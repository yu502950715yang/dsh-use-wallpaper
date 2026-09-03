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
  it('消息气泡改回 DSH 原生（无液态玻璃覆盖）；输入框保留液态玻璃（blur + 圆角）', () => {
    // 2026-08-31：消息气泡（flowItem）改回 DSH 原生样式，插件不再给它加液态玻璃覆盖
    expect(WALLPAPER_CSS).not.toMatch(/\[data-we-wallpaper\]\s*\[class\*="flowItem"\]\s*\{[^}]*backdrop-filter/);
    expect(WALLPAPER_CSS).not.toMatch(/\[class\*="flowItem"\]\s*\{[^}]*border-radius:16px/);
    // 输入框：圆角 + blur（保留液态玻璃）
    expect(WALLPAPER_CSS).toMatch(/\[data-composer-card\]\s*\{[^}]*border-radius:20px[^}]*backdrop-filter:blur\(/);
    // 输入框深浅色玻璃底色
    const lightComposer = /body\[data-we-wallpaper\]\s*\[data-composer-card\]\s*\{([^}]*)\}/.exec(WALLPAPER_CSS)?.[1] ?? '';
    expect(lightComposer).toMatch(/background-color:rgba\(255,\s*255,\s*255,\s*\.5\d*\)/);
    const darkComposer = /body\[data-ds-dark-theme\]\[data-we-wallpaper\]\s*\[data-composer-card\]\s*\{([^}]*)\}/.exec(WALLPAPER_CSS)?.[1] ?? '';
    expect(darkComposer).toMatch(/background-color:rgba\(2[0-9],\s*2[0-9],\s*3[0-9],\s*\.6\d*\)/);
  });
  it('用户提问弹窗与主输入框一致：液体玻璃（[data-question-key] section）', () => {
    expect(WALLPAPER_CSS).toMatch(/\[data-question-key\]\s*section\s*\{[^}]*border-radius:20px[^}]*backdrop-filter:blur\(/);
    const dark = /body\[data-ds-dark-theme\]\[data-we-wallpaper\]\s*\[data-question-key\]\s*section\s*\{([^}]*)\}/.exec(WALLPAPER_CSS)?.[1] ?? '';
    expect(dark).toMatch(/background-color:rgba\(2[0-9],\s*2[0-9],\s*3[0-9],\s*\.6\d*\)/);
  });
  it('整区 scrollBody 不 blur（壁纸在气泡间清晰可见，不遮挡背景）', () => {
    expect(WALLPAPER_CSS).not.toMatch(/\[class\*="scrollBody"\]\s*\{[^}]*backdrop-filter/);
  });
  it('侧边栏无 blur（对话框 portal 在下面会塌陷）；填充用 --dsw-specific-sidebar-fill 半透明（壁纸透出）', () => {
    expect(WALLPAPER_CSS).not.toMatch(/\[class\*="sidebarCol"\]\s*\{[^}]*backdrop-filter/);
    // 侧边栏根（hHd-Xa_root）与列都用 --dsw-specific-sidebar-fill，半透明让壁纸透出
    expect(WALLPAPER_CSS).toMatch(/body\[data-we-wallpaper\]:not\(\[data-ds-dark-theme\]\)\s*\{[^}]*--dsw-specific-sidebar-fill:rgba\(255,\s*255,\s*255,\s*\.5\d*\)!important/);
    expect(WALLPAPER_CSS).toMatch(/body\[data-ds-dark-theme\]\[data-we-wallpaper\]\s*\{[^}]*--dsw-specific-sidebar-fill:rgba\(24,\s*26,\s*30,\s*\.4\d*\)!important/);
  });
  it('壁纸层不透明化：消息区/输入框 token 透明（壁纸透出），整区 scrollBody 无 blur，无 text-shadow', () => {
    // 侧边栏 fill 不再全局设 transparent，而由浅/深分支半透明控制（覆盖 DSH dark 分支的不透明值）
    expect(WALLPAPER_CSS).not.toMatch(/body\[data-we-wallpaper\]\s*\{[^}]*--dsw-specific-sidebar-fill:transparent/);
    const light = /body\[data-we-wallpaper\]:not\(\[data-ds-dark-theme\]\)\s*\{([^}]*)\}/.exec(WALLPAPER_CSS)?.[1] ?? '';
    expect(light).toMatch(/--dsw-specific-input-major:transparent/);
    expect(light).toMatch(/--dsw-specific-bubble:transparent/);
    const dark = /body\[data-ds-dark-theme\]\[data-we-wallpaper\]\s*\{([^}]*)\}/.exec(WALLPAPER_CSS)?.[1] ?? '';
    expect(dark).toMatch(/--dsw-specific-input-major:transparent/);
    expect(dark).toMatch(/--dsw-specific-bubble:transparent/);
    expect(WALLPAPER_CSS).not.toMatch(/\[class\*="scrollBody"\]\s*\{[^}]*backdrop-filter/);
    expect(WALLPAPER_CSS).not.toMatch(/text-shadow:/);
  });
  it('scrim 遮罩：壁纸清晰可见但被适度压暗（.wp-bg-overlay rgba(0,0,0,.3)）', () => {
    expect(WALLPAPER_CSS).toMatch(/\.wp-bg-overlay\s*\{[^}]*background:rgba\(0,\s*0,\s*0,\s*\.3\d*\)/);
    expect(WALLPAPER_CSS).not.toMatch(/\.wp-bg-overlay\s*\{[^}]*opacity:\.35/);
  });
  it('边框强调：--dsw-alias-border-l1/l2 中性灰（深浅主题可见）', () => {
    expect(WALLPAPER_CSS).toMatch(/--dsw-alias-border-l1:rgba\(180,\s*180,\s*180/);
    expect(WALLPAPER_CSS).toMatch(/--dsw-alias-border-l2:rgba\(180,\s*180,\s*180/);
  });
  it('文字颜色跟随壁纸亮度：消息列文本消费 --wp-chat-fg（fallback 到主题文字色）', () => {
    // 2026-09-03：只改消息列文字颜色（不遮背景）。flowItem 主要文本 color 读 --wp-chat-fg，
    // 未测量时 fallback 到 DSH 主题文字色（--dsw-alias-label-primary）。
    expect(WALLPAPER_CSS).toMatch(/body\[data-we-wallpaper\]\s*\[class\*="flowItem"\]\s*p[\s\S]*color:var\(--wp-chat-fg,var\(--dsw-alias-label-primary,inherit\)\)/);
  });
  it('行内代码/代码块不随壁纸亮度反色：显式用主题文字色（避免暗壁纸下 code 白字白底）', () => {
    // 2026-09-03 修复：code 有独立不透明背景（浅色近白），其 color 会被父级 --wp-chat-fg 继承成白字
    // → 白底白字。须显式给 code/pre code 用 --dsw-alias-label-primary（随主题：浅=黑/深=白）。
    expect(WALLPAPER_CSS).toMatch(/body\[data-we-wallpaper\]\s*\[class\*="flowItem"\]\s*code[\s\S]*color:var\(--dsw-alias-label-primary,inherit\)/);
    expect(WALLPAPER_CSS).toMatch(/body\[data-we-wallpaper\]\s*\[class\*="flowItem"\]\s*pre code[\s\S]*color:var\(--dsw-alias-label-primary,inherit\)/);
  });
  it('actions 内操作 SVG 图标跟随壁纸亮度（fill=currentColor 继承容器 color）', () => {
    // 2026-09-03 修复：actions 的 SVG 图标 fill="currentColor"，背景透明贴壁纸，
    // 应跟随 --wp-chat-fg（暗壁纸→白图标、亮壁纸→黑图标），避免浅灰图标在壁纸上看不清。
    expect(WALLPAPER_CSS).toMatch(/\[class\*="flowItem"\]\s*\[class\*="actions"\]\s*svg\s*\{/);
    expect(WALLPAPER_CSS).toMatch(/\[class\*="flowItem"\]\s*\[class\*="actions"\]\s*svg\s*\{[^}]*color:var\(--wp-chat-fg,var\(--dsw-alias-label-primary,inherit\)\)/);
  });
  it('文件链接跟随壁纸亮度（[class*=fileLink]/a，避免深灰链接在暗壁纸上看不清）', () => {
    // 文件链接选择器是逗号分组（a, fileLink, _file），最后 `_file]{` 直接跟规则体。
    expect(WALLPAPER_CSS).toMatch(/\[class\*="flowItem"\]\s*\[class\*="fileLink"\]/);
    expect(WALLPAPER_CSS).toMatch(/\[class\*="flowItem"\]\s*\[class\*="_file"\]\s*\{[^}]*color:var\(--wp-chat-fg,var\(--dsw-alias-label-primary,inherit\)\)/);
  });
  it('li 列表点（::marker）跟随壁纸亮度（避免深灰点在暗壁纸上看不清）', () => {
    expect(WALLPAPER_CSS).toMatch(/\[class\*="flowItem"\]\s*li::marker\s*\{[^}]*color:var\(--wp-chat-fg,var\(--dsw-alias-label-primary,inherit\)\)/);
  });
  it('消息气泡（有独立背景）内部文字用主题色（避免暗壁纸下白字贴淡蓝底看不清）', () => {
    // 2026-09-03 修复：气泡有 --dsw-specific-bubble 背景（浅色淡蓝），内部文字不能用 --wp-chat-fg 反色，
    // 须显式用 --dsw-alias-label-primary（浅=黑/深=白）保证与气泡背景对比。
    // 选择器是逗号分组（bubble, bubble p, ... bubble code{），code 是最后一条直接跟 {。
    expect(WALLPAPER_CSS).toMatch(/\[class\*="flowItem"\]\s*\[class\*="bubble"\]\s*code\s*\{[^}]*color:var\(--dsw-alias-label-primary,inherit\)/);
  });
});
