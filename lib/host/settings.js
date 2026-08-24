import z from '@deepseek-ai/schemastery';
export const WALLPAPER_NS = 'wallpaper-engine';
export const WallpaperSettingsSchema = z.object({
    selectedWallpaperId: z.string().default(''),
    // 壁纸目录（workshop/content/431960）与引擎目录（common/wallpaper_engine）。
    // 空字符串 = 未配置，回退 config（cordis.patch.yml）→ 缺省路径；可由设置面板
    // 自动探测候选后写入（不再依赖写死的 config）。
    wallpaperDir: z.string().default(''),
    weAssetsDir: z.string().default(''),
    overlayOpacity: z.number().min(0).max(1).default(0.35),
    blurEnabled: z.boolean().default(false),
    blurRadius: z.number().min(0).max(64).default(12),
    kenBurns: z.boolean().default(true),
});
