import { Config } from './settings.js';
export declare const DEFAULT_STATIC_DIR: string;
export declare const name = "dsh-wallpaper-engine";
export interface WallpaperEngineConfig {
    wallpaperDir?: string;
    weAssetsDir?: string;
    mediaIntegrationEnabled?: boolean;
    /** 开机动画本地视频路径（boot 两条路由的唯一允许读取路径，1.0 S1 加固）。 */
    bootAnimationLocalPath?: string;
}
export interface WallpaperRuntimeState {
    wallpaperDir: string;
    weAssetsDir: string;
    mediaIntegrationEnabled: boolean;
    /** 开机动画本地视频路径：boot 两条路由的**唯一**允许读取路径（1.0 S1 加固，见 routes.ts）。 */
    bootAnimationLocalPath: string;
}
export declare function apply(ctx: any, config?: WallpaperEngineConfig): void;
export { Config };
export default apply;
