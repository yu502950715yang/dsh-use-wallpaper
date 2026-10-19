// scene 渲染不可用时的降级链（v0.8 Task 6）：内嵌视频 → 首帧缓存图 → 作者预览图 → 空。
// 所有探测/抓帧失败只 warn 或返回 null，绝不向 controller 抛错（任何路径都不能白屏）。
import type { WallpaperInfo } from '../shared/types.js';

export type SceneFallbackResult = 'video' | 'frame' | 'preview' | 'none';

type FetchLike = typeof fetch;

export interface SceneFallbackLayer {
  showVideo(url: string): Promise<'ok' | 'unsupported' | 'timeout'>;
  showImage(url: string, kenBurns: boolean): void;
  showNone(): void;
}

export interface SceneFallbackDeps {
  fetch: FetchLike;
  layer: SceneFallbackLayer;
}

export interface FrameCacheRenderer {
  captureFrame?: () => Promise<Uint8Array | null>;
}

export interface EnsureSceneFrameDeps {
  fetch: FetchLike;
  renderer: FrameCacheRenderer;
}

const sceneVideoUrl = (id: string) => `/wallpapers/scene/${encodeURIComponent(id)}/embedded-video`;
const frameUrl = (id: string) => `/wallpapers/frame/${encodeURIComponent(id)}`;

/** 探测壁纸包内是否带内嵌 MP4：true → 返回播放 URL；无视频/请求失败 → null。 */
export async function probeEmbeddedVideo(id: string, fetchImpl?: FetchLike): Promise<string | null> {
  try {
    const doFetch = fetchImpl ?? globalThis.fetch;
    const res = await doFetch(`/wallpapers/scene/${encodeURIComponent(id)}/video-probe`);
    if (!res.ok) return null;
    const data = (await res.json()) as { video?: unknown } | null;
    return data?.video === true ? sceneVideoUrl(id) : null;
  } catch {
    return null;
  }
}

// 同 id 并发去重：一次 select 可能同时触发 onSceneLive 与其他入口，避免重复抓帧/写盘。
const frameInFlight = new Map<string, Promise<void>>();

/** 确保 host 有该壁纸的首帧缓存：HEAD 命中即止；404 时抓当前帧并 POST（≤12MB PNG）。 */
export function ensureSceneFrame(id: string, deps: EnsureSceneFrameDeps): Promise<void> {
  const running = frameInFlight.get(id);
  if (running) return running;
  const task = ensureSceneFrameInner(id, deps).finally(() => {
    if (frameInFlight.get(id) === task) frameInFlight.delete(id);
  });
  frameInFlight.set(id, task);
  return task;
}

async function ensureSceneFrameInner(id: string, deps: EnsureSceneFrameDeps): Promise<void> {
  try {
    const url = frameUrl(id);
    const head = await deps.fetch(url, { method: 'HEAD' });
    if (head.ok) return; // 已有缓存，不重复抓帧
    if (head.status !== 404) {
      console.warn(`[wallpaper-engine] scene 首帧探测失败（HTTP ${head.status}，已跳过缓存）`);
      return;
    }
    const png = await deps.renderer.captureFrame?.();
    if (!png || png.length === 0) return; // 不支持抓帧/抓帧失败：只跳过，不影响 live 渲染
    const res = await deps.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      // Uint8Array 的底层缓冲可能是 SharedArrayBuffer 等 ArrayBufferLike，BodyInit 只收 ArrayBuffer ⇒ 拷贝一份。
      body: png.slice().buffer,
    });
    if (!res.ok) console.warn(`[wallpaper-engine] scene 首帧写入失败（HTTP ${res.status}，已跳过）`);
  } catch (e) {
    console.warn('[wallpaper-engine] scene 首帧缓存失败（已跳过）:', e instanceof Error ? e.message : String(e));
  }
}

/** 渲染色 scene 失败后的降级链：内嵌视频（须 'ok'）→ 已有抓帧 → 作者预览图 → showNone。 */
export async function showSceneFallback(info: WallpaperInfo, deps: SceneFallbackDeps): Promise<SceneFallbackResult> {
  const videoUrl = await probeEmbeddedVideo(info.id, deps.fetch);
  if (videoUrl) {
    try {
      if ((await deps.layer.showVideo(videoUrl)) === 'ok') return 'video';
    } catch {
      // 视频解码/播放异常 → 继续下一条降级
    }
  }
  const frame = frameUrl(info.id);
  const head = await deps.fetch(frame, { method: 'HEAD' }).catch(() => null);
  if (head?.ok) {
    deps.layer.showImage(frame, false);
    return 'frame';
  }
  if (info.previewUrl) {
    deps.layer.showImage(info.previewUrl, !info.hasPreviewGif);
    return 'preview';
  }
  deps.layer.showNone();
  return 'none';
}
