import type { WallpaperInfo } from '../shared/types.js';
import type { BackgroundPlan, FitMode } from './types.js';
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
export interface TransportGlobals {
    __DSH_TRANSPORT__?: {
        streamBaseUrl?: unknown;
    };
}
export declare function readTransportOrigin(globals?: TransportGlobals): string | null;
export type WebFrameOriginPlan = {
    kind: 'transport';
    origin: string;
} | {
    kind: 'probe';
    alternate: string;
} | {
    kind: 'fallback';
};
export declare function planWebFrameOrigin(loc: WebFrameLocation, transportOrigin: string | null): WebFrameOriginPlan;
export declare function webFrameSpec(wallpaperPath: string, loc: WebFrameLocation, altOrigin: string | null): WebFrameSpec;
export declare const WEB_RESIZE_RELOAD_DELAY_MS = 300;
export declare const WEB_RESIZE_RELOAD_TIMEOUT_MS = 8000;
export declare const VIDEO_LOAD_TIMEOUT_MS = 1500;
export type VideoLoadResult = 'ok' | 'unsupported' | 'timeout';
export interface BackgroundLayer {
    root: HTMLElement;
    showImage(url: string, kenBurns: boolean): void;
    /** 加载视频并等首帧：error → unsupported，1.5s 无 loadeddata → timeout。 */
    showVideo(url: string): Promise<VideoLoadResult>;
    showWeb(url: string): void;
    showSceneCanvas(canvas: HTMLCanvasElement, blurCanvas?: HTMLCanvasElement): void;
    showNone(): void;
    setOverlayOpacity(v: number): void;
    setBlur(enabled: boolean, radius: number): void;
    /** 设置 Ken Burns 开关状态并即时应用到当前图片（不重建元素）。 */
    setKenBurns(enabled: boolean): void;
    /** 运行期切换画面适配模式（当前图片/视频即时生效）。 */
    setFitMode(mode: FitMode): void;
    setChatFg(color: string): void;
    /** 文字描边（对立色阴影）：level 0 或空颜色 = 移除变量（无描边，既有观感）。 */
    setChatOutline(color: string, level: number): void;
    /** 省电：暂停/恢复视频壁纸播放（scene 由渲染器负责；web 壁纸在 iframe 里无法受控）。 */
    setPaused(paused: boolean): void;
}
export declare function createBackgroundLayer(root: HTMLElement): BackgroundLayer;
