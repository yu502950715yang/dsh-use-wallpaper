import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWallpaperRoutes, isLoopbackRemote, resolveBootVideoPath } from '../src/host/routes.js';

let dir: string;
let routes: Map<string, (req: any, res: any) => void>;

function makeCtx() {
  const webServer = {
    register: (route: any) => { routes.set(route.path, route.handler); return () => {}; },
  };
  return { inject: (_s: string[], fn: (c: any) => void) => fn({ webServer }) } as any;
}

function makeReq(url: string, remoteAddress = '127.0.0.1') {
  return { url, method: 'GET', headers: {} as Record<string, string>, socket: { remoteAddress } };
}

function makeStreamRes() {
  const chunks: Buffer[] = [];
  const res: any = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.statusCode = 200;
  res.headers = {} as Record<string, string>;
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.writeHead = (c: number, h: Record<string, string>) => { res.statusCode = c; Object.assign(res.headers, h); };
  res.done = new Promise<void>((resolve) => res.on('finish', resolve));
  Object.defineProperty(res, 'body', { get: () => Buffer.concat(chunks) });
  return res;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp-boot-'));
  routes = new Map();
  registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('isLoopbackRemote', () => {
  it('只认回环地址', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(isLoopbackRemote(a)).toBe(true);
    for (const a of ['192.168.1.5', '10.0.0.1', '::ffff:8.8.8.8', undefined, '']) expect(isLoopbackRemote(a)).toBe(false);
  });
});

describe('resolveBootVideoPath', () => {
  it('拒绝相对路径与非白名单扩展名', () => {
    expect(resolveBootVideoPath('boot.mp4')).toEqual({ ok: false, code: 400 });
    expect(resolveBootVideoPath('')).toEqual({ ok: false, code: 400 });
    expect(resolveBootVideoPath(null)).toEqual({ ok: false, code: 400 });
    expect(resolveBootVideoPath(join(dir, 'a.exe'))).toEqual({ ok: false, code: 400 });
  });
  it('不存在的文件 404；合法 mp4 返回 size', () => {
    expect(resolveBootVideoPath(join(dir, 'missing.mp4'))).toEqual({ ok: false, code: 404 });
    const p = join(dir, 'ok.mp4');
    writeFileSync(p, 'abcdef');
    expect(resolveBootVideoPath(p)).toEqual({ ok: true, file: p, size: 6 });
  });
  it('NUL 路径 400；以 .mp4 结尾的目录 404', () => {
    expect(resolveBootVideoPath(join(dir, 'nul\0.mp4'))).toEqual({ ok: false, code: 400 });
    mkdirSync(join(dir, 'folder.mp4'));
    expect(resolveBootVideoPath(join(dir, 'folder.mp4'))).toEqual({ ok: false, code: 404 });
  });
});

const handler = (path: string) => routes.get(path)!;

describe('GET /wallpapers/boot/local-video', () => {
  it('非回环 403', async () => {
    const res = makeStreamRes();
    handler('/wallpapers/boot/local-video')(makeReq('/wallpapers/boot/local-video?path=x', '10.1.2.3'), res);
    await res.done;
    expect(res.statusCode).toBe(403);
  });
  it('合法 mp4 整块返回 200；Range 返回 206', async () => {
    const p = join(dir, 'clip.mp4');
    writeFileSync(p, Buffer.from('0123456789'));
    const url = '/wallpapers/boot/local-video?path=' + encodeURIComponent(p);

    const res = makeStreamRes();
    handler('/wallpapers/boot/local-video')(makeReq(url), res);
    await res.done;
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('video/mp4');
    expect(res.body.toString()).toBe('0123456789');

    const res2 = makeStreamRes();
    const req2 = { ...makeReq(url), headers: { range: 'bytes=2-4' } };
    handler('/wallpapers/boot/local-video')(req2, res2);
    await res2.done;
    expect(res2.statusCode).toBe(206);
    expect(res2.headers['Content-Range']).toBe('bytes 2-4/10');
    expect(res2.body.toString()).toBe('234');
  });
  it('相对路径 400、不存在 404', async () => {
    const r1 = makeStreamRes();
    handler('/wallpapers/boot/local-video')(makeReq('/wallpapers/boot/local-video?path=a.mp4'), r1);
    await r1.done;
    expect(r1.statusCode).toBe(400);
    const r2 = makeStreamRes();
    handler('/wallpapers/boot/local-video')(makeReq('/wallpapers/boot/local-video?path=' + encodeURIComponent(join(dir, 'no.mp4'))), r2);
    await r2.done;
    expect(r2.statusCode).toBe(404);
  });
  it('NUL 路径 400；以 .mp4 结尾的目录 404', async () => {
    const r1 = makeStreamRes();
    handler('/wallpapers/boot/local-video')(makeReq('/wallpapers/boot/local-video?path=' + encodeURIComponent(join(dir, 'nul\0.mp4'))), r1);
    await r1.done;
    expect(r1.statusCode).toBe(400);

    mkdirSync(join(dir, 'folder.mp4'));
    const r2 = makeStreamRes();
    handler('/wallpapers/boot/local-video')(makeReq('/wallpapers/boot/local-video?path=' + encodeURIComponent(join(dir, 'folder.mp4'))), r2);
    await r2.done;
    expect(r2.statusCode).toBe(404);
  });
  it('mov/m4v/ogv 下发对应视频 MIME', async () => {
    const cases = [['.mov', 'video/quicktime'], ['.m4v', 'video/x-m4v'], ['.ogv', 'video/ogg']] as const;
    for (const [ext, mime] of cases) {
      const p = join(dir, 'clip' + ext);
      writeFileSync(p, 'x');
      const res = makeStreamRes();
      handler('/wallpapers/boot/local-video')(makeReq('/wallpapers/boot/local-video?path=' + encodeURIComponent(p)), res);
      await res.done;
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe(mime);
    }
  });
});

describe('GET /wallpapers/boot/probe', () => {
  it('存在返回元数据、非回环 403', async () => {
    const p = join(dir, 'probe.mp4');
    writeFileSync(p, '12345');
    const res = makeStreamRes();
    handler('/wallpapers/boot/probe')(makeReq('/wallpapers/boot/probe?path=' + encodeURIComponent(p)), res);
    await res.done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body.toString())).toMatchObject({ ok: true, exists: true, isFile: true, size: 5, playable: true });

    const res2 = makeStreamRes();
    handler('/wallpapers/boot/probe')(makeReq('/wallpapers/boot/probe?path=x', '8.8.8.8'), res2);
    await res2.done;
    expect(res2.statusCode).toBe(403);
  });
  it('NUL/相对路径 400、不存在/目录 404，错误体 ok:false', async () => {
    const nul = makeStreamRes();
    handler('/wallpapers/boot/probe')(makeReq('/wallpapers/boot/probe?path=' + encodeURIComponent(join(dir, 'nul\0.mp4'))), nul);
    await nul.done;
    expect(nul.statusCode).toBe(400);
    expect(JSON.parse(nul.body.toString())).toMatchObject({ ok: false, exists: false, size: 0, playable: false });

    const rel = makeStreamRes();
    handler('/wallpapers/boot/probe')(makeReq('/wallpapers/boot/probe?path=a.mp4'), rel);
    await rel.done;
    expect(rel.statusCode).toBe(400);

    const missing = makeStreamRes();
    handler('/wallpapers/boot/probe')(makeReq('/wallpapers/boot/probe?path=' + encodeURIComponent(join(dir, 'no.mp4'))), missing);
    await missing.done;
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body.toString())).toMatchObject({ ok: false, exists: false, isFile: false });

    mkdirSync(join(dir, 'folder.mp4'));
    const dirRes = makeStreamRes();
    handler('/wallpapers/boot/probe')(makeReq('/wallpapers/boot/probe?path=' + encodeURIComponent(join(dir, 'folder.mp4'))), dirRes);
    await dirRes.done;
    expect(dirRes.statusCode).toBe(404);
    expect(JSON.parse(dirRes.body.toString())).toMatchObject({ ok: false, exists: false, isFile: false });
  });
  it('尾随空格与 local-video 一样 trim 后校验', async () => {
    const p = join(dir, 'trim.mp4');
    writeFileSync(p, 'abc');
    const res = makeStreamRes();
    handler('/wallpapers/boot/probe')(makeReq('/wallpapers/boot/probe?path=' + encodeURIComponent(p + '  ')), res);
    await res.done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body.toString())).toMatchObject({ ok: true, exists: true, isFile: true, size: 3, playable: true });
  });
});
