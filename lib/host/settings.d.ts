import z from '@deepseek-ai/schemastery';
export declare const WALLPAPER_NS = "wallpaper-engine";
export declare const WallpaperSettingsSchema: z<Schemastery.ObjectS<{
    selectedWallpaperId: z<string, string>;
    wallpaperDir: z<string, string>;
    weAssetsDir: z<string, string>;
    overlayOpacity: z<number, number>;
    blurEnabled: z<boolean, boolean>;
    blurRadius: z<number, number>;
    kenBurns: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    selectedWallpaperId: z<string, string>;
    wallpaperDir: z<string, string>;
    weAssetsDir: z<string, string>;
    overlayOpacity: z<number, number>;
    blurEnabled: z<boolean, boolean>;
    blurRadius: z<number, number>;
    kenBurns: z<boolean, boolean>;
}>>;
