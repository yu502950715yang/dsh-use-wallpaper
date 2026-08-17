import type { WallpaperInfo } from '../shared/types.js';
import type { BackgroundLayer } from './background-layer.js';
import { resolveBackground } from './background-layer.js';

export interface WallpaperControllerOptions {
  fetchList: () => Promise<WallpaperInfo[]>;
  sceneRenderer?: { render(wallpaperId: string, canvas: HTMLCanvasElement): Promise<boolean> };
}

export function createWallpaperController(
  layer: BackgroundLayer,
  opts: WallpaperControllerOptions,
) {
  let list: WallpaperInfo[] = [];

  async function load(): Promise<WallpaperInfo[]> {
    list = await opts.fetchList();
    return list;
  }

  async function select(id: string): Promise<void> {
    const info = list.find((w) => w.id === id);
    if (!info) return;
    const plan = resolveBackground(info);
    switch (plan.kind) {
      case 'video': layer.showVideo(plan.url); break;
      case 'image': layer.showImage(plan.url, plan.kenBurns); break;
      case 'scene': {
        if (opts.sceneRenderer) {
          const canvas = document.createElement('canvas');
          const ok = await opts.sceneRenderer.render(plan.wallpaperId, canvas);
          if (ok) { layer.showSceneCanvas(canvas); break; }
        }
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
