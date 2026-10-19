import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  buildRotationPool, createRotationScheduler, formatRotationInterval,
  normalizeRotationOrder, pickNext,
} from '../src/client/rotation.js';
import type { LibraryState } from '../src/client/library-view.js';
import type { WallpaperInfo } from '../src/shared/types.js';

// 自动轮播（v0.8）：轮播池 / 下一张选择 / 调度器。纯逻辑 + fake timers，node 环境可测。

const wall = (id: string, type: WallpaperInfo['type'] = 'scene'): WallpaperInfo => ({
  id, title: id, type, hasScene: type === 'scene', hasPreviewGif: false, previewUrl: `/p/${id}`,
});
const libState = (favorites: string[] = [], hidden: string[] = []): LibraryState => ({
  favorites: new Set(favorites), hidden: new Set(hidden), recent: {},
});
const poolTwo = () => [wall('1'), wall('2')];

afterEach(() => { vi.useRealTimers(); });

describe('pickNext', () => {
  it('sequential 跳过 current；random 注入 rand 可预测', () => {
    const pool = [{ id: '1' }, { id: '2' }] as WallpaperInfo[];
    expect(pickNext(pool, '1', 'sequential')?.id).toBe('2');
    expect(pickNext(pool, '2', 'sequential')?.id).toBe('1');
    expect(pickNext(pool, '1', 'random', () => 0)?.id).toBe('2');
  });

  it('空池 / 单张返回 null；current 不在池中取第一张；random 排除 current', () => {
    expect(pickNext([], '1', 'sequential')).toBeNull();
    expect(pickNext([wall('1')], '1', 'sequential')).toBeNull();
    expect(pickNext([wall('1'), wall('2')], '', 'sequential')?.id).toBe('1');
    // 随机：池 [1,2,3]、current=2 时只可能在 {1,3} 里挑（rand 端点可预测）
    expect(pickNext([wall('1'), wall('2'), wall('3')], '2', 'random', () => 0)?.id).toBe('1');
    expect(pickNext([wall('1'), wall('2'), wall('3')], '2', 'random', () => 0.99)?.id).toBe('3');
  });
});

describe('buildRotationPool', () => {
  it('收藏 ≥2 时轮播池只用收藏；否则用全部非隐藏', () => {
    const list = [{ id: '1', type: 'scene' }, { id: '2', type: 'video' }, { id: '3', type: 'scene' }] as WallpaperInfo[];
    expect(buildRotationPool(list, { favorites: new Set(['1', '3']), hidden: new Set(), recent: {} }).map((w) => w.id)).toEqual(['1', '3']);
    expect(buildRotationPool(list, { favorites: new Set(['1']), hidden: new Set(['2']), recent: {} }).map((w) => w.id)).toEqual(['1', '3']);
  });

  it('非收藏池排除 unknown 类型（无法渲染的不参与轮播）', () => {
    expect(buildRotationPool([wall('1'), wall('2', 'unknown')], libState()).map((w) => w.id)).toEqual(['1']);
  });
});

describe('createRotationScheduler', () => {
  it('定时器按间隔触发、暂停/手动选择重置、failed 跳过', async () => {
    vi.useFakeTimers();
    const select = vi.fn(async () => {});
    const s = createRotationScheduler({
      getPool: () => [{ id: '1' }, { id: '2' }] as WallpaperInfo[],
      getCurrentId: () => '1',
      select,
      isPaused: () => false,
      intervalMs: 1000,
    });
    s.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(select).toHaveBeenCalledWith('2');
    s.markFailed('2');
    await vi.advanceTimersByTimeAsync(1000);
    expect(select).toHaveBeenLastCalledWith('1');
    s.stop();
  });

  it('status 报告启停/可轮播池/下次触发时间；stop 后不再触发', async () => {
    vi.useFakeTimers();
    const select = vi.fn(async () => {});
    const s = createRotationScheduler({
      getPool: poolTwo, getCurrentId: () => '1', select, isPaused: () => false, intervalMs: 1000,
    });
    s.start();
    expect(s.status()).toMatchObject({ enabled: true, poolSize: 2 });
    expect(s.status().nextInMs).toBeGreaterThan(0);
    expect(s.status().nextInMs).toBeLessThanOrEqual(1000);
    s.markFailed('2');
    expect(s.status().poolSize).toBe(1); // 本会话失败项不计入可轮播池
    s.stop();
    expect(s.status()).toEqual({ enabled: false, poolSize: 1, nextInMs: null });
    await vi.advanceTimersByTimeAsync(5000);
    expect(select).not.toHaveBeenCalled();
  });

  it('setConfig 改变间隔后按新间隔触发', async () => {
    vi.useFakeTimers();
    const select = vi.fn(async () => {});
    const s = createRotationScheduler({
      getPool: poolTwo, getCurrentId: () => '1', select, isPaused: () => false, intervalMs: 1000,
    });
    s.start();
    s.setConfig({ intervalMs: 500, order: 'sequential' });
    await vi.advanceTimersByTimeAsync(499);
    expect(select).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(select).toHaveBeenCalledWith('2');
    s.stop();
  });

  it('setPaused 暂停时不切换，恢复后继续', async () => {
    vi.useFakeTimers();
    const select = vi.fn(async () => {});
    const s = createRotationScheduler({
      getPool: poolTwo, getCurrentId: () => '1', select, isPaused: () => false, intervalMs: 1000,
    });
    s.start();
    s.setPaused(true);
    expect(s.status().enabled).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(select).not.toHaveBeenCalled();
    s.setPaused(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(select).toHaveBeenCalledWith('2');
    s.stop();
  });

  it('isPaused() 为 true 时 tick 不切换（计时继续排）', async () => {
    vi.useFakeTimers();
    let paused = true;
    const select = vi.fn(async () => {});
    const s = createRotationScheduler({
      getPool: poolTwo, getCurrentId: () => '1', select, isPaused: () => paused, intervalMs: 1000,
    });
    s.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(select).not.toHaveBeenCalled();
    paused = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(select).toHaveBeenCalledWith('2');
    s.stop();
  });

  it('单次切换抛错不终止轮播', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const select = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    });
    const s = createRotationScheduler({
      getPool: poolTwo, getCurrentId: () => '1', select, isPaused: () => false, intervalMs: 1000,
    });
    s.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(select).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(select).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('notifyManualSelect 清空失败记忆并重置计时', async () => {
    vi.useFakeTimers();
    const select = vi.fn(async () => {});
    const s = createRotationScheduler({
      getPool: poolTwo, getCurrentId: () => '1', select, isPaused: () => false, intervalMs: 1000,
    });
    s.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(select).toHaveBeenCalledTimes(1);
    s.markFailed('2');
    s.notifyManualSelect(); // 手动选择过 ⇒ 失败记忆清空、计时从此刻重排
    await vi.advanceTimersByTimeAsync(999);
    expect(select).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(select).toHaveBeenLastCalledWith('2');
    s.stop();
  });

  it('可轮播壁纸只有 1 张时不动', async () => {
    vi.useFakeTimers();
    const select = vi.fn(async () => {});
    const s = createRotationScheduler({
      getPool: () => [wall('1')], getCurrentId: () => '1', select, isPaused: () => false, intervalMs: 1000,
    });
    s.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(select).not.toHaveBeenCalled();
    s.stop();
  });
});

describe('rotation 兜底值', () => {
  it('normalizeRotationOrder 只认 random，其余回 sequential', () => {
    expect(normalizeRotationOrder('random')).toBe('random');
    expect(normalizeRotationOrder('bogus')).toBe('sequential');
    expect(normalizeRotationOrder(undefined)).toBe('sequential');
  });

  it('formatRotationInterval 按分钟展示，非法值回退 5 分钟', () => {
    expect(formatRotationInterval(60000)).toBe('1 分钟');
    expect(formatRotationInterval(600000)).toBe('10 分钟');
    expect(formatRotationInterval(Number.NaN)).toBe('5 分钟');
  });
});
