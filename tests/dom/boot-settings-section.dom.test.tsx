import { describe, expect, it, vi, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { BootSettingsSection } from '../../src/client/boot-settings-section.js';
import type { ClientSettings } from '../../src/client/types.js';
import { DEFAULTS } from '../../src/client/settings.js';

const SETTINGS: ClientSettings = { ...DEFAULTS };
const LIST = [
  { id: '1', title: 'Scene', type: 'scene', hasScene: true, hasPreviewGif: false, previewUrl: '/p1' },
  { id: '2', title: 'Clip', type: 'video', file: 'a.mp4', hasScene: false, hasPreviewGif: false, previewUrl: '/p2' },
  { id: '3', title: 'Photo', type: 'image', hasScene: false, hasPreviewGif: false, previewUrl: '/p3' },
] as any[];

let container: HTMLElement;
let root: Root;
let writeSettings: ReturnType<typeof vi.fn>;

function render(props: Partial<React.ComponentProps<typeof BootSettingsSection>> = {}) {
  writeSettings = vi.fn(async () => true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const fetchSettings = vi.fn(async () => ({ ...SETTINGS }));
  root.render(<BootSettingsSection
    fetchSettings={fetchSettings}
    writeSettings={writeSettings}
    fetchWallpapers={async () => LIST}
    probePath={async () => ({ ok: true, exists: true, isFile: true, size: 1024, playable: true })}
    playPreview={async () => 'ended'}
    getLast={() => null}
    {...props}
  />);
  return { fetchSettings };
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('BootSettingsSection', () => {
  it('默认关闭；WE 素材只列 video/image 两类', async () => {
    await act(async () => { render(); });
    const enable = document.querySelector<HTMLInputElement>('.wbs-enable')!;
    expect(enable.checked).toBe(false);
    const opts = Array.from(document.querySelectorAll<HTMLOptionElement>('.wbs-wallpaper option')).map((o) => o.value);
    expect(opts).toEqual(['', '2', '3']);
  });

  it('选择 WE 视频壁纸写入 id + kind；视频时平铺禁用', async () => {
    await act(async () => { render(); });
    const select = document.querySelector<HTMLSelectElement>('.wbs-wallpaper')!;
    await act(async () => { select.value = '2'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(writeSettings).toHaveBeenCalledWith({ bootAnimationWallpaperId: '2', bootAnimationWallpaperKind: 'video' });
    const tile = document.querySelector<HTMLInputElement>('.wbs-fit-tile')!;
    expect(tile.disabled).toBe(true);
  });

  it('本地路径校验显示结果；试播调用 playPreview', async () => {
    await act(async () => { render(); });
    const local = document.querySelector<HTMLInputElement>('.wbs-source-local')!;
    await act(async () => { local.click(); });
    const input = document.querySelector<HTMLInputElement>('.wbs-local-path')!;
    await act(async () => { input.value = 'E:\\a.mp4'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { document.querySelector<HTMLButtonElement>('.wbs-probe')!.click(); });
    expect(document.querySelector('.wbs-probe-result')!.textContent).toContain('可播放');
    await act(async () => { document.querySelector<HTMLButtonElement>('.wbs-preview')!.click(); });
    const message = document.querySelector('.wbs-message')!.textContent ?? '';
    expect(message).toContain('ended');
    expect(message).toContain('播放完成'); // 英文结果码之外必须有中文结论
  });

  it('校验失败中文化：英文 error 码不上屏', async () => {
    await act(async () => {
      render({ probePath: async () => ({ ok: false, exists: false, isFile: false, error: 'not found' }) });
    });
    await act(async () => { document.querySelector<HTMLButtonElement>('.wbs-probe')!.click(); });
    const text = document.querySelector('.wbs-probe-result')!.textContent ?? '';
    expect(text).toContain('文件不存在或不是普通文件');
    expect(text).not.toContain('not found');
  });

  it('本地路径输入只改本地显示，失焦才持久化', async () => {
    await act(async () => { render(); });
    const input = document.querySelector<HTMLInputElement>('.wbs-local-path')!;
    // 受控 input 必须走原型 setter，否则 React 的 value tracker 认不出变化（不触发 onChange）。
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'E:\\clips\\boot.mp4');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('E:\\clips\\boot.mp4');
    expect(writeSettings).not.toHaveBeenCalled(); // 输入过程中不落盘
    await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(writeSettings).toHaveBeenCalledWith({ bootAnimationLocalPath: 'E:\\clips\\boot.mp4' });
  });

  it('本地素材平铺置灰；切回 WE 图片素材后恢复可用', async () => {
    await act(async () => { render({ fetchSettings: async () => ({ ...SETTINGS, bootAnimationSource: 'local' }) }); });
    const tile = () => document.querySelector<HTMLInputElement>('.wbs-fit-tile')!;
    expect(tile().disabled).toBe(true); // 本地素材恒为视频
    const select = document.querySelector<HTMLSelectElement>('.wbs-wallpaper')!;
    await act(async () => {
      document.querySelector<HTMLInputElement>('.wbs-source-we')!.click();
      select.value = '3';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(tile().disabled).toBe(false); // WE 图片素材可平铺
  });

  it('壁纸列表为空给提示；上次播放结果中文化', async () => {
    await act(async () => {
      render({ fetchWallpapers: async () => [], getLast: () => ({ result: 'timeout', at: 1 }) });
    });
    expect(document.querySelector('.wbs-wallpaper')!.querySelectorAll('option')).toHaveLength(1);
    const hints = Array.from(document.querySelectorAll('.wbs-desc')).map((el) => el.textContent ?? '');
    expect(hints.some((t) => t.includes('壁纸列表为空'))).toBe(true);
    expect(document.querySelector('.wbs-last')!.textContent).toContain('素材超时');
  });

  it('默认试播走 window.__wallpaperEngineBoot.play；缺失时提示未启用', async () => {
    const play = vi.fn(async () => 'skipped');
    try {
      (window as any).__wallpaperEngineBoot = { play, getLast: () => null };
      await act(async () => { render({ playPreview: undefined, getLast: undefined }); });
      await act(async () => { document.querySelector<HTMLButtonElement>('.wbs-preview')!.click(); });
      expect(play).toHaveBeenCalledWith({ force: true });
      expect(document.querySelector('.wbs-message')!.textContent).toContain('已跳过');

      delete (window as any).__wallpaperEngineBoot; // 未注入 boot API（如旧版 index）→ 明确提示
      await act(async () => { document.querySelector<HTMLButtonElement>('.wbs-preview')!.click(); });
      expect(document.querySelector('.wbs-message')!.textContent).toContain('未启用');
    } finally {
      delete (window as any).__wallpaperEngineBoot;
    }
  });
});
