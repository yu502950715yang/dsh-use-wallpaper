import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// DSH 设置对话框「开机动画」独立 section（wbs-* 类）：与「Wallpaper 壁纸」页互不影响。
// 数据与动作经 props 注入（默认走真实 API / window.__wallpaperEngineBoot），便于 jsdom 单测。
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
    const [last, setLast] = useState(null);
    const [previewing, setPreviewing] = useState(false);
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
    const source = settings.bootAnimationSource === 'local' ? 'local' : 'we';
    // 本地素材恒为视频；WE 素材按选择时的 kind 判断（视频不支持平铺）。
    const isVideoAsset = source === 'local' || settings.bootAnimationWallpaperKind === 'video';
    const runProbe = async () => {
        try {
            setProbe(await probePath(settings.bootAnimationLocalPath));
        }
        catch {
            setProbe({ ok: false, error: 'bad path' });
        }
    };
    const runPreview = async () => {
        setPreviewing(true);
        setMessage('播放中…');
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
    };
    return (_jsxs("div", { className: "wbs-root", children: [_jsxs("section", { className: "wbs-section", children: [_jsx("h4", { className: "wbs-title", children: "\u5F00\u673A\u52A8\u753B \u00B7 \u4E0E\u65E5\u5E38\u58C1\u7EB8\u4E92\u4E0D\u5F71\u54CD" }), _jsx("p", { className: "wbs-desc", children: "\u6253\u5F00 DSH \u65F6\u5168\u5C4F\u64AD\u4E00\u6BB5\u7247\u5934\uFF0C\u64AD\u5B8C\u6DE1\u51FA\u8FDB\u5165\u754C\u9762\uFF1B\u56FA\u5B9A\u9759\u97F3\uFF0C\u6BCF\u6B21\u542F\u52A8/\u65B0\u7A97\u53E3\u53EA\u64AD\u4E00\u6B21\uFF08\u5237\u65B0\u4E0D\u91CD\u64AD\uFF09\u3002" }), _jsxs("label", { className: "wbs-row", children: [_jsx("input", { type: "checkbox", className: "wbs-enable", checked: settings.bootAnimationEnabled, onChange: (e) => void patch({ bootAnimationEnabled: e.target.checked }) }), _jsx("span", { children: "\u542F\u7528\u5F00\u673A\u52A8\u753B" })] }), last && _jsxs("p", { className: "wbs-last", children: ["\u4E0A\u6B21\u64AD\u653E\uFF1A", RESULT_TEXT[last.result] ?? last.result] })] }), _jsxs("section", { className: "wbs-section", children: [_jsx("h4", { className: "wbs-title", children: "\u7D20\u6750" }), _jsxs("label", { className: "wbs-row", children: [_jsx("input", { type: "radio", name: "wbs-source", className: "wbs-source-we", checked: source === 'we', onChange: () => void patch({ bootAnimationSource: 'we' }) }), _jsx("span", { children: "\u4ECE Wallpaper Engine \u5E93\u9009\u62E9\uFF08\u4EC5\u89C6\u9891 / \u56FE\u7247\u7C7B\uFF09" })] }), _jsxs("select", { className: "wbs-wallpaper", "aria-label": "\u5F00\u673A\u52A8\u753B\u7D20\u6750", value: settings.bootAnimationWallpaperId, onChange: (e) => {
                            const id = e.target.value;
                            const picked = wallpapers.find((w) => w.id === id);
                            void patch({
                                bootAnimationWallpaperId: id,
                                bootAnimationWallpaperKind: picked ? (picked.type === 'image' ? 'image' : 'video') : '',
                            });
                        }, children: [_jsx("option", { value: "", children: "\uFF08\u672A\u9009\u62E9\uFF09" }), wallpapers.map((w) => _jsxs("option", { value: w.id, children: [w.title, " \u00B7 ", w.type === 'image' ? '图片' : '视频'] }, w.id))] }), wallpapers.length === 0 && _jsx("p", { className: "wbs-desc", children: "\u58C1\u7EB8\u5217\u8868\u4E3A\u7A7A\uFF1A\u8BF7\u5148\u5728\u300CWallpaper \u58C1\u7EB8\u300D\u9875\u914D\u7F6E\u76EE\u5F55\u6216\u70B9\u5237\u65B0\u3002" }), _jsxs("label", { className: "wbs-row", children: [_jsx("input", { type: "radio", name: "wbs-source", className: "wbs-source-local", checked: source === 'local', onChange: () => void patch({ bootAnimationSource: 'local' }) }), _jsx("span", { children: "\u672C\u5730\u89C6\u9891\u6587\u4EF6\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF09" })] }), _jsxs("div", { className: "wbs-row", children: [_jsx("input", { type: "text", className: "wbs-local-path", "aria-label": "\u672C\u5730\u89C6\u9891\u8DEF\u5F84", placeholder: "E:\\\\clips\\\\boot.mp4", value: settings.bootAnimationLocalPath, onChange: (e) => setSettings((prev) => (prev ? { ...prev, bootAnimationLocalPath: e.target.value } : prev)), onBlur: (e) => void patch({ bootAnimationLocalPath: e.target.value }) }), _jsx("button", { type: "button", className: "wbs-probe", onClick: () => void runProbe(), children: "\u6821\u9A8C" })] }), probe && _jsx("p", { className: "wbs-probe-result", children: probeText(probe) })] }), _jsxs("section", { className: "wbs-section", children: [_jsx("h4", { className: "wbs-title", children: "\u5C55\u793A\u65B9\u5F0F" }), FITS.map((f) => (_jsxs("label", { className: "wbs-row", children: [_jsx("input", { type: "radio", name: "wbs-fit", className: 'wbs-fit-' + f.value, checked: settings.bootAnimationFitMode === f.value, disabled: f.value === 'tile' && isVideoAsset, onChange: () => void patch({ bootAnimationFitMode: f.value }) }), _jsxs("span", { children: [f.label, f.value === 'tile' && isVideoAsset ? '（视频不支持平铺）' : ''] })] }, f.value)))] }), _jsxs("section", { className: "wbs-section", children: [_jsx("h4", { className: "wbs-title", children: "\u6700\u957F\u64AD\u653E" }), _jsxs("label", { className: "wbs-row", children: [_jsx("input", { type: "range", className: "wbs-max-duration", "aria-label": "\u6700\u957F\u64AD\u653E\u65F6\u95F4\uFF08\u79D2\uFF09", min: 0, max: 30, step: 1, value: Math.round(settings.bootAnimationMaxDurationMs / 1000), onChange: (e) => void patch({ bootAnimationMaxDurationMs: Number(e.target.value) * 1000 }) }), _jsx("span", { className: "wbs-duration-value", children: settings.bootAnimationMaxDurationMs === 0 ? '播完 / 不限' : Math.round(settings.bootAnimationMaxDurationMs / 1000) + ' 秒' })] }), _jsx("p", { className: "wbs-desc", children: "0 = \u89C6\u9891\u64AD\u5B8C\u4E3A\u6B62\uFF1B\u56FE\u7247\u56FA\u5B9A\u7EA6 4 \u79D2\u3002\u7D20\u6750 8 \u79D2\u672A\u5C31\u7EEA\u4F1A\u81EA\u52A8\u8DF3\u8FC7\u3002" })] }), _jsx("div", { className: "wbs-row", children: _jsx("button", { type: "button", className: "wbs-preview", disabled: previewing, onClick: () => void runPreview(), children: previewing ? '播放中…' : '试播' }) }), message && _jsx("p", { className: "wbs-message", children: message })] }));
}
