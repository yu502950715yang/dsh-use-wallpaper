import { describe, expect, it, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { WallpaperSettingsShell } from '../../src/client/settings-shell.js';

// 「Wallpaper 壁纸」单 section：顶部 tab 切换两个面板（日常壁纸 / 开机动画）。
// 子面板经 props 注入 stub（真实面板各自有自己的 dom 测试），这里只测 tab 容器行为。

let container: HTMLElement;
let root: Root;

function render(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(<WallpaperSettingsShell
    renderWallpaper={() => <div className="stub-wallpaper">壁纸面板</div>}
    renderBoot={() => <div className="stub-boot">开机动画面板</div>}
  />);
}

function tabs(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.we-tab'));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('WallpaperSettingsShell（单 section + tab）', () => {
  it('默认渲染「日常壁纸」：两个 tab 存在、aria-selected 正确', async () => {
    await act(async () => { render(); });
    expect(tabs().map((t) => t.textContent)).toEqual(['日常壁纸', '开机动画']);
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('false');
    expect(document.querySelector('.stub-wallpaper')).not.toBeNull();
    expect(document.querySelector('.stub-boot')).toBeNull();
    expect(document.querySelector('[role="tablist"]')).not.toBeNull();
  });

  it('点击「开机动画」切换面板：boot 渲染、壁纸面板卸载（条件渲染）', async () => {
    await act(async () => { render(); });
    await act(async () => { tabs()[1]!.click(); });
    expect(document.querySelector('.stub-boot')).not.toBeNull();
    expect(document.querySelector('.stub-wallpaper')).toBeNull();
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('false');
  });

  it('点击「日常壁纸」切回；tab 面板带 role=tabpanel', async () => {
    await act(async () => { render(); });
    await act(async () => { tabs()[1]!.click(); });
    await act(async () => { tabs()[0]!.click(); });
    expect(document.querySelector('.stub-wallpaper')).not.toBeNull();
    expect(document.querySelector('.stub-boot')).toBeNull();
    const panel = document.querySelector('[role="tabpanel"]');
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute('aria-labelledby')).toBeTruthy();
  });

  it('键盘 → 从壁纸 tab 切到开机动画 tab；← 切回', async () => {
    await act(async () => { render(); });
    await act(async () => {
      tabs()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.querySelector('.stub-boot')).not.toBeNull();
    await act(async () => {
      tabs()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(document.querySelector('.stub-wallpaper')).not.toBeNull();
  });
});
