import type { WallpaperInfo } from '../shared/types.js';
import type { BackgroundPlan } from './types.js';
export declare function resolveBackground(info: WallpaperInfo): BackgroundPlan;
export declare function applyKenBurns(el: HTMLElement, enabled: boolean): void;
export interface BackgroundLayer {
    root: HTMLElement;
    showImage(url: string, kenBurns: boolean): void;
    showVideo(url: string): void;
    showWeb(url: string): void;
    showSceneCanvas(canvas: HTMLCanvasElement, blurCanvas?: HTMLCanvasElement): void;
    showNone(): void;
    setOverlayOpacity(v: number): void;
    setBlur(enabled: boolean, radius: number): void;
}
export declare function createBackgroundLayer(root: HTMLElement): BackgroundLayer;
