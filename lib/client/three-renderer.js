import { loadSceneToThree } from './threejs-player.js';
import { parseSceneJson } from './scene-json.js';
import { resolveImageTexture } from './scene-renderer.js';
import { loadTexTexture } from './tex-loader.js';
import { defaultLoadWasm, resolveParticleMaterial } from './wasm-renderer.js';
import { groupEffectsByObject, objectCameraRange, particleObjectRange, particleWorldSize, } from './object-range.js';
import { isLinearEffectChain, ObjectEffectStage, resolveObjectRtSize } from './object-effects.js';
import { resolveEffectChain } from './shader/effect-chain.js';
// 去重告警（同一 key 只打印一次，防刷屏；与 object-effects.ts 的 warnOnce 同风格，本文件独立
// 实现一份）。⚠️ 生命周期与「当前壁纸」绑定：render() 开头清空一次，避免跨壁纸累积而漏报。
const warnedKeys = new Set();
function warnOnce(key, message) {
    if (warnedKeys.has(key))
        return;
    warnedKeys.add(key);
    console.warn(`[wallpaper-engine] ${message}`);
}
// 与「对象级 RT」alpha 语义冲突的 colorBlendMode（= WE 已实现的那三个，见 threejs-player 的
// colorBlendModeToThree）：这些对象**不走隔离路径**（理由见 render() 内 isolate 计算处的守卫注释）。
const BLEND_ISOLATION_UNSAFE = new Set([6, 7, 31]);
// 粒子混合模式：**优先读材质 json 的 `passes[0].blending`**（WE 权威字段），缺失时才回退按
// 材质名启发式（对齐 wasm `BlendMode::from_material`）。
//
// ⚠️ 这里是「DK WOTLK（44 层）满屏黑色小方块」的根因（2026-09-10 定位，真 GPU 实证）：
// 旧实现只用 `/lightshaft|glow|additive/i` 匹配 **spec.material 的路径字符串**，而 WE 材质的
// 辉光语义写在**材质 json 的 `blending` 字段**里、**路径名里通常没有这些字样**——DK 的 44 层
// 材质是 `materials/presets/torch.json`、`materials/workshop/2111504995/presets/snowperspective.json`
// 等，全部 `"blending": "additive"`，但路径名一个都不匹配 → 全被判成 NormalBlending。
// （全库普查：粒子材质 `blending` = additive 45 / translucent 5，而路径名含 "lightshaft" 的只有
//  `materials/presets/lightshaft.json` 一个。）后果：additive 材质的粒子走了 alpha 混合，
// 而 additive 纹理（如 `particle/chromaticdot`，RGBA8888、**alpha 全 255**、形状写在 rgb 里——
// 黑底 + 中央亮点）在 NormalBlending 下 = 不透明黑方块（rgb=0×color → 黑，alpha=1 → 不透明），
// 即用户截图里 DK 满屏黑色小方块；同层的火/雾/尘被画成洗白的方块噪声而非辉光。
// 修复：从材质 json 取 `blending` 真实值（'add'/'additive' → AdditiveBlending，其余 → alpha）。
export function particleBlend(blending, specText) {
    if (typeof blending === 'string' && blending) {
        // WE 枚举：add / additive 为加算；alpha / translucent / normal / opaque 等为普通透明叠加。
        return /^(add|additive)$/i.test(blending.trim()) ? 'additive' : 'alpha';
    }
    // 材质 json 不可得（拉取失败/无 passes）→ 回退旧启发式（材质名含 lightshaft/glow/additive）。
    try {
        const spec = JSON.parse(specText);
        const mat = spec.material;
        if (typeof mat === 'string' && /lightshaft|glow|additive/i.test(mat))
            return 'additive';
    }
    catch {
        /* 解析失败 → alpha */
    }
    return 'alpha';
}
// 空粒子模拟器兜底：spec 解析失败（`CpuParticleSim.new` throw）时返回**零粒子**模拟器，
// 使 loadSceneToThree 不因单个坏 spec 整场失败（对齐「失败只丢单个对象」原则，粒子层 0 实例）。
function createEmptySim() {
    return {
        update: () => { },
        vertices: () => new Float32Array(0),
        frame_count: () => 1,
        set_frame_count: () => { },
        particle_count: () => 0,
    };
}
// 收集并解析「带效果对象」的链（spec §2.3：按 scene.json objects 顺序，每对象保留自身
// effects，不展平）。text 对象不在范围（SceneTextObject 无 effects 字段）；解析失败的链
// 过滤掉并 warn（该对象回退无效果显示，不黑屏）。
//
// ⚠️ 本函数按 `groupEffectsByObject` 的口径收链，其中还包含 `models/util/*` 的 util 对象
// （合成层/全屏层，全库 8 个对象 10 条效果）——它们在 loadSceneToThree 里**不渲染**，
// 因此永远没有隔离条目。调用方按「是否真的隔离成功」再过滤一次（见 render() 的挂链循环），
// 本函数保持「解析与分类」的单一职责。
//
// `loadFile` 内部是多次 await fetch（effect.json → material → shader 源），全部发生在**加载期**：
// 帧内只写 uniform + 提交 pass，不建管线/不 fetch。
export async function collectObjectEffectChains(desc, loadFile) {
    const out = new Map();
    for (const group of groupEffectsByObject(desc.objects)) {
        const chains = [];
        for (const fx of group.effects) {
            if (typeof fx?.file !== 'string')
                continue;
            const chain = await resolveEffectChain({ file: fx.file, passes: fx.passes }, loadFile);
            if (!chain) {
                console.warn('[wallpaper-engine] 效果链解析失败，跳过:', fx.file);
                continue;
            }
            chains.push(chain);
        }
        if (chains.length > 0)
            out.set(group.obj.id, chains);
    }
    return out;
}
// 创建 three.js 播放器场景渲染器（sceneRenderer 接口）。
// opts.loadWasm 可注入（测试）；缺省用 defaultLoadWasm（导入静态 URL + 显式初始化）。
export function createThreeSceneRenderer(opts) {
    const loadWasm = opts?.loadWasm ?? defaultLoadWasm;
    // 模块加载缓存：同一 renderer 内多次 render 只加载/初始化一次 wasm（对齐 wasm-renderer）。
    let modulePromise = null;
    // 跨 render 持有本次装配的 three 播放器 + sim（供替换/dispose 释放）。
    let current = null;
    // 本次装配的对象级效果链编排器（模块内闭包持有，供 window.resize 同步预算与 teardown 释放）。
    let currentStage = null;
    // window.resize 监听：窗口尺寸变化时按新窗口比例重推 cover（对齐 wasm 窗口视口语义）。
    let onWindowResize = null;
    const teardown = () => {
        if (onWindowResize) {
            window.removeEventListener('resize', onWindowResize);
            onWindowResize = null;
        }
        // 先释放编排器（其 runner 持有对象 RT/材质），再释放播放器（player.dispose 会释放
        // renderer 与隔离 RT）——顺序反了会让 runner 的 dispose 触碰已释放的 GL 资源。
        currentStage?.dispose();
        currentStage = null;
        current?.player.dispose();
        for (const sim of current?.sims ?? [])
            sim.free?.();
        current = null;
    };
    // 当前窗口/视口尺寸（clamp ≥1，对齐 wasm-renderer 的 vw/vh 推导）。
    const viewportSize = () => ({
        width: Math.max(1, Math.round(window.innerWidth || 0)),
        height: Math.max(1, Math.round(window.innerHeight || 0)),
    });
    return {
        async render(id, fg, _bg) {
            // 诊断去重集合的生命周期 = 当前壁纸：每次 render 清空，避免跨壁纸累积（换了壁纸后新壁纸的
            // 告警必须还能打印出来）。
            warnedKeys.clear();
            try {
                // 替换/切壁纸前先释放上次播放器资源（首次渲染 no-op）。
                teardown();
                // `CpuParticleSim` 是纯 CPU（无需 WebGPU）；模块初始化失败 → 仍可渲染背景，仅跳过粒子。
                modulePromise ??= loadWasm();
                const mod = await modulePromise;
                // 拉取场景描述并解析（与 wasm-renderer 共用 parseSceneJson，对象归类/正交尺寸一致）。
                const sceneJsonResp = await fetch(`/wallpapers/scene/${id}/asset?name=scene.json`);
                if (!sceneJsonResp.ok)
                    return false;
                const sceneJson = await sceneJsonResp.text();
                const desc = parseSceneJson(sceneJson);
                // 前景 canvas 逻辑尺寸 = 视口（对齐 wasm-renderer 的 vw/vh；cover 相机按此裁剪）。
                const vw = Math.max(1, Math.round(window.innerWidth || desc.orthogonal.width));
                const vh = Math.max(1, Math.round(window.innerHeight || desc.orthogonal.height));
                fg.width = vw;
                fg.height = vh;
                // ── 组装 SceneAssets：背景纹理 + 粒子条件 + 模拟器工厂 ──────────────────────────
                const backgroundTextures = new Map();
                const particles = new Map();
                for (const obj of desc.objects) {
                    if (obj.kind === 'image') {
                        // 图片对象纹理（scene-renderer.resolveImageTexture，复用同一模型→材质→tex 推导）。
                        const tex = await resolveImageTexture(id, obj);
                        if (tex)
                            backgroundTextures.set(obj.id, tex);
                    }
                    else if (obj.kind === 'particle' && obj.particle) {
                        // 粒子 spec json（raw，供 CpuParticleSim::new 解析）。
                        const specResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(obj.particle)}`);
                        if (!specResp.ok)
                            continue;
                        const specText = await specResp.text();
                        // 粒子材质（材质 json）→ 静态纹理 URL（ptex-*.tex）+ 混合模式（`passes[0].blending`）。
                        // 无纹理/解析失败 → tex undefined → 白图兜底；材质不可得 → blending null → 名启发式兜底。
                        const mat = await resolveParticleMaterial(id, specText);
                        const tex = mat?.texUrl ? (await loadTexTexture(mat.texUrl)) ?? undefined : undefined;
                        particles.set(obj.id, {
                            specJson: specText,
                            tex,
                            blend: particleBlend(mat?.blending, specText),
                            // 对象级 instanceoverride（原始 JSON；无覆盖 → undefined → 工厂传空串）。
                            // 由 wasm `CpuParticleSim` 按官方 OverrideSpawnProgram 语义应用：
                            // alpha/size/lifetime/speed 乘数 + color 覆盖 + emitter rate × count。
                            // （GTR 3743126786 烟柱 alpha=0.03 靠它才与桌面端一致。）
                            overrideJson: obj.instanceOverrideJson,
                            // softness 缺省由 addParticle 按有无纹理推导（有纹理 0.15 / 无纹理 1.0，对齐 wasm
                            // particle_render SOFTNESS_* 语义）；此处不硬编码 0（无纹理白图兜底时硬边白方块
                            // 会叠成白斑、单个粒子被看作方块——Task5 回归「粒子可见但不过曝/不遮背景」）。
                        });
                    }
                }
                // `createParticleSim`：wasm CpuParticleSim 构造器（测试可注入 loadWasm 得到假模块）。
                // 模块无 CpuParticleSim（如未编译 render feature）→ undefined → loadSceneToThree
                // 自动跳过粒子对象（只渲染背景）。
                const cpSim = mod?.CpuParticleSim;
                const createParticleSim = cpSim
                    ? (json, origin, sceneW, sceneH, overrideJson) => {
                        try {
                            return cpSim.new(json, Float32Array.from(origin), sceneW, sceneH, overrideJson);
                        }
                        catch (e) {
                            console.warn('[three] 粒子模拟器构造失败（用零粒子兜底）:', e instanceof Error ? e.message : String(e));
                            return createEmptySim();
                        }
                    }
                    : undefined;
                // ── 对象级效果链：解析 + 隔离尺寸预算（spec §5.2）────────────────────────────
                // ⚠️ 位置：必须在「组装 SceneAssets」的 objects 循环**之后**（本段依赖已被填充的
                // backgroundTextures/particles：图片尺寸兜底、粒子 spec 的 distanceMax），且在
                // loadSceneToThree 之前（isolate 要随 assets 一起下发）。
                // ⚠️ 全部在**加载期**完成：resolveEffectChain 内部的多次 loadFile(fetch)、EffectRunner
                // 创建与探针编译都在这里；帧内只写 uniform + 提交 pass。
                const loadFile = async (name) => {
                    const r = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(name)}`);
                    if (!r.ok)
                        return null;
                    return new Uint8Array(await r.arrayBuffer());
                };
                const effectChains = await collectObjectEffectChains(desc, loadFile);
                const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
                const budgetW = Math.floor(vw * dpr);
                const budgetH = Math.floor(vh * dpr);
                // isolate 的键 = scene.json 的**对象 id**，值里的 objectId 同值：player 用 objectId 作
                // **隔离条目的键**（attachIsolated），ObjectEffectStage 也用同一把键 → 三者同键空间，
                // 不存在「对象 id → 图层计数器 id」的翻译层，也就不会撞键（见 threejs-player 的注释）。
                const isolate = new Map();
                // 因 colorBlendMode 与对象级 RT 的 alpha 语义冲突而**主动跳过隔离**的对象（见下）。这些
                // 对象仍照常参与渲染（只是没有隔离条目），故不并入下面「挂在未参与渲染的对象上」的汇总
                // 告警——两者原因不同、各自告警一次，混在一起会指向错误的排查方向。
                const blendSkipped = new Set();
                // 链**全为具名 RT 图链**、因而不隔离的对象（见下）。它们照常渲染，只是没有隔离条目、
                // 效果整条跳过（观感与不隔离相同）——既不属于「挂在未参与渲染的对象类型上」，也不该
                // 因为省掉隔离而丢掉「具名 RT 未实现，跳过」这条降级告警（诊断不得静默）。
                const rtGraphOnly = new Set();
                for (const obj of desc.objects) {
                    const chains = effectChains.get(obj.id);
                    // 无链 → 与收紧前逐字一致的早退（effectChains 只在链非空时入表）。
                    if (!chains || chains.length === 0)
                        continue;
                    // colorBlendMode ∈ {6,7,31} 的混合语义是「读当前帧缓冲、按自己的 alpha 与之混合」，其内容材质
                    // 把结果 alpha 钉成「背景的 alpha」（blendSrcAlpha=Zero / blendDstAlpha=One）。对象级 RT 里没有
                    // 「背景」，RT 清屏 alpha=0 ⇒ RT alpha 恒 0 ⇒ 合成 quad 的片元被乘成 0，对象会整体不可见。
                    // 改动前这类对象在 three 路径下是「效果不生效但对象可见」；为避免把可见变成不可见，
                    // 对该组合**不走隔离路径**（效果仍不生效，与改动前一致），并告警一次。根本修法留 P2。
                    // ⚠️ 本守卫必须在下面的「有无可执行链」判定**之前**：它的理由与链能不能执行无关，且不许因为
                    // 「链恰好全是具名 RT 图链」而丢掉这条告警（收紧准入不得改守卫语义）。
                    if (obj.kind === 'image'
                        && typeof obj.colorBlendMode === 'number' && BLEND_ISOLATION_UNSAFE.has(obj.colorBlendMode)) {
                        warnOnce(`blend-isolation:${obj.id}`, `对象 ${obj.id} 的 colorBlendMode=${obj.colorBlendMode} 与对象级 RT 的 alpha 语义冲突，跳过其效果链（对象保持可见）`);
                        blendSkipped.add(obj.id);
                        continue;
                    }
                    // 只有能被执行的链才值得隔离：链全为具名 RT 图链时会整条跳过（setObjectChains 不建 runner），
                    // 此时对象 RT 的显存与每帧一次额外渲染完全没有收益，观感也与不隔离相同。
                    const usable = chains.some((one) => isLinearEffectChain(one));
                    if (!usable) {
                        // 收紧前准入只看「有链」：这类对象照样进了 isolate → 一张收口到对象尺寸的对象 RT
                        // （如 3840×2160 = 31.6 MB）+ 合成 quad + 每帧一次额外渲染与一次 RT 切换，而链从未
                        // 建 runner ⇒ quad 永远采样 RT 原图，隔离没有额外视觉收益（纯浪费）。注意隔离路径与
                        // 直接渲染并非位级等价（RT 8 位量化 / alpha 预乘往返 / 预算收口时放大采样），故不主张「逐像素相同」。
                        //
                        // 只对「收紧前**本该**被隔离」的渲染对象（image / 有 spec 的 particle）在这里告警：util /
                        // text / 缺粒子资源的对象本来就没有隔离条目，它们的 effects 由下面「挂在未参与渲染的对象
                        // 类型上」汇总告警覆盖（口径与收紧前逐字一致，不在这里抢走那条告警）。
                        if (obj.kind === 'image' || (obj.kind === 'particle' && particles.has(obj.id))) {
                            rtGraphOnly.add(obj.id);
                            for (const one of chains) {
                                if (isLinearEffectChain(one))
                                    continue;
                                const label = one.find((p) => p.target)?.target
                                    ?? one.find((p) => p.bind.length > 0)?.bind[0]?.name
                                    ?? '(具名 RT)';
                                warnOnce(`rt-graph:${label}`, `效果需要具名 RT（P2 未实现），跳过: ${label}（对象 ${obj.id} 的链全为具名 RT 图链，不再隔离）`);
                            }
                        }
                        continue;
                    }
                    if (obj.kind === 'image') {
                        const tex = backgroundTextures.get(obj.id);
                        const texW = tex?.image?.width ?? obj.size?.[0] ?? 1;
                        const texH = tex?.image?.height ?? obj.size?.[1] ?? 1;
                        const w = obj.size?.[0] ?? texW;
                        const h = obj.size?.[1] ?? texH;
                        // 世界尺寸（未钳制幅值）= |size × scale| → 合成 quad 的几何尺寸。
                        const world = { w: Math.abs(w * obj.scale[0]), h: Math.abs(h * obj.scale[1]) };
                        // 相机范围（场景像素，已按 4096 钳制）= 对象 RT 的分辨率基准。
                        const range = objectCameraRange([w, h], [obj.scale[0], obj.scale[1]]);
                        // RT 像素尺寸 = 场景像素范围 × dpr，再等比收口到 min(4096, 视口 × dpr)。
                        // dpr 必须在这里乘：RT 要与「贴屏缓冲 = 视口 × dpr」同分辨率，传 1 会让 dpr=2 的
                        // 屏幕上对象 RT 只有一半分辨率（效果发糊）且与贴屏不一致。
                        // ⚠️ RT 分辨率基准必须用**未钳制**的 `world`，**不能**用 `range`：`range` 是
                        // objectCameraRange 的「相机范围」（逐轴钳到 4096），拿它当分辨率基准会同时错两处 ——
                        //   ① 比例失真：7430×4147 被钳成 4096×4096；
                        //   ② 分辨率被视口预算收口得更小：实测退到 **720×720**，贴回屏幕要放大 1.78×
                        //      ⇒ 整层背景明显模糊（这正是「大幅背景壁纸变糊」的根因；e2e harness 自己按 world
                        //      算所以一直复现不出）。
                        // 正确：RT = min(world × dpr, 视口 × dpr, 4096) = 对象在屏幕上的像素数（受 4096 硬上限）。
                        const rt = resolveObjectRtSize(world.w, world.h, dpr, budgetW, budgetH);
                        isolate.set(obj.id, {
                            objectId: obj.id,
                            rtWidth: rt.width, rtHeight: rt.height, worldW: world.w, worldH: world.h,
                        });
                    }
                    else if (obj.kind === 'particle') {
                        const p = particles.get(obj.id);
                        if (!p)
                            continue;
                        let spec = {};
                        try {
                            spec = JSON.parse(p.specJson);
                        }
                        catch { /* 缺省 distanceMax */ }
                        // 世界尺寸用**未钳制**的 distanceMax × scale（quad 的世界占位），相机范围取幅值
                        // 并钳制 4096（RT 分辨率基准）——两者不可混用（见 particleWorldSize 注释）。
                        const world = particleWorldSize(spec, [obj.scale[0], obj.scale[1]]);
                        const range = particleObjectRange(spec, [obj.scale[0], obj.scale[1]]);
                        // ⚠️ RT 分辨率基准必须用**未钳制**的 `world`，**不能**用 `range`：`range` 是
                        // objectCameraRange 的「相机范围」（逐轴钳到 4096），拿它当分辨率基准会同时错两处 ——
                        //   ① 比例失真：7430×4147 被钳成 4096×4096；
                        //   ② 分辨率被视口预算收口得更小：实测退到 **720×720**，贴回屏幕要放大 1.78×
                        //      ⇒ 整层背景明显模糊（这正是「大幅背景壁纸变糊」的根因；e2e harness 自己按 world
                        //      算所以一直复现不出）。
                        // 正确：RT = min(world × dpr, 视口 × dpr, 4096) = 对象在屏幕上的像素数（受 4096 硬上限）。
                        const rt = resolveObjectRtSize(world.w, world.h, dpr, budgetW, budgetH);
                        isolate.set(obj.id, {
                            objectId: obj.id,
                            rtWidth: rt.width, rtHeight: rt.height,
                            worldW: Math.abs(world.w), worldH: Math.abs(world.h),
                        });
                    }
                }
                // 装配并启动播放（背景 + 粒子；setAnimationLoop 内部每帧 sim.update(dt) → 刷新 buffer）。
                // viewport 传真实窗口/视口尺寸（vw/vh）：ThreeScenePlayer 构造器已不再把 canvas 重置回场景
                // 尺寸，此处显式传给 loadSceneToThree → player.resize(vw,vh) 使 cover 相机按窗口宽高比裁剪
                // （Task5 修复：窗口比例 ≠ 场景比例时背景 cover 裁切而非 object-fit:fill 拉伸）。
                const result = loadSceneToThree(sceneJson, { backgroundTextures, particles, createParticleSim, isolate }, fg, {
                    width: vw,
                    height: vh,
                });
                current = result;
                // ── 装配 ObjectEffectStage（对象级效果链的编排器）──────────────────────────────
                // 键空间（本轮根治点）：isolate 表的键、player 隔离条目的 id（isolatedObjects()[].id）、
                // stage 的键**都是 scene.json 的对象 id**——player 的 attachIsolated 直接用 obj.id 建条目。
                // 此前这里有一层「对象 id → 图层计数器 id」的翻译（用 result.backgroundIds /
                // result.particleLayers 的游标复制 loadSceneToThree 的建层条件与顺序）：它脆弱（对侧一改
                // 建层条件/顺序，测试全绿而效果链静默全失效），且两个图层计数器都从 0 起、同壁纸的隔离
                // image 与隔离 particle 会撞键。该层已整体删除。
                //
                // 挂在「不参与渲染的对象类型」（util 合成层/全屏层、缺粒子 spec/资源的对象）上的效果
                // 不会得到隔离条目，因而无法挂链——为免它们被**静默丢弃**（诊断上完全不可见），按壁纸
                // 汇总一条告警（每壁纸一条，不按对象刷屏）。
                let stage = null;
                let droppedEffects = 0;
                for (const [objId, chains] of effectChains) {
                    // blendSkipped 的已单独告警（colorBlendMode 冲突），不并入本条汇总。
                    // rtGraphOnly 的也已单独告警（具名 RT 未实现）；它们**照常渲染**（只是不隔离），
                    // 原因不是「对象不参与渲染」，并入本条会把排查方向指向错误的类型。
                    if (isolate.has(objId) || blendSkipped.has(objId) || rtGraphOnly.has(objId))
                        continue;
                    droppedEffects += chains.length;
                }
                if (droppedEffects > 0) {
                    warnOnce(`unrendered-effects:${id}`, `${droppedEffects} 条效果挂在未参与渲染的对象类型上（util/音频），已跳过`);
                }
                // 有对象被真正隔离才需要编排器：util 对象（models/util/*）带 effects 但不在
                // loadSceneToThree 的渲染范围，永远没有隔离条目 → 挂链必然失败，故不建 stage
                // （stage 为 null 时帧序与今天逐字相同）。
                if (isolate.size > 0) {
                    stage = new ObjectEffectStage(result.player, {
                        wallpaperId: id, dpr, budgetWidth: budgetW, budgetHeight: budgetH,
                    });
                    // 顺序契约：先 setWorldSize（尺寸的唯一来源），再 setObjectChains（后者不覆盖世界尺寸）。
                    // 世界尺寸直接用 isolate 里已算好的世界尺寸（同一份计算的两个消费者），不另存一份映射；
                    // 键一律用对象 id（= isolate 的键 = 隔离条目的 id）。
                    for (const [objId, iso] of isolate) {
                        stage.setWorldSize(objId, iso.worldW, iso.worldH);
                    }
                    for (const [objId, chains] of effectChains) {
                        // 没有隔离条目的对象（util 层、缺粒子资源、blend 冲突跳过的）不挂链：挂也找不到 view，
                        // 只会产生误导性的「调用顺序错误」告警，且画不出内容。
                        if (!isolate.has(objId))
                            continue;
                        stage.setObjectChains(objId, chains);
                    }
                    result.player.setObjectEffectStage(stage);
                    currentStage = stage;
                }
                // 窗口尺寸变化 → 按新窗口比例重推 cover（对齐 wasm 路径的 window.innerWidth/Height 语义），
                // 并把新的画布缓冲预算同步给效果链编排器（隔离对象 RT 随视口重设）。
                onWindowResize = () => {
                    if (!current)
                        return;
                    const { width, height } = viewportSize();
                    current.player.resize(width, height);
                    currentStage?.onViewportResize(Math.floor(width * dpr), Math.floor(height * dpr));
                };
                window.addEventListener('resize', onWindowResize);
                // 观测：确认走的是 three 路径（浏览器回归探测用）。
                console.log(`[three] scene loaded id=${id} background=${result.backgroundIds.length} particleLayers=${result.particleLayers.length}`);
                // 零背景 + 零粒子 → 无内容，返回 false 由 controller 走 preview 兜底（不显示空 canvas）。
                if (result.backgroundIds.length === 0 && result.particleLayers.length === 0) {
                    teardown();
                    return false;
                }
                return true;
            }
            catch (e) {
                console.warn('[three] scene render failed:', e instanceof Error ? e.message : String(e));
                teardown();
                return false;
            }
        },
        // 释放当前 three 播放器 + wasm 模拟器（切壁纸/卸载时防泄漏）。
        dispose() {
            teardown();
        },
    };
}
