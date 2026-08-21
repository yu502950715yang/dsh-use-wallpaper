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
});
