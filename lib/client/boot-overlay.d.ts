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
    /** DSH 启动页（[data-dsh-boot]）存在时的硬上限；默认 30s（极慢机器兜底，避免无限黑屏）。 */
    bootHoldMaxMs?: number;
    doc?: Document;
}
export declare function createBootOverlay(opts?: BootOverlayOptions): BootOverlay;
