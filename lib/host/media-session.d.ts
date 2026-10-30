import type { MediaPlaybackState, MediaReason } from '../shared/media.js';
export interface RawMediaSession {
    appId: string;
    status: string;
    title: string;
    artist: string;
    album: string;
    contentType: string;
    positionMs: number;
    durationMs: number;
    art: {
        bytes: Buffer;
        contentType: string;
    } | null;
}
export interface WatcherFrame {
    at: number;
    sessions: RawMediaSession[];
}
export declare function playbackOfStatus(status: string): MediaPlaybackState;
export declare function parseWatcherLine(line: string): WatcherFrame | null;
export interface SessionSelectionOptions {
    ownAppId: string;
    pageTitle: string;
    lastChangedAt: ReadonlyMap<string, number>;
}
export declare function selectSession(frame: WatcherFrame, opts: SessionSelectionOptions): {
    session: RawMediaSession | null;
    reason: MediaReason;
};
export declare const WATCH_SCRIPT: string;
