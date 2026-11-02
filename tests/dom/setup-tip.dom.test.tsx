import { describe, expect, it, vi, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SetupTip, registerSetupTipSlots } from '../../src/client/setup-tip.js';
import { STORAGE_KEYS, type StorageLike } from '../../src/client/local-store.js';
import type { ClientSettings } from '../../src/client/types.js';

// 首次安装提示条（shell.overlay 槽位）：未配置素材目录时提示一次入口位置，
// 之后靠 localStorage 标记不再打扰；已配置 / 读设置失败都静默不显示。

const SETTINGS = {
  wallpaperDir: '', weAssetsDir: '',
} as ClientSettings;

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => (key in data ? data[key]! : null),
    setItem: (key: string, value: string) => { data[key] = value; },
    removeItem: (key: string) => { delete data[key]; },
  };
}

let container: HTMLElement;
let root: Root | null = null;

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function mount(props: React.ComponentProps<typeof SetupTip> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // 默认关掉自动淡出定时器（用例自己控制）；需要时经 props 传 autoHideMs。
  root.render(<SetupTip fetchSettings={async () => SETTINGS} autoHideMs={0} {...props} />);
}

async function unmount() {
  if (!root) return;
  const mounted = root;
  root = null;
  await act(async () => { mounted.unmount(); });
  container.remove();
}

describe('首次安装提示条', () => {
  afterEach(async () => {
    await unmount();
    vi.useRealTimers();
  });

  it('未配置目录且没提示过 → 显示入口提示，并写入已提示标记', async () => {
    const storage = fakeStorage();
    mount({ storage });
    await flush();
    const tip = document.body.querySelector('.wst-root');
    expect(tip).toBeTruthy();
    expect(tip!.textContent).toContain('设置 → Wallpaper 壁纸');
    expect(tip!.textContent).toContain('自动探测');
    expect(storage.data[STORAGE_KEYS.setupTip]).toBe('1');
  });

  it('已配置任一目录 → 不显示，也不写标记', async () => {
    const storage = fakeStorage();
    mount({ storage, fetchSettings: async () => ({ ...SETTINGS, wallpaperDir: 'D:/Steam/...' }) });
    await flush();
    expect(document.body.querySelector('.wst-root')).toBeNull();
    expect(storage.data[STORAGE_KEYS.setupTip]).toBeUndefined();
  });

  it('已提示过（标记存在）→ 未配置也不再显示', async () => {
    const storage = fakeStorage({ [STORAGE_KEYS.setupTip]: '1' });
    mount({ storage });
    await flush();
    expect(document.body.querySelector('.wst-root')).toBeNull();
  });

  it('点「知道了」→ 关闭提示条', async () => {
    const storage = fakeStorage();
    mount({ storage });
    await flush();
    (document.body.querySelector('.wst-dismiss') as HTMLButtonElement).click();
    await flush();
    expect(document.body.querySelector('.wst-root')).toBeNull();
  });

  it('读设置失败 → 静默不显示、不抛错', async () => {
    const storage = fakeStorage();
    mount({ storage, fetchSettings: async () => { throw new Error('boom'); } });
    await flush();
    expect(document.body.querySelector('.wst-root')).toBeNull();
    expect(storage.data[STORAGE_KEYS.setupTip]).toBeUndefined();
  });

  it('到时自动消失（autoHideMs）', async () => {
    vi.useFakeTimers();
    const storage = fakeStorage();
    mount({ storage, autoHideMs: 3000 });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.body.querySelector('.wst-root')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(document.body.querySelector('.wst-root')).toBeNull();
  });
});

describe('shell.overlay 注册', () => {
  it('注册进 DSH 全框浮层：additive 的 list slot（自定义 id，不替换官方条目）', () => {
    const inject = vi.fn((_name: string, cb: () => unknown) => cb());
    const register = vi.fn((_options: unknown, _component: unknown) => 'entry');
    const ctx = { slots: { inject, register } };
    expect(registerSetupTipSlots(ctx)).toBe(true);
    expect(inject.mock.calls[0]![0]).toBe('shell.overlay');
    expect(register.mock.calls[0]![0]).toEqual({
      name: 'shell.overlay',
      id: 'wallpaper-engine-setup-tip',
      order: 30,
    });
    expect(register.mock.calls[0]![1]).toBe(SetupTip);
  });

  it('ctx 没有 slots（宿主未提供槽位）→ 跳过注册且不抛错', () => {
    expect(registerSetupTipSlots({})).toBe(false);
    expect(registerSetupTipSlots(undefined)).toBe(false);
  });
});
