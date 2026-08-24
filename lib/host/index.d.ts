export declare const DEFAULT_WALLPAPER_DIR = "D:/Steam/steamapps/workshop/content/431960";
export declare const DEFAULT_WE_ASSETS_DIR = "D:/Steam/steamapps/common/wallpaper_engine";
export declare const DEFAULT_STATIC_DIR: string;
export declare const name = "dsh-wallpaper-engine";
export interface WallpaperEngineConfig {
    wallpaperDir?: string;
    weAssetsDir?: string;
}
export interface WallpaperRuntimeState {
    wallpaperDir: string;
    weAssetsDir: string;
}
export declare function apply(ctx: any, config?: WallpaperEngineConfig): void;
export default apply;
