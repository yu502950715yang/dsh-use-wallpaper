import { fileURLToPath } from 'node:url';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { WALLPAPER_NS, WallpaperSettingsSchema } from './settings.js';
import { registerWallpaperRoutes } from './routes.js';

// 缺省 Wallpaper Engine workshop 目录（2026-08-21 起不再写死在 cordis.patch.yml；
// 解析顺序：settings.wallpaperDir（设置面板可配/自动探测）> config.wallpaperDir >
// 本缺省兜底。用户换 Steam 盘符时在设置面板配置即可，无需改配置文件）
export const DEFAULT_WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';

// 缺省 Wallpaper Engine 安装目录（wasm 粒子纹理来源，语义同 wallpaperDir；
// 设置面板可配/自动探测，config.weAssetsDir 兼容覆盖）
export const DEFAULT_WE_ASSETS_DIR = 'D:/Steam/steamapps/common/wallpaper_engine';

// 缺省 wasm 静态资源目录：build:client 输出 dist/static/（wasm 引擎 glue + .wasm）。
// 用 import.meta.url 定位模块（源码 src/host/ 与编译后 lib/host/ 相对包根深度一致，
// ../../dist/static 均指向包内 dist/static，且 dist 在 package.json files 白名单内）。
export const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../../dist/static/', import.meta.url));

// 插件名（官方文档要求插件模块导出 name + apply）
export const name = 'dsh-wallpaper-engine';

export interface WallpaperEngineConfig {
  wallpaperDir?: string;
  weAssetsDir?: string;
}

// 可变运行状态：路由每次请求读取实时值，settings 变更经 scope.watch 热更新（无需重启）。
export interface WallpaperRuntimeState {
  wallpaperDir: string;
  weAssetsDir: string;
}

// Cordis 函数插件：config 作为第二参数传入（dsh-host-webserver 等一致模式），
// 不可访问 ctx.config（需 inject 声明）；这里用参数解构兼容 loader 注入。
export function apply(ctx: any, config?: WallpaperEngineConfig): void {
  const state: WallpaperRuntimeState = {
    wallpaperDir: config?.wallpaperDir ?? DEFAULT_WALLPAPER_DIR,
    weAssetsDir: config?.weAssetsDir ?? DEFAULT_WE_ASSETS_DIR,
  };
  ctx.inject(['settings'], (settingsCtx: any) => {
    const scope = settingsCtx.settings.register(settingsNamespace(WALLPAPER_NS), WallpaperSettingsSchema);
    // 解析顺序：settings 用户值 > config > 缺省；空字符串（未配置）跳过。
    const applySettings = (value: any) => {
      if (value?.wallpaperDir) state.wallpaperDir = value.wallpaperDir;
      else state.wallpaperDir = config?.wallpaperDir ?? DEFAULT_WALLPAPER_DIR;
      if (value?.weAssetsDir) state.weAssetsDir = value.weAssetsDir;
      else state.weAssetsDir = config?.weAssetsDir ?? DEFAULT_WE_ASSETS_DIR;
    };
    applySettings(scope.get());
    scope.watch(applySettings);
  });
  // 挂载壁纸 REST 路由（/wallpapers/list、/wallpapers/media、/wallpapers/scene、
  // /wallpapers/static、/wallpapers/web、/wallpapers/particle-texture、/wallpapers/probe）
  registerWallpaperRoutes(ctx, { state, staticDir: DEFAULT_STATIC_DIR });
}

// Cordis loader 以默认导出作为插件入口（函数或含 apply 方法的对象）；
// 命名导出保留给单元测试使用。
export default apply;
