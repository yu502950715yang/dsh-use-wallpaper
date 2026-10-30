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

const $ = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string): T[] => Array.from(document.querySelectorAll<T>(sel));

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('BootSettingsSection', () => {
  it('默认关闭；WE 素材网格只列 video / image（不出现 scene）', async () => {
    await act(async () => { render(); });
    expect($<HTMLInputElement>('.wbs-enable')!.checked).toBe(false);
    await act(async () => { $<HTMLButtonElement>('.wbs-choose')!.click(); });
    const ids = $$('.wbs-wallpaper-card').map((c) => c.getAttribute('data-id'));
    expect(ids).toEqual(['2', '3']); // scene(1) 被过滤
    expect($('.wbs-wallpaper-card[data-id="1"]')).toBeNull();
  });

  it('选择 WE 视频壁纸：写入 id+kind、当前素材卡显示标题/类型、视频时平铺禁用', async () => {
    await act(async () => { render(); });
    await act(async () => { $<HTMLButtonElement>('.wbs-choose')!.click(); });
    await act(async () => { $<HTMLButtonElement>('.wbs-wallpaper-card[data-id="2"]')!.click(); });
    expect(writeSettings).toHaveBeenCalledWith({ bootAnimationWallpaperId: '2', bootAnimationWallpaperKind: 'video' });
    expect($('.wbs-current-title')!.textContent).toBe('Clip');
    expect($('.wbs-current-meta')!.textContent).toContain('视频');
    expect($<HTMLInputElement>('.wbs-fit-tile')!.disabled).toBe(true);
  });

  it('WE 选择器支持按标题搜索过滤', async () => {
    await act(async () => { render(); });
    await act(async () => { $<HTMLButtonElement>('.wbs-choose')!.click(); });
    const search = $<HTMLInputElement>('.wbs-wallpaper-search')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(search, 'photo');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect($$('.wbs-wallpaper-card').map((c) => c.getAttribute('data-id'))).toEqual(['3']);
  });

  it('本地文件（桌面端）：系统选择器选中后写入路径并自动校验', async () => {
    const pickLocalFile = vi.fn(async () => 'E:\\clips\\a.mp4');
    await act(async () => {
      render({ pickLocalFile });
    });
    await act(async () => { $<HTMLInputElement>('.wbs-source-local')!.click(); });
    expect($('.wbs-pick-file')).not.toBeNull();
    expect($('.wbs-local-path')).toBeNull(); // 桌面端不再要求手填
    await act(async () => { $<HTMLButtonElement>('.wbs-pick-file')!.click(); });
    expect(pickLocalFile).toHaveBeenCalledTimes(1);
    expect(writeSettings).toHaveBeenCalledWith({ bootAnimationLocalPath: 'E:\\clips\\a.mp4' });
    expect($('.wbs-current-title')!.textContent).toContain('a.mp4');
    expect($('.wbs-probe-result')!.textContent).toContain('可播放');
  });

  it('本地文件（web/旧版）：回退手填路径 + 校验按钮；失焦才持久化', async () => {
    await act(async () => { render({ pickLocalFile: null }); }); // null = 环境不支持系统选择器
    await act(async () => { $<HTMLInputElement>('.wbs-source-local')!.click(); });
    const callsBefore = writeSettings.mock.calls.length; // 切来源本身会写一次设置
    const input = $<HTMLInputElement>('.wbs-local-path')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'E:\\clips\\boot.mp4');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(writeSettings.mock.calls.length).toBe(callsBefore); // 输入过程中不落盘
    await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(writeSettings).toHaveBeenLastCalledWith({ bootAnimationLocalPath: 'E:\\clips\\boot.mp4' });
    await act(async () => { $<HTMLButtonElement>('.wbs-probe')!.click(); });
    expect($('.wbs-probe-result')!.textContent).toContain('可播放');
  });

  it('校验失败中文化：英文 error 码不上屏', async () => {
    await act(async () => {
      render({ pickLocalFile: null, probePath: async () => ({ ok: false, exists: false, isFile: false, error: 'not found' }) });
    });
    await act(async () => { $<HTMLInputElement>('.wbs-source-local')!.click(); });
    await act(async () => { $<HTMLButtonElement>('.wbs-probe')!.click(); });
    const text = $('.wbs-probe-result')!.textContent ?? '';
    expect(text).toContain('文件不存在或不是普通文件');
    expect(text).not.toContain('not found');
  });

  it('本地素材平铺置灰；切回 WE 图片素材后恢复可用', async () => {
    await act(async () => { render({ fetchSettings: async () => ({ ...SETTINGS, bootAnimationSource: 'local' }) }); });
    const tile = () => $<HTMLInputElement>('.wbs-fit-tile')!;
    expect(tile().disabled).toBe(true); // 本地素材恒为视频
    await act(async () => { $<HTMLInputElement>('.wbs-source-we')!.click(); });
    await act(async () => { $<HTMLButtonElement>('.wbs-choose')!.click(); });
    await act(async () => { $<HTMLButtonElement>('.wbs-wallpaper-card[data-id="3"]')!.click(); });
    expect(tile().disabled).toBe(false); // WE 图片素材可平铺
  });

  it('试播调用 playPreview 并显示中文结论', async () => {
    await act(async () => { render(); });
    await act(async () => { $<HTMLButtonElement>('.wbs-preview')!.click(); });
    const message = $('.wbs-message')!.textContent ?? '';
    expect(message).toContain('ended');
    expect(message).toContain('播放完成');
  });

  it('壁纸列表为空给提示；上次播放结果中文化', async () => {
    await act(async () => {
      render({ fetchWallpapers: async () => [], getLast: () => ({ result: 'timeout', at: 1 }) });
    });
    await act(async () => { $<HTMLButtonElement>('.wbs-choose')!.click(); });
    const hints = $$('.wbs-desc').map((el) => el.textContent ?? '');
    expect(hints.some((t) => t.includes('壁纸列表为空'))).toBe(true);
    expect($('.wbs-last')!.textContent).toContain('素材超时');
  });

  it('默认试播走 window.__wallpaperEngineBoot.play；缺失时提示未启用', async () => {
    const play = vi.fn(async () => 'skipped');
    try {
      (window as any).__wallpaperEngineBoot = { play, getLast: () => null };
      await act(async () => { render({ playPreview: undefined, getLast: undefined }); });
      await act(async () => { $<HTMLButtonElement>('.wbs-preview')!.click(); });
      expect(play).toHaveBeenCalledWith({ force: true });
      expect($('.wbs-message')!.textContent).toContain('已跳过');

      delete (window as any).__wallpaperEngineBoot; // 未注入 boot API（如旧版 index）→ 明确提示
      await act(async () => { $<HTMLButtonElement>('.wbs-preview')!.click(); });
      expect($('.wbs-message')!.textContent).toContain('未启用');
    } finally {
      delete (window as any).__wallpaperEngineBoot;
    }
  });

  // 面板设计系统（2026-10-30）：状态 hero / 来源分段 / 展示方式 2×2 卡片 / 状态条 tone。
  it('设计系统结构：hero、来源分段、2×2 展示方式卡片与状态条 tone', async () => {
    await act(async () => {
      render({ getLast: () => ({ result: 'ended', at: Date.now() }) });
    });
    expect($('.wbs-hero')).not.toBeNull();
    expect($('.wbs-switch')).not.toBeNull();
    expect($('.wbs-last')!.getAttribute('data-tone')).toBe('ok');
    expect($$('.wbs-source-group .wbs-source')).toHaveLength(2);
    const cards = $$('.wbs-fit-card');
    expect(cards).toHaveLength(4);
    expect(cards.map((c) => c.getAttribute('data-fit'))).toEqual(['tile', 'contain', 'stretch', 'cover']);
    // 当前素材卡：默认未选时是空态
    expect($('.wbs-current')!.getAttribute('data-empty')).toBe('true');
  });

  it('失败态状态条使用语义 tone（上次播放 failed → danger）', async () => {
    await act(async () => {
      render({ getLast: () => ({ result: 'failed', at: Date.now() }) });
    });
    expect($('.wbs-last')!.getAttribute('data-tone')).toBe('danger');
  });
});
