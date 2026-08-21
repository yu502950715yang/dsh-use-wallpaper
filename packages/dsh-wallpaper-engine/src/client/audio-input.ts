// src/client/audio-input.ts
// 音频输入管线（Task 3.2）：AudioContext + AnalyserNode 频谱缓冲 → EffectRunner 音频 uniform。
// 壁纸音频播放（Task 3.4）会把 sound 源接入 context；本任务只建立频谱分析器——
// 无音频源时 getByteFrequencyData 返回全零 → EffectRunner 保持静音（与现状一致，不回归）。
export interface AudioAnalyzer {
  context: AudioContext;
  analyser: AnalyserNode;
  freqData: Uint8Array; // 频谱缓冲（fftSize 128 → 64 bin），字节 0-255
  update(): void;       // 刷新频谱：analyser.getByteFrequencyData(freqData)
}

type AudioContextCtor = new () => AudioContext;

// 特性检测：标准 AudioContext 优先，webkitAudioContext 回退（旧 Safari）
function resolveAudioContextCtor(): AudioContextCtor | null {
  const g = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

// 创建频谱分析器；无 Web Audio（旧浏览器/非浏览器环境）→ null（静音回退，不阻断渲染）。
export function createAudioAnalyzer(): AudioAnalyzer | null {
  const Ctor = resolveAudioContextCtor();
  if (!Ctor) return null;
  try {
    const context = new Ctor();
    const analyser = context.createAnalyser();
    // fftSize 128 → frequencyBinCount = 64 bins（对齐 WE 音频 uniform 最大 RESOLUTION=64）
    analyser.fftSize = 128;
    const freqData = new Uint8Array(analyser.frequencyBinCount);
    return {
      context,
      analyser,
      freqData,
      update() {
        analyser.getByteFrequencyData(freqData);
      },
    };
  } catch {
    // 构造失败（autoplay 限制 / 上下文数量上限等）→ 静音回退，不拖垮渲染
    return null;
  }
}
