import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWallpaperRoutes } from '../src/host/routes.js';

let dir: string;
let routes: Map<string, (req: any, res: any) => void>;
let captured: Array<{ kind: string; path: string }>;

// 偏差修正（brief 原文为 `fn({ webServer: ctx.webServer })`，其中 ctx 是未定义的
// 自由变量，运行时会 ReferenceError；故提取局部 webServer 常量，语义与 brief 意图一致）
function makeCtx() {
  const webServer = {
    register: (route: any) => {
      captured.push({ kind: route.kind, path: route.path });
      routes.set(route.kind + ' ' + route.path, route.handler);
      return () => {};
    },
  };
  return {
    inject: (_s: string[], fn: (c: any) => void) => fn({ webServer }),
    webServer,
  } as any;
}
function makeRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as any,
    ended: false,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    writeHead(c: number, h: Record<string, string>) { this.statusCode = c; Object.assign(this.headers, h); },
    end(b?: any) { this.body = b; this.ended = true; },
  };
  return res;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp-route-'));
  routes = new Map();
  captured = [];
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('registerWallpaperRoutes', () => {
  it('registers list route returning scanned wallpapers', async () => {
    mkdirSync(join(dir, '1'), { recursive: true });
    writeFileSync(join(dir, '1', 'project.json'), JSON.stringify({ title: 'T', type: 'video', file: 'a.mp4' }));
    writeFileSync(join(dir, '1', 'a.mp4'), 'fake');
    const ctx = makeCtx();
    registerWallpaperRoutes(ctx, { wallpaperDir: dir });
    const h = routes.get('GET /wallpapers/list')!;
    const res = makeRes();
    await h({}, res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body.toString('utf8'));
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('1');
  });
  it('serves preview file with content type by extension', async () => {
    mkdirSync(join(dir, '2'), { recursive: true });
    writeFileSync(join(dir, '2', 'project.json'), JSON.stringify({ type: 'scene' }));
    writeFileSync(join(dir, '2', 'preview.gif'), 'GIF89a');
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const res = makeRes();
    await routes.get('GET /wallpapers/media/:id/preview')!({ params: { id: '2' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('image/gif');
    expect(res.body.toString('utf8')).toBe('GIF89a');
  });
  it('rejects path traversal in id and asset name', async () => {
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const res1 = makeRes();
    await routes.get('GET /wallpapers/media/:id/preview')!({ params: { id: '..' } }, res1);
    expect(res1.statusCode).toBe(400);
    const res2 = makeRes();
    await routes.get('GET /wallpapers/scene/:id/asset')!({ params: { id: '1' }, query: { name: '../../etc/passwd' } }, res2);
    expect(res2.statusCode).toBe(400);
  });
  it('serves scene asset from pkg by entry name', async () => {
    // 构造一个含 scene.pkg 的壁纸目录（用 makePkg）
    const { makePkg } = await import('./fixtures/make-pkg.js');
    const pkg = makePkg([{ name: 'scene.json', data: Buffer.from('{"objects":[]}', 'utf8') }]);
    const d = join(dir, '3');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'project.json'), JSON.stringify({ type: 'scene' }));
    writeFileSync(join(d, 'scene.pkg'), pkg);
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const res = makeRes();
    await routes.get('GET /wallpapers/scene/:id/asset')!({ params: { id: '3' }, query: { name: 'scene.json' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(res.body.toString('utf8')).toBe('{"objects":[]}');
  });
});
