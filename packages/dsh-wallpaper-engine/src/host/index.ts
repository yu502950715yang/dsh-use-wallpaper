import { fileURLToPath } from 'node:url';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { WALLPAPER_NS, WallpaperSettingsSchema } from './settings.js';
import { registerWallpaperRoutes } from './routes.js';

// 缺省 Wallpaper Engine workshop 目录（cordis.patch.yml 的 config 同名覆盖）
export const DEFAULT_WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';

// 缺省 wasm 静态资源目录：build:client 输出 dist/static/（wasm 引擎 glue + .wasm）。
// 用 import.meta.url 定位模块（源码 src/host/ 与编译后 lib/host/ 相对包根深度一致，
// ../../dist/static 均指向包内 dist/static，且 dist 在 package.json files 白名单内）。
export const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../../dist/static/', import.meta.url));

// 插件名（官方文档要求插件模块导出 name + apply）
export const name = 'dsh-wallpaper-engine';

export interface WallpaperEngineConfig {
  wallpaperDir?: string;
}

// Cordis 函数插件：config 作为第二参数传入（dsh-host-webserver 等一致模式），
// 不可访问 ctx.config（需 inject 声明）；这里用参数解构兼容 loader 注入。
export function apply(ctx: any, config?: WallpaperEngineConfig): void {
  const wallpaperDir = config?.wallpaperDir ?? DEFAULT_WALLPAPER_DIR;
  ctx.inject(['settings'], (settingsCtx: any) => {
    settingsCtx.settings.register(settingsNamespace(WALLPAPER_NS), WallpaperSettingsSchema);
  });
  // 挂载壁纸 REST 路由（/wallpapers/list、/wallpapers/media、/wallpapers/scene、
  // /wallpapers/static、/wallpapers/web）
  registerWallpaperRoutes(ctx, { wallpaperDir, staticDir: DEFAULT_STATIC_DIR });
}

// Cordis loader 以默认导出作为插件入口（函数或含 apply 方法的对象）；
// 命名导出保留给单元测试使用。
export default apply;
