// src/client/system-audio.ts
// 系统音频采集（v0.9 P1）：浏览器 getDisplayMedia 捕获系统/标签页音频 → 独立 AnalyserNode。
// 桌面版 App（Electron）主进程禁用了 display media 与设备权限（setPermissionCheckHandler(false)、
// setDisplayMediaRequestHandler 回调空 sources）⇒ 失败开放，由面板提示改用浏览器打开 GUI。
export type SystemAudioFailure = 'unsupported' | 'denied' | 'no-audio-track' | 'no-web-audio' | 'error';

export interface SystemAudioCapture {
  context: AudioContext;
  analyser: AnalyserNode;
  freqData: Uint8Array; // 64 bins（fftSize 128），字节 0-255
  stream: MediaStream;
  update(): void;
  stop(): void;
}

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const g = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

function stopTracks(stream: MediaStream): void {
  try {
    for (const t of stream.getTracks()) t.stop();
  } catch {
    // 已停止/畸形流：忽略（收尾不抛）
  }
}

// 启动系统音频捕获。成功 → capture（调用方负责 stop）；失败 → 分类原因（失败开放，不抛）。
// onEnded：用户点浏览器的「停止共享」或轨道结束后续调（调用方据此清 UI 状态）。
export async function startSystemAudioCapture(
  onEnded?: () => void,
): Promise<SystemAudioCapture | SystemAudioFailure> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) return 'unsupported';
  const Ctor = audioContextCtor();
  if (!Ctor) return 'no-web-audio';
  // video:true 是 Chromium 弹出「共享音频」选项的前提；捕获后只消费 audio track（video 不渲染）。
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
    if (name === 'NotSupportedError' || name === 'TypeError') return 'unsupported';
    return 'error';
  }
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) {
    stopTracks(stream);
    return 'no-audio-track';
  }
  let context: AudioContext;
  try {
    context = new Ctor();
  } catch {
    stopTracks(stream);
    return 'no-web-audio';
  }
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      audioTrack.onended = null;
    } catch {
      // 忽略
    }
    stopTracks(stream);
    void context.close().catch(() => {});
    onEnded?.();
  };
  try {
    // 独立 AudioContext（与包内 sound 的分析器隔离）：source → analyser → 静音 Gain → destination。
    // 静音汇点保证音频图被拉取，同时不把系统音频再播一遍（否则回声）。
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 128;
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(analyser);
    analyser.connect(silent);
    silent.connect(context.destination);
    const freqData = new Uint8Array(analyser.frequencyBinCount);
    audioTrack.onended = () => stop();
    void context.resume().catch(() => {});
    return {
      context,
      analyser,
      freqData,
      stream,
      update() {
        analyser.getByteFrequencyData(freqData);
      },
      stop,
    };
  } catch {
    stopTracks(stream);
    void context.close().catch(() => {});
    return 'error';
  }
}
