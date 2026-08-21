import type { WallpaperInfo } from '../shared/types.js';
import type { BackgroundLayer } from './background-layer.js';
import { resolveBackground } from './background-layer.js';

export interface WallpaperControllerOptions {
  fetchList: () => Promise<WallpaperInfo[]>;
  sceneRenderer?: { render(wallpaperId: string, fg: HTMLCanvasElement, bg?: HTMLCanvasElement): Promise<boolean> };
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
    const info = list.find((w) => w.id === id);
    if (!info) return;
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
