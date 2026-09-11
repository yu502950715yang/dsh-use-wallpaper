import { loadSceneToThree } from './threejs-player.js';
import { parseSceneJson } from './scene-json.js';
import { resolveImageTexture } from './scene-renderer.js';
import { loadTexTexture } from './tex-loader.js';
import { defaultLoadWasm, resolveParticleMaterial } from './wasm-renderer.js';
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
// 创建 three.js 播放器场景渲染器（sceneRenderer 接口）。
// opts.loadWasm 可注入（测试）；缺省用 defaultLoadWasm（导入静态 URL + 显式初始化）。
export function createThreeSceneRenderer(opts) {
    const loadWasm = opts?.loadWasm ?? defaultLoadWasm;
    // 模块加载缓存：同一 renderer 内多次 render 只加载/初始化一次 wasm（对齐 wasm-renderer）。
    let modulePromise = null;
    // 跨 render 持有本次装配的 three 播放器 + sim（供替换/dispose 释放）。
    let current = null;
    // window.resize 监听：窗口尺寸变化时按新窗口比例重推 cover（对齐 wasm 窗口视口语义）。
    let onWindowResize = null;
    const teardown = () => {
        if (onWindowResize) {
            window.removeEventListener('resize', onWindowResize);
            onWindowResize = null;
        }
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
                // 装配并启动播放（背景 + 粒子；setAnimationLoop 内部每帧 sim.update(dt) → 刷新 buffer）。
                // viewport 传真实窗口/视口尺寸（vw/vh）：ThreeScenePlayer 构造器已不再把 canvas 重置回场景
                // 尺寸，此处显式传给 loadSceneToThree → player.resize(vw,vh) 使 cover 相机按窗口宽高比裁剪
                // （Task5 修复：窗口比例 ≠ 场景比例时背景 cover 裁切而非 object-fit:fill 拉伸）。
                const result = loadSceneToThree(sceneJson, { backgroundTextures, particles, createParticleSim }, fg, {
                    width: vw,
                    height: vh,
                });
                current = result;
                // 窗口尺寸变化 → 按新窗口比例重推 cover（对齐 wasm 路径的 window.innerWidth/Height 语义）。
                onWindowResize = () => {
                    if (!current)
                        return;
                    const { width, height } = viewportSize();
                    current.player.resize(width, height);
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
