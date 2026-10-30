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
    // 壁纸音效（sound 对象播放 + 频谱驱动效果）：默认开启，与桌面 WE 一致。
    soundEnabled: z.boolean().default(true),
    // 媒体集成（Windows SMTC 只读；数据仅内存、不落盘、不记日志）。
    mediaIntegrationEnabled: z.boolean().default(true),
    // 文字可读性（2026-10-01）：
    // · textColorMode 用宽松 string —— 模式白名单在 client（normalizeMode：未知值按 auto），
    //   避免旧版面板写入未知值即被 schema 拒绝；
    // · textColor 的 hex 白名单同样在 client（防任意串写进 CSS 变量）；
    // · textOutline 0-3（0 = 关，默认 = 既有观感）。
    textColorMode: z.string().default('auto'),
    textColor: z.string().default('#ffffff'),
    textOutline: z.number().min(0).max(3).default(0),
    // v0.8 显示/轮播：fitMode 与 rotationOrder 用宽松 string（白名单归一在 client，防旧值被拒）；
    // rotationIntervalMs 钳在 1-30 分钟。
    fitMode: z.string().default('cover'),
    rotationEnabled: z.boolean().default(false),
    rotationIntervalMs: z.number().min(60000).max(1800000).default(300000),
    rotationOrder: z.string().default('sequential'),
    frameCacheEnabled: z.boolean().default(true),
    // 开机动画（v0.10）：与壁纸设置完全独立，默认关闭。source/fitMode 用宽松 string
    // （白名单归一在 client，防旧值被 schema 拒绝）。
    bootAnimationEnabled: z.boolean().default(false),
    bootAnimationSource: z.string().default('we'),
    bootAnimationWallpaperId: z.string().default(''),
    // 'video' | 'image'：面板选 WE 壁纸时与 id 一起写入，启动时免拉列表判断类型
    bootAnimationWallpaperKind: z.string().default(''),
    bootAnimationLocalPath: z.string().default(''),
    bootAnimationFitMode: z.string().default('cover'),
    bootAnimationMaxDurationMs: z.number().min(0).max(30000).default(6000),
});
// 0.1.7 表单只投影 volatile 字段；旧版 register 要普通 schema（volatile 在旧版取不到值）。
export const Config = WallpaperSettingsSchema.volatile();
