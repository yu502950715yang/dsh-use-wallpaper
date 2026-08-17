import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scanWallpapers } from './scanner.js';
import { PkgReader } from './pkg-reader.js';
import type { WallpaperInfo } from '../shared/types.js';

export interface WallpaperRoutesOptions { wallpaperDir: string }

// I4：PkgReader 实例缓存 —— scene asset 每请求整包 readFileSync 成本高，
// 按 (path, mtime) 缓存，mtime 变化才重建；Map 超出上限时淘汰最旧一项。
const READER_CACHE = new Map<string, { mtimeMs: number; reader: PkgReader }>();
const READER_CACHE_MAX = 32;

export function getPkgReader(pkgPath: string): PkgReader {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(pkgPath).mtimeMs;
  } catch {
    // 文件不可读：mtime 归零，保证不会误命中旧缓存（下方构造会抛出并走 500 分支）
  }
  const hit = READER_CACHE.get(pkgPath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.reader;
  const reader = new PkgReader(pkgPath);
  READER_CACHE.set(pkgPath, { mtimeMs, reader });
  if (READER_CACHE.size > READER_CACHE_MAX) {
    const oldest = READER_CACHE.keys().next().value;
    if (oldest !== undefined) READER_CACHE.delete(oldest);
  }
  return reader;
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.tex': 'application/octet-stream',
};

function isSafeToken(s: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(s) && !s.includes('..');
}

function json(res: any, code: number, value: unknown) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

// 真实 WebRoute 无 params/query 注入：从 req.url 解析 pathname 段与 query
// （WHATWG URL 的 dot-segment 规范化天然折叠 '..' 段，是第一层穿越防护）
function parseUrl(req: any): { segs: string[]; search: URLSearchParams } {
  const u = new URL(req.url ?? '/', 'http://localhost');
  return { segs: u.pathname.split('/').filter(Boolean), search: u.searchParams };
}

export function registerWallpaperRoutes(ctx: any, opts: WallpaperRoutesOptions): void {
  ctx.inject(['webServer'], (httpCtx: any) => {
    const server = httpCtx.webServer;
    const { wallpaperDir } = opts;

    server.register({
      kind: 'exact', path: '/wallpapers/list',
      handler: async (_req: any, res: any) => {
        // WebRoute 不区分 HTTP 方法（浏览器仅用 GET），此处不校验方法
        const list = await scanWallpapers(wallpaperDir);
        json(res, 200, list);
      },
    });

    server.register({
      kind: 'prefix', path: '/wallpapers/media',
      // 匹配 /wallpapers/media/<id>/preview 与 /wallpapers/media/<id>/file
      handler: (_req: any, res: any) => {
        const { segs } = parseUrl(_req);
        if (segs.length < 4) return json(res, 400, { error: 'bad path' });
        const id = segs[2];
        const action = segs[3];
        if (!isSafeToken(id)) return json(res, 400, { error: 'bad id' });
        if (action === 'preview') {
          const base = join(wallpaperDir, id);
          for (const ext of ['.gif', '.jpg', '.jpeg', '.png']) {
            const p = join(base, 'preview' + ext);
            if (existsSync(p)) {
              const body = readFileSync(p);
              res.writeHead(200, { 'Content-Type': MIME[ext], 'Content-Length': body.length });
              return res.end(body);
            }
          }
          json(res, 404, { error: 'no preview' });
        } else if (action === 'file') {
          // file 名来自 project.json（扫描结果），这里按 id 读取 project.json 获得
          try {
            const pj = JSON.parse(readFileSync(join(wallpaperDir, id, 'project.json'), 'utf8'));
            const file = String(pj.file ?? '');
            if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) {
              return json(res, 400, { error: 'bad file' });
            }
            const p = join(wallpaperDir, id, file);
            if (!existsSync(p)) return json(res, 404, { error: 'no file' });
            const body = readFileSync(p);
            const ext = '.' + file.split('.').pop()?.toLowerCase();
            res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': body.length });
            res.end(body);
          } catch {
            json(res, 404, { error: 'not found' });
          }
        } else {
          json(res, 404, { error: 'no such action' });
        }
      },
    });

    server.register({
      kind: 'prefix', path: '/wallpapers/scene',
      // 匹配 /wallpapers/scene/<id>/asset
      handler: (_req: any, res: any) => {
        const { segs, search } = parseUrl(_req);
        if (segs.length < 4) return json(res, 400, { error: 'bad path' });
        const id = segs[2];
        const action = segs[3];
        if (action !== 'asset') return json(res, 404, { error: 'no such action' });
        const name = search.get('name') ?? '';
        if (!isSafeToken(id)) return json(res, 400, { error: 'bad id' });
        if (!name || !/^[A-Za-z0-9._\/-]+$/.test(name) || name.includes('..')) {
          return json(res, 400, { error: 'bad name' });
        }
        const pkgPath = join(wallpaperDir, id, 'scene.pkg');
        if (!existsSync(pkgPath)) return json(res, 404, { error: 'no scene pkg' });
        try {
          const reader = getPkgReader(pkgPath);
          const entry = reader.readEntry(name);
          if (!entry) return json(res, 404, { error: 'no such asset' });
          const ext = '.' + name.split('.').pop()?.toLowerCase();
          // 场景资源是动态内容（pkg 内读取），禁止浏览器缓存，避免切壁纸后拿到陈旧数据
          res.writeHead(200, {
            'Content-Type': MIME[ext] ?? 'application/octet-stream',
            'Content-Length': entry.length,
            'Cache-Control': 'no-store',
          });
          res.end(entry);
        } catch {
          // 固定文案，不泄漏内部错误信息
          json(res, 500, { error: 'internal error' });
        }
      },
    });
  });
}
