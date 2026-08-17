import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { WALLPAPER_NS, WallpaperSettingsSchema } from './settings.js';

export function apply(ctx: any): void {
  ctx.inject(['settings'], (settingsCtx: any) => {
    settingsCtx.settings.register(settingsNamespace(WALLPAPER_NS), WallpaperSettingsSchema);
  });
}
