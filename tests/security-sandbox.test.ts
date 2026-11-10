import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWallpaperRoutes } from '../src/host/routes.js';

// 安全加固回归（1.0 S1/S2）：见 docs/superpowers/specs/2026-11-10-web-wallpaper-sandbox-hardening-design.md
//
// S1：boot 两条路由只读配置的开机动画路径，query 仅供 client 传同一值；任意其它路径必须 403。
// S2：/wallpapers/web/* 拒绝「Host = 已知 GUI host」的请求（壁纸 iframe 自我导航回 GUI origin 的逃逸路径）；
//     同时危险 MIME（.html/.svg/.js…）一律按 application/octet-stream 下载 + 全局 nosniff。

let dir: string;
let routes: Map<string, (req: any, res: any) => void>;

function makeCtx() {
  const webServer = {
    register: (route: any) => { routes.set(route.path, route.handler); return () => {}; },
  };
  return { inject: (_s: string[], fn: (c: any) => void) => fn({ webServer }) } as any;
}

function makeReq(url: string, headers: Record<string, string> = {}, remoteAddress = '127.0.0.1') {
  return {
    url, method: 'GET',
    headers: { host: '127.0.0.1:58769', ...headers } as Record<string, string>,
    socket: { remoteAddress },
  };
}

/** 普通 JSON 响应。 */
function makeRes() {
  const res: any = {
    statusCode: 200, headers: {} as Record<string, string>, body: null,
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
    writeHead(c: number, h: Record<string, string> = {}) {
      this.statusCode = c;
      for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = v;
    },
    end(b?: any) { this.body = b; },
  };
  return res;
}

/** 流式响应（boot 的 sendSceneAsset 走 createReadStream → pipe）。 */
function makeStreamRes() {
  const chunks: Buffer[] = [];
  const res: any = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.statusCode = 200;
  res.headers = {} as Record<string, string>;
  res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; };
  res.writeHead = (c: number, h: Record<string, string> = {}) => {
    res.statusCode = c;
    for (const [k, v] of Object.entries(h)) res.headers[k.toLowerCase()] = v;
  };
  res.done = new Promise<void>((resolve) => res.on('finish', resolve));
  Object.defineProperty(res, 'body', { get: () => Buffer.concat(chunks) });
  return res;
}

function register(bootAnimationLocalPath: string, weAssetsDir = '') {
  routes = new Map();
  registerWallpaperRoutes(makeCtx(), {
    staticDir: join(dir, 'static'),
    state: { wallpaperDir: dir, weAssetsDir, bootAnimationLocalPath },
  });
}

function seedVideo(name: string): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.from('FAKE-MP4-BYTES'));
  return p;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wp-sec-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('S1：boot 路由只读配置路径', () => {
  it('未配置路径时拒绝任意 ?path=（防任意本地视频读取）', async () => {
    const secret = seedVideo('secret.mp4');
    register('');
    const res = makeStreamRes();
    await routes.get('/wallpapers/boot/local-video')!(
      makeReq('/wallpapers/boot/local-video?path=' + encodeURIComponent(secret)), res,
    );
    expect(res.statusCode).toBe(403);
  });

  it('query 路径与配置不一致时 403', async () => {
    const allowed = seedVideo('allowed.mp4');
    const secret = seedVideo('secret.mp4');
    register(allowed);
    const res = makeStreamRes();
    await routes.get('/wallpapers/boot/local-video')!(
      makeReq('/wallpapers/boot/local-video?path=' + encodeURIComponent(secret)), res,
    );
    expect(res.statusCode).toBe(403);
    expect(res.body.toString()).not.toContain('FAKE-MP4-BYTES'); // 一个字节的视频内容都不下发
  });

  it('query 与配置一致时正常下发（面板保存后立即试播的路径）', async () => {
    const allowed = seedVideo('allowed.mp4');
    register(allowed);
    const res = makeStreamRes();
    const req = makeReq('/wallpapers/boot/local-video?path=' + encodeURIComponent(allowed));
    const done = res.done;
    await routes.get('/wallpapers/boot/local-video')!(req, res);
    await done;
    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toBe('FAKE-MP4-BYTES');
  });

  it('不带 query 时回退到配置路径', async () => {
    const allowed = seedVideo('allowed.mp4');
    register(allowed);
    const res = makeStreamRes();
    const done = res.done;
    await routes.get('/wallpapers/boot/local-video')!(
      makeReq('/wallpapers/boot/local-video'), res,
    );
    await done;
    expect(res.statusCode).toBe(200);
  });

  it('probe 同样只接受配置路径', async () => {
    const allowed = seedVideo('allowed.mp4');
    const secret = seedVideo('secret.mp4');
    register(allowed);
    let res = makeRes();
    await routes.get('/wallpapers/boot/probe')!(
      makeReq('/wallpapers/boot/probe?path=' + encodeURIComponent(secret)), res,
    );
    expect(res.statusCode).toBe(403);
    res = makeRes();
    await routes.get('/wallpapers/boot/probe')!(
      makeReq('/wallpapers/boot/probe?path=' + encodeURIComponent(allowed)), res,
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(String(res.body)).ok).toBe(true);
  });
});

describe('S2：/wallpapers/web 承载 Host 绑定', () => {
  function seedWeb(id: string) {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, 'index.html'), '<html><body>wallpaper</body></html>');
  }

  it('Host 是已知 GUI host → 403（壁纸导航回 GUI origin 的逃逸路径）', async () => {
    seedWeb('w1');
    register('');
    // GUI 页面先请求一个非 /web 路由，记录它的 Host
    await routes.get('/wallpapers/list')!(
      makeReq('/wallpapers/list', { host: '127.0.0.1:58769' }), makeRes(),
    );
    const res = makeRes();
    await routes.get('/wallpapers/web')!(
      makeReq('/wallpapers/web/w1/index.html', { host: '127.0.0.1:58769' }), res,
    );
    expect(res.statusCode).toBe(403);
  });

  it('Host 是壁纸承载 host（另一回环名）→ 200', async () => {
    seedWeb('w1');
    register('');
    await routes.get('/wallpapers/list')!(
      makeReq('/wallpapers/list', { host: '127.0.0.1:58769' }), makeRes(),
    );
    const res = makeRes();
    await routes.get('/wallpapers/web')!(
      makeReq('/wallpapers/web/w1/index.html', { host: 'localhost:58769' }), res,
    );
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('wallpaper');
  });

  it('GUI host 尚未记录时按承载 host 放行（恢复会话首个请求的容错）', async () => {
    seedWeb('w1');
    register('');
    const res = makeRes();
    await routes.get('/wallpapers/web')!(
      makeReq('/wallpapers/web/w1/index.html', { host: 'localhost:58769' }), res,
    );
    expect(res.statusCode).toBe(200);
  });
});

describe('S2：危险 MIME 收紧 + nosniff', () => {
  it('scene asset 的 .html 按 octet-stream 下载（防 GUI 同源 XSS）', async () => {
    const assets = join(dir, 'assets');
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, 'evil.html'), '<script>alert(1)</script>');
    // weAssetsDir = dir（路由内部再拼 /assets），与真实配置语义一致
    register('', dir);
    mkdirSync(join(dir, 'w2'), { recursive: true });
    writeFileSync(join(dir, 'w2', 'project.json'), JSON.stringify({ title: 'W2', type: 'scene' }));
    const res = makeRes();
    await routes.get('/wallpapers/scene')!(
      makeReq('/wallpapers/scene/w2/asset?name=evil.html'), res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('media file 指向 .html 时同样强制下载', async () => {
    mkdirSync(join(dir, 'm1'), { recursive: true });
    writeFileSync(join(dir, 'm1', 'project.json'), JSON.stringify({ title: 'M1', type: 'video', file: 'evil.html' }));
    writeFileSync(join(dir, 'm1', 'evil.html'), '<script>alert(1)</script>');
    register('');
    const res = makeRes();
    await routes.get('/wallpapers/media')!(
      makeReq('/wallpapers/media/m1/file'), res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toContain('attachment');
  });

  it('普通资源响应带 X-Content-Type-Options: nosniff', async () => {
    mkdirSync(join(dir, 'w3'), { recursive: true });
    writeFileSync(join(dir, 'w3', 'index.html'), '<html></html>');
    register('');
    const res = makeRes();
    await routes.get('/wallpapers/web')!(
      makeReq('/wallpapers/web/w3/index.html', { host: 'localhost:58769' }), res,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
