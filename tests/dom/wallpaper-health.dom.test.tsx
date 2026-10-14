// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn(async () => {});
vi.mock('../../src/client/background-layer.js', () => ({
  createBackgroundLayer: () => ({ root: document.createElement('div'), setOverlayOpacity() {}, setBlur() {}, setPaused() {}, showNone() {}, showImage() {}, showVideo() {}, showWeb() {} }),
}));
vi.mock('../../src/client/wallpaper-controller.js', () => ({
  createWallpaperController: () => ({ load: async () => {}, select: selectMock, applyTextStyle() {} }),
}));
// settings-section 是 .tsx（依赖 React）：本测试只验 index.ts 的接线，把它整体替身掉
vi.mock('../../src/client/settings-section.js', () => ({
  WallpaperSettingsSection: () => null,
  setWallpaperSelectHandler: vi.fn(),
  setWallpaperRuntimeHandler: vi.fn(),
  setWallpaperHealthHandler: vi.fn(),
  notifyWallpaperHealth: vi.fn(),
}));
vi.mock('../../src/client/styles.js', () => ({ injectWallpaperStyles: vi.fn() }));
const rendererMock = vi.hoisted(() => ({
  getLastHealth: vi.fn(() => ({ wallpaperId: 'w1', ok: true, failure: null, timing: { assembleMs: 10, firstFrameMs: 20 } })),
  setOnHealth: vi.fn(),
  setPaused: vi.fn(), setQualityScale: vi.fn(), setGlow: vi.fn(), setSoundEnabled: vi.fn(), dispose: vi.fn(),
}));
// 捕获 renderer 的入参：本文件还要验证 index.ts 把**同一个** healthStore 注入了 renderer。
const rendererOpts = vi.hoisted(() => ({ value: null as { healthStore?: any } | null }));
vi.mock('../../src/client/three-renderer.js', () => ({
  createThreeSceneRenderer: (opts: { healthStore?: any }) => { rendererOpts.value = opts; return rendererMock; },
}));

import { bootstrap } from '../../src/client/index.js';
import type { HealthSnapshot } from '../../src/client/render-health.js';

const engine = () => (window as any).__wallpaperEngine;
const tick = () => new Promise((r) => setTimeout(r, 0));
const selectedIds = () => selectMock.mock.calls.map((c) => String(c[0]));

describe('window.__wallpaperEngine 看护入口', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    localStorage.clear();
    // 每个用例都从零开始：清掉上一个实例的全局登记点，否则新 mount 会先跑旧实例收尾（多一次 setOnHealth(null)）
    delete (window as any).__wallpaperEngine;
    delete (window as any).__wpEngineTeardown;
    rendererOpts.value = null;
  });
  it('health / retryLive / clearRenderFailures 都在，且 retryLive 会清记忆并重选', async () => {
    bootstrap();
    await new Promise((r) => setTimeout(r, 0));
    const api = (window as any).__wallpaperEngine;
    expect(api.health().ok).toBe(true);
    localStorage.setItem('we:renderfail:w1', JSON.stringify({ v: 1, kind: 'exception', detail: 'x', at: 1 }));
    api.clearRenderFailures();
    expect(localStorage.getItem('we:renderfail:w1')).toBeNull();
    // retryLive 只清「当前选中壁纸」的记忆 ⇒ 先选中 w1（select 同步写本实例的 settings）
    api.select('w1');
    await new Promise((r) => setTimeout(r, 0));
    localStorage.setItem('we:renderfail:w1', JSON.stringify({ v: 1, kind: 'exception', detail: 'x', at: 1 }));
    api.retryLive();
    expect(localStorage.getItem('we:renderfail:w1')).toBeNull();
  });

  it('注入 renderer 的是同一个 store：retryLive 只清当前选中壁纸的记忆并重选它', async () => {
    bootstrap();
    await tick();
    const store = rendererOpts.value?.healthStore;
    expect(store).toBeTruthy(); // 未注入 ⇒ renderer 会自建一份，面板与全局入口读到的就不是同一份记忆
    store.recordSoft('w1', 'load-error', '断流');
    store.recordSoft('w2', 'load-error', '断流');

    engine().select('w1');
    engine().retryLive();

    expect(store.snapshot('w1').failure).toBeNull();
    expect(store.snapshot('w1').ok).toBeNull(); // clear(id) 同时清掉最近一次装配结果与 timing
    expect(store.snapshot('w2').failure?.kind).toBe('load-error'); // 别的壁纸的记忆不许被顺手清掉
    expect(selectMock).toHaveBeenLastCalledWith('w1');
  });

  it('软失败冷却后自动重试一次（仅当前选中；硬失败与已切走的不重试）', async () => {
    bootstrap();
    await tick();
    const store = rendererOpts.value!.healthStore;
    const onHealth = rendererMock.setOnHealth.mock.calls[0]![0] as (s: HealthSnapshot) => void;
    expect(typeof onHealth).toBe('function');

    // 冷却闸用 store 自己的时钟：mock Date.now 让「上次软失败」看起来已过冷却。
    let fakeNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);

    engine().select('w1');
    store.recordSoft('w1', 'load-error', '断流');
    fakeNow += 5000;
    onHealth(store.snapshot('w1'));
    await tick();
    expect(selectedIds().filter((id) => id === 'w1')).toHaveLength(2); // api.select 一次 + 自动重试一次

    onHealth(store.snapshot('w1')); // 每会话每壁纸只自动重试一次
    await tick();
    expect(selectedIds().filter((id) => id === 'w1')).toHaveLength(2);

    localStorage.setItem('we:renderfail:w3', JSON.stringify({ v: 1, kind: 'no-visible-objects', detail: '', at: 1 }));
    engine().select('w3');
    onHealth(store.snapshot('w3'));
    await tick();
    expect(selectedIds().filter((id) => id === 'w3')).toHaveLength(1); // 硬失败：只有 api.select 那一次

    store.recordSoft('w2', 'load-error', '断流');
    fakeNow += 5000;
    onHealth(store.snapshot('w2')); // 当前选中是 w3 ⇒ 不许把用户拽回 w2
    await tick();
    expect(selectedIds().filter((id) => id === 'w2')).toHaveLength(0);

    nowSpy.mockRestore();
  });

  it('teardown 撤销健康订阅，且挂起的自动重试不再落到已收尾的实例上', async () => {
    bootstrap();
    await tick();
    const store = rendererOpts.value!.healthStore;
    const onHealth = rendererMock.setOnHealth.mock.calls[0]![0] as (s: HealthSnapshot) => void;

    let fakeNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    engine().select('w1');
    store.recordSoft('w1', 'load-error', '断流');
    fakeNow += 5000;
    onHealth(store.snapshot('w1')); // 排一次自动重试
    engine().teardown();
    await tick();

    expect(rendererMock.setOnHealth).toHaveBeenLastCalledWith(null); // 订阅已撤销
    expect(selectedIds().filter((id) => id === 'w1')).toHaveLength(1); // 只有 api.select，自动重试没发生
    nowSpy.mockRestore();
  });
});
