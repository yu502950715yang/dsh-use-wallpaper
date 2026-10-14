import { describe, expect, it } from 'vitest';
import {
  HEALTH_KEY_PREFIX, HARD_KINDS, createRenderHealthStore, formatHealthLine, isHardFailure,
} from '../src/client/render-health.js';
import type { FailureKind } from '../src/client/render-health.js';

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

  // HARD_KINDS 是 HardFailureKind 的**唯一声明**（类型由它派生）⇒ 直接断言这份集合本身，
  // 不再复制字面量（旧写法断言的是局部数组，isHardFailure 恒真也照样绿）。
  it('硬失败种类 = HARD_KINDS 的完整投影，且软失败种类不得被判硬', () => {
    expect([...HARD_KINDS].sort()).toEqual(['context-lost', 'exception', 'no-visible-objects', 'scene-json']);
    expect(HARD_KINDS.every((k) => isHardFailure(k))).toBe(true);
    // 反向：'load-error' 必须是软失败（恒真的 isHardFailure 会让这条红）
    expect(isHardFailure('load-error')).toBe(false);
    const all: FailureKind[] = [...HARD_KINDS, 'load-error'];
    expect(all.filter((k) => isHardFailure(k))).toEqual([...HARD_KINDS]);
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
    // ok = 最近一次装配结果（仍是 true）；硬记忆只进 failure —— 硬失败不再把 ok 钉死。
    expect(store.snapshot('7').ok).toBe(true);
    expect(store.snapshot('7').failure?.kind).toBe('scene-json');
  });

  it('recordHard 单独发生（本次会话还没装配过）⇒ ok 为 null，不伪造 false', () => {
    const store = createRenderHealthStore({ storage: null });
    store.recordHard('8', 'no-visible-objects', '空场景');
    const snap = store.snapshot('8');
    expect(snap.ok).toBeNull(); // 「还没装配过」与「装配失败」是两件事
    expect(snap.failure?.kind).toBe('no-visible-objects');
    expect(snap.failure?.hard).toBe(true);
  });

  it('recordHard → recordOk：现在正常 + 曾硬失败可并存（面板两行设计要用的状态）', () => {
    const store = createRenderHealthStore({ storage: null });
    store.recordHard('9', 'context-lost', 'webglcontextlost');
    store.recordOk('9', { assembleMs: 200, firstFrameMs: 260 });
    const snap = store.snapshot('9');
    expect(snap.ok).toBe(true);
    expect(snap.failure?.kind).toBe('context-lost');
    expect(snap.failure?.hard).toBe(true); // 硬记忆不因一次成功而消失（要显式 clear）
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

  it('clearAll 只清失败记忆，不抹掉「现在正常」与计时', () => {
    const store = createRenderHealthStore({ storage: null });
    store.recordHard('c', 'exception', 'x');
    store.recordOk('c', { assembleMs: 120, firstFrameMs: 480 });
    store.clearAll();
    const snap = store.snapshot('c');
    expect(snap.failure).toBeNull();
    expect(snap.ok).toBe(true); // 成功结论不是失败记忆
    expect(snap.timing).toEqual({ assembleMs: 120, firstFrameMs: 480 });
  });

  // Minor 12：硬失败落盘的唯一用途 —— 新实例（重开 App / 另一窗口）只从 storage 读得到它。
  it('跨实例读回的硬记忆同样拦住自动重试（落盘硬记忆 + 本次软失败）', () => {
    const s = memStorage();
    s.setItem(HEALTH_KEY_PREFIX + 'x', JSON.stringify({ v: 1, kind: 'scene-json', detail: '404', at: 0 }));
    const store = createRenderHealthStore({ storage: s, now: () => 99999, softCooldownMs: 0 });
    store.recordSoft('x', 'load-error', '断流');
    expect(store.shouldAutoRetry('x')).toBe(false);
    // 对照：同一份软失败、没有硬记忆 ⇒ 冷却已过就该重试。
    const plain = createRenderHealthStore({ storage: memStorage(), now: () => 99999, softCooldownMs: 0 });
    plain.recordSoft('x', 'load-error', '断流');
    expect(plain.shouldAutoRetry('x')).toBe(true);
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

  it('首帧未出（-1）时不渲染「首帧」字段，装配耗时照常', () => {
    const t = (s: string) => s;
    // 暂停态下首帧可能长期不出；初值 -1 直接进文案就是「首帧 -1 ms」。
    const line = formatHealthLine(
      { wallpaperId: '1', ok: true, failure: null, timing: { assembleMs: 120, firstFrameMs: -1 } },
      t,
    );
    expect(line).toContain('装配 120 ms');
    expect(line).not.toContain('首帧');
    expect(line).not.toContain('-1');
  });
});
