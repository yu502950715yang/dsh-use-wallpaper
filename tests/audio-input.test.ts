// tests/audio-input.test.ts
// Task 3.2 音频输入管线：createAudioAnalyzer() 频谱分析器工厂。
// Task 3.4 壁纸音频播放：playWallpaperSound()（fetch + AudioBufferSourceNode 接分析器）。
// jsdom/node 环境均无 Web Audio API：测试在 globalThis 上注入 AudioContext / fetch mock，
// 断言分析器结构（fftSize 128 → 64 bin）、update() 填充频谱缓冲、音频图接线
// （T3.4 起 createAudioAnalyzer 把 analyser 接 destination，playWallpaperSound 把源接
// analyser）、以及播放失败静默 / autoplay 恢复行为；
// 无 AudioContext（含 webkitAudioContext）时返回 null（静音回退，EffectRunner 不回归）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAudioAnalyzer, playWallpaperSound } from '../src/client/audio-input.js';

// Mock AnalyserNode：getByteFrequencyData 把模拟频谱（i*5 mod 256）写入调用方数组。
// 语义对齐真实 Web Audio：frequencyBinCount = fftSize / 2（此处固定 64，对应 fftSize 128）。
// connect 自 T3.4 起被 createAudioAnalyzer 调用（analyser → destination 音频图汇点）。
function makeMockAnalyser() {
  return {
    fftSize: 0,
    frequencyBinCount: 64,
    connect: vi.fn(),
    getByteFrequencyData: vi.fn((arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) arr[i] = (i * 5) % 256;
    }),
  };
}

// 在 globalThis 注入 AudioContext mock，返回 mock analyser 与构造类（供实例断言）
function stubAudioContext() {
  const analyser = makeMockAnalyser();
  class MockAudioContext {
    destination = {}; // T3.4：createAudioAnalyzer 把 analyser 接到 destination
    analyser = analyser;
    createAnalyser() {
      return this.analyser;
    }
  }
  vi.stubGlobal('AudioContext', MockAudioContext);
  return { analyser, MockAudioContext };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext;
});

describe('createAudioAnalyzer（音频频谱分析器工厂）', () => {
  it('无 AudioContext / webkitAudioContext → 返回 null（静音回退，不阻断渲染）', () => {
    expect(createAudioAnalyzer()).toBeNull();
  });

  it('AudioContext 可用 → 创建分析器：analyser fftSize=128、freqData 64 bin、接 destination', () => {
    const { analyser, MockAudioContext } = stubAudioContext();
    const a = createAudioAnalyzer();
    expect(a).not.toBeNull();
    expect(a!.context).toBeInstanceOf(MockAudioContext);
    expect(a!.analyser).toBe(analyser);
    expect(analyser.fftSize).toBe(128); // fftSize 128 → frequencyBinCount 64
    expect(a!.freqData).toBeInstanceOf(Uint8Array);
    expect(a!.freqData.length).toBe(64);
    // T3.4：音频图汇点（analyser → destination）在创建期一次性接好，播放只需把源接 analyser
    expect(analyser.connect).toHaveBeenCalledWith(a!.context.destination);
  });

  it('update() 刷新频谱：getByteFrequencyData(freqData) 填充 64 bin 字节数据', () => {
    const { analyser } = stubAudioContext();
    const a = createAudioAnalyzer()!;
    a.update();
    expect(analyser.getByteFrequencyData).toHaveBeenCalledTimes(1);
    // 同一缓冲引用：scene-renderer 把 freqData 作为共享频谱源传给各 EffectRunner
    expect(analyser.getByteFrequencyData).toHaveBeenCalledWith(a.freqData);
    for (let i = 0; i < 64; i++) expect(a.freqData[i]).toBe((i * 5) % 256);
  });

  it('webkitAudioContext 回退：仅 webkit 前缀存在也能创建', () => {
    const analyser = makeMockAnalyser();
    class MockWebkitAudioContext {
      destination = {};
      analyser = analyser;
      createAnalyser() {
        return this.analyser;
      }
    }
    vi.stubGlobal('webkitAudioContext', MockWebkitAudioContext);
    const a = createAudioAnalyzer();
    expect(a).not.toBeNull();
    expect(a!.analyser).toBe(analyser);
    expect(a!.freqData.length).toBe(64);
    expect(analyser.connect).toHaveBeenCalledWith(a!.context.destination);
  });

  it('AudioContext 构造抛异常 → 返回 null（音频失败静默，不拖垮渲染）', () => {
    vi.stubGlobal('AudioContext', class {
      constructor() {
        throw new Error('blocked');
      }
    });
    expect(createAudioAnalyzer()).toBeNull();
  });
});

// T3.4 壁纸音频播放：playWallpaperSound(url, analyzer) —— fetch sound 资源 → 原始字节
// → decodeAudioData → AudioBufferSourceNode（loop 播放）→ 接入 analyser（频谱数据源；
// analyser → destination 已在 createAudioAnalyzer 接好，本函数只插源）。任何失败
// （fetch / 解码 / analyzer 缺失）→ 返回 false（静默，不阻断渲染）。autoplay 策略：
// context suspended → 立即尝试 resume（可能被拦）+ 一次性手势监听（用户首次
// pointerdown/keydown/touchstart 时重试恢复，恢复后自动卸载）。
describe('playWallpaperSound（壁纸音频播放，T3.4）', () => {
  // 最小 analyzer mock：context（state/decodeAudioData/createBufferSource/resume）
  // + analyser（复用 makeMockAnalyser）。source 模拟 AudioBufferSourceNode。
  function makeAnalyzer(opts: { state?: 'running' | 'suspended' } = {}) {
    const analyser = makeMockAnalyser();
    const source = {
      buffer: null as unknown,
      loop: false,
      connect: vi.fn(),
      start: vi.fn(),
    };
    const context = {
      state: opts.state ?? 'running',
      destination: {},
      decodeAudioData: vi.fn(async () => ({ length: 2, duration: 10 }) as AudioBuffer),
      createBufferSource: vi.fn(() => source),
      // 模拟 autoplay 拦截：resume 始终 reject（context 保持 suspended）
      resume: vi.fn(async () => { throw new DOMException('blocked', 'NotAllowedError'); }),
    };
    return { analyser, source, context };
  }

  // 默认成功 fetch（ok + 8B arrayBuffer）；resp 覆盖可模拟失败
  function stubFetch(resp?: Partial<Response>) {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
      ...resp,
    } as Response));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  // 最小 window mock（node 环境无 window）：记录/移除事件监听
  function stubWindow() {
    const listeners: Record<string, Array<() => void>> = {};
    const win = {
      addEventListener: vi.fn((t: string, fn: () => void) => { (listeners[t] ??= []).push(fn); }),
      removeEventListener: vi.fn((t: string, fn: () => void) => { listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn); }),
    };
    vi.stubGlobal('window', win);
    return { win, listeners };
  }

  it('成功路径：fetch → decode → source 接 analyser、loop=true、start，返回 true', async () => {
    stubFetch();
    const { analyser, source, context } = makeAnalyzer();
    const ok = await playWallpaperSound('/wallpapers/scene/1/asset?name=sounds/a.flac', { context, analyser } as any);
    expect(ok).toBe(true);
    expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(source.buffer).toEqual({ length: 2, duration: 10 }); // decode 结果挂到 source
    expect(source.loop).toBe(true);                              // WE 默认 loop 播放
    expect(source.connect).toHaveBeenCalledWith(analyser);       // 源 → 分析器（频谱数据）
    expect(source.start).toHaveBeenCalledTimes(1);
  });

  it('fetch 非 2xx → 返回 false，不解码不播放', async () => {
    stubFetch({ ok: false });
    const { analyser, source, context } = makeAnalyzer();
    expect(await playWallpaperSound('u', { context, analyser } as any)).toBe(false);
    expect(context.decodeAudioData).not.toHaveBeenCalled();
    expect(source.start).not.toHaveBeenCalled();
  });

  it('fetch 抛异常 → 返回 false（静默，不抛给调用方）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    const { analyser, context } = makeAnalyzer();
    expect(await playWallpaperSound('u', { context, analyser } as any)).toBe(false);
  });

  it('decodeAudioData 失败 → 返回 false，不播放', async () => {
    stubFetch();
    const { analyser, source, context } = makeAnalyzer();
    context.decodeAudioData.mockRejectedValueOnce(new Error('bad audio'));
    expect(await playWallpaperSound('u', { context, analyser } as any)).toBe(false);
    expect(source.start).not.toHaveBeenCalled();
  });

  it('analyzer 缺失（无 Web Audio）→ 返回 false（不抛错）', async () => {
    stubFetch();
    expect(await playWallpaperSound('u', null as any)).toBe(false);
  });

  it('context suspended（autoplay 拦截）→ 播放时立即尝试 resume（不阻塞播放返回）', async () => {
    stubFetch();
    const { analyser, context } = makeAnalyzer({ state: 'suspended' });
    const ok = await playWallpaperSound('u', { context, analyser } as any);
    expect(ok).toBe(true); // 播放本身成功入列，可听性取决于 resume
    expect(context.resume).toHaveBeenCalledTimes(1);
  });

  it('context running → 不调 resume', async () => {
    stubFetch();
    const { analyser, context } = makeAnalyzer({ state: 'running' });
    await playWallpaperSound('u', { context, analyser } as any);
    expect(context.resume).not.toHaveBeenCalled();
  });

  it('suspended → 注册一次性手势监听；用户手势触发恢复后三个监听全部卸载', async () => {
    stubFetch();
    const { win, listeners } = stubWindow();
    const { analyser, context } = makeAnalyzer({ state: 'suspended' });
    await playWallpaperSound('u', { context, analyser } as any);
    expect(win.addEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function));
    expect(win.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(win.addEventListener).toHaveBeenCalledWith('touchstart', expect.any(Function));
    // 手势触发 → 重试 resume（播放时 1 次 + 手势 1 次）；监听已卸载，重复触发不再恢复
    listeners.pointerdown?.[0]?.();
    listeners.keydown?.[0]?.();
    listeners.touchstart?.[0]?.();
    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(win.removeEventListener).toHaveBeenCalledTimes(3);
  });

  it('同一 context 多次播放（多 sound 共享分析器）→ 手势监听只注册一次', async () => {
    stubFetch();
    const { win } = stubWindow();
    const { analyser, context } = makeAnalyzer({ state: 'suspended' });
    await playWallpaperSound('u1', { context, analyser } as any);
    await playWallpaperSound('u2', { context, analyser } as any);
    expect(win.addEventListener).toHaveBeenCalledTimes(3); // 三事件各一次，不重复注册
  });
});
