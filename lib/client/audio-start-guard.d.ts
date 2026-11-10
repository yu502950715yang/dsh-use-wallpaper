import type { SystemAudioFailure } from './system-audio.js';
export interface AudioStartOps {
    start(): Promise<SystemAudioFailure | 'ok'>;
    stop(): void;
}
export interface AudioStartGuard {
    start(): Promise<SystemAudioFailure | 'ok'>;
    stop(): void;
}
export declare function createAudioStartGuard(ops: AudioStartOps): AudioStartGuard;
