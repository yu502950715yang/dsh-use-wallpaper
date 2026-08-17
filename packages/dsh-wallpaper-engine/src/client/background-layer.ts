import type { WallpaperInfo } from '../shared/types.js';
import type { BackgroundPlan } from './types.js';

export function resolveBackground(info: WallpaperInfo): BackgroundPlan {
  if (info.type === 'scene' && info.hasScene) {
    return { kind: 'scene', wallpaperId: info.id };
  }
  if (info.type === 'video' && info.file) {
    return { kind: 'video', url: `/wallpapers/media/${info.id}/file` };
  }
  if (info.previewUrl) {
    return { kind: 'image', url: info.previewUrl, kenBurns: !info.hasPreviewGif };
  }
  return { kind: 'none' };
}

export function applyKenBurns(el: HTMLElement, enabled: boolean): void {
  el.classList.toggle('wp-kenburns', enabled);
}

export interface BackgroundLayer {
  root: HTMLElement;
  showImage(url: string, kenBurns: boolean): void;
  showVideo(url: string): void;
  showSceneCanvas(canvas: HTMLCanvasElement): void;
  showNone(): void;
  setOverlayOpacity(v: number): void;
  setBlur(enabled: boolean, radius: number): void;
}

export function createBackgroundLayer(root: HTMLElement): BackgroundLayer {
  root.classList.add('wp-background-layer');
  const fill = document.createElement('div');
  fill.className = 'wp-bg-fill';
  root.appendChild(fill);
  const overlay = document.createElement('div');
  overlay.className = 'wp-bg-overlay';
  root.appendChild(overlay);

  function clear() { fill.replaceChildren(); }

  return {
    root,
    showImage(url, kenBurns) {
      clear();
      const img = document.createElement('img');
      img.src = url;
      applyKenBurns(img, kenBurns);
      fill.appendChild(img);
    },
    showVideo(url) {
      clear();
      const video = document.createElement('video');
      video.src = url;
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      fill.appendChild(video);
    },
    showSceneCanvas(canvas) {
      clear();
      canvas.classList.add('wp-scene-canvas');
      fill.appendChild(canvas);
    },
    showNone() { clear(); },
    setOverlayOpacity(v) { overlay.style.opacity = String(v); },
    setBlur(enabled, radius) {
      fill.style.filter = enabled ? `blur(${radius}px)` : '';
    },
  };
}
