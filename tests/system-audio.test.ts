import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSystemAudioCapture } from '../src/client/system-audio.js';

// 系统音频采集（v0.9 P1）：失败分类 + 成功路径的接线/清理（Web Audio 用最小 stub）。
function audioContextStub() {
  const analyser = {
    fftSize: 0,
    frequencyBinCount: 64,
    getByteFrequencyData: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const ctx = {
    createAnalyser: vi.fn(() => analyser),
    createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    destination: {},
  };
  return { ctx, analyser };
}

function streamStub(withAudio: boolean) {
  const audioTrack = {
    stop: vi.fn(),
    onended: null as (() => void) | null,
  };
  const videoTrack = { stop: vi.fn() };
  return {
    stream: {
      getAudioTracks: () => (withAudio ? [audioTrack] : []),
      getTracks: () => (withAudio ? [audioTrack, videoTrack] : [videoTrack]),
    },
    audioTrack,
  };
}

function stubEnv(opts: {
  displayMedia?: () => Promise<unknown>;
  withAudioContext?: boolean;
}) {
  const getDisplayMedia = vi.fn(opts.displayMedia ?? (async () => streamStub(true).stream));
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
  if (opts.withAudioContext === false) vi.stubGlobal('AudioContext', undefined);
  else {
    vi.stubGlobal('AudioContext', function AudioContextStub(this: unknown) {
      return audioContextStub().ctx;
    });
  }
  return { getDisplayMedia };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startSystemAudioCapture（失败分类）', () => {
  it('无 navigator.mediaDevices.getDisplayMedia → unsupported', async () => {
    vi.stubGlobal('navigator', {});
    expect(await startSystemAudioCapture()).toBe('unsupported');
  });

  it('无 AudioContext → no-web-audio', async () => {
    stubEnv({ withAudioContext: false });
    expect(await startSystemAudioCapture()).toBe('no-web-audio');
  });

  it('用户拒绝授权（NotAllowedError）→ denied', async () => {
    stubEnv({
      displayMedia: async () => {
        const e = new Error('denied');
        e.name = 'NotAllowedError';
        throw e;
      },
    });
    expect(await startSystemAudioCapture()).toBe('denied');
  });

  it('宿主不支持（NotSupportedError，桌面 App 禁用）→ unsupported', async () => {
    stubEnv({
      displayMedia: async () => {
        const e = new Error('unsupported');
        e.name = 'NotSupportedError';
        throw e;
      },
    });
    expect(await startSystemAudioCapture()).toBe('unsupported');
  });

  it('只共享画面无音频轨 → no-audio-track 且停掉轨道', async () => {
    const s = streamStub(false);
    stubEnv({ displayMedia: async () => s.stream });
    expect(await startSystemAudioCapture()).toBe('no-audio-track');
    for (const t of s.stream.getTracks()) expect(t.stop).toHaveBeenCalled();
  });
});

describe('startSystemAudioCapture（成功路径）', () => {
  it('返回 capture：update 读频谱、stop 停轨/关上下文/回调 onEnded', async () => {
    const s = streamStub(true);
    stubEnv({ displayMedia: async () => s.stream });
    const onEnded = vi.fn();
    const result = await startSystemAudioCapture(onEnded);
    expect(typeof result).toBe('object');
    if (typeof result === 'string') throw new Error('expected capture, got ' + result);
    expect(result.freqData).toHaveLength(64);
    result.update();
    // 轨道结束（用户点「停止共享」）→ 自动清理并回调
    s.audioTrack.onended?.();
    expect(onEnded).toHaveBeenCalledTimes(1);
    for (const t of s.stream.getTracks()) expect(t.stop).toHaveBeenCalled();
    result.stop(); // 幂等：重复 stop 不再触发 onEnded / 不再重复关闭
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('外部 stop → 停轨 + 关 AudioContext', async () => {
    const s = streamStub(true);
    const { ctx } = audioContextStub();
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn(async () => s.stream) } });
    vi.stubGlobal('AudioContext', function AudioContextStub() { return ctx; });
    const result = await startSystemAudioCapture();
    if (typeof result === 'string') throw new Error('expected capture');
    result.stop();
    expect(ctx.close).toHaveBeenCalled();
    for (const t of s.stream.getTracks()) expect(t.stop).toHaveBeenCalled();
  });

  it('连接失败（createMediaStreamSource 抛错）→ error 且释放', async () => {
    const s = streamStub(true);
    const { ctx } = audioContextStub();
    ctx.createMediaStreamSource.mockImplementation(() => {
      throw new Error('bad stream');
    });
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn(async () => s.stream) } });
    vi.stubGlobal('AudioContext', function AudioContextStub() { return ctx; });
    expect(await startSystemAudioCapture()).toBe('error');
    for (const t of s.stream.getTracks()) expect(t.stop).toHaveBeenCalled();
  });
});
