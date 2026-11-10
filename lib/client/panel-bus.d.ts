import type { ClientSettings } from './types.js';
import type { HealthSnapshot } from './render-health.js';
import type { MediaFailure } from './media-health.js';
import type { MediaIntegrationStatus } from '../shared/media.js';
import type { VideoHealthSnapshot } from './video-health.js';
import type { SystemAudioFailure } from './system-audio.js';
export interface SystemAudioHandlers {
    start(): Promise<SystemAudioFailure | 'ok'>;
    stop(): void;
}
/** 面板「实时渲染」卡片要的三件事：读状态、重试当前壁纸、清空全部失败记忆。 */
export interface WallpaperHealthHandler {
    get(): HealthSnapshot | null;
    retry(): void;
    clearFailures(): void;
}
/** 面板「媒体失败提示」要的两件事：读当前失败 / 清除。 */
export interface WallpaperMediaHandler {
    get(): MediaFailure | null;
    clear(): void;
}
/** 媒体集成状态（面板状态行）：由 index.ts 注入 renderer.getMediaStatus（只读、不含曲目）。 */
export interface WallpaperMediaIntegrationHandler {
    get(): MediaIntegrationStatus | null;
}
/** 视频壁纸健康状态行：index.ts 注入 layer.getVideoHealth（只读快照；非视频壁纸返回 null）。 */
export interface WallpaperVideoHealthHandler {
    get(): VideoHealthSnapshot | null;
}
export interface PanelHandlers {
    onSelect?: ((id: string) => void) | null;
    onRuntimeSettings?: ((patch: Partial<ClientSettings>) => void) | null;
    onReselect?: ((id: string) => void) | null;
    systemAudio?: SystemAudioHandlers | null;
    health?: WallpaperHealthHandler | null;
    media?: WallpaperMediaHandler | null;
    mediaIntegration?: WallpaperMediaIntegrationHandler | null;
    videoHealth?: WallpaperVideoHealthHandler | null;
}
export declare class PanelBus {
    private handlers;
    private readonly healthSubs;
    private readonly mediaSubs;
    /** 注册/覆盖处理器槽位（undefined 槽位保持现状；显式 null = 撤销该槽位）。 */
    setHandlers(patch: Partial<PanelHandlers>): void;
    get(): PanelHandlers;
    subscribeHealth(cb: (s: HealthSnapshot | null) => void): () => void;
    notifyHealth(snap: HealthSnapshot | null): void;
    subscribeMedia(cb: (failure: MediaFailure | null) => void): () => void;
    /** handler 未注册时不推（面板已回初始态，迟到的失败不得复活提示）。 */
    notifyMedia(failure: MediaFailure | null): void;
    private pushMedia;
}
