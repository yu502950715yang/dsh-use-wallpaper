import { describe, expect, it, vi, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import {
  WallpaperSettingsSection, setWallpaperRuntimeHandler, setWallpaperSelectHandler,
  setWallpaperHealthHandler, subscribeWallpaperHealth, notifyWallpaperHealth,
} from '../../src/client/settings-section.js';
import type { ClientSettings } from '../../src/client/types.js';
import type { HealthSnapshot } from '../../src/client/render-health.js';
import type { ProbeResult } from '../../src/shared/types.js';

// 壁纸设置面板（设置对话框 "壁纸" section）：
// 网格切换 / 取消壁纸 / 路径配置（手动 + 自动探测）。数据与动作经 props 注入
// （默认走真实 API），测试只关心组件行为。

// ── 端到端接线（index.ts）的替身：面板仍是真实组件，只把渲染器/控制器/层/样式替身掉，
// 断言落在 .wss-live-status 的 textContent 上（健康事件是否真的上屏）。
const e2eSelect = vi.hoisted(() => vi.fn(async () => {}));
const e2eHealth = vi.hoisted(() => ({
  last: null as HealthSnapshot | null,
  onHealth: null as ((s: HealthSnapshot) => void) | null,
}));
vi.mock('../../src/client/background-layer.js', () => ({
  createBackgroundLayer: () => ({
    root: document.createElement('div'),
    setOverlayOpacity() {}, setBlur() {}, setPaused() {},
    showNone() {}, showImage() {}, showVideo() {}, showWeb() {},
  }),
}));
vi.mock('../../src/client/wallpaper-controller.js', () => ({
  createWallpaperController: () => ({ load: async () => {}, select: e2eSelect, applyTextStyle() {} }),
}));
vi.mock('../../src/client/styles.js', () => ({ injectWallpaperStyles: vi.fn() }));
vi.mock('../../src/client/three-renderer.js', () => ({
  createThreeSceneRenderer: () => ({
    getLastHealth: () => e2eHealth.last,
    setOnHealth: (fn: ((s: HealthSnapshot) => void) | null) => { e2eHealth.onHealth = fn; },
    setPaused() {}, setQualityScale() {}, setGlow() {}, setSoundEnabled() {}, dispose() {},
  }),
}));

import { bootstrap } from '../../src/client/index.js';

const BASE_SETTINGS: ClientSettings = {
  selectedWallpaperId: '1', wallpaperDir: '', weAssetsDir: '',
  overlayOpacity: 0.35, blurEnabled: false, blurRadius: 12, kenBurns: true,
  glowEnabled: true, glowThreshold: 0.65, glowStrength: 0.35,
  paused: false, pauseOnHidden: true, qualityScale: 1, soundEnabled: true,
  textColorMode: 'auto', textColor: '#ffffff', textOutline: 0,
  fitMode: 'cover', rotationEnabled: false, rotationIntervalMs: 300000,
  rotationOrder: 'sequential', frameCacheEnabled: true,
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
// null = 已卸载：用例内可能自行 unmount（验退订），afterEach 的第二次卸载不得再打同一个 root。
let root: Root | null = null;

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
  if (!root) return;
  const mounted = root;
  root = null;
  await act(async () => { mounted.unmount(); });
  container.remove();
}

// 收尾本用例启动的 index.ts 实例（否则下一个用例的 bootstrap 会先跑旧实例收尾）。
function teardownEngine() {
  const api = (window as any).__wallpaperEngine;
  try { api?.teardown?.(); } catch { /* 已收尾 */ }
  delete (window as any).__wallpaperEngine;
  delete (window as any).__wpEngineTeardown;
}

const engine = () => (window as any).__wallpaperEngine;
const statusText = () => (container.querySelector('.wss-live-status') as HTMLElement | null)?.textContent ?? '';

afterEach(async () => {
  await unmount();
  teardownEngine();
  // 模块级共享 handler 随用例重置：否则上一个用例注册的那份会被下一个用例读到（顺序依赖）。
  setWallpaperHealthHandler(null);
  setWallpaperSelectHandler(() => {});
  setWallpaperRuntimeHandler(() => {});
  vi.restoreAllMocks();
});

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

  // 0.1.7 迁移后写入可能被服务端拒（settings/rejected）；面板不得谎报「已保存」。
  it('保存失败（写入返回 false）→ 提示失败，不显示已保存', async () => {
    const writeSettings = vi.fn(async () => false);
    mount({ writeSettings });
    await flush();
    (container.querySelector('.wss-save-dirs') as HTMLElement).click();
    await flush();
    const message = container.querySelector('.wss-message')?.textContent ?? '';
    expect(message).not.toContain('路径已保存');
    expect(message).toContain('保存失败');
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

  // 音频开关（2026-09-25）：默认开启（与桌面 WE 一致）；关掉后不播放壁纸音效，频谱效果也保持静止。
  it('音效开关：默认勾选 → 关闭时即时下发 + 持久化 soundEnabled=false', async () => {
    const writeSettings = vi.fn(async () => {});
    const onRuntimeSettings = vi.fn();
    mount({ writeSettings, onRuntimeSettings });
    await flush();

    const box = container.querySelector('.wss-sound') as HTMLInputElement;
    expect(box).toBeTruthy();
    expect(box.checked).toBe(true); // 缺省开启
    box.click();
    await flush();
    expect(onRuntimeSettings).toHaveBeenCalledWith({ soundEnabled: false });
    expect(writeSettings).toHaveBeenCalledWith({ soundEnabled: false });
  });

  // 视觉重构（2026-09-25）：选中态与滑杆值有了自己的 DOM 钩子（行为契约不变）。
  it('选中卡片渲染 ✓ 角标；未选中项没有', async () => {
    mount();
    await flush();
    const thumbs = container.querySelectorAll('.wss-thumb');
    expect(thumbs[0]!.querySelector('.wss-check')).toBeTruthy();
    expect(thumbs[1]!.querySelector('.wss-check')).toBeNull();
  });

  it('滑杆值以独立 badge 显示，拖动后实时更新', async () => {
    mount();
    await flush();
    let vals = container.querySelectorAll('.wss-value');
    // 2026-10-01：新增「文字描边」滑杆 → badge 变为 3 个（阈值 / 强度 / 描边档位）
    expect(vals.length).toBe(3);
    expect(vals[0]!.textContent).toBe('0.65');
    expect(vals[1]!.textContent).toBe('0.35');
    expect(vals[2]!.textContent).toBe('关');

    const th = container.querySelector('.wss-glow-threshold') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(th, '0.5');
    th.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    vals = container.querySelectorAll('.wss-value');
    expect(vals[0]!.textContent).toBe('0.50');
  });

  // 文字可读性（2026-10-01，用户报告「某些壁纸文字看不清」）：设置面板手动指定文字颜色
  // （自动/白/黑/自定义）与描边档位。改动经 onRuntimeSettings 立即下发（index.ts 转给
  // controller.applyTextStyle），同时持久化——不必重选壁纸。
  it('文字可读性：默认自动档 + 描边关；切模式与拖描边立即下发并持久化', async () => {
    const onRuntimeSettings = vi.fn();
    const writeSettings = vi.fn(async () => {});
    mount({ onRuntimeSettings, writeSettings });
    await flush();
    const mode = container.querySelector('.wss-textcolor-mode') as HTMLSelectElement;
    expect(mode.value).toBe('auto');
    expect((container.querySelector('.wss-textcolor-outline') as HTMLInputElement).value).toBe('0');

    mode.value = 'white';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onRuntimeSettings).toHaveBeenCalledWith({ textColorMode: 'white' });
    expect(writeSettings).toHaveBeenCalledWith({ textColorMode: 'white' });

    const outline = container.querySelector('.wss-textcolor-outline') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(outline, '2');
    outline.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(onRuntimeSettings).toHaveBeenCalledWith({ textOutline: 2 });
    expect(container.querySelectorAll('.wss-value')[2]!.textContent).toBe('中');
  });

  it('文字可读性：仅「自定义」档渲染取色器，改色立即下发', async () => {
    const onRuntimeSettings = vi.fn();
    mount({ onRuntimeSettings, fetchSettings: async () => ({ ...BASE_SETTINGS, textColorMode: 'custom', textColor: '#123456' }) });
    await flush();
    const color = container.querySelector('.wss-textcolor-custom') as HTMLInputElement;
    expect(color).toBeTruthy();
    expect(color.value).toBe('#123456');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(color, '#00ff00');
    color.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onRuntimeSettings).toHaveBeenCalledWith({ textColor: '#00ff00' });
  });

  it('文字可读性：非自定义档不渲染取色器', async () => {
    mount();
    await flush();
    expect(container.querySelector('.wss-textcolor-custom')).toBeNull();
  });

  // Task 4：实时渲染卡片（状态行 + 重试/清除入口）。状态行要同时讲「现在怎么样」与
  // 「曾经失败过什么」—— ok 与 failure 可并存，只按其中一个渲染会自相矛盾。
  it('实时渲染卡片：三态状态行 + 两个按钮回调', async () => {
    const onRetryLive = vi.fn();
    const onClearRenderFailures = vi.fn();
    mount({
      ...BASE_SETTINGS,
      health: { wallpaperId: 'w1', ok: false, failure: { kind: 'no-visible-objects', hard: true, at: 1, detail: '' }, timing: { assembleMs: 120, firstFrameMs: -1 } },
      onRetryLive,
      onClearRenderFailures,
    } as any);
    await flush(); // createRoot 的首次渲染在 act 排队里，须等它落地再查 DOM
    const status = container.querySelector('.wss-live-status');
    expect(status?.textContent).toContain('没有可显示的对象');
    expect((status as HTMLElement).dataset.state).toBe('failed'); // 主行即失败文案 ⇒ 失败态
    // 首帧未出（firstFrameMs = -1）时不渲染该字段：初值进文案就是「首帧 -1 ms」。
    expect(status?.textContent).not.toContain('首帧');
    expect(status?.textContent).not.toContain('-1');
    expect(container.querySelector('.wss-live-memory')).toBeNull(); // 只有一条失败事实，不重复两行
    await act(async () => { (container.querySelector('.wss-live-retry') as HTMLButtonElement).click(); });
    expect(onRetryLive).toHaveBeenCalledTimes(1);
    await act(async () => { (container.querySelector('.wss-live-forget') as HTMLButtonElement).click(); });
    expect(onClearRenderFailures).toHaveBeenCalledTimes(1);
  });

  it('未渲染时不显示失败文案', async () => {
    mount({ ...BASE_SETTINGS, health: { wallpaperId: 'w1', ok: null, failure: null, timing: null } } as any);
    await flush();
    expect(container.querySelector('.wss-live-status')?.textContent).toContain('尚未渲染');
  });

  it('实时渲染卡片：现在正常但曾失败过 ⇒ 两件事都要显示（成功不被失败记忆顶掉）', async () => {
    mount({
      ...BASE_SETTINGS,
      health: {
        wallpaperId: 'w1', ok: true, timing: { assembleMs: 120, firstFrameMs: 480 },
        failure: { kind: 'context-lost', hard: true, at: 1, detail: '' },
      },
    } as any);
    await flush();
    const status = container.querySelector('.wss-live-status') as HTMLElement;
    expect(status.textContent).toContain('实时渲染正常');
    expect(status.textContent).toContain('装配 120 ms');
    expect(status.textContent).toContain('首帧 480 ms');
    expect(status.textContent).toContain('WebGL 上下文丢失');
    expect(status.textContent).toContain('（已记忆）');
    // 主行是「现在」的状态：不能让失败记忆把正常态标成失败
    expect(status.dataset.state).toBe('ok');
    expect((container.querySelector('.wss-live-memory') as HTMLElement).textContent).toContain('上次失败');
  });

  it('实时渲染卡片：正常态只有主行（无失败记忆行）', async () => {
    mount({ ...BASE_SETTINGS, health: { wallpaperId: 'w1', ok: true, failure: null, timing: { assembleMs: 88, firstFrameMs: 210 } } } as any);
    await flush();
    const status = container.querySelector('.wss-live-status') as HTMLElement;
    expect(status.textContent).toContain('实时渲染正常');
    expect(status.textContent).toContain('装配 88 ms');
    expect(status.textContent).toContain('首帧 210 ms');
    expect(status.dataset.state).toBe('ok');
    expect(container.querySelector('.wss-live-memory')).toBeNull();
  });

  it('实时渲染卡片：没有 props 时走共享 handler（订阅推送 + 两入口兜底 + 卸载退订）', async () => {
    const retry = vi.fn();
    const clearFailures = vi.fn();
    setWallpaperHealthHandler({ get: () => null, retry, clearFailures });
    mount();
    await flush();
    expect((container.querySelector('.wss-live-status') as HTMLElement).textContent).toContain('尚未渲染');

    await act(async () => {
      notifyWallpaperHealth({ wallpaperId: 'w9', ok: true, failure: null, timing: { assembleMs: 10, firstFrameMs: 20 } });
    });
    expect((container.querySelector('.wss-live-status') as HTMLElement).textContent).toContain('实时渲染正常');

    await act(async () => { (container.querySelector('.wss-live-retry') as HTMLButtonElement).click(); });
    await act(async () => { (container.querySelector('.wss-live-forget') as HTMLButtonElement).click(); });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(clearFailures).toHaveBeenCalledTimes(1);
    expect((container.querySelector('.wss-message') as HTMLElement).textContent).toContain('已清除失败记忆');

    // 卸载后推送不得再落到已卸载的组件上（订阅已退订 ⇒ 不触发状态更新）
    await unmount();
    expect(() => notifyWallpaperHealth(null)).not.toThrow();
  });

  it('共享订阅入口：退订后不再收到推送', async () => {
    const seen: (HealthSnapshot | null)[] = [];
    const off = subscribeWallpaperHealth((s) => seen.push(s));
    notifyWallpaperHealth({ wallpaperId: 'w1', ok: true, failure: null, timing: null });
    expect(seen).toHaveLength(1);
    off();
    notifyWallpaperHealth(null);
    expect(seen).toHaveLength(1); // 已退订 ⇒ 不再收到
  });

  // fix round 1（Important）：切走之后旧壁纸迟到的健康事件不得覆盖面板 —— 面板常驻显示
  // 已被取代壁纸的状态时，get() 已是 null，失败文案对应的「重试」还会作用到另一张壁纸。
  it('端到端：切走后迟到的旧壁纸失败事件不覆盖面板（只有当前选中壁纸的状态上屏）', async () => {
    e2eHealth.last = null;
    e2eHealth.onHealth = null;
    e2eSelect.mockClear();
    bootstrap();
    await flush(); // 启动异步读设置先落地，否则本次驱动会被这一次读回覆盖
    const onHealth = e2eHealth.onHealth!;
    // onSelect: undefined 必须显式给：mount 的默认 props 里注入了 noop onSelect，
    // 不给它就永远走不到 index.ts 注册的共享 handler（这条用例要验的正是那条路径）。
    mount({ onSelect: undefined, fetchSettings: async () => BASE_SETTINGS, writeSettings: async () => {} });
    await flush();

    // 选中 '1'（scene）后它的正常状态上屏
    (container.querySelectorAll('.wss-thumb')[0] as HTMLElement).click();
    await flush();
    expect(e2eSelect).toHaveBeenLastCalledWith('1');
    e2eHealth.last = { wallpaperId: '1', ok: true, failure: null, timing: { assembleMs: 30, firstFrameMs: 60 } };
    onHealth(e2eHealth.last);
    await flush();
    expect(statusText()).toContain('实时渲染正常');

    // 切到 '2'（视频）：选中项已不是 '1'
    (container.querySelectorAll('.wss-thumb')[1] as HTMLElement).click();
    await flush();
    expect(e2eSelect).toHaveBeenLastCalledWith('2');
    expect(statusText()).not.toContain('实时渲染正常'); // 换壁纸即刷新状态行（选中项变了）

    // '1' 迟到的硬失败：面板不得显示它的失败文案
    onHealth({ wallpaperId: '1', ok: false, timing: null, failure: { kind: 'no-visible-objects', hard: true, at: 1, detail: '' } });
    await flush();
    expect(statusText()).not.toContain('没有可显示的对象');
    expect(statusText()).toContain('尚未渲染');
  });

  // fix round 1（Important）：公开 API 换壁纸也要同步选中项，否则新守卫会把真实显示中的
  // 壁纸状态挡掉（settings 还是旧值）。
  it('端到端：__wallpaperEngine.select 与 show(scene) 之后，该壁纸的健康状态能上屏', async () => {
    e2eHealth.last = null;
    e2eHealth.onHealth = null;
    e2eSelect.mockClear();
    bootstrap();
    await flush();
    const onHealth = e2eHealth.onHealth!;
    mount({ onSelect: undefined, fetchSettings: async () => BASE_SETTINGS, writeSettings: async () => {} });
    await flush();

    engine().select('wX');
    await flush();
    onHealth({ wallpaperId: 'wX', ok: true, failure: null, timing: { assembleMs: 11, firstFrameMs: 22 } });
    await flush();
    expect(statusText()).toContain('实时渲染正常');
    expect(statusText()).toContain('装配 11 ms');

    engine().show({ kind: 'scene', wallpaperId: 'wY' }); // 公开 API 的 scene 路径
    await flush();
    expect(e2eSelect).toHaveBeenLastCalledWith('wY');
    onHealth({ wallpaperId: 'wY', ok: true, failure: null, timing: { assembleMs: 33, firstFrameMs: 44 } });
    await flush();
    expect(statusText()).toContain('装配 33 ms');
  });

  // G：首帧未出时只有装配耗时（暂停态下 firstFrameMs 会长期是 -1）。
  it('实时渲染卡片：首帧未出（-1）不显示首帧字段，装配耗时照常', async () => {
    mount({
      ...BASE_SETTINGS,
      health: { wallpaperId: 'w1', ok: true, failure: null, timing: { assembleMs: 120, firstFrameMs: -1 } },
    } as any);
    await flush();
    const text = statusText();
    expect(text).toContain('实时渲染正常');
    expect(text).toContain('装配 120 ms');
    expect(text).not.toContain('首帧');
    expect(text).not.toContain('-1');
  });

  // Important 3：非 scene 分支（image/video/web/none）不解绑选中项时，上一张 scene 的状态会**持续**
  // 挂在面板上，且「重试实时渲染」会把用户刚换掉的那张 scene 选回来。
  it('端到端：show({kind:"none"}) 之后上一张 scene 的迟到健康事件不得上屏、重试不得把它选回来', async () => {
    e2eHealth.last = null;
    e2eHealth.onHealth = null;
    e2eSelect.mockClear();
    bootstrap();
    await flush();
    const onHealth = e2eHealth.onHealth!;
    mount({ onSelect: undefined, fetchSettings: async () => BASE_SETTINGS, writeSettings: async () => {} });
    await flush();

    engine().select('w1');
    await flush();
    onHealth({ wallpaperId: 'w1', ok: true, failure: null, timing: { assembleMs: 11, firstFrameMs: 22 } });
    await flush();
    expect(statusText()).toContain('实时渲染正常');

    engine().show({ kind: 'none' }); // 公开 API 的非 scene 分支：必须同步解绑选中项
    await flush();
    expect(engine().health()).toBeNull();
    expect(statusText()).toContain('尚未渲染');

    const callsBeforeRetry = e2eSelect.mock.calls.length;
    await act(async () => { (container.querySelector('.wss-live-retry') as HTMLButtonElement).click(); });
    expect(e2eSelect.mock.calls.length).toBe(callsBeforeRetry); // 不得把刚换掉的 scene 选回来

    // 上一张 scene 迟到的失败打点不得上屏
    onHealth({ wallpaperId: 'w1', ok: false, timing: null, failure: { kind: 'no-visible-objects', hard: true, at: 1, detail: '' } });
    await flush();
    expect(statusText()).not.toContain('没有可显示的对象');
    expect(statusText()).toContain('尚未渲染');
  });
});
