import type { WallpaperInfo } from '../shared/types.js';
import type { BackgroundPlan } from './types.js';
export declare function resolveBackground(info: WallpaperInfo): BackgroundPlan;
export declare function applyKenBurns(el: HTMLElement, enabled: boolean): void;
export interface WebFrameLocation {
    protocol: string;
    hostname: string;
    port: string;
}
export interface WebFrameSpec {
    url: string;
    sandbox: string;
}
export declare function alternateLoopbackOrigin(loc: WebFrameLocation): string | null;
export declare function webFrameSpec(wallpaperPath: string, loc: WebFrameLocation, altOrigin: string | null): WebFrameSpec;
export interface BackgroundLayer {
    root: HTMLElement;
    showImage(url: string, kenBurns: boolean): void;
    showVideo(url: string): void;
    showWeb(url: string): void;
    showSceneCanvas(canvas: HTMLCanvasElement, blurCanvas?: HTMLCanvasElement): void;
    showNone(): void;
    setOverlayOpacity(v: number): void;
    setBlur(enabled: boolean, radius: number): void;
    setChatFg(color: string): void;
    /** 省电：暂停/恢复视频壁纸播放（scene 由渲染器负责；web 壁纸在 iframe 里无法受控）。 */
    setPaused(paused: boolean): void;
}
export declare function createBackgroundLayer(root: HTMLElement): BackgroundLayer;
