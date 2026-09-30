import type { WallpaperInfo } from '../shared/types.js';
import type { BackgroundLayer } from './background-layer.js';
export interface SceneRendererLike {
    render(id: string, fg: HTMLCanvasElement, bg?: HTMLCanvasElement): Promise<boolean>;
    dispose?(): void;
    setPaused?(paused: boolean): void;
    setQualityScale?(scale: number): void;
    setGlow?(patch: {
        enabled?: boolean;
        threshold?: number;
        strength?: number;
    }): void;
    setSoundEnabled?(enabled: boolean): void;
}
/** 贴壁纸文字样式（设置面板可改）：实时读取，故由 index.ts 以 getter 注入。 */
export interface TextStyleSettings {
    /** 'auto' | 'white' | 'black' | 'custom'（非法值按 auto 处理）。 */
    mode: string;
    /** 自定义色（仅 custom 档使用）。 */
    custom: string;
    /** 描边档位 0-3（0 = 关）。 */
    outline: number;
}
export interface WallpaperControllerOptions {
    fetchList: () => Promise<WallpaperInfo[]>;
    sceneRenderer?: SceneRendererLike;
    /** 文字颜色/描边设置（实时读取）。缺省 = auto 档、无描边（既有行为）。 */
    textStyle?: () => TextStyleSettings;
    /** preview 亮度测量；缺省用 luma.measureLuma（测试注入替身用）。 */
    measurePreviewLuma?: (url: string) => Promise<number | null>;
}
export declare function createWallpaperController(layer: BackgroundLayer, opts: WallpaperControllerOptions): {
    load: () => Promise<WallpaperInfo[]>;
    select: (id: string) => Promise<void>;
    applyTextStyle(): void;
};
