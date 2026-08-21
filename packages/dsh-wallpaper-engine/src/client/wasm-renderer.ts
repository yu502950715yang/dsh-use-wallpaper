// Rust/WebGPU 渲染器胶水：实现 wallpaper-controller 的 sceneRenderer 接口。
// 无 WebGPU / wasm 加载失败 → 渲染返回 false，controller 走现有 JS 渲染 / preview 回退链。
import { parseSceneJson } from './scene-json.js';
import { resolveTexPath } from './scene-renderer.js';
import type { SceneDescription } from '../shared/types.js';

// Task 2.1：效果链检测（纯函数）。wasm 渲染器（Rust/wgpu）只渲染静态图像 quad +
// GPU 粒子，无效果链执行器——带 godrays/foliagesway/iris 等对象级 effects 的壁纸
// 走 wasm 路径会渲染成 STATIC。任一对象含非空 effects 数组 → true，render() 据此
// 在绑定 WebGPU 之前返回 false，回退 JS 渲染器（Phase 1 已实现对象级效果链，动画恢复）。
export function hasEffectChains(desc: SceneDescription): boolean {
  return desc.objects.some((o) => Array.isArray(o.effects) && o.effects.length > 0);
}

// wasm 侧 WeScene 实例的接口（对齐 wasm/pkg/we_scene_wasm.d.ts）
export interface WasmScene {
  resize(w: number, h: number): void;
  load_scene(json: string): void;
  set_cover(): void;
  load_image(assetId: number, tex: Uint8Array, origin: Float32Array, scale: Float32Array, size: Float32Array): void;
  add_particle(json: string, origin: Float32Array, scale: Float32Array): void;
  step(dt: number): void;
  render(): void;
  scene_width(): number;
  scene_height(): number;
}

// wasm-pack --target web 产物（wasm/pkg/we_scene_wasm.js）模块形态：
// 命名导出 WeScene；默认导出 __wbg_init（实例化 wasm，可传 wasm URL 覆盖
// import.meta.url 定位——直接 import 静态 URL 时 import.meta.url 指向
// /wallpapers/static/we_scene_wasm.js，相对定位 we_scene_wasm_bg.wasm 同样正确，
// 但显式传参更稳妥，避免与 blob/路径假设耦合）。
export interface WasmSceneModule {
  default(moduleOrPath?: string | URL | Request): Promise<unknown>;
  WeScene: { create(canvas: HTMLCanvasElement, width: number, height: number): Promise<WasmScene> };
}

export type LoadWasm = () => Promise<WasmSceneModule | null>;

// wallpaper-controller 的 sceneRenderer 接口形态（scene-renderer.ts 的 renderScene 同构）
export interface SceneRendererLike {
  render(id: string, fg: HTMLCanvasElement, bg?: HTMLCanvasElement): Promise<boolean>;
}

// 回退链组合（spec §7 第 2/3 条）：wasm 渲染器不可用（null）→ 直接用 JS 渲染器；
// wasm 加载/初始化/渲染失败（resolve false）→ 降级 JS 渲染器；
// JS 渲染器同样失败（false）→ 最终 false，controller 走 preview 图回退。
// 组合层不吞异常：任一渲染器 reject 由 controller 的 try/catch 兜底（语义等价 preview）。
// Task 9 修复（回退链 canvas 污染）：wasm 失败时 fg 已被 WebGPU context 占用，JS 渲染器
// 无法在同一 canvas 上创建 WebGL context。故 wasm 失败后**返回 false 交由 controller 重建
// canvas 重试**（重试时 wasmFailed 已记录，组合层直接用新 canvas 走 JS 渲染器），
// 避免组合层内部换 canvas 与 controller 展示引用不一致（2597392171 双失败根因）。
export function createFallbackSceneRenderer(
  wasm: SceneRendererLike | null,
  js: SceneRendererLike,
): SceneRendererLike {
  if (!wasm) return js;
  // 本壁纸 wasm 已失败：后续渲染跳过 wasm 直接走 JS（避免反复绑定 canvas）
  const wasmFailed = new Set<string>();
  return {
    async render(id, fg, bg) {
      if (!wasmFailed.has(id)) {
        const ok = await wasm.render(id, fg, bg);
        if (ok) return true;
        wasmFailed.add(id);
        return false; // wasm 失败且 fg 已被 WebGPU 污染 → controller 重建 canvas 重试
      }
      // wasmFailed：controller 已重建 canvas（未绑定 WebGPU），直接走 JS 渲染器
      return js.render(id, fg, bg);
    },
  };
}

// TS DOM lib 的 Navigator 尚未声明 WebGPU 的 gpu 属性（实验性 API），此处仅做存在性探测
interface NavigatorWithGPU { gpu?: unknown }

// 静态资源前缀与文件名（与 src/host/routes.ts 的 /wallpapers/static 路由对应；
// scripts/build-client.mjs 从 wasm/pkg/ 复制这两个文件到 dist/static/）
const STATIC_BASE = '/wallpapers/static';
const WASM_GLUE_FILE = 'we_scene_wasm.js';
const WASM_BIN_FILE = 'we_scene_wasm_bg.wasm';

async function defaultLoadWasm(): Promise<WasmSceneModule | null> {
  try {
    // 直接动态 import 静态 URL（不用 blob：blob 无路径基准，入口内 import.meta.url
    // 无法相对定位 wasm）。--target web 产物导出 default（__wbg_init），必须显式调用
    // 初始化——wasm 是惰性单例，不调 default 则 WeScene.create 内 wasm 未定义（实测
    // 'Cannot read properties of undefined (reading wescene_create)'）。
    const mod = (await import(/* @vite-ignore */ `${STATIC_BASE}/${WASM_GLUE_FILE}`)) as WasmSceneModule;
    await mod.default(`${STATIC_BASE}/${WASM_BIN_FILE}`);
    return mod;
  } catch {
    return null;
  }
}

// 图片对象纹理字节推导：obj.image → model.json → material → .tex。
// 与 scene-renderer 的 resolveImageTexture 同构，但字节流直接传 wasm（不在 JS 侧解码）。
async function resolveImageTexBytes(id: string, imageRef: string): Promise<Uint8Array | null> {
  try {
    const modelResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(imageRef)}`);
    if (!modelResp.ok) return null;
    const model: unknown = await modelResp.json();
    const matRef: unknown = (model as any)?.material;
    if (typeof matRef !== 'string' || !matRef) return null;
    const matResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(matRef)}`);
    if (!matResp.ok) return null;
    const mat: unknown = await matResp.json();
    const texName: unknown = (mat as any)?.passes?.[0]?.textures?.[0];
    if (typeof texName !== 'string' || !texName) return null;
    const texResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(resolveTexPath(matRef, texName))}`);
    if (!texResp.ok) return null;
    return new Uint8Array(await texResp.arrayBuffer());
  } catch {
    return null;
  }
}

export function createWasmSceneRenderer(opts?: { loadWasm?: LoadWasm }): SceneRendererLike | null {
  // 无 WebGPU（navigator.gpu falsy，含 SSR/测试环境）→ null，controller 走现有 JS 渲染回退
  if (typeof navigator === 'undefined' || !(navigator as NavigatorWithGPU).gpu) return null;
  const loadWasm = opts?.loadWasm ?? defaultLoadWasm;
  // 模块加载缓存：同一 renderer 内多次 render 只加载/初始化一次 wasm
  let modulePromise: Promise<WasmSceneModule | null> | null = null;
  return {
    async render(id, fg, bg) {
      try {
        modulePromise ??= loadWasm();
        const mod = await modulePromise;
        if (!mod) return false;
        // 拉取场景描述并解析（与 JS 渲染器共用 parseSceneJson，对象归类/正交尺寸语义一致）
        const sceneJsonResp = await fetch(`/wallpapers/scene/${id}/asset?name=scene.json`);
        if (!sceneJsonResp.ok) return false;
        const sceneJson = await sceneJsonResp.text();
        const desc = parseSceneJson(sceneJson);
        // Task 2.1：效果链检测必须在此处（WeScene.create 之前）——wasm 无效果链执行器，
        // 带 effects 的壁纸走 wasm 渲染成 STATIC。此处 fg/bg 都尚未绑定 WebGPU context，
        // 返回 false 后 controller 重建 canvas 走 JS 渲染器（对象级效果链 Phase 1 已实现）；
        // 若在 WeScene.create 之后才检测，canvas 已被 WebGPU 占用，JS 渲染器无法复用。
        if (hasEffectChains(desc)) return false;
        const { width, height } = desc.orthogonal;
        // Task 9 修复：surface 与 canvas 属性尺寸 = 视口（对齐 scene-renderer.setScene 的
        // vw/vh 语义；原实现直接传场景正交尺寸，canvas 默认 300×150 → 渲染被拉伸/截图失真）
        const vw = Math.max(1, Math.round(window.innerWidth || width));
        const vh = Math.max(1, Math.round(window.innerHeight || height));
        fg.width = vw;
        fg.height = vh;
        const scene = await mod.WeScene.create(fg, vw, vh);
        scene.load_scene(sceneJson);
        // Task 9 修复（背景层）：bg canvas 用 cover 渲染场景图片（铺满 + CSS 模糊），
        // 对齐 JS 版 background-layer 的双 canvas 语义——前景 contain 的透明区域露出
        // 模糊背景，避免透明区域显示黑色导致画面过暗（实测 EVA avg 200→20 的主因之一）。
        // 背景只加载图片（粒子叠加在前景即可），纹理字节与前景共享同一 fetch。
        let bgScene: WasmScene | null = null;
        if (bg) {
          // 背景层创建失败不应拖垮前景渲染（wasm 双 surface 极端环境可能失败）
          try {
            bg.width = vw;
            bg.height = vh;
            bgScene = await mod.WeScene.create(bg, vw, vh);
            bgScene.set_cover();
            bgScene.load_scene(sceneJson);
          } catch {
            bgScene = null;
          }
        }
        // 对象遍历：image → 纹理字节直传 wasm；particle → 规格 json 直传；util 跳过
        // （与 scene-renderer.ts 语义一致；assetId 用对象索引保证单场景内唯一）
        let rendered = 0;
        for (let i = 0; i < desc.objects.length; i++) {
          const obj = desc.objects[i];
          if (obj.kind === 'image') {
            const tex = await resolveImageTexBytes(id, obj.image);
            if (!tex) continue; // 纹理缺失 → 跳过该对象（与 JS 渲染器一致）
            scene.load_image(
              i,
              tex,
              Float32Array.from(obj.origin),
              Float32Array.from(obj.scale),
              Float32Array.from(obj.size ?? []),
            );
            if (bgScene) {
              bgScene.load_image(
                i,
                tex,
                Float32Array.from(obj.origin),
                Float32Array.from(obj.scale),
                Float32Array.from(obj.size ?? []),
              );
            }
            rendered++;
          } else if (obj.kind === 'particle' && obj.particle) {
            const specResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(obj.particle)}`);
            if (!specResp.ok) continue;
            const specText = await specResp.text();
            scene.add_particle(specText, Float32Array.from(obj.origin), Float32Array.from(obj.scale));
            // 背景层也叠加粒子：JS 版 bg 渲染整个 scene（含粒子），blur 后背景偏亮；
            // wasm 版 bgScene 若只有图片（EVA 主图 alpha 大面积 0）→ 背景暗（avg 39 vs 基线 200）
            if (bgScene) {
              bgScene.add_particle(specText, Float32Array.from(obj.origin), Float32Array.from(obj.scale));
            }
            rendered++;
          }
        }
        // 全部对象渲染失败 → 返回 false，controller 走 preview 回退（回退链接线）
        if (rendered === 0) return false;
        let raf = 0;
        const loop = () => {
          scene.step(1 / 60);
          scene.render();
          if (bgScene) {
            bgScene.step(1 / 60);
            bgScene.render();
          }
          // canvas 被 controller 移除（切换壁纸）时自动终止 raf，防止泄漏
          if (fg.isConnected) raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        return true;
      } catch {
        return false;
      }
    },
  };
}
