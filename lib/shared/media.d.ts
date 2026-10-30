export type MediaPlaybackState = 'stopped' | 'playing' | 'paused';
export type MediaReason = 'ok' | 'no-session' | 'disabled' | 'unsupported-platform' | 'no-powershell' | 'watcher-failed';
export type MediaRgb = [number, number, number];
export interface MediaSessionSnapshot {
    available: boolean;
    reason: MediaReason;
    appId: string;
    title: string;
    artist: string;
    album: string;
    contentType: string;
    playback: MediaPlaybackState;
    hasThumbnail: boolean;
    thumbnailRev: number;
    positionMs: number | null;
    durationMs: number | null;
    at: number;
}
export interface MediaPalette {
    primary: MediaRgb;
    secondary: MediaRgb;
    tertiary: MediaRgb;
    text: MediaRgb;
    highContrast: MediaRgb;
}
/** 中性快照：所有失败/无会话路径共用（available=false ⇒ 客户端派发 stopped）。 */
export declare function emptyMediaSnapshot(reason: MediaReason, at?: number): MediaSessionSnapshot;
