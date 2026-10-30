import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// 「Wallpaper 壁纸」设置页的 tab 容器：日常壁纸 / 开机动画 各管各的设置，互不影响。
// 子面板默认渲染真实组件；测试可经 props 注入 stub（两套面板依赖多，stub 才能只测容器行为）。
import { useId, useState } from 'react';
import { WallpaperSettingsSection } from './settings-section.js';
import { BootSettingsSection } from './boot-settings-section.js';
const TABS = [
    { id: 'wallpaper', label: '日常壁纸' },
    { id: 'boot', label: '开机动画' },
];
export function WallpaperSettingsShell(props = {}) {
    // 默认「日常壁纸」且不记忆（每次打开行为可预测）。
    const [tab, setTab] = useState('wallpaper');
    const baseId = useId();
    const renderWallpaper = props.renderWallpaper ?? (() => _jsx(WallpaperSettingsSection, {}));
    const renderBoot = props.renderBoot ?? (() => _jsx(BootSettingsSection, {}));
    // tab 键盘交互（WAI-ARIA tabs）：←/→ 循环切换并移动焦点。
    const move = (dir) => {
        const index = TABS.findIndex((t) => t.id === tab);
        const next = TABS[(index + dir + TABS.length) % TABS.length];
        setTab(next.id);
        requestAnimationFrame(() => document.getElementById(baseId + '-tab-' + next.id)?.focus?.());
    };
    return (_jsxs("div", { className: "we-shell", children: [_jsx("div", { className: "we-tabs", role: "tablist", "aria-label": "\u58C1\u7EB8\u8BBE\u7F6E", children: TABS.map((t) => (_jsx("button", { id: baseId + '-tab-' + t.id, type: "button", role: "tab", className: 'we-tab' + (tab === t.id ? ' we-tab-active' : ''), "aria-selected": tab === t.id, "aria-controls": baseId + '-panel-' + t.id, tabIndex: tab === t.id ? 0 : -1, onClick: () => setTab(t.id), onKeyDown: (e) => {
                        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')
                            return;
                        e.preventDefault();
                        move(e.key === 'ArrowRight' ? 1 : -1);
                    }, children: t.label }, t.id))) }), _jsx("div", { className: "we-tabpanel", role: "tabpanel", id: baseId + '-panel-' + tab, "aria-labelledby": baseId + '-tab-' + tab, children: tab === 'boot' ? renderBoot() : renderWallpaper() })] }));
}
