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
import { defaultLoadWasm, resolveParticleTexUrl } from './wasm-renderer.js';
import type { LoadWasm, SceneRendererLike, WasmSceneModule } from './wasm-renderer.js';

// wasm `CpuParticleSim` 的构造器形态（wasm-bindgen 静态 `new`；`ParticleSim` 接口见
// threejs-player.ts：update/vertices/frame_count/set_frame_count/particle_count/free）。
type CpuParticleSimLike = {
  new: (json: string, origin: Float32Array, sceneW: number, sceneH: number) => ParticleSim;
};

type ThreeWasmModule = WasmSceneModule & { CpuParticleSim?: CpuParticleSimLike };

// 粒子混合模式：对齐 wasm `BlendMode::from_material`（lightshaft/glow/additive → additive，
// 其余 → alpha/translucent）。从粒子 spec 的 `material` 名推导；解析失败 → alpha。
function particleBlend(specText: string): 'additive' | 'alpha' {
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

// 创建 three.js 播放器场景渲染器（sceneRenderer 接口）。
// opts.loadWasm 可注入（测试）；缺省用 defaultLoadWasm（导入静态 URL + 显式初始化）。
export function createThreeSceneRenderer(opts?: { loadWasm?: LoadWasm }): SceneRendererLike {
  const loadWasm = opts?.loadWasm ?? defaultLoadWasm;
  // 模块加载缓存：同一 renderer 内多次 render 只加载/初始化一次 wasm（对齐 wasm-renderer）。
  let modulePromise: Promise<WasmSceneModule | null> | null = null;
  // 跨 render 持有本次装配的 three 播放器 + sim（供替换/dispose 释放）。
  let current: ThreeSceneLoadResult | null = null;
  const teardown = () => {
    current?.player.dispose();
    for (const sim of current?.sims ?? []) sim.free?.();
    current = null;
  };
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
            // 粒子 tex → THREE.Texture（静态路由 ptex-*.tex；无纹理/解析失败 → undefined → 白图兜底）。
            const texUrl = await resolveParticleTexUrl(id, specText);
            const tex = texUrl ? (await loadTexTexture(texUrl)) ?? undefined : undefined;
            particles.set(obj.id, {
              specJson: specText,
              tex,
              blend: particleBlend(specText),
              softness: 0,
            });
          }
        }
        // `createParticleSim`：wasm CpuParticleSim 构造器（测试可注入 loadWasm 得到假模块）。
        // 模块无 CpuParticleSim（如未编译 render feature）→ undefined → loadSceneToThree
        // 自动跳过粒子对象（只渲染背景）。
        const cpSim = (mod as ThreeWasmModule | null)?.CpuParticleSim;
        const createParticleSim = cpSim
          ? (json: string, origin: [number, number, number], sceneW: number, sceneH: number): ParticleSim => {
              try {
                return cpSim.new(json, Float32Array.from(origin), sceneW, sceneH);
              } catch (e) {
                console.warn('[three] 粒子模拟器构造失败（用零粒子兜底）:', e instanceof Error ? e.message : String(e));
                return createEmptySim();
              }
            }
          : undefined;

        // 装配并启动播放（背景 + 粒子；setAnimationLoop 内部每帧 sim.update(dt) → 刷新 buffer）。
        const result = loadSceneToThree(sceneJson, { backgroundTextures, particles, createParticleSim }, fg);
        current = result;
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
