import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { scanWallpapers } from './scanner.js';
import { PkgReader } from './pkg-reader.js';
import { probeSteamPaths, readSteamInstallPathFromRegistry, DEFAULT_STEAM_ROOTS } from './steam-paths.js';
import type { WallpaperInfo } from '../shared/types.js';

export interface WallpaperRoutesOptions {
  /** 兼容旧调用：静态 wallpaperDir（无 state 时使用） */
  wallpaperDir?: string;
  staticDir?: string;
  /** 兼容旧调用：静态 weAssetsDir（无 state 时使用） */
  weAssetsDir?: string;
  /** 可变运行状态：每次请求读取实时值（host/index.ts 维护，settings 热更新） */
  state?: { wallpaperDir: string; weAssetsDir: string };
}

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
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', // T3.4：壁纸 sound 条目（如 2937346640 的 30MB flac）走场景资源路由取原始字节
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
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
    // 每次请求解析实时目录：state（热更新）优先，兼容旧静态 wallpaperDir 参数
    const dir = () => opts.state?.wallpaperDir ?? opts.wallpaperDir ?? '';
    const assetsDir = () => opts.state?.weAssetsDir ?? opts.weAssetsDir;

    server.register({
      kind: 'exact', path: '/wallpapers/list',
      handler: async (_req: any, res: any) => {
        // WebRoute 不区分 HTTP 方法（浏览器仅用 GET），此处不校验方法
        const list = await scanWallpapers(dir());
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
          const base = join(dir(), id);
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
            const pj = JSON.parse(readFileSync(join(dir(), id, 'project.json'), 'utf8'));
            const file = String(pj.file ?? '');
            if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) {
              return json(res, 400, { error: 'bad file' });
            }
            const p = join(dir(), id, file);
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
        // 资源名是 pkg 容器内条目名，可含 Unicode 文件名（俄文/中文等）、标点（《》等）与空格；
        // 白名单放行字母/数字/标点/空格/._-/斜杠，仍拒绝 '..' 穿越（readEntry 内 isSafeName 二次校验）。
        if (!name || !/^[\p{L}\p{N}\p{P} ._\/-]+$/u.test(name) || name.includes('..')) {
          return json(res, 400, { error: 'bad name' });
        }
        const pkgPath = join(dir(), id, 'scene.pkg');
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

    server.register({
      kind: 'prefix', path: '/wallpapers/static',
      // 匹配 /wallpapers/static/<file>：服务插件构建产物（wasm 引擎 glue + .wasm 等，
      // scripts/build-client.mjs 输出到 dist/static/）。
      handler: (_req: any, res: any) => {
        const { segs } = parseUrl(_req);
        // 静态资源必须是单段文件名（无子目录）
        if (segs.length !== 3) return json(res, 400, { error: 'bad path' });
        const file = segs[2];
        if (!isSafeToken(file)) return json(res, 400, { error: 'bad file' });
        if (!opts.staticDir) return json(res, 500, { error: 'no static dir' });
        // 越界二次校验：staticDir 来自 fileURLToPath（Windows 上可能带尾分隔符且与
        // path.join 的分隔符风格不一致），故先 resolve 规范化（去尾分隔符、统一分隔符）
        // 再比较前缀，避免误判合法文件越界（Task 9 实测：/wallpapers/static/* 全部 400）。
        // isSafeToken 已禁 '..'，resolve 无穿越风险。
        const base = resolve(opts.staticDir);
        const p = resolve(base, file);
        if (p !== base && !p.startsWith(base + sep)) {
          return json(res, 400, { error: 'bad path' });
        }
        if (!existsSync(p) || !statSync(p).isFile()) return json(res, 404, { error: 'no such file' });
        try {
          const body = readFileSync(p);
          const ext = '.' + file.split('.').pop()?.toLowerCase();
          // 静态产物随构建覆盖同名文件，no-store 与场景资源一致，避免浏览器缓存陈旧版本
          res.writeHead(200, {
            'Content-Type': MIME[ext] ?? 'application/octet-stream',
            'Content-Length': body.length,
            'Cache-Control': 'no-store',
          });
          res.end(body);
        } catch {
          json(res, 500, { error: 'internal error' });
        }
      },
    });

    server.register({
      kind: 'prefix', path: '/wallpapers/web',
      // 匹配 /wallpapers/web/<id>/<path...>：web 壁纸静态文件服务（index.html 及其 css/js/img 等）
      handler: (_req: any, res: any) => {
        const { segs } = parseUrl(_req);
        if (segs.length < 3) return json(res, 400, { error: 'bad path' });
        const id = segs[2];
        if (!isSafeToken(id)) return json(res, 400, { error: 'bad id' });
        // 剩余路径段逐段校验：禁止 '..' 穿越与绝对路径
        const rest = segs.slice(3);
        if (rest.some((s) => !s || s === '..' || s.includes('..') || s.includes('\\') || s.includes(':'))) {
          return json(res, 400, { error: 'bad path' });
        }
        const base = join(dir(), id);
        const rel = rest.length === 0 ? 'index.html' : rest.join('/');
        const p = join(base, rel);
        // 二次校验：解析结果必须位于壁纸目录内（防软链/unicode 变体等绕过）
        if (p !== base && !p.startsWith(base + '\\') && !p.startsWith(base + '/')) {
          return json(res, 400, { error: 'bad path' });
        }
        if (!existsSync(p) || !statSync(p).isFile()) return json(res, 404, { error: 'no such file' });
        try {
          const body = readFileSync(p);
          const ext = '.' + rel.split('.').pop()?.toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME[ext] ?? 'application/octet-stream',
            'Content-Length': body.length,
            'Cache-Control': 'no-store',
          });
          res.end(body);
        } catch {
          json(res, 500, { error: 'internal error' });
        }
      },
    });

    server.register({
      kind: 'exact', path: '/wallpapers/particle-texture',
      // 2026-08-21（wasm 粒子纹理，方案 A）：WE 内置粒子纹理——粒子材质 textures
      // 如 "particle/fog/fog1" 是引擎内置资源（不在壁纸 pkg），WE 引擎从
      // assets/materials/particle/fog/fog1.tex 读取。本路由从 WE 安装目录
      // （weAssetsDir，可配置）提供该纹理原始字节（TEXV0005，client 侧现有解码管线消费）。
      handler: (_req: any, res: any) => {
        const { search } = parseUrl(_req);
        if (!assetsDir()) return json(res, 500, { error: 'no we assets dir' });
        const name = search.get('name') ?? '';
        // name = 材质 textures 路径（含 '/' 子目录），白名单放行字母/数字/标点/空格/._-/斜杠
        if (!name || !/^[\p{L}\p{N}\p{P} ._\/-]+$/u.test(name) || name.includes('..')) {
          return json(res, 400, { error: 'bad name' });
        }
        const base = resolve(assetsDir()!, 'assets', 'materials');
        const p = resolve(base, name + '.tex');
        if (p !== base && !p.startsWith(base + sep)) return json(res, 400, { error: 'bad path' });
        if (!existsSync(p) || !statSync(p).isFile()) return json(res, 404, { error: 'no such texture' });
        try {
          const body = readFileSync(p);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': body.length,
            'Cache-Control': 'no-store',
          });
          res.end(body);
        } catch {
          json(res, 500, { error: 'internal error' });
        }
      },
    });

    server.register({
      kind: 'exact', path: '/wallpapers/probe',
      // 2026-08-21（路径可配置化）：自动探测 Steam 安装路径（注册表）+ 全部库
      // （libraryfolders.vdf）+ 常见根，生成壁纸目录与引擎目录候选（带存在性标记）。
      // 设置面板展示候选，用户点选后写入 settings.wallpaperDir/weAssetsDir（热更新）。
      handler: (_req: any, res: any) => {
        const result = probeSteamPaths({
          steamPath: readSteamInstallPathFromRegistry(),
          readVdf: (install) => {
            try {
              return readFileSync(join(install, 'libraryfolders.vdf'), 'utf8');
            } catch {
              return undefined;
            }
          },
          extraRoots: [...DEFAULT_STEAM_ROOTS],
        });
        json(res, 200, result);
      },
    });
  });
}
