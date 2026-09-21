import { describe, expect, it, vi, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { WallpaperSettingsSection, setWallpaperRuntimeHandler } from '../../src/client/settings-section.js';
import type { ClientSettings } from '../../src/client/types.js';
import type { ProbeResult } from '../../src/shared/types.js';

// 壁纸设置面板（设置对话框 "壁纸" section）：
// 网格切换 / 取消壁纸 / 路径配置（手动 + 自动探测）。数据与动作经 props 注入
// （默认走真实 API），测试只关心组件行为。

const BASE_SETTINGS: ClientSettings = {
  selectedWallpaperId: '1', wallpaperDir: '', weAssetsDir: '',
  overlayOpacity: 0.35, blurEnabled: false, blurRadius: 12, kenBurns: true,
  glowEnabled: true, glowThreshold: 0.65, glowStrength: 0.35,
  paused: false, pauseOnHidden: true, qualityScale: 1,
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

  it('点击「光晕」复选框 → 立即下发（onRuntimeSettings）+ 持久化 glowEnabled=false', async () => {
    const writeSettings = vi.fn(async () => {});
    const onRuntimeSettings = vi.fn();
    mount({ writeSettings, onRuntimeSettings });
    await flush();
    // 本文件无 @testing-library 依赖：沿用既有写法，按 label 取到「光晕」复选框
    // （label 包裹 input ⇒ 该复选框即以「光晕（立即生效）」为可访问名）
    const label = container.querySelector('.wss-glow-row') as HTMLLabelElement | null;
    expect(label?.textContent).toBe('光晕（立即生效）');
    const box = label!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    box.click();
    await flush();
    // 开关也走运行期通道：改完立刻生效（不必再切一次壁纸）
    expect(onRuntimeSettings).toHaveBeenCalledWith({ glowEnabled: false });
    expect(writeSettings).toHaveBeenCalledWith({ glowEnabled: false });
    expect(box.checked).toBe(false);
  });

  // 应用级 Glow 的阈值/强度（2026-09-21）：此前只有 profile config 能改，且改完要切一次壁纸才生效。
  it('光晕阈值/强度滑杆：显示当前值，拖动 → 立即下发 + 持久化（不必重选壁纸）', async () => {
    const writeSettings = vi.fn(async () => {});
    const onRuntimeSettings = vi.fn();
    mount({ writeSettings, onRuntimeSettings });
    await flush();
    const th = container.querySelector('.wss-glow-threshold') as HTMLInputElement;
    const st = container.querySelector('.wss-glow-strength') as HTMLInputElement;
    expect(th).toBeTruthy();
    expect(st).toBeTruthy();
    // 范围与当前值（阈值 0–0.99、强度 0–4；当前值来自设置）
    expect([th.type, th.min, th.max, th.value]).toEqual(['range', '0', '0.99', '0.65']);
    expect([st.type, st.min, st.max, st.value]).toEqual(['range', '0', '4', '0.35']);
    const setValue = (el: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue(th, '0.5');
    await flush();
    expect(onRuntimeSettings).toHaveBeenCalledWith({ glowThreshold: 0.5 });
    expect(writeSettings).toHaveBeenCalledWith({ glowThreshold: 0.5 });
    expect(th.value).toBe('0.5'); // 受控：回写设置值
    setValue(st, '2');
    await flush();
    expect(onRuntimeSettings).toHaveBeenCalledWith({ glowStrength: 2 });
    expect(writeSettings).toHaveBeenCalledWith({ glowStrength: 2 });
    expect(st.value).toBe('2');
  });

  // 槽位组件拿不到 props（settings.section 由 index.ts 注册）⇒ 生产上走共享 handler；
  // 这里钉住「未传 onRuntimeSettings 时仍然下发」，否则面板改 Glow 在生产里会静默失效。
  it('未传 onRuntimeSettings ⇒ 走 setWallpaperRuntimeHandler 注册的共享通道', async () => {
    const shared = vi.fn();
    setWallpaperRuntimeHandler(shared);
    try {
      mount();
      await flush();
      const st = container.querySelector('.wss-glow-strength') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(st, '1.5');
      st.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
      expect(shared).toHaveBeenCalledWith({ glowStrength: 1.5 });
    } finally {
      setWallpaperRuntimeHandler(() => {});
    }
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

  // 省电/画质档位（2026-09-21）：面板改完立即生效（经 onRuntimeSettings 下发渲染器），并持久化。
  it('省电/画质控件：暂停、后台自动暂停、画质档位 → 即时回调 + 持久化', async () => {
    const writeSettings = vi.fn(async () => {});
    const onRuntimeSettings = vi.fn();
    mount({ writeSettings, onRuntimeSettings });
    await flush();

    const boxes = container.querySelectorAll('.wss-power input[type="checkbox"]');
    expect(boxes.length).toBe(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(false); // paused 缺省 false
    expect((boxes[1] as HTMLInputElement).checked).toBe(true); // pauseOnHidden 缺省 true
    (boxes[0] as HTMLInputElement).click();
    await flush();
    expect(onRuntimeSettings).toHaveBeenCalledWith({ paused: true });
    expect(writeSettings).toHaveBeenCalledWith({ paused: true });

    (container.querySelectorAll('.wss-power input[type="checkbox"]')[1] as HTMLInputElement).click();
    await flush();
    expect(onRuntimeSettings).toHaveBeenCalledWith({ pauseOnHidden: false });

    const select = container.querySelector('.wss-quality') as HTMLSelectElement;
    expect(select.value).toBe('1');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, '0.5');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(onRuntimeSettings).toHaveBeenCalledWith({ qualityScale: 0.5 });
    expect(writeSettings).toHaveBeenCalledWith({ qualityScale: 0.5 });
  });
});
