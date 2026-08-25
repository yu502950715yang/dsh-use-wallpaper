import type { WallpaperInfo } from '../shared/types.js';
import type { BackgroundLayer } from './background-layer.js';
import { resolveBackground } from './background-layer.js';

export interface WallpaperControllerOptions {
  fetchList: () => Promise<WallpaperInfo[]>;
  // Finding 2：dispose 可选——每次 select（含取消/切壁纸）时调用，释放渲染器持有的
  // wasm 场景 + 脚本运行时（防泄漏）。仅注入 render 的旧实现不受影响（可选链兜底）。
  sceneRenderer?: {
    render(wallpaperId: string, fg: HTMLCanvasElement, bg?: HTMLCanvasElement): Promise<boolean>;
    dispose?(): void;
  };
}

export function createWallpaperController(
  layer: BackgroundLayer,
  opts: WallpaperControllerOptions,
) {
  let list: WallpaperInfo[] = [];
  // I3：select 竞态防护 —— 每次 select 递增 generation，异步完成后（scene
  // 渲染回调等）校验 generation 未变才应用，防止乱序覆盖最新选择。
  let selectGeneration = 0;

  async function load(): Promise<WallpaperInfo[]> {
    list = await opts.fetchList();
    return list;
  }

  async function select(id: string): Promise<void> {
    const gen = ++selectGeneration;
    // Finding 2：壁纸切换/取消时释放当前 scene 渲染器资源（wasm 场景 + 脚本运行时）。
    // 旧渲染器的 raf 循环随 canvas 被替换/移除终止，但其持有的 scene/quickjs 需显式释放。
    opts.sceneRenderer?.dispose?.();
    // 取消壁纸：空 id 直接清空背景层（恢复默认背景，露出 DSH 原生背景）。
    // 同步生效并递增 generation，使进行中的旧选择异步回调被竞态防护丢弃。
    if (id === '') {
      layer.showNone();
      return;
    }
    // 列表未加载时自动拉取（show() 委托 select 的前提）；加载失败则静默放弃本次选择
    if (list.length === 0) {
      try {
        await load();
      } catch {
        return;
      }
    }
    if (gen !== selectGeneration) return;
    // I1 修复：controller 缓存的 list 只在为空时刷新（见上方），而设置面板的列表是
    // 独立 fetch 维护的——新添加的壁纸会出现在面板列表却不在 controller 缓存里。
    // 若 list.find(id) 找不到（旧缓存过期），重新拉取一次列表再查找，避免
    // 「列表可见却选不中（无任何反应）」。重试后仍找不到才放弃。
    let info = list.find((w) => w.id === id);
    if (!info) {
      try {
        await load();
      } catch {
        return;
      }
      if (gen !== selectGeneration) return;
      info = list.find((w) => w.id === id);
      if (!info) return;
    }
    const plan = resolveBackground(info);
    switch (plan.kind) {
      case 'video': layer.showVideo(plan.url); break;
      case 'image': layer.showImage(plan.url, plan.kenBurns); break;
      case 'web': layer.showWeb(plan.url); break;
      case 'scene': {
        if (opts.sceneRenderer) {
          const fg = document.createElement('canvas');
          const bg = document.createElement('canvas');
          try {
            let ok = await opts.sceneRenderer.render(plan.wallpaperId, fg, bg);
            if (!ok) {
              // Task 9 语义保留：wasm 失败时 fg 可能已被绑定 WebGPU context → 重建 canvas
              // 重试一次（组合层对已失败壁纸直接返回 false；2026-08-21 起 JS 渲染已禁用，
              // 重试仍走 wasm/组合层，最终失败落入下方 preview 回退）
              const fg2 = document.createElement('canvas');
              const bg2 = document.createElement('canvas');
              ok = await opts.sceneRenderer.render(plan.wallpaperId, fg2, bg2);
              if (ok) {
                if (gen !== selectGeneration) return;
                layer.showSceneCanvas(fg2, bg2);
                break;
              }
            }
            if (gen !== selectGeneration) return; // 期间已切换 → 丢弃旧渲染结果
            if (ok) { layer.showSceneCanvas(fg, bg); break; }
          } catch {
            if (gen !== selectGeneration) return;
            // 渲染异常（reject）→ 与失败同等对待，落入回退
          }
        }
        if (gen !== selectGeneration) return;
        // 渲染不可用/失败 → 回退 preview
        if (info.previewUrl) layer.showImage(info.previewUrl, !info.hasPreviewGif);
        else layer.showNone();
        break;
      }
      case 'none': layer.showNone(); break;
    }
  }

  return { load, select };
}
