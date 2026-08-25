import { describe, expect, it, vi, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { WallpaperSettingsSection } from '../../src/client/settings-section.js';
import type { ClientSettings } from '../../src/client/types.js';
import type { ProbeResult } from '../../src/shared/types.js';

// 壁纸设置面板（设置对话框 "壁纸" section）：
// 网格切换 / 取消壁纸 / 路径配置（手动 + 自动探测）。数据与动作经 props 注入
// （默认走真实 API），测试只关心组件行为。

const BASE_SETTINGS: ClientSettings = {
  selectedWallpaperId: '1', wallpaperDir: '', weAssetsDir: '',
  overlayOpacity: 0.35, blurEnabled: false, blurRadius: 12, kenBurns: true,
};

const WALLPAPERS = [
  { id: '1', title: 'EVA', type: 'scene', hasScene: true, hasPreviewGif: false, previewUrl: '/p1' },
  { id: '2', title: 'Video', type: 'video', file: 'a.mp4', hasScene: false, hasPreviewGif: false, previewUrl: '/p2' },
];

const PROBE: ProbeResult = {
  workshop: [
    { path: 'D:/Steam/steamapps/workshop/content/431960', exists: true, kind: 'workshop' },
    { path: 'E:/Lib/steamapps/workshop/content/431960', exists: false, kind: 'workshop' },
  ],
  assets: [
    { path: 'D:/Steam/steamapps/common/wallpaper_engine', exists: true, kind: 'assets' },
  ],
};

let container: HTMLElement;
let root: Root;

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function mount(props: Partial<React.ComponentProps<typeof WallpaperSettingsSection>> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  root.render((
    <WallpaperSettingsSection
      fetchSettings={async () => BASE_SETTINGS}
      writeSettings={async () => {}}
      fetchWallpapers={async () => WALLPAPERS as any}
      fetchProbe={async () => PROBE}
      onSelect={() => {}}
      {...props}
    />
  ));
}

async function unmount() {
  await act(async () => { root.unmount(); });
  container.remove();
}

afterEach(async () => { await unmount(); vi.restoreAllMocks(); });

describe('WallpaperSettingsSection', () => {
  it('渲染壁纸网格并标记当前选中项', async () => {
    mount();
    await flush();
    const thumbs = container.querySelectorAll('.wss-thumb');
    expect(thumbs.length).toBe(2);
    expect(thumbs[0]!.classList.contains('wss-selected')).toBe(true);
    expect((container.querySelector('.wss-thumb-title') as HTMLElement).textContent).toBe('EVA');
  });

  it('点击壁纸 → 调用 onSelect 并持久化 selectedWallpaperId', async () => {
    const onSelect = vi.fn();
    const writeSettings = vi.fn(async () => {});
    mount({ onSelect, writeSettings });
    await flush();
    const thumbs = container.querySelectorAll('.wss-thumb');
    (thumbs[1] as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith('2');
    expect(writeSettings).toHaveBeenCalledWith({ selectedWallpaperId: '2' });
  });

  it('点击「取消壁纸」→ onSelect("") 并持久化空 id', async () => {
    const onSelect = vi.fn();
    const writeSettings = vi.fn(async () => {});
    mount({ onSelect, writeSettings });
    await flush();
    (container.querySelector('.wss-cancel') as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith('');
    expect(writeSettings).toHaveBeenCalledWith({ selectedWallpaperId: '' });
  });

  it('自动探测：展示候选，点击采用写入 wallpaperDir', async () => {
    const writeSettings = vi.fn(async () => {});
    mount({ writeSettings });
    await flush();
    (container.querySelector('.wss-probe') as HTMLElement).click();
    await flush();
    const candidates = container.querySelectorAll('.wss-candidate');
    expect(candidates.length).toBe(3); // 2 workshop + 1 assets
    const workshopCandidates = container.querySelectorAll('.wss-candidate[data-kind="workshop"]');
    expect(workshopCandidates.length).toBe(2);
    // 点击存在的 workshop 候选
    const adopt = container.querySelector('.wss-adopt[data-path="D:/Steam/steamapps/workshop/content/431960"]') as HTMLElement;
    expect(adopt).toBeTruthy();
    adopt.click();
    expect(writeSettings).toHaveBeenCalledWith({ wallpaperDir: 'D:/Steam/steamapps/workshop/content/431960' });
  });

  it('手动输入路径并保存 → 同时写入 wallpaperDir 与 weAssetsDir', async () => {
    const writeSettings = vi.fn(async () => {});
    mount({ writeSettings });
    await flush();
    const inputW = container.querySelector('.wss-dir-workshop') as HTMLInputElement;
    const inputA = container.querySelector('.wss-dir-assets') as HTMLInputElement;
    const setValue = (el: HTMLInputElement, value: string) => {
      // React 受控组件：用原生 setter + input 事件触发 onChange
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue(inputW, 'D:/Custom/431960');
    setValue(inputA, 'D:/Custom/we');
    (container.querySelector('.wss-save-dirs') as HTMLElement).click();
    expect(writeSettings).toHaveBeenCalledWith({ wallpaperDir: 'D:/Custom/431960', weAssetsDir: 'D:/Custom/we' });
  });

  it('点击「刷新壁纸」→ 重新拉取列表并更新网格', async () => {
    const fetchWallpapers = vi.fn(async () => WALLPAPERS as any);
    mount({ fetchWallpapers });
    await flush();
    expect(fetchWallpapers).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('.wss-thumb').length).toBe(2);
    // 新的列表：替换为另一份数据
    fetchWallpapers.mockResolvedValueOnce([
      { id: '3', title: 'Web', type: 'web', hasScene: false, hasPreviewGif: false, previewUrl: '/p3' },
    ] as any);
    (container.querySelector('.wss-refresh') as HTMLElement).click();
    await flush();
    expect(fetchWallpapers).toHaveBeenCalledTimes(2);
    const thumbs = container.querySelectorAll('.wss-thumb');
    expect(thumbs.length).toBe(1);
    expect((container.querySelector('.wss-thumb-title') as HTMLElement).textContent).toBe('Web');
  });

  it('点击「刷新壁纸」失败 → 提示刷新壁纸失败', async () => {
    const fetchWallpapers = vi.fn(async () => { throw new Error('boom'); });
    mount({ fetchWallpapers });
    await flush();
    (container.querySelector('.wss-refresh') as HTMLElement).click();
    await flush();
    expect((container.querySelector('.wss-message') as HTMLElement).textContent).toBe('刷新壁纸失败');
  });
});
