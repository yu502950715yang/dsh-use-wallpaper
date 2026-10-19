import { injectWallpaperStyles } from './styles.js';
import { createBackgroundLayer } from './background-layer.js';
import { createWallpaperController } from './wallpaper-controller.js';
import { createThreeSceneRenderer } from './three-renderer.js';
import { ensureSceneFrame, showSceneFallback } from './scene-fallback.js';
import { WallpaperSettingsSection, setWallpaperSelectHandler, setWallpaperRuntimeHandler, setWallpaperHealthHandler, setWallpaperMediaHandler, setWallpaperReselectHandler, notifyWallpaperHealth, notifyWallpaperMedia } from './settings-section.js';
import { readClientSettings, writeClientSettings, DEFAULTS, setSettingsCtx } from './settings.js';
import { createRenderHealthStore } from './render-health.js';
import { createMediaHealthStore } from './media-health.js';
import { markRecent, loadLibraryState } from './library-view.js';
import { buildRotationPool, createRotationScheduler, normalizeRotationOrder } from './rotation.js';
const SETTINGS_SECTION_ID = 'wallpaper-engine';
// 软失败冷却重试的等待时长：与 store 的 softCooldownMs 同一常量（单一事实源），
// 否则「等到冷却到期再问闸」与 store 的判定会各自漂移。
const SOFT_RETRY_DELAY_MS = 3000;
// 本实例收尾函数的全局登记点：DSH 的 rebuilt 重载会换掉模块实例（模块级变量全丢），
// 只有挂在 window 上的引用能让新实例找到旧实例、先让它收尾（见 mount 的单例清理）。
const TEARDOWN_KEY = '__wpEngineTeardown';
// show() 只拿到视频 URL：失败提示需要归属 id（解析不到也不影响面板文案）。
function videoWallpaperId(url) {
    const m = /\/wallpapers\/media\/([^/]+)\/file/.exec(url);
    if (!m)
        return url;
    try {
        return decodeURIComponent(m[1]);
    }
    catch {
        return m[1];
    } // 非法百分号编码不抛
}
export function bootstrap(ctx) {
    // DSH 0.1.2-rc.1：设置走 ctx.remote.settings（Typert），须注入 settingsCtx 供读写
    setSettingsCtx(ctx);
    injectWallpaperStyles();
    let layer = null;
    let controller = null;
    let settings = { ...DEFAULTS };
    // 已收尾标记：ctx 释放（HMR drain 旧 fiber）后不得再有挂载/异步回调把插件复活。
    let disposed = false;
    // 视频解码失败记忆（内存、不落盘）：面板只提示最近一条；重新选壁纸时清除。
    const mediaHealth = createMediaHealthStore();
    const unsubscribeMedia = mediaHealth.subscribe((failure) => {
        if (!disposed)
            notifyWallpaperMedia(failure);
    });
    // 背景切换代号：show() 的视频结果（1.5s 超时）迟到时，不得落到期间已换上的新壁纸。
    let backgroundToken = 0;
    // 本实例注册的 visibilitychange 监听（收尾时移除，否则每次重载留一份）。
    let onVisibility = null;
    // 看护存储：与 renderer 共用同一实例（面板/全局入口读的是同一份记忆）。
    const healthStore = createRenderHealthStore({ softCooldownMs: SOFT_RETRY_DELAY_MS });
    // three.js 场景渲染器：bootstrap 创建一次、跨壁纸复用（内部每次 render 重建 player）。
    // 这里持有引用，是为了把「省电 / 画质档位」直接下发——它们不在 controller 的渲染接口上。
    const sceneRenderer = createThreeSceneRenderer({ healthStore });
    // 自动轮播：池/当前项/暂停都实时读取；启停由 applyRuntimeSettings 与 mount/teardown 同步。
    let rotationPaused = false;
    const rotation = createRotationScheduler({
        getPool: () => buildRotationPool(controller?.getList() ?? [], loadLibraryState()),
        getCurrentId: () => settings.selectedWallpaperId,
        // manual=false：轮播自身的切换不得清空失败记忆（否则「本会话跳过」形同虚设）。
        select: (id) => selectWallpaper(id, false),
        isPaused: () => rotationPaused,
        intervalMs: settings.rotationIntervalMs,
        order: normalizeRotationOrder(settings.rotationOrder),
    });
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
    // 定时器按壁纸一份：共享一个的话，后一张壁纸的软失败会被前一张的定时器吞掉，没人给它排重试。
    const autoRetryTimers = new Map();
    // 面板读到的是「当前选中壁纸」的状态：选中项与快照壁纸不一致（非 scene 壁纸、还没渲染过）时
    // 必须为空，否则会把上一张 scene 的结论串到面板上。
    const panelHealth = () => {
        const snap = sceneRenderer.getLastHealth?.() ?? null;
        return snap && snap.wallpaperId === settings.selectedWallpaperId ? snap : null;
    };
    const onHealth = (snap) => {
        // 硬失败 ⇒ 本会话轮播跳过这张（软失败还会冷却重试，不跳过）。
        if (snap.wallpaperId && snap.failure?.hard)
            rotation.markFailed(snap.wallpaperId);
        // 只推「当前选中壁纸」：切走后旧壁纸迟到的打点会常驻面板，而 get() 已是 null、
        // 该失败文案对应的「重试」还会作用到另一张壁纸（读实时选中项，不用缓存值）。
        if (snap.wallpaperId === settings.selectedWallpaperId)
            notifyWallpaperHealth(snap);
        // 只对软失败排重试：硬失败有证据表明这张壁纸渲染不出来，重试只会重复失败。
        if (!snap.wallpaperId || !snap.failure || snap.failure.hard)
            return;
        const id = snap.wallpaperId;
        // 每次软失败都按完整冷却重排（先撤旧的）：同一次 select 会连打两次点（fg→fg2），
        // 第二次把 store 的 at 推晚了，沿用旧到期时刻就会算出 now-at < 冷却 ⇒ 闸假、永不重试。
        const existing = autoRetryTimers.get(id);
        if (existing)
            clearTimeout(existing);
        autoRetryTimers.set(id, window.setTimeout(() => {
            autoRetryTimers.delete(id);
            if (disposed || !controller)
                return;
            if (settings.selectedWallpaperId !== id)
                return; // 用户已切走 ⇒ 不把人家拽回来
            if (!healthStore.shouldAutoRetry(id))
                return; // 兜底：期间已成功 / 记忆被清 / 已被别的路径重试过
            healthStore.markAutoRetried(id); // 每会话每壁纸一次（重试后再次软失败不会成环）
            void controller.select(id);
        }, SOFT_RETRY_DELAY_MS));
    };
    sceneRenderer.setOnHealth?.(onHealth);
    const applySettingsToLayer = (s) => {
        if (!layer)
            return;
        layer.setOverlayOpacity(s.overlayOpacity);
        layer.setBlur(s.blurEnabled, s.blurRadius);
        layer.setKenBurns(s.kenBurns);
        layer.setFitMode(s.fitMode);
    };
    // 省电与画质档位：每次按「设置 + 当前可见性」重算（不做增量维护，避免状态漂移）。
    const applyRuntimeSettings = (s) => {
        const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
        const shouldPause = s.paused || (s.pauseOnHidden && hidden);
        rotationPaused = shouldPause;
        sceneRenderer.setPaused?.(shouldPause);
        sceneRenderer.setQualityScale?.(s.qualityScale);
        // 应用级 Glow：开关/阈值/强度一并即时下发（已装配则就地改 uniform，无需重选壁纸）
        sceneRenderer.setGlow?.({ enabled: s.glowEnabled, threshold: s.glowThreshold, strength: s.glowStrength });
        // 壁纸音效开关：关掉即时停声并释放 AudioContext（打开按上次规格重播）。
        sceneRenderer.setSoundEnabled?.(s.soundEnabled);
        layer?.setPaused(shouldPause);
        // 贴壁纸文字颜色/描边：面板改动即时生效（手动档换色 / auto 档重测 preview），不必重选壁纸。
        controller?.applyTextStyle();
        // 轮播：间隔/顺序随设置即时生效；启用开关同步启停（暂停/页面隐藏时停表）。
        rotation.setConfig({ intervalMs: s.rotationIntervalMs, order: normalizeRotationOrder(s.rotationOrder) });
        if (s.rotationEnabled)
            rotation.start();
        else
            rotation.stop();
        rotation.setPaused(shouldPause);
    };
    // 选择壁纸（面板/外部与轮播共用）：成功后才落层/写最近/刷新状态；manual=false（轮播自身切换）不清失败记忆。
    async function selectWallpaper(id, manual = true) {
        backgroundToken += 1;
        mediaHealth.clear(); // 重新选壁纸即清掉上一条媒体失败提示
        settings = { ...settings, selectedWallpaperId: id };
        void writeClientSettings({ selectedWallpaperId: id });
        if (!controller)
            return;
        try {
            await controller.select(id);
        }
        catch {
            // 单次切换失败保持现状（轮播下一拍再试；调用方均为 void 调用，不得产生 unhandled rejection）
            return;
        }
        applySettingsToLayer(settings);
        markRecent(id); // 切换成功才记入「最近使用」（空 id = 取消，markRecent 内部忽略）
        if (manual)
            rotation.notifyManualSelect(); // 手动选择重置轮播计时并清失败记忆
        notifyWallpaperHealth(panelHealth()); // 选中后补推一次：切壁纸即刷新状态行（不必等下一次健康事件）
    }
    // 本实例收尾：停 scene 渲染器（WebGL/wasm/音频）→ 清空并摘掉背景层 → 注销监听。
    // 幂等（可被 ctx drain 与下一个实例的 mount 各调一次）。
    const teardown = () => {
        if (disposed)
            return;
        disposed = true;
        // 撤掉轮播定时器：收尾/HMR 后不得再有挂载实例的自动切换（只允许存在一份）。
        rotation.stop();
        // 收尾：撤掉全部在途的自动重试与健康订阅（否则延迟的回调会落到已释放的渲染器/层上）。
        for (const t of autoRetryTimers.values())
            clearTimeout(t);
        autoRetryTimers.clear();
        sceneRenderer.setOnHealth?.(null);
        setWallpaperMediaHandler(null); // 面板媒体失败提示回初始态
        setWallpaperReselectHandler(null); // 面板属性开关不再指向已释放的 controller
        unsubscribeMedia();
        notifyWallpaperHealth(null); // 收尾后状态行不得再显示已释放渲染器的旧状态（面板可能还开着）
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
            // 视频编码兜底：失败回退 preview 由 controller 完成，这里只记失败供面板提示。
            // 期间已切走（selectedWallpaperId 变了）的迟到失败不上报。
            onMediaFailure: (id, kind, fallback) => {
                if (settings.selectedWallpaperId !== id)
                    return;
                mediaHealth.set(id, kind, fallback);
            },
            // scene 成功显示 → 后台抓首帧缓存（下次冷启动可直接作为降级帧）；失败只 warn，不阻塞渲染。
            onSceneLive: (info) => {
                if (!settings.frameCacheEnabled)
                    return;
                void ensureSceneFrame(info.id, {
                    fetch: window.fetch.bind(window),
                    // 抓帧前再确认仍是当前壁纸：HEAD 期间切走后渲染器已换成新壁纸，不得把新画面存进旧 id。
                    renderer: {
                        captureFrame: () => (settings.selectedWallpaperId === info.id
                            ? sceneRenderer.captureFrame?.() ?? Promise.resolve(null)
                            : Promise.resolve(null)),
                    },
                });
            },
            // scene 渲染失败/不可用 → 多级降级链（内嵌视频 → 抓帧 → preview）；显示成功即清掉失败记忆。
            sceneFallback: async (info) => {
                // 降级链没有 generation 参数：用「仍是当前选中壁纸」守卫，防视频探测（≤1.5s）迟到后覆盖新壁纸。
                const current = () => settings.selectedWallpaperId === info.id;
                const result = await showSceneFallback(info, {
                    fetch: window.fetch.bind(window),
                    layer: {
                        showVideo: (url) => (current() ? layer.showVideo(url) : Promise.resolve('unsupported')),
                        showImage: (url, kenBurns) => { if (current())
                            layer.showImage(url, kenBurns); },
                        showNone: () => { if (current())
                            layer.showNone(); },
                    },
                });
                if ((result === 'video' || result === 'frame') && current())
                    healthStore.clear(info.id);
            },
        });
        // 设置面板（settings-section）的壁纸切换/取消经共享 handler 委托 controller
        setWallpaperSelectHandler((id) => { void selectWallpaper(id); });
        // 用户属性切换后重装配当前壁纸：属性值只在装配时读取，故重新 select（不弹提示/不写设置）
        setWallpaperReselectHandler((id) => { void controller?.select(id); });
        // 设置面板改显示效果/省电/画质档位 → 立即下发（layer 与渲染器都要，不必重选壁纸）
        setWallpaperRuntimeHandler((patch) => {
            settings = { ...settings, ...patch };
            applySettingsToLayer(settings);
            applyRuntimeSettings(settings);
        });
        // 设置面板「实时渲染」卡片：读状态 / 重试当前壁纸 / 清空全部失败记忆（与全局入口同一份实现）
        setWallpaperHealthHandler({
            get: panelHealth,
            retry: retryLive,
            // 清记忆后补推当前快照（不是 null）：clearAll 保留成功结论 ⇒ 状态行仍显示「实时渲染正常」。
            clearFailures: () => { clearRenderFailures(); notifyWallpaperHealth(panelHealth()); },
        });
        // 设置面板「媒体失败提示」：读最近一条视频解码失败；清除按钮回空态。
        setWallpaperMediaHandler({
            get: mediaHealth.get,
            clear: () => { mediaHealth.clear(); },
        });
        // 切到后台/最小化 → 按设置自动暂停（省电），回到前台恢复。
        onVisibility = () => applyRuntimeSettings(settings);
        document.addEventListener('visibilitychange', onVisibility);
        // 读回已保存设置并应用到 layer（opacity/blur/kenBurns/fitMode）与运行期项（暂停/画质档位）
        void readClientSettings().then((s) => {
            if (disposed)
                return; // 期间已收尾（HMR drain）→ 不再复活
            // 启动窗口内用户可能已经选过壁纸 ⇒ 异步读回的持久值不得把它冲掉（否则 retryLive/自动重试定位不到）
            settings = { ...s, selectedWallpaperId: settings.selectedWallpaperId || s.selectedWallpaperId };
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
        // 启动时若已启用轮播则开始计时（读回设置前 settings 还是 DEFAULTS，真正启动在 applyRuntimeSettings）。
        if (settings.rotationEnabled)
            rotation.start();
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
            backgroundToken += 1;
            mediaHealth.clear(); // 手动切换同样清掉上一条媒体失败提示
            // 同步记住选中项：retryLive / 自动重试按「当前选中的壁纸」定位（面板路径见 selectWallpaper）。
            settings = { ...settings, selectedWallpaperId: id };
            void controller.select(id);
            rotation.notifyManualSelect(); // 手动切换同样重置轮播计时并清失败记忆
        },
        // 看护入口（面板与排查用）：读状态 / 重试当前壁纸 / 清空全部失败记忆。
        // health() 与面板读接口同一守卫：当前壁纸不是 scene（video/none/还没选）时返回 null。
        health: () => panelHealth(),
        retryLive,
        clearRenderFailures,
        show(plan, opts) {
            mount();
            if (!layer)
                return;
            const token = ++backgroundToken;
            mediaHealth.clear(); // 换任何背景都先撤掉上一条视频失败提示
            switch (plan.kind) {
                // 非 scene 分支没有壁纸 id ⇒ 解绑选中项：否则上一张 scene 的状态会持续挂在面板上，
                // 且「重试实时渲染」会把用户刚换掉的那张 scene 选回来。
                case 'image':
                    settings = { ...settings, selectedWallpaperId: '' };
                    layer.showImage(plan.url, plan.kenBurns);
                    break;
                case 'video':
                    settings = { ...settings, selectedWallpaperId: '' };
                    // show() 的 video plan 没有 preview 字段：失败只记录（fallback='none'）供面板提示，不假回退图片
                    // （controller 路径才有壁纸信息，由它回退 preview）。
                    void layer.showVideo(plan.url).then((result) => {
                        if (result === 'ok' || disposed || token !== backgroundToken)
                            return;
                        mediaHealth.set(videoWallpaperId(plan.url), result, 'none');
                    });
                    break;
                case 'web':
                    settings = { ...settings, selectedWallpaperId: '' };
                    layer.showWeb(plan.url);
                    break;
                case 'scene': {
                    // I6：委托 controller.select —— 统一 scene 渲染与 preview 回退语义
                    // （渲染失败回退 preview 图，与 controller 一致），并受竞态防护约束
                    // 先同步选中项：健康事件只推「当前选中壁纸」，不同步会把真实显示中的状态挡掉。
                    settings = { ...settings, selectedWallpaperId: plan.wallpaperId };
                    markRecent(plan.wallpaperId); // 公开 API 直接显示 scene 也计入「最近使用」
                    void controller.select(plan.wallpaperId).catch(() => { });
                    break;
                }
                case 'none':
                    settings = { ...settings, selectedWallpaperId: '' };
                    layer.showNone();
                    break;
            }
            if (opts?.opacity !== undefined)
                layer.setOverlayOpacity(opts.opacity);
            if (opts?.blur !== undefined)
                layer.setBlur(opts.blur, opts.blurRadius ?? 12);
            // 非 scene 分支已解绑选中项 ⇒ 补推一次（与 selectWallpaper 同款）：面板立刻刷新，
            // 不留上一张 scene 的旧文案（panelHealth 此时读到的已是 null）。
            if (plan.kind !== 'scene')
                notifyWallpaperHealth(panelHealth());
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
