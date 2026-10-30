export type BootFitMode = 'tile' | 'contain' | 'stretch' | 'cover';
export type BootAsset = {
    kind: 'video';
    url: string;
} | {
    kind: 'image';
    url: string;
};
export type BootResult = 'ended' | 'skipped' | 'timeout' | 'failed' | 'already-played' | 'disabled' | 'no-asset';
export interface BootOverlay {
    play(asset: BootAsset, fit: BootFitMode, maxDurationMs?: number): Promise<BootResult>;
    dispose(): void;
}
export interface BootOverlayOptions {
    readyTimeoutMs?: number;
    fadeMs?: number;
    imageDurationMs?: number;
    doc?: Document;
}
export declare function createBootOverlay(opts?: BootOverlayOptions): BootOverlay;
