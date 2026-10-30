import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// DSH 设置面板「开机动画」页（Wallpaper 壁纸 tab 的内容）：设计系统统一样式，行为不变。
// 素材选择区重点解决「看不清当前选了哪个」：当前素材大卡片 + 可视化壁纸网格 + 系统文件选择器。
import { useEffect, useState } from 'react';
import { readClientSettings, writeClientSettings } from './settings.js';
async function defaultFetchWallpapers() {
    return (await fetch('/wallpapers/list')).json();
}
async function defaultProbePath(path) {
    const r = await fetch('/wallpapers/boot/probe?path=' + encodeURIComponent(path));
    return r.json();
}
function bootApi() {
    return globalThis.__wallpaperEngineBoot;
}
async function defaultPlayPreview() {
    return (await bootApi()?.play?.({ force: true })) ?? 'disabled';
}
// 桌面端：隐藏 <input type=file> 选文件，再用 __DSH_HOST_PATHS__.pathFor 换成绝对路径。
// 浏览器（dsh web）没有该 API，由组件回退到手填路径。
async function defaultPickLocalFile() {
    if (typeof document === 'undefined' || typeof window === 'undefined')
        return null;
    const hostPaths = window.__DSH_HOST_PATHS__;
    if (!hostPaths || typeof hostPaths.pathFor !== 'function')
        return null;
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'video/*,.mp4,.webm,.mov,.m4v,.ogv';
        input.style.display = 'none';
        document.body.appendChild(input);
        let settled = false;
        const done = (path) => {
            if (settled)
                return;
            settled = true;
            input.remove();
            resolve(path);
        };
        input.addEventListener('change', () => {
            const file = input.files?.[0] ?? null;
            let path = null;
            try {
                path = file ? hostPaths.pathFor(file) : null;
            }
            catch {
                path = null;
            }
            done(path && path.trim() ? path : null);
        }, { once: true });
        input.addEventListener('cancel', () => done(null), { once: true });
        input.click();
    });
}
const FITS = [
    { value: 'tile', label: '平铺' },
    { value: 'contain', label: '居中' },
    { value: 'stretch', label: '挤压' },
    { value: 'cover', label: '裁切填满' },
];
const RESULT_TEXT = {
    ended: '播放完成', skipped: '已跳过', timeout: '素材超时（已跳过）', failed: '播放失败（已跳过）',
    'already-played': '本次会话已播过', disabled: '未启用', 'no-asset': '未选择素材',
};
// 播放结果 → 语义色：正常结束/跳过为 ok，超时/失败为 danger，其余中性。
function toneOf(result) {
    if (result === 'ended' || result === 'skipped')
        return 'ok';
    if (result === 'timeout' || result === 'failed')
        return 'danger';
    if (result === 'already-played')
        return 'warn';
    return 'neutral';
}
function formatSize(n) {
    if (typeof n !== 'number')
        return '-';
    return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
}
// probe 的 error 是英文协议串（not found / bad path），面板只给中文结论。
function probeText(probe) {
    if (probe.ok)
        return `文件存在 · ${formatSize(probe.size)} · ${probe.playable ? '可播放' : '扩展名不支持'}`;
    return probe.error === 'not found' ? '文件不存在或不是普通文件' : '路径无效或扩展名不支持';
}
function fileNameOf(path) {
    return path.split(/[\\/]/).pop() || path;
}
export function BootSettingsSection(props) {
    const fetchSettings = props.fetchSettings ?? readClientSettings;
    const save = props.writeSettings ?? writeClientSettings;
    const fetchWallpapers = props.fetchWallpapers ?? defaultFetchWallpapers;
    const probePath = props.probePath ?? defaultProbePath;
    const playPreview = props.playPreview ?? defaultPlayPreview;
    const getLast = props.getLast ?? (() => bootApi()?.getLast?.() ?? null);
    const [settings, setSettings] = useState(null);
    const [wallpapers, setWallpapers] = useState([]);
    const [probe, setProbe] = useState(null);
    const [message, setMessage] = useState('');
    const [messageTone, setMessageTone] = useState('neutral');
    const [last, setLast] = useState(null);
    const [previewing, setPreviewing] = useState(false);
    // 壁纸选择网格（默认收起，点「更换/选择壁纸」展开）
    const [pickerOpen, setPickerOpen] = useState(false);
    const [query, setQuery] = useState('');
    // 只挂载时读一次：读设置失败不抛（面板给提示），壁纸列表失败按空列表处理。
    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const [s, list] = await Promise.all([fetchSettings(), fetchWallpapers().catch(() => [])]);
                if (!alive)
                    return;
                setSettings(s);
                setWallpapers(list.filter((w) => w.type === 'video' || w.type === 'image'));
                setLast(getLast());
            }
            catch {
                if (alive)
                    setMessage('读取设置失败，请重新打开设置面板');
            }
        })();
        return () => { alive = false; };
    }, []);
    if (!settings)
        return _jsx("div", { className: "wbs-root wbs-loading", children: "\u52A0\u8F7D\u4E2D\u2026" });
    const source = settings.bootAnimationSource === 'local' ? 'local' : 'we';
    // 本地素材恒为视频；WE 素材按选择时的 kind 判断（视频不支持平铺）。
    const isVideoAsset = source === 'local' || settings.bootAnimationWallpaperKind === 'video';
    const picked = wallpapers.find((w) => w.id === settings.bootAnimationWallpaperId) ?? null;
    const localFile = settings.bootAnimationLocalPath;
    // 桌面端（桌面壳注入 hostPaths）用系统选择器；否则回退手填（web / 旧版桌面）。
    const nativePick = props.pickLocalFile === null
        ? false
        : props.pickLocalFile !== undefined
            ? true
            : typeof window !== 'undefined' && typeof window.__DSH_HOST_PATHS__?.pathFor === 'function';
    const pick = nativePick ? (props.pickLocalFile ?? defaultPickLocalFile) : null;
    const filtered = wallpapers.filter((w) => {
        const q = query.trim().toLowerCase();
        return q === '' || w.title.toLowerCase().includes(q);
    });
    // 字段改动先更新本地 UI，再持久化；写失败明确提示（不谎报已保存）。
    const patch = async (p) => {
        setSettings((prev) => (prev ? { ...prev, ...p } : prev));
        try {
            const ok = await save(p);
            if (ok === false)
                setMessage('保存失败：设置服务不可用');
        }
        catch {
            setMessage('保存失败：设置服务不可用');
        }
    };
    const runProbe = async (pathOverride) => {
        try {
            setProbe(await probePath(pathOverride ?? localFile));
        }
        catch {
            setProbe({ ok: false, error: 'bad path' });
        }
    };
    const chooseLocalFile = async () => {
        if (pick === null)
            return;
        let path = null;
        try {
            path = await pick();
        }
        catch {
            path = null;
        }
        const trimmed = (path ?? '').trim();
        if (!trimmed)
            return;
        await patch({ bootAnimationLocalPath: trimmed });
        await runProbe(trimmed); // 选完立即校验，用户不用再点一次
    };
    const chooseWallpaper = (w) => {
        void patch({
            bootAnimationWallpaperId: w.id,
            bootAnimationWallpaperKind: w.type === 'image' ? 'image' : 'video',
        });
        setPickerOpen(false);
    };
    const runPreview = async () => {
        setPreviewing(true);
        setMessage('播放中…');
        setMessageTone('neutral');
        let result = 'failed';
        try {
            result = await playPreview();
        }
        catch {
            result = 'failed';
        }
        setPreviewing(false);
        // 中文结论 + 原始结果码（用户反馈问题时便于定位具体失败分支）。
        setMessage('结果：' + (RESULT_TEXT[result] ?? '失败') + '（' + result + '）');
        setMessageTone(toneOf(result));
    };
    return (_jsxs("div", { className: "wbs-root", children: [_jsxs("section", { className: "wbs-hero", children: [_jsxs("div", { className: "wbs-hero-body", children: [_jsx("h4", { className: "wbs-hero-title", children: "\u5F00\u673A\u52A8\u753B" }), _jsx("p", { className: "wbs-hero-desc", children: "\u6253\u5F00 DSH \u65F6\u5168\u5C4F\u64AD\u4E00\u6BB5\u7247\u5934\uFF0C\u64AD\u5B8C\u6DE1\u51FA\u8FDB\u5165\u754C\u9762\uFF1B\u56FA\u5B9A\u9759\u97F3\uFF0C\u6BCF\u6B21\u542F\u52A8/\u65B0\u7A97\u53E3\u53EA\u64AD\u4E00\u6B21\uFF08\u5237\u65B0\u4E0D\u91CD\u64AD\uFF09\u3002" }), last && (_jsxs("p", { className: "wbs-last", "data-tone": toneOf(last.result), children: ["\u4E0A\u6B21\u64AD\u653E\uFF1A", RESULT_TEXT[last.result] ?? last.result] }))] }), _jsxs("label", { className: "wbs-switch", children: [_jsx("input", { type: "checkbox", className: "wbs-enable", checked: settings.bootAnimationEnabled, onChange: (e) => void patch({ bootAnimationEnabled: e.target.checked }) }), _jsx("span", { className: "wbs-switch-track", "aria-hidden": "true" }), _jsx("span", { className: "wbs-switch-label", children: "\u542F\u7528" })] })] }), _jsxs("section", { className: "wbs-card", children: [_jsxs("header", { className: "wbs-card-head", children: [_jsx("h4", { className: "wbs-title", children: "\u7D20\u6750" }), _jsx("span", { className: "wbs-hint", children: "\u89C6\u9891 / \u56FE\u7247" })] }), _jsxs("div", { className: "wbs-source-group", role: "radiogroup", "aria-label": "\u7D20\u6750\u6765\u6E90", children: [_jsxs("label", { className: "wbs-source", "data-active": source === 'we', children: [_jsx("input", { type: "radio", name: "wbs-source", className: "wbs-source-we", checked: source === 'we', onChange: () => void patch({ bootAnimationSource: 'we' }) }), _jsx("span", { className: "wbs-source-label", children: "Wallpaper Engine \u5E93" }), _jsx("span", { className: "wbs-source-hint", children: "\u4EC5\u89C6\u9891 / \u56FE\u7247\u7C7B" })] }), _jsxs("label", { className: "wbs-source", "data-active": source === 'local', children: [_jsx("input", { type: "radio", name: "wbs-source", className: "wbs-source-local", checked: source === 'local', onChange: () => void patch({ bootAnimationSource: 'local' }) }), _jsx("span", { className: "wbs-source-label", children: "\u672C\u5730\u89C6\u9891\u6587\u4EF6" }), _jsx("span", { className: "wbs-source-hint", children: nativePick ? '系统选择器' : '手填绝对路径' })] })] }), source === 'we' ? (_jsxs("div", { className: "wbs-we", children: [_jsxs("div", { className: "wbs-current", "data-empty": !picked, "data-kind": picked ? (picked.type === 'image' ? 'image' : 'video') : 'none', children: [_jsx("div", { className: "wbs-current-thumb", children: picked?.previewUrl ? _jsx("img", { src: picked.previewUrl, alt: "" }) : _jsx("span", { children: "\u65E0\u9884\u89C8" }) }), _jsxs("div", { className: "wbs-current-info", children: [_jsx("span", { className: "wbs-current-label", children: "\u5F53\u524D\u7D20\u6750" }), _jsx("span", { className: "wbs-current-title", children: picked?.title ?? (settings.bootAnimationWallpaperId ? '已选壁纸（不在当前列表）' : '未选择素材') }), _jsx("span", { className: "wbs-current-meta", children: picked
                                                    ? (picked.type === 'image' ? '图片壁纸' : '视频壁纸') + (picked.hasPreviewGif ? ' · 动图预览' : '')
                                                    : '从 WE 库选一张视频 / 图片壁纸' })] }), _jsx("button", { type: "button", className: "wbs-choose", onClick: () => setPickerOpen((v) => !v), children: pickerOpen ? '收起' : picked ? '更换' : '选择壁纸' })] }), pickerOpen && (_jsxs("div", { className: "wbs-picker", children: [_jsx("input", { type: "search", className: "wbs-wallpaper-search", "aria-label": "\u641C\u7D22\u58C1\u7EB8", placeholder: "\u641C\u7D22\u58C1\u7EB8\u6807\u9898\u2026", value: query, onChange: (e) => setQuery(e.target.value) }), _jsxs("div", { className: "wbs-wallpaper-grid", role: "listbox", "aria-label": "\u53EF\u9009\u58C1\u7EB8\uFF08\u89C6\u9891 / \u56FE\u7247\uFF09", children: [filtered.map((w) => (_jsxs("button", { type: "button", role: "option", "aria-selected": w.id === settings.bootAnimationWallpaperId, className: "wbs-wallpaper-card", "data-id": w.id, "data-selected": w.id === settings.bootAnimationWallpaperId, onClick: () => chooseWallpaper(w), children: [_jsxs("span", { className: "wbs-wallpaper-thumb", children: [w.previewUrl ? _jsx("img", { src: w.previewUrl, alt: "", loading: "lazy" }) : null, _jsx("span", { className: "wbs-wallpaper-kind", children: w.type === 'image' ? '图片' : '视频' })] }), _jsx("span", { className: "wbs-wallpaper-title", title: w.title, children: w.title })] }, w.id))), filtered.length === 0 && _jsx("p", { className: "wbs-desc wbs-wallpaper-empty", children: "\u6CA1\u6709\u5339\u914D\u7684\u58C1\u7EB8\u3002" })] }), wallpapers.length === 0 && _jsx("p", { className: "wbs-desc", children: "\u58C1\u7EB8\u5217\u8868\u4E3A\u7A7A\uFF1A\u8BF7\u5148\u5728\u300C\u65E5\u5E38\u58C1\u7EB8\u300D\u9875\u914D\u7F6E\u76EE\u5F55\u6216\u70B9\u5237\u65B0\u3002" })] }))] })) : (_jsxs("div", { className: "wbs-local", "data-active": "true", children: [_jsxs("div", { className: "wbs-current", "data-empty": !localFile, children: [_jsx("div", { className: "wbs-current-thumb wbs-current-thumb-file", "aria-hidden": "true", children: "\u25B6" }), _jsxs("div", { className: "wbs-current-info", children: [_jsx("span", { className: "wbs-current-label", children: "\u5F53\u524D\u7D20\u6750" }), _jsx("span", { className: "wbs-current-title", children: localFile ? fileNameOf(localFile) : '未选择视频文件' }), _jsx("span", { className: "wbs-current-meta", title: localFile || undefined, children: localFile || '支持 mp4 / webm / mov / m4v / ogv' })] }), nativePick && (_jsx("button", { type: "button", className: "wbs-choose wbs-pick-file", onClick: () => void chooseLocalFile(), children: "\u9009\u62E9\u6587\u4EF6\u2026" }))] }), !nativePick && (_jsxs("div", { className: "wbs-row wbs-local-row", children: [_jsx("input", { type: "text", className: "wbs-local-path", "aria-label": "\u672C\u5730\u89C6\u9891\u8DEF\u5F84", placeholder: "E:\\\\clips\\\\boot.mp4", value: localFile, onChange: (e) => setSettings((prev) => (prev ? { ...prev, bootAnimationLocalPath: e.target.value } : prev)), onBlur: (e) => void patch({ bootAnimationLocalPath: e.target.value }) }), _jsx("button", { type: "button", className: "wbs-probe", onClick: () => void runProbe(), children: "\u6821\u9A8C" })] })), nativePick && localFile && (_jsx("button", { type: "button", className: "wbs-probe wbs-probe-inline", onClick: () => void runProbe(), children: "\u91CD\u65B0\u6821\u9A8C" })), probe && _jsx("p", { className: "wbs-probe-result", "data-tone": probe.ok ? 'ok' : 'danger', children: probeText(probe) })] }))] }), _jsxs("section", { className: "wbs-card", children: [_jsxs("header", { className: "wbs-card-head", children: [_jsx("h4", { className: "wbs-title", children: "\u5C55\u793A\u65B9\u5F0F" }), _jsx("span", { className: "wbs-hint", children: "\u753B\u9762\u5982\u4F55\u9002\u914D\u5168\u5C4F" })] }), _jsx("div", { className: "wbs-fit-grid", role: "radiogroup", "aria-label": "\u5C55\u793A\u65B9\u5F0F", children: FITS.map((f) => {
                            const disabled = f.value === 'tile' && isVideoAsset;
                            return (_jsxs("label", { className: "wbs-fit-card", "data-fit": f.value, "data-disabled": disabled, "data-active": settings.bootAnimationFitMode === f.value, children: [_jsx("input", { type: "radio", name: "wbs-fit", className: 'wbs-fit-' + f.value, checked: settings.bootAnimationFitMode === f.value, disabled: disabled, onChange: () => void patch({ bootAnimationFitMode: f.value }) }), _jsx("span", { className: "wbs-fit-art", "data-fit": f.value, "aria-hidden": "true" }), _jsx("span", { className: "wbs-fit-label", children: f.label }), disabled && _jsx("span", { className: "wbs-fit-hint", children: "\u89C6\u9891\u4E0D\u652F\u6301" })] }, f.value));
                        }) })] }), _jsxs("section", { className: "wbs-card", children: [_jsxs("header", { className: "wbs-card-head", children: [_jsx("h4", { className: "wbs-title", children: "\u6700\u957F\u64AD\u653E" }), _jsx("span", { className: "wbs-value", children: settings.bootAnimationMaxDurationMs === 0 ? '播完 / 不限' : Math.round(settings.bootAnimationMaxDurationMs / 1000) + ' 秒' })] }), _jsxs("label", { className: "wbs-slider", children: [_jsx("input", { type: "range", className: "wbs-max-duration", "aria-label": "\u6700\u957F\u64AD\u653E\u65F6\u95F4\uFF08\u79D2\uFF09", min: 0, max: 30, step: 1, value: Math.round(settings.bootAnimationMaxDurationMs / 1000), onChange: (e) => void patch({ bootAnimationMaxDurationMs: Number(e.target.value) * 1000 }) }), _jsx("p", { className: "wbs-desc", children: "0 = \u89C6\u9891\u64AD\u5B8C\u4E3A\u6B62\uFF1B\u56FE\u7247\u56FA\u5B9A\u7EA6 4 \u79D2\u3002\u7D20\u6750 8 \u79D2\u672A\u5C31\u7EEA\u4F1A\u81EA\u52A8\u8DF3\u8FC7\u3002" })] })] }), _jsxs("div", { className: "wbs-actions", children: [_jsx("button", { type: "button", className: "wbs-preview", disabled: previewing, onClick: () => void runPreview(), children: previewing ? '播放中…' : '试播' }), message && _jsx("p", { className: "wbs-message", "data-tone": messageTone, children: message })] })] }));
}
