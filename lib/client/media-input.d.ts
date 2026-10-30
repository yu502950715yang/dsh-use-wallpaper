import type { MediaSessionSnapshot } from '../shared/media.js';
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
    start(): void;
    stop(): void;
    setPaused(paused: boolean): void;
    pollNow(): Promise<void>;
    isRunning(): boolean;
    dispose(): void;
}
export declare function mediaUrl(pageTitle: string): string;
/** 返回变化的键；首次（prev=null）视为全变化。一律按 !== 判，thumbnailRev 回退也算变化。 */
export declare function diffSnapshot(prev: MediaSessionSnapshot | null, next: MediaSessionSnapshot): string[];
export declare function createMediaInput(opts: MediaInputOptions): MediaInput;
