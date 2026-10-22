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

// 播放句柄：stop 停声并断开音频图（小文件停 AudioBufferSource，大文件停 <audio>）
export interface PlaybackHandle {
  stop(): void;
}

// 大音频阈值：超过后不整块解码（Crimson 的 132MB 睡眠音乐 decode 需要 GB 级 PCM）
export const LARGE_AUDIO_BYTES = 32 * 1024 * 1024;

type SoundAnalyzer = { context: AudioContext; analyser: AnalyserNode };

// 一次性手势重试 el.play()（autoplay 拦截）；成功/停止时卸载三个监听
function armGesturePlay(el: HTMLAudioElement, context: AudioContext): () => void {
  if (typeof window === 'undefined') return () => {};
  const detach = () => {
    window.removeEventListener('pointerdown', onGesture);
    window.removeEventListener('keydown', onGesture);
    window.removeEventListener('touchstart', onGesture);
  };
  const onGesture = () => {
    detach();
    if (context.state === 'suspended') context.resume().catch(() => {});
    void el.play().catch(() => {});
  };
  window.addEventListener('pointerdown', onGesture);
  window.addEventListener('keydown', onGesture);
  window.addEventListener('touchstart', onGesture);
  return detach;
}

// 流式链路：<audio> → MediaElementSource → Gain（音量）→ analyser。浏览器原生流式解码，
// 不依赖 content-length/整块 fetch（132MB 大音频也能播）；autoplay 拦截不视为失败（等手势）。
async function playStreamingSound(
  url: string,
  analyzer: SoundAnalyzer,
  opts: { volume?: number; loop?: boolean } | undefined,
): Promise<PlaybackHandle> {
  if (typeof document === 'undefined') throw new Error('no document');
  const el = document.createElement('audio');
  el.src = url;
  el.loop = opts?.loop !== false;
  el.volume = opts?.volume ?? 1;
  el.preload = 'auto';
  const context = analyzer.context;
  let source: MediaElementAudioSourceNode | null = null;
  let gain: GainNode | null = null;
  let disarm: (() => void) | null = null;
  let stopped = false;
  const teardown = () => {
    disarm?.();
    disarm = null;
    try { el.pause(); } catch { /* 元素已释放 */ }
    el.removeAttribute('src');
    try { el.load(); } catch { /* 元素已释放 */ }
    try { el.remove(); } catch { /* 元素未插入 */ }
    try { source?.disconnect(); } catch { /* 节点已断 */ }
    try { gain?.disconnect(); } catch { /* 节点已断 */ }
  };
  try {
    source = context.createMediaElementSource(el);
    gain = context.createGain();
    gain.gain.value = opts?.volume ?? 1;
    source.connect(gain);
    gain.connect(analyzer.analyser);
    // 与 decode 路径一致：suspended 先 resume + 注册手势兜底；缺这步会「元素在播但音频图静音」
    if (context.state === 'suspended') {
      context.resume().catch(() => {});
      armGestureResume(context);
    }
    // 元素挂进 DOM（生命周期稳定 + DevTools 可查）；stop 时移除
    try { el.style.display = 'none'; } catch { /* 元素无 style */ }
    if (typeof document !== 'undefined' && document.body) document.body.appendChild(el);
    // 诊断快照：DevTools 里 `__weAudioDebug` 可看 paused/currentTime/contextState（元素由句柄持有）
    const w = globalThis as unknown as { __weAudioDebug?: unknown };
    w.__weAudioDebug = {
      url, get paused() { return el.paused; }, get muted() { return el.muted; },
      get volume() { return el.volume; }, get currentTime() { return el.currentTime; },
      get readyState() { return el.readyState; }, get error() { return el.error?.code ?? null; },
      get contextState() { return context.state; }, get connected() { return el.isConnected; },
    };
    try {
      await el.play();
    } catch (err) {
      // 仅 autoplay 拦截走手势重试；格式/网络错误按失败上报（由调用方回退解码）
      if ((err as { name?: string } | null)?.name !== 'NotAllowedError') throw err;
      console.warn('[wallpaper-engine] 壁纸音频播放被浏览器拦截（需要用户手势），已注册手势重试');
      disarm = armGesturePlay(el, context);
    }
    // 诊断：Console 过滤 `[wallpaper-engine]` 可见（含 context 状态；`__weAudioDebug` 可看实时值）
    console.info('[wallpaper-engine] 壁纸音频流式播放已启动', {
      url: url.slice(-60), contextState: context.state, volume: el.volume, loop: el.loop,
    });
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        teardown();
      },
    };
  } catch (err) {
    teardown();
    throw err;
  }
}

// 回退链路：小文件整块解码（浏览器 <audio> 不支持的格式等）；>32MB 不做（decode 不可行）
async function playDecodedSound(
  url: string,
  analyzer: SoundAnalyzer,
  opts: { volume?: number; loop?: boolean } | undefined,
): Promise<PlaybackHandle> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`http ${resp.status}`);
  const declared = Number(resp.headers?.get?.('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > LARGE_AUDIO_BYTES) throw new Error('too large to decode');
  const buf = await resp.arrayBuffer();
  const audioBuffer = await analyzer.context.decodeAudioData(buf);
  const source = analyzer.context.createBufferSource();
  source.buffer = audioBuffer;
  source.loop = opts?.loop !== false;
  // 音量经 GainNode 生效（OWE 在 PCM 上乘 volume，GainNode 等价）：source → gain → analyser
  const gain = analyzer.context.createGain();
  gain.gain.value = opts?.volume ?? 1;
  source.connect(gain);
  gain.connect(analyzer.analyser);
  // autoplay 策略：context suspended → 立即尝试恢复；被拦时由用户手势兜底
  if (analyzer.context.state === 'suspended') {
    analyzer.context.resume().catch(() => {});
    armGestureResume(analyzer.context);
  }
  source.start();
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { source.stop(); } catch { /* 未起播/已停止 */ }
      try { source.disconnect(); } catch { /* 节点已断 */ }
      try { gain.disconnect(); } catch { /* 节点已断 */ }
    },
  };
}

// 壁纸音频播放（T3.4/v0.8.1）：统一走 <audio> 流式（浏览器原生流式解码，大小无上限，不再
// 依赖 content-length/整块 fetch）；流式不可用（格式不支持等）且文件较小 → 回退 decodeAudioData。
// 失败 → null（不阻断渲染）。autoplay：suspended 立即 resume() + 一次性手势兜底。
export async function playWallpaperSound(
  url: string,
  analyzer: SoundAnalyzer | null,
  opts?: { volume?: number; loop?: boolean },
): Promise<PlaybackHandle | null> {
  if (!analyzer?.context || !analyzer.analyser) return null;
  try {
    return await playStreamingSound(url, analyzer, opts);
  } catch (streamErr) {
    console.warn('[wallpaper-engine] 音频流式播放失败，回退整块解码', streamErr);
    try {
      return await playDecodedSound(url, analyzer, opts);
    } catch (decodeErr) {
      console.warn('[wallpaper-engine] 音频播放失败（流式与解码均失败）', decodeErr);
      return null;
    }
  }
}
