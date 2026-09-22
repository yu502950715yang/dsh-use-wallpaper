import { injectWallpaperStyles } from './styles.js';
import { createBackgroundLayer } from './background-layer.js';
import { createWallpaperController } from './wallpaper-controller.js';
import { createThreeSceneRenderer } from './three-renderer.js';
import { WallpaperSettingsSection, setWallpaperSelectHandler, setWallpaperRuntimeHandler } from './settings-section.js';
import { readClientSettings, writeClientSettings, DEFAULTS, setSettingsCtx } from './settings.js';
const SETTINGS_SECTION_ID = 'wallpaper-engine';
export function bootstrap(ctx) {
    // DSH 0.1.2-rc.1：设置走 ctx.remote.settings（Typert），须注入 settingsCtx 供读写
    setSettingsCtx(ctx);
    injectWallpaperStyles();
    let layer = null;
    let controller = null;
    let settings = { ...DEFAULTS };
    // three.js 场景渲染器：bootstrap 创建一次、跨壁纸复用（内部每次 render 重建 player）。
    // 这里持有引用，是为了把「省电 / 画质档位」直接下发——它们不在 controller 的渲染接口上。
    const sceneRenderer = createThreeSceneRenderer();
    const applySettingsToLayer = (s) => {
        if (!layer)
            return;
        layer.setOverlayOpacity(s.overlayOpacity);
        layer.setBlur(s.blurEnabled, s.blurRadius);
        if (!s.kenBurns) {
            layer.root.querySelectorAll('.wp-kenburns').forEach((el) => el.classList.remove('wp-kenburns'));
        }
    };
    // 省电与画质档位：每次按「设置 + 当前可见性」重算（不做增量维护，避免状态漂移）。
    const applyRuntimeSettings = (s) => {
        const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
        const shouldPause = s.paused || (s.pauseOnHidden && hidden);
        sceneRenderer.setPaused?.(shouldPause);
        sceneRenderer.setQualityScale?.(s.qualityScale);
        // 应用级 Glow：开关/阈值/强度一并即时下发（已装配则就地改 uniform，无需重选壁纸）
        sceneRenderer.setGlow?.({ enabled: s.glowEnabled, threshold: s.glowThreshold, strength: s.glowStrength });
        layer?.setPaused(shouldPause);
    };
    const selectWallpaper = (id) => {
        settings = { ...settings, selectedWallpaperId: id };
        void controller.select(id).then(() => applySettingsToLayer(settings));
        void writeClientSettings({ selectedWallpaperId: id });
    };
    const mount = () => {
        if (layer)
            return;
        const root = document.createElement('div');
        // prepend 到 body 最前（在 #root 之前），配合 z-index:0 的壁纸层与 #root z-index:1 的层级方案
        // （参考 dsh-liang-skin 的做法），避免 z-index:-1 被 body/frame 不透明背景遮挡。
        document.body.prepend(root);
        layer = createBackgroundLayer(root);
        controller = createWallpaperController(layer, {
            fetchList: async () => (await fetch('/wallpapers/list')).json(),
            // three.js 播放器是**唯一** scene 路径；渲染失败/零可见对象 → controller 回退 preview 图。
            sceneRenderer,
        });
        // 设置面板（settings-section）的壁纸切换/取消经共享 handler 委托 controller
        setWallpaperSelectHandler((id) => selectWallpaper(id));
        // 设置面板改省电/画质档位 → 立即下发（不必重选壁纸）
        setWallpaperRuntimeHandler((patch) => {
            settings = { ...settings, ...patch };
            applyRuntimeSettings(settings);
        });
        // 读回已保存设置并应用到 layer（opacity/blur/kenBurns）与运行期项（暂停/画质档位）
        void readClientSettings().then((s) => {
            settings = s;
            applySettingsToLayer(s);
            applyRuntimeSettings(s);
            // I1：恢复已保存的选中壁纸 —— 先 load 保证列表存在，再 select
            if (s.selectedWallpaperId && controller) {
                void controller.load().then(() => {
                    if (controller && settings.selectedWallpaperId)
                        void controller.select(settings.selectedWallpaperId);
                });
            }
        });
    };
    // 切到后台/最小化 → 按设置自动暂停（省电），回到前台恢复。
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => applyRuntimeSettings(settings));
    }
    // 延迟到 DOM 就绪
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount, { once: true });
    }
    else {
        mount();
    }
    // 暴露渲染 API（设置面板与外部调用）
    window.__wallpaperEngine = {
        mount,
        select(id) {
            mount();
            if (!controller)
                return;
            void controller.select(id);
        },
        show(plan, opts) {
            mount();
            if (!layer)
                return;
            switch (plan.kind) {
                case 'image':
                    layer.showImage(plan.url, plan.kenBurns);
                    break;
                case 'video':
                    layer.showVideo(plan.url);
                    break;
                case 'web':
                    layer.showWeb(plan.url);
                    break;
                case 'scene': {
                    // I6：委托 controller.select —— 统一 scene 渲染与 preview 回退语义
                    // （渲染失败回退 preview 图，与 controller 一致），并受竞态防护约束
                    void controller.select(plan.wallpaperId).catch(() => { });
                    break;
                }
                case 'none':
                    layer.showNone();
                    break;
            }
            if (opts?.opacity !== undefined)
                layer.setOverlayOpacity(opts.opacity);
            if (opts?.blur !== undefined)
                layer.setBlur(opts.blur, opts.blurRadius ?? 12);
        },
    };
    // 注册 DSH 设置对话框侧边栏 "Wallpaper 壁纸" 菜单（settings.section slot）：
    // 菜单项 id/order/label，内容组件 WallpaperSettingsSection（网格/取消/路径配置）。
    // ctx.slots 由 dsh-client-runtime 的 SlotRegistry 提供（client 插件共享根上下文）。
    if (ctx?.slots?.inject && ctx?.slots?.register) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: SETTINGS_SECTION_ID,
            order: 20,
            label: () => 'Wallpaper 壁纸',
        }, WallpaperSettingsSection));
    }
}
// Cordis 客户端插件入口：client loader 期待模块导出「函数」或「含 apply 的对象」
// （与官方 dsh-client-* 插件一致）。apply 在 fiber 应用阶段被调用，触发 bootstrap。
// 注意：bundle 的注册由构建产物 wrapper（window.__ModuleLoader__.load）完成，
// 本文件不得再调用 loader.load —— 否则 factory 内二次注册同 id（duplicate registration）。
export function apply(ctx) {
    bootstrap(ctx);
}
// Cordis 依赖声明：apply 通过 ctx.slots 注册设置菜单（settings.section slot），
// 并通过 ctx.remote.settings 读写插件设置（官方 client 插件同款注入）。
// 必须 inject 'slots'、'remote'、'remote.settings' 服务。
export const inject = ['slots', 'remote', 'remote.settings'];
