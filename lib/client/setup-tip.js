import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// 首次安装提示条（注册进 DSH shell.overlay 槽位）：未配置素材目录时提示一次设置入口，
// 用 localStorage 标记只提示一次；读设置失败 / 已配置都静默不显示。
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { readClientSettings } from './settings.js';
import { STORAGE_KEYS } from './local-store.js';
/** shell.overlay 是 list slot：用自定义 id 只追加条目，不替换官方 toast。 */
const SETUP_TIP_ID = 'wallpaper-engine-setup-tip';
/**
 * 把提示条注册进 DSH 全框浮层（shell.overlay）：层级最高、默认 click-through，
 * 根元素自己接指针事件。宿主不提供 slots 时静默跳过（插件其余功能照常）。
 */
export function registerSetupTipSlots(ctx) {
    if (!ctx?.slots?.inject || !ctx?.slots?.register)
        return false;
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: SETUP_TIP_ID,
        order: 30,
    }, SetupTip));
    return true;
}
function storeOf(storage) {
    if (storage)
        return storage;
    return typeof localStorage !== 'undefined' ? localStorage : null;
}
export function SetupTip(props = {}) {
    const fetchSettings = props.fetchSettings ?? readClientSettings;
    // 真实注册走默认 15s 自动淡出；测试传 0 禁用定时器。
    const autoHideMs = props.autoHideMs ?? 15000;
    const [visible, setVisible] = useState(false);
    // 判定完成前不渲染：避免「先闪一下再消失」。
    const [settled, setSettled] = useState(false);
    useEffect(() => {
        let alive = true;
        void (async () => {
            const store = storeOf(props.storage);
            if (store?.getItem(STORAGE_KEYS.setupTip)) {
                if (alive)
                    setSettled(true); // 提示过：不再打扰
                return;
            }
            let configured = false;
            try {
                const s = await fetchSettings();
                configured = !!(s.wallpaperDir || s.weAssetsDir);
            }
            catch {
                if (alive)
                    setSettled(true); // 读不到设置：静默（不猜）
                return;
            }
            if (!alive)
                return;
            if (!configured) {
                store?.setItem(STORAGE_KEYS.setupTip, '1'); // 一次性：显示即写标记
                setVisible(true);
            }
            setSettled(true);
        })();
        return () => { alive = false; };
    }, [fetchSettings, props.storage]);
    useEffect(() => {
        if (!visible || !autoHideMs)
            return;
        const timer = setTimeout(() => setVisible(false), autoHideMs);
        return () => clearTimeout(timer);
    }, [visible, autoHideMs]);
    if (!settled || !visible || typeof document === 'undefined')
        return null;
    // portal 到 body：避开 shell.overlay 的层叠上下文（z-index:20），也保证不被设置对话框遮住；
    // 与官方 Toast 同级的 1100。样式在 styles.ts（.wst-*，只用 DSH token）。
    return createPortal(_jsxs("div", { className: "wst-root", role: "status", "aria-live": "polite", children: [_jsxs("div", { className: "wst-body", children: [_jsx("p", { className: "wst-title", children: "\u58C1\u7EB8\u5F15\u64CE\u8FD8\u5DEE\u4E00\u6B65" }), _jsxs("p", { className: "wst-desc", children: ["\u6253\u5F00 ", _jsx("b", { children: "\u8BBE\u7F6E \u2192 Wallpaper \u58C1\u7EB8" }), "\uFF0C\u70B9\u300C\u81EA\u52A8\u63A2\u6D4B\u300D\u627E\u5230 Wallpaper Engine \u7684\u7D20\u6750\u76EE\u5F55\uFF0C\u5C31\u80FD\u9009\u58C1\u7EB8\u4E86\u3002"] })] }), _jsx("button", { type: "button", className: "wst-dismiss", onClick: () => setVisible(false), children: "\u77E5\u9053\u4E86" })] }), document.body);
}
