import { injectWallpaperStyles } from './styles.js';
import { createBackgroundLayer } from './background-layer.js';
import { createWallpaperController } from './wallpaper-controller.js';
import { renderScene } from './scene-renderer.js';
import { mountPicker as mountPickerUI } from './picker.js';
import { readClientSettings, writeClientSettings } from './settings.js';
import type { BackgroundPlan, ClientSettings } from './types.js';

declare global {
  interface Window { __ModuleLoader__?: any; __DSH_BOOT__?: any; }
}

export function bootstrap(): void {
  injectWallpaperStyles();
  let layer: ReturnType<typeof createBackgroundLayer> | null = null;
  let controller: ReturnType<typeof createWallpaperController> | null = null;
  let settings: ClientSettings = {
    selectedWallpaperId: '', overlayOpacity: 0.35,
    blurEnabled: false, blurRadius: 12, kenBurns: true,
  };
  const applySettingsToLayer = (s: ClientSettings) => {
    if (!layer) return;
    layer.setOverlayOpacity(s.overlayOpacity);
    layer.setBlur(s.blurEnabled, s.blurRadius);
    if (!s.kenBurns) {
      layer.root.querySelectorAll('.wp-kenburns').forEach((el) => el.classList.remove('wp-kenburns'));
    }
  };
  const mount = () => {
    if (layer) return;
    const root = document.createElement('div');
    document.body.appendChild(root);
    layer = createBackgroundLayer(root);
    controller = createWallpaperController(layer, {
      fetchList: async () => (await fetch('/wallpapers/list')).json(),
      sceneRenderer: { render: renderScene }, // scene 壁纸 → Three.js 实时渲染（失败回退 preview）
    });
    // 读回已保存设置并应用到 layer（opacity/blur/kenBurns）
    void readClientSettings().then((s) => {
      settings = s;
      applySettingsToLayer(s);
    });
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
        case 'scene': {
          // 阶段 2：Three.js 实时渲染；canvas 由 controller/show 创建，失败回退 none
          const canvas = document.createElement('canvas');
          void renderScene(plan.wallpaperId, canvas).then((ok) => {
            if (ok) layer?.showSceneCanvas(canvas);
            else layer?.showNone();
          });
          break;
        }
        case 'none': layer.showNone(); break;
      }
      if (opts?.opacity !== undefined) layer.setOverlayOpacity(opts.opacity);
      if (opts?.blur !== undefined) layer.setBlur(opts.blur, opts.blurRadius ?? 12);
    },
    mountPicker(root: HTMLElement) {
      mount();
      if (!layer || !controller) return;
      return mountPickerUI(root, controller, {
        currentId: settings.selectedWallpaperId,
        onSelect: (id) => {
          settings = { ...settings, selectedWallpaperId: id };
          void controller!.select(id).then(() => applySettingsToLayer(settings));
          void writeClientSettings({ selectedWallpaperId: id });
        },
      });
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
