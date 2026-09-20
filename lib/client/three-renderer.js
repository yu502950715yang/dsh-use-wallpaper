import { loadSceneToThree, resolvePixelRatio } from './threejs-player.js';
import { parseSceneJson } from './scene-json.js';
import { resolveImageTexture } from './scene-renderer.js';
import { loadTexTexture } from './tex-loader.js';
import { defaultLoadWasm, resolveParticleMaterial } from './wasm-renderer.js';
import { groupEffectsByObject, objectRtSize, particleWorldSize, screenScalePx, } from './object-range.js';
import { ObjectEffectStage } from './object-effects.js';
import { createGlowStage } from './glow-stage.js';
import { readClientSettings, getUserPropertyValue } from './settings.js';
import { resolveEffectChain } from './shader/effect-chain.js';
import { createTextTexture, textCanvasSize, createClockDriver } from './text-object.js';
import { detectScriptPattern, formatClockText } from './script-patterns.js';
import { resolveVisibility } from './visibility.js';
// 去重告警（同一 key 只打印一次，防刷屏；与 object-effects.ts 的 warnOnce 同风格，本文件独立
// 实现一份）。⚠️ 生命周期与「当前壁纸」绑定：render() 开头清空一次，避免跨壁纸累积而漏报。
const warnedKeys = new Set();
function warnOnce(key, message) {
    if (warnedKeys.has(key))
        return;
    warnedKeys.add(key);
    console.warn(`[wallpaper-engine] ${message}`);
}
// WE 字体（pkg 内 otf/ttf）经 FontFace 加载后按家族名绘制；失败或环境不支持（jsdom 无 FontFace）
// → 回退系统 sans-serif。按「壁纸 id + 字体路径」缓存：同一壁纸的多个 text 对象共用一次加载。
const FONT_CACHE = new Map();
let fontSeq = 0;
async function loadWallpaperFont(wallpaperId, font) {
    if (typeof font !== 'string' || !font)
        return undefined;
    if (!/\.(otf|ttf|ttc|woff2?)$/i.test(font))
        return undefined; // 家族名直接用
    if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts)
        return undefined;
    const key = `${wallpaperId}:${font}`;
    let pending = FONT_CACHE.get(key);
    if (!pending) {
        pending = (async () => {
            try {
                const r = await fetch(`/wallpapers/scene/${wallpaperId}/asset?name=${encodeURIComponent(font)}`);
                if (!r.ok)
                    return null;
                const family = `we-font-${++fontSeq}`;
                const face = new FontFace(family, await r.arrayBuffer());
                await face.load();
                document.fonts.add(face);
                return family;
            }
            catch {
                return null; // 字体取不到/非法 → 上层回退默认字体（不阻断渲染）
            }
        })();
        FONT_CACHE.set(key, pending);
    }
    return (await pending) ?? undefined;
}
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
            // effect 级可见性：lwe CImage::setupPasses 对 visible=false 的 effect 整条跳过（正常内容，不告警）
            if (fx.visible === false)
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
    // 本次装配的应用级 Glow stage（同上：闭包持有，teardown 释放）。
    let currentGlow = null;
    // 省电与画质档位（跨 render 有效）：render 内读设置同步，装配时就地应用。
    let paused = false;
    let qualityScale = 1;
    // window.resize 监听：窗口尺寸变化时按新窗口比例重推 cover（对齐 wasm 窗口视口语义）。
    let onWindowResize = null;
    // 本次装配的背景纹理：teardown 时显式 dispose（视频纹理的 `<video>`/Blob URL 清理挂在
    // 纹理 dispose 事件上，renderer.dispose() 不会停解码）。见 AGENT.md §5.23。
    let currentTextures = null;
    const teardown = () => {
        if (onWindowResize) {
            window.removeEventListener('resize', onWindowResize);
            onWindowResize = null;
        }
        // 先释放编排器（其 runner 持有对象 RT/材质），再释放播放器（player.dispose 会释放
        // renderer 与隔离 RT）——顺序反了会让 runner 的 dispose 触碰已释放的 GL 资源。
        currentStage?.dispose();
        currentStage = null;
        // Glow stage 持有自己的 RT/材质，同样要在 player.dispose（释放 renderer）之前释放。
        currentGlow?.dispose();
        currentGlow = null;
        current?.player.dispose();
        for (const sim of current?.sims ?? [])
            sim.free?.();
        current = null;
        // 纹理放在播放器之后释放（GPU 侧已随 renderer.dispose 收口，再触发纹理自身的清理钩子）。
        for (const tex of currentTextures?.values() ?? [])
            tex.dispose();
        currentTextures = null;
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
                currentTextures = backgroundTextures; // teardown 负责 dispose（见 currentTextures 注释）
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
                // ── text 对象（2026-09-21）────────────────────────────────────────────────
                // **只对 text** 应用 visible（布尔 / 用户属性 / 脚本绑定）：本库 20 个 text 全是脚本时钟，
                // 其中数个默认隐藏（2911105183 的 3 个 Clock 有 2 个 value=false），不过滤就会叠出多个时钟。
                // image/particle 的可见性不在本次范围（存量行为不变）。
                const userProps = {};
                for (const obj of desc.objects) {
                    if (obj.visible?.kind === 'user' && obj.visible.key) {
                        userProps[obj.visible.key] = getUserPropertyValue(obj.visible.key);
                    }
                }
                const textLayers = new Map();
                for (const obj of desc.objects) {
                    if (obj.kind !== 'text')
                        continue;
                    if (!resolveVisibility(obj, userProps))
                        continue;
                    const size = textCanvasSize(obj.text, obj.pointsize, obj.size);
                    const opts = {
                        font: await loadWallpaperFont(id, obj.font),
                        pointsize: obj.pointsize,
                        color: obj.color,
                        width: size.w,
                        height: size.h,
                    };
                    const props = obj.scriptProperties ?? {};
                    const isClock = obj.script ? detectScriptPattern(obj.script) === 'clock' : false;
                    const initial = isClock ? formatClockText(new Date(), props) : obj.text;
                    const texture = createTextTexture(initial, opts);
                    textLayers.set(obj.id, {
                        texture,
                        // 时钟：每帧判文本是否变化（同分钟不重绘），变了由 player 置 needsUpdate 上传。
                        driver: isClock ? createClockDriver(texture.image, opts, props, initial) : undefined,
                    });
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
                // 插件设置：一次读取。画质档位必须在算屏幕密度**之前**拿到——对象 RT 的尺寸基准与画布
                // 缓冲必须用同一个渲染像素比（两者口径不一致会让整层模糊，见 AGENT.md §5.15/§5.21）。
                const settings = await readClientSettings();
                qualityScale = settings.qualityScale ?? 1;
                const dpr = resolvePixelRatio(typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1, qualityScale);
                // 屏幕密度（设备像素 / 世界单位）：对象 RT 尺寸的**唯一基准**，由主相机同一套 cover 语义
                // 算出（object-range.screenScalePx 与 player.applyCover 共用 coverRange：同一份 scene 尺寸、
                // 视口与 dpr ⇒ 同一个数）。窗口 resize 时用 `player.screenScalePx()` 重算同一个量
                // （见下方 onWindowResize），**不得**另起一套「视口 × dpr 预算」——那正是 3fd6b00
                // 「挂载期 RT 正确、任何一次 resize 又被打回旧口径」这一漏检类的同源地雷。
                const screenScale = screenScalePx(desc.orthogonal.width, desc.orthogonal.height, vw, vh, dpr);
                // isolate 的键 = scene.json 的**对象 id**，值里的 objectId 同值：player 用 objectId 作
                // **隔离条目的键**（attachIsolated），ObjectEffectStage 也用同一把键 → 三者同键空间，
                // 不存在「对象 id → 图层计数器 id」的翻译层，也就不会撞键（见 threejs-player 的注释）。
                const isolate = new Map();
                // P2 起 isolate 准入 = 「有链」：线性链与具名 RT 图链都由 ObjectEffectStage 建 runner 与计划执行
                // （Task 6 已反转旧的「链全为具名 RT 图链则不隔离」收紧准入，故这里不再有 rtGraphOnly 分支）。
                for (const obj of desc.objects) {
                    const chains = effectChains.get(obj.id);
                    // 无链 → 与收紧前逐字一致的早退（effectChains 只在链非空时入表）。
                    if (!chains || chains.length === 0)
                        continue;
                    if (obj.kind === 'image') {
                        const tex = backgroundTextures.get(obj.id);
                        const texW = tex?.image?.width ?? obj.size?.[0] ?? 1;
                        const texH = tex?.image?.height ?? obj.size?.[1] ?? 1;
                        const w = obj.size?.[0] ?? texW;
                        const h = obj.size?.[1] ?? texH;
                        // 世界尺寸（未钳制幅值）= |size × scale| → 合成 quad 的几何尺寸，也是对象 RT 尺寸的
                        // **唯一基准**（RT 像素 = 世界尺寸 × 屏幕密度）。
                        const world = { w: Math.abs(w * obj.scale[0]), h: Math.abs(h * obj.scale[1]) };
                        // RT 像素尺寸 = 对象在画布缓冲上的**占位像素**（世界尺寸 × 屏幕密度），等比收口到 4096。
                        // ⚠️ 两条硬约束（都踩过，见 clarity-report.md）：
                        //   ① 基准必须是**未钳制**的世界尺寸，不是 objectCameraRange 的相机范围（后者逐轴钳到
                        //      4096）：7430×4147 会被钳成 4096×4096（比例失真），且分辨率被视口预算收口后实测
                        //      退到 **720×720**，贴回屏幕要放大 1.78× ⇒ 整层背景明显模糊；
                        //   ② 密度必须与主相机 cover 同源。旧口径「世界 × dpr 收口到视口 × dpr」与屏占位差
                        //      0.8%（GTR 3743126786 实测 1280×714 vs 占位 1290×720）⇒ 合成那一步是比 0.992 的
                        //      双线性缩小 + 亚纹素相位漂移 ⇒ 整层锐度实测 −52%（Laplacian 713 → 342），
                        //      且与 dpr 无关、加 MSAA 也无效（根因就是这一步重采样，不是抗锯齿）。
                        const rt = objectRtSize(world.w, world.h, screenScale);
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
                        // 世界尺寸用**未钳制**的 distanceMax × scale（quad 的世界占位，也是 RT 尺寸的唯一基准）；
                        // 局部相机范围由 player 按同一世界尺寸建立（见 particleWorldSize 注释）。
                        const world = particleWorldSize(spec, [obj.scale[0], obj.scale[1]]);
                        // RT 像素尺寸 = 屏占位（世界尺寸 × 屏幕密度），等比收口到 4096（同 image 分支的两条约束）。
                        const rt = objectRtSize(world.w, world.h, screenScale);
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
                const result = loadSceneToThree(sceneJson, { backgroundTextures, particles, createParticleSim, isolate, textLayers, qualityScale }, fg, {
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
                    // 没有隔离条目 = 对象不参与渲染（util 层 / 缺粒子资源），并入本条汇总告警。
                    if (isolate.has(objId))
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
                        wallpaperId: id, screenScale,
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
                // 应用级 Glow：按插件设置装配（关闭时零资源、帧序与输出零回归）。⚠️ 必须在 isolate 块
                // **之外**——Glow 与「有无对象被隔离」无关；尺寸用画布缓冲（loadSceneToThree 内部已
                // player.resize(vw,vh) 按 dpr 设过），故 resize 由 player.resize 内部单点同步，此处不重复。
                currentGlow?.dispose();
                currentGlow = settings.glowEnabled
                    ? createGlowStage(fg.width, fg.height, {
                        threshold: settings.glowThreshold,
                        strength: settings.glowStrength,
                    })
                    : null;
                result.player.setGlowStage(currentGlow);
                // 省电：装配时若已处于暂停态（如切到后台时换壁纸）→ 直接不排程。
                if (paused)
                    result.player.pause();
                // 窗口尺寸变化 → 按新窗口比例重推 cover（对齐 wasm 路径的 window.innerWidth/Height 语义），
                // 并把新的**屏幕密度**同步给效果链编排器（隔离对象 RT 随视口重设）。
                // ⚠️ 密度取自 `player.screenScalePx()`（player 内部与 applyCover 同一套 state，
                // 因此与刚执行的 `player.resize` 天然同源），不在这里另算一份 cover —— 挂载期与 resize
                // 期两处各算一遍正是「RT 尺寸被 resize 打回旧口径」那类漏检的结构性原因。
                onWindowResize = () => {
                    if (!current)
                        return;
                    const { width, height } = viewportSize();
                    current.player.resize(width, height);
                    currentStage?.onViewportResize(current.player.screenScalePx());
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
        // 省电：暂停/恢复当前播放器的帧循环（无播放器时只记状态，下次装配时就地应用）。
        setPaused(value) {
            paused = value;
            if (!current)
                return;
            if (value)
                current.player.pause();
            else
                current.player.resume();
        },
        // 画质档位：改渲染像素比后重推画布缓冲，并把新屏幕密度同步给效果链编排器（对象 RT 随其重设）。
        setQualityScale(scale) {
            qualityScale = scale;
            if (!current)
                return;
            current.player.setQualityScale(scale);
            currentStage?.onViewportResize(current.player.screenScalePx());
        },
        // 释放当前 three 播放器 + wasm 模拟器（切壁纸/卸载时防泄漏）。
        dispose() {
            teardown();
        },
    };
}
