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
