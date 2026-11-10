import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WALLPAPER_ROUTE_PATHS } from '../src/shared/routes.js';
import { registerWallpaperRoutes } from '../src/host/routes.js';

// 跨端路由契约（审查 P0-11）：host 注册与 client 请求共用 shared/routes.ts。
// 两道断言：① host 注册的路径集合 == 常量集合（防两侧漂移）；② host/client 源码不再有裸
// '/wallpapers/' 字面量（强制走常量/构造器；注释不计）。

function registeredPaths(): string[] {
  const paths: string[] = [];
  const ctx = {
    inject: (_deps: string[], fn: (c: unknown) => void) => fn({
      webServer: { register: (route: { path: string }) => { paths.push(route.path); return () => {}; } },
    }),
  };
  registerWallpaperRoutes(ctx, {
    state: { wallpaperDir: '/tmp/wallpapers', weAssetsDir: '' },
  } as never);
  return paths;
}

/** 扫描目录下源码中的裸路由字面量（跳过注释行）。 */
function bareRouteLiterals(dir: string): string[] {
  const offenders: string[] = [];
  for (const f of readdirSync(dir).filter((n) => /\.(ts|tsx)$/.test(n))) {
    const src = readFileSync(join(dir, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (!/\/wallpapers\//.test(line)) return;
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // 注释
      offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  return offenders;
}

describe('跨端路由契约（P0-11）', () => {
  it('host 注册的路径集合与 shared/routes 常量一致', () => {
    expect(new Set(registeredPaths())).toEqual(new Set(WALLPAPER_ROUTE_PATHS));
  });

  it('client 源码不含裸 /wallpapers/ 路径字面量（必须走 shared/routes 构造器）', () => {
    expect(bareRouteLiterals('src/client')).toEqual([]);
  });

  it('host 源码不含裸 /wallpapers/ 路径字面量（必须走 shared/routes 常量）', () => {
    expect(bareRouteLiterals('src/host')).toEqual([]);
  });
});
