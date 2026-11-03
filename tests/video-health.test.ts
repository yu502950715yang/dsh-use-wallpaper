import { describe, expect, it } from 'vitest';
import {
  createVideoHealthMonitor,
  type VideoHealthMonitor,
  type VideoHealthSnapshot,
} from '../src/client/video-health.js';

/** 注入式时钟：now 读当前毫秒，advance 手动推进。 */
function makeClock(start = 0) {
  let current = start;
  return { now: (): number => current, advance: (ms: number): void => { current += ms; } };
}

/** 注入式定时器：句柄 = 数组下标；fire(ms) 只触发该间隔的活动定时器。 */
function makeTimers() {
  const entries: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    entries,
    api: {
      setInterval: (fn: () => void, ms: number): number => entries.push({ fn, ms, cleared: false }) - 1,
      clearInterval: (id: number): void => {
        const entry = entries[id];
        if (entry) entry.cleared = true;
      },
    },
    fire(ms: number): void {
      for (const entry of entries) if (!entry.cleared && entry.ms === ms) entry.fn();
    },
    active(): Array<{ fn: () => void; ms: number; cleared: boolean }> {
      return entries.filter((entry) => !entry.cleared);
    },
  };
}

type Quality = { totalVideoFrames: number; droppedVideoFrames: number };

/** 假 video：只实现被测字段；getVideoPlaybackQuality 可缺省（模拟 jsdom）或抛错。 */
function makeVideo(opts: {
  withQuality?: boolean;
  qualityThrows?: boolean;
  currentTime?: number;
  duration?: number;
  paused?: boolean;
} = {}) {
  const listeners = new Map<string, Set<() => void>>();
  const removed: Array<{ type: string; handler: () => void }> = [];
  let quality: Quality = { totalVideoFrames: 0, droppedVideoFrames: 0 };
  const video: {
    currentTime: number;
    duration: number;
    paused: boolean;
    videoWidth: number | undefined;
    videoHeight: number | undefined;
    getVideoPlaybackQuality?: () => Quality;
    addEventListener(type: string, handler: () => void): void;
    removeEventListener(type: string, handler: () => void): void;
  } = {
    currentTime: opts.currentTime ?? 0,
    duration: opts.duration ?? 60,
    paused: opts.paused ?? false,
    videoWidth: 3840,
    videoHeight: 2160,
    addEventListener(type, handler): void {
      let handlers = listeners.get(type);
      if (!handlers) { handlers = new Set(); listeners.set(type, handlers); }
      handlers.add(handler);
    },
    removeEventListener(type, handler): void {
      removed.push({ type, handler });
      const handlers = listeners.get(type);
      if (!handlers) return;
      handlers.delete(handler);
      if (handlers.size === 0) listeners.delete(type); // 与真实 DOM 一致：无监听后该类型不残留
    },
  };
  if (opts.withQuality !== false) {
    video.getVideoPlaybackQuality = opts.qualityThrows
      ? (): Quality => { throw new Error('quality unavailable'); }
      : (): Quality => ({ ...quality });
  }
  return {
    video,
    el: video as unknown as HTMLVideoElement,
    listeners,
    removed,
    setQuality(totalVideoFrames: number, droppedVideoFrames: number): void {
      quality = { totalVideoFrames, droppedVideoFrames };
    },
    emit(type: string): void {
      for (const handler of [...(listeners.get(type) ?? [])]) handler();
    },
  };
}

type MonitorOptions = Parameters<typeof createVideoHealthMonitor>[0];
type VideoOptions = Parameters<typeof makeVideo>[0];

function setup(opts: MonitorOptions = {}, videoOpts: VideoOptions = {}) {
  const clock = makeClock();
  const timers = makeTimers();
  const monitor = createVideoHealthMonitor({ now: clock.now, timers: timers.api, ...opts });
  const fake = makeVideo(videoOpts);
  return { clock, timers, monitor, fake };
}

/** 断言 snapshot 非 null 并返回（避免每处都写非空断言）。 */
function snap(monitor: VideoHealthMonitor): VideoHealthSnapshot {
  const snapshot = monitor.snapshot();
  expect(snapshot).not.toBeNull();
  return snapshot as VideoHealthSnapshot;
}

describe('createVideoHealthMonitor', () => {
  it('未 attach 时 snapshot 为 null；attach 后暴露视频字段与会话默认值；detach 后归 null', () => {
    const { monitor, fake } = setup();
    expect(monitor.snapshot()).toBeNull();

    monitor.attach(fake.el);
    const snapshot = snap(monitor);
    expect(snapshot).toMatchObject({
      fps: 0,
      droppedFrames: 0,
      droppedRecent: 0,
      totalFrames: 0,
      currentTime: 0,
      duration: 60,
      paused: false,
      videoWidth: 3840,
      videoHeight: 2160,
      loopStallsMs: [],
      lastEvent: null,
      lastEventAgoMs: null,
      state: 'ok',
    });
    expect(typeof snapshot.updatedAt).toBe('number');

    monitor.detach();
    expect(monitor.snapshot()).toBeNull();
  });

  it('sample 以 attach 基线算窗口 fps 与 droppedRecent，计数器回退不产负值', () => {
    const clock = makeClock();
    const timers = makeTimers();
    const monitor = createVideoHealthMonitor({ now: clock.now, timers: timers.api });
    const fake = makeVideo();
    fake.setQuality(100, 5);
    monitor.attach(fake.el); // 基线：attach 前的 100 帧不计入 fps

    let snapshot = snap(monitor);
    expect(snapshot.fps).toBe(0);
    expect(snapshot.totalFrames).toBe(100);
    expect(snapshot.droppedFrames).toBe(5);

    clock.advance(1000);
    fake.setQuality(160, 8);
    timers.fire(1000);
    snapshot = snap(monitor);
    expect(snapshot.fps).toBe(60);
    expect(snapshot.droppedRecent).toBe(3);
    expect(snapshot.droppedFrames).toBe(8);
    expect(snapshot.totalFrames).toBe(160);

    clock.advance(1000);
    fake.setQuality(215, 9);
    timers.fire(1000);
    snapshot = snap(monitor);
    expect(snapshot.fps).toBe(55);
    expect(snapshot.droppedRecent).toBe(1);
    expect(snapshot.droppedFrames).toBe(9);

    // 换源/重载后计数回退：窗口增量按 0，不出负 fps / 负丢帧
    clock.advance(1000);
    fake.setQuality(10, 1);
    timers.fire(1000);
    snapshot = snap(monitor);
    expect(snapshot.fps).toBe(0);
    expect(snapshot.droppedRecent).toBe(0);
    expect(snapshot.droppedFrames).toBe(1);
    expect(snapshot.totalFrames).toBe(10);
  });

  it('循环点回绕记录墙钟停顿，保留最近 maxLoopStalls 条（最新在后）', () => {
    const clock = makeClock();
    const timers = makeTimers();
    const monitor = createVideoHealthMonitor({ now: clock.now, timers: timers.api, maxLoopStalls: 2 });
    const fake = makeVideo();
    monitor.attach(fake.el); // 基线 tick：currentTime=0
    const tick = (currentTime: number, advanceMs: number): void => {
      fake.video.currentTime = currentTime;
      clock.advance(advanceMs);
      timers.fire(100);
    };

    tick(59.5, 100); // 尾部
    tick(0.2, 100);  // t=200 回绕，停顿 = 200-100 = 100
    tick(59.9, 100);
    tick(0.1, 100);  // 停顿 = 100
    tick(59.8, 100);
    tick(0.3, 150);  // 停顿 = 150
    tick(30, 100);   // 中段向后拖动：不是循环点
    tick(10, 100);
    expect(snap(monitor).loopStallsMs).toEqual([100, 150]);
  });

  it('默认保留最近 5 次循环点停顿', () => {
    const clock = makeClock();
    const timers = makeTimers();
    const monitor = createVideoHealthMonitor({ now: clock.now, timers: timers.api });
    const fake = makeVideo();
    monitor.attach(fake.el);
    const tick = (currentTime: number, advanceMs: number): void => {
      fake.video.currentTime = currentTime;
      clock.advance(advanceMs);
      timers.fire(100);
    };
    for (let i = 0; i < 6; i += 1) {
      tick(59.5, 100);
      tick(0.2, 100 + i * 10); // 历次停顿 = 100,110,…,150
    }
    expect(snap(monitor).loopStallsMs).toEqual([110, 120, 130, 140, 150]);
  });

  it('暂停期间与无 duration 时不判循环回绕', () => {
    const { clock, timers, monitor, fake } = setup();
    monitor.attach(fake.el); // 基线 tick：currentTime=0
    const tick = (currentTime: number, advanceMs: number, paused = false): void => {
      fake.video.currentTime = currentTime;
      fake.video.paused = paused;
      clock.advance(advanceMs);
      timers.fire(100);
    };

    tick(59.5, 100);
    tick(0.2, 100); // 正常回绕 ⇒ 记一条
    expect(snap(monitor).loopStallsMs).toEqual([100]);

    tick(59.9, 100, true);  // 暂停中：尾部
    tick(0.05, 100, true);  // 暂停中回绕不判
    expect(snap(monitor).loopStallsMs).toEqual([100]);

    // 恢复播放：第一拍只重建基线，不把暂停/拖动的时间差算成停顿
    tick(0.2, 100);
    tick(59.9, 100);
    tick(0.1, 100);
    expect(snap(monitor).loopStallsMs).toEqual([100, 100]);

    // duration 无效（NaN ⇒ 0）时不判
    fake.video.duration = Number.NaN;
    tick(59.9, 100);
    tick(0.1, 100);
    expect(snap(monitor).loopStallsMs).toEqual([100, 100]);
  });

  it('事件更新 lastEvent/时间；waiting/stalled 在最近 5s 内 state=stalled', () => {
    const { clock, monitor, fake } = setup();
    monitor.attach(fake.el);
    expect(snap(monitor).lastEventAgoMs).toBeNull();

    clock.advance(100);
    fake.emit('waiting');
    let snapshot = snap(monitor);
    expect(snapshot.lastEvent).toBe('waiting');
    expect(snapshot.lastEventAgoMs).toBe(0);
    expect(snapshot.state).toBe('stalled');

    clock.advance(4000);
    snapshot = snap(monitor);
    expect(snapshot.lastEventAgoMs).toBe(4000);
    expect(snapshot.state).toBe('stalled');

    clock.advance(1001); // 超出 5s 窗口
    expect(snap(monitor).state).toBe('ok');

    fake.emit('stalled');
    expect(snap(monitor).state).toBe('stalled');

    for (const type of ['seeking', 'seeked', 'playing', 'pause', 'ended']) {
      fake.emit(type);
      expect(snap(monitor).lastEvent).toBe(type);
    }
  });

  it('暂停时 state=paused；error 后 state=lost（丢失优先于暂停）', () => {
    const { monitor, fake } = setup();
    monitor.attach(fake.el);
    fake.video.paused = true;
    expect(snap(monitor).state).toBe('paused');

    fake.emit('error');
    const snapshot = snap(monitor);
    expect(snapshot.lastEvent).toBe('error');
    expect(snapshot.state).toBe('lost');
  });

  it('detach 清掉全部 interval 与监听，之后不再采样', () => {
    const clock = makeClock();
    const timers = makeTimers();
    const monitor = createVideoHealthMonitor({ now: clock.now, timers: timers.api });
    const fake = makeVideo();
    monitor.attach(fake.el);
    expect(timers.active()).toHaveLength(2);
    expect(fake.listeners.size).toBe(8);

    fake.setQuality(60, 1);
    clock.advance(1000);
    timers.fire(1000);
    expect(snap(monitor).fps).toBe(60);

    monitor.detach();
    expect(timers.active()).toHaveLength(0);
    expect(fake.listeners.size).toBe(0);
    expect(fake.removed).toHaveLength(8);
    expect(monitor.snapshot()).toBeNull();

    // 已清除的定时器不再触发采样，快照也不会复活
    fake.setQuality(120, 2);
    clock.advance(1000);
    timers.fire(1000);
    expect(monitor.snapshot()).toBeNull();

    // 重新 attach 从零开始（旧会话状态不残留）
    const second = makeVideo({ currentTime: 5 });
    monitor.attach(second.el);
    const snapshot = snap(monitor);
    expect(snapshot.fps).toBe(0);
    expect(snapshot.totalFrames).toBe(0);
    expect(snapshot.droppedFrames).toBe(0);
    expect(snapshot.loopStallsMs).toEqual([]);
    expect(snapshot.lastEvent).toBeNull();
    expect(snapshot.currentTime).toBe(5);
  });

  it('重复 attach 先摘旧视频再绑定新视频', () => {
    const clock = makeClock();
    const timers = makeTimers();
    const monitor = createVideoHealthMonitor({ now: clock.now, timers: timers.api });
    const first = makeVideo();
    monitor.attach(first.el);

    const second = makeVideo({ currentTime: 10, duration: 30 });
    second.video.videoWidth = 1920;
    second.video.videoHeight = 1080;
    monitor.attach(second.el);

    expect(first.listeners.size).toBe(0);
    expect(timers.active()).toHaveLength(2);
    expect(timers.entries.filter((entry) => entry.cleared)).toHaveLength(2);
    const snapshot = snap(monitor);
    expect(snapshot.currentTime).toBe(10);
    expect(snapshot.duration).toBe(30);
    expect(snapshot.videoWidth).toBe(1920);
    expect(snapshot.videoHeight).toBe(1080);
    expect(snapshot.lastEvent).toBeNull();
  });

  it('无 getVideoPlaybackQuality（jsdom）或它抛错时 fps/丢帧读 0 且不抛', () => {
    const clock = makeClock();
    const timers = makeTimers();
    const monitor = createVideoHealthMonitor({ now: clock.now, timers: timers.api });

    const noQuality = makeVideo({ withQuality: false });
    expect(() => monitor.attach(noQuality.el)).not.toThrow();
    clock.advance(1000);
    expect(() => timers.fire(1000)).not.toThrow();
    let snapshot = snap(monitor);
    expect(snapshot.fps).toBe(0);
    expect(snapshot.droppedFrames).toBe(0);
    expect(snapshot.droppedRecent).toBe(0);
    expect(snapshot.totalFrames).toBe(0);

    const throwing = makeVideo({ qualityThrows: true });
    expect(() => monitor.attach(throwing.el)).not.toThrow();
    clock.advance(1000);
    expect(() => timers.fire(1000)).not.toThrow();
    snapshot = snap(monitor);
    expect(snapshot.fps).toBe(0);
    expect(snapshot.droppedFrames).toBe(0);
  });

  it('duration NaN 与尺寸字段缺失时按 0 输出', () => {
    const { monitor, fake } = setup();
    fake.video.duration = Number.NaN;
    fake.video.videoWidth = undefined;
    fake.video.videoHeight = undefined;
    expect(() => monitor.attach(fake.el)).not.toThrow();
    const snapshot = snap(monitor);
    expect(snapshot.duration).toBe(0);
    expect(snapshot.videoWidth).toBe(0);
    expect(snapshot.videoHeight).toBe(0);
  });

  it('dispose 后 snapshot 为 null 且不再 attach', () => {
    const { monitor, fake, timers } = setup();
    monitor.attach(fake.el);
    monitor.dispose();
    expect(monitor.snapshot()).toBeNull();
    expect(timers.active()).toHaveLength(0);

    expect(() => monitor.attach(fake.el)).not.toThrow();
    expect(monitor.snapshot()).toBeNull();
  });
});
