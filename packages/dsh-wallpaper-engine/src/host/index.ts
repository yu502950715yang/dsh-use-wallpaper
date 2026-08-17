import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { WALLPAPER_NS, WallpaperSettingsSchema } from './settings.js';
import { registerWallpaperRoutes } from './routes.js';

// 缺省 Wallpaper Engine workshop 目录（cordis.patch.yml 的 config 同名覆盖）
export const DEFAULT_WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';

export function apply(ctx: any): void {
  const wallpaperDir = ctx.config?.wallpaperDir ?? DEFAULT_WALLPAPER_DIR;
  ctx.inject(['settings'], (settingsCtx: any) => {
    settingsCtx.settings.register(settingsNamespace(WALLPAPER_NS), WallpaperSettingsSchema);
  });
  // 挂载壁纸 REST 路由（/wallpapers/list、/wallpapers/media、/wallpapers/scene）
  registerWallpaperRoutes(ctx, { wallpaperDir });
}
