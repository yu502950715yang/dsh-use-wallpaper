import { injectWallpaperStyles } from './styles.js';
import { createBackgroundLayer } from './background-layer.js';
import { createWallpaperController } from './wallpaper-controller.js';
import { createThreeSceneRenderer } from './three-renderer.js';
import { WallpaperSettingsSection, setWallpaperSelectHandler, setWallpaperRuntimeHandler } from './settings-section.js';
import { readClientSettings, writeClientSettings, DEFAULTS, setSettingsCtx } from './settings.js';
import { createRenderHealthStore } from './render-health.js';
const SETTINGS_SECTION_ID = 'wallpaper-engine';
// 软失败冷却重试的等待时长：与 store 的 softCooldownMs 同一常量（单一事实源），
// 否则「等到冷却到期再问闸」与 store 的判定会各自漂移。
const SOFT_RETRY_DELAY_MS = 3000;
// 本实例收尾函数的全局登记点：DSH 的 rebuilt 重载会换掉模块实例（模块级变量全丢），
// 只有挂在 window 上的引用能让新实例找到旧实例、先让它收尾（见 mount 的单例清理）。
const TEARDOWN_KEY = '__wpEngineTeardown';
export function bootstrap(ctx) {
    // DSH 0.1.2-rc.1：设置走 ctx.remote.settings（Typert），须注入 settingsCtx 供读写
    setSettingsCtx(ctx);
    injectWallpaperStyles();
    let layer = null;
    let controller = null;
    let settings = { ...DEFAULTS };
    // 已收尾标记：ctx 释放（HMR drain 旧 fiber）后不得再有挂载/异步回调把插件复活。
    let disposed = false;
    // 本实例注册的 visibilitychange 监听（收尾时移除，否则每次重载留一份）。
    let onVisibility = null;
    // 看护存储：与 renderer 共用同一实例（面板/全局入口读的是同一份记忆）。
    const healthStore = createRenderHealthStore({ softCooldownMs: SOFT_RETRY_DELAY_MS });
    // three.js 场景渲染器：bootstrap 创建一次、跨壁纸复用（内部每次 render 重建 player）。
    // 这里持有引用，是为了把「省电 / 画质档位」直接下发——它们不在 controller 的渲染接口上。
    const sceneRenderer = createThreeSceneRenderer({ healthStore });
    // 两个可复用入口：全局 API 与面板共享 handler 都调它们（只此一份实现）。
    const clearRenderFailures = () => { healthStore.clearAll(); };
    const retryLive = () => {
        const id = settings.selectedWallpaperId;
        if (id)
            healthStore.clear(id);
        if (!id || !controller)
            return;
        void controller.select(id);
    };
    // 软失败冷却后自动重试一次（同一壁纸、每会话一次）；硬失败不自动重试。
    let autoRetryTimer = 0;
    const onHealth = (snap) => {
        // 只对软失败排重试：硬失败有证据表明这张壁纸渲染不出来，重试只会重复失败。
        if (!snap.wallpaperId || !snap.failure || snap.failure.hard)
            return;
        if (autoRetryTimer)
            return; // 已有一次待发生 ⇒ 不叠加
        // 打点即此刻 ⇒ 冷却闸此刻必为假，必须等到冷却到期再问闸（否则自动重试永不触发）。
        autoRetryTimer = window.setTimeout(() => {
            autoRetryTimer = 0;
            if (disposed || !controller)
                return;
            // 四项守卫：仍是当前选中 / 仍是同一个软失败 / 闸没用过 / 没被清过记忆。
            if (settings.selectedWallpaperId !== snap.wallpaperId)
                return;
            const now = healthStore.snapshot(snap.wallpaperId);
            if (!now.failure || now.failure.hard)
                return;
            if (!healthStore.shouldAutoRetry(snap.wallpaperId))
                return;
            healthStore.markAutoRetried(snap.wallpaperId);
            void controller.select(snap.wallpaperId);
        }, SOFT_RETRY_DELAY_MS);
    };
    sceneRenderer.setOnHealth?.(onHealth);
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
        // 壁纸音效开关：关掉即时停声并释放 AudioContext（打开按上次规格重播）。
        sceneRenderer.setSoundEnabled?.(s.soundEnabled);
        layer?.setPaused(shouldPause);
        // 贴壁纸文字颜色/描边：面板改动即时生效（手动档换色 / auto 档重测 preview），不必重选壁纸。
        controller?.applyTextStyle();
    };
    const selectWallpaper = (id) => {
        settings = { ...settings, selectedWallpaperId: id };
        void controller.select(id).then(() => applySettingsToLayer(settings));
        void writeClientSettings({ selectedWallpaperId: id });
    };
    // 本实例收尾：停 scene 渲染器（WebGL/wasm/音频）→ 清空并摘掉背景层 → 注销监听。
    // 幂等（可被 ctx drain 与下一个实例的 mount 各调一次）。
    const teardown = () => {
        if (disposed)
            return;
        disposed = true;
        // 收尾：撤掉挂起的自动重试与健康订阅（否则延迟的回调会落到已释放的渲染器/层上）。
        if (autoRetryTimer) {
            clearTimeout(autoRetryTimer);
            autoRetryTimer = 0;
        }
        sceneRenderer.setOnHealth?.(null);
        const root = layer?.root ?? null;
        try {
            controller?.select('');
        }
        catch { /* 收尾失败也必须摘层，否则又变成盖住新实例的残留层 */ }
        layer = null;
        controller = null;
        root?.remove();
        if (onVisibility) {
            document.removeEventListener('visibilitychange', onVisibility);
            onVisibility = null;
        }
        if (window[TEARDOWN_KEY] === teardown)
            delete window[TEARDOWN_KEY];
    };
    // 单例清理：先让上一个实例自己收尾（释放 GL/音频/wasm），再按 DOM 兜底摘掉无主的残留层 ——
    // 老版本插件没有 teardown（真机升级路径上会剩 9 层），只能靠这里连同它的 GL 上下文一起丢掉。
    const dropStaleLayers = () => {
        const previous = window[TEARDOWN_KEY];
        if (typeof previous === 'function') {
            try {
                previous();
            }
            catch { /* 旧实例收尾失败不阻断本次挂载 */ }
        }
        // 无 WebGL 的环境（jsdom / 测试）不碰 canvas：它不可能持有 GL 上下文
        const hasGl = typeof WebGL2RenderingContext !== 'undefined';
        for (const el of Array.from(document.querySelectorAll('.wp-background-layer'))) {
            if (hasGl) {
                for (const canvas of Array.from(el.querySelectorAll('canvas'))) {
                    try {
                        canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
                    }
                    catch { /* 非 GL canvas / 已丢失 */ }
                }
            }
            for (const video of Array.from(el.querySelectorAll('video'))) {
                try {
                    video.pause();
                    video.removeAttribute('src');
                    video.load();
                }
                catch { /* 未插入 DOM 等，忽略 */ }
            }
            el.remove();
        }
    };
    const mount = () => {
        if (disposed || layer)
            return;
        dropStaleLayers();
        const root = document.createElement('div');
        // prepend 到 body 最前（在 #root 之前），配合 z-index:0 的壁纸层与 #root z-index:1 的层级方案
        // （参考 dsh-liang-skin 的做法），避免 z-index:-1 被 body/frame 不透明背景遮挡。
        document.body.prepend(root);
        layer = createBackgroundLayer(root);
        controller = createWallpaperController(layer, {
            fetchList: async () => (await fetch('/wallpapers/list')).json(),
            // three.js 播放器是**唯一** scene 路径；渲染失败/零可见对象 → controller 回退 preview 图。
            sceneRenderer,
            // 贴壁纸文字颜色/描边：实时读取设置（手动档直接固定色、跳过 preview 测量；auto 档沿用亮度测量）。
            textStyle: () => ({
                mode: settings.textColorMode,
                custom: settings.textColor,
                outline: settings.textOutline,
            }),
        });
        // 设置面板（settings-section）的壁纸切换/取消经共享 handler 委托 controller
        setWallpaperSelectHandler((id) => selectWallpaper(id));
        // 设置面板改省电/画质档位 → 立即下发（不必重选壁纸）
        setWallpaperRuntimeHandler((patch) => {
            settings = { ...settings, ...patch };
            applyRuntimeSettings(settings);
        });
        // 切到后台/最小化 → 按设置自动暂停（省电），回到前台恢复。
        onVisibility = () => applyRuntimeSettings(settings);
        document.addEventListener('visibilitychange', onVisibility);
        // 读回已保存设置并应用到 layer（opacity/blur/kenBurns）与运行期项（暂停/画质档位）
        void readClientSettings().then((s) => {
            if (disposed)
                return; // 期间已收尾（HMR drain）→ 不再复活
            settings = s;
            applySettingsToLayer(s);
            applyRuntimeSettings(s);
            // I1：恢复已保存的选中壁纸 —— 先 load 保证列表存在，再 select
            if (s.selectedWallpaperId && controller) {
                void controller.load().then(() => {
                    if (!disposed && controller && settings.selectedWallpaperId)
                        void controller.select(settings.selectedWallpaperId);
                });
            }
        });
        window[TEARDOWN_KEY] = teardown;
    };
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
        // 手动卸载（排查/救急用）：收尾并摘掉背景层；下次 mount 可重新挂载。
        teardown,
        select(id) {
            mount();
            if (!controller)
                return;
            // 同步记住选中项：retryLive / 自动重试按「当前选中的壁纸」定位（面板路径见 selectWallpaper）。
            settings = { ...settings, selectedWallpaperId: id };
            void controller.select(id);
        },
        // 看护入口（面板与排查用）：读状态 / 重试当前壁纸 / 清空全部失败记忆。
        health: () => sceneRenderer.getLastHealth?.() ?? null,
        retryLive,
        clearRenderFailures,
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
    // ctx 释放（DSH client-hmr 的 rebuilt 重载会 drain 旧 fiber，再以全新状态重挂载插件）：
    // 必须在这里收尾 —— 否则旧背景层留在 body 里，与 z-index 同为 0 的新层按 DOM 序压在上面
    // ⇒ 新实例渲染的壁纸被旧层盖住（真机「选了魔兽之门仍显示三角洲」，层数累计到 9）。
    if (typeof ctx?.effect === 'function')
        ctx.effect(() => teardown, 'wallpaper-engine: teardown');
    else if (typeof ctx?.on === 'function')
        ctx.on('dispose', teardown);
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
