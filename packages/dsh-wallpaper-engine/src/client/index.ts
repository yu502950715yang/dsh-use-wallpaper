import { injectWallpaperStyles } from './styles.js';
import { createBackgroundLayer } from './background-layer.js';
import type { BackgroundPlan } from './types.js';

declare global {
  interface Window { __ModuleLoader__?: any; __DSH_BOOT__?: any; }
}

export function bootstrap(): void {
  injectWallpaperStyles();
  let layer: ReturnType<typeof createBackgroundLayer> | null = null;
  const mount = () => {
    if (layer) return;
    const root = document.createElement('div');
    document.body.appendChild(root);
    layer = createBackgroundLayer(root);
  };
  // 延迟到 DOM 就绪
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
  // 暴露渲染 API（picker 与设置面板调用）
  (window as any).__wallpaperEngine = {
    mount,
    show(plan: BackgroundPlan, opts?: { opacity?: number; blur?: boolean; blurRadius?: number }) {
      mount();
      if (!layer) return;
      switch (plan.kind) {
        case 'image': layer.showImage(plan.url, plan.kenBurns); break;
        case 'video': layer.showVideo(plan.url); break;
        case 'scene': break; // 阶段 2 接入 SceneRenderer
        case 'none': layer.showNone(); break;
      }
      if (opts?.opacity !== undefined) layer.setOverlayOpacity(opts.opacity);
      if (opts?.blur !== undefined) layer.setBlur(opts.blur, opts.blurRadius ?? 12);
    },
  };
}

if (typeof window !== 'undefined') {
  const loader = window.__ModuleLoader__;
  if (loader?.load) {
    loader.load({
      id: '@dsh-use/wallpaper-engine',
      factory: () => { bootstrap(); return { bootstrap }; },
    });
  } else {
    bootstrap();
  }
}
