// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// I5：teardown 之后，面板仍持有旧的共享 handler（React 组件不会因插件收尾自动卸载）。
// 这些 handler 必须失效：不得重新启动轮播定时器、不得再驱动 controller.select，
// 且 teardown 应主动把共享 handler 注销（传 null），面板回到初始态。
//
// 只验 index.ts 的接线，外围模块全部替身：轮播调度器用 mock 计数（能直接观察 start 是否被再次调用）。

const selectMock = vi.fn(async () => {});
const list = vi.hoisted(() => [] as any[]);
const rotation = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), setConfig: vi.fn(), setPaused: vi.fn(),
  notifyManualSelect: vi.fn(), markFailed: vi.fn(),
  status: vi.fn(() => ({ enabled: false, poolSize: 0, nextInMs: null })),
}));
const handlers = vi.hoisted(() => ({
  runtime: null as ((patch: any) => void) | null,
  select: null as ((id: string) => void) | null,
  reselect: null as ((id: string) => void) | null,
}));

vi.mock('../../src/client/background-layer.js', () => ({
  createBackgroundLayer: () => ({
    root: document.createElement('div'),
    setOverlayOpacity() {}, setBlur() {}, setPaused() {}, setKenBurns() {}, setFitMode() {},
    showNone() {}, showImage() {}, showVideo: async () => 'ok', showWeb() {},
  }),
}));
vi.mock('../../src/client/wallpaper-controller.js', () => ({
  createWallpaperController: () => ({
    load: async () => list,
    select: selectMock,
    applyTextStyle() {},
    getList: () => list,
  }),
}));
vi.mock('../../src/client/rotation.js', () => ({
  buildRotationPool: () => [],
  createRotationScheduler: () => rotation,
  normalizeRotationOrder: () => 'sequential',
}));
vi.mock('../../src/client/three-renderer.js', () => ({
  createThreeSceneRenderer: () => ({
    getLastHealth: () => null, setOnHealth() {}, setPaused() {}, setQualityScale() {},
    setGlow() {}, setSoundEnabled() {}, dispose() {},
  }),
}));
vi.mock('../../src/client/styles.js', () => ({ injectWallpaperStyles: vi.fn() }));
vi.mock('../../src/client/settings-section.js', () => ({
  WallpaperSettingsSection: () => null,
  setWallpaperSelectHandler: vi.fn((fn: any) => { handlers.select = fn; }),
  setWallpaperRuntimeHandler: vi.fn((fn: any) => { handlers.runtime = fn; }),
  setWallpaperHealthHandler: vi.fn(),
  setWallpaperMediaHandler: vi.fn(),
  setWallpaperMediaIntegrationHandler: vi.fn(),
  setWallpaperReselectHandler: vi.fn((fn: any) => { handlers.reselect = fn; }),
  setWallpaperSystemAudioHandlers: vi.fn(),
  notifyWallpaperHealth: vi.fn(),
  notifyWallpaperMedia: vi.fn(),
}));

import { bootstrap } from '../../src/client/index.js';
import {
  setWallpaperHealthHandler, setWallpaperMediaHandler, setWallpaperReselectHandler,
  setWallpaperRuntimeHandler, setWallpaperSelectHandler,
} from '../../src/client/settings-section.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

function settingsCtx(value: Record<string, unknown>) {
  return {
    remote: {
      settings: {
        describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'wallpaper-engine', value }] } }),
        update: async () => ({}),
      },
    },
  };
}

afterEach(() => {
  const api = (window as any).__wallpaperEngine;
  try { api?.teardown?.(); } catch { /* 已收尾 */ }
  delete (window as any).__wallpaperEngine;
  delete (window as any).__wpEngineTeardown;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  handlers.runtime = null;
  handlers.select = null;
  handlers.reselect = null;
});

describe('teardown 后共享 handler 失效', () => {
  it('旧 runtime handler 不得重启轮播；旧 select handler 不得驱动 controller', async () => {
    bootstrap(settingsCtx({ rotationEnabled: true }));
    await tick();
    expect(rotation.start).toHaveBeenCalledTimes(1); // 读回设置后启动
    const staleRuntime = handlers.runtime!;
    const staleSelect = handlers.select!;
    const staleReselect = handlers.reselect!;
    expect(typeof staleRuntime).toBe('function');

    (window as any).__wallpaperEngine.teardown();
    expect(rotation.stop).toHaveBeenCalled();
    rotation.start.mockClear();
    selectMock.mockClear();

    // 面板仍开着 ⇒ 仍可能回调旧 handler（组件没卸载、订阅对象已换 null）
    staleRuntime({ rotationEnabled: true });
    staleSelect('w1');
    staleReselect('w1');
    await tick();

    expect(rotation.start).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
    // teardown 主动注销共享 handler（面板回初始态，不再指向已释放实例）
    expect(vi.mocked(setWallpaperRuntimeHandler)).toHaveBeenLastCalledWith(null);
    expect(vi.mocked(setWallpaperSelectHandler)).toHaveBeenLastCalledWith(null);
    expect(vi.mocked(setWallpaperHealthHandler)).toHaveBeenLastCalledWith(null);
    expect(vi.mocked(setWallpaperMediaHandler)).toHaveBeenLastCalledWith(null);
    expect(vi.mocked(setWallpaperReselectHandler)).toHaveBeenLastCalledWith(null);
  });

  it('teardown 后 visibilitychange 也不得重启轮播', async () => {
    bootstrap(settingsCtx({ rotationEnabled: true }));
    await tick();
    (window as any).__wallpaperEngine.teardown();
    rotation.start.mockClear();

    document.dispatchEvent(new Event('visibilitychange'));
    await tick();
    expect(rotation.start).not.toHaveBeenCalled();
  });
});
