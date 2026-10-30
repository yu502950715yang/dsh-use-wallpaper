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
}): BootPlayer;
