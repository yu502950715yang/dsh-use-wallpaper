import { describe, expect, it } from 'vitest';
import { createMediaHealthStore } from '../src/client/media-health.js';

// 视频解码失败记忆（内存、不落盘）：面板只提示最近一条；重新选壁纸时清除。
describe('createMediaHealthStore', () => {
  it('set 记录最近一条失败与时间戳，get 读回', () => {
    const store = createMediaHealthStore();
    expect(store.get()).toBeNull();
    store.set('v1', 'unsupported');
    const first = store.get();
    expect(first).toMatchObject({ id: 'v1', kind: 'unsupported' });
    expect(typeof first!.at).toBe('number');
    // 只保留最近一条（不累积整段历史）
    store.set('v2', 'timeout');
    expect(store.get()).toMatchObject({ id: 'v2', kind: 'timeout' });
  });

  it('空 id 不记录（还没有可归属的壁纸）', () => {
    const store = createMediaHealthStore();
    store.set('', 'unsupported');
    expect(store.get()).toBeNull();
  });

  it('set/clear 通知订阅者，退订后不再收到；空态 clear 不重复通知', () => {
    const store = createMediaHealthStore();
    const seen: Array<{ id: string; kind: string; at: number } | null> = [];
    const off = store.subscribe((f) => seen.push(f));
    store.set('v1', 'unsupported');
    store.clear();
    store.clear();
    off();
    store.set('v2', 'timeout');
    expect(seen).toEqual([
      { id: 'v1', kind: 'unsupported', at: expect.any(Number) },
      null,
    ]);
  });
});
