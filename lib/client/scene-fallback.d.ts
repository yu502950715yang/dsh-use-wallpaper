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
/** 探测壁纸包内是否带内嵌 MP4：true → 返回播放 URL；无视频/请求失败 → null。 */
export declare function probeEmbeddedVideo(id: string, fetchImpl?: FetchLike): Promise<string | null>;
/** 确保 host 有该壁纸的首帧缓存：HEAD 命中即止；404 时抓当前帧并 POST（≤12MB PNG）。 */
export declare function ensureSceneFrame(id: string, deps: EnsureSceneFrameDeps): Promise<void>;
/** 渲染色 scene 失败后的降级链：内嵌视频（须 'ok'）→ 已有抓帧 → 作者预览图 → showNone。 */
export declare function showSceneFallback(info: WallpaperInfo, deps: SceneFallbackDeps): Promise<SceneFallbackResult>;
export {};
