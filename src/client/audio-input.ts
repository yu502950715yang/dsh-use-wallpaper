// src/client/audio-input.ts
// 音频输入管线（Task 3.2）：AudioContext + AnalyserNode 频谱缓冲 → EffectRunner 音频 uniform。
// 壁纸音频播放（Task 3.4）：playWallpaperSound 把 sound 源接入分析器——音频图汇点
// （analyser → destination）在创建期一次性接好；无音频源时 getByteFrequencyData
// 返回全零 → EffectRunner 保持静音（与现状一致，不回归）。
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
// T3.4：创建期把 analyser 接到 context.destination（音频图汇点，仅一次）——壁纸音频
// 播放（playWallpaperSound）只需把 AudioBufferSourceNode 插到 analyser 输入即可成链
// （source → analyser → destination），避免多 sound 各自重复连接 destination。
export function createAudioAnalyzer(): AudioAnalyzer | null {
  const Ctor = resolveAudioContextCtor();
  if (!Ctor) return null;
  try {
    const context = new Ctor();
    const analyser = context.createAnalyser();
    // fftSize 128 → frequencyBinCount = 64 bins（对齐 WE 音频 uniform 最大 RESOLUTION=64）
    analyser.fftSize = 128;
    analyser.connect(context.destination);
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

// 已安装手势恢复监听的 context 集合：每个 context 只注册一次（同一壁纸多 sound 共享
// 分析器；换壁纸换 context 后重新注册，旧 context close 后监听自然失效）
const gestureArmedContexts = new WeakSet<AudioContext>();

// autoplay 策略下 AudioContext 常被浏览器挂起（suspended），非用户手势调用 resume()
// 会被拒（NotAllowedError）——注册一次性全局手势监听（pointerdown/keydown/touchstart），
// 用户首次手势时重试恢复，恢复后卸载三个监听。窗口不存在（非浏览器环境）→ 跳过。
function armGestureResume(context: AudioContext): void {
  if (typeof window === 'undefined' || gestureArmedContexts.has(context)) return;
  gestureArmedContexts.add(context);
  const onGesture = () => {
    detach();
    if (context.state === 'suspended') context.resume().catch(() => {});
  };
  const detach = () => {
    window.removeEventListener('pointerdown', onGesture);
    window.removeEventListener('keydown', onGesture);
    window.removeEventListener('touchstart', onGesture);
  };
  window.addEventListener('pointerdown', onGesture);
  window.addEventListener('keydown', onGesture);
  window.addEventListener('touchstart', onGesture);
}

// T3.4 壁纸音频播放：fetch sound 资源 → decodeAudioData → AudioBufferSourceNode
// （loop 播放——WE playbackmode 实测 9/10 为 loop，"random"（2597392171）近似为单曲
// 循环；本接口只收 url，不携带 playbackmode/volume，保持最小）→ 接入 analyser
// （频谱可视化数据源，visualizer 条/频谱效果从此拿到真实数据）。
// 返回 true 表示成功入列；任何失败（fetch 错误 / 非 2xx / 解码失败 / analyzer 缺失）
// → false（静默，不阻断渲染，调用方 fire-and-forget）。
// autoplay：context suspended → 立即尝试 resume()（可能被拦，静默）+ 一次性手势监听
// 兜底（见 armGestureResume）；恢复前音频不可闻、频谱全零（可视化条保持静止）。
export async function playWallpaperSound(
  url: string,
  analyzer: { context: AudioContext; analyser: AnalyserNode },
): Promise<boolean> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return false;
    const buf = await resp.arrayBuffer();
    const audioBuffer = await analyzer.context.decodeAudioData(buf);
    const source = analyzer.context.createBufferSource();
    source.buffer = audioBuffer;
    source.loop = true; // WE 默认 loop 播放
    source.connect(analyzer.analyser);
    // autoplay 策略：context suspended → 立即尝试恢复；被拦时由用户手势兜底
    if (analyzer.context.state === 'suspended') {
      analyzer.context.resume().catch(() => {});
      armGestureResume(analyzer.context);
    }
    source.start();
    return true;
  } catch {
    // fetch/解码/无 Web Audio 等任何失败 → 静默返回 false（不抛错，不阻断渲染）
    return false;
  }
}
