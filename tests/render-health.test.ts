import { describe, expect, it } from 'vitest';
import {
  HEALTH_KEY_PREFIX, createRenderHealthStore, formatHealthLine, isHardFailure,
} from '../src/client/render-health.js';

// 内存 storage：与 localStorage 同形（node 环境无 localStorage）。
function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
    dump: () => m,
  };
}

describe('render-health 分级', () => {
  it('硬失败 = 有证据表明这张壁纸渲染不出来', () => {
    expect(isHardFailure('scene-json')).toBe(true);
    expect(isHardFailure('no-visible-objects')).toBe(true);
    expect(isHardFailure('context-lost')).toBe(true);
    expect(isHardFailure('exception')).toBe(true);
    expect(isHardFailure('load-error')).toBe(false);
  });
});

describe('render-health 记忆', () => {
  it('硬失败落盘、可读回；软失败只进会话', () => {
    const s = memStorage();
    let clock = 1000;
    const store = createRenderHealthStore({ storage: s, now: () => (clock += 10) });
    store.recordHard('3303428996', 'no-visible-objects', 'background=0 particleLayers=0');
    store.recordSoft('3303428996', 'load-error', 'fetch threw');
    const snap = store.snapshot('3303428996');
    // 硬失败优先呈现（软失败是「这次没供上」，不覆盖已确认的硬结论）
    expect(snap.failure?.kind).toBe('no-visible-objects');
    expect(snap.failure?.hard).toBe(true);
    expect(s.dump().has(HEALTH_KEY_PREFIX + '3303428996')).toBe(true);
    // 软失败不得落盘：换一个 store 实例（模拟重开 App）只剩硬失败
    const reopened = createRenderHealthStore({ storage: s });
    expect(reopened.snapshot('3303428996').failure?.kind).toBe('no-visible-objects');
    reopened.clear('3303428996');
    expect(reopened.snapshot('3303428996').failure).toBeNull();
  });

  it('软失败在冷却后只自动重试一次', () => {
    let clock = 0;
    const store = createRenderHealthStore({ storage: null, now: () => clock, softCooldownMs: 3000 });
    store.recordSoft('1', 'load-error', 'network');
    expect(store.shouldAutoRetry('1')).toBe(false); // 冷却未到
    clock = 3000;
    expect(store.shouldAutoRetry('1')).toBe(true);
    store.markAutoRetried('1');
    expect(store.shouldAutoRetry('1')).toBe(false); // 每会话只一次
    // 硬失败不触发自动重试（重试同一张渲染不出来的壁纸只会重复失败）
    clock = 99999;
    store.recordHard('2', 'exception', 'boom');
    expect(store.shouldAutoRetry('2')).toBe(false);
  });

  it('recordOk 清软失败并记计时；硬失败保持到显式 clear', () => {
    const s = memStorage();
    const store = createRenderHealthStore({ storage: s });
    store.recordSoft('7', 'load-error', 'network');
    store.recordOk('7', { assembleMs: 120, firstFrameMs: 480 });
    const snap = store.snapshot('7');
    expect(snap.ok).toBe(true);
    expect(snap.failure).toBeNull();
    expect(snap.timing).toEqual({ assembleMs: 120, firstFrameMs: 480 });
    store.recordHard('7', 'scene-json', '404');
    expect(store.snapshot('7').ok).toBe(false);
    expect(store.snapshot('7').failure?.kind).toBe('scene-json');
  });

  it('clearAll 清掉全部记忆键（面板「清除失败记忆」）', () => {
    const s = memStorage();
    const store = createRenderHealthStore({ storage: s });
    store.recordHard('a', 'exception', 'x');
    store.recordHard('b', 'context-lost', 'y');
    store.clearAll();
    expect(store.snapshot('a').failure).toBeNull();
    expect(store.snapshot('b').failure).toBeNull();
    expect(s.dump().size).toBe(0);
  });

  it('storage 抛错（隐私模式/配额）不冒泡，退化为会话内记忆', () => {
    const throwing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
      key: () => null, length: 0,
    };
    const store = createRenderHealthStore({ storage: throwing });
    expect(() => store.recordHard('1', 'exception', 'x')).not.toThrow();
    expect(store.snapshot('1').failure?.kind).toBe('exception');
  });
});

describe('render-health 文案', () => {
  it('三种状态各有可读文案（不出现 undefined / 原始枚举）', () => {
    const store = createRenderHealthStore({ storage: null, now: () => 0 });
    const t = (s: string) => s;
    expect(formatHealthLine(store.snapshot('1'), t)).toContain('未渲染');
    store.recordOk('1', { assembleMs: 120, firstFrameMs: 480 });
    const okLine = formatHealthLine(store.snapshot('1'), t);
    expect(okLine).toContain('120');
    expect(okLine).toContain('480');
    store.recordHard('1', 'no-visible-objects', '');
    const line = formatHealthLine(store.snapshot('1'), t);
    expect(line).toContain('没有可显示的对象');
    expect(line).not.toContain('no-visible-objects');
  });
});
