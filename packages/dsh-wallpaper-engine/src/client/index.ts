import { injectWallpaperStyles } from './styles.js';
import { createBackgroundLayer } from './background-layer.js';
import { createWallpaperController } from './wallpaper-controller.js';
import { renderScene } from './scene-renderer.js';
import { createWasmSceneRenderer, createFallbackSceneRenderer } from './wasm-renderer.js';
import { mountPicker as mountPickerUI } from './picker.js';
import { readClientSettings, writeClientSettings, getUserPropertyValue } from './settings.js';
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
    // prepend 到 body 最前（在 #root 之前），配合 z-index:0 的壁纸层与 #root z-index:1 的层级方案
    // （参考 dsh-liang-skin 的做法），避免 z-index:-1 被 body/frame 不透明背景遮挡。
    document.body.prepend(root);
    layer = createBackgroundLayer(root);
    controller = createWallpaperController(layer, {
      fetchList: async () => (await fetch('/wallpapers/list')).json(),
      sceneRenderer: createFallbackSceneRenderer(createWasmSceneRenderer(), {
        // T4.2：注入可见性 user 绑定的用户属性 getter（localStorage 实现见 settings.ts；
        // renderScene 不硬依赖设置存储，键缺失回退绑定 value）
        render: (id, fg, bg) => renderScene(id, fg, bg, { getUserProperty: getUserPropertyValue }),
      }),
      // Task 8 回退链（spec §7 第 1/2/3 条，三级语义）：
      //   1. 无 WebGPU → createWasmSceneRenderer() 返回 null → 直接用 JS/Three.js 渲染器；
      //   2. wasm 加载/初始化失败（render resolve false）→ 组合层降级调用 JS 渲染器；
      //   3. wasm 与 JS 都渲染失败（零对象等，resolve false）→ controller 统一走 preview 图回退。
      // wasm-renderer 保持单一职责：WebGPU 可用时尝试 wasm，失败返回 false 由组合层降级。
    });
    // I2：浮动入口按钮 + picker 面板（不依赖 DSH 设置面板 slot API，避免未知集成风险）
    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'wp-fab';
    fab.title = '切换壁纸';
    fab.textContent = 'WP';
    const panel = document.createElement('div');
    panel.className = 'wp-picker-panel';
    panel.hidden = true;
    document.body.append(fab, panel);
    fab.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      if (panel.hidden) return;
      void mountPickerUI(panel, controller!, {
        currentId: settings.selectedWallpaperId,
        onSelect: (id) => {
          settings = { ...settings, selectedWallpaperId: id };
          void controller!.select(id).then(() => applySettingsToLayer(settings));
          void writeClientSettings({ selectedWallpaperId: id });
        },
      });
    });
    // 读回已保存设置并应用到 layer（opacity/blur/kenBurns）
    void readClientSettings().then((s) => {
      settings = s;
      applySettingsToLayer(s);
      // I1：恢复已保存的选中壁纸 —— 先 load 保证列表存在，再 select
      if (s.selectedWallpaperId && controller) {
        void controller.load().then(() => {
          if (controller && settings.selectedWallpaperId) void controller.select(settings.selectedWallpaperId);
        });
      }
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
        case 'web': layer.showWeb(plan.url); break;
        case 'scene': {
          // I6：委托 controller.select —— 统一 scene 渲染与 preview 回退语义
          // （渲染失败回退 preview 图，与 controller 一致），并受竞态防护约束
          void controller!.select(plan.wallpaperId).catch(() => {});
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

// Cordis 客户端插件入口：client loader 期待模块导出「函数」或「含 apply 的对象」
// （与官方 dsh-client-* 插件一致）。apply 在 fiber 应用阶段被调用，触发 bootstrap。
function apply(): void {
  bootstrap();
}

if (typeof window !== 'undefined') {
  const loader = window.__ModuleLoader__;
  if (loader?.load) {
    loader.load({
      id: '@dsh-use/wallpaper-engine',
      factory: () => ({ apply }),
    });
  } else {
    bootstrap();
  }
}
