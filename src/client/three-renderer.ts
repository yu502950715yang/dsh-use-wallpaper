// Task 5：three.js 播放器生产入口（思路 1「WE 场景 → three.js 播放器」落地）。
//
// 作用：把 `loadSceneToThree`（Task 4）接进生产壁纸渲染路径，使**用户实际**通过 three.js
// 播放器看到背景 + 粒子。本模块实现与 wasm-renderer 同构的 `SceneRendererLike`
// （`render(id, fg, bg)` + `dispose()`），供 wallpaper-controller 直接使用：
//   - 拉取 scene.json → 解析（parseSceneJson，与既有路径同源语义）；
//   - 组装 `SceneAssets`：背景纹理（resolveImageTexture）+ 粒子条件（spec/tex/blend）+
//     `createParticleSim` 工厂（wasm `CpuParticleSim`，复用既有 CPU 模拟，不重写模拟）；
//   - `loadSceneToThree` 创建 ThreeScenePlayer（cover 正交相机 + 背景 Sprite + 粒子 billboard）
//     并 `setAnimationLoop` 播放（每帧 sim.update(dt) 推进 → updateParticles 读 getter 刷新 buffer）。
//
// ⚠️ 与 wasm-renderer 的关系：本模块是**新增**的三条播放路径（`THREE_USE=1` 时启用），
// **不改动/不删除** wasm-renderer（默认路径保持不变，可对照）。`CpuParticleSim` 是纯 CPU
// 模拟（非 WebGPU），本路径**不需要 WebGPU**；wasm 模块仅用来加载 CpuParticleSim。
//
// 已知边界（Task 5 合约）：
//   - 粒子 billboard 不做 quad 自旋（`build_instance_vertices` 的 10 浮点不含 rotation）；
//     粒子**位置/尺寸/颜色/alpha/帧**随 sim 每帧推进，飘动可见（本任务核心）。
//   - 可视性（visible.user/script 绑定）本任务不做过滤——四壁纸对象均为可见；
//     loadSceneToThree 沿用「缺物件 spec/工厂则跳过该粒子对象」语义，绝不全屏失败。
import type { Texture } from 'three';
import { loadSceneToThree, type LoadedParticleAssets, type ParticleSim, type ThreeSceneLoadResult } from './threejs-player.js';
import { parseSceneJson } from './scene-json.js';
import { resolveImageTexture } from './scene-renderer.js';
import { loadTexTexture } from './tex-loader.js';
import { defaultLoadWasm, resolveParticleMaterial } from './wasm-renderer.js';
import type { LoadWasm, SceneRendererLike, WasmSceneModule } from './wasm-renderer.js';
import type { SceneDescription } from '../shared/types.js';
import {
  groupEffectsByObject, objectCameraRange, particleObjectRange, particleWorldSize,
} from './object-range.js';
import { ObjectEffectStage, resolveObjectRtSize } from './object-effects.js';
import { resolveEffectChain, type CompiledEffectPass } from './shader/effect-chain.js';

// wasm `CpuParticleSim` 的构造器形态（wasm-bindgen 静态 `new`；`ParticleSim` 接口见
// threejs-player.ts：update/vertices/frame_count/set_frame_count/particle_count/free）。
type CpuParticleSimLike = {
  new: (
    json: string,
    origin: Float32Array,
    sceneW: number,
    sceneH: number,
    overrideJson: string,
  ) => ParticleSim;
};

type ThreeWasmModule = WasmSceneModule & { CpuParticleSim?: CpuParticleSimLike };

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
export function particleBlend(
  blending: string | null | undefined,
  specText: string,
): 'additive' | 'alpha' {
  if (typeof blending === 'string' && blending) {
    // WE 枚举：add / additive 为加算；alpha / translucent / normal / opaque 等为普通透明叠加。
    return /^(add|additive)$/i.test(blending.trim()) ? 'additive' : 'alpha';
  }
  // 材质 json 不可得（拉取失败/无 passes）→ 回退旧启发式（材质名含 lightshaft/glow/additive）。
  try {
    const spec = JSON.parse(specText) as { material?: unknown };
    const mat = spec.material;
    if (typeof mat === 'string' && /lightshaft|glow|additive/i.test(mat)) return 'additive';
  } catch {
    /* 解析失败 → alpha */
  }
  return 'alpha';
}

// 空粒子模拟器兜底：spec 解析失败（`CpuParticleSim.new` throw）时返回**零粒子**模拟器，
// 使 loadSceneToThree 不因单个坏 spec 整场失败（对齐「失败只丢单个对象」原则，粒子层 0 实例）。
function createEmptySim(): ParticleSim {
  return {
    update: () => {},
    vertices: () => new Float32Array(0),
    frame_count: () => 1,
    set_frame_count: () => {},
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
export async function collectObjectEffectChains(
  desc: SceneDescription,
  loadFile: (name: string) => Promise<Uint8Array | null>,
): Promise<Map<number, CompiledEffectPass[][]>> {
  const out = new Map<number, CompiledEffectPass[][]>();
  for (const group of groupEffectsByObject(desc.objects)) {
    const chains: CompiledEffectPass[][] = [];
    for (const fx of group.effects as Array<{ file?: string; passes?: unknown[] }>) {
      if (typeof fx?.file !== 'string') continue;
      const chain = await resolveEffectChain({ file: fx.file, passes: fx.passes }, loadFile);
      if (!chain) {
        console.warn('[wallpaper-engine] 效果链解析失败，跳过:', fx.file);
        continue;
      }
      chains.push(chain);
    }
    if (chains.length > 0) out.set(group.obj.id, chains);
  }
  return out;
}

// 创建 three.js 播放器场景渲染器（sceneRenderer 接口）。
// opts.loadWasm 可注入（测试）；缺省用 defaultLoadWasm（导入静态 URL + 显式初始化）。
export function createThreeSceneRenderer(opts?: { loadWasm?: LoadWasm }): SceneRendererLike {
  const loadWasm = opts?.loadWasm ?? defaultLoadWasm;
  // 模块加载缓存：同一 renderer 内多次 render 只加载/初始化一次 wasm（对齐 wasm-renderer）。
  let modulePromise: Promise<WasmSceneModule | null> | null = null;
  // 跨 render 持有本次装配的 three 播放器 + sim（供替换/dispose 释放）。
  let current: ThreeSceneLoadResult | null = null;
  // 本次装配的对象级效果链编排器（模块内闭包持有，供 window.resize 同步预算与 teardown 释放）。
  let currentStage: ObjectEffectStage | null = null;
  // window.resize 监听：窗口尺寸变化时按新窗口比例重推 cover（对齐 wasm 窗口视口语义）。
  let onWindowResize: (() => void) | null = null;
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
    for (const sim of current?.sims ?? []) sim.free?.();
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
        if (!sceneJsonResp.ok) return false;
        const sceneJson = await sceneJsonResp.text();
        const desc = parseSceneJson(sceneJson);
        // 前景 canvas 逻辑尺寸 = 视口（对齐 wasm-renderer 的 vw/vh；cover 相机按此裁剪）。
        const vw = Math.max(1, Math.round(window.innerWidth || desc.orthogonal.width));
        const vh = Math.max(1, Math.round(window.innerHeight || desc.orthogonal.height));
        fg.width = vw;
        fg.height = vh;
        // ── 组装 SceneAssets：背景纹理 + 粒子条件 + 模拟器工厂 ──────────────────────────
        const backgroundTextures = new Map<number, Texture>();
        const particles = new Map<number, LoadedParticleAssets>();
        for (const obj of desc.objects) {
          if (obj.kind === 'image') {
            // 图片对象纹理（scene-renderer.resolveImageTexture，复用同一模型→材质→tex 推导）。
            const tex = await resolveImageTexture(id, obj);
            if (tex) backgroundTextures.set(obj.id, tex);
          } else if (obj.kind === 'particle' && obj.particle) {
            // 粒子 spec json（raw，供 CpuParticleSim::new 解析）。
            const specResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(obj.particle)}`);
            if (!specResp.ok) continue;
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
        const cpSim = (mod as ThreeWasmModule | null)?.CpuParticleSim;
        const createParticleSim = cpSim
          ? (
              json: string,
              origin: [number, number, number],
              sceneW: number,
              sceneH: number,
              overrideJson: string,
            ): ParticleSim => {
              try {
                return cpSim.new(json, Float32Array.from(origin), sceneW, sceneH, overrideJson);
              } catch (e) {
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
        const loadFile = async (name: string): Promise<Uint8Array | null> => {
          const r = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(name)}`);
          if (!r.ok) return null;
          return new Uint8Array(await r.arrayBuffer());
        };
        const effectChains = await collectObjectEffectChains(desc, loadFile);
        const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
        const budgetW = Math.floor(vw * dpr);
        const budgetH = Math.floor(vh * dpr);
        // isolate 的键 = scene.json 的**对象 id**（player 在 loadSceneToThree 内用 obj.id 查表），
        // 值 = 四字段（RT 像素尺寸 + 合成 quad 世界尺寸，见 SceneAssets.isolate 注释）。
        const isolate = new Map<number, { rtWidth: number; rtHeight: number; worldW: number; worldH: number }>();
        for (const obj of desc.objects) {
          if (!effectChains.has(obj.id)) continue;
          if (obj.kind === 'image') {
            const tex = backgroundTextures.get(obj.id);
            const texW = (tex?.image?.width as number | undefined) ?? obj.size?.[0] ?? 1;
            const texH = (tex?.image?.height as number | undefined) ?? obj.size?.[1] ?? 1;
            const w = obj.size?.[0] ?? texW;
            const h = obj.size?.[1] ?? texH;
            // 世界尺寸（未钳制幅值）= |size × scale| → 合成 quad 的几何尺寸。
            const world = { w: Math.abs(w * obj.scale[0]), h: Math.abs(h * obj.scale[1]) };
            // 相机范围（场景像素，已按 4096 钳制）= 对象 RT 的分辨率基准。
            const range = objectCameraRange([w, h], [obj.scale[0], obj.scale[1]]);
            // RT 像素尺寸 = 场景像素范围 × dpr，再等比收口到 min(4096, 视口 × dpr)。
            // dpr 必须在这里乘：RT 要与「贴屏缓冲 = 视口 × dpr」同分辨率，传 1 会让 dpr=2 的
            // 屏幕上对象 RT 只有一半分辨率（效果发糊）且与贴屏不一致。
            const rt = resolveObjectRtSize(range.w, range.h, dpr, budgetW, budgetH);
            isolate.set(obj.id, { rtWidth: rt.width, rtHeight: rt.height, worldW: world.w, worldH: world.h });
          } else if (obj.kind === 'particle') {
            const p = particles.get(obj.id);
            if (!p) continue;
            let spec: { distanceMax?: number } = {};
            try { spec = JSON.parse(p.specJson) as { distanceMax?: number }; } catch { /* 缺省 distanceMax */ }
            // 世界尺寸用**未钳制**的 distanceMax × scale（quad 的世界占位），相机范围取幅值
            // 并钳制 4096（RT 分辨率基准）——两者不可混用（见 particleWorldSize 注释）。
            const world = particleWorldSize(spec, [obj.scale[0], obj.scale[1]]);
            const range = particleObjectRange(spec, [obj.scale[0], obj.scale[1]]);
            const rt = resolveObjectRtSize(range.w, range.h, dpr, budgetW, budgetH);
            isolate.set(obj.id, {
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
        // ⚠️ 键空间（踩过的接口陷阱，务必对齐）：stage 的键必须是 **player 隔离条目的 id**，
        // 不是 scene.json 的对象 id。player 用「背景层 / 粒子层各自的计数器」给隔离条目编号
        // （threejs-player 的 nextBackgroundId / nextParticleLayerId，从 0 开始），与对象 id
        // 完全不是一套编号（全库实测对象 id = 12/13/17/20/…）。若用对象 id 挂链，
        // `ObjectEffectStage.setObjectChains` 的 `isolatedObjects().find(o => o.id === objId)`
        // 永远找不到条目 → 每个对象都告警「尚无隔离条目，效果链未挂载（调用顺序错误）」，
        // 且一条效果链都挂不上（对象级效果整条链路静默失效）。
        // 对齐方式：loadSceneToThree 按 desc.objects 顺序调用 addBackground/addParticle，
        // 层 id 就是「第几个被建层的该类对象」，而 result.backgroundIds / result.particleLayers
        // 正是这个顺序的权威产出。
        const stageKey = new Map<number, number>(); // scene.json 对象 id → player 隔离条目 id
        {
          let bgIndex = 0;
          let particleIndex = 0;
          for (const obj of desc.objects) {
            if (obj.kind === 'image') {
              // 每个 image 对象都会 addBackground（无条件）→ 层 id = 它是第几个 image 对象。
              const layerId = result.backgroundIds[bgIndex++];
              if (layerId !== undefined) stageKey.set(obj.id, layerId);
            } else if (obj.kind === 'particle') {
              // 粒子层只在「有 spec + 有模拟器工厂」时才建（loadSceneToThree 的同名门控）；
              // 未建层的对象不占层号，故这里必须用同一条件推进游标。
              if (!obj.particle || !particles.get(obj.id) || !createParticleSim) continue;
              const layer = result.particleLayers[particleIndex++];
              if (layer) stageKey.set(obj.id, layer.id);
            }
          }
        }
        let stage: ObjectEffectStage | null = null;
        // 有对象被真正隔离才需要编排器：util 对象（models/util/*）带 effects 但不在
        // loadSceneToThree 的渲染范围，永远没有隔离条目 → 挂链必然失败，故不建 stage
        // （stage 为 null 时帧序与今天逐字相同）。
        if (isolate.size > 0) {
          stage = new ObjectEffectStage(result.player, {
            wavelengthId: id, dpr, budgetWidth: budgetW, budgetHeight: budgetH,
          });
          // 顺序契约：先 setWorldSize（尺寸的唯一来源），再 setObjectChains（后者不覆盖世界尺寸）。
          // 世界尺寸直接用 isolate 里已算好的世界尺寸（同一份计算的两个消费者），不另存一份映射。
          for (const [objId, iso] of isolate) {
            const key = stageKey.get(objId);
            if (key === undefined) continue;
            stage.setWorldSize(key, iso.worldW, iso.worldH);
          }
          for (const [objId, chains] of effectChains) {
            const key = stageKey.get(objId);
            // 没有隔离条目的对象（util 层等）不挂链：挂也找不到 view，只会产生误导性的
            // 「调用顺序错误」告警，且画不出内容。
            if (key === undefined) continue;
            stage.setObjectChains(key, chains);
          }
          result.player.setObjectEffectStage(stage);
          currentStage = stage;
        }
        // 窗口尺寸变化 → 按新窗口比例重推 cover（对齐 wasm 路径的 window.innerWidth/Height 语义），
        // 并把新的画布缓冲预算同步给效果链编排器（隔离对象 RT 随视口重设）。
        onWindowResize = () => {
          if (!current) return;
          const { width, height } = viewportSize();
          current.player.resize(width, height);
          currentStage?.onViewportResize(Math.floor(width * dpr), Math.floor(height * dpr));
        };
        window.addEventListener('resize', onWindowResize);
        // 观测：确认走的是 three 路径（浏览器回归探测用）。
        console.log(
          `[three] scene loaded id=${id} background=${result.backgroundIds.length} particleLayers=${result.particleLayers.length}`,
        );
        // 零背景 + 零粒子 → 无内容，返回 false 由 controller 走 preview 兜底（不显示空 canvas）。
        if (result.backgroundIds.length === 0 && result.particleLayers.length === 0) {
          teardown();
          return false;
        }
        return true;
      } catch (e) {
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
