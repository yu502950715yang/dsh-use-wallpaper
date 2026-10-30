import { Config } from './settings.js';
export declare const DEFAULT_STATIC_DIR: string;
export declare const name = "dsh-wallpaper-engine";
export interface WallpaperEngineConfig {
    wallpaperDir?: string;
    weAssetsDir?: string;
    mediaIntegrationEnabled?: boolean;
}
export interface WallpaperRuntimeState {
    wallpaperDir: string;
    weAssetsDir: string;
    mediaIntegrationEnabled: boolean;
}
export declare function apply(ctx: any, config?: WallpaperEngineConfig): void;
export { Config };
export default apply;
