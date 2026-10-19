import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// src/client/settings-section.tsx —— DSH 设置对话框 "壁纸" section。
// 通过 ctx.slots.register('settings.section', ...) 挂载（见 client/index.ts），
// 提供：壁纸网格切换 / 取消壁纸 / 壁纸目录与引擎目录配置（手动输入 + 自动探测）。
// 数据与动作经 props 注入（默认走真实 API），便于 jsdom 单测。
import { useCallback, useEffect, useState } from 'react';
import { readClientSettings, writeClientSettings } from './settings.js';
import { fetchWallpaperProperties, readBoolProperty, writeBoolProperty } from './wallpaper-properties.js';
import { TEXT_OUTLINE_MAX, normalizeHexColor, normalizeMode, normalizeOutlineLevel, outlineLabel } from './text-color.js';
import { formatHealthLine } from './render-health.js';
import { filterLibrary, loadLibraryState, toggleFavorite, toggleHidden } from './library-view.js';
import { ROTATION_INTERVAL_OPTIONS, buildRotationPool, formatRotationInterval, normalizeRotationOrder } from './rotation.js';
async function defaultFetchWallpapers() {
    return (await fetch('/wallpapers/list')).json();
}
async function defaultFetchProbe() {
    return (await fetch('/wallpapers/probe')).json();
}
// 模块级共享选择处理器：index.ts bootstrap 时注册（委托 controller.select），
// 使 slot 渲染的组件（无法直接传 props）也能切换/取消壁纸。props.onSelect 优先。
let sharedOnSelect = null;
export function setWallpaperSelectHandler(fn) {
    sharedOnSelect = fn;
}
// 运行期设置（省电/画质档位）的共享处理器：同样由 index.ts 注册（槽位组件无法直接传 props）。
let sharedOnRuntimeSettings = null;
export function setWallpaperRuntimeHandler(fn) {
    sharedOnRuntimeSettings = fn;
}
// 用户属性切换后的重装配处理器：属性值存在 localStorage，渲染器只在装配时读取，
// 故切换后需重新 select 当前壁纸（不弹提示、不写设置）。传 null = 撤销（teardown）。
let sharedOnReselect = null;
export function setWallpaperReselectHandler(handler) {
    sharedOnReselect = handler;
}
let healthHandler = null;
const healthSubscribers = new Set();
/** 注册/撤销共享 handler（传 null = 撤销：面板回退到「读不到状态」的初始态）。 */
export function setWallpaperHealthHandler(handler) {
    healthHandler = handler;
}
/** 订阅健康变化（组件挂载时订阅、卸载时退订；index.ts 调 notifyWallpaperHealth 推送）。 */
export function subscribeWallpaperHealth(cb) {
    healthSubscribers.add(cb);
    return () => { healthSubscribers.delete(cb); };
}
/** 由 index.ts 的健康事件调用；也用于组件挂载时补一次当前值。 */
export function notifyWallpaperHealth(snap) {
    for (const cb of Array.from(healthSubscribers)) {
        try {
            cb(snap);
        }
        catch { /* 单个订阅者异常不影响其它订阅者 */ }
    }
}
let mediaHandler = null;
const mediaSubscribers = new Set();
/** 注册/撤销共享 handler（传 null = 面板回到「无失败」初始态，并清掉已显示的提示）。 */
export function setWallpaperMediaHandler(handler) {
    mediaHandler = handler;
    pushMedia(handler?.get() ?? null);
}
/** 订阅媒体失败变化（组件挂载时订阅、卸载时退订）。 */
export function subscribeWallpaperMedia(cb) {
    mediaSubscribers.add(cb);
    return () => { mediaSubscribers.delete(cb); };
}
/** 由 index.ts 的媒体失败事件调用；handler 未注册时不推（面板已回初始态，迟到的失败不得复活提示）。 */
export function notifyWallpaperMedia(failure) {
    if (!mediaHandler)
        return;
    pushMedia(failure);
}
function pushMedia(failure) {
    for (const cb of Array.from(mediaSubscribers)) {
        try {
            cb(failure);
        }
        catch { /* 单个订阅者异常不影响其它订阅者 */ }
    }
}
// 本文件文案是中文硬编码（无 i18n 层）：formatHealthLine 要求传入翻译函数，这里透传。
const weT = (s) => s;
// 还没选壁纸 / 还没推送过：状态行按「尚未渲染」呈现，不给 formatHealthLine 造一个假壁纸 id。
const EMPTY_HEALTH = { wallpaperId: '', ok: null, failure: null, timing: null };
// 按 kind × fallback 分档：只有真的显示了预览图才能说「已回退到预览图」；timeout 与 unsupported 仍需可区分。
const MEDIA_FAILURE_TEXT = {
    unsupported: {
        preview: '该视频壁纸解码失败（可能是 HEVC/H.265），已回退到预览图；建议改用 Chrome 或转换编码。',
        none: '该视频壁纸解码失败（可能是 HEVC/H.265），且没有可用的预览图；建议改用 Chrome 或转换编码。',
    },
    timeout: {
        preview: '视频壁纸加载超时：1.5 秒内没有出现首帧，已回退到预览图；建议改用 Chrome 或检查视频文件。',
        none: '视频壁纸加载超时：1.5 秒内没有出现首帧，且没有可用的预览图；建议改用 Chrome 或检查视频文件。',
    },
};
export function WallpaperSettingsSection(props) {
    const fetchSettings = props.fetchSettings ?? readClientSettings;
    const writeSettings = props.writeSettings ?? writeClientSettings;
    const fetchWallpapers = props.fetchWallpapers ?? defaultFetchWallpapers;
    const fetchProbe = props.fetchProbe ?? defaultFetchProbe;
    const fetchProperties = props.fetchProperties ?? fetchWallpaperProperties;
    const onSelect = props.onSelect ?? sharedOnSelect ?? (() => { });
    const onReselect = props.onReselect ?? sharedOnReselect ?? (() => { });
    const onRuntimeSettings = props.onRuntimeSettings ?? sharedOnRuntimeSettings ?? (() => { });
    const [settings, setSettings] = useState(null);
    const [wallpapers, setWallpapers] = useState([]);
    const [probe, setProbe] = useState(null);
    const [wallpaperDir, setWallpaperDir] = useState('');
    const [weAssetsDir, setWeAssetsDir] = useState('');
    const [message, setMessage] = useState('');
    const [health, setHealth] = useState(props.health ?? null);
    // 媒体失败（视频解码）：handler 由 index.ts 注册，提示条在其卡片下方显示。
    const [mediaFailure, setMediaFailure] = useState(mediaHandler?.get() ?? null);
    // 壁纸库筛选状态：收藏/隐藏/最近使用来自 localStorage（挂载时读一次，操作后即时落盘）。
    const [libState, setLibState] = useState(loadLibraryState);
    // 壁纸用户属性（v0.8 仅布尔可见性）：只对当前选中的 scene 壁纸拉取一次。
    const [properties, setProperties] = useState([]);
    const [propValues, setPropValues] = useState({});
    const [filter, setFilter] = useState({
        query: '', types: [], favoritesOnly: false, showHidden: false, sort: 'default',
    });
    const visibleWallpapers = filterLibrary(wallpapers, filter, libState);
    const selectedId = settings?.selectedWallpaperId ?? '';
    const selectedIsScene = !!selectedId && wallpapers.some((w) => w.id === selectedId && w.type === 'scene');
    // 挂载时先取一次当前值（打开面板即显示状态），再订阅后续推送；卸载时退订。
    useEffect(() => {
        setHealth(props.health ?? healthHandler?.get() ?? null);
        return subscribeWallpaperHealth((s) => setHealth(s));
    }, [props.health]);
    useEffect(() => {
        setMediaFailure(mediaHandler?.get() ?? null);
        return subscribeWallpaperMedia((f) => setMediaFailure(f));
    }, []);
    useEffect(() => {
        let alive = true;
        void (async () => {
            const [s, list] = await Promise.all([
                fetchSettings(),
                fetchWallpapers().catch(() => []),
            ]);
            if (!alive)
                return;
            setSettings(s);
            setWallpapers(list);
            setWallpaperDir(s.wallpaperDir || '');
            setWeAssetsDir(s.weAssetsDir || '');
        })();
        return () => { alive = false; };
    }, [fetchSettings, fetchWallpapers]);
    // 切换壁纸时重新拉取属性；checkbox 初值 = localStorage 覆盖值，否则壁纸默认 value。
    useEffect(() => {
        if (!selectedIsScene) {
            setProperties([]);
            setPropValues({});
            return;
        }
        let alive = true;
        void fetchProperties(selectedId)
            .then((list) => {
            if (!alive)
                return;
            const items = Array.isArray(list) ? list : [];
            setProperties(items);
            // 初值按当前壁纸 id 读（per-wallpaper 覆盖值；缺键回退旧全局键）。
            setPropValues(Object.fromEntries(items.map((p) => [p.key, readBoolProperty(p.key, selectedId) ?? p.value])));
        })
            .catch(() => {
            if (!alive)
                return;
            setProperties([]);
            setPropValues({});
        });
        return () => { alive = false; };
    }, [selectedId, selectedIsScene, fetchProperties]);
    // 选择/取消壁纸：同步回调（controller 立即生效）+ 持久化
    const select = useCallback((id) => {
        onSelect(id);
        setSettings((prev) => (prev ? { ...prev, selectedWallpaperId: id } : prev));
        void writeSettings({ selectedWallpaperId: id }).then((ok) => setMessage(ok === false
            ? '保存失败：选择未持久化（详见控制台）'
            : (id ? '壁纸已切换' : '已取消壁纸')));
    }, [onSelect, writeSettings]);
    // 刷新壁纸列表：重新从壁纸目录拉取最新列表（壁纸目录变更后手动刷新用）
    const refreshWallpapers = useCallback(() => {
        setMessage('');
        void fetchWallpapers()
            .then((list) => {
            setWallpapers(list);
            setMessage('壁纸列表已刷新');
        })
            .catch(() => setMessage('刷新壁纸失败'));
    }, [fetchWallpapers]);
    // 省电 / 画质档位 / 光晕参数：本地即时生效（经共享 handler 下发渲染器）+ 持久化（不必重选壁纸）
    const applyRuntime = useCallback((patch) => {
        setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
        onRuntimeSettings(patch);
        void writeSettings(patch);
    }, [onRuntimeSettings, writeSettings]);
    // 保存手动输入的路径（空值 = 清除用户配置，回退默认）
    const saveDirs = useCallback(() => {
        void writeSettings({ wallpaperDir: wallpaperDir.trim(), weAssetsDir: weAssetsDir.trim() })
            .then((ok) => setMessage(ok === false ? '保存失败：设置未写入（详见控制台）' : '路径已保存'));
    }, [wallpaperDir, weAssetsDir, writeSettings]);
    const runProbe = useCallback(() => {
        setMessage('');
        void fetchProbe()
            .then(setProbe)
            .catch(() => setMessage('自动探测失败'));
    }, [fetchProbe]);
    const adopt = useCallback((path, key) => {
        void writeSettings({ [key]: path })
            .then((ok) => {
            if (ok === false) {
                setMessage('保存失败：设置未写入（详见控制台）');
                return;
            }
            if (key === 'wallpaperDir')
                setWallpaperDir(path);
            else
                setWeAssetsDir(path);
            setMessage('已采用探测路径');
        });
    }, [writeSettings]);
    const currentTitle = settings
        ? (wallpapers.find((w) => w.id === settings.selectedWallpaperId)?.title ?? '无（默认背景）')
        : '';
    // 实时渲染状态：ok（最近一次装配结果）与 failure（失败记忆）可并存 ⇒ 主行讲「现在怎么样」、
    // 次级行讲「曾经失败过什么」；只按其中一个渲染会自相矛盾（现在正常时只剩失败文案）。
    const live = health ?? EMPTY_HEALTH;
    const liveCurrent = live.ok === true
        ? formatHealthLine({ ...live, failure: null }, weT)
        : formatHealthLine(live, weT);
    const liveMemory = live.ok === true && live.failure
        ? formatHealthLine({ ...live, ok: null, timing: null }, weT)
        : '';
    const liveState = live.ok === true ? 'ok' : (live.failure ? 'failed' : 'idle');
    // 轮播状态行：可轮播池按当前列表 + 收藏/隐藏实时算（池 <2 张时明确提示原因，不静默）。
    const rotationPoolSize = buildRotationPool(wallpapers, libState).length;
    const rotationStatus = rotationPoolSize < 2
        ? '至少保留 2 张可轮播壁纸，或收藏 2 张以上'
        : `每 ${formatRotationInterval(settings?.rotationIntervalMs)} · ${normalizeRotationOrder(settings?.rotationOrder) === 'sequential' ? '顺序' : '随机'} · 可轮播 ${rotationPoolSize} 张`;
    // 两个入口：props 优先（可嵌入/可测），否则走 index.ts 注册的共享 handler；
    // 都没有时不谎报「已重试/已清除」（插件尚未挂载时是这种情况）。
    const retryLive = () => {
        if (props.onRetryLive)
            props.onRetryLive();
        else if (healthHandler)
            healthHandler.retry();
        else
            return;
        setMessage('已重试实时渲染');
    };
    const forgetFailures = () => {
        if (props.onClearRenderFailures)
            props.onClearRenderFailures();
        else if (healthHandler)
            healthHandler.clearFailures();
        else
            return;
        setMessage('已清除失败记忆');
    };
    const dismissMediaFailure = () => {
        mediaHandler?.clear();
        setMediaFailure(null); // 立即隐藏；真实 handler 也会经订阅推送 null
    };
    return (_jsxs("div", { className: "wss-root", children: [_jsx("section", { className: "wss-section", children: _jsxs("div", { className: "wss-current", children: [_jsxs("div", { className: "wss-current-info", children: [_jsx("span", { className: "wss-current-label", children: "\u5F53\u524D\u58C1\u7EB8" }), _jsx("span", { className: "wss-current-name", title: currentTitle, children: currentTitle })] }), _jsxs("div", { className: "wss-current-actions", children: [_jsx("button", { type: "button", className: "wss-refresh", onClick: refreshWallpapers, children: "\u5237\u65B0\u58C1\u7EB8" }), _jsx("button", { type: "button", className: "wss-cancel", onClick: () => select(''), children: "\u53D6\u6D88\u58C1\u7EB8" })] })] }) }), _jsxs("section", { className: "wss-section", children: [_jsxs("header", { className: "wss-section-head", children: [_jsx("h4", { className: "wss-section-title", children: "\u58C1\u7EB8\u5E93" }), _jsxs("span", { className: "wss-count", children: [wallpapers.length, " \u5F20"] })] }), _jsxs("div", { className: "wss-library-tools", children: [_jsx("input", { type: "search", className: "wss-search", placeholder: "\u641C\u7D22\u58C1\u7EB8\u6807\u9898", "aria-label": "\u641C\u7D22\u58C1\u7EB8\u6807\u9898", value: filter.query, onChange: (e) => setFilter((f) => ({ ...f, query: e.target.value })) }), _jsxs("select", { className: "wss-type-filter", "aria-label": "\u6309\u7C7B\u578B\u7B5B\u9009", value: filter.types[0] ?? 'all', onChange: (e) => setFilter((f) => ({
                                    ...f,
                                    types: e.target.value === 'all' ? [] : [e.target.value],
                                })), children: [_jsx("option", { value: "all", children: "\u5168\u90E8\u7C7B\u578B" }), _jsx("option", { value: "scene", children: "Scene" }), _jsx("option", { value: "video", children: "\u89C6\u9891" }), _jsx("option", { value: "web", children: "Web" }), _jsx("option", { value: "image", children: "\u56FE\u7247" })] }), _jsxs("label", { className: "wss-tool", children: [_jsx("input", { type: "checkbox", className: "wss-fav-only", checked: filter.favoritesOnly, onChange: (e) => setFilter((f) => ({ ...f, favoritesOnly: e.target.checked })) }), "\u4EC5\u6536\u85CF"] }), _jsxs("label", { className: "wss-tool", children: [_jsx("input", { type: "checkbox", className: "wss-show-hidden", checked: filter.showHidden, onChange: (e) => setFilter((f) => ({ ...f, showHidden: e.target.checked })) }), "\u663E\u793A\u5DF2\u9690\u85CF"] }), _jsxs("select", { className: "wss-sort", "aria-label": "\u6392\u5E8F\u65B9\u5F0F", value: filter.sort, onChange: (e) => {
                                    const sort = e.target.value;
                                    setFilter((f) => ({ ...f, sort }));
                                    // 面板开着时选中壁纸由 index.ts 写入最近使用；切到该排序时只重读 recent（保留会话内收藏/隐藏）。
                                    if (sort === 'recent')
                                        setLibState((prev) => ({ ...prev, recent: loadLibraryState().recent }));
                                }, children: [_jsx("option", { value: "default", children: "\u9ED8\u8BA4\u6392\u5E8F" }), _jsx("option", { value: "recent", children: "\u6700\u8FD1\u4F7F\u7528" }), _jsx("option", { value: "title", children: "\u6807\u9898\u6392\u5E8F" })] })] }), _jsx("div", { className: "wss-grid", children: visibleWallpapers.map((w) => {
                            const selected = settings?.selectedWallpaperId === w.id;
                            const favorite = libState.favorites.has(w.id);
                            const hidden = libState.hidden.has(w.id);
                            return (_jsxs("div", { className: "wss-thumb-wrap", children: [_jsxs("button", { type: "button", className: 'wss-thumb' + (selected ? ' wss-selected' : ''), "data-id": w.id, title: w.title, "aria-pressed": selected, onClick: () => select(w.id), children: [_jsxs("span", { className: "wss-thumb-media", children: [w.previewUrl
                                                        ? _jsx("img", { src: w.previewUrl, alt: w.title, loading: "lazy" })
                                                        : _jsx("span", { className: "wss-no-preview", children: "\u65E0\u9884\u89C8" }), _jsx("span", { className: "wss-badge", children: w.type.toUpperCase() }), selected && _jsx("span", { className: "wss-check", "aria-hidden": "true", children: "\u2713" })] }), _jsx("span", { className: "wss-thumb-title", children: w.title })] }), _jsxs("span", { className: "wss-thumb-actions", children: [_jsx("button", { type: "button", className: 'wss-fav' + (favorite ? ' wss-fav-on' : ''), "data-id": w.id, title: favorite ? '取消收藏' : '收藏', "aria-label": favorite ? '取消收藏' : '收藏', "aria-pressed": favorite, onClick: (e) => {
                                                    e.stopPropagation();
                                                    setLibState((prev) => toggleFavorite(w.id, prev));
                                                }, children: favorite ? '★' : '☆' }), _jsx("button", { type: "button", className: 'wss-hide' + (hidden ? ' wss-hide-on' : ''), "data-id": w.id, title: hidden ? '取消隐藏' : '隐藏这张壁纸', "aria-label": hidden ? '取消隐藏' : '隐藏这张壁纸', onClick: (e) => {
                                                    e.stopPropagation();
                                                    setLibState((prev) => toggleHidden(w.id, prev));
                                                }, children: hidden ? '↺' : '✕' })] })] }, w.id));
                        }) }), wallpapers.length === 0 && (_jsx("p", { className: "wss-empty", children: "\u8FD8\u6CA1\u6709\u58C1\u7EB8\u3002\u8BF7\u5728\u4E0B\u65B9\u8BBE\u7F6E\u58C1\u7EB8\u76EE\u5F55\uFF0C\u6216\u70B9\u300C\u81EA\u52A8\u63A2\u6D4B\u300D\u3002" })), wallpapers.length > 0 && visibleWallpapers.length === 0 && (_jsxs("p", { className: "wss-empty", children: ["\u6CA1\u6709\u5339\u914D\u7684\u58C1\u7EB8\uFF08\u9690\u85CF ", libState.hidden.size, " \u5F20\uFF09"] }))] }), selectedIsScene && properties.length > 0 && (_jsxs("section", { className: "wss-section wss-userprops", children: [_jsx("h4", { className: "wss-section-title", children: "\u58C1\u7EB8\u5C5E\u6027" }), _jsx("p", { className: "wss-section-desc", children: "\u5207\u6362\u540E\u751F\u6548\uFF08\u4F1A\u91CD\u65B0\u88C5\u914D\u5F53\u524D\u58C1\u7EB8\uFF09\u3002" }), properties.map((property) => (_jsxs("label", { className: "wss-row", children: [_jsx("input", { type: "checkbox", className: "wss-userprop", "data-key": property.key, checked: propValues[property.key] ?? property.value, onChange: (e) => {
                                    const checked = e.target.checked;
                                    setPropValues((prev) => ({ ...prev, [property.key]: checked }));
                                    writeBoolProperty(property.key, checked, selectedId);
                                    onReselect(selectedId);
                                } }), property.label] }, property.key)))] })), settings && (_jsxs("section", { className: "wss-section", children: [_jsx("h4", { className: "wss-section-title", children: "\u663E\u793A\u6548\u679C" }), _jsxs("div", { className: "wss-effects", children: [_jsxs("label", { className: "wss-slider", children: [_jsxs("span", { className: "wss-slider-head", children: [_jsx("span", { children: "\u906E\u7F69\u4E0D\u900F\u660E\u5EA6" }), _jsx("span", { className: "wss-effect-value", children: settings.overlayOpacity.toFixed(2) })] }), _jsx("input", { type: "range", className: "wss-overlay-opacity", min: 0, max: 1, step: 0.01, value: settings.overlayOpacity, onChange: (e) => applyRuntime({ overlayOpacity: Number(e.target.value) }) })] }), _jsxs("label", { className: "wss-row", children: [_jsx("input", { type: "checkbox", className: "wss-blur-enabled", checked: settings.blurEnabled, onChange: (e) => applyRuntime({ blurEnabled: e.target.checked }) }), "\u80CC\u666F\u6A21\u7CCA"] }), _jsxs("label", { className: "wss-slider", children: [_jsxs("span", { className: "wss-slider-head", children: [_jsx("span", { children: "\u6A21\u7CCA\u534A\u5F84" }), _jsxs("span", { className: "wss-effect-value", children: [settings.blurRadius, " px"] })] }), _jsx("input", { type: "range", className: "wss-blur-radius", min: 0, max: 64, step: 1, value: settings.blurRadius, onChange: (e) => applyRuntime({ blurRadius: Number(e.target.value) }) })] }), _jsxs("label", { className: "wss-row", children: [_jsx("input", { type: "checkbox", className: "wss-kenburns", checked: settings.kenBurns, onChange: (e) => applyRuntime({ kenBurns: e.target.checked }) }), "Ken Burns \u7F13\u6162\u7F29\u653E"] }), _jsxs("label", { className: "wss-row", children: [_jsx("span", { children: "\u753B\u9762\u9002\u914D" }), _jsxs("select", { className: "wss-fit-mode", value: settings.fitMode, onChange: (e) => applyRuntime({ fitMode: e.target.value }), children: [_jsx("option", { value: "cover", children: "\u88C1\u526A\u94FA\u6EE1" }), _jsx("option", { value: "contain", children: "\u5B8C\u6574\u663E\u793A\uFF08\u53EF\u80FD\u7559\u8FB9\uFF09" }), _jsx("option", { value: "stretch", children: "\u62C9\u4F38\u94FA\u6EE1" })] })] })] }), _jsxs("div", { className: "wss-glow", children: [_jsxs("label", { className: "wss-glow-row", children: [_jsx("input", { type: "checkbox", checked: settings.glowEnabled, onChange: (e) => applyRuntime({ glowEnabled: e.target.checked }) }), "\u5149\u6655\uFF08\u7ACB\u5373\u751F\u6548\uFF09"] }), _jsxs("label", { className: "wss-slider", children: [_jsxs("span", { className: "wss-slider-head", children: [_jsx("span", { children: "\u9608\u503C" }), _jsx("span", { className: "wss-value", children: settings.glowThreshold.toFixed(2) })] }), _jsx("input", { type: "range", className: "wss-glow-threshold", min: 0, max: 0.99, step: 0.01, value: settings.glowThreshold, onChange: (e) => applyRuntime({ glowThreshold: Number(e.target.value) }) })] }), _jsxs("label", { className: "wss-slider", children: [_jsxs("span", { className: "wss-slider-head", children: [_jsx("span", { children: "\u5F3A\u5EA6" }), _jsx("span", { className: "wss-value", children: settings.glowStrength.toFixed(2) })] }), _jsx("input", { type: "range", className: "wss-glow-strength", min: 0, max: 4, step: 0.05, value: settings.glowStrength, onChange: (e) => applyRuntime({ glowStrength: Number(e.target.value) }) })] })] })] })), settings && (_jsxs("section", { className: "wss-section", children: [_jsx("h4", { className: "wss-section-title", children: "\u8F6E\u64AD" }), _jsxs("div", { className: "wss-rotation", children: [_jsxs("label", { className: "wss-glow-row", children: [_jsx("input", { type: "checkbox", className: "wss-rotation-enabled", checked: settings.rotationEnabled, onChange: (e) => applyRuntime({ rotationEnabled: e.target.checked }) }), "\u81EA\u52A8\u8F6E\u64AD"] }), _jsxs("label", { className: "wss-row", children: [_jsx("span", { children: "\u5207\u6362\u95F4\u9694" }), _jsxs("select", { className: "wss-rotation-interval", value: String(settings.rotationIntervalMs), onChange: (e) => applyRuntime({ rotationIntervalMs: Number(e.target.value) }), children: [!ROTATION_INTERVAL_OPTIONS.some((o) => o.ms === settings.rotationIntervalMs) && (_jsx("option", { value: String(settings.rotationIntervalMs), children: formatRotationInterval(settings.rotationIntervalMs) })), ROTATION_INTERVAL_OPTIONS.map((o) => (_jsx("option", { value: String(o.ms), children: o.label }, o.ms)))] })] }), _jsxs("label", { className: "wss-row", children: [_jsx("span", { children: "\u5207\u6362\u987A\u5E8F" }), _jsxs("select", { className: "wss-rotation-order", value: normalizeRotationOrder(settings.rotationOrder), onChange: (e) => applyRuntime({ rotationOrder: e.target.value }), children: [_jsx("option", { value: "sequential", children: "\u987A\u5E8F" }), _jsx("option", { value: "random", children: "\u968F\u673A" })] })] }), _jsx("p", { className: "wss-section-desc wss-rotation-status", "data-state": rotationPoolSize < 2 ? 'empty' : 'ready', children: rotationStatus })] })] })), settings && (_jsxs("section", { className: "wss-section", children: [_jsx("h4", { className: "wss-section-title", children: "\u6027\u80FD\u4E0E\u7701\u7535" }), _jsxs("div", { className: "wss-power", children: [_jsxs("label", { className: "wss-glow-row", children: [_jsx("input", { type: "checkbox", checked: settings.paused, onChange: (e) => applyRuntime({ paused: e.target.checked }) }), "\u6682\u505C\u58C1\u7EB8\uFF08\u7701\u7535\uFF09"] }), _jsxs("label", { className: "wss-glow-row", children: [_jsx("input", { type: "checkbox", checked: settings.pauseOnHidden, onChange: (e) => applyRuntime({ pauseOnHidden: e.target.checked }) }), "\u5207\u5230\u540E\u53F0\u65F6\u81EA\u52A8\u6682\u505C"] }), _jsxs("label", { className: "wss-row", children: [_jsx("span", { children: "\u753B\u8D28\u6863\u4F4D" }), _jsxs("select", { className: "wss-quality", value: String(settings.qualityScale), onChange: (e) => applyRuntime({ qualityScale: Number(e.target.value) }), children: [_jsx("option", { value: "1", children: "\u539F\u751F\uFF081\u00D7\uFF09" }), _jsx("option", { value: "0.75", children: "\u7701\u663E\u5B58\uFF080.75\u00D7\uFF09" }), _jsx("option", { value: "0.5", children: "\u6700\u7701\uFF080.5\u00D7\uFF09" })] })] })] }), _jsx("div", { className: "wss-sound-row", children: _jsxs("label", { className: "wss-glow-row", children: [_jsx("input", { type: "checkbox", className: "wss-sound", checked: settings.soundEnabled, onChange: (e) => applyRuntime({ soundEnabled: e.target.checked }) }), "\u58C1\u7EB8\u97F3\u6548"] }) })] })), settings && (_jsxs("section", { className: "wss-section", children: [_jsx("h4", { className: "wss-section-title", children: "\u6587\u5B57\u53EF\u8BFB\u6027" }), _jsx("p", { className: "wss-section-desc", children: "\u8D34\u58C1\u7EB8\u7684\u6587\u5B57\uFF08\u6D88\u606F\u6B63\u6587\u3001\u6807\u9898\u3001\u94FE\u63A5\u3001\u804A\u5929\u680F\uFF09\u770B\u4E0D\u6E05\u65F6\uFF0C\u53EF\u56FA\u5B9A\u6587\u5B57\u989C\u8272\uFF1B\u80CC\u666F\u82B1\u54E8\u65F6\u5F00\u4E00\u70B9\u63CF\u8FB9\u6700\u6709\u6548\u3002" }), _jsxs("div", { className: "wss-textcolor", children: [_jsxs("label", { className: "wss-row", children: [_jsx("span", { children: "\u6587\u5B57\u989C\u8272" }), _jsxs("select", { className: "wss-textcolor-mode", value: normalizeMode(settings.textColorMode), onChange: (e) => applyRuntime({ textColorMode: e.target.value }), children: [_jsx("option", { value: "auto", children: "\u81EA\u52A8\uFF08\u8DDF\u968F\u58C1\u7EB8\u4EAE\u5EA6\uFF09" }), _jsx("option", { value: "white", children: "\u767D\u8272" }), _jsx("option", { value: "black", children: "\u9ED1\u8272" }), _jsx("option", { value: "custom", children: "\u81EA\u5B9A\u4E49\u2026" })] })] }), normalizeMode(settings.textColorMode) === 'custom' && (_jsxs("label", { className: "wss-row", children: [_jsx("span", { children: "\u81EA\u5B9A\u4E49\u989C\u8272" }), _jsx("input", { type: "color", className: "wss-textcolor-custom", value: normalizeHexColor(settings.textColor), onChange: (e) => applyRuntime({ textColor: e.target.value }) })] })), _jsxs("label", { className: "wss-slider", children: [_jsxs("span", { className: "wss-slider-head", children: [_jsx("span", { children: "\u6587\u5B57\u63CF\u8FB9" }), _jsx("span", { className: "wss-value", children: outlineLabel(settings.textOutline) })] }), _jsx("input", { type: "range", className: "wss-textcolor-outline", min: 0, max: TEXT_OUTLINE_MAX, step: 1, value: normalizeOutlineLevel(settings.textOutline), onChange: (e) => applyRuntime({ textOutline: Number(e.target.value) }) })] })] })] })), _jsxs("section", { className: "wss-section", children: [_jsx("h4", { className: "wss-section-title", children: "\u58C1\u7EB8\u76EE\u5F55" }), _jsx("p", { className: "wss-section-desc", children: "\u586B Wallpaper Engine \u7684\u4E24\u4E2A\u76EE\u5F55\uFF1B\u7559\u7A7A = \u672A\u914D\u7F6E\u3002\u4E5F\u53EF\u4EE5\u76F4\u63A5\u70B9\u300C\u81EA\u52A8\u63A2\u6D4B\u300D\u91C7\u7528\u63A2\u6D4B\u7ED3\u679C\u3002" }), _jsxs("label", { className: "wss-field", children: [_jsx("span", { className: "wss-field-label", children: "\u58C1\u7EB8\u76EE\u5F55\uFF08workshop\uFF09" }), _jsx("input", { className: "wss-dir-workshop", value: wallpaperDir, placeholder: "\u4F8B\u5982 D:/Steam/steamapps/workshop/content/431960", onChange: (e) => setWallpaperDir(e.target.value) })] }), _jsxs("label", { className: "wss-field", children: [_jsx("span", { className: "wss-field-label", children: "\u5F15\u64CE\u76EE\u5F55\uFF08particle \u7EB9\u7406\uFF09" }), _jsx("input", { className: "wss-dir-assets", value: weAssetsDir, placeholder: "\u4F8B\u5982 D:/Steam/steamapps/common/wallpaper_engine", onChange: (e) => setWeAssetsDir(e.target.value) })] }), _jsxs("div", { className: "wss-dir-actions", children: [_jsx("button", { type: "button", className: "wss-save-dirs", onClick: saveDirs, children: "\u4FDD\u5B58\u8DEF\u5F84" }), _jsx("button", { type: "button", className: "wss-probe", onClick: runProbe, children: "\u81EA\u52A8\u63A2\u6D4B" })] }), probe && (_jsxs("div", { className: "wss-probe-result", children: [_jsx("h5", { className: "wss-subtitle", children: "\u63A2\u6D4B\u5230\u7684\u58C1\u7EB8\u76EE\u5F55" }), probe.workshop.map((c) => (_jsxs("div", { className: "wss-candidate", "data-kind": "workshop", children: [_jsx("span", { className: "wss-candidate-path", title: c.path, children: c.path }), _jsx("span", { className: c.exists ? 'wss-exists' : 'wss-missing', children: c.exists ? '存在' : '不存在' }), _jsx("button", { type: "button", className: "wss-adopt", "data-path": c.path, onClick: () => adopt(c.path, 'wallpaperDir'), children: "\u91C7\u7528" })] }, c.path))), _jsx("h5", { className: "wss-subtitle", children: "\u63A2\u6D4B\u5230\u7684\u5F15\u64CE\u76EE\u5F55" }), probe.assets.map((c) => (_jsxs("div", { className: "wss-candidate", "data-kind": "assets", children: [_jsx("span", { className: "wss-candidate-path", title: c.path, children: c.path }), _jsx("span", { className: c.exists ? 'wss-exists' : 'wss-missing', children: c.exists ? '存在' : '不存在' }), _jsx("button", { type: "button", className: "wss-adopt", "data-path": c.path, onClick: () => adopt(c.path, 'weAssetsDir'), children: "\u91C7\u7528" })] }, c.path)))] }))] }), _jsxs("section", { className: "wss-section", children: [_jsx("h4", { className: "wss-section-title", children: "\u5B9E\u65F6\u6E32\u67D3" }), _jsxs("div", { className: "wss-live-status", "data-state": liveState, children: [_jsx("p", { className: "wss-section-desc wss-live-current", children: liveCurrent }), liveMemory && _jsx("p", { className: "wss-section-desc wss-live-memory", children: liveMemory })] }), _jsxs("div", { className: "wss-row", children: [_jsx("button", { type: "button", className: "wss-live-retry", onClick: retryLive, children: "\u91CD\u8BD5\u5B9E\u65F6\u6E32\u67D3" }), _jsx("button", { type: "button", className: "wss-live-forget", onClick: forgetFailures, children: "\u6E05\u9664\u5931\u8D25\u8BB0\u5FC6" })] })] }), mediaFailure && (_jsxs("section", { className: "wss-section wss-media-failure", "data-kind": mediaFailure.kind, children: [_jsx("p", { className: "wss-section-desc", children: MEDIA_FAILURE_TEXT[mediaFailure.kind][mediaFailure.fallback] }), _jsx("div", { className: "wss-row", children: _jsx("button", { type: "button", className: "wss-media-dismiss", onClick: dismissMediaFailure, children: "\u77E5\u9053\u4E86" }) })] })), message && _jsx("p", { className: "wss-message", role: "status", children: message })] }));
}
