import { fileURLToPath } from 'node:url';
import { Config, WALLPAPER_NS, WallpaperSettingsSchema } from './settings.js';
import { registerWallpaperRoutes } from './routes.js';

// 壁纸目录与引擎目录不再提供写死缺省（不默认 D:/Steam）：必须由设置面板
// （自动探测 / 手动填写）或 profile config 显式配置；两者都未配置即视为未配置，
// 相关路由返回空列表 / 提示配置。

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

// 可变运行状态：路由每次请求读取实时值（见 routes.ts 的 dir()/assetsDir()）。
export interface WallpaperRuntimeState {
  wallpaperDir: string;
  weAssetsDir: string;
}

// Cordis 函数插件：config 作为第二参数传入（loader 注入）。
// 设置双路径（详见 AGENT.md §5.34）：≤0.1.6 走 settings.register + scope.watch 动态注册；
// ≥0.1.7 走 SettingsForms（无 register，命名空间是 profile 条目 id）。
//
// config 在 0.1.7 下是 volatile 活引用（对象级，需 .get()），旧版是普通对象 ⇒ 统一解引用。
function configValue(config: unknown): WallpaperEngineConfig {
  const value = config && typeof (config as any).get === 'function' ? (config as any).get() : config;
  return (value ?? {}) as WallpaperEngineConfig;
}

export function apply(ctx: any, config?: WallpaperEngineConfig): void {
  let userWallpaperDir = '';
  let userWeAssetsDir = '';
  const state: WallpaperRuntimeState = {
    get wallpaperDir() { return userWallpaperDir || configValue(config).wallpaperDir || ''; },
    get weAssetsDir() { return userWeAssetsDir || configValue(config).weAssetsDir || ''; },
  };
  ctx.inject(['settings'], (settingsCtx: any) => {
    const settings = settingsCtx?.settings;
    try {
      if (typeof settings?.register === 'function') {
        // base 必须传：旧版面板与「选中壁纸自动恢复」都靠它读到 profile config。
        const scope = settings.register(WALLPAPER_NS, WallpaperSettingsSchema, { base: configValue(config) });
        const applySettings = (value: any) => {
          userWallpaperDir = value?.wallpaperDir || '';
          userWeAssetsDir = value?.weAssetsDir || '';
        };
        applySettings(scope.get());
        scope.watch?.(applySettings);
        return;
      }
      // 自带面板策略；owner 必须显式给插件 fiber（子级里默认是子 fiber）。
      settings?.configure?.({ auto: false }, ctx.fiber);
    } catch (error) {
      // 设置初始化失败不得阻断插件主体（路由与渲染仍要工作）。
      ctx.logger?.warn?.('[wallpaper-engine] 设置初始化失败：%s', error);
    }
  });
  // 挂载壁纸 REST 路由（/wallpapers/list、/wallpapers/media、/wallpapers/scene、
  // /wallpapers/static、/wallpapers/web、/wallpapers/particle-texture、/wallpapers/probe）
  registerWallpaperRoutes(ctx, { state, staticDir: DEFAULT_STATIC_DIR });
}

// loader 的 unwrapExports 在存在 default 导出时丢弃命名导出 ⇒ Config 必须挂上来。
(apply as any).Config = Config;

export { Config };

// Cordis loader 以默认导出作为插件入口（函数或含 apply 方法的对象）；
// 命名导出保留给单元测试使用。
export default apply;
