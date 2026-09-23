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
    // 应用级 Glow（整帧亮部发光）：阈值/强度默认值与 client 的 DEFAULTS 一致（2026-09-21 用户真机定档）。
    glowEnabled: z.boolean().default(true),
    glowThreshold: z.number().min(0).max(0.99).default(0.65),
    glowStrength: z.number().min(0).max(4).default(0.35),
    // 省电与画质档位（2026-09-21）：paused 手动暂停；pauseOnHidden 切到后台自动暂停；
    // qualityScale 渲染像素比倍率（1 = 原生 dpr，下限 0.5 防糊到不可用）。
    paused: z.boolean().default(false),
    pauseOnHidden: z.boolean().default(true),
    qualityScale: z.number().min(0.5).max(1).default(1),
});
// 0.1.7 表单只投影 volatile 字段；旧版 register 要普通 schema（volatile 在旧版取不到值）。
export const Config = WallpaperSettingsSchema.volatile();
