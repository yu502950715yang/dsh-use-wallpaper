// Rust/WebGPU 渲染器胶水：实现 wallpaper-controller 的 sceneRenderer 接口。
// 无 WebGPU / wasm 加载失败 → 渲染返回 false，controller 走现有 JS 渲染 / preview 回退链。
import { parseSceneJson } from './scene-json.js';
import { resolveTexPath } from './scene-renderer.js';

// wasm 侧 WeScene 实例的接口（对齐 wasm/pkg/we_scene_wasm.d.ts）
export interface WasmScene {
  resize(w: number, h: number): void;
  load_scene(json: string): void;
  load_image(assetId: number, tex: Uint8Array, origin: Float32Array, scale: Float32Array, size: Float32Array): void;
  add_particle(json: string, origin: Float32Array, scale: Float32Array): void;
  step(dt: number): void;
  render(): void;
  scene_width(): number;
  scene_height(): number;
}

// wasm-pack --target web 产物（wasm/pkg/we_scene_wasm.js）模块形态：
// 命名导出 WeScene；默认导出 __wbg_init（实例化 wasm，可传 wasm URL 覆盖 import.meta.url 定位）
export interface WasmSceneModule {
  default(moduleOrPath?: string | URL | Request): Promise<unknown>;
  WeScene: { create(canvas: HTMLCanvasElement, width: number, height: number): Promise<WasmScene> };
}

export type LoadWasm = () => Promise<WasmSceneModule | null>;

// TS DOM lib 的 Navigator 尚未声明 WebGPU 的 gpu 属性（实验性 API），此处仅做存在性探测
interface NavigatorWithGPU { gpu?: unknown }

// 静态资源前缀与文件名（与 src/host/routes.ts 的 /wallpapers/static 路由对应；
// scripts/build-client.mjs 从 wasm/pkg/ 复制这两个文件到 dist/static/）
const STATIC_BASE = '/wallpapers/static';
const WASM_GLUE_FILE = 'we_scene_wasm.js';
const WASM_BIN_FILE = 'we_scene_wasm_bg.wasm';

async function defaultLoadWasm(): Promise<WasmSceneModule | null> {
  try {
    const resp = await fetch(`${STATIC_BASE}/${WASM_GLUE_FILE}`);
    if (!resp.ok) return null;
    const glue = await resp.text();
    // blob URL 动态 import：绕过 bundle 对 wasm 产物的静态解析（产物独立于 client bundle）。
    // glue 内 import.meta.url 指向 blob（无法相对解析 .wasm），故初始化时显式传 wasm 静态 URL。
    const url = URL.createObjectURL(new Blob([glue], { type: 'text/javascript' }));
    try {
      const mod = (await import(/* @vite-ignore */ url)) as WasmSceneModule;
      await mod.default(`${STATIC_BASE}/${WASM_BIN_FILE}`);
      return mod;
    } finally {
      URL.revokeObjectURL(url);
    }
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

export function createWasmSceneRenderer(opts?: { loadWasm?: LoadWasm }): {
  render(id: string, fg: HTMLCanvasElement, bg?: HTMLCanvasElement): Promise<boolean>;
} | null {
  // 无 WebGPU（navigator.gpu falsy，含 SSR/测试环境）→ null，controller 走现有 JS 渲染回退
  if (typeof navigator === 'undefined' || !(navigator as NavigatorWithGPU).gpu) return null;
  const loadWasm = opts?.loadWasm ?? defaultLoadWasm;
  // 模块加载缓存：同一 renderer 内多次 render 只加载/初始化一次 wasm
  let modulePromise: Promise<WasmSceneModule | null> | null = null;
  return {
    async render(id, fg) {
      try {
        modulePromise ??= loadWasm();
        const mod = await modulePromise;
        if (!mod) return false;
        // 拉取场景描述并解析（与 JS 渲染器共用 parseSceneJson，对象归类/正交尺寸语义一致）
        const sceneJsonResp = await fetch(`/wallpapers/scene/${id}/asset?name=scene.json`);
        if (!sceneJsonResp.ok) return false;
        const sceneJson = await sceneJsonResp.text();
        const desc = parseSceneJson(sceneJson);
        const { width, height } = desc.orthogonal;
        const scene = await mod.WeScene.create(fg, width, height);
        scene.load_scene(sceneJson);
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
            rendered++;
          } else if (obj.kind === 'particle' && obj.particle) {
            const specResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(obj.particle)}`);
            if (!specResp.ok) continue;
            scene.add_particle(await specResp.text(), Float32Array.from(obj.origin), Float32Array.from(obj.scale));
            rendered++;
          }
        }
        // 全部对象渲染失败 → 返回 false，controller 走 preview 回退（回退链接线）
        if (rendered === 0) return false;
        let raf = 0;
        const loop = () => {
          scene.step(1 / 60);
          scene.render();
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
