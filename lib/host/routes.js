import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { scanWallpapers } from './scanner.js';
import { injectPointerShim } from '../shared/pointer-shim.js';
import { PkgReader } from './pkg-reader.js';
import { probeSteamPaths, readSteamInstallPathFromRegistry, readLibraryFoldersVdf, DEFAULT_STEAM_ROOTS } from './steam-paths.js';
import { framesDirOf } from './data-dir.js';
import { createSceneFrameStore, DEFAULT_MAX_FRAME_BYTES } from './scene-frame-store.js';
import { extractEmbeddedMp4, probeEmbeddedMp4 } from './scene-media-probe.js';
import { collectVisibleBoolProperties } from './user-props.js';
// 场景素材流式阈值：≥8MB 或音视频改用 createReadStream，避免 132MB 音频整块驻留
export const STREAM_ASSET_BYTES = 8 * 1024 * 1024;
// I4：PkgReader 实例缓存 —— scene asset 每请求整包 readFileSync 成本高，
// 按 (path, mtime) 缓存，mtime 变化才重建；Map 超出上限时淘汰最旧一项。
const READER_CACHE = new Map();
const READER_CACHE_MAX = 32;
export function getPkgReader(pkgPath) {
    let mtimeMs = 0;
    try {
        mtimeMs = statSync(pkgPath).mtimeMs;
    }
    catch {
        // 文件不可读：mtime 归零，保证不会误命中旧缓存（下方构造会抛出并走 500 分支）
    }
    const hit = READER_CACHE.get(pkgPath);
    if (hit && hit.mtimeMs === mtimeMs)
        return hit.reader;
    const reader = new PkgReader(pkgPath);
    READER_CACHE.set(pkgPath, { mtimeMs, reader });
    if (READER_CACHE.size > READER_CACHE_MAX) {
        const oldest = READER_CACHE.keys().next().value;
        if (oldest !== undefined)
            READER_CACHE.delete(oldest);
    }
    return reader;
}
const MIME = {
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
function isSafeToken(s) {
    return /^[A-Za-z0-9._-]+$/.test(s) && !s.includes('..');
}
// ── 引擎 assets 目录（VFS 的 `/`）─────────────────────────────────────────────────────
// WE 把**引擎 assets 目录也挂载在 VFS 的 `/`** 上（lwe WallpaperApplication.cpp:85-99 的挂载顺序：
// 壁纸目录 → scene.pkg → 引擎 assets → cwd），所以 scene.json 里的路径（`fonts/X.ttf`、
// `materials/...`）是 **VFS 相对路径**，文件可能只在 `<WE 安装目录>/assets/` 里。
// 全库实测：33 个带 font 的 text 对象里 21 个是文件路径，其中 **11 个只在引擎目录**（5 张壁纸）——
// 用户报告「魔兽之门」1922570576 的 3D Clock 就是其一（该 scene.pkg 48 个条目里零字体文件）。
// 只放行**相对路径**（绝对路径、'..'、Windows 分隔符一律拒绝）。
export function isSafeAssetName(name) {
    return !!name && !name.includes('..') && !name.includes('\\') && !name.startsWith('/');
}
/** 解析「引擎目录 + VFS 相对路径」，并证明结果没有跳出 `<weAssetsDir>/assets`（resolve + 前缀比较，
 *  与本文件其它路由同一手法）。越界 / 不存在 / 不是文件 → null（调用方按未命中继续）。 */
export function resolveEngineAsset(weAssetsDir, name) {
    if (!isSafeAssetName(name))
        return null;
    const base = resolve(weAssetsDir, 'assets');
    const full = resolve(base, name);
    if (full !== base && !full.startsWith(base + sep))
        return null;
    if (!existsSync(full) || !statSync(full).isFile())
        return null;
    return full;
}
function json(res, code, value) {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
    res.end(body);
}
// .tex 原始字节响应（pkg 与引擎目录两个来源共用）；动态内容禁缓存，避免切壁纸后读到陈旧纹理
function sendTexture(res, body) {
    res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
    });
    res.end(body);
}
function mimeOfAsset(name) {
    const ext = '.' + (name.split('.').pop() ?? '').toLowerCase();
    return MIME[ext] ?? 'application/octet-stream';
}
// 单区间 Range（含首含尾）：无 Range → null；非法/多区间/越界 → 'invalid'（调用方回 416）
function parseRangeHeader(value, size) {
    if (value === undefined)
        return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
    if (!m || (m[1] === '' && m[2] === ''))
        return 'invalid';
    if (size <= 0)
        return 'invalid';
    if (m[1] === '') {
        const suffix = Number(m[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0)
            return 'invalid';
        return { start: Math.max(size - suffix, 0), end: size - 1 };
    }
    const start = Number(m[1]);
    if (!Number.isSafeInteger(start) || start >= size)
        return 'invalid';
    if (m[2] === '')
        return { start, end: size - 1 };
    const end = Number(m[2]);
    if (!Number.isSafeInteger(end) || end < start)
        return 'invalid';
    return { start, end: Math.min(end, size - 1) };
}
// 场景素材统一出口：支持 Range/HEAD；大素材或音视频流式，小素材保持整块 Buffer
function sendSceneAsset(req, res, name, source, streamThreshold) {
    const mime = mimeOfAsset(name);
    const size = source.size;
    const range = parseRangeHeader(req.headers?.range, size);
    if (range === 'invalid') {
        res.writeHead(416, {
            'Content-Type': mime,
            'Content-Range': `bytes */${size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': 0,
            'Cache-Control': 'no-store',
        });
        res.end();
        return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const headers = {
        'Content-Type': mime,
        'Content-Length': size === 0 ? 0 : end - start + 1,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
    };
    if (range)
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    const isHead = String(req.method ?? 'GET').toUpperCase() === 'HEAD';
    const stream = size >= streamThreshold || mime.startsWith('audio/') || mime.startsWith('video/');
    // 小素材先读再回：读取失败仍能按未命中 404（旧行为），不把头部提前写出
    let body = null;
    if (!isHead && !stream && size > 0) {
        try {
            body = range ? source.readAll().subarray(start, end + 1) : source.readAll();
        }
        catch {
            json(res, 404, { error: 'no such asset' });
            return;
        }
    }
    res.writeHead(range ? 206 : 200, headers);
    if (isHead || size === 0) {
        res.end();
        return;
    }
    if (body) {
        res.end(body);
        return;
    }
    const file = source.openRange(start, end);
    file.on('error', () => res.destroy?.());
    file.pipe(res);
}
// 真实 WebRoute 无 params/query 注入：从 req.url 解析 pathname 段与 query
// （WHATWG URL 的 dot-segment 规范化天然折叠 '..' 段，是第一层穿越防护）
function parseUrl(req) {
    const u = new URL(req.url ?? '/', 'http://localhost');
    return { segs: u.pathname.split('/').filter(Boolean), search: u.searchParams };
}
// 读取 POST body：超限立即停止累积、丢弃剩余流并返回 too-large（调用方回 413）。
function readBody(req, maxBytes) {
    return new Promise((resolve) => {
        const chunks = [];
        let total = 0;
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            resolve(result);
        };
        req.on('data', (chunk) => {
            if (settled)
                return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buf.length;
            if (total > maxBytes) {
                chunks.length = 0;
                finish({ ok: false, reason: 'too-large' });
                req.resume?.();
                return;
            }
            chunks.push(buf);
        });
        req.on('end', () => finish({ ok: true, body: Buffer.concat(chunks) }));
        req.on('error', () => finish({ ok: false, reason: 'error' }));
        // 客户端中途断开时也必须 settle，否则 handler 的 await 永久悬挂
        req.on('close', () => finish({ ok: false, reason: 'error' }));
    });
}
export function registerWallpaperRoutes(ctx, opts) {
    ctx.inject(['webServer'], (httpCtx) => {
        const server = httpCtx.webServer;
        // 每次请求解析实时目录：state（热更新）优先，兼容旧静态 wallpaperDir 参数
        const dir = () => opts.state?.wallpaperDir ?? opts.wallpaperDir ?? '';
        const assetsDir = () => opts.state?.weAssetsDir ?? opts.weAssetsDir;
        // 抓帧目录 = <dataDir>/frames（Task 1）；未配 dataDir 时写接口 500、读接口按无帧 404
        const frameStore = opts.dataDir ? createSceneFrameStore(framesDirOf(opts.dataDir)) : null;
        server.register({
            kind: 'exact', path: '/wallpapers/list',
            handler: async (_req, res) => {
                // WebRoute 不区分 HTTP 方法（浏览器仅用 GET），此处不校验方法
                const list = await scanWallpapers(dir());
                json(res, 200, list);
            },
        });
        server.register({
            kind: 'prefix', path: '/wallpapers/media',
            // 匹配 /wallpapers/media/<id>/preview 与 /wallpapers/media/<id>/file
            handler: (_req, res) => {
                const { segs } = parseUrl(_req);
                if (segs.length < 4)
                    return json(res, 400, { error: 'bad path' });
                const id = segs[2];
                const action = segs[3];
                if (!isSafeToken(id))
                    return json(res, 400, { error: 'bad id' });
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
                }
                else if (action === 'file') {
                    // file 名来自 project.json（扫描结果），这里按 id 读取 project.json 获得
                    try {
                        const pj = JSON.parse(readFileSync(join(dir(), id, 'project.json'), 'utf8'));
                        const file = String(pj.file ?? '');
                        if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) {
                            return json(res, 400, { error: 'bad file' });
                        }
                        const p = join(dir(), id, file);
                        if (!existsSync(p))
                            return json(res, 404, { error: 'no file' });
                        const body = readFileSync(p);
                        const ext = '.' + file.split('.').pop()?.toLowerCase();
                        res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': body.length });
                        res.end(body);
                    }
                    catch {
                        json(res, 404, { error: 'not found' });
                    }
                }
                else {
                    json(res, 404, { error: 'no such action' });
                }
            },
        });
        server.register({
            kind: 'prefix', path: '/wallpapers/scene',
            // 匹配 /wallpapers/scene/<id>/{asset|video-probe|embedded-video}；asset 支持 Range/HEAD/流式
            handler: (_req, res) => {
                const { segs, search } = parseUrl(_req);
                if (segs.length < 4)
                    return json(res, 400, { error: 'bad path' });
                const id = segs[2];
                const action = segs[3];
                if (action === 'video-probe' || action === 'embedded-video') {
                    if (!isSafeToken(id))
                        return json(res, 400, { error: 'bad id' });
                    const pkgPath = join(dir(), id, 'scene.pkg');
                    if (action === 'video-probe') {
                        // 探测失败按无视频处理（降级链继续走抓帧/预览，不向调用方抛错）
                        const video = existsSync(pkgPath) && probeEmbeddedMp4(pkgPath);
                        res.setHeader?.('Cache-Control', 'no-store');
                        return json(res, 200, { video });
                    }
                    const hit = existsSync(pkgPath) ? extractEmbeddedMp4(pkgPath) : null;
                    if (!hit)
                        return json(res, 404, { error: 'no embedded video' });
                    // 不做 Range：本场景是整包循环播放（v0.8 约定），一律 200 全量
                    res.writeHead(200, {
                        'Content-Type': 'video/mp4',
                        'Content-Length': hit.bytes.length,
                        'Cache-Control': 'no-store',
                    });
                    return res.end(hit.bytes);
                }
                if (action !== 'asset')
                    return json(res, 404, { error: 'no such action' });
                const name = search.get('name') ?? '';
                if (!isSafeToken(id))
                    return json(res, 400, { error: 'bad id' });
                // 资源名是 pkg 容器内条目名，可含 Unicode 文件名（俄文/中文等）、标点（《》等）与空格；
                // 白名单放行字母/数字/标点/空格/._-/斜杠，仍拒绝 '..' 穿越（readEntry 内 isSafeName 二次校验）。
                if (!name || !/^[\p{L}\p{N}\p{P} ._\/-]+$/u.test(name) || name.includes('..')) {
                    return json(res, 400, { error: 'bad name' });
                }
                const pkgPath = join(dir(), id, 'scene.pkg');
                // ① pkg 条目（WE 挂载顺序里壁纸包先于引擎 assets）：只取区间元数据，流式不读整块
                let source = null;
                if (existsSync(pkgPath)) {
                    try {
                        const reader = getPkgReader(pkgPath);
                        const range = reader.entryAbsRange(name);
                        if (range) {
                            source = {
                                size: range.end - range.start,
                                readAll: () => reader.readEntry(name),
                                openRange: (start, end) => createReadStream(reader.pkgPath, {
                                    start: range.start + start,
                                    end: range.start + end,
                                }),
                            };
                        }
                    }
                    catch {
                        return json(res, 500, { error: 'internal error' });
                    }
                }
                // ② 引擎 assets 目录回退（字体等 WE 内置素材；`weAssetsDir` 未配 → 直接 404）
                if (!source) {
                    const we = assetsDir();
                    const fromEngine = we ? resolveEngineAsset(we, name) : null;
                    if (fromEngine) {
                        try {
                            const size = statSync(fromEngine).size;
                            source = {
                                size,
                                readAll: () => readFileSync(fromEngine),
                                openRange: (start, end) => createReadStream(fromEngine, { start, end }),
                            };
                        }
                        catch {
                            // 读失败按未命中处理（下面的 404），不泄漏内部错误
                        }
                    }
                }
                if (!source)
                    return json(res, 404, { error: 'no such asset' });
                return sendSceneAsset(_req, res, name, source, opts.streamAssetBytes ?? STREAM_ASSET_BYTES);
            },
        });
        server.register({
            kind: 'prefix', path: '/wallpapers/frame',
            // 匹配 /wallpapers/frame/<id>：GET/HEAD 取帧、POST 存帧（仅 image/png）、DELETE 删帧
            handler: async (_req, res) => {
                const { segs } = parseUrl(_req);
                if (segs.length !== 3)
                    return json(res, 400, { error: 'bad path' });
                const id = segs[2];
                if (!isSafeToken(id))
                    return json(res, 400, { error: 'bad id' });
                const method = String(_req.method ?? 'GET').toUpperCase();
                if (method === 'POST') {
                    if (!frameStore)
                        return json(res, 500, { error: 'no data dir' });
                    const type = String(_req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
                    if (type !== 'image/png')
                        return json(res, 415, { error: 'unsupported media type' });
                    const declared = Number(_req.headers?.['content-length']);
                    if (Number.isFinite(declared) && declared > DEFAULT_MAX_FRAME_BYTES) {
                        _req.resume?.(); // 丢弃 body，避免连接残留
                        return json(res, 413, { error: 'too large' });
                    }
                    const body = await readBody(_req, DEFAULT_MAX_FRAME_BYTES);
                    if (!body.ok) {
                        return body.reason === 'too-large'
                            ? json(res, 413, { error: 'too large' })
                            : json(res, 400, { error: 'bad body' });
                    }
                    const result = frameStore.write(id, body.body);
                    if (!result.ok) {
                        if (result.reason === 'too-large')
                            return json(res, 413, { error: 'too large' });
                        if (result.reason === 'bad-png')
                            return json(res, 400, { error: 'bad png' });
                        return json(res, 500, { error: 'write failed' });
                    }
                    return json(res, 201, { ok: true });
                }
                if (method === 'DELETE') {
                    frameStore?.remove(id);
                    return json(res, 200, { ok: true });
                }
                if (method !== 'GET' && method !== 'HEAD')
                    return json(res, 405, { error: 'method not allowed' });
                const png = frameStore?.read(id) ?? null;
                if (!png)
                    return json(res, 404, { error: 'no frame' });
                res.writeHead(200, {
                    'Content-Type': 'image/png',
                    'Content-Length': png.length,
                    'Cache-Control': 'no-store',
                });
                return res.end(png);
            },
        });
        server.register({
            kind: 'prefix', path: '/wallpapers/static',
            // 匹配 /wallpapers/static/<file>：服务插件构建产物（wasm 引擎 glue + .wasm 等，
            // scripts/build-client.mjs 输出到 dist/static/）。
            handler: (_req, res) => {
                const { segs } = parseUrl(_req);
                // 静态资源必须是单段文件名（无子目录）
                if (segs.length !== 3)
                    return json(res, 400, { error: 'bad path' });
                const file = segs[2];
                if (!isSafeToken(file))
                    return json(res, 400, { error: 'bad file' });
                if (!opts.staticDir)
                    return json(res, 500, { error: 'no static dir' });
                // 越界二次校验：staticDir 来自 fileURLToPath（Windows 上可能带尾分隔符且与
                // path.join 的分隔符风格不一致），故先 resolve 规范化（去尾分隔符、统一分隔符）
                // 再比较前缀，避免误判合法文件越界（Task 9 实测：/wallpapers/static/* 全部 400）。
                // isSafeToken 已禁 '..'，resolve 无穿越风险。
                const base = resolve(opts.staticDir);
                const p = resolve(base, file);
                if (p !== base && !p.startsWith(base + sep)) {
                    return json(res, 400, { error: 'bad path' });
                }
                if (!existsSync(p) || !statSync(p).isFile())
                    return json(res, 404, { error: 'no such file' });
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
                }
                catch {
                    json(res, 500, { error: 'internal error' });
                }
            },
        });
        server.register({
            kind: 'prefix', path: '/wallpapers/web',
            // 匹配 /wallpapers/web/<id>/<path...>：web 壁纸静态文件服务（index.html 及其 css/js/img 等）
            handler: (_req, res) => {
                const { segs } = parseUrl(_req);
                if (segs.length < 3)
                    return json(res, 400, { error: 'bad path' });
                const id = segs[2];
                if (!isSafeToken(id))
                    return json(res, 400, { error: 'bad id' });
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
                if (!existsSync(p) || !statSync(p).isFile())
                    return json(res, 404, { error: 'no such file' });
                try {
                    const body = readFileSync(p);
                    const ext = '.' + rel.split('.').pop()?.toLowerCase();
                    // HTML 注入指针 shim（AGENT.md §5.48）：背景层 pointer-events:none ⇒ 壁纸 iframe 收不到
                    // mousemove，视差类 web 壁纸恒为静态。注入失败（无锚点/非 UTF-8 安全）则原样返回，绝不改坏。
                    let out = body;
                    if (ext === '.html' || ext === '.htm') {
                        const patched = injectPointerShim(body.toString('utf8'));
                        if (patched !== null)
                            out = Buffer.from(patched, 'utf8');
                    }
                    res.writeHead(200, {
                        'Content-Type': MIME[ext] ?? 'application/octet-stream',
                        'Content-Length': out.length,
                        'Cache-Control': 'no-store',
                    });
                    res.end(out);
                }
                catch {
                    json(res, 500, { error: 'internal error' });
                }
            },
        });
        server.register({
            kind: 'exact', path: '/wallpapers/particle-texture',
            // 2026-08-21（wasm 粒子纹理，方案 A）：粒子材质 textures 如 "particle/fog/fog1" 是
            // 引擎内置资源 → WE 引擎从 assets/materials/particle/fog/fog1.tex 读取。本路由从 WE 安装
            // 目录（weAssetsDir）提供该纹理原始字节（TEXV0005，client 侧现有解码管线消费）。
            // 2026-09-29 起带可选 `id`：壁纸自带素材会被打包进它自己的 scene.pkg（`materials/<name>.tex`），
            // 此时引擎目录没有该文件 —— 只查引擎目录会 404，粒子退化成白图软圆点（3793620838 的小鸟）。
            // 查找顺序 = pkg 先、引擎目录后，对齐 WE 的挂载顺序（lwe `Container::m_mountpoints` 顺序遍历，
            // 壁纸目录/scene.pkg 挂在引擎 assets 之前）。
            handler: (_req, res) => {
                const { search } = parseUrl(_req);
                const name = search.get('name') ?? '';
                // name = 材质 textures 路径（含 '/' 子目录），白名单放行字母/数字/标点/空格/._-/斜杠
                if (!name || !/^[\p{L}\p{N}\p{P} ._\/-]+$/u.test(name) || name.includes('..')) {
                    return json(res, 400, { error: 'bad name' });
                }
                // ① 壁纸 scene.pkg。缺 id / pkg 无该条目 → 落回引擎目录（不因 pkg 未命中而报错）。
                const id = search.get('id') ?? '';
                if (id && isSafeToken(id)) {
                    const pkgPath = join(dir(), id, 'scene.pkg');
                    if (existsSync(pkgPath)) {
                        try {
                            const entry = getPkgReader(pkgPath).readEntry(`materials/${name}.tex`);
                            if (entry)
                                return sendTexture(res, entry);
                        }
                        catch {
                            // pkg 存在但不可读：按未命中处理，交给引擎目录
                        }
                    }
                }
                // ② WE 安装目录
                if (!assetsDir())
                    return json(res, 500, { error: 'no we assets dir' });
                const base = resolve(assetsDir(), 'assets', 'materials');
                const p = resolve(base, name + '.tex');
                if (p !== base && !p.startsWith(base + sep))
                    return json(res, 400, { error: 'bad path' });
                if (!existsSync(p) || !statSync(p).isFile())
                    return json(res, 404, { error: 'no such texture' });
                try {
                    sendTexture(res, readFileSync(p));
                }
                catch {
                    json(res, 500, { error: 'internal error' });
                }
            },
        });
        server.register({
            kind: 'exact', path: '/wallpapers/probe',
            // 2026-08-21（路径可配置化）：自动探测 Steam 安装路径（注册表）+ 全部库
            // （libraryfolders.vdf）+ 常见根，生成壁纸目录与引擎目录候选（带存在性标记）。
            // 设置面板展示候选，用户点选后写入 settings.wallpaperDir/weAssetsDir（热更新）。
            handler: (_req, res) => {
                const result = probeSteamPaths({
                    steamPath: readSteamInstallPathFromRegistry(),
                    readVdf: (install) => readLibraryFoldersVdf(install),
                    extraRoots: [...DEFAULT_STEAM_ROOTS],
                });
                json(res, 200, result);
            },
        });
        server.register({
            kind: 'exact', path: '/wallpapers/properties',
            // v0.8 用户属性面板：project.json bool 属性 ∩ scene.json objects[].visible.user。
            // 每次请求重读、任何文件缺失/坏 JSON 都按「无属性」返回 200（不把素材问题升级成 500）。
            handler: (_req, res) => {
                const { search } = parseUrl(_req);
                const id = search.get('id') ?? '';
                if (!isSafeToken(id))
                    return json(res, 400, { error: 'bad id' });
                let projectJson = null;
                let sceneJson = null;
                try {
                    projectJson = JSON.parse(readFileSync(join(dir(), id, 'project.json'), 'utf8'));
                }
                catch {
                    // project.json 缺失/不可读/坏 JSON → 属性为空
                }
                const pkgPath = join(dir(), id, 'scene.pkg');
                if (existsSync(pkgPath)) {
                    try {
                        const entry = getPkgReader(pkgPath).readEntry('scene.json');
                        if (entry)
                            sceneJson = JSON.parse(entry.toString('utf8'));
                    }
                    catch {
                        // pkg 不可读 / 无 scene.json / 坏 JSON → 属性为空
                    }
                }
                res.setHeader?.('Cache-Control', 'no-store');
                json(res, 200, { properties: collectVisibleBoolProperties(projectJson, sceneJson) });
            },
        });
    });
}
