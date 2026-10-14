// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
// 假时钟下等「启动期异步读设置」落地：它 resolve 后会把 settings 覆盖为已保存值，
// 必须发生在驱动选中项之前，否则断言看到的选中项会被这次异步读清掉。
const boot = () => vi.advanceTimersByTimeAsync(0);
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
  afterEach(() => { vi.useRealTimers(); });
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

  it('软失败冷却到期后恰好自动重试一次；再推进时间不再重试', async () => {
    vi.useFakeTimers(); // 用假时钟推进真实定时器，不用 mock Date.now 伪造「冷却已过」
    bootstrap();
    await boot();
    const store = rendererOpts.value!.healthStore;
    const onHealth = rendererMock.setOnHealth.mock.calls[0]![0] as (s: HealthSnapshot) => void;
    expect(typeof onHealth).toBe('function');

    engine().select('w1');
    store.recordSoft('w1', 'load-error', '断流');
    onHealth(store.snapshot('w1'));

    await vi.advanceTimersByTimeAsync(2000);
    expect(selectedIds().filter((id) => id === 'w1')).toHaveLength(1); // 冷却未到 ⇒ 不重选

    await vi.advanceTimersByTimeAsync(1000);
    expect(selectedIds().filter((id) => id === 'w1')).toHaveLength(2); // 冷却到期 ⇒ 恰好一次
    expect(selectMock).toHaveBeenLastCalledWith('w1');

    await vi.advanceTimersByTimeAsync(10000); // 每会话每壁纸一次：闸已用过，不再重试
    expect(selectedIds().filter((id) => id === 'w1')).toHaveLength(2);
  });

  it('冷却到期前用户已切走 ⇒ 不把用户拽回旧壁纸', async () => {
    vi.useFakeTimers();
    bootstrap();
    await boot();
    const store = rendererOpts.value!.healthStore;
    const onHealth = rendererMock.setOnHealth.mock.calls[0]![0] as (s: HealthSnapshot) => void;

    engine().select('w1');
    store.recordSoft('w1', 'load-error', '断流');
    onHealth(store.snapshot('w1')); // 排一次 w1 的重试

    engine().select('w3'); // 冷却未到就切走
    await vi.advanceTimersByTimeAsync(5000);

    expect(selectedIds().filter((id) => id === 'w1')).toHaveLength(1); // 只有 api.select，没有自动重试
    expect(selectMock).toHaveBeenLastCalledWith('w3');
  });

  it('软失败之后已成功渲染 ⇒ 不重试', async () => {
    vi.useFakeTimers();
    bootstrap();
    await boot();
    const store = rendererOpts.value!.healthStore;
    const onHealth = rendererMock.setOnHealth.mock.calls[0]![0] as (s: HealthSnapshot) => void;

    engine().select('w1');
    store.recordSoft('w1', 'load-error', '断流');
    onHealth(store.snapshot('w1')); // 排一次重试

    store.recordOk('w1', { assembleMs: 10, firstFrameMs: 20 }); // 成功会清掉软失败
    await vi.advanceTimersByTimeAsync(5000);

    expect(selectedIds().filter((id) => id === 'w1')).toHaveLength(1);
    expect(store.snapshot('w1').failure).toBeNull();
    expect(store.snapshot('w1').ok).toBe(true); // ok 与 failure 可并存，这里软失败已被成功清掉
  });

  it('硬失败不排自动重试', async () => {
    vi.useFakeTimers();
    bootstrap();
    await boot();
    const store = rendererOpts.value!.healthStore;
    const onHealth = rendererMock.setOnHealth.mock.calls[0]![0] as (s: HealthSnapshot) => void;

    engine().select('w3');
    store.recordHard('w3', 'no-visible-objects', '空场景');
    onHealth(store.snapshot('w3'));
    await vi.advanceTimersByTimeAsync(10000);

    expect(selectedIds().filter((id) => id === 'w3')).toHaveLength(1); // 只有 api.select
    expect(store.snapshot('w3').failure?.hard).toBe(true);
  });

  it('teardown 撤销健康订阅，且挂起的自动重试不再落到已收尾的实例上', async () => {
    vi.useFakeTimers();
    bootstrap();
    await boot();
    const store = rendererOpts.value!.healthStore;
    const onHealth = rendererMock.setOnHealth.mock.calls[0]![0] as (s: HealthSnapshot) => void;

    engine().select('w1');
    store.recordSoft('w1', 'load-error', '断流');
    onHealth(store.snapshot('w1')); // 排一次自动重试
    engine().teardown();
    await vi.advanceTimersByTimeAsync(10000);

    expect(rendererMock.setOnHealth).toHaveBeenLastCalledWith(null); // 订阅已撤销
    expect(selectedIds().filter((id) => id === 'w1')).toHaveLength(1); // 只有 api.select，自动重试没发生
  });
});
