// 媒体集成端到端验证（白框修复的**可见验收点**）：
// 用生产 `lib/` 渲染真实 scene 壁纸，自起 http server **mock** host 的 now-playing 两条路由
// （不 spawn PowerShell，只用假标题），用 headless Edge + CDP 按阶段切媒体状态并断言像素/对象事实。
//
// 判据（全部动态定位，不依赖固定像素坐标）：
//   [1] stopped（无会话）：白色占位层（对象 40）的**动态 bbox** 内三通道 ≥250 的像素数 = 0，
//       且 displayObject(35/40/45).visible === false —— 装配期初始派发把媒体层在首帧前隐藏。
//   [2] 封面（本任务不实现，Task 8）：`const checkCover = false`；打开时断言封面区域洋红像素 > 200。
//   [3] playing（mock 快照带 title/artist）：对象 38/39 的文本画布 mapSize[0] > 4（歌名/歌手已画进
//       非空画布）且对象可见。
//   [4] 回到 stopped：媒体层（35/40/45）再次隐藏。
// 退出码：0 = 全部判据通过；1 = 任一判据失败或异常（CI 门禁）。
// ⚠️ 依赖本机 workshop 素材（默认 3797976859，可用 --id 换）；缺素材直接报错退出。
// 用法：node e2e/verify/verify-media-layer.mjs [--id=<workshopId>] [--workshop=<dir>] [--assets=<dir>]
//        [--port=9834] [--cdp-port=9247] [--gpu]
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { OUT_DIR, WE_WORKSHOP, WE_ASSETS, httpPort, cdpPort, resolveEdgePath, TIMEOUT_MS, argOf, flagOf, requireFile } from '../config.mjs';
import { decodePng } from '../lib/png-stats.mjs';
import { encodePng } from '../lib/png-encode.mjs';

const WALLPAPER_ID = '3797976859'; // 带媒体层（歌名/歌手/封面框）的场景壁纸
const WHITE_BOX_OBJECT = 40;       // 白色占位层（Album Cover Frame）
const MEDIA_LAYER_IDS = [35, 40, 45];
const FALLBACK_WHITE_BOX = [1160, 280, 1260, 370]; // 对象 40 未登记时的保守回退区域
const COVER_REGION = [1160, 285, 1245, 360];       // [2] 封面区域（checkCover 关闭时不用）
// 封面判据留给 Task 8（封面纹理/主色）；本任务只验白框与文本层。
const checkCover = false;

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(OUT_DIR, 'media-layer');
mkdirSync(OUT, { recursive: true });
const PORT = httpPort(9834);
const CDP_PORT = cdpPort(9247);
const USE_GPU = flagOf('gpu');
const ID = argOf('id', WALLPAPER_ID);
const WS = argOf('workshop', WE_WORKSHOP);
const WE = argOf('assets', WE_ASSETS);
const PKG = requireFile(
  join(WS, ID, 'scene.pkg'),
  `本机缺少壁纸 ${ID}（用 --workshop=<dir> 指定 Steam workshop/content/431960 目录）`,
);

// quickjs 沙箱 wasm：优先 dist/static/quickjs.wasm（build:client 的产物，页面加载的就是它），
// 缺省回退 node_modules（pnpm 下真实路径在 .pnpm/<pkg>@<ver>/node_modules/...）。
function resolveQuickjsWasm() {
  const candidates = [
    join(here, '..', '..', 'dist', 'static', 'quickjs.wasm'),
    join(here, '..', '..', 'node_modules', '@jitl', 'quickjs-wasmfile-release-sync', 'dist', 'emscripten-module.wasm'),
  ];
  const pnpmDir = join(here, '..', '..', 'node_modules', '.pnpm');
  if (existsSync(pnpmDir)) {
    for (const d of readdirSync(pnpmDir).filter((n) => n.startsWith('@jitl+quickjs-wasmfile-release-sync@'))) {
      candidates.push(join(pnpmDir, d, 'node_modules', '@jitl', 'quickjs-wasmfile-release-sync', 'dist', 'emscripten-module.wasm'));
    }
  }
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error('找不到 quickjs.wasm（先 `npm run build:client`）');
  return hit;
}
const QUICKJS_WASM = resolveQuickjsWasm();

// ── mock 媒体状态（隐私：只用假标题，绝不使用真实曲目；不落盘、不写日志）──────────────
let mediaStage = {
  available: false, playback: 'stopped', title: '', artist: '', album: '',
  contentType: 'music', thumbnailRev: 0,
};
let artBytes = null; // 有封面时 thumbnail 路由返回它；本任务只验 hasThumbnail 字段
const ART_PNG = encodePng((() => {
  const w = 32, h = 32;
  const data = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i += 1) { data[i * 3] = 255; data[i * 3 + 1] = 0; data[i * 3 + 2] = 255; }
  return { width: w, height: h, channels: 3, data };
})());

const mediaSnapshot = () => ({
  available: mediaStage.available,
  reason: mediaStage.available ? 'ok' : 'no-session',
  appId: mediaStage.available ? 'e2e.exe' : '',
  title: mediaStage.title,
  artist: mediaStage.artist,
  album: mediaStage.album,
  contentType: mediaStage.contentType,
  playback: mediaStage.playback,
  hasThumbnail: !!artBytes,
  thumbnailRev: artBytes ? 1 : 0,
  positionMs: 1,
  durationMs: 2,
  at: 1,
});

const { PkgReader } = await import('../../lib/host/pkg-reader.js');
const reader = new PkgReader(PKG);
const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.map': 'application/json',
};

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#000}canvas{display:block}</style>
</head><body><script type="module" src="/harness.js"></script></body></html>`;

const bundle = (await esbuild.build({
  entryPoints: [join(here, '..', 'harness', 'harness-media-entry.mjs')],
  bundle: true, format: 'esm', target: 'es2022', write: false, logLevel: 'silent',
})).outputFiles[0].text;

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const send = (body, type) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  const json = (value) => send(JSON.stringify(value), 'application/json; charset=utf-8');
  try {
    if (p === '/' || p === '/index.html') return send(HTML, 'text/html; charset=utf-8');
    if (p === '/harness.js') return send(bundle, 'text/javascript; charset=utf-8');
    // ── mock 媒体路由（不 spawn PowerShell；标题全为假数据）──────────────────────────
    if (p === '/wallpapers/now-playing') return json(mediaSnapshot());
    if (p === '/wallpapers/now-playing/thumbnail') {
      if (!artBytes) { res.writeHead(404); return res.end('nf'); }
      return send(artBytes, 'image/png');
    }
    if (p.startsWith('/wallpapers/static/')) {
      const file = p.slice('/wallpapers/static/'.length);
      if (file === 'quickjs.wasm') return send(readFileSync(QUICKJS_WASM), 'application/wasm');
      const local = join(here, '..', '..', 'dist', 'static', file);
      if (existsSync(local)) return send(readFileSync(local), MIME[extname(file)] ?? 'application/octet-stream');
      console.log('   [404 static]', file); res.writeHead(404); return res.end('nf');
    }
    if (p.startsWith('/wallpapers/scene/')) {
      const name = url.searchParams.get('name') ?? '';
      // 复刻 host 的两级查找：scene.pkg 优先，其次 WE 引擎 assets 目录。
      const entry = reader.readEntry(name);
      if (entry) return send(entry, MIME[extname(name)] ?? 'application/octet-stream');
      const engineBase = resolve(join(WE, 'assets'));
      const engine = name ? resolve(engineBase, name) : engineBase;
      if (name.includes('..') || engine === engineBase || !engine.startsWith(engineBase)
        || !existsSync(engine) || !statSync(engine).isFile()) {
        console.log('   [404 asset]', name);
        res.writeHead(404); return res.end('nf');
      }
      return send(readFileSync(engine), MIME[extname(name)] ?? 'application/octet-stream');
    }
    if (p === '/wallpapers/particle-texture') {
      const name = url.searchParams.get('name') ?? '';
      const inPkg = reader.readEntry(`materials/${name}.tex`);
      if (inPkg) return send(inPkg, 'application/octet-stream');
      const file = resolve(join(WE, 'assets', 'materials'), name + '.tex');
      if (existsSync(file) && statSync(file).isFile()) return send(readFileSync(file), 'application/octet-stream');
      console.log('   [404 ptex]', name); res.writeHead(404); return res.end('nf');
    }
    console.log('   [404]', p);
    res.writeHead(404); res.end('nf');
  } catch (e) {
    console.log('   [500]', p, String(e && e.message));
    res.writeHead(500); res.end('err');
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let edge, ws, msgId = 0;
const pending = new Map();
let logs = [];
const send2 = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, { resolve: res, reject: rej });
  ws.send(JSON.stringify({ id, method, params }));
});
async function evalJs(expression) {
  const r = await send2('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
}
async function waitReady() {
  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    try { if (await evalJs('window.__ready === true')) return true; } catch { /* 导航中 */ }
    if (logs.some((l) => l.startsWith('[harness]'))) return true;
    await sleep(200);
  }
  return false;
}
async function shot(tag) {
  const r = await send2('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(join(OUT, `media-layer-${tag}.png`), buf);
  return buf;
}

/** 白色像素数（三通道都 ≥ 250；bbox 含端点）。 */
function countWhite(img, box) {
  const [x0, y0, x1, y1] = box;
  let n = 0;
  for (let y = Math.max(0, y0); y <= Math.min(img.height - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(img.width - 1, x1); x++) {
      const o = (y * img.width + x) * img.channels;
      if (img.data[o] >= 250 && img.data[o + 1] >= 250 && img.data[o + 2] >= 250) n++;
    }
  }
  return n;
}

/** 洋红像素数（封面占位纹理；[2] 用）。 */
function countMagenta(img, box) {
  const [x0, y0, x1, y1] = box;
  let n = 0;
  for (let y = Math.max(0, y0); y <= Math.min(img.height - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(img.width - 1, x1); x++) {
      const o = (y * img.width + x) * img.channels;
      if (img.data[o] > 200 && img.data[o + 1] < 80 && img.data[o + 2] > 200) n++;
    }
  }
  return n;
}

const rectOf = async (objectId) => JSON.parse(await evalJs(`JSON.stringify(window.__objectRect(${objectId}))`) ?? 'null');
const materialOf = async (objectId) => JSON.parse(await evalJs(`JSON.stringify(window.__objectMaterialInfo(${objectId}))`) ?? 'null');
/** 显示对象的可见性（未登记 → null；对象级 visible 是 applyLayerState 的落点）。 */
const visibleOf = async (ids) => JSON.parse(await evalJs(
  `JSON.stringify(${JSON.stringify(ids)}.map((oid) => { const o = window.__player && window.__player.displayObject(oid); return o ? o.visible : null; }))`,
));
const probeMedia = async (tag) => {
  const probe = JSON.parse(await evalJs('JSON.stringify(window.__probeMedia())') ?? 'null');
  console.log(`  [probe] ${tag}:`, JSON.stringify(probe));
};

const results = [];
const judge = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${name}  ${detail}`);
};
const VW = 1600, VH = 900;
try {
  await new Promise((r) => server.listen(PORT, r));
  console.log(`harness server: http://127.0.0.1:${PORT}/  （壁纸 ${ID}）`);

  edge = spawn(resolveEdgePath(), [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(OUT, '.edge-media-layer')}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio', `--window-size=${VW},${VH}`,
    ...(USE_GPU ? ['--use-angle=d3d11', '--ignore-gpu-blocklist'] : ['--enable-unsafe-swiftshader']),
    '--disable-gpu-sandbox', 'about:blank',
  ], { stdio: 'ignore' });

  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) break; } catch { /* 未就绪 */ }
    await sleep(400);
  }
  const pages = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = pages.find((t) => t.type === 'page' && String(t.url).startsWith('about:'))
    ?? pages.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP websocket 连接失败')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) {
      const pp = pending.get(m.id);
      if (pp) { pending.delete(m.id); m.error ? pp.reject(new Error(m.error.message)) : pp.resolve(m.result); }
    } else if (m.method === 'Runtime.consoleAPICalled') {
      logs.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
    } else if (m.method === 'Log.entryAdded') {
      logs.push(`[${m.params.entry.level}] ${m.params.entry.url ?? ''} ${m.params.entry.text}`);
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + (m.params.exceptionDetails?.exception?.description ?? ''));
    }
  };
  await send2('Runtime.enable'); await send2('Log.enable'); await send2('Page.enable');
  // 固定视口：headless 新建窗口的 innerHeight 会被任务栏/窗口夹小，画布与截图就不是 1600×900。
  await send2('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });

  await send2('Page.navigate', { url: `http://127.0.0.1:${PORT}/?id=${ID}&vw=${VW}&vh=${VH}` });
  const ready = await waitReady();
  if (!ready) {
    console.log(`  ⚠️ 页面在 ${TIMEOUT_MS}ms 内未就绪`);
    console.log('  日志:', JSON.stringify(logs.slice(0, 20)));
    process.exitCode = 1;
  } else {
    await sleep(500); // harness 已等 1200ms；这里只等媒体初始派发与帧循环稳定
    const harnessLine = logs.find((l) => l.startsWith('[harness]')) ?? '(未捕获 [harness] 日志)';
    console.log('  ' + harnessLine);

    // ── [1] stopped：白色占位层 bbox 内零白像素 + 媒体层隐藏 ───────────────────────
    const rect40 = await rectOf(WHITE_BOX_OBJECT);
    const box = rect40 && Array.isArray(rect40.canvasCss) ? rect40.canvasCss : FALLBACK_WHITE_BOX;
    const whiteStopped = countWhite(decodePng(await shot('stopped')), box);
    const mediaVisibleStopped = await visibleOf(MEDIA_LAYER_IDS);
    const allHidden = mediaVisibleStopped.every((v) => v === false);
    judge('[1] stopped 白块区域白像素数 = 0', whiteStopped === 0,
      `bbox=${JSON.stringify(box)}（${rect40 ? 'dynamic' : 'fallback'}）white=${whiteStopped} ` +
      `visible(35/40/45)=${JSON.stringify(mediaVisibleStopped)}`);
    judge('[1b] stopped 媒体层（35/40/45）全部隐藏', allHidden,
      `visible=${JSON.stringify(mediaVisibleStopped)}`);
    await probeMedia('stopped');

    // ── [2] 封面（Task 8；本任务关闭）─────────────────────────────────────────────
    if (checkCover) {
      const magenta = countMagenta(decodePng(await shot('cover')), COVER_REGION);
      judge('[2] 封面洋红像素 > 200', magenta > 200, `magenta=${magenta} region=${JSON.stringify(COVER_REGION)}`);
    } else {
      console.log('  ⏭️  [2] 封面判据未启用（Task 8 才实现封面纹理/主色）');
    }

    // ── [3] playing：文本层拿到 title/artist → 画布非空且对象可见 ─────────────────
    mediaStage = {
      available: true, playback: 'playing', title: 'E2E-TITLE', artist: 'E2E-ARTIST',
      album: 'E2E-ALBUM', contentType: 'music', thumbnailRev: 1,
    };
    artBytes = ART_PNG;
    await sleep(2500); // 1s 轮询 + 文本重绘/quad 尺寸同步
    const titleMat = await materialOf(38);
    const artistMat = await materialOf(39);
    const textVis = await visibleOf([38, 39]);
    const titleW = titleMat?.mapSize?.[0] ?? null;
    const artistW = artistMat?.mapSize?.[0] ?? null;
    const titleOk = typeof titleW === 'number' && titleW > 4;
    const artistOk = typeof artistW === 'number' && artistW > 4;
    judge('[3] playing 歌名文本画布非空（mapSize[0] > 4）', titleOk,
      `obj38.mapSize=${JSON.stringify(titleMat?.mapSize ?? null)} visible=${JSON.stringify(textVis[0])}`);
    judge('[3b] playing 歌手文本画布非空（mapSize[0] > 4）', artistOk,
      `obj39.mapSize=${JSON.stringify(artistMat?.mapSize ?? null)} visible=${JSON.stringify(textVis[1])}`);
    judge('[3c] playing 歌名/歌手对象可见', textVis.every((v) => v === true), `visible=${JSON.stringify(textVis)}`);
    await probeMedia('playing');
    await shot('playing');

    // ── [4] 回到 stopped：媒体层再次隐藏 ─────────────────────────────────────────
    mediaStage = {
      available: true, playback: 'stopped', title: '', artist: '', album: '',
      contentType: 'music', thumbnailRev: 0,
    };
    artBytes = null;
    await sleep(2200);
    const mediaVisibleStopped2 = await visibleOf(MEDIA_LAYER_IDS);
    judge('[4] 回到 stopped 媒体层（35/40/45）再次隐藏', mediaVisibleStopped2.every((v) => v === false),
      `visible=${JSON.stringify(mediaVisibleStopped2)}`);
    await probeMedia('stopped-again');
    await shot('stopped-again');
  }
} catch (e) {
  console.log('[fatal]', e && e.stack ? e.stack : String(e));
  process.exitCode = 1;
} finally {
  const failed = results.filter((r) => !r.pass);
  console.log('\n===== 判定 =====');
  if (failed.length === 0 && results.length > 0) {
    console.log(`  ✅ 全部 ${results.length} 条判据通过`);
  } else if (failed.length > 0) {
    console.log(`  ❌ ${failed.length}/${results.length} 条判据失败：${failed.map((r) => r.name).join(' / ')}`);
    process.exitCode = 1;
  }
  try { ws && ws.close(); } catch { /* ignore */ }
  try { edge && edge.kill(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
}
