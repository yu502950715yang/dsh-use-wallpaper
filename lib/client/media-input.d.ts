import type { MediaPalette, MediaPropertiesPayload, MediaSessionSnapshot } from '../shared/media.js';
import type { SceneDescription } from '../shared/types.js';
export interface MediaInputOptions {
    fetchImpl?: (url: string) => Promise<{
        ok: boolean;
        json(): Promise<MediaSessionSnapshot>;
    }>;
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
    /** 停止轮询并清定时器；`failures` 保留（重新 start 仍按退避档起步），`prev` 清空（重开按首帧重放）。 */
    stop(): void;
    /** 暂停期间不发请求；恢复时立即拉一次。幂等。 */
    setPaused(paused: boolean): void;
    pollNow(): Promise<void>;
    /** 运行中且未暂停且未 dispose。 */
    isRunning(): boolean;
    dispose(): void;
}
export declare function mediaUrl(pageTitle: string): string;
/** 返回变化的键；首次（prev=null）视为全变化。一律按 !== 判，thumbnailRev 回退也算变化。 */
export declare function diffSnapshot(prev: MediaSessionSnapshot | null, next: MediaSessionSnapshot): string[];
export declare function createMediaInput(opts: MediaInputOptions): MediaInput;
/** 媒体层事件（Task 8 才有真实封面主色；本任务固定中性调色板，hasThumbnail/rev 仅供脚本判断）。 */
export interface MediaThumbnailEventPayload {
    hasThumbnail: boolean;
    rev: number;
    palette: MediaPalette;
}
/** 中性调色板：无封面/未实现主色提取时的统一颜色（黑色系 + 白字，不影响任何图层可见性）。 */
export declare const NEUTRAL_MEDIA_PALETTE: MediaPalette;
/** 快照 → 渲染器事件（three-renderer 的 sink 落到 SceneScriptHost 与文本脚本）。 */
export interface MediaDispatchSink {
    playback(state: 'stopped' | 'playing' | 'paused'): void;
    status(enabled: boolean): void;
    properties(props: MediaPropertiesPayload): void;
    thumbnail(payload: MediaThumbnailEventPayload): void;
}
/** 快照 diff → 事件顺序：status（仅首次）→ playback → properties → thumbnail。
 *  停止/不可用只派 playback('stopped')：媒体层已被脚本隐藏，再派空属性只会白重绘文本层。 */
export declare function applyMediaSnapshot(prev: MediaSessionSnapshot | null, next: MediaSessionSnapshot, sink: MediaDispatchSink): void;
/** 场景是否声明了媒体事件脚本（visible/属性/text 三处）；没有则零轮询、零开销。 */
export declare function sceneNeedsMedia(desc: SceneDescription): boolean;
