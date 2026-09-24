import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// src/client/settings-section.tsx —— DSH 设置对话框 "壁纸" section。
// 通过 ctx.slots.register('settings.section', ...) 挂载（见 client/index.ts），
// 提供：壁纸网格切换 / 取消壁纸 / 壁纸目录与引擎目录配置（手动输入 + 自动探测）。
// 数据与动作经 props 注入（默认走真实 API），便于 jsdom 单测。
import { useCallback, useEffect, useState } from 'react';
import { readClientSettings, writeClientSettings } from './settings.js';
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
export function WallpaperSettingsSection(props) {
    const fetchSettings = props.fetchSettings ?? readClientSettings;
    const writeSettings = props.writeSettings ?? writeClientSettings;
    const fetchWallpapers = props.fetchWallpapers ?? defaultFetchWallpapers;
    const fetchProbe = props.fetchProbe ?? defaultFetchProbe;
    const onSelect = props.onSelect ?? sharedOnSelect ?? (() => { });
    const onRuntimeSettings = props.onRuntimeSettings ?? sharedOnRuntimeSettings ?? (() => { });
    const [settings, setSettings] = useState(null);
    const [wallpapers, setWallpapers] = useState([]);
    const [probe, setProbe] = useState(null);
    const [wallpaperDir, setWallpaperDir] = useState('');
    const [weAssetsDir, setWeAssetsDir] = useState('');
    const [message, setMessage] = useState('');
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
    return (_jsxs("div", { className: "wss-root", children: [_jsx("p", { className: "wss-hint", children: "\u9009\u62E9\u58C1\u7EB8\u80CC\u666F\uFF0C\u6216\u53D6\u6D88\u4EE5\u6062\u590D\u9ED8\u8BA4\u80CC\u666F\u3002\u58C1\u7EB8\u76EE\u5F55\u652F\u6301\u81EA\u52A8\u63A2\u6D4B\u6216\u624B\u52A8\u586B\u5199\u3002" }), _jsxs("div", { className: "wss-current", children: [_jsxs("span", { children: ["\u5F53\u524D\u58C1\u7EB8\uFF1A", currentTitle] }), _jsxs("div", { className: "wss-current-actions", children: [_jsx("button", { type: "button", className: "wss-refresh", onClick: refreshWallpapers, children: "\u5237\u65B0\u58C1\u7EB8" }), _jsx("button", { type: "button", className: "wss-cancel", onClick: () => select(''), children: "\u53D6\u6D88\u58C1\u7EB8" })] })] }), _jsx("div", { className: "wss-grid", children: wallpapers.map((w) => (_jsxs("button", { type: "button", className: 'wss-thumb' + (settings?.selectedWallpaperId === w.id ? ' wss-selected' : ''), "data-id": w.id, onClick: () => select(w.id), children: [w.previewUrl ? _jsx("img", { src: w.previewUrl, alt: w.title, loading: "lazy" }) : _jsx("span", { className: "wss-no-preview", children: "\u65E0\u9884\u89C8" }), _jsx("span", { className: "wss-badge", children: w.type.toUpperCase() }), _jsx("span", { className: "wss-thumb-title", children: w.title })] }, w.id))) }), settings && (_jsxs("div", { className: "wss-glow", children: [_jsxs("label", { className: "wss-glow-row", children: [_jsx("input", { type: "checkbox", checked: settings.glowEnabled, onChange: (e) => applyRuntime({ glowEnabled: e.target.checked }) }), "\u5149\u6655\uFF08\u7ACB\u5373\u751F\u6548\uFF09"] }), _jsxs("label", { className: "wss-glow-slider", children: [_jsxs("span", { children: ["\u5149\u6655\u9608\u503C ", settings.glowThreshold.toFixed(2)] }), _jsx("input", { type: "range", className: "wss-glow-threshold", min: 0, max: 0.99, step: 0.01, value: settings.glowThreshold, onChange: (e) => applyRuntime({ glowThreshold: Number(e.target.value) }) })] }), _jsxs("label", { className: "wss-glow-slider", children: [_jsxs("span", { children: ["\u5149\u6655\u5F3A\u5EA6 ", settings.glowStrength.toFixed(2)] }), _jsx("input", { type: "range", className: "wss-glow-strength", min: 0, max: 4, step: 0.05, value: settings.glowStrength, onChange: (e) => applyRuntime({ glowStrength: Number(e.target.value) }) })] })] })), settings && (_jsxs("div", { className: "wss-power", children: [_jsxs("label", { className: "wss-glow-row", children: [_jsx("input", { type: "checkbox", checked: settings.paused, onChange: (e) => applyRuntime({ paused: e.target.checked }) }), "\u6682\u505C\u58C1\u7EB8\uFF08\u7701\u7535\uFF09"] }), _jsxs("label", { className: "wss-glow-row", children: [_jsx("input", { type: "checkbox", checked: settings.pauseOnHidden, onChange: (e) => applyRuntime({ pauseOnHidden: e.target.checked }) }), "\u5207\u5230\u540E\u53F0\u65F6\u81EA\u52A8\u6682\u505C"] }), _jsxs("label", { className: "wss-glow-row", children: [_jsx("span", { children: "\u753B\u8D28\u6863\u4F4D" }), _jsxs("select", { className: "wss-quality", value: String(settings.qualityScale), onChange: (e) => applyRuntime({ qualityScale: Number(e.target.value) }), children: [_jsx("option", { value: "1", children: "\u539F\u751F\uFF081\u00D7\uFF09" }), _jsx("option", { value: "0.75", children: "\u7701\u663E\u5B58\uFF080.75\u00D7\uFF09" }), _jsx("option", { value: "0.5", children: "\u6700\u7701\uFF080.5\u00D7\uFF09" })] })] })] })), settings && (_jsx("div", { className: "wss-sound-row", children: _jsxs("label", { className: "wss-glow-row", children: [_jsx("input", { type: "checkbox", className: "wss-sound", checked: settings.soundEnabled, onChange: (e) => applyRuntime({ soundEnabled: e.target.checked }) }), "\u58C1\u7EB8\u97F3\u6548"] }) })), _jsxs("div", { className: "wss-dirs", children: [_jsx("h4", { children: "\u58C1\u7EB8\u76EE\u5F55" }), _jsxs("label", { className: "wss-dir-row", children: [_jsx("span", { children: "\u58C1\u7EB8\u76EE\u5F55\uFF08workshop\uFF09" }), _jsx("input", { className: "wss-dir-workshop", value: wallpaperDir, placeholder: "\u4F8B\u5982 D:/Steam/steamapps/workshop/content/431960\uFF08\u7559\u7A7A = \u672A\u914D\u7F6E\uFF09", onChange: (e) => setWallpaperDir(e.target.value) })] }), _jsxs("label", { className: "wss-dir-row", children: [_jsx("span", { children: "\u5F15\u64CE\u76EE\u5F55\uFF08particle \u7EB9\u7406\uFF09" }), _jsx("input", { className: "wss-dir-assets", value: weAssetsDir, placeholder: "\u4F8B\u5982 D:/Steam/steamapps/common/wallpaper_engine\uFF08\u7559\u7A7A = \u672A\u914D\u7F6E\uFF09", onChange: (e) => setWeAssetsDir(e.target.value) })] }), _jsxs("div", { className: "wss-dir-actions", children: [_jsx("button", { type: "button", className: "wss-save-dirs", onClick: saveDirs, children: "\u4FDD\u5B58\u8DEF\u5F84" }), _jsx("button", { type: "button", className: "wss-probe", onClick: runProbe, children: "\u81EA\u52A8\u63A2\u6D4B" })] }), probe && (_jsxs("div", { className: "wss-probe-result", children: [_jsx("h4", { children: "\u63A2\u6D4B\u5230\u7684\u58C1\u7EB8\u76EE\u5F55" }), probe.workshop.map((c) => (_jsxs("div", { className: "wss-candidate", "data-kind": "workshop", children: [_jsx("span", { className: "wss-candidate-path", children: c.path }), _jsx("span", { className: c.exists ? 'wss-exists' : 'wss-missing', children: c.exists ? '存在' : '不存在' }), _jsx("button", { type: "button", className: "wss-adopt", "data-path": c.path, onClick: () => adopt(c.path, 'wallpaperDir'), children: "\u91C7\u7528" })] }, c.path))), _jsx("h4", { children: "\u63A2\u6D4B\u5230\u7684\u5F15\u64CE\u76EE\u5F55" }), probe.assets.map((c) => (_jsxs("div", { className: "wss-candidate", "data-kind": "assets", children: [_jsx("span", { className: "wss-candidate-path", children: c.path }), _jsx("span", { className: c.exists ? 'wss-exists' : 'wss-missing', children: c.exists ? '存在' : '不存在' }), _jsx("button", { type: "button", className: "wss-adopt", "data-path": c.path, onClick: () => adopt(c.path, 'weAssetsDir'), children: "\u91C7\u7528" })] }, c.path)))] }))] }), message && _jsx("p", { className: "wss-message", children: message })] }));
}
