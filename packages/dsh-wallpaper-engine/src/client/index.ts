import { injectWallpaperStyles } from './styles.js';
import { createBackgroundLayer } from './background-layer.js';
import { createWallpaperController } from './wallpaper-controller.js';
import { renderScene } from './scene-renderer.js';
import { createWasmSceneRenderer, createFallbackSceneRenderer } from './wasm-renderer.js';
import { WallpaperSettingsSection, setWallpaperSelectHandler } from './settings-section.js';
import { readClientSettings, writeClientSettings, getUserPropertyValue, DEFAULTS } from './settings.js';
import type { BackgroundPlan, ClientSettings } from './types.js';

declare global {
  interface Window { __ModuleLoader__?: any; __DSH_BOOT__?: any; }
}

// 设置对话框侧边栏 "壁纸" 菜单项 id（slots settings.section 注册）
export const SETTINGS_SECTION_ID = 'wallpaper-engine';

export function bootstrap(ctx?: any): void {
  injectWallpaperStyles();
  let layer: ReturnType<typeof createBackgroundLayer> | null = null;
  let controller: ReturnType<typeof createWallpaperController> | null = null;
  let settings: ClientSettings = { ...DEFAULTS };
  const applySettingsToLayer = (s: ClientSettings) => {
    if (!layer) return;
    layer.setOverlayOpacity(s.overlayOpacity);
    layer.setBlur(s.blurEnabled, s.blurRadius);
    if (!s.kenBurns) {
      layer.root.querySelectorAll('.wp-kenburns').forEach((el) => el.classList.remove('wp-kenburns'));
    }
  };
  const selectWallpaper = (id: string) => {
    settings = { ...settings, selectedWallpaperId: id };
    void controller!.select(id).then(() => applySettingsToLayer(settings));
    void writeClientSettings({ selectedWallpaperId: id });
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
    // 设置面板（settings-section）的壁纸切换/取消经共享 handler 委托 controller
    setWallpaperSelectHandler((id: string) => selectWallpaper(id));
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
  // 暴露渲染 API（设置面板与外部调用）
  (window as any).__wallpaperEngine = {
    mount,
    select(id: string) {
      mount();
      if (!controller) return;
      void controller.select(id);
    },
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
  };
  // 注册 DSH 设置对话框侧边栏 "壁纸" 菜单（settings.section slot）：
  // 菜单项 id/order/label，内容组件 WallpaperSettingsSection（网格/取消/路径配置）。
  // ctx.slots 由 dsh-client-runtime 的 SlotRegistry 提供（client 插件共享根上下文）。
  if (ctx?.slots?.inject && ctx?.slots?.register) {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: SETTINGS_SECTION_ID,
      order: 20,
      label: () => '壁纸',
    }, WallpaperSettingsSection));
  }
}

// Cordis 客户端插件入口：client loader 期待模块导出「函数」或「含 apply 的对象」
// （与官方 dsh-client-* 插件一致）。apply 在 fiber 应用阶段被调用，触发 bootstrap。
// 注意：bundle 的注册由构建产物 wrapper（window.__ModuleLoader__.load）完成，
// 本文件不得再调用 loader.load —— 否则 factory 内二次注册同 id（duplicate registration）。
export function apply(ctx: any): void {
  bootstrap(ctx);
}

// Cordis 依赖声明：apply 通过 ctx.slots 注册设置菜单（settings.section slot），
// 必须 inject 'slots' 服务（官方 client 插件同样导出 inject 数组）。
export const inject = ['slots'];
