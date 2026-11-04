import type { BootAsset, BootFitMode, BootOverlay, BootResult } from './boot-overlay.js';
import type { ClientSettings } from './types.js';
export declare const BOOT_PLAYED_KEY = "we:boot-played";
export declare function normalizeBootFit(value: string): BootFitMode;
export declare function bootAssetFromSettings(s: ClientSettings): BootAsset | null;
export declare function shouldPlayBoot(s: ClientSettings, storage: Pick<Storage, 'getItem'>): boolean;
export interface BootLastResult {
    result: BootResult;
    at: number;
    asset: BootAsset | null;
}
export interface BootPlayer {
    start(): Promise<BootResult>;
    play(opts?: {
        force?: boolean;
    }): Promise<BootResult>;
    getLast(): BootLastResult | null;
    dispose(): void;
}
export declare function createBootPlayer(opts: {
    readSettings: () => Promise<ClientSettings>;
    overlay?: BootOverlay;
    storage?: Pick<Storage, 'getItem' | 'setItem'>;
    /** 真正播放区间回调（true = 开始播放、false = 结束）：供上层抑制壁纸声音等。 */
    onActiveChange?: (active: boolean) => void;
}): BootPlayer;
