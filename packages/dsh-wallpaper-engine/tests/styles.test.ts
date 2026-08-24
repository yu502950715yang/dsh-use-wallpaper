import { describe, expect, it } from 'vitest';
import { WALLPAPER_CSS } from '../src/client/styles.js';

// 浅色模式适配（2026-08-19）：styles.ts 须导出 CSS 常量（供测试断言），
// 且包含竞品式主题分支——浅色（有壁纸、非深色主题）与深色（有壁纸 + 深色主题）。
// 插件自身 UI（picker/FAB/thumb/badge）颜色改用 CSS 变量，不再硬编码深色。

describe('styles 主题适配', () => {
  it('导出 CSS 含浅色分支（有壁纸、非深色主题）', () => {
    expect(WALLPAPER_CSS).toContain('body[data-we-wallpaper]:not([data-ds-dark-theme])');
  });
  it('导出 CSS 含深色分支（有壁纸 + 深色主题）', () => {
    expect(WALLPAPER_CSS).toContain('body[data-ds-dark-theme][data-we-wallpaper]');
  });
  it('浅色分支覆盖 DSH 灰阶文字 token 提升对比度', () => {
    // 浅色主题下文字按近白底调校，壁纸透出后失去对比 → 压暗整条灰阶（竞品 1396-1403 同款）
    expect(WALLPAPER_CSS).toMatch(/body\[data-we-wallpaper\]:not\(\[data-ds-dark-theme\]\)\s*{[^}]*--dsw-alias-label-primary/);
  });
  it('设置面板 UI 用 CSS 变量而非硬编码深色（wss-root）', () => {
    expect(WALLPAPER_CSS).toMatch(/\.wss-root\s*{[^}]*var\(--dsw-alias-label-primary/);
  });
  it('设置面板按钮用 CSS 变量而非硬编码深色（wss-cancel 分组）', () => {
    expect(WALLPAPER_CSS).toMatch(/\.wss-cancel[^{]*\{[^}]*var\(--dsw-alias-border-l2/);
  });
  it('缩略图文字颜色用 CSS 变量', () => {
    expect(WALLPAPER_CSS).toMatch(/\.wp-thumb\s*{[^}]*var\(--wp-text/);
  });
  it('不再包含已移除的 FAB / picker 面板样式', () => {
    expect(WALLPAPER_CSS).not.toMatch(/\.wp-fab/);
    expect(WALLPAPER_CSS).not.toMatch(/\.wp-picker-panel/);
  });
  it('背景透明化收敛到有壁纸时（body[data-we-wallpaper] 作用域）', () => {
    // 原实现无条件 body{background:transparent!important}，浅色主题无壁纸时也被破坏 →
    // 改为仅在有壁纸激活时透明化
    expect(WALLPAPER_CSS).toMatch(/body\[data-we-wallpaper\]\s+#root/);
  });
  it('遮罩颜色可读：浅色分支 overlay 不硬编码纯黑高不透明度', () => {
    // 遮罩仍为深色但透明度收敛（不再 .35 压暗浅色主题）
    expect(WALLPAPER_CSS).not.toMatch(/\.wp-bg-overlay\s*{[^}]*opacity:\.35/);
  });
  it('半透明玻璃 token（参考项目配方）：浅色 input/bubble 白色微透明 .1x', () => {
    // 液态玻璃 token 在 body[data-we-wallpaper] 基础块（非层级透明块），两个 token 同块
    expect(WALLPAPER_CSS).toMatch(/body\[data-we-wallpaper\]\s*\{[^}]*--dsw-specific-input-major:rgba\(255,\s*255,\s*255,\s*\.1\d*\)[^}]*--dsw-specific-bubble:rgba\(255,\s*255,\s*255,\s*\.1\d*\)/);
  });
  it('半透明玻璃 token（参考项目配方）：深色分支更透的白色玻璃 .0x', () => {
    const dark = /body\[data-ds-dark-theme\]\[data-we-wallpaper\]\s*\{([^}]*)\}/.exec(WALLPAPER_CSS)?.[1] ?? '';
    expect(dark).toMatch(/--dsw-specific-input-major:rgba\(255,\s*255,\s*255,\s*\.0\d*\)/);
    expect(dark).toMatch(/--dsw-specific-bubble:rgba\(255,\s*255,\s*255,\s*\.0\d*\)/);
  });
  it('液态玻璃配方：消息区 scrollBody backdrop-filter blur + 白玻璃底色 + 高光渐变', () => {
    expect(WALLPAPER_CSS).toMatch(/\[class\*="scrollBody"\][^{]*\{[^}]*backdrop-filter:blur\(/);
    expect(WALLPAPER_CSS).toMatch(/\[class\*="scrollBody"\][^{]*\{[^}]*linear-gradient\(180deg/);
    expect(WALLPAPER_CSS).toMatch(/\[class\*="scrollBody"\][^{]*\{[^}]*background-color:rgba\(255,\s*255,\s*255,\s*\.1\d*\)/);
  });
  it('液态玻璃配方：输入框 data-composer-card backdrop-filter', () => {
    expect(WALLPAPER_CSS).toMatch(/\[data-composer-card\][^{]*\{[^}]*backdrop-filter:blur\(/);
  });
  it('液态玻璃配方：侧边栏 sidebarCol 无 blur（避免对话框 portal 塌陷），半透明背景兜底', () => {
    // 设置对话框 portal 挂在 sidebarCol 下，backdrop-filter 会使其 fixed 遮罩塌陷
    expect(WALLPAPER_CSS).toMatch(/body\[data-we-wallpaper\]\s*\[class\*="sidebarCol"\]\s*\{[^}]*background-color:rgba\(255,\s*255,\s*255,\s*\.7\d*\)/);
    expect(WALLPAPER_CSS).not.toMatch(/\[class\*="sidebarCol"\]\s*\{[^}]*backdrop-filter/);
  });
  it('边框强调：--dsw-alias-border-l1/l2 中性灰（深浅主题可见）', () => {
    expect(WALLPAPER_CSS).toMatch(/--dsw-alias-border-l1:rgba\(180,\s*180,\s*180/);
    expect(WALLPAPER_CSS).toMatch(/--dsw-alias-border-l2:rgba\(180,\s*180,\s*180/);
  });
  it('@supports 回退：无 backdrop-filter 时近不透明保证可读', () => {
    expect(WALLPAPER_CSS).toMatch(/@supports not \(\(backdrop-filter:blur\(1px\)\)/);
  });
});
