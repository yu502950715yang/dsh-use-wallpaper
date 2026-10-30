import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMediaSnapshot, createMediaInput, diffSnapshot, mediaUrl, sceneNeedsMedia } from '../src/client/media-input.js';
import { parseSceneJson } from '../src/client/scene-json.js';
import { emptyMediaSnapshot, type MediaSessionSnapshot } from '../src/shared/media.js';

const snap = (patch: Partial<MediaSessionSnapshot>): MediaSessionSnapshot => ({ ...emptyMediaSnapshot('ok', 1), ...patch });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

type FetchResult = { ok: boolean; json(): Promise<MediaSessionSnapshot> };

/** 注入式定时器：句柄即数组下标；cleared 标记 clearIntervalImpl 是否被调用。 */
function makeTimerHarness() {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    timers,
    setIntervalImpl: (fn: () => void, ms: number): number => {
      timers.push({ fn, ms, cleared: false });
      return timers.length - 1;
    },
    clearIntervalImpl: (handle: unknown): void => {
      const record = timers[handle as number];
      if (record) record.cleared = true;
    },
    active: () => timers.filter((t) => !t.cleared).at(-1),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('mediaUrl', () => {
  it('标题写入 query 并做 URL 编码', () => {
    expect(mediaUrl('A & B — 测试')).toBe('/wallpapers/now-playing?title=' + encodeURIComponent('A & B — 测试'));
  });
});

describe('diffSnapshot', () => {
  it('首次返回所有变化键；仅 positionMs/at 变化 ⇒ 空数组', () => {
    expect(diffSnapshot(null, snap({ available: true, title: 'T' }))).toEqual(
      expect.arrayContaining(['available', 'reason', 'title', 'playback']),
    );
    expect(diffSnapshot(snap({ available: true, title: 'T' }), snap({ available: true, title: 'T', at: 9 }))).toEqual([]);
  });

  it('positionMs/durationMs/at 不参与 diff', () => {
    const prev = snap({ available: true, title: 'T', positionMs: 1, durationMs: 2, at: 3 });
    expect(diffSnapshot(prev, snap({ available: true, title: 'T', positionMs: 9, durationMs: 8, at: 7 }))).toEqual([]);
  });

  it('切歌/封面变化分别产出 title 与 thumbnailRev', () => {
    const prev = snap({ available: true, title: 'A', thumbnailRev: 2 });
    expect(diffSnapshot(prev, snap({ available: true, title: 'B', thumbnailRev: 3 }))).toEqual(['title', 'thumbnailRev']);
  });

  it('thumbnailRev 回退也算变化（按 !== 而非 >）', () => {
    const prev = snap({ available: true, title: 'A', thumbnailRev: 5 });
    expect(diffSnapshot(prev, snap({ available: true, title: 'A', thumbnailRev: 4 }))).toEqual(['thumbnailRev']);
  });

  it('contentType 参与 diff（视频/音乐切换要重派属性）', () => {
    const prev = snap({ available: true, title: 'T', contentType: 'music' });
    expect(diffSnapshot(prev, snap({ available: true, title: 'T', contentType: 'video' }))).toEqual(['contentType']);
  });
});

describe('createMediaInput', () => {
  it('每秒轮询一次；快照变化回调；pageTitle 写入 URL', async () => {
    const timers: Array<() => void> = [];
    const urls: string[] = [];
    const got: MediaSessionSnapshot[] = [];
    let payload = snap({ available: true, title: 'A' });
    const input = createMediaInput({
      pageTitle: () => 'D — DeepSeek Harness',
      fetchImpl: async (url) => { urls.push(url); return { ok: true, json: async () => payload }; },
      setIntervalImpl: (fn) => { timers.push(fn); return timers.length - 1; },
      clearIntervalImpl: () => {},
      onSnapshot: (_n, _p) => got.push(_n),
    });
    input.start();
    await flush(); // 先消化 start 的立即轮询，避免 pollNow 被 inflight 守卫吃掉
    await input.pollNow();
    expect(urls[0]).toBe('/wallpapers/now-playing?title=' + encodeURIComponent('D — DeepSeek Harness'));
    expect(got).toHaveLength(1);
    await input.pollNow(); // 无变化 ⇒ 不再回调
    expect(got).toHaveLength(1);
    payload = snap({ available: true, title: 'B' });
    await input.pollNow();
    expect(got).toHaveLength(2);
    input.setPaused(true);
    expect(input.isRunning()).toBe(false);
    input.dispose();
  });

  it('连续 3 次失败后进入退避（10s），成功恢复；stop 后不再请求', async () => {
    vi.useFakeTimers();
    const intervals: Array<{ fn: () => void; ms: number }> = [];
    let calls = 0;
    let fail = true;
    const input = createMediaInput({
      fetchImpl: async () => { calls += 1; if (fail) throw new Error('net'); return { ok: true, json: async () => snap({ available: true, title: 'T' }) }; },
      setIntervalImpl: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length - 1; },
      clearIntervalImpl: () => {},
      onSnapshot: () => {},
      onError: () => {},
    });
    input.start();
    for (let i = 0; i < 3; i++) await input.pollNow();
    expect(intervals.some((i) => i.ms === 10_000)).toBe(true);
    fail = false;
    await input.pollNow();
    input.stop();
    expect(input.isRunning()).toBe(false);
    vi.useRealTimers();
  });

  it('连续 3 次失败切 10s 退避，一次成功恢复 1s；同间隔不重复重建定时器', async () => {
    const timers = makeTimerHarness();
    let fail = true;
    const input = createMediaInput({
      fetchImpl: async () => {
        if (fail) throw new Error('net');
        return { ok: true, json: async () => snap({ available: true, title: 'T' }) };
      },
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      onSnapshot: () => {},
      onError: () => {},
    });
    input.start();
    await flush(); // 消化 start 的立即轮询
    for (let i = 0; i < 3; i += 1) await input.pollNow();
    expect(timers.active()?.ms).toBe(10_000);
    const before = timers.timers.length;
    fail = false;
    await input.pollNow();
    expect(timers.active()?.ms).toBe(1_000);
    await input.pollNow(); // 同间隔成功 ⇒ 不重建
    expect(timers.timers.length).toBe(before + 1);
    input.dispose();
  });

  it('回调携带上一次快照（首次为 null）', async () => {
    const seenPrev: Array<MediaSessionSnapshot | null> = [];
    let payload = snap({ available: true, title: 'A' });
    const input = createMediaInput({
      fetchImpl: async () => ({ ok: true, json: async () => payload }),
      onSnapshot: (_next, prev) => seenPrev.push(prev),
    });
    await input.pollNow();
    payload = snap({ available: true, title: 'B' });
    await input.pollNow();
    expect(seenPrev).toHaveLength(2);
    expect(seenPrev[0]).toBeNull();
    expect(seenPrev[1]?.title).toBe('A');
  });

  it('setPaused(true) 停定时器；false 立即拉一次并恢复 1s', async () => {
    const timers = makeTimerHarness();
    let calls = 0;
    const input = createMediaInput({
      fetchImpl: async () => { calls += 1; return { ok: true, json: async () => snap({ available: true, title: 'T' }) }; },
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      onSnapshot: () => {},
    });
    input.start();
    expect(calls).toBe(1);
    await flush(); // 等 start 的立即轮询结束，否则恢复时会被 inflight 守卫吃掉
    expect(timers.active()?.ms).toBe(1_000);
    input.setPaused(true);
    expect(input.isRunning()).toBe(false);
    expect(timers.active()).toBeUndefined();
    input.setPaused(false);
    expect(input.isRunning()).toBe(true);
    expect(calls).toBe(2);
    expect(timers.active()?.ms).toBe(1_000);
    input.dispose();
  });

  it('dispose 幂等：清定时器且不再回调/轮询', async () => {
    const timers = makeTimerHarness();
    const got: MediaSessionSnapshot[] = [];
    let calls = 0;
    const input = createMediaInput({
      fetchImpl: async () => { calls += 1; return { ok: true, json: async () => snap({ available: true, title: 'T' }) }; },
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      onSnapshot: (next) => got.push(next),
    });
    input.start();
    input.dispose();
    input.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(got).toHaveLength(0);
    expect(calls).toBe(1);
    expect(timers.timers.every((t) => t.cleared)).toBe(true);
    await input.pollNow();
    expect(calls).toBe(1);
    expect(input.isRunning()).toBe(false);
  });

  it('dispose 后飞行中的失败不再回调 onError', async () => {
    let rejectFetch!: (error: Error) => void;
    const errors: unknown[] = [];
    const input = createMediaInput({
      fetchImpl: () => new Promise<FetchResult>((_resolve, reject) => { rejectFetch = reject; }),
      onSnapshot: () => {},
      onError: (error) => errors.push(error),
    });
    const pending = input.pollNow();
    input.dispose();
    rejectFetch(new Error('net'));
    await pending;
    expect(errors).toHaveLength(0);
  });

  it('请求飞行中重入 pollNow 不再发请求', async () => {
    let resolveFetch!: (value: FetchResult) => void;
    let calls = 0;
    const input = createMediaInput({
      fetchImpl: () => { calls += 1; return new Promise<FetchResult>((resolve) => { resolveFetch = resolve; }); },
      onSnapshot: () => {},
    });
    const first = input.pollNow();
    const second = input.pollNow();
    expect(calls).toBe(1);
    resolveFetch({ ok: true, json: async () => snap({ available: true, title: 'T' }) });
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  it('响应非 ok 时回调 onError、不产生快照，pollNow 不 reject', async () => {
    const errors: unknown[] = [];
    const got: MediaSessionSnapshot[] = [];
    const input = createMediaInput({
      fetchImpl: async () => ({ ok: false, json: async () => snap({ available: true, title: 'T' }) }),
      onSnapshot: (next) => got.push(next),
      onError: (error) => errors.push(error),
    });
    await expect(input.pollNow()).resolves.toBeUndefined();
    expect(got).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('now-playing http');
  });

  it('onError 自身抛错也不外抛（无 unhandled rejection）', async () => {
    const input = createMediaInput({
      fetchImpl: async () => { throw new Error('net'); },
      onSnapshot: () => {},
      onError: () => { throw new Error('boom'); },
    });
    await expect(input.pollNow()).resolves.toBeUndefined();
  });

  // Task 4 carry-over：定时器路径此前没有直接用例（只测了手动 pollNow）。
  it('定时器 fire 触发一次轮询', async () => {
    const timers = makeTimerHarness();
    let calls = 0;
    const input = createMediaInput({
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, json: async () => snap({ available: true, title: 'T' }) };
      },
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      onSnapshot: () => {},
    });
    input.start();
    await flush();
    expect(calls).toBe(1);
    timers.active()!.fn();
    await flush();
    expect(calls).toBe(2);
    input.dispose();
  });

  it('stop/dispose 后定时器 fire 不再请求', async () => {
    const timers = makeTimerHarness();
    let calls = 0;
    const input = createMediaInput({
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, json: async () => snap({ available: true, title: 'T' }) };
      },
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      onSnapshot: () => {},
    });
    input.start();
    await flush();
    const first = timers.active()!;
    input.stop();
    first.fn();
    await flush();
    expect(calls).toBe(1);
    input.start();
    await flush();
    expect(calls).toBe(2);
    const second = timers.active()!;
    input.dispose();
    second.fn();
    await flush();
    expect(calls).toBe(2);
  });

  // 回调异常不是网络失败：不得累加 failures（否则 3 次回调异常就把轮询打进 10s 退避）。
  it('onSnapshot 抛错不计入 failures、不触发退避、不调用 onError', async () => {
    const timers = makeTimerHarness();
    const errors: unknown[] = [];
    let calls = 0;
    const input = createMediaInput({
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, json: async () => snap({ available: true, title: 'T' + calls }) };
      },
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      onSnapshot: () => { throw new Error('render boom'); },
      onError: (e) => errors.push(e),
    });
    input.start();
    await flush();
    for (let i = 0; i < 4; i += 1) await input.pollNow();
    expect(calls).toBe(5);
    expect(errors).toEqual([]);
    expect(timers.active()?.ms).toBe(1_000);
    input.dispose();
  });
});

describe('applyMediaSnapshot（快照 → 事件派发）', () => {
  const makeSink = (log: string[]) => ({
    playback: (s: string) => log.push('playback:' + s),
    status: (e: boolean) => log.push('status:' + e),
    properties: (p: { title: string }) => log.push('props:' + p.title),
    thumbnail: (t: { hasThumbnail: boolean }) => log.push('thumb:' + t.hasThumbnail),
  });
  const playing = {
    ...emptyMediaSnapshot('ok', 1),
    available: true, playback: 'playing' as const,
    title: 'T', artist: 'A', hasThumbnail: true, thumbnailRev: 1,
  };

  it('首次/切歌/停止的事件顺序与去重', () => {
    const log: string[] = [];
    const sink = makeSink(log);
    applyMediaSnapshot(null, playing, sink);
    expect(log).toEqual(['status:true', 'playback:playing', 'props:T', 'thumb:true']);
    log.length = 0;
    applyMediaSnapshot(playing, { ...playing, positionMs: 5 }, sink);
    expect(log).toEqual([]);
    applyMediaSnapshot(playing, { ...playing, playback: 'stopped', title: '' }, sink);
    expect(log).toEqual(['playback:stopped']);
  });

  it('不可用快照只派发 stopped（不向已隐藏的媒体层派发空属性/封面）', () => {
    const log: string[] = [];
    applyMediaSnapshot(playing, emptyMediaSnapshot('no-session', 2), makeSink(log));
    expect(log).toEqual(['playback:stopped']);
  });
});

describe('sceneNeedsMedia', () => {
  it('只有声明 media* 脚本时为 true', () => {
    const plain = parseSceneJson(JSON.stringify({ objects: [{ id: 1, image: 'models/x.json' }] }));
    expect(sceneNeedsMedia(plain)).toBe(false);

    const visible = parseSceneJson(JSON.stringify({
      objects: [{
        id: 1, image: 'models/x.json',
        visible: { script: 'export function mediaPlaybackChanged(e){ thisLayer.visible=false; }', value: true },
      }],
    }));
    expect(sceneNeedsMedia(visible)).toBe(true);

    const text = parseSceneJson(JSON.stringify({
      objects: [{ id: 2, text: { value: 'x', script: 'export function mediaPropertiesChanged(e){}' } }],
    }));
    expect(sceneNeedsMedia(text)).toBe(true);

    // 属性脚本（angles/origin/scale/color）也要能被识别
    const attr = parseSceneJson(JSON.stringify({
      objects: [{ id: 3, image: 'models/x.json', angles: { script: 'export function mediaStatusChanged(e){}' } }],
    }));
    expect(sceneNeedsMedia(attr)).toBe(true);
  });

  it('普通 update/时钟脚本不误判', () => {
    const d = parseSceneJson(JSON.stringify({
      objects: [{
        id: 1, image: 'models/x.json',
        visible: { script: 'export function update(){ return true; }', value: true },
      }, {
        id: 2, text: { value: '', script: 'export function update(v){ return v; }' },
      }],
    }));
    expect(sceneNeedsMedia(d)).toBe(false);
  });
});
