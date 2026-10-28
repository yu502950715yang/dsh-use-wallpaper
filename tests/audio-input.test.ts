// tests/audio-input.test.ts
// Task 3.2 音频输入管线：createAudioAnalyzer() 频谱分析器工厂。
// Task 3.4 壁纸音频播放：playWallpaperSound()（小文件 decodeAudioData / >32MB <audio> 流式）。
// jsdom/node 环境均无 Web Audio API：测试在 globalThis 上注入 AudioContext / fetch / document，
// 断言分析器结构（fftSize 128 → 64 bin）、音频图接线、播放句柄 stop、失败静默与 autoplay 兜底；
// 无 AudioContext（含 webkitAudioContext）时返回 null（静音回退，EffectRunner 不回归）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAudioAnalyzer, LARGE_AUDIO_BYTES, playWallpaperSound } from '../src/client/audio-input.js';

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
    suspend = vi.fn(async () => {});
    resume = vi.fn(async () => {});
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

  // 省电暂停：最小化/切后台时挂起 AudioContext（解码路径的 source 随 context 时钟冻结），恢复后续播
  it('setSuspended：挂起调 context.suspend，恢复调 context.resume；被拒不抛', async () => {
    const { MockAudioContext } = stubAudioContext();
    const a = createAudioAnalyzer()!;
    const ctx = a.context as unknown as InstanceType<typeof MockAudioContext>;

    a.setSuspended(true);
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
    a.setSuspended(false);
    expect(ctx.resume).toHaveBeenCalledTimes(1);

    // 恢复可能被 autoplay 策略拒绝 → 静默（不抛、不阻断后续调用）
    (ctx.resume as unknown as { mockRejectedValueOnce: (e: unknown) => void }).mockRejectedValueOnce(new Error('blocked'));
    expect(() => a.setSuspended(false)).not.toThrow();
    await Promise.resolve();
  });
});

// T3.4/v0.8.1 壁纸音频播放：playWallpaperSound(url, analyzer, opts?) —— fetch sound 资源
// → 原始字节 → decodeAudioData → AudioBufferSourceNode → GainNode（音量）→ analyser
// （频谱数据源；analyser → destination 已在 createAudioAnalyzer 接好，本函数只插源与音量）。
// loop 由 opts.loop 控制（缺省 true = WE 默认）；任何失败（fetch / 解码 / analyzer 缺失）
// → 返回 null（静默，不阻断渲染）；成功返回 { stop } 句柄。autoplay 策略：context suspended
// → 立即尝试 resume（可能被拦）+ 一次性手势监听（用户首次 pointerdown/keydown/touchstart
// 时重试，恢复后自动卸载）；>32MB 音频改 <audio> 流式，handlers 见下方 large 用例。
describe('playWallpaperSound（壁纸音频播放，T3.4）', () => {
  // 最小 analyzer mock：context（state/decodeAudioData/createBufferSource/createGain/resume）
  // + analyser（复用 makeMockAnalyser）。source 模拟 AudioBufferSourceNode，
  // gain 模拟 GainNode（gain.gain.value 为音量）。
  function makeAnalyzer(opts: { state?: 'running' | 'suspended' } = {}) {
    const analyser = makeMockAnalyser();
    const source = {
      buffer: null as unknown,
      loop: false,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      disconnect: vi.fn(),
    };
    const gain = {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const context = {
      state: opts.state ?? 'running',
      destination: {},
      decodeAudioData: vi.fn(async () => ({ length: 2, duration: 10 }) as AudioBuffer),
      createBufferSource: vi.fn(() => source),
      createGain: vi.fn(() => gain),
      // 模拟 autoplay 拦截：resume 始终 reject（context 保持 suspended）
      resume: vi.fn(async () => { throw new DOMException('blocked', 'NotAllowedError'); }),
    };
    return { analyser, source, gain, context };
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

  // 大音频流式路径的 analyzer mock：多 createMediaElementSource + 可 resolve 的 resume
  function makeStreamingAnalyzer(opts: { state?: 'running' | 'suspended' } = {}) {
    const analyser = makeMockAnalyser();
    const mediaSource = { connect: vi.fn(), disconnect: vi.fn() };
    const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    const context = {
      state: opts.state ?? 'running',
      destination: {},
      createGain: vi.fn(() => gain),
      createMediaElementSource: vi.fn(() => mediaSource),
      resume: vi.fn(async () => {}),
    };
    return { analyser, mediaSource, gain, context };
  }

  // 最小 document/audio 元素 mock；play 行为可按用例覆盖
  function stubDocument(play?: () => Promise<void>) {
    const el: any = {
      src: '',
      loop: false,
      volume: 1,
      preload: '',
      style: {},
      play: vi.fn(play ?? (async () => {})),
      pause: vi.fn(),
      removeAttribute: vi.fn((name: string) => { if (name === 'src') el.src = ''; }),
      load: vi.fn(),
      remove: vi.fn(),
    };
    const body = { appendChild: vi.fn() };
    const createElement = vi.fn((tag: string) => {
      if (tag !== 'audio') throw new Error(`unexpected element: ${tag}`);
      return el;
    });
    vi.stubGlobal('document', { createElement, body });
    return { el, createElement, body };
  }

  // 大文件 fetch mock：content-length 超阈值；body.cancel 可断言被调用
  function stubLargeFetch(length = LARGE_AUDIO_BYTES + 1) {
    const cancel = vi.fn(async () => {});
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(8));
    const get = vi.fn((name: string) => (name === 'content-length' ? String(length) : null));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: { get },
      body: { cancel },
      arrayBuffer,
    } as unknown as Response));
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, cancel, arrayBuffer, get };
  }

  it('小文件成功路径：fetch → decode → source → gain → analyser、loop=true、start，返回 stop 句柄', async () => {
    stubFetch();
    const { analyser, source, gain, context } = makeAnalyzer();
    const handle = await playWallpaperSound('/wallpapers/scene/1/asset?name=sounds/a.flac', { context, analyser } as any);
    expect(handle).not.toBeNull();
    expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(source.buffer).toEqual({ length: 2, duration: 10 }); // decode 结果挂到 source
    expect(source.loop).toBe(true);                              // 缺省 loop=true（WE 默认）
    expect(gain.gain.value).toBe(1);                             // 缺省音量 1
    expect(source.connect).toHaveBeenCalledWith(gain);           // 源 → 音量 → 分析器
    expect(gain.connect).toHaveBeenCalledWith(analyser);
    expect(source.start).toHaveBeenCalledTimes(1);
    // stop：停源并断开音频图（幂等）
    handle!.stop();
    handle!.stop();
    expect(source.stop).toHaveBeenCalledTimes(1);
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(gain.disconnect).toHaveBeenCalledTimes(1);
  });

  it('opts：volume 经 GainNode 生效，loop 可关闭（single 播放模式）', async () => {
    stubFetch();
    const { analyser, source, gain, context } = makeAnalyzer();
    const handle = await playWallpaperSound('u', { context, analyser } as any, { volume: 0.31, loop: false });
    expect(handle).not.toBeNull();
    expect(gain.gain.value).toBeCloseTo(0.31, 5);
    expect(source.loop).toBe(false);
    expect(source.connect).toHaveBeenCalledWith(gain);           // source → gain → analyser
    expect(gain.connect).toHaveBeenCalledWith(analyser);
  });

  it('fetch 非 2xx → 返回 null，不解码不播放', async () => {
    stubFetch({ ok: false });
    const { analyser, source, context } = makeAnalyzer();
    expect(await playWallpaperSound('u', { context, analyser } as any)).toBeNull();
    expect(context.decodeAudioData).not.toHaveBeenCalled();
    expect(source.start).not.toHaveBeenCalled();
  });

  it('fetch 抛异常 → 返回 null（静默，不抛给调用方）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    const { analyser, context } = makeAnalyzer();
    expect(await playWallpaperSound('u', { context, analyser } as any)).toBeNull();
  });

  it('decodeAudioData 失败 → 返回 null，不播放', async () => {
    stubFetch();
    const { analyser, source, context } = makeAnalyzer();
    context.decodeAudioData.mockRejectedValueOnce(new Error('bad audio'));
    expect(await playWallpaperSound('u', { context, analyser } as any)).toBeNull();
    expect(source.start).not.toHaveBeenCalled();
  });

  it('analyzer 缺失（无 Web Audio）→ 返回 null（不抛错）', async () => {
    stubFetch();
    expect(await playWallpaperSound('u', null as any)).toBeNull();
  });

  it('context suspended（autoplay 拦截）→ 播放时立即尝试 resume（不阻塞播放返回）', async () => {
    stubFetch();
    const { analyser, context } = makeAnalyzer({ state: 'suspended' });
    const handle = await playWallpaperSound('u', { context, analyser } as any);
    expect(handle).not.toBeNull(); // 播放本身成功入列，可听性取决于 resume
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

  // ── 统一 <audio> 流式（Crimson 132MB mp3：整块解码不可行）────────────────────────
  it('统一 <audio> 流式：不先 fetch 探测大小，元素创建/挂载/播放/停止', async () => {
    const { el, createElement, body } = stubDocument();
    const { analyser, mediaSource, gain, context } = makeStreamingAnalyzer();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const url = '/wallpapers/scene/9/asset?name=sounds/a.mp3';
    const handle = await playWallpaperSound(url, { context, analyser } as any, { volume: 0.4, loop: false });
    expect(handle).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled(); // 流式不再整块 fetch（content-length 不可靠）
    expect(createElement).toHaveBeenCalledWith('audio');
    expect(el.src).toBe(url);
    expect(el.loop).toBe(false);
    expect(el.volume).toBeCloseTo(0.4, 5);
    expect(context.createMediaElementSource).toHaveBeenCalledWith(el);
    expect(body.appendChild).toHaveBeenCalledWith(el); // 挂进 DOM：生命周期稳定 + DevTools 可查
    expect(mediaSource.connect).toHaveBeenCalledWith(gain); // source → gain → analyser
    expect(gain.connect).toHaveBeenCalledWith(analyser);
    expect(el.play).toHaveBeenCalledTimes(1);
    handle!.stop();
    handle!.stop();
    expect(el.pause).toHaveBeenCalledTimes(1);
    expect(el.removeAttribute).toHaveBeenCalledWith('src');
    expect(el.load).toHaveBeenCalledTimes(1);
    expect(el.remove).toHaveBeenCalledTimes(1);
    expect(mediaSource.disconnect).toHaveBeenCalledTimes(1);
    expect(gain.disconnect).toHaveBeenCalledTimes(1);
  });

  // 省电暂停：流式元素本身也要停（context.suspend 不会让 MediaElement 的时钟停下）
  it('流式句柄 pause/resume：<audio> 暂停与续播；stop 后不再复活', async () => {
    const { el } = stubDocument();
    const { analyser, context } = makeStreamingAnalyzer();
    const handle = await playWallpaperSound('u', { context, analyser } as any);
    expect(handle).not.toBeNull();
    expect(handle!.pause).toBeTypeOf('function');
    expect(handle!.resume).toBeTypeOf('function');

    handle!.pause!();
    expect(el.pause).toHaveBeenCalledTimes(1);
    handle!.resume!();
    expect(el.play).toHaveBeenCalledTimes(2); // 创建期 1 次 + 续播 1 次

    handle!.stop();
    (el.pause as any).mockClear();
    (el.play as any).mockClear();
    handle!.pause!();
    handle!.resume!();
    expect(el.pause).not.toHaveBeenCalled(); // 已停止：不得再碰元素
    expect(el.play).not.toHaveBeenCalled();
  });

  it('流式不可用（无 createMediaElementSource）→ 回退整块解码播放', async () => {
    stubFetch();
    const { analyser, source, context } = makeAnalyzer();
    const handle = await playWallpaperSound('u', { context, analyser } as any, { volume: 0.31 });
    expect(handle).not.toBeNull();
    expect(context.decodeAudioData).toHaveBeenCalledTimes(1); // 回退 decode
    expect(source.start).toHaveBeenCalledTimes(1);
    handle!.stop();
  });

  it('大音频 play 成功但 context suspended → 仍注册手势恢复（否则元素在播但音频图静音）', async () => {
    stubLargeFetch();
    const { listeners } = stubWindow();
    stubDocument();
    const { analyser, context } = makeStreamingAnalyzer({ state: 'suspended' });
    const handle = await playWallpaperSound('u', { context, analyser } as any);
    expect(handle).not.toBeNull();
    expect(context.resume).toHaveBeenCalledTimes(1); // 立即尝试恢复
    expect(listeners.pointerdown?.length).toBe(1);   // 且注册了手势兜底
    listeners.pointerdown![0]();
    await Promise.resolve();
    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(listeners.pointerdown?.length ?? 0).toBe(0);
    handle!.stop();
  });

  it('大音频 el.play() 被 autoplay 拒绝 → warn + 注册一次性手势重试 play，成功后卸载监听', async () => {
    stubLargeFetch();
    const { listeners } = stubWindow();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const play = vi.fn()
      .mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'))
      .mockResolvedValueOnce(undefined);
    const { el } = stubDocument(play as () => Promise<void>);
    const { analyser, context } = makeStreamingAnalyzer({ state: 'suspended' });
    try {
      const handle = await playWallpaperSound('u', { context, analyser } as any);
      expect(handle).not.toBeNull(); // 拦截不视为失败，等手势
      expect(el.loop).toBe(true);    // 缺省 loop=true
      expect(el.volume).toBe(1);     // 缺省音量 1
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('被浏览器拦截'));
      expect(context.resume).toHaveBeenCalledTimes(1);
      // armGesturePlay 与 armGestureResume 各注册一组监听
      expect(listeners.pointerdown?.length).toBe(2);
      const fns = [...listeners.pointerdown!];
      fns.forEach((fn) => fn());
      await Promise.resolve();
      await Promise.resolve();
      expect(play).toHaveBeenCalledTimes(2);          // 手势重试 play
      expect(context.resume.mock.calls.length).toBeGreaterThanOrEqual(2); // 手势恢复 suspended context
      expect(listeners.pointerdown?.length ?? 0).toBe(0);
      expect(listeners.keydown?.length ?? 0).toBe(0);
      expect(listeners.touchstart?.length ?? 0).toBe(0);
      handle!.stop();
    } finally {
      warn.mockRestore();
    }
  });

  it('流式失败且文件过大 → 返回 null + 两条 warn，不回退解码', async () => {
    const declared = LARGE_AUDIO_BYTES + 7;
    stubLargeFetch(declared);
    const { el } = stubDocument(async () => { throw new Error('bad media'); });
    const { analyser, mediaSource, context } = makeStreamingAnalyzer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await playWallpaperSound('u', { context, analyser } as any)).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('音频流式播放失败，回退整块解码'),
        expect.any(Error),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('音频播放失败（流式与解码均失败）'),
        expect.any(Error),
      );
      expect(el.pause).toHaveBeenCalledTimes(1);
      expect(el.removeAttribute).toHaveBeenCalledWith('src');
      expect(el.load).toHaveBeenCalledTimes(1);
      expect(mediaSource.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('流式与解码都不可用（非浏览器无 document）→ 返回 null + warn，不抛错', async () => {
    stubLargeFetch();
    const { analyser, context } = makeStreamingAnalyzer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await playWallpaperSound('u', { context, analyser } as any)).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('音频播放失败（流式与解码均失败）'),
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
