// 真实路由级判据：/wallpapers/web 对 HTML 注入 shim，对非 HTML 原样返回。
// 夹具用本机工坊 1184182304 的 index.html 副本（只读源，缺素材即跳过）。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registerWallpaperRoutes } from '../src/host/routes.js';
import { POINTER_SHIM_SOURCE } from '../src/shared/pointer-shim.js';

const WE_WORKSHOP = process.env.WE_WORKSHOP ?? 'D:/Steam/steamapps/workshop/content/431960';
const EVA5 = join(WE_WORKSHOP, '1184182304');
const haveFixture = existsSync(join(EVA5, 'index.html'));

interface WebRoute { kind: string; path: string; handler: (req: any, res: any) => void }

/** 取到真实的 /wallpapers/web 路由处理器（走 registerWallpaperRoutes，不另写一份桩）。 */
function webRoute(): WebRoute {
  const handlers: WebRoute[] = [];
  // ctx.inject(deps, cb)：真实 ctx 由 cordis 依赖注入，此处同步回调即可（注册是同步的）。
  const ctx = {
    inject: (_deps: string[], cb: (c: any) => void) => cb({ webServer: { register: (h: any) => handlers.push(h) } }),
  };
  registerWallpaperRoutes(ctx as any, { wallpaperDir: WE_WORKSHOP });
  const route = handlers.find((h) => h.path === '/wallpapers/web');
  expect(route, '未注册 /wallpapers/web 路由').toBeTruthy();
  return route!;
}

/** 造一个最小 res 桩，收集状态/头/正文。 */
function makeRes() {
  const out = { status: 0, headers: {} as Record<string, string>, body: Buffer.alloc(0) as Buffer };
  const res = {
    writeHead(code: number, headers: Record<string, string>) { out.status = code; out.headers = headers ?? {}; },
    end(body: any) { out.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? '')); },
  };
  return { out, res };
}

describe.skipIf(!haveFixture)('/wallpapers/web 路由的指针 shim 注入', () => {
  it('HTML 响应里被注入 shim（进到 <head>，且在壁纸自带脚本之前）', () => {
    const { out, res } = makeRes();
    webRoute().handler({ url: '/wallpapers/web/1184182304/index.html' } as any, res as any);

    expect(out.status).toBe(200);
    expect(out.headers['Content-Type']).toContain('text/html');
    const html = out.body.toString('utf8');
    // shim 的独有标记（不会被壁纸自身代码误命中）
    expect(html).toContain('__wpPointerShimInstalled');
    expect(html).toContain(POINTER_SHIM_SOURCE.slice(0, 60));
    expect(html.indexOf('__wpPointerShimInstalled')).toBeLessThan(html.indexOf('jquery.parallax.min.js'));
    // 正文没被改坏：原有脚本标签仍在，且长度只增加了 shim
    const raw = readFileSync(resolve(EVA5, 'index.html'), 'utf8');
    expect(html).toContain('js/jquery.parallax.min.js');
    expect(html.length).toBeGreaterThan(raw.length);
    expect(out.headers['Cache-Control']).toBe('no-store');
  });

  it('非 HTML 响应原样返回（不注入、不损坏二进制）', () => {
    const { out, res } = makeRes();
    webRoute().handler({ url: '/wallpapers/web/1184182304/js/jquery.parallax.min.js' } as any, res as any);

    expect(out.status).toBe(200);
    expect(out.headers['Content-Type']).toContain('javascript');
    const raw = readFileSync(join(EVA5, 'js/jquery.parallax.min.js'));
    expect(out.body.equals(raw)).toBe(true);
  });
});
