import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanWallpapers } from './scanner.js';
import { PkgReader } from './pkg-reader.js';
import type { WallpaperInfo } from '../shared/types.js';

export interface WallpaperRoutesOptions { wallpaperDir: string }

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

export function registerWallpaperRoutes(ctx: any, opts: WallpaperRoutesOptions): void {
  ctx.inject(['webServer'], (httpCtx: any) => {
    const server = httpCtx.webServer;

    server.register({
      kind: 'GET', path: '/wallpapers/list',
      handler: async (_req: any, res: any) => {
        const list = await scanWallpapers(opts.wallpaperDir);
        json(res, 200, list);
      },
    });

    server.register({
      kind: 'GET', path: '/wallpapers/media/:id/preview',
      handler: (_req: any, res: any) => {
        const id = _req.params?.id;
        if (!isSafeToken(id)) return json(res, 400, { error: 'bad id' });
        const base = join(opts.wallpaperDir, id);
        for (const ext of ['.gif', '.jpg', '.jpeg', '.png']) {
          const p = join(base, 'preview' + ext);
          if (existsSync(p)) {
            const body = readFileSync(p);
            res.writeHead(200, { 'Content-Type': MIME[ext], 'Content-Length': body.length });
            return res.end(body);
          }
        }
        json(res, 404, { error: 'no preview' });
      },
    });

    server.register({
      kind: 'GET', path: '/wallpapers/media/:id/file',
      handler: (_req: any, res: any) => {
        const id = _req.params?.id;
        if (!isSafeToken(id)) return json(res, 400, { error: 'bad id' });
        // file 名来自 project.json（扫描结果），这里按 id 读取 project.json 获得
        try {
          const pj = JSON.parse(readFileSync(join(opts.wallpaperDir, id, 'project.json'), 'utf8'));
          const file = String(pj.file ?? '');
          if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) {
            return json(res, 400, { error: 'bad file' });
          }
          const p = join(opts.wallpaperDir, id, file);
          if (!existsSync(p)) return json(res, 404, { error: 'no file' });
          const body = readFileSync(p);
          const ext = '.' + file.split('.').pop()?.toLowerCase();
          res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': body.length });
          res.end(body);
        } catch {
          json(res, 404, { error: 'not found' });
        }
      },
    });

    server.register({
      kind: 'GET', path: '/wallpapers/scene/:id/asset',
      handler: (_req: any, res: any) => {
        const id = _req.params?.id;
        const name: string = _req.query?.name ?? '';
        if (!isSafeToken(id)) return json(res, 400, { error: 'bad id' });
        if (!name || !/^[A-Za-z0-9._\/-]+$/.test(name) || name.includes('..')) {
          return json(res, 400, { error: 'bad name' });
        }
        const pkgPath = join(opts.wallpaperDir, id, 'scene.pkg');
        if (!existsSync(pkgPath)) return json(res, 404, { error: 'no scene pkg' });
        try {
          const reader = new PkgReader(pkgPath);
          const entry = reader.readEntry(name);
          if (!entry) return json(res, 404, { error: 'no such asset' });
          const ext = '.' + name.split('.').pop()?.toLowerCase();
          res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': entry.length });
          res.end(entry);
        } catch (e: any) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    });
  });
}
