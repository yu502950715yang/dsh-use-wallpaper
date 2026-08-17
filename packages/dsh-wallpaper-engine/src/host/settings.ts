import z from '@deepseek-ai/schemastery';

export const WALLPAPER_NS = 'wallpaper-engine';

export const WallpaperSettingsSchema = z.object({
  selectedWallpaperId: z.string().default(''),
  overlayOpacity: z.number().min(0).max(1).default(0.35),
  blurEnabled: z.boolean().default(false),
  blurRadius: z.number().min(0).max(64).default(12),
  kenBurns: z.boolean().default(true),
});
