// client 媒体轮询总线：1s 拉 now-playing 快照，仅快照变化时回调；连续失败退避 10s。
// 纯函数 diff/mediaUrl/applyMediaSnapshot/sceneNeedsMedia 独立可测；定时器与 fetch 可注入（测试不碰真实网络/时钟）。
import type { MediaPalette, MediaPropertiesPayload, MediaSessionSnapshot } from '../shared/media.js';
import type { SceneDescription } from '../shared/types.js';

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_BACKOFF_MS = 10_000;
const FAILURES_BEFORE_BACKOFF = 3;
const DIFF_KEYS = [
  'available',
  'reason',
  'appId',
  'contentType',
  'playback',
  'title',
  'artist',
  'album',
  'hasThumbnail',
  'thumbnailRev',
] as const;

export interface MediaInputOptions {
  fetchImpl?: (url: string) => Promise<{ ok: boolean; json(): Promise<MediaSessionSnapshot> }>;
  pageTitle?: () => string;
  intervalMs?: number;
  backoffMs?: number;
  setIntervalImpl?: (fn: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
  onSnapshot: (next: MediaSessionSnapshot, prev: MediaSessionSnapshot | null) => void;
  onError?: (error: unknown) => void;
}

export interface MediaInput {
  /** 启动轮询（已启动则 no-op）；立即拉一次，之后按 1s/退避间隔。 */
  start(): void;
  /** 停止轮询并清定时器；`failures` 保留（重新 start 仍按退避档起步，避免抖动时打爆 host）。 */
  stop(): void;
  /** 暂停期间不发请求；恢复时立即拉一次。幂等。 */
  setPaused(paused: boolean): void;
  pollNow(): Promise<void>;
  /** 运行中且未暂停且未 dispose。 */
  isRunning(): boolean;
  dispose(): void;
}

export function mediaUrl(pageTitle: string): string {
  return '/wallpapers/now-playing?title=' + encodeURIComponent(pageTitle);
}

/** 返回变化的键；首次（prev=null）视为全变化。一律按 !== 判，thumbnailRev 回退也算变化。 */
export function diffSnapshot(prev: MediaSessionSnapshot | null, next: MediaSessionSnapshot): string[] {
  if (!prev) return [...DIFF_KEYS];
  return DIFF_KEYS.filter((key) => prev[key] !== next[key]);
}

type FetchResponse = { ok: boolean; status?: number; json(): Promise<MediaSessionSnapshot> };

export function createMediaInput(opts: MediaInputOptions): MediaInput {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const fetchImpl: (url: string) => Promise<FetchResponse> =
    opts.fetchImpl ?? ((url) => fetch(url));
  const pageTitle = opts.pageTitle ?? (() => (typeof document === 'undefined' ? '' : document.title));
  const setIntervalImpl: (fn: () => void, ms: number) => unknown =
    opts.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl: (handle: unknown) => void =
    opts.clearIntervalImpl ?? ((handle) => { clearInterval(handle as Parameters<typeof clearInterval>[0]); });

  let running = false;
  let paused = false;
  let disposed = false;
  let timer: unknown = null;
  let currentIntervalMs = intervalMs;
  let failures = 0;
  let inflight = false;
  let prev: MediaSessionSnapshot | null = null;

  const targetIntervalMs = (): number => (failures >= FAILURES_BEFORE_BACKOFF ? backoffMs : intervalMs);

  const stopTimer = (): void => {
    if (timer === null) return;
    clearIntervalImpl(timer);
    timer = null;
  };

  // 仅在运行中且间隔真的变化时重建定时器（退避↔常规），避免重复挖掉刚设的 interval。
  const armTimer = (ms: number): void => {
    if (disposed || !running || paused) return;
    if (timer !== null && currentIntervalMs === ms) return;
    stopTimer();
    currentIntervalMs = ms;
    timer = setIntervalImpl(() => {
      if (running && !paused && !disposed) void poll();
    }, ms);
  };

  const poll = async (): Promise<void> => {
    if (disposed || paused || inflight) return;
    inflight = true;
    try {
      const resp = await fetchImpl(mediaUrl(pageTitle()));
      if (!resp.ok) throw new Error('now-playing http ' + (resp.status ?? 'unknown'));
      const next = await resp.json();
      if (disposed || paused) return;
      failures = 0;
      if (diffSnapshot(prev, next).length > 0) {
        const old = prev;
        prev = next;
        // 回调异常**不是网络失败**：不得计入 failures/触发退避，否则「渲染侧一次抛错」会把轮询打进 10s 退避。
        try {
          opts.onSnapshot(next, old);
        } catch {
          // 单个消费方异常只丢该次通知
        }
      }
      armTimer(intervalMs);
    } catch (error) {
      if (disposed) return;
      failures += 1;
      try {
        opts.onError?.(error);
      } catch {
        // onError 自身异常不外抛
      }
      if (failures >= FAILURES_BEFORE_BACKOFF) armTimer(backoffMs);
    } finally {
      inflight = false;
    }
  };

  return {
    start() {
      if (disposed || running) return;
      running = true;
      armTimer(targetIntervalMs());
      void poll();
    },
    stop() {
      running = false;
      stopTimer();
    },
    setPaused(value) {
      if (disposed || value === paused) return;
      paused = value;
      if (value) {
        stopTimer();
      } else if (running) {
        armTimer(targetIntervalMs());
        void poll();
      }
    },
    async pollNow() {
      await poll();
    },
    isRunning() {
      return running && !paused && !disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      stopTimer();
    },
  };
}

/** 媒体层事件（Task 8 才有真实封面主色；本任务固定中性调色板，hasThumbnail/rev 仅供脚本判断）。 */
export interface MediaThumbnailEventPayload {
  hasThumbnail: boolean;
  rev: number;
  palette: MediaPalette;
}

/** 中性调色板：无封面/未实现主色提取时的统一颜色（黑色系 + 白字，不影响任何图层可见性）。 */
export const NEUTRAL_MEDIA_PALETTE: MediaPalette = {
  primary: [0, 0, 0], secondary: [0, 0, 0], tertiary: [0, 0, 0],
  text: [1, 1, 1], highContrast: [1, 1, 1],
};

/** 快照 → 渲染器事件（three-renderer 的 sink 落到 SceneScriptHost 与文本脚本）。 */
export interface MediaDispatchSink {
  playback(state: 'stopped' | 'playing' | 'paused'): void;
  status(enabled: boolean): void;
  properties(props: MediaPropertiesPayload): void;
  thumbnail(payload: MediaThumbnailEventPayload): void;
}

/** 快照 diff → 事件顺序：status（仅首次）→ playback → properties → thumbnail。
 *  停止/不可用只派 playback('stopped')：媒体层已被脚本隐藏，再派空属性只会白重绘文本层。 */
export function applyMediaSnapshot(
  prev: MediaSessionSnapshot | null,
  next: MediaSessionSnapshot,
  sink: MediaDispatchSink,
): void {
  const changed = diffSnapshot(prev, next);
  if (changed.length === 0) return;
  if (prev === null) sink.status(true); // 首次快照 = 媒体集成已启用
  if (!next.available || (changed.includes('playback') && next.playback === 'stopped')) {
    sink.playback('stopped');
    return;
  }
  if (changed.includes('playback')) sink.playback(next.playback);
  if (changed.includes('title') || changed.includes('artist') || changed.includes('album')) {
    sink.properties({ title: next.title, artist: next.artist, album: next.album, contentType: next.contentType });
  }
  if (changed.includes('thumbnailRev') || changed.includes('hasThumbnail')) {
    sink.thumbnail({ hasThumbnail: next.hasThumbnail, rev: next.thumbnailRev, palette: NEUTRAL_MEDIA_PALETTE });
  }
}

const MEDIA_SCRIPT_RE = /mediaPlaybackChanged|mediaStatusChanged|mediaPropertiesChanged|mediaThumbnailChanged|MediaPlaybackEvent/;

/** 场景是否声明了媒体事件脚本（visible/属性/text 三处）；没有则零轮询、零开销。 */
export function sceneNeedsMedia(desc: SceneDescription): boolean {
  for (const obj of desc.objects) {
    if (typeof obj.visible?.script === 'string' && obj.visible.script && MEDIA_SCRIPT_RE.test(obj.visible.script)) {
      return true;
    }
    for (const e of obj.objectScripts ?? []) {
      if (typeof e?.script === 'string' && e.script && MEDIA_SCRIPT_RE.test(e.script)) return true;
    }
    if (obj.kind === 'text' && typeof obj.script === 'string' && obj.script && MEDIA_SCRIPT_RE.test(obj.script)) {
      return true;
    }
  }
  return false;
}
