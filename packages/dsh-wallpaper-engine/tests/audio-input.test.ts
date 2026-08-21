// tests/audio-input.test.ts
// Task 3.2 音频输入管线：createAudioAnalyzer() 频谱分析器工厂。
// jsdom/node 环境均无 Web Audio API：测试在 globalThis 上注入 AudioContext mock，
// 断言分析器结构（fftSize 128 → 64 bin）与 update() 填充频谱缓冲的行为；
// 无 AudioContext（含 webkitAudioContext）时返回 null（静音回退，EffectRunner 不回归）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAudioAnalyzer } from '../src/client/audio-input.js';

// Mock AnalyserNode：getByteFrequencyData 把模拟频谱（i*5 mod 256）写入调用方数组。
// 语义对齐真实 Web Audio：frequencyBinCount = fftSize / 2（此处固定 64，对应 fftSize 128）。
function makeMockAnalyser() {
  return {
    fftSize: 0,
    frequencyBinCount: 64,
    getByteFrequencyData: vi.fn((arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) arr[i] = (i * 5) % 256;
    }),
  };
}

// 在 globalThis 注入 AudioContext mock，返回 mock analyser 与构造类（供实例断言）
function stubAudioContext() {
  const analyser = makeMockAnalyser();
  class MockAudioContext {
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

  it('AudioContext 可用 → 创建分析器：analyser fftSize=128、freqData 64 bin', () => {
    const { analyser, MockAudioContext } = stubAudioContext();
    const a = createAudioAnalyzer();
    expect(a).not.toBeNull();
    expect(a!.context).toBeInstanceOf(MockAudioContext);
    expect(a!.analyser).toBe(analyser);
    expect(analyser.fftSize).toBe(128); // fftSize 128 → frequencyBinCount 64
    expect(a!.freqData).toBeInstanceOf(Uint8Array);
    expect(a!.freqData.length).toBe(64);
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
