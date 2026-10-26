// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn(async () => {});
// 捕获 controller 的入参：I3 要直接驱动 index.ts 接线的 sceneFallback（降级成功路径）。
const controllerOpts = vi.hoisted(() => ({ value: null as any }));
vi.mock('../../src/client/background-layer.js', () => ({
  createBackgroundLayer: () => ({ root: document.createElement('div'), setOverlayOpacity() {}, setBlur() {}, setPaused() {}, setKenBurns() {}, setFitMode() {}, showNone() {}, showImage() {}, showVideo: async () => 'ok', showWeb() {} }),
}));
vi.mock('../../src/client/wallpaper-controller.js', () => ({
  createWallpaperController: (_layer: any, opts: any) => {
    controllerOpts.value = opts;
    return { load: async () => [], select: selectMock, applyTextStyle() {}, getList: () => [] };
  },
}));
// 降级链：I3 只关心「成功拿到 video/frame 后是否清记忆」，真实探测/抓帧流程不在此测。
const sceneFallbackMock = vi.hoisted(() => ({
  showSceneFallback: vi.fn(async () => 'frame' as 'video' | 'frame' | 'preview' | 'none'),
  ensureSceneFrame: vi.fn(async () => null),
}));
vi.mock('../../src/client/scene-fallback.js', () => sceneFallbackMock);
// settings-section 是 .tsx（依赖 React）：本测试只验 index.ts 的接线，把它整体替身掉
vi.mock('../../src/client/settings-section.js', () => ({
  WallpaperSettingsSection: () => null,
  setWallpaperSelectHandler: vi.fn(),
  setWallpaperRuntimeHandler: vi.fn(),
  setWallpaperHealthHandler: vi.fn(),
  setWallpaperMediaHandler: vi.fn(),
  setWallpaperReselectHandler: vi.fn(),
  setWallpaperSystemAudioHandlers: vi.fn(),
  notifyWallpaperHealth: vi.fn(),
  notifyWallpaperMedia: vi.fn(),
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
import { setWallpaperHealthHandler, setWallpaperSelectHandler, setWallpaperReselectHandler, notifyWallpaperHealth } from '../../src/client/settings-section.js';
import type { HealthSnapshot } from '../../src/client/render-health.js';

const engine = () => (window as any).__wallpaperEngine;
const tick = () => new Promise((r) => setTimeout(r, 0));
// 假时钟下等「启动期异步读设置」落地：它 resolve 后会把 settings 覆盖为已保存值，
// 必须发生在驱动选中项之前，否则断言看到的选中项会被这次异步读清掉。
const boot = () => vi.advanceTimersByTimeAsync(0);
const selectedIds = () => selectMock.mock.calls.map((c) => String(c[0]));

// 收尾用例启动的实例：不能只 delete 全局登记点 —— 那样 visibilitychange 监听与在途定时器会跨用例累积。
function teardownEngine() {
  const api = (window as any).__wallpaperEngine;
  try { api?.teardown?.(); } catch { /* 已收尾 */ }
  delete (window as any).__wallpaperEngine;
  delete (window as any).__wpEngineTeardown;
}

describe('window.__wallpaperEngine 看护入口', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    localStorage.clear();
    // 每个用例都从零开始：先让上一个用例的实例自己收尾（撤监听/清定时器），再清全局登记点。
    teardownEngine();
    rendererOpts.value = null;
  });
  afterEach(() => { vi.useRealTimers(); teardownEngine(); });
  it('health / retryLive / clearRenderFailures 都在，且 retryLive 会清记忆并重选', async () => {
    bootstrap();
    await new Promise((r) => setTimeout(r, 0));
    const api = (window as any).__wallpaperEngine;
    // 守卫：非当前选中壁纸读不到状态（mock renderer 恒返回 w1），选中它之后才读得到。
    expect(api.health()).toBeNull();
    api.select('w1');
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

  it('同一次 select 的两次软失败打点（fg→fg2）⇒ 冷却按后一次重排，到期恰好重试一次', async () => {
    vi.useFakeTimers();
    bootstrap();
    await boot();
    const store = rendererOpts.value!.healthStore;
    const onHealth = rendererMock.setOnHealth.mock.calls[0]![0] as (s: HealthSnapshot) => void;

    engine().select('w1');
    store.recordSoft('w1', 'load-error', '断流 fg');
    onHealth(store.snapshot('w1')); // 第一次打点：排冷却
    await vi.advanceTimersByTimeAsync(1); // 让第二次打点比第一次晚 ≥1ms（store 的 at 会被刷新）
    store.recordSoft('w1', 'load-error', '断流 fg2');
    onHealth(store.snapshot('w1')); // 第二次打点：必须按完整冷却重排，否则到期时 now-at < 冷却

    await vi.advanceTimersByTimeAsync(2999);
    expect(selectedIds().filter((id) => id === 'w1')).toHaveLength(1); // 冷却未到 ⇒ 不重选
    await vi.advanceTimersByTimeAsync(1);
    expect(selectedIds().filter((id) => id === 'w1')).toHaveLength(2); // 冷却到期 ⇒ 恰好一次
    await vi.advanceTimersByTimeAsync(10000);
    expect(selectedIds().filter((id) => id === 'w1')).toHaveLength(2); // 不再有第二次
  });

  it('两张壁纸各自软失败 ⇒ 各自都有重试；w2 不被 w1 的定时器挡掉、w1 不被拽回', async () => {
    vi.useFakeTimers();
    bootstrap();
    await boot();
    const store = rendererOpts.value!.healthStore;
    const onHealth = rendererMock.setOnHealth.mock.calls[0]![0] as (s: HealthSnapshot) => void;

    engine().select('w1');
    store.recordSoft('w1', 'load-error', '断流');
    onHealth(store.snapshot('w1')); // w1 排一次重试
    engine().select('w2'); // 用户切到 w2
    store.recordSoft('w2', 'load-error', '断流');
    onHealth(store.snapshot('w2')); // w2 也必须有自己的重试

    await vi.advanceTimersByTimeAsync(3000);

    // 序列：用户选 w1 / 用户选 w2 / 自动重试 w2 —— w1 到期时已不是当前选中，不重选
    expect(selectedIds()).toEqual(['w1', 'w2', 'w2']);
  });

  it('启动窗口内用户已选的壁纸不被异步读回的持久值冲掉', async () => {
    vi.useFakeTimers();
    // 真机 describe() 是一次远程往返（可晚数百 ms）：这里用受控 promise 复刻「读回迟到」
    let resolveDescribe!: (v: unknown) => void;
    const describe = vi.fn(() => new Promise((r) => { resolveDescribe = r; }));
    bootstrap({ remote: { settings: { describe } } });
    await boot();

    engine().select('w1'); // 读回尚未落地
    resolveDescribe({ ok: true, value: { namespaces: [{ ns: 'dsh-wallpaper-engine', value: { selectedWallpaperId: 'w0' } }] } });
    await boot();
    await boot(); // controller.load().then(…) 的下一跳

    const hard = JSON.stringify({ v: 1, kind: 'exception', detail: 'x', at: 1 });
    localStorage.setItem('we:renderfail:w1', hard);
    localStorage.setItem('we:renderfail:w0', hard);
    engine().retryLive(); // retryLive 只清「当前选中壁纸」的记忆 ⇒ 用它观测选中项
    expect(localStorage.getItem('we:renderfail:w1')).toBeNull(); // 选中项仍是 w1
    expect(localStorage.getItem('we:renderfail:w0')).toBe(hard); // w0 的记忆没被动
    expect(selectedIds()).not.toContain('w0'); // 也没把壁纸切回 w0
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

  // Task 4：面板接线 —— 健康事件要推给订阅者（硬失败也不能漏），选中壁纸后补推一次，
  // 且只推「当前选中壁纸」的状态（否则上一张 scene 的结论会串到面板上）。
  it('面板接线：健康事件与选中后补推都进订阅者，非当前壁纸的状态不串台', async () => {
    bootstrap();
    await tick();
    const handlerCalls = vi.mocked(setWallpaperHealthHandler).mock.calls;
    const handler = handlerCalls[handlerCalls.length - 1]![0];
    const onHealth = rendererMock.setOnHealth.mock.calls[0]![0] as (s: HealthSnapshot) => void;
    const ok: HealthSnapshot = { wallpaperId: 'w1', ok: true, failure: null, timing: { assembleMs: 10, firstFrameMs: 20 } };
    const hard: HealthSnapshot = {
      wallpaperId: 'w1', ok: false, timing: null,
      failure: { kind: 'no-visible-objects', hard: true, at: 1, detail: '' },
    };

    engine().select('w1'); // 打点只对「当前选中壁纸」生效 ⇒ 先选中它
    onHealth(ok);
    expect(notifyWallpaperHealth).toHaveBeenLastCalledWith(ok);
    onHealth(hard); // 硬失败也要推（冷却重试的早退不得挡住面板推送）
    expect(notifyWallpaperHealth).toHaveBeenLastCalledWith(hard);

    // 面板选壁纸 → controller.select 落地后补推一次（走共享 select handler，即面板路径）
    const selectCalls = vi.mocked(setWallpaperSelectHandler).mock.calls;
    (selectCalls[selectCalls.length - 1]![0] as (id: string) => void)('w1');
    await tick();
    expect(notifyWallpaperHealth).toHaveBeenLastCalledWith(ok);
    expect(handler.get()).toEqual(ok);

    // 面板打开时读到的也只认当前选中壁纸：mock renderer 的快照是 w1
    expect(handler.retry).toBeTypeOf('function');
    expect(handler.clearFailures).toBeTypeOf('function');
    handler.clearFailures();
    // E：清除失败记忆只清「失败记忆」，不抹掉「现在正常」⇒ 推送的是当前选中壁纸的真实快照，
    // 而不是把状态行打成「尚未渲染」。
    expect(notifyWallpaperHealth).toHaveBeenLastCalledWith(ok);
  });

  // Minor 6：health() 与面板 panelHealth 同一守卫 —— 当前壁纸不是 scene（video/none）时读不到状态。
  it('health() 的 id 守卫：非当前选中壁纸时返回 null', async () => {
    bootstrap();
    await tick();
    const api = engine();
    expect(api.health()).toBeNull(); // 还没选中任何壁纸
    api.select('w1');
    expect(api.health()?.wallpaperId).toBe('w1');
    api.show({ kind: 'video', url: '/x.mp4' }); // 非 scene 分支
    expect(api.health()).toBeNull();
  });

  // Important 3：非 scene 分支（image/video/web/none）必须解绑选中项 —— 否则上一张 scene 的状态
  // **持续**挂在面板上，且「重试实时渲染」会把用户刚换掉的那张 scene 选回来。
  it('show({kind:"none"}) 解绑选中项：上一张 scene 的迟到事件不推面板，retryLive 不把它选回来', async () => {
    bootstrap();
    await tick();
    const api = engine();
    const onHealth = rendererMock.setOnHealth.mock.calls[0]![0] as (s: HealthSnapshot) => void;
    api.select('w1');
    vi.mocked(notifyWallpaperHealth).mockClear();

    api.show({ kind: 'none' });
    expect(api.health()).toBeNull();
    expect(notifyWallpaperHealth).toHaveBeenLastCalledWith(null); // 面板立即刷新，不留上一张的旧文案
    vi.mocked(notifyWallpaperHealth).mockClear();
    // 上一张 scene 迟到的失败打点不得上屏
    onHealth({
      wallpaperId: 'w1', ok: false, timing: null,
      failure: { kind: 'no-visible-objects', hard: true, at: 1, detail: '' },
    });
    expect(notifyWallpaperHealth).not.toHaveBeenCalled();

    // 面板「重试实时渲染」不得把刚换掉的 scene 选回来
    const calls = selectMock.mock.calls.length;
    api.retryLive();
    expect(selectMock.mock.calls.length).toBe(calls);
  });

  // Minor 12：硬失败落盘的**唯一用途** = 跨实例拦住自动重试（本用例是真实生产序列：
  // 上次会话留下硬记忆 → 本次软失败排冷却 → 到期时 store 的硬记忆闸必须拦住重选）。
  it('跨实例持久硬记忆拦住自动重试（硬失败落盘后不再自动重选）', async () => {
    vi.useFakeTimers();
    // 必须在 bootstrap 之前预置：store 在 bootstrap 里新建，读的就是这份 localStorage。
    localStorage.setItem('we:renderfail:w1', JSON.stringify({ v: 1, kind: 'exception', detail: '上次会话', at: 1 }));
    bootstrap();
    await boot();
    const store = rendererOpts.value!.healthStore;
    const onHealth = rendererMock.setOnHealth.mock.calls[0]![0] as (s: HealthSnapshot) => void;
    expect(store.snapshot('w1').failure?.hard).toBe(true); // 跨实例读回上次会话的硬失败

    engine().select('w1');
    store.recordSoft('w1', 'load-error', '断流');
    onHealth(store.snapshot('w1'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(selectedIds().filter((id) => id === 'w1')).toHaveLength(1); // 只有 api.select，没有自动重试
  });

  it('对照：同样的软失败但没有硬记忆 ⇒ 冷却到期自动重选一次', async () => {
    vi.useFakeTimers();
    expect(localStorage.getItem('we:renderfail:w1')).toBeNull(); // 前置：没有硬记忆
    bootstrap();
    await boot();
    const store = rendererOpts.value!.healthStore;
    const onHealth = rendererMock.setOnHealth.mock.calls[0]![0] as (s: HealthSnapshot) => void;

    engine().select('w1');
    store.recordSoft('w1', 'load-error', '断流');
    onHealth(store.snapshot('w1'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(selectedIds().filter((id) => id === 'w1')).toHaveLength(2); // api.select + 一次自动重试
    expect(selectMock).toHaveBeenLastCalledWith('w1');
  });

  it('面板读接口：选中项与快照壁纸不一致（非 scene 壁纸）⇒ 读不到状态（推 null 不串台）', async () => {
    bootstrap();
    await tick();
    const handlerCalls = vi.mocked(setWallpaperHealthHandler).mock.calls;
    const handler = handlerCalls[handlerCalls.length - 1]![0];
    const selectCalls = vi.mocked(setWallpaperSelectHandler).mock.calls;
    const selectWallpaper = selectCalls[selectCalls.length - 1]![0] as (id: string) => void;

    selectWallpaper('video-1'); // mock renderer 的 getLastHealth 恒返回 wallpaperId 'w1'
    await tick();
    expect(handler.get()).toBeNull();
    expect(notifyWallpaperHealth).toHaveBeenLastCalledWith(null);

    selectWallpaper('w1');
    await tick();
    expect(handler.get()?.wallpaperId).toBe('w1');
  });

  // fix round 1（Important）：切走后旧壁纸迟到的打点不得覆盖面板（onHealth 的 id 守卫）。
  it('面板接线：切走后迟到的旧壁纸健康事件不推面板，当前壁纸的事件照推', async () => {
    bootstrap();
    await tick();
    const onHealth = rendererMock.setOnHealth.mock.calls[0]![0] as (s: HealthSnapshot) => void;
    const w1ok: HealthSnapshot = { wallpaperId: 'w1', ok: true, failure: null, timing: { assembleMs: 10, firstFrameMs: 20 } };

    engine().select('w1');
    onHealth(w1ok);
    expect(notifyWallpaperHealth).toHaveBeenLastCalledWith(w1ok); // 当前选中 ⇒ 照推

    engine().select('w2'); // 用户切走（或切到已取消的空 id）
    vi.mocked(notifyWallpaperHealth).mockClear();
    const late: HealthSnapshot = {
      wallpaperId: 'w1', ok: false, timing: null,
      failure: { kind: 'no-visible-objects', hard: true, at: 1, detail: '' },
    };
    onHealth(late);
    expect(notifyWallpaperHealth).not.toHaveBeenCalled(); // 迟到的旧壁纸打点被守卫挡掉

    const w2ok: HealthSnapshot = { wallpaperId: 'w2', ok: true, failure: null, timing: { assembleMs: 1, firstFrameMs: 2 } };
    onHealth(w2ok);
    expect(notifyWallpaperHealth).toHaveBeenLastCalledWith(w2ok); // 守卫不误伤当前壁纸
  });

  // I3：降级成功只是「显示层成功」，live 渲染失败的事实要保留 —— 否则软失败的 3s 自动重试被取消。
  const w1Info = { id: 'w1', title: 'S', type: 'scene', hasScene: true, hasPreviewGif: false, previewUrl: '/p1' };
  it('I3: 软失败后降级到抓帧成功不清记忆 ⇒ 3s 冷却后仍自动重试一次', async () => {
    vi.useFakeTimers();
    bootstrap();
    await boot();
    const store = rendererOpts.value!.healthStore;
    const onHealth = rendererMock.setOnHealth.mock.calls[0]![0] as (s: HealthSnapshot) => void;

    engine().select('w1');
    store.recordSoft('w1', 'load-error', '断流');
    onHealth(store.snapshot('w1')); // 排 3s 冷却重试
    sceneFallbackMock.showSceneFallback.mockResolvedValueOnce('frame');
    await controllerOpts.value.sceneFallback(w1Info); // 降级到抓帧成功

    expect(store.snapshot('w1').failure?.kind).toBe('load-error'); // 不 clear：失败事实保留
    await vi.advanceTimersByTimeAsync(3000);
    expect(selectedIds().filter((id) => id === 'w1')).toHaveLength(2); // api.select + 自动重试
  });

  it('I3: 降级成功也不清硬失败记忆（面板「已记忆」跨刷新仍成立）', async () => {
    bootstrap();
    await tick();
    const store = rendererOpts.value!.healthStore;

    engine().select('w1');
    store.recordHard('w1', 'exception', '装配异常');
    sceneFallbackMock.showSceneFallback.mockResolvedValueOnce('frame');
    await controllerOpts.value.sceneFallback(w1Info);

    expect(store.snapshot('w1').failure?.hard).toBe(true);
    expect(localStorage.getItem('we:renderfail:w1')).not.toBeNull();
  });

  // I4：面板属性开关拿的是自己的选中快照（可能晚于实际选中项）⇒ 陈旧 id 不得把壁纸切回去。
  it('I4: 共享 reselect handler 收到陈旧 id 不重选，当前 id 才重选', async () => {
    bootstrap();
    await tick();
    const calls = vi.mocked(setWallpaperReselectHandler).mock.calls;
    const reselect = calls[calls.length - 1]![0] as (id: string) => void;

    engine().select('w1');
    selectMock.mockClear();
    reselect('w2'); // 面板快照还是 w2（实际已是 w1）
    await tick();
    expect(selectMock).not.toHaveBeenCalled();

    reselect('w1');
    await tick();
    expect(selectMock).toHaveBeenCalledWith('w1');
  });
});
