import { type MediaPlaybackState, type MediaReason, type MediaSessionSnapshot } from '../shared/media.js';
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
export interface MediaWatcherProcess {
    stdout: {
        on(event: 'data', cb: (chunk: Buffer) => void): void;
    } | null;
    stderr?: {
        on(event: 'data', cb: (chunk: Buffer) => void): void;
    } | null;
    kill(): void;
    on(event: 'exit', cb: (code?: number | null) => void): void;
}
export interface MediaSessionServiceOptions {
    platform?: NodeJS.Platform;
    spawnImpl?: (cmd: string, args: string[]) => MediaWatcherProcess;
    now?: () => number;
    ownAppId?: string;
    log?: (msg: string) => void;
    idleMs?: number;
    idleCheckMs?: number;
    setIntervalImpl?: (fn: () => void, ms: number) => unknown;
    clearIntervalImpl?: (h: unknown) => void;
}
export interface MediaSessionService {
    request(opts: {
        pageTitle: string;
        enabled: boolean;
    }): MediaSessionSnapshot;
    thumbnail(rev: number): {
        bytes: Buffer;
        contentType: string;
    } | null;
    dispose(): void;
    stats(): {
        starts: number;
        badLines: number;
        restarts: number;
        degraded: boolean;
    };
}
export declare function createMediaSessionService(opts?: MediaSessionServiceOptions): MediaSessionService;
