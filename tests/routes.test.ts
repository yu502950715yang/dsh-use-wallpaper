import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, existsSync, readdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWallpaperRoutes, getPkgReader } from '../src/host/routes.js';
import { makePkg } from './fixtures/make-pkg.js';
import { makeTex } from './fixtures/make-tex.js';

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

// 流式响应 mock：Writable 收集 chunk；pipe 事件用于区分流式与整块 Buffer 路径
function makeStreamRes() {
  const chunks: Buffer[] = [];
  const res: any = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  });
  res.statusCode = 200;
  res.headers = {} as Record<string, string>;
  res.piped = false;
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.writeHead = (c: number, h: Record<string, string>) => { res.statusCode = c; Object.assign(res.headers, h); };
  res.on('pipe', () => { res.piped = true; });
  res.done = new Promise<void>((resolve, reject) => {
    res.on('finish', resolve);
    res.on('error', reject);
  });
  Object.defineProperty(res, 'body', { get: () => Buffer.concat(chunks) });
  return res;
}

// 壁纸目录 + scene.pkg（场景素材路由用）
function makeScenePkg(id: string, files: Array<{ name: string; data: Uint8Array }>): void {
  const d = join(dir, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'project.json'), JSON.stringify({ type: 'scene' }));
  writeFileSync(join(d, 'scene.pkg'), makePkg(files));
}

// 最小可读请求：EventEmitter + headers/method；body 在 handler 挂好监听后异步吐出
function makeBodyReq(url: string, opts: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}) {
  const req: any = new EventEmitter();
  req.url = url;
  req.method = opts.method ?? 'GET';
  req.headers = opts.headers ?? {};
  req.resume = () => {};
  if (opts.body) {
    setImmediate(() => { req.emit('data', opts.body); req.emit('end'); });
  }
  return req;
}

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
const FRAME_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

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
      { kind: 'prefix', path: '/wallpapers/frame' },
      { kind: 'prefix', path: '/wallpapers/static' },
      { kind: 'prefix', path: '/wallpapers/web' },
      { kind: 'exact', path: '/wallpapers/particle-texture' },
      { kind: 'exact', path: '/wallpapers/probe' },
      { kind: 'exact', path: '/wallpapers/properties' },
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
    // 音频 MIME 即使小于阈值也走流式（<audio> 边下边播），故用 Writable mock 收 chunk
    const res = makeStreamRes();
    await routes.get('prefix /wallpapers/scene')!({
      url: '/wallpapers/scene/5/asset?name=sounds/yutaka%20hirasaka%20-%20acro.flac',
    }, res);
    await res.done;
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('audio/flac');
    expect(res.piped).toBe(true);
    expect(res.body.toString('utf8')).toBe('fLaC\x00fake-flac-bytes'); // 原始字节原样返回
  });

  it('scene asset 小条目仍走整块 Buffer：200 + Content-Length、无 Content-Range', async () => {
    makeScenePkg('small', [{ name: 'scene.json', data: Buffer.from('{"objects":[]}', 'utf8') }]);
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const res = makeRes();
    await routes.get('prefix /wallpapers/scene')!({ url: '/wallpapers/scene/small/asset?name=scene.json' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Length']).toBe(14);
    expect(res.headers['Accept-Ranges']).toBe('bytes');
    expect(res.headers['Content-Range']).toBeUndefined();
    expect(res.body.toString('utf8')).toBe('{"objects":[]}');
  });

  it('scene asset 超过流式阈值 → createReadStream（pipe）且字节完整', async () => {
    const data = Buffer.alloc(64, 0x5a);
    makeScenePkg('big', [
      { name: 'scene.json', data: Buffer.from('{"objects":[]}', 'utf8') },
      { name: 'materials/blob.bin', data },
    ]);
    // 阈值调小：非音视频条目也走流式，验证 pkg 条目绝对偏移
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir, streamAssetBytes: 16 });
    const res = makeStreamRes();
    await routes.get('prefix /wallpapers/scene')!({ url: '/wallpapers/scene/big/asset?name=materials/blob.bin' }, res);
    await res.done;
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/octet-stream');
    expect(res.headers['Content-Length']).toBe(64);
    expect(res.piped).toBe(true);
    expect(res.body.equals(data)).toBe(true);
  });

  it('scene asset Range（小条目，Buffer 切片）：bytes=0-3 / bytes=2- / bytes=-3', async () => {
    makeScenePkg('r1', [{ name: 'scene.json', data: Buffer.from('{"objects":[]}', 'utf8') }]);
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const handler = routes.get('prefix /wallpapers/scene')!;
    const url = '/wallpapers/scene/r1/asset?name=scene.json';

    const r1 = makeRes();
    await handler(makeBodyReq(url, { headers: { range: 'bytes=0-3' } }), r1);
    expect(r1.statusCode).toBe(206);
    expect(r1.headers['Content-Range']).toBe('bytes 0-3/14');
    expect(r1.headers['Content-Length']).toBe(4);
    expect(r1.body.toString('utf8')).toBe('{"ob');

    const r2 = makeRes();
    await handler(makeBodyReq(url, { headers: { range: 'bytes=2-' } }), r2);
    expect(r2.statusCode).toBe(206);
    expect(r2.headers['Content-Range']).toBe('bytes 2-13/14');
    expect(r2.body.toString('utf8')).toBe('objects":[]}');

    const r3 = makeRes();
    await handler(makeBodyReq(url, { headers: { range: 'bytes=-3' } }), r3);
    expect(r3.statusCode).toBe(206);
    expect(r3.headers['Content-Range']).toBe('bytes 11-13/14');
    expect(r3.body.toString('utf8')).toBe('[]}');
  });

  it('scene asset Range（流式，pkg 条目绝对偏移）：bytes=2-5', async () => {
    makeScenePkg('r2', [
      { name: 'other.txt', data: Buffer.from('xxxx', 'utf8') },
      { name: 'sounds/a.mp3', data: Buffer.from('ABCDEFGHIJ', 'utf8') },
    ]);
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const res = makeStreamRes();
    await routes.get('prefix /wallpapers/scene')!(
      makeBodyReq('/wallpapers/scene/r2/asset?name=sounds/a.mp3', { headers: { range: 'bytes=2-5' } }),
      res,
    );
    await res.done;
    expect(res.statusCode).toBe(206);
    expect(res.headers['Content-Range']).toBe('bytes 2-5/10');
    expect(res.headers['Content-Length']).toBe(4);
    expect(res.piped).toBe(true);
    expect(res.body.toString('utf8')).toBe('CDEF');
  });

  it('scene asset 非法/越界 Range → 416 + Content-Range: bytes */size', async () => {
    makeScenePkg('r3', [{ name: 'scene.json', data: Buffer.from('{"objects":[]}', 'utf8') }]);
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const handler = routes.get('prefix /wallpapers/scene')!;
    const url = '/wallpapers/scene/r3/asset?name=scene.json';
    for (const range of ['bytes=99-', 'bytes=abc', 'bytes=0-1,3-4', 'bytes=5-2']) {
      const res = makeRes();
      await handler(makeBodyReq(url, { headers: { range } }), res);
      expect(res.statusCode, range).toBe(416);
      expect(res.headers['Content-Range']).toBe('bytes */14');
      expect(res.headers['Content-Length']).toBe(0);
      expect(res.ended).toBe(true);
    }
  });

  it('scene asset HEAD：与 GET 相同 headers、无 body（音频也不 pipe）', async () => {
    makeScenePkg('h1', [{ name: 'sounds/a.mp3', data: Buffer.from('ABCDEFGHIJ', 'utf8') }]);
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const res = makeStreamRes();
    await routes.get('prefix /wallpapers/scene')!(
      makeBodyReq('/wallpapers/scene/h1/asset?name=sounds/a.mp3', { method: 'HEAD' }),
      res,
    );
    await res.done;
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('audio/mpeg');
    expect(res.headers['Content-Length']).toBe(10);
    expect(res.headers['Accept-Ranges']).toBe('bytes');
    expect(res.piped).toBe(false);
    expect(res.body.length).toBe(0);
  });

  it('scene asset 引擎目录大文件：流式 + Range', async () => {
    const weDir = join(dir, 'we-assets');
    const soundsDir = join(weDir, 'assets', 'sounds');
    mkdirSync(soundsDir, { recursive: true });
    writeFileSync(join(soundsDir, 'big.mp3'), Buffer.from('0123456789', 'utf8'));
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir, weAssetsDir: weDir, streamAssetBytes: 4 });
    const res = makeStreamRes();
    await routes.get('prefix /wallpapers/scene')!(
      makeBodyReq('/wallpapers/scene/e1/asset?name=sounds/big.mp3', { headers: { range: 'bytes=1-3' } }),
      res,
    );
    await res.done;
    expect(res.statusCode).toBe(206);
    expect(res.headers['Content-Range']).toBe('bytes 1-3/10');
    expect(res.piped).toBe(true);
    expect(res.body.toString('utf8')).toBe('123');
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

  // 根因回归（2026-09-29，壁纸 3793620838「In the Mountains 21:9 w lofi」小鸟变圆点）：
  // 粒子材质纹理若打包在壁纸自己的 scene.pkg（materials/<name>.tex）里，而引擎目录没有，
  // 旧路由只查引擎目录 → 404 → client 白图兜底 + maskMode=0 → 粒子渲染成软圆点。
  // WE 的挂载顺序是「壁纸目录/pkg 先于引擎 assets」（lwe Container::m_mountpoints 顺序遍历），
  // 故这里 pkg 优先、引擎目录回退。
  it('粒子纹理路由：带 id 时优先取壁纸 pkg 内的纹理', async () => {
    const { makePkg } = await import('./fixtures/make-pkg.js');
    const weDir = join(dir, 'we-assets');
    const engineTex = join(weDir, 'assets', 'materials', 'particle');
    mkdirSync(engineTex, { recursive: true });
    writeFileSync(join(engineTex, 'BIRD TEST 3 FILTER.tex'), Buffer.from('ENGINE'));
    const pkg = makePkg([
      { name: 'scene.json', data: Buffer.from('{}', 'utf8') },
      { name: 'materials/particle/BIRD TEST 3 FILTER.tex', data: Buffer.from('PKG') },
    ]);
    const wp = join(dir, '3793620838');
    mkdirSync(wp, { recursive: true });
    writeFileSync(join(wp, 'scene.pkg'), pkg);
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir, weAssetsDir: weDir });
    const res = makeRes();
    await routes.get('exact /wallpapers/particle-texture')!({
      url: '/wallpapers/particle-texture?id=3793620838&name=' + encodeURIComponent('particle/BIRD TEST 3 FILTER'),
    }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.toString('utf8')).toBe('PKG');
  });

  it('粒子纹理路由：pkg 内没有该纹理时回退引擎目录', async () => {
    const { makePkg } = await import('./fixtures/make-pkg.js');
    const weDir = join(dir, 'we-assets');
    const engineTex = join(weDir, 'assets', 'materials', 'particle', 'fog');
    mkdirSync(engineTex, { recursive: true });
    writeFileSync(join(engineTex, 'fog1.tex'), Buffer.from('ENGINE'));
    const wp = join(dir, '9');
    mkdirSync(wp, { recursive: true });
    writeFileSync(join(wp, 'scene.pkg'), makePkg([{ name: 'scene.json', data: Buffer.from('{}', 'utf8') }]));
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir, weAssetsDir: weDir });
    const res = makeRes();
    await routes.get('exact /wallpapers/particle-texture')!(
      { url: '/wallpapers/particle-texture?id=9&name=particle/fog/fog1' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.toString('utf8')).toBe('ENGINE');
  });

  it('粒子纹理路由：pkg 命中时不因未配 weAssetsDir 而失败', async () => {
    const { makePkg } = await import('./fixtures/make-pkg.js');
    const pkg = makePkg([
      { name: 'scene.json', data: Buffer.from('{}', 'utf8') },
      { name: 'materials/workshop/2478413376/particle/bird sprite sheet.tex', data: Buffer.from('PKG') },
    ]);
    const wp = join(dir, '3793620838');
    mkdirSync(wp, { recursive: true });
    writeFileSync(join(wp, 'scene.pkg'), pkg);
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const res = makeRes();
    await routes.get('exact /wallpapers/particle-texture')!({
      url: '/wallpapers/particle-texture?id=3793620838&name='
        + encodeURIComponent('workshop/2478413376/particle/bird sprite sheet'),
    }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.toString('utf8')).toBe('PKG');
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

  // ── scene asset 的「引擎 assets 目录」回退（2026-10-10）────────────────────────────
  // 根因：WE 把**引擎 assets 目录也挂在 VFS 的 `/`**（lwe WallpaperApplication.cpp:85-99 的挂载顺序：
  // 壁纸目录 → scene.pkg → 引擎 assets），所以 scene.json 里的 `fonts/X.ttf` 是 VFS 相对路径，
  // 文件可能只在 `<WE>/assets/fonts/` 里。此前该路由**只查 pkg** ⇒ 404 ⇒ 客户端回退 sans-serif。
  // 全库实测：33 个带 font 的 text 对象里 21 个是文件路径，其中 **11 个只在引擎目录**（5 张壁纸），
  // 用户报告「魔兽之门」1922570576 的 3D Clock 用的就是它（该 pkg 48 个条目里零字体文件）。
  // 同类语义的先例：粒子纹理路由（2026-09-29 为 3793620838 的小鸟纹理加了同样的 pkg → 引擎回退）。
  describe('scene asset 引擎目录回退（字体等引擎内置素材）', () => {
    const FONT_REL = 'fonts/CursedTimerUlil-Aznm.ttf';       // 该壁纸 scene.json 里写的路径
    const ENGINE_BYTES = Buffer.from('ENGINE-TTF-BYTES', 'utf8');
    const PKG_BYTES = Buffer.from('PKG-TTF-BYTES', 'utf8');

    /** 造一份「scene.pkg 里（默认）没有字体」的壁纸，并把字体放进引擎目录。 */
    function makeFontFixture(opts: { engine?: boolean; inPkg?: boolean; weAssets?: boolean } = {}) {
      const weDir = join(dir, 'we-assets');
      if (opts.engine !== false) {
        mkdirSync(join(weDir, 'assets', 'fonts'), { recursive: true });
        writeFileSync(join(weDir, 'assets', FONT_REL), ENGINE_BYTES);
      }
      const wp = join(dir, '1922570576');
      mkdirSync(wp, { recursive: true });
      const entries = [{ name: 'scene.json', data: Buffer.from('{"objects":[]}', 'utf8') }];
      if (opts.inPkg) entries.push({ name: FONT_REL, data: PKG_BYTES });
      writeFileSync(join(wp, 'scene.pkg'), makePkg(entries));
      registerWallpaperRoutes(makeCtx(), opts.weAssets === false
        ? { wallpaperDir: dir }
        : { wallpaperDir: dir, weAssetsDir: weDir });
      return { weDir, wp };
    }

    it('pkg 未命中时回退引擎 assets 目录（font/ttf + no-store + 原始字节）', async () => {
      makeFontFixture();
      const res = makeRes();
      await routes.get('prefix /wallpapers/scene')!(
        { url: `/wallpapers/scene/1922570576/asset?name=${encodeURIComponent(FONT_REL)}` }, res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('font/ttf');
      expect(res.headers['Cache-Control']).toBe('no-store');
      expect(res.body).toEqual(ENGINE_BYTES);
    });

    it('pkg 与引擎目录都有时以 pkg 优先（对齐 WE 挂载顺序）', async () => {
      makeFontFixture({ inPkg: true });
      const res = makeRes();
      await routes.get('prefix /wallpapers/scene')!(
        { url: `/wallpapers/scene/1922570576/asset?name=${encodeURIComponent(FONT_REL)}` }, res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(PKG_BYTES);
    });

    it('scene.pkg 不存在但引擎目录命中 → 200（引擎素材不依赖壁纸包）', async () => {
      const weDir = join(dir, 'we-assets');
      mkdirSync(join(weDir, 'assets', 'fonts'), { recursive: true });
      writeFileSync(join(weDir, 'assets', FONT_REL), ENGINE_BYTES);
      registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir, weAssetsDir: weDir });
      const res = makeRes();
      await routes.get('prefix /wallpapers/scene')!(
        { url: `/wallpapers/scene/nopkg/asset?name=${encodeURIComponent(FONT_REL)}` }, res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(ENGINE_BYTES);
    });

    it('两处都没有 → 404；未配 weAssetsDir 且 pkg 未命中 → 404（不是 500）', async () => {
      makeFontFixture({ engine: false });
      const r1 = makeRes();
      await routes.get('prefix /wallpapers/scene')!(
        { url: `/wallpapers/scene/1922570576/asset?name=${encodeURIComponent(FONT_REL)}` }, r1);
      expect(r1.statusCode).toBe(404);
      expect(JSON.parse(r1.body.toString('utf8'))).toEqual({ error: 'no such asset' });

      makeFontFixture({ weAssets: false });
      const r2 = makeRes();
      await routes.get('prefix /wallpapers/scene')!(
        { url: `/wallpapers/scene/1922570576/asset?name=${encodeURIComponent(FONT_REL)}` }, r2);
      expect(r2.statusCode).toBe(404);
    });

    it('穿越变体（%2e%2e%2f / ../）取不到引擎目录之外的文件', async () => {
      const weDir = join(dir, 'we-assets');
      mkdirSync(join(weDir, 'assets', 'fonts'), { recursive: true });
      writeFileSync(join(weDir, 'assets', 'fonts', 'ok.ttf'), Buffer.from('OK'));
      writeFileSync(join(weDir, 'secret'), Buffer.from('TOPSECRET'));
      registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir, weAssetsDir: weDir });
      const handler = routes.get('prefix /wallpapers/scene')!;

      // 编码斜杠（不经过 WHATWG 规范化）→ 白名单含 '/' 故放行，但 resolveEngineAsset 拒绝 '..' ⇒ 404
      const r1 = makeRes();
      await handler({ url: '/wallpapers/scene/1922570576/asset?name=%2e%2e%2fsecret' }, r1);
      expect([400, 404]).toContain(r1.statusCode);
      expect(String(r1.body ?? '')).not.toContain('TOPSECRET');

      // 原始 '../' 在 query 里不经规范化 → 白名单拒绝 → 400
      const r2 = makeRes();
      await handler({ url: '/wallpapers/scene/1922570576/asset?name=../secret' }, r2);
      expect(r2.statusCode).toBe(400);

      // 合法名仍可用（证明不是把整条路由打死）
      const r3 = makeRes();
      await handler({ url: '/wallpapers/scene/1922570576/asset?name=' + encodeURIComponent('fonts/ok.ttf') }, r3);
      expect(r3.statusCode).toBe(200);
      expect(r3.body.toString('utf8')).toBe('OK');
    });

    it('纯函数边界：isSafeAssetName / resolveEngineAsset', async () => {
      const { isSafeAssetName, resolveEngineAsset } = await import('../src/host/routes.js');
      expect(typeof isSafeAssetName).toBe('function');
      expect(typeof resolveEngineAsset).toBe('function');
      // 只放行相对路径
      expect(isSafeAssetName('fonts/a.ttf')).toBe(true);
      expect(isSafeAssetName('fonts/workshop/1/x.otf')).toBe(true);
      expect(isSafeAssetName('')).toBe(false);
      expect(isSafeAssetName('../secret')).toBe(false);
      expect(isSafeAssetName('a/../b.ttf')).toBe(false);
      expect(isSafeAssetName('..\\secret')).toBe(false);
      expect(isSafeAssetName('/etc/passwd')).toBe(false);
      // 解析：必须落在 <weAssetsDir>/assets 之内且是文件
      const weDir = join(dir, 'we-assets');
      mkdirSync(join(weDir, 'assets', 'fonts'), { recursive: true });
      writeFileSync(join(weDir, 'assets', 'fonts', 'ok.ttf'), 'OK');
      writeFileSync(join(weDir, 'secret'), 'TOPSECRET');
      expect(resolveEngineAsset(weDir, 'fonts/ok.ttf')).toBe(join(weDir, 'assets', 'fonts', 'ok.ttf'));
      expect(resolveEngineAsset(weDir, '../secret')).toBeNull();
      // 跨盘绝对路径（Windows 上 resolve 会跳出 base）⇒ 必须为 null（不靠平台差异兜底）
      expect(resolveEngineAsset(weDir, 'C:/windows/win.ini')).toBeNull();
      expect(resolveEngineAsset(weDir, 'fonts/nope.ttf')).toBeNull();
      expect(resolveEngineAsset(weDir, 'fonts')).toBeNull(); // 目录不是文件
    });
  });

  // ── 降级链：内嵌 MP4 探测/取流 + 抓帧缓存 ─────────────────────────────────────────
  it('video-probe / embedded-video / frame 路由', async () => {
    const wallDir = mkdtempSync(join(tmpdir(), 'we-routes-'));
    const wall = join(wallDir, '42');
    mkdirSync(wall, { recursive: true });
    writeFileSync(join(wall, 'project.json'), JSON.stringify({ type: 'Scene', file: 'scene.pkg' }));
    writeFileSync(join(wall, 'scene.pkg'), makePkg([
      { name: 'scene.json', data: Buffer.from(JSON.stringify({ objects: [] })) },
      { name: 'materials/video.tex', data: makeTex({ flags: 32, container: 'TEXB0004', images: [[{ width: 2, height: 2, data: MP4 }]] }) },
    ]));
    const frameDir = mkdtempSync(join(tmpdir(), 'we-frames-'));
    try {
      registerWallpaperRoutes(makeCtx(), { wallpaperDir: wallDir, dataDir: frameDir });
      const sceneRoute = routes.get('prefix /wallpapers/scene')!;
      const frameRoute = routes.get('prefix /wallpapers/frame')!;

      const probeRes = makeRes();
      await sceneRoute({ url: '/wallpapers/scene/42/video-probe' }, probeRes);
      expect(probeRes.statusCode).toBe(200);
      expect(JSON.parse(probeRes.body.toString('utf8'))).toEqual({ video: true });

      const videoRes = makeRes();
      await sceneRoute({ url: '/wallpapers/scene/42/embedded-video' }, videoRes);
      expect(videoRes.statusCode).toBe(200);
      expect(videoRes.headers['Content-Type']).toBe('video/mp4');
      expect(videoRes.headers['Cache-Control']).toBe('no-store');
      expect(Buffer.from(videoRes.body).subarray(4, 8).toString('ascii')).toBe('ftyp');

      // 无 pkg / 无样本 → 200 { video:false } 与 404（不是 500）
      const noPkgProbe = makeRes();
      await sceneRoute({ url: '/wallpapers/scene/99/video-probe' }, noPkgProbe);
      expect(noPkgProbe.statusCode).toBe(200);
      expect(JSON.parse(noPkgProbe.body.toString('utf8'))).toEqual({ video: false });
      const noPkgVideo = makeRes();
      await sceneRoute({ url: '/wallpapers/scene/99/embedded-video' }, noPkgVideo);
      expect(noPkgVideo.statusCode).toBe(404);

      const postRes = makeRes();
      await frameRoute(makeBodyReq('/wallpapers/frame/42', {
        method: 'POST',
        headers: { 'content-type': 'image/png', 'content-length': String(FRAME_PNG.length) },
        body: FRAME_PNG,
      }), postRes);
      expect(postRes.statusCode).toBe(201);
      expect(JSON.parse(postRes.body.toString('utf8'))).toEqual({ ok: true });
      expect(existsSync(join(frameDir, 'frames', '42.png'))).toBe(true);

      const getRes = makeRes();
      await frameRoute({ url: '/wallpapers/frame/42' }, getRes);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.headers['Content-Type']).toBe('image/png');
      expect(getRes.headers['Cache-Control']).toBe('no-store');
      expect(Buffer.from(getRes.body).equals(FRAME_PNG)).toBe(true);

      // HEAD 走 GET 分支（Node 对 HEAD 自动省略 body），Task 6 的存在性探测依赖它
      const headRes = makeRes();
      await frameRoute(makeBodyReq('/wallpapers/frame/42', { method: 'HEAD' }), headRes);
      expect(headRes.statusCode).toBe(200);

      const delRes = makeRes();
      await frameRoute(makeBodyReq('/wallpapers/frame/42', { method: 'DELETE' }), delRes);
      expect(delRes.statusCode).toBe(200);
      expect(JSON.parse(delRes.body.toString('utf8'))).toEqual({ ok: true });

      const goneRes = makeRes();
      await frameRoute({ url: '/wallpapers/frame/42' }, goneRes);
      expect(goneRes.statusCode).toBe(404);
    } finally {
      rmSync(wallDir, { recursive: true, force: true });
      rmSync(frameDir, { recursive: true, force: true });
    }
  });

  it('frame 路由：媒体类型/大小上限/缺失 dataDir/非法 id', async () => {
    const frameDir = mkdtempSync(join(tmpdir(), 'we-frames-'));
    try {
      registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir, dataDir: frameDir });
      const frameRoute = routes.get('prefix /wallpapers/frame')!;

      // 非 image/png → 415
      const wrongType = makeRes();
      await frameRoute(makeBodyReq('/wallpapers/frame/1', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.from('{}'),
      }), wrongType);
      expect(wrongType.statusCode).toBe(415);

      // Content-Length 预检超限 → 413（无需真的发 body）
      const declaredBig = makeRes();
      await frameRoute(makeBodyReq('/wallpapers/frame/1', {
        method: 'POST',
        headers: { 'content-type': 'image/png', 'content-length': String(12 * 1024 * 1024 + 1) },
      }), declaredBig);
      expect(declaredBig.statusCode).toBe(413);

      // 无 Content-Length，流式累计超限 → 413
      const streamBig = makeRes();
      await frameRoute(makeBodyReq('/wallpapers/frame/1', {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: Buffer.concat([FRAME_PNG, Buffer.alloc(12 * 1024 * 1024)]),
      }), streamBig);
      expect(streamBig.statusCode).toBe(413);

      // 未超限但不是 PNG → 400
      const badPng = makeRes();
      await frameRoute(makeBodyReq('/wallpapers/frame/1', {
        method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.from('not png'),
      }), badPng);
      expect(badPng.statusCode).toBe(400);

      // 非法 id / 多段路径 → 400
      const badId = makeRes();
      await frameRoute({ url: '/wallpapers/frame/1%2F2' }, badId);
      expect(badId.statusCode).toBe(400);
      const extraSeg = makeRes();
      await frameRoute({ url: '/wallpapers/frame/1/x' }, extraSeg);
      expect(extraSeg.statusCode).toBe(400);
      const badProbeId = makeRes();
      await routes.get('prefix /wallpapers/scene')!({ url: '/wallpapers/scene/1%2F2/video-probe' }, badProbeId);
      expect(badProbeId.statusCode).toBe(400);

      // DELETE 幂等
      const del1 = makeRes();
      await frameRoute(makeBodyReq('/wallpapers/frame/2', { method: 'DELETE' }), del1);
      const del2 = makeRes();
      await frameRoute(makeBodyReq('/wallpapers/frame/2', { method: 'DELETE' }), del2);
      expect(JSON.parse(del1.body.toString('utf8'))).toEqual({ ok: true });
      expect(JSON.parse(del2.body.toString('utf8'))).toEqual({ ok: true });

      // 无 dataDir：POST → 500；GET → 404（无帧，不误报 500）
      registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
      const noDataDirFrameRoute = routes.get('prefix /wallpapers/frame')!;
      const noDataDirPost = makeRes();
      await noDataDirFrameRoute(makeBodyReq('/wallpapers/frame/3', {
        method: 'POST', headers: { 'content-type': 'image/png' }, body: FRAME_PNG,
      }), noDataDirPost);
      expect(noDataDirPost.statusCode).toBe(500);
      const noDataDirGet = makeRes();
      await noDataDirFrameRoute({ url: '/wallpapers/frame/3' }, noDataDirGet);
      expect(noDataDirGet.statusCode).toBe(404);
    } finally {
      rmSync(frameDir, { recursive: true, force: true });
    }
  });

  // ── v0.9 Task 2：壁纸用户属性（project.json 四类型 ∩ scene.json {user} 引用）──────────
  it('GET /wallpapers/properties：返回被引用的四类型属性（label 去 HTML、usedBy 标注）', async () => {
    const d = join(dir, 'props1');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'project.json'), JSON.stringify({
      type: 'scene',
      general: { properties: {
        clouds: { order: 2.5, text: '<b>云层</b>', type: 'bool', value: true },
        speed: { order: 1, text: '速度', type: 'slider', value: 1 },
        locked: { order: 3, text: '锁定', type: 'bool', value: true, editable: false },
      } },
    }));
    writeFileSync(join(d, 'scene.pkg'), makePkg([{ name: 'scene.json', data: Buffer.from(JSON.stringify({
      objects: [
        { visible: { user: 'clouds', value: true } },
        { visible: { user: 'speed', value: true } },
        { visible: { user: 'locked', value: true } },
        { visible: true },
      ],
    })) }]));
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const res = makeRes();
    await routes.get('exact /wallpapers/properties')!({ url: '/wallpapers/properties?id=props1' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({
      audioProcessing: false,
      properties: [
        {
          key: 'speed', label: '速度', type: 'slider', value: 1, min: 0, max: 1, order: 1,
          usedBy: ['objects[].visible'],
        },
        {
          key: 'clouds', label: '云层', type: 'bool', value: true, order: 2.5,
          usedBy: ['objects[].visible'],
        },
      ],
    });
    // 只读：请求后目录里没有新增/改写文件
    expect(readdirSync(d).sort()).toEqual(['project.json', 'scene.pkg']);
  });

  it('GET /wallpapers/properties：非法/缺失 id → 400', async () => {
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const handler = routes.get('exact /wallpapers/properties')!;
    for (const url of [
      '/wallpapers/properties',
      '/wallpapers/properties?id=',
      '/wallpapers/properties?id=..%2Fetc',
      '/wallpapers/properties?id=a%2Fb',
    ]) {
      const res = makeRes();
      await handler({ url }, res);
      expect(res.statusCode).toBe(400);
    }
  });

  it('GET /wallpapers/properties：project.json / scene.pkg / scene.json 缺失或解析失败 → 200 空数组（不 500）', async () => {
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const handler = routes.get('exact /wallpapers/properties')!;
    const bodyOf = (res: any) => JSON.parse(res.body.toString('utf8'));

    // 目录都不存在（project.json 缺失）
    let res = makeRes();
    await handler({ url: '/wallpapers/properties?id=nope' }, res);
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ audioProcessing: false, properties: [] });

    // project.json 坏 JSON
    const bad = join(dir, 'bad');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'project.json'), '{oops');
    res = makeRes();
    await handler({ url: '/wallpapers/properties?id=bad' }, res);
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ audioProcessing: false, properties: [] });

    // 有 project.json 但没有 scene.pkg
    const nopkg = join(dir, 'nopkg');
    mkdirSync(nopkg, { recursive: true });
    writeFileSync(join(nopkg, 'project.json'), JSON.stringify({
      general: { properties: { clouds: { type: 'bool', value: true } } },
    }));
    res = makeRes();
    await handler({ url: '/wallpapers/properties?id=nopkg' }, res);
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ audioProcessing: false, properties: [] });

    // pkg 里没有 scene.json
    const noscene = join(dir, 'noscene');
    mkdirSync(noscene, { recursive: true });
    writeFileSync(join(noscene, 'project.json'), JSON.stringify({ general: { properties: {} } }));
    writeFileSync(join(noscene, 'scene.pkg'), makePkg([{ name: 'other.json', data: Buffer.from('{}') }]));
    res = makeRes();
    await handler({ url: '/wallpapers/properties?id=noscene' }, res);
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ audioProcessing: false, properties: [] });

    // scene.json 坏 JSON
    const badscene = join(dir, 'badscene');
    mkdirSync(badscene, { recursive: true });
    writeFileSync(join(badscene, 'project.json'), JSON.stringify({ general: { properties: {} } }));
    writeFileSync(join(badscene, 'scene.pkg'), makePkg([{ name: 'scene.json', data: Buffer.from('{oops') }]));
    res = makeRes();
    await handler({ url: '/wallpapers/properties?id=badscene' }, res);
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ audioProcessing: false, properties: [] });
  });

  it('GET /wallpapers/properties：每次请求重读 project.json（不缓存可变状态）', async () => {
    const d = join(dir, 'props2');
    mkdirSync(d, { recursive: true });
    const scenePkg = makePkg([{ name: 'scene.json', data: Buffer.from(JSON.stringify({
      objects: [{ visible: { user: 'clouds', value: true } }],
    })) }]);
    writeFileSync(join(d, 'scene.pkg'), scenePkg);
    writeFileSync(join(d, 'project.json'), JSON.stringify({
      general: { properties: { clouds: { type: 'bool', value: true, text: '云层' } } },
    }));
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const handler = routes.get('exact /wallpapers/properties')!;
    const first = makeRes();
    await handler({ url: '/wallpapers/properties?id=props2' }, first);
    expect(JSON.parse(first.body.toString('utf8')).properties).toHaveLength(1);

    // 关掉该属性（去掉 properties 里的键）后同一进程内的下一次请求必须看到新值
    writeFileSync(join(d, 'project.json'), JSON.stringify({ general: { properties: {} } }));
    const second = makeRes();
    await handler({ url: '/wallpapers/properties?id=props2' }, second);
    expect(JSON.parse(second.body.toString('utf8'))).toEqual({ audioProcessing: false, properties: [] });
  });
});
