import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWallpaperRoutes, getPkgReader } from '../src/host/routes.js';

// Fix round 1：测试与实现适配真实 WebRoute 形态
// （{ kind: 'exact'|'prefix', path, handler(req, res) }，无 params/query 注入，
//  handler 内自解析 req.url；mock 捕获 {kind, path, handler}，req 用最小伪对象 { url }）

let dir: string;
let staticDir: string;
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
  staticDir = join(dir, 'static');
  mkdirSync(staticDir, { recursive: true });
  routes = new Map();
  captured = [];
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('registerWallpaperRoutes', () => {
  it('registers routes with real WebRoute shape (exact/prefix)', () => {
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    expect(captured).toEqual([
      { kind: 'exact', path: '/wallpapers/list' },
      { kind: 'prefix', path: '/wallpapers/media' },
      { kind: 'prefix', path: '/wallpapers/scene' },
      { kind: 'prefix', path: '/wallpapers/static' },
      { kind: 'prefix', path: '/wallpapers/web' },
      { kind: 'exact', path: '/wallpapers/particle-texture' },
      { kind: 'exact', path: '/wallpapers/probe' },
    ]);
  });
  it('serves list route returning scanned wallpapers', async () => {
    mkdirSync(join(dir, '1'), { recursive: true });
    writeFileSync(join(dir, '1', 'project.json'), JSON.stringify({ title: 'T', type: 'video', file: 'a.mp4' }));
    writeFileSync(join(dir, '1', 'a.mp4'), 'fake');
    const ctx = makeCtx();
    registerWallpaperRoutes(ctx, { wallpaperDir: dir });
    const h = routes.get('exact /wallpapers/list')!;
    const res = makeRes();
    await h({ url: '/wallpapers/list' }, res);
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
    await routes.get('prefix /wallpapers/media')!({ url: '/wallpapers/media/2/preview' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('image/gif');
    expect(res.body.toString('utf8')).toBe('GIF89a');
  });
  it('rejects path traversal in id and asset name', async () => {
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    // id='..'：WHATWG URL dot-segment 规范化将 '..' 段折叠，pathname 段数不足 → 400
    const res1 = makeRes();
    await routes.get('prefix /wallpapers/media')!({ url: '/wallpapers/media/../preview' }, res1);
    expect(res1.statusCode).toBe(400);
    // id 含编码斜杠 %2F（不产生新段、保留在 id 中）→ isSafeToken 拒绝 → 400
    const res1b = makeRes();
    await routes.get('prefix /wallpapers/media')!({ url: '/wallpapers/media/1%2F2/preview' }, res1b);
    expect(res1b.statusCode).toBe(400);
    // name 穿越：query 参数不经过 path 规范化，'..' 原样保留 → 白名单拒绝 → 400
    const res2 = makeRes();
    await routes.get('prefix /wallpapers/scene')!({ url: '/wallpapers/scene/1/asset?name=../../etc/passwd' }, res2);
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
    await routes.get('prefix /wallpapers/scene')!({ url: '/wallpapers/scene/3/asset?name=scene.json' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.body.toString('utf8')).toBe('{"objects":[]}');
  });
  it('scene asset 服务 .flac 音频：原始字节 + audio/flac（壁纸 sound 播放路由，T3.4）', async () => {
    // 2937346640 实测：sound 条目如 "sounds/yutaka hirasaka - acro.flac"（30MB flac），
    // 经 /wallpapers/scene/<id>/asset 路由按 pkg 条目名取原始字节（不解析/不转码）
    const { makePkg } = await import('./fixtures/make-pkg.js');
    const pkg = makePkg([
      { name: 'scene.json', data: Buffer.from('{"objects":[]}', 'utf8') },
      { name: 'sounds/yutaka hirasaka - acro.flac', data: Buffer.from('fLaC\x00fake-flac-bytes') },
    ]);
    const d = join(dir, '5');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'project.json'), JSON.stringify({ type: 'scene' }));
    writeFileSync(join(d, 'scene.pkg'), pkg);
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const res = makeRes();
    await routes.get('prefix /wallpapers/scene')!({
      url: '/wallpapers/scene/5/asset?name=sounds/yutaka%20hirasaka%20-%20acro.flac',
    }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('audio/flac');
    expect(res.body.toString('utf8')).toBe('fLaC\x00fake-flac-bytes'); // 原始字节原样返回
  });

  it('rejects unknown scene action segment', async () => {
    const { makePkg } = await import('./fixtures/make-pkg.js');
    const pkg = makePkg([{ name: 'scene.json', data: Buffer.from('{}', 'utf8') }]);
    const d = join(dir, '4');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'scene.pkg'), pkg);
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const res = makeRes();
    await routes.get('prefix /wallpapers/scene')!({ url: '/wallpapers/scene/4/other?name=scene.json' }, res);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: 'no such action' });
  });
  it('I4: PkgReader 按 (path, mtime) 缓存，避免每个 asset 请求整包重读', async () => {
    const { makePkg } = await import('./fixtures/make-pkg.js');
    const d = join(dir, 'c1');
    mkdirSync(d, { recursive: true });
    const pkgPath = join(d, 'scene.pkg');
    writeFileSync(pkgPath, makePkg([{ name: 'scene.json', data: Buffer.from('{"v":1}', 'utf8') }]));
    const r1 = getPkgReader(pkgPath);
    const r2 = getPkgReader(pkgPath);
    expect(r2).toBe(r1); // 同一路径 + 未变 mtime → 复用同一实例（不再整包读取）
    expect(r1.readEntry('scene.json')!.toString('utf8')).toBe('{"v":1}');
    // mtime 变化 → 重建实例并读到新内容
    writeFileSync(pkgPath, makePkg([{ name: 'scene.json', data: Buffer.from('{"v":2}', 'utf8') }]));
    utimesSync(pkgPath, new Date(Date.now() + 60000), new Date(Date.now() + 60000));
    const r3 = getPkgReader(pkgPath);
    expect(r3).not.toBe(r1);
    expect(r3.readEntry('scene.json')!.toString('utf8')).toBe('{"v":2}');
  });
  it('I4: scene asset handler 连续请求复用缓存且返回一致内容', async () => {
    const { makePkg } = await import('./fixtures/make-pkg.js');
    const d = join(dir, 'c2');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'project.json'), JSON.stringify({ type: 'scene' }));
    writeFileSync(join(d, 'scene.pkg'), makePkg([{ name: 'scene.json', data: Buffer.from('{"objects":[]}', 'utf8') }]));
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const handler = routes.get('prefix /wallpapers/scene')!;
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      await handler({ url: '/wallpapers/scene/c2/asset?name=scene.json' }, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.toString('utf8')).toBe('{"objects":[]}');
    }
  });
  it('web 路由：index.html 默认页与相对资源（css/js/img）静态服务', async () => {
    const d = join(dir, 'w1');
    mkdirSync(join(d, 'css'), { recursive: true });
    mkdirSync(join(d, 'img'), { recursive: true });
    writeFileSync(join(d, 'index.html'), '<html><link rel="stylesheet" href="css/a.css"></html>');
    writeFileSync(join(d, 'css', 'a.css'), 'body{}');
    writeFileSync(join(d, 'img', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const handler = routes.get('prefix /wallpapers/web')!;

    const r1 = makeRes();
    await handler({ url: '/wallpapers/web/w1/index.html' }, r1);
    expect(r1.statusCode).toBe(200);
    expect(r1.headers['Content-Type']).toContain('text/html');
    expect(r1.body.toString('utf8')).toContain('css/a.css');

    const r2 = makeRes();
    await handler({ url: '/wallpapers/web/w1/css/a.css' }, r2);
    expect(r2.statusCode).toBe(200);
    expect(r2.headers['Content-Type']).toContain('text/css');

    const r3 = makeRes();
    await handler({ url: '/wallpapers/web/w1/img/logo.png' }, r3);
    expect(r3.statusCode).toBe(200);
    expect(r3.headers['Content-Type']).toBe('image/png');

    // 缺省路径 → index.html
    const r4 = makeRes();
    await handler({ url: '/wallpapers/web/w1/' }, r4);
    expect(r4.statusCode).toBe(200);
    expect(r4.headers['Content-Type']).toContain('text/html');
  });
  it('web 路由：路径穿越与越界访问被拒绝', async () => {
    const d = join(dir, 'w2');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'index.html'), 'ok');
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const handler = routes.get('prefix /wallpapers/web')!;

    const r1 = makeRes();
    await handler({ url: '/wallpapers/web/w2/../secret' }, r1);
    // WHATWG URL 规范化已折叠 '..' 段 → 剩余路径不存在 → 404（无法越界即防护生效）
    expect(r1.statusCode).toBe(404);

    const r2 = makeRes();
    await handler({ url: '/wallpapers/web/w2/..%2F..%2Fetc%2Fpasswd' }, r2);
    expect(r2.statusCode).toBe(400);

    const r3 = makeRes();
    await handler({ url: '/wallpapers/web/w2/nope.html' }, r3);
    expect(r3.statusCode).toBe(404);

    const r4 = makeRes();
    await handler({ url: '/wallpapers/web/other/id' }, r4);
    expect(r4.statusCode).toBe(404);
  });
  it('静态资源路由：服务插件 wasm 产物（.js/.wasm），带正确 MIME 与 no-store', async () => {
    writeFileSync(join(staticDir, 'we_scene_wasm.js'), 'export const WeScene = {};');
    writeFileSync(join(staticDir, 'we_scene_wasm_bg.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir, staticDir });
    const handler = routes.get('prefix /wallpapers/static')!;

    const r1 = makeRes();
    await handler({ url: '/wallpapers/static/we_scene_wasm.js' }, r1);
    expect(r1.statusCode).toBe(200);
    expect(r1.headers['Content-Type']).toContain('application/javascript');
    expect(r1.headers['Cache-Control']).toBe('no-store');
    expect(r1.body.toString('utf8')).toContain('WeScene');

    const r2 = makeRes();
    await handler({ url: '/wallpapers/static/we_scene_wasm_bg.wasm' }, r2);
    expect(r2.statusCode).toBe(200);
    expect(r2.headers['Content-Type']).toBe('application/wasm');
    expect(r2.body).toEqual(Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  });
  it('静态资源路由：穿越与非法文件名被拒绝', async () => {
    writeFileSync(join(staticDir, 'ok.js'), 'ok');
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir, staticDir });
    const handler = routes.get('prefix /wallpapers/static')!;

    // '..' 段被 WHATWG URL 规范化折叠 → 段数不足 → 400（无法越界即防护生效）
    const r1 = makeRes();
    await handler({ url: '/wallpapers/static/../secret' }, r1);
    expect(r1.statusCode).toBe(400);

    // 编码斜杠 %2F（不产生新段、保留在文件名中）→ isSafeToken 拒绝 → 400
    const r2 = makeRes();
    await handler({ url: '/wallpapers/static/a%2Fb.js' }, r2);
    expect(r2.statusCode).toBe(400);

    // 多段路径 → 400
    const r4 = makeRes();
    await handler({ url: '/wallpapers/static/a/b.js' }, r4);
    expect(r4.statusCode).toBe(400);

    // 文件不存在 → 404
    const r3 = makeRes();
    await handler({ url: '/wallpapers/static/nope.js' }, r3);
    expect(r3.statusCode).toBe(404);
  });

  it('粒子纹理路由：服务 WE 内置粒子纹理（TEXV0005 原始字节，no-store，2026-08-21 方案 A）', async () => {
    const weDir = join(dir, 'we-assets');
    const fogDir = join(weDir, 'assets', 'materials', 'particle', 'fog');
    mkdirSync(fogDir, { recursive: true });
    const texData = Buffer.from('TEXV0005-FAKE-TEX-DATA');
    writeFileSync(join(fogDir, 'fog1.tex'), texData);
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir, weAssetsDir: weDir });
    const handler = routes.get('exact /wallpapers/particle-texture')!;
    const res = makeRes();
    await handler({ url: '/wallpapers/particle-texture?name=particle/fog/fog1' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(texData);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['Content-Type']).toBe('application/octet-stream');
  });

  it('粒子纹理路由：非法 name（穿越）、不存在纹理、缺失 weAssetsDir 被拒绝', async () => {
    const weDir = join(dir, 'we-assets');
    mkdirSync(join(weDir, 'assets', 'materials'), { recursive: true });
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir, weAssetsDir: weDir });
    const handler = routes.get('exact /wallpapers/particle-texture')!;

    // 穿越（..）→ 400
    const r1 = makeRes();
    await handler({ url: '/wallpapers/particle-texture?name=../../secret' }, r1);
    expect(r1.statusCode).toBe(400);
    // 不存在 → 404
    const r2 = makeRes();
    await handler({ url: '/wallpapers/particle-texture?name=particle/fog/nonexist' }, r2);
    expect(r2.statusCode).toBe(404);
    // 缺失 weAssetsDir → 500
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const r3 = makeRes();
    await routes.get('exact /wallpapers/particle-texture')!({ url: '/wallpapers/particle-texture?name=particle/fog/fog1' }, r3);
    expect(r3.statusCode).toBe(500);
  });
});
