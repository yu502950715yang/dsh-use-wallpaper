import { describe, expect, it, vi, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import {
  WallpaperSettingsSection, setWallpaperRuntimeHandler, setWallpaperSelectHandler,
  setWallpaperHealthHandler, setWallpaperMediaHandler, setWallpaperMediaIntegrationHandler,
  setWallpaperReselectHandler, setWallpaperSystemAudioHandlers,
  subscribeWallpaperHealth, notifyWallpaperHealth,
} from '../../src/client/settings-section.js';
import type { ClientSettings } from '../../src/client/types.js';
import type { HealthSnapshot } from '../../src/client/render-health.js';
import type { MediaIntegrationStatus } from '../../src/shared/media.js';
import type { ProbeResult, WallpaperUserProperty } from '../../src/shared/types.js';

// 壁纸设置面板（设置对话框 "壁纸" section）：
// 网格切换 / 取消壁纸 / 路径配置（手动 + 自动探测）。数据与动作经 props 注入
// （默认走真实 API），测试只关心组件行为。

// ── 端到端接线（index.ts）的替身：面板仍是真实组件，只把渲染器/控制器/层/样式替身掉，
// 断言落在 .wss-live-status 的 textContent 上（健康事件是否真的上屏）。
const e2eSelect = vi.hoisted(() => vi.fn(async () => {}));
// controller 的列表（轮播 getPool 读它）；各用例按需填充，默认空池 ⇒ 轮播不动。
const e2eList = vi.hoisted(() => [] as any[]);
// index 的 show({kind:'video'}) 走 layer.showVideo 三态；默认 ok，失败用例按需覆盖。
const e2eVideo = vi.hoisted(() => ({
  showVideo: vi.fn(async (_url: string): Promise<'ok' | 'unsupported' | 'timeout'> => 'ok'),
}));
const e2eHealth = vi.hoisted(() => ({
  last: null as HealthSnapshot | null,
  onHealth: null as ((s: HealthSnapshot) => void) | null,
}));
vi.mock('../../src/client/background-layer.js', () => ({
  createBackgroundLayer: () => ({
    root: document.createElement('div'),
    setOverlayOpacity() {}, setBlur() {}, setPaused() {},
    setKenBurns() {}, setFitMode() {},
    showNone() {}, showImage() {}, showVideo: (url: string) => e2eVideo.showVideo(url), showWeb() {},
  }),
}));
vi.mock('../../src/client/wallpaper-controller.js', () => ({
  createWallpaperController: () => ({ load: async () => {}, select: e2eSelect, applyTextStyle() {}, getList: () => e2eList }),
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
  paused: false, pauseOnHidden: true, qualityScale: 1, soundEnabled: true, mediaIntegrationEnabled: true,
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
      fetchProperties={async () => ({ properties: [], audioProcessing: false })}
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
  // 收藏/隐藏/最近使用落 localStorage：逐用例清空，避免污染同文件后续用例。
  localStorage.clear();
  // 模块级共享 handler 随用例重置：否则上一个用例注册的那份会被下一个用例读到（顺序依赖）。
  setWallpaperHealthHandler(null);
  setWallpaperMediaHandler(null);
  setWallpaperMediaIntegrationHandler(null);
  setWallpaperSelectHandler(() => {});
  setWallpaperRuntimeHandler(() => {});
  setWallpaperReselectHandler(null);
  setWallpaperSystemAudioHandlers(null);
  vi.restoreAllMocks();
});

describe('WallpaperSettingsSection', () => {
  it('v0.9 新布局：Hero 展示当前壁纸预览、类型与渲染状态', async () => {
    mount();
    await flush();
    const hero = container.querySelector('.wss-hero') as HTMLElement | null;
    expect(hero).toBeTruthy();
    expect(hero!.querySelector('img')?.getAttribute('src')).toBe('/p1');
    expect(hero!.querySelector('.wss-current-name')?.textContent).toBe('EVA');
    expect(hero!.querySelector('.wss-type-badge')?.textContent).toBe('SCENE');
    const status = hero!.querySelector('.wss-hero-status') as HTMLElement | null;
    expect(status).toBeTruthy();
    expect(status!.getAttribute('data-tone')).toBe('idle');
  });

  it('v0.9 新布局：快捷导航 4 个锚点，点击滚动到对应分组', async () => {
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      mount();
      await flush();
      const items = [...container.querySelectorAll<HTMLElement>('.wss-nav-item')];
      expect(items.map((el) => el.textContent)).toEqual(['壁纸库', '外观', '播放', '高级']);
      expect(container.querySelector('#wss-anchor-advanced')).toBeTruthy();
      items[3]!.click();
      await flush();
      expect(scrollSpy).toHaveBeenCalledTimes(1);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('v0.9 新布局：高级设置默认折叠为 details', async () => {
    mount();
    await flush();
    const details = [...container.querySelectorAll<HTMLDetailsElement>('details.wss-details')];
    expect(details.length).toBeGreaterThanOrEqual(4);
    expect(details.every((d) => d.open === false)).toBe(true);
  });

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

  // v0.8 显示效果：遮罩/模糊/KenBurns/适配模式全部即时下发 + 持久化。
  it('显示效果：遮罩不透明度/模糊/KenBurns/适配模式变化 → 即时下发 + 持久化', async () => {
    const writeSettings = vi.fn(async () => {});
    const onRuntimeSettings = vi.fn();
    mount({ writeSettings, onRuntimeSettings });
    await flush();
    const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    };

    setValue(container.querySelector('.wss-overlay-opacity') as HTMLInputElement, '0.6');
    await flush();
    expect(onRuntimeSettings).toHaveBeenCalledWith({ overlayOpacity: 0.6 });

    (container.querySelector('.wss-blur-enabled') as HTMLInputElement).click();
    await flush();
    expect(onRuntimeSettings).toHaveBeenCalledWith({ blurEnabled: true });

    (container.querySelector('.wss-kenburns') as HTMLInputElement).click();
    await flush();
    expect(onRuntimeSettings).toHaveBeenCalledWith({ kenBurns: false });

    setValue(container.querySelector('.wss-fit-mode') as HTMLSelectElement, 'contain');
    await flush();
    expect(onRuntimeSettings).toHaveBeenCalledWith({ fitMode: 'contain' });
  });

  // v0.8 壁纸库：搜索 / 收藏 / 隐藏与恢复（localStorage 持久化；隐藏不打断播放）。
  it('壁纸库：搜索、类型筛选、收藏、隐藏/恢复', async () => {
    localStorage.clear();
    mount();
    await flush();
    const setValue = (el: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue(container.querySelector('.wss-search') as HTMLInputElement, 'A');
    await flush();
    expect(container.querySelectorAll('.wss-thumb')).toHaveLength(1);

    (container.querySelector('.wss-fav[data-id="1"]') as HTMLElement).click();
    await flush();
    (container.querySelector('.wss-fav-only') as HTMLInputElement).click();
    await flush();
    expect(container.querySelectorAll('.wss-thumb')).toHaveLength(1);

    (container.querySelector('.wss-hide[data-id="1"]') as HTMLElement).click();
    await flush();
    expect(container.querySelectorAll('.wss-thumb')).toHaveLength(0);
    (container.querySelector('.wss-show-hidden') as HTMLInputElement).click();
    await flush();
    expect(container.querySelectorAll('.wss-thumb')).toHaveLength(1);
    localStorage.clear();
  });

  it('壁纸库：收藏/隐藏按钮不触发切换壁纸（stopPropagation）', async () => {
    localStorage.clear();
    const onSelect = vi.fn();
    mount({ onSelect });
    await flush();
    (container.querySelector('.wss-fav[data-id="1"]') as HTMLElement).click();
    await flush();
    expect(onSelect).not.toHaveBeenCalled();
    expect((container.querySelector('.wss-fav[data-id="1"]') as HTMLElement).getAttribute('aria-pressed')).toBe('true');

    (container.querySelector('.wss-hide[data-id="1"]') as HTMLElement).click();
    await flush();
    expect(onSelect).not.toHaveBeenCalled(); // 隐藏只影响列表过滤，不调用 select/取消播放
    expect(container.querySelector('.wss-thumb[data-id="1"]')).toBeNull();
    expect((container.querySelector('.wss-current-name') as HTMLElement).textContent).toBe('EVA');
    localStorage.clear();
  });

  it('壁纸库：类型筛选与最近使用排序', async () => {
    localStorage.clear();
    mount();
    await flush();
    const setSelect = (el: HTMLSelectElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setSelect(container.querySelector('.wss-type-filter') as HTMLSelectElement, 'video');
    await flush();
    expect([...container.querySelectorAll<HTMLElement>('.wss-thumb')].map((el) => el.dataset.id)).toEqual(['2']);

    // 最近使用在挂载时读取：重挂载前先写 localStorage，再切 sort=recent
    await unmount();
    localStorage.setItem('we:recent', JSON.stringify({ '2': Date.now() }));
    mount();
    await flush();
    setSelect(container.querySelector('.wss-sort') as HTMLSelectElement, 'recent');
    await flush();
    expect([...container.querySelectorAll<HTMLElement>('.wss-thumb')].map((el) => el.dataset.id)).toEqual(['2', '1']);
    localStorage.clear();
  });

  it('壁纸库：默认排序下收藏置顶，取消收藏恢复原序', async () => {
    localStorage.clear();
    mount();
    await flush();
    expect([...container.querySelectorAll<HTMLElement>('.wss-thumb')].map((el) => el.dataset.id)).toEqual(['1', '2']);
    (container.querySelector('.wss-fav[data-id="2"]') as HTMLElement).click();
    await flush();
    expect([...container.querySelectorAll<HTMLElement>('.wss-thumb')].map((el) => el.dataset.id)).toEqual(['2', '1']);
    (container.querySelector('.wss-fav[data-id="2"]') as HTMLElement).click();
    await flush();
    expect([...container.querySelectorAll<HTMLElement>('.wss-thumb')].map((el) => el.dataset.id)).toEqual(['1', '2']);
    localStorage.clear();
  });

  it('壁纸库：全部隐藏且未开启显示 → 空结果文案含隐藏数量', async () => {
    localStorage.clear();
    mount();
    await flush();
    (container.querySelector('.wss-hide[data-id="1"]') as HTMLElement).click();
    await flush();
    (container.querySelector('.wss-hide[data-id="2"]') as HTMLElement).click();
    await flush();
    expect(container.querySelectorAll('.wss-thumb')).toHaveLength(0);
    expect((container.querySelector('.wss-empty') as HTMLElement).textContent).toContain('隐藏 2 张');
    localStorage.clear();
  });

  // v0.8：最近使用由 index.ts 在切换成功 / 公开 API 显示 scene 时写入。
  it('端到端：selectWallpaper 成功后与 show(scene) 都写入最近使用', async () => {
    localStorage.clear();
    e2eSelect.mockClear();
    bootstrap();
    await flush();
    mount({ onSelect: undefined, fetchSettings: async () => BASE_SETTINGS, writeSettings: async () => {} });
    await flush();
    (container.querySelectorAll('.wss-thumb')[1] as HTMLElement).click();
    await flush();
    expect(e2eSelect).toHaveBeenLastCalledWith('2');
    expect(typeof (JSON.parse(localStorage.getItem('we:recent') ?? '{}') as Record<string, unknown>)['2']).toBe('number');

    // 切到「最近使用」：重读存储后刚选中的 2 排到 1 前面
    const sort = container.querySelector('.wss-sort') as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(sort, 'recent');
    sort.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect([...container.querySelectorAll<HTMLElement>('.wss-thumb')].map((el) => el.dataset.id)).toEqual(['2', '1']);

    engine().show({ kind: 'scene', wallpaperId: 'wY' });
    await flush();
    expect(typeof (JSON.parse(localStorage.getItem('we:recent') ?? '{}') as Record<string, unknown>)['wY']).toBe('number');
    localStorage.clear();
  });
});

// v0.8 Task 8：自动轮播（开关/间隔/顺序经 applyRuntime 下发并持久化；状态行随设置与可轮播池实时更新）。
describe('自动轮播', () => {
  const rotationStatusText = () => (container.querySelector('.wss-rotation-status') as HTMLElement | null)?.textContent ?? '';
  const setSelect = (el: HTMLSelectElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('开关/间隔/顺序改完即时下发并持久化；状态行显示间隔、顺序与可轮播张数', async () => {
    const writeSettings = vi.fn(async () => {});
    const onRuntimeSettings = vi.fn();
    mount({ writeSettings, onRuntimeSettings });
    await flush();

    // 缺省 5 分钟 / 顺序 / 可轮播 2 张（WALLPAPERS 两张都不是 unknown 且未隐藏）
    expect(rotationStatusText()).toContain('每 5 分钟');
    expect(rotationStatusText()).toContain('顺序');
    expect(rotationStatusText()).toContain('可轮播 2 张');

    const enabled = container.querySelector('.wss-rotation-enabled') as HTMLInputElement;
    expect(enabled.checked).toBe(false); // 默认关闭
    enabled.click();
    await flush();
    expect(onRuntimeSettings).toHaveBeenCalledWith({ rotationEnabled: true });
    expect(writeSettings).toHaveBeenCalledWith({ rotationEnabled: true });

    const interval = container.querySelector('.wss-rotation-interval') as HTMLSelectElement;
    setSelect(interval, '600000');
    await flush();
    expect(onRuntimeSettings).toHaveBeenCalledWith({ rotationIntervalMs: 600000 });
    expect(writeSettings).toHaveBeenCalledWith({ rotationIntervalMs: 600000 });
    expect(rotationStatusText()).toContain('每 10 分钟');

    const order = container.querySelector('.wss-rotation-order') as HTMLSelectElement;
    setSelect(order, 'random');
    await flush();
    expect(onRuntimeSettings).toHaveBeenCalledWith({ rotationOrder: 'random' });
    expect(writeSettings).toHaveBeenCalledWith({ rotationOrder: 'random' });
    expect(rotationStatusText()).toContain('随机');
  });

  it('可轮播池不足 2 张时给出明确提示（隐藏/单张）', async () => {
    mount({ fetchWallpapers: async () => [WALLPAPERS[0]] as any });
    await flush();
    expect(rotationStatusText()).toBe('至少保留 2 张可轮播壁纸，或收藏 2 张以上');
    await unmount();

    mount();
    await flush();
    (container.querySelector('.wss-hide[data-id="2"]') as HTMLElement).click();
    await flush();
    expect(rotationStatusText()).toContain('至少保留 2 张可轮播壁纸，或收藏 2 张以上');
    localStorage.clear();
  });

  // 端到端：面板开启轮播 → index.ts 调度器按间隔经 selectWallpaper 切换 → teardown 停表（HMR 不留双定时器）。
  it('端到端：开启轮播后按间隔自动切换，teardown 后不再切换', async () => {
    vi.useFakeTimers();
    try {
      e2eSelect.mockClear();
      e2eList.length = 0;
      e2eList.push(...WALLPAPERS);
      bootstrap();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      mount({ onSelect: undefined, fetchSettings: async () => BASE_SETTINGS, writeSettings: async () => {} });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      // 先手动选 '1'（index 的 settings.selectedWallpaperId 只有走共享 handler 才会同步）
      (container.querySelector('.wss-thumb[data-id="1"]') as HTMLElement).click();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(e2eSelect).toHaveBeenLastCalledWith('1');

      (container.querySelector('.wss-rotation-enabled') as HTMLInputElement).click();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const before = e2eSelect.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
      expect(e2eSelect).toHaveBeenLastCalledWith('2');
      expect(e2eSelect.mock.calls.length).toBeGreaterThan(before);

      // teardown 撤掉轮播定时器：再过一个周期不得再切换
      await act(async () => { teardownEngine(); });
      const afterTeardown = e2eSelect.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
      expect(e2eSelect.mock.calls.length).toBe(afterTeardown);
    } finally {
      vi.useRealTimers();
    }
  });
});

// v0.8 视频编码兜底：失败提示只在有记录时出现，unsupported/timeout 文案区分，可清除与撤销。
describe('媒体失败提示', () => {
  it('媒体失败提示：有失败记录时显示明确文案，可清除', async () => {
    const clear = vi.fn();
    mount();
    await flush();
    await act(async () => {
      setWallpaperMediaHandler({ get: () => ({ id: 'v1', kind: 'unsupported', fallback: 'preview', at: Date.now() }), clear });
    });
    expect(container.textContent).toContain('解码失败');
    expect(container.textContent).toContain('已回退到预览图');
    expect(container.textContent).toContain('Chrome');
    const box = container.querySelector('.wss-media-failure') as HTMLElement;
    expect(box.dataset.kind).toBe('unsupported');
    await act(async () => {
      (box.querySelector('.wss-media-dismiss') as HTMLButtonElement).click();
    });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.wss-media-failure')).toBeNull();
  });

  // 无 preview 回退时（show({kind:'video'}) / 无预览图壁纸）不得谎称「已回退到预览图」。
  it('fallback=none 文案说明没有可用预览图，且不出现「已回退到预览图」', async () => {
    mount();
    await flush();
    await act(async () => {
      setWallpaperMediaHandler({ get: () => ({ id: 'v1', kind: 'unsupported', fallback: 'none', at: Date.now() }), clear: vi.fn() });
    });
    expect(container.textContent).toContain('没有可用的预览图');
    expect(container.textContent).not.toContain('已回退到预览图');
  });

  it('timeout 文案与 unsupported 区分；handler 撤销后面板回到「无失败」初始态', async () => {
    mount();
    await flush();
    await act(async () => {
      setWallpaperMediaHandler({ get: () => ({ id: 'v1', kind: 'timeout', fallback: 'preview', at: Date.now() }), clear: vi.fn() });
    });
    expect(container.textContent).toContain('超时');
    expect(container.textContent).toContain('已回退到预览图');
    expect(container.textContent).not.toContain('解码失败');
    await act(async () => { setWallpaperMediaHandler(null); });
    expect(container.querySelector('.wss-media-failure')).toBeNull();
  });

  // 端到端（index.ts）：show(video) 失败 → 面板提示；换到其它背景 → 提示随即清除。
  it('端到端：show({kind:"video"}) 解码失败上屏，换背景后清除', async () => {
    teardownEngine();
    e2eVideo.showVideo.mockResolvedValueOnce('unsupported');
    bootstrap();
    await flush();
    mount({ onSelect: undefined, fetchSettings: async () => BASE_SETTINGS, writeSettings: async () => {} });
    await flush();

    engine().show({ kind: 'video', url: '/wallpapers/media/v1/file' });
    await flush();
    // show(video) 的 plan 没有 preview：失败只能记「未回退」，不得说已回退。
    expect(container.textContent).toContain('没有可用的预览图');
    expect(container.textContent).not.toContain('已回退到预览图');

    engine().show({ kind: 'image', url: '/p1', kenBurns: true });
    await flush();
    expect(container.querySelector('.wss-media-failure')).toBeNull();
  });
});

// v0.8 Task 7：壁纸属性面板（仅选中 scene 且属性非空时渲染；布尔开关写 localStorage 后重装配）。
describe('壁纸属性（用户布尔可见性）', () => {
  const CLOUDS: WallpaperUserProperty = {
    key: 'clouds', label: '云层', type: 'bool', value: true, order: 2.5, usedBy: ['objects[].visible'],
  };
  const RAIN: WallpaperUserProperty = {
    key: 'rain', label: '雨', type: 'bool', value: true, order: 1, usedBy: ['objects[].visible'],
  };

  it('选中 scene 且属性非空 → 渲染「壁纸属性」section；存储值覆盖壁纸默认 value', async () => {
    localStorage.setItem('we:userprop:clouds', 'false');
    mount({ fetchProperties: async () => ({ properties: [CLOUDS, RAIN], audioProcessing: false }) });
    await flush();
    const boxes = [...container.querySelectorAll<HTMLInputElement>('.wss-userprop')];
    expect(boxes).toHaveLength(2);
    expect(boxes.map((b) => b.dataset.key)).toEqual(['clouds', 'rain']);
    expect(boxes[0]!.checked).toBe(false); // localStorage 覆盖默认 true
    expect(boxes[1]!.checked).toBe(true);
    expect(container.textContent).toContain('壁纸属性');
    expect(container.textContent).toContain('云层');
    expect(container.textContent).toContain('切换后生效');
    localStorage.clear();
  });

  it('切换 checkbox → 写当前壁纸的 per-id 键并触发当前壁纸重装配', async () => {
    const reselect = vi.fn();
    setWallpaperReselectHandler(reselect);
    mount({ fetchProperties: async () => ({ properties: [CLOUDS], audioProcessing: false }) });
    await flush();
    const box = container.querySelector('.wss-userprop[data-key="clouds"]') as HTMLInputElement;
    box.click();
    await flush();
    expect(localStorage.getItem('we:userprop:1:clouds')).toBe('false');
    expect(localStorage.getItem('we:userprop:clouds')).toBeNull(); // 不再写全局键
    expect(reselect).toHaveBeenCalledWith('1');
    expect(box.checked).toBe(false);
  });

  it('per-wallpaper 隔离：切到另一张同名属性的 scene 读自己的值，不串上一张的开关', async () => {
    // '1' 与 '3' 都是 scene 且都有 clouds（真实场景：EVA 与另一张都有 bool newproperty1）。
    mount({
      fetchProperties: async () => ({ properties: [CLOUDS], audioProcessing: false }),
      fetchWallpapers: async () => [
        ...WALLPAPERS,
        { id: '3', title: 'EVA 2', type: 'scene', hasScene: true, hasPreviewGif: false, previewUrl: '/p3' },
      ] as any,
    });
    await flush();
    (container.querySelector('.wss-userprop[data-key="clouds"]') as HTMLInputElement).click();
    await flush();
    expect(localStorage.getItem('we:userprop:1:clouds')).toBe('false');

    (container.querySelector('.wss-thumb[data-id="3"]') as HTMLElement).click();
    await flush();
    const box3 = container.querySelector('.wss-userprop[data-key="clouds"]') as HTMLInputElement;
    expect(box3.checked).toBe(true); // 另一张壁纸仍是自己的默认值
    box3.click();
    await flush();
    expect(localStorage.getItem('we:userprop:3:clouds')).toBe('false');
    expect(localStorage.getItem('we:userprop:1:clouds')).toBe('false'); // 互不覆盖
  });

  it('props.onReselect 优先于共享 handler', async () => {
    const shared = vi.fn();
    const prop = vi.fn();
    setWallpaperReselectHandler(shared);
    mount({ fetchProperties: async () => ({ properties: [CLOUDS], audioProcessing: false }), onReselect: prop });
    await flush();
    (container.querySelector('.wss-userprop[data-key="clouds"]') as HTMLInputElement).click();
    await flush();
    expect(prop).toHaveBeenCalledWith('1');
    expect(shared).not.toHaveBeenCalled();
  });

  it('非 scene / 空列表 / fetch 抛错 → 不渲染 section，不抛错', async () => {
    // 非 scene：selectedWallpaperId='2' 是 video，不应请求属性
    const fetchProperties = vi.fn(async () => ({ properties: [CLOUDS], audioProcessing: false }));
    mount({
      fetchSettings: async () => ({ ...BASE_SETTINGS, selectedWallpaperId: '2' }),
      fetchProperties,
    });
    await flush();
    expect(container.querySelector('.wss-userprop')).toBeNull();
    expect(fetchProperties).not.toHaveBeenCalled();
    await unmount();

    mount({ fetchProperties: async () => ({ properties: [], audioProcessing: false }) });
    await flush();
    expect(container.querySelector('.wss-userprop')).toBeNull();
    await unmount();

    mount({ fetchProperties: async () => { throw new Error('boom'); } });
    await flush();
    expect(container.querySelector('.wss-userprop')).toBeNull();
    expect(container.textContent).toContain('EVA'); // 面板其它部分正常
  });

  it('切换壁纸 → 以新 id 重新 fetch，面板内容随属性更新', async () => {
    const calls: string[] = [];
    const fetchProperties = vi.fn(async (id: string) => {
      calls.push(id);
      return { properties: id === '1' ? [CLOUDS] : [RAIN], audioProcessing: false };
    });
    mount({
      fetchProperties,
      fetchWallpapers: async () => [
        ...WALLPAPERS,
        { id: '3', title: 'EVA 2', type: 'scene', hasScene: true, hasPreviewGif: false, previewUrl: '/p3' },
      ] as any,
    });
    await flush();
    expect(calls).toEqual(['1']);
    expect(container.querySelector('.wss-userprop[data-key="clouds"]')).not.toBeNull();

    (container.querySelector('.wss-thumb[data-id="3"]') as HTMLElement).click();
    await flush();
    expect(calls).toEqual(['1', '3']);
    expect(container.querySelector('.wss-userprop[data-key="clouds"]')).toBeNull();
    expect(container.querySelector('.wss-userprop[data-key="rain"]')).not.toBeNull();
    expect(container.textContent).toContain('雨');
  });
});

// Task 7：四类型控件（bool/slider/color/combo）+ condition 禁用 + 恢复默认。
describe('壁纸属性（四类型控件）', () => {
  const BOOL: WallpaperUserProperty = {
    key: 'b', label: 'Bool 开关', type: 'bool', value: true, order: 1, usedBy: ['objects[].visible'],
  };
  const SLIDER: WallpaperUserProperty = {
    key: 's', label: 'Slider 滑杆', type: 'slider', value: 0.4, min: 0, max: 1, step: 0.01, order: 2, usedBy: ['x'],
  };
  const COLOR: WallpaperUserProperty = {
    key: 'c', label: 'Color 取色', type: 'color', value: '1 0 0', order: 3, usedBy: ['x'],
  };
  const COMBO: WallpaperUserProperty = {
    key: 'm', label: 'Combo 下拉', type: 'combo', value: '1',
    options: [{ label: 'A', value: '1' }, { label: 'B', value: '2' }], order: 4, usedBy: ['x'],
  };

  const setInput = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const setSelect = (el: HTMLSelectElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const stored = (key: string) => localStorage.getItem(`we:userprop:1:${key}`);
  const advance = async (ms: number) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  };

  it('按类型渲染控件：bool 复选框 / slider 滑杆 / color 取色 / combo 下拉', async () => {
    mount({ fetchProperties: async () => ({ properties: [BOOL, SLIDER, COLOR, COMBO], audioProcessing: false }) });
    await flush();
    const box = container.querySelector('input[type="checkbox"][data-key="b"]') as HTMLInputElement | null;
    const range = container.querySelector('input[type="range"][data-key="s"]') as HTMLInputElement | null;
    const color = container.querySelector('input[type="color"][data-key="c"]') as HTMLInputElement | null;
    const combo = container.querySelector('select[data-key="m"]') as HTMLSelectElement | null;
    expect(box).toBeTruthy();
    expect(range).toBeTruthy();
    expect(color).toBeTruthy();
    expect(combo).toBeTruthy();
    expect(box!.checked).toBe(true);
    // min/max/step 来自属性；初值来自壁纸默认值
    expect([range!.min, range!.max, range!.step, range!.value]).toEqual(['0', '1', '0.01', '0.4']);
    expect(container.querySelector('.wss-userprop-value')?.textContent).toBe('0.40'); // 无 precision 时按 step 推导
    expect(color!.value).toBe('#ff0000'); // "1 0 0"(0-1) → #rrggbb
    expect(combo!.value).toBe('1');
    expect(combo!.options[0]?.textContent).toBe('A');
    expect(container.querySelectorAll('.wss-userprop-reset')).toHaveLength(4);
  });

  it('slider 显示值按 precision/fraction 格式化', async () => {
    const precise: WallpaperUserProperty = {
      key: 's', label: 'S', type: 'slider', value: 0.4, min: 0, max: 1, step: 0.01,
      precision: 3, fraction: true, order: 1, usedBy: ['x'],
    };
    mount({ fetchProperties: async () => ({ properties: [precise], audioProcessing: false }) });
    await flush();
    expect(container.querySelector('.wss-userprop-value')?.textContent).toBe('0.400');
    await unmount();

    const whole: WallpaperUserProperty = {
      key: 'w', label: 'W', type: 'slider', value: 2.6, min: 0, max: 10, step: 0.1,
      fraction: false, order: 1, usedBy: ['x'],
    };
    mount({ fetchProperties: async () => ({ properties: [whole], audioProcessing: false }) });
    await flush();
    expect(container.querySelector('.wss-userprop-value')?.textContent).toBe('3');
  });

  it('slider/color 防抖 300ms 只提交一次；combo 立即提交', async () => {
    vi.useFakeTimers();
    try {
      const reselect = vi.fn();
      setWallpaperReselectHandler(reselect);
      mount({ fetchProperties: async () => ({ properties: [SLIDER, COLOR, COMBO], audioProcessing: false }) });
      await advance(0);

      const range = container.querySelector('input[type="range"][data-key="s"]') as HTMLInputElement;
      await act(async () => { setInput(range, '0.7'); });
      await advance(299);
      expect(stored('s')).toBeNull();
      expect(reselect).not.toHaveBeenCalled();
      await advance(1);
      expect(stored('s')).toBe(JSON.stringify(0.7));
      expect(reselect).toHaveBeenCalledTimes(1);
      expect(reselect).toHaveBeenLastCalledWith('1');

      // 连续拖动只在静止 300ms 后提交一次（最后一次的值）
      await act(async () => {
        setInput(range, '0.2');
        setInput(range, '0.3');
      });
      await advance(300);
      expect(stored('s')).toBe(JSON.stringify(0.3));
      expect(reselect).toHaveBeenCalledTimes(2);

      // color：取色器拖动连续 input，本地即时更新，但只写一次/重装配一次
      const color = container.querySelector('input[type="color"][data-key="c"]') as HTMLInputElement;
      await act(async () => {
        setInput(color, '#00ff00');
        setInput(color, '#0000ff');
        setInput(color, '#336699');
      });
      expect(color.value).toBe('#336699'); // 本地显示即时跟随
      await advance(299);
      expect(stored('c')).toBeNull();
      expect(reselect).toHaveBeenCalledTimes(2);
      await advance(1);
      expect(stored('c')).toBe(JSON.stringify('0.2 0.4 0.6'));
      expect(reselect).toHaveBeenCalledTimes(3);
      expect(reselect).toHaveBeenLastCalledWith('1');

      const combo = container.querySelector('select[data-key="m"]') as HTMLSelectElement;
      await act(async () => { setSelect(combo, '2'); });
      expect(stored('m')).toBe(JSON.stringify('2'));
      expect(reselect).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('slider/color pointerup 立即提交一次（不等防抖）', async () => {
    vi.useFakeTimers();
    try {
      const reselect = vi.fn();
      setWallpaperReselectHandler(reselect);
      mount({ fetchProperties: async () => ({ properties: [SLIDER, COLOR], audioProcessing: false }) });
      await advance(0);
      const range = container.querySelector('input[type="range"][data-key="s"]') as HTMLInputElement;
      await act(async () => {
        setInput(range, '0.6');
        range.dispatchEvent(new Event('pointerup', { bubbles: true }));
      });
      expect(stored('s')).toBe(JSON.stringify(0.6));
      expect(reselect).toHaveBeenCalledTimes(1);
      await advance(400);
      expect(reselect).toHaveBeenCalledTimes(1); // 定时器已清，不重复提交

      const color = container.querySelector('input[type="color"][data-key="c"]') as HTMLInputElement;
      await act(async () => {
        setInput(color, '#336699');
        color.dispatchEvent(new Event('pointerup', { bubbles: true }));
      });
      expect(stored('c')).toBe(JSON.stringify('0.2 0.4 0.6'));
      expect(reselect).toHaveBeenCalledTimes(2);
      await advance(400);
      expect(reselect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('切壁纸取消未提交的 color 防抖：不写回上一张', async () => {
    vi.useFakeTimers();
    try {
      const reselect = vi.fn();
      setWallpaperReselectHandler(reselect);
      mount({
        fetchProperties: async () => ({ properties: [COLOR], audioProcessing: false }),
        fetchWallpapers: async () => [
          ...WALLPAPERS,
          { id: '3', title: 'EVA 2', type: 'scene', hasScene: true, hasPreviewGif: false, previewUrl: '/p3' },
        ] as any,
      });
      await advance(0);
      const color = container.querySelector('input[type="color"][data-key="c"]') as HTMLInputElement;
      await act(async () => { setInput(color, '#00ff00'); });
      await act(async () => {
        (container.querySelector('.wss-thumb[data-id="3"]') as HTMLElement).click();
      });
      await advance(400);
      expect(localStorage.getItem('we:userprop:1:c')).toBeNull();
      expect(localStorage.getItem('we:userprop:3:c')).toBeNull();
      expect(reselect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('color 值 "r g b" ↔ #rrggbb 转换；存储值覆盖默认色', async () => {
    localStorage.setItem('we:userprop:1:c', JSON.stringify('0 0 1'));
    mount({ fetchProperties: async () => ({ properties: [COLOR], audioProcessing: false }) });
    await flush();
    const color = container.querySelector('input[type="color"][data-key="c"]') as HTMLInputElement;
    expect(color.value).toBe('#0000ff');
    // pointerup 立即 flush（防抖提交路径）
    await act(async () => {
      setInput(color, '#336699');
      color.dispatchEvent(new Event('pointerup', { bubbles: true }));
    });
    await flush();
    expect(stored('c')).toBe(JSON.stringify('0.2 0.4 0.6'));
  });

  it('condition 不满足时控件禁用并标灰；条件满足后恢复', async () => {
    const AUDIO: WallpaperUserProperty = {
      key: 'audiobar', label: '音效条', type: 'bool', value: false, order: 1, usedBy: ['x'],
    };
    const MUSIC: WallpaperUserProperty = {
      key: 'musiccolor', label: '音乐颜色', type: 'color', value: '1 0 0', order: 2, usedBy: ['x'],
      condition: 'audiobar.value==true',
    };
    mount({ fetchProperties: async () => ({ properties: [AUDIO, MUSIC], audioProcessing: false }) });
    await flush();
    const color = container.querySelector('input[type="color"][data-key="musiccolor"]') as HTMLInputElement;
    const item = color.closest('.wss-userprop-item') as HTMLElement;
    expect(color.disabled).toBe(true);
    expect(item.getAttribute('data-disabled')).toBe('true');
    expect(item.textContent).toContain('条件不满足');
    expect((item.querySelector('.wss-userprop-reset') as HTMLButtonElement).disabled).toBe(true);

    (container.querySelector('input[type="checkbox"][data-key="audiobar"]') as HTMLInputElement).click();
    await flush();
    expect(color.disabled).toBe(false);
    expect(item.getAttribute('data-disabled')).toBeNull();
    expect(item.textContent).not.toContain('条件不满足');
  });

  it('只渲染 usedBy 非空的四类型属性；text 不渲染', async () => {
    const unused: WallpaperUserProperty = {
      key: 'unused', label: '未引用', type: 'bool', value: true, order: 1, usedBy: [],
    };
    const text = {
      key: 't', label: '文本', type: 'text', value: 'x', order: 2, usedBy: ['x'],
    } as unknown as WallpaperUserProperty;
    mount({ fetchProperties: async () => ({ properties: [unused, text, BOOL], audioProcessing: false }) });
    await flush();
    expect(container.querySelectorAll('.wss-userprop-item')).toHaveLength(1);
    expect(container.querySelector('[data-key="unused"]')).toBeNull();
    expect(container.querySelector('[data-key="t"]')).toBeNull();

    await unmount();
    mount({ fetchProperties: async () => ({ properties: [unused], audioProcessing: false }) });
    await flush();
    expect(container.querySelector('.wss-userprops')).toBeNull();
  });

  it('恢复默认：删除 per-id 覆盖值、控件回默认并重装配（reset 带 selectedId）', async () => {
    const reselect = vi.fn();
    setWallpaperReselectHandler(reselect);
    localStorage.setItem('we:userprop:1:b', 'false');
    mount({ fetchProperties: async () => ({ properties: [BOOL], audioProcessing: false }) });
    await flush();
    const box = container.querySelector('input[type="checkbox"][data-key="b"]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    (container.querySelector('.wss-userprop-reset[data-key="b"]') as HTMLButtonElement).click();
    await flush();
    expect(stored('b')).toBeNull();
    expect(box.checked).toBe(true);
    expect(reselect).toHaveBeenLastCalledWith('1');
  });

  it('恢复默认会取消未提交的 slider/color 防抖（旧值不回写）', async () => {
    vi.useFakeTimers();
    try {
      const reselect = vi.fn();
      setWallpaperReselectHandler(reselect);
      mount({ fetchProperties: async () => ({ properties: [SLIDER, COLOR], audioProcessing: false }) });
      await advance(0);
      const range = container.querySelector('input[type="range"][data-key="s"]') as HTMLInputElement;
      await act(async () => { setInput(range, '0.9'); });
      await act(async () => {
        (container.querySelector('.wss-userprop-reset[data-key="s"]') as HTMLButtonElement).click();
      });
      await advance(400);
      expect(stored('s')).toBeNull();
      expect(reselect).toHaveBeenCalledTimes(1); // 只有 reset 那一次

      const color = container.querySelector('input[type="color"][data-key="c"]') as HTMLInputElement;
      await act(async () => { setInput(color, '#00ff00'); });
      await act(async () => {
        (container.querySelector('.wss-userprop-reset[data-key="c"]') as HTMLButtonElement).click();
      });
      await advance(400);
      expect(stored('c')).toBeNull();
      expect(reselect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('卸载时清理防抖定时器：不再写值/重装配', async () => {
    vi.useFakeTimers();
    try {
      const reselect = vi.fn();
      setWallpaperReselectHandler(reselect);
      mount({ fetchProperties: async () => ({ properties: [SLIDER, COLOR], audioProcessing: false }) });
      await advance(0);
      const range = container.querySelector('input[type="range"][data-key="s"]') as HTMLInputElement;
      const color = container.querySelector('input[type="color"][data-key="c"]') as HTMLInputElement;
      await act(async () => {
        setInput(range, '0.8');
        setInput(color, '#00ff00');
      });
      await unmount();
      await advance(400);
      expect(stored('s')).toBeNull();
      expect(stored('c')).toBeNull();
      expect(reselect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('媒体集成状态行（B1）', () => {
  const statusEl = () => container.querySelector('.wss-media-status') as HTMLElement | null;

  it('开关在「显示效果」组；未注册 handler 时显示隐私说明（不显示曲目）', async () => {
    mount();
    await flush();
    const appearance = container.querySelector('#wss-anchor-appearance') as HTMLElement | null;
    expect(appearance).toBeTruthy();
    const box = appearance!.querySelector('.wss-media-integration') as HTMLInputElement | null;
    expect(box).toBeTruthy();
    expect(box!.checked).toBe(true);
    // 原「性能与省电」卡片不再承载媒体开关（spec §4.5 / TESTING M6 的入口路径）。
    expect(container.querySelector('.wss-sound-row .wss-media-integration')).toBeNull();
    const text = statusEl()!.textContent ?? '';
    expect(text).toContain('仅 Windows');
    expect(text).toContain('不落盘、不上传');
  });

  it('状态行文案随 getMediaStatus.reason 变化（unsupported-platform / no-powershell / watcher-failed / ok）', async () => {
    let status: MediaIntegrationStatus = { available: false, reason: 'unsupported-platform', enabled: true };
    setWallpaperMediaIntegrationHandler({ get: () => status });
    mount();
    await flush();
    expect(statusEl()!.textContent).toContain('不支持系统媒体会话');
    expect(statusEl()!.dataset.state).toBe('unsupported-platform');
    await act(async () => {
      status = { ...status, reason: 'no-powershell' };
      await new Promise((r) => setTimeout(r, 1100)); // 状态读取 = 1s 轮询
    });
    expect(statusEl()!.textContent).toContain('PowerShell');
    await act(async () => {
      status = { ...status, reason: 'watcher-failed' };
      await new Promise((r) => setTimeout(r, 1100));
    });
    expect(statusEl()!.textContent).toContain('读取失败');
    await act(async () => {
      status = { available: true, reason: 'ok', enabled: true };
      await new Promise((r) => setTimeout(r, 1100));
    });
    expect(statusEl()!.textContent).toContain('不落盘、不上传');
    expect(statusEl()!.dataset.state).toBe('ok');
  });

  it('关闭开关 → 状态行变「已关闭」且 data-state=disabled', async () => {
    setWallpaperMediaIntegrationHandler({ get: () => ({ available: false, reason: 'no-session', enabled: true }) });
    mount();
    await flush();
    const box = container.querySelector('.wss-media-integration') as HTMLInputElement;
    await act(async () => { box.click(); });
    expect(box.checked).toBe(false);
    expect(statusEl()!.textContent).toContain('已关闭');
    expect(statusEl()!.dataset.state).toBe('disabled');
  });
});


describe('系统音频入口（v0.9 P1）', () => {
  const BOOL_PROP: WallpaperUserProperty = {
    key: 'clouds', label: '云层', type: 'bool', value: true, order: 2.5, usedBy: ['objects[].visible'],
  };
  it('audioProcessing=true 时显示启用按钮；失败码回显；成功后切到停止', async () => {
    const start = vi.fn(async (): Promise<'ok' | 'denied'> => 'denied');
    const stop = vi.fn();
    setWallpaperSystemAudioHandlers({ start, stop });
    mount({ fetchProperties: async () => ({ properties: [BOOL_PROP], audioProcessing: true }) });
    await flush();
    const btn = container.querySelector('.wss-sysaudio-start') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(container.textContent).toContain('系统音频');
    expect(container.textContent).toContain('桌面版 App');
    btn!.click();
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('未授权');
    // 成功后按钮切「停止」，点击停止调用 handler
    start.mockResolvedValueOnce('ok');
    btn!.click();
    await flush();
    const stopBtn = container.querySelector('.wss-sysaudio-stop') as HTMLButtonElement | null;
    expect(stopBtn).not.toBeNull();
    stopBtn!.click();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('audioProcessing=false → 不渲染系统音频 section', async () => {
    mount({ fetchProperties: async () => ({ properties: [BOOL_PROP], audioProcessing: false }) });
    await flush();
    expect(container.querySelector('.wss-sysaudio')).toBeNull();
  });
});
