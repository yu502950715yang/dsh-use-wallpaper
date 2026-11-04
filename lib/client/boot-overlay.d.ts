export type BootFitMode = 'tile' | 'contain' | 'stretch' | 'cover';
export type BootAsset = {
    kind: 'video';
    url: string;
} | {
    kind: 'image';
    url: string;
};
export type BootResult = 'ended' | 'skipped' | 'timeout' | 'failed' | 'already-played' | 'disabled' | 'no-asset';
export interface BootPlayOptions {
    /** 是否播放声音（缺省 true）；浏览器无用户激活时仍先静音（自动播放策略）。 */
    soundEnabled?: boolean;
    /** 音量 0-1，缺省 1。 */
    volume?: number;
}
export interface BootOverlay {
    play(asset: BootAsset, fit: BootFitMode, maxDurationMs?: number, opts?: BootPlayOptions): Promise<BootResult>;
    dispose(): void;
}
export interface BootOverlayOptions {
    readyTimeoutMs?: number;
    fadeMs?: number;
    imageDurationMs?: number;
    /** DSH 启动页（[data-dsh-boot]）存在时的硬上限；默认 30s（极慢机器兜底，避免无限黑屏）。 */
    bootHoldMaxMs?: number;
    /** 桌面壳（dsh-app://）：Electron 默认允许有声自动播放；缺省按 location.protocol 判断。 */
    desktopShell?: boolean;
    doc?: Document;
}
export declare function createBootOverlay(opts?: BootOverlayOptions): BootOverlay;
