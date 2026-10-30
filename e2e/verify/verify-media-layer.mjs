// 媒体集成 e2e：生产 lib/ 渲染真实场景壁纸，自起 server mock now-playing 两条路由 + headless Edge/CDP。
// 判据：装配即隐藏（白像素 0）/ 播放显示文本且画布宽度随标题变化 / 封面纹理与主色 / 停止再隐藏；退出码 0/1。
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
const MEDIA_LAYER_IDS = [35, 40, 45];
const COVER_REGION = [1160, 285, 1245, 360]; // [2a] 封面区域（objectRect(45) 不可得时的兜底）

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
  contentType: 'music',
};
let artBytes = null; // 有封面时 thumbnail 路由返回它
let artRev = 0;      // 每次换封面 +1（快照 diff 靠 thumbnailRev 变化）
/** 生成纯色 PNG（封面 mock；隐私：只用生成图，不用真实封面）。 */
function solidPng(r, g, b, w = 32, h = 32) {
  const data = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i += 1) { data[i * 3] = r; data[i * 3 + 1] = g; data[i * 3 + 2] = b; }
  return encodePng({ width: w, height: h, channels: 3, data });
}
// [2c] 方向判据封面：上≈3/4 洋红、下≈1/4 绿（32×32 RGBA，程序生成）。
// 绿色从第 23 行起（严格 24 行时上下半高切分恰好各半、无法判「占主导」；23/9 仍≈3/4:1/4）。
const ART_MAGENTA_ROWS = 23;
function asymmetricPng(w = 32, h = 32) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const magenta = y < ART_MAGENTA_ROWS;
      data[o] = magenta ? 255 : 0;
      data[o + 1] = magenta ? 0 : 255;
      data[o + 2] = magenta ? 255 : 0;
      data[o + 3] = 255;
    }
  }
  return encodePng({ width: w, height: h, channels: 4, data });
}
const ART_ASYM = asymmetricPng();
const ART_GREEN = solidPng(0, 255, 0);
const setArt = (png) => { artBytes = png; artRev += 1; };

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
  thumbnailRev: artBytes ? artRev : 0,
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

/** bbox=[x0,y0,x1,y1]（含端点）内满足颜色判定的像素数（封面判据 [2a]/[2c] 用）。 */
function countPixels(img, box, test) {
  const [x0, y0, x1, y1] = box;
  let n = 0;
  for (let y = Math.max(0, y0); y <= Math.min(img.height - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(img.width - 1, x1); x++) {
      const o = (y * img.width + x) * img.channels;
      if (test(img.data[o], img.data[o + 1], img.data[o + 2])) n++;
    }
  }
  return n;
}
const isMagenta = (r, g, b) => r > 200 && g < 80 && b > 200;
const isGreen = (r, g, b) => g > 200 && r < 80 && b < 80;
const countMagenta = (img, box) => countPixels(img, box, isMagenta);
const countGreen = (img, box) => countPixels(img, box, isGreen);

const materialOf = async (objectId) => JSON.parse(await evalJs(`JSON.stringify(window.__objectMaterialInfo(${objectId}))`) ?? 'null');
const rectOf = async (objectId) => JSON.parse(await evalJs(`JSON.stringify(window.__objectRect(${objectId}))`) ?? 'null');
const tintOf = async (objectId) => JSON.parse(await evalJs(`JSON.stringify(window.__materialTint(${objectId}))`) ?? 'null');
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

    // ── [1] 装配期（render resolve 即时）：媒体层隐藏 + 白块区域零白像素 ─────────────
    const immediate = JSON.parse(await evalJs('JSON.stringify(window.__mediaAtRenderResolve)') ?? 'null');
    const immediateHidden = !!immediate && Array.isArray(immediate.visible)
      && immediate.visible.every((v) => v === false);
    judge('[1] render resolve 即媒体层隐藏且白像素 = 0', immediateHidden && immediate.whitePixels === 0,
      `resolve=${immediate ? Math.round(immediate.at) : 'null'}ms visible=${JSON.stringify(immediate?.visible ?? null)} ` +
      `white=${immediate?.whitePixels ?? 'null'} frame=${immediate?.frameCaptured} ` +
      `pollDelay=${immediate?.firstPollDelayedMs ?? '?'}ms bbox=${JSON.stringify(immediate?.rect ?? null)}`);

    // ── [1b] stopped 稳态：媒体层（35/40/45）仍全部隐藏 ───────────────────────────
    const mediaVisibleStopped = await visibleOf(MEDIA_LAYER_IDS);
    const allHidden = mediaVisibleStopped.every((v) => v === false);
    judge('[1b] stopped 媒体层（35/40/45）全部隐藏', allHidden,
      `visible=${JSON.stringify(mediaVisibleStopped)}`);
    await probeMedia('stopped');
    await shot('stopped');

    // ── [3] playing：文本层拿到 title/artist；两个不同长度标题验证画布随内容变化 ──────
    mediaStage = {
      available: true, playback: 'playing', title: 'E2E-T1', artist: 'E2E-ARTIST',
      album: 'E2E-ALBUM', contentType: 'music',
    };
    setArt(ART_ASYM);
    await sleep(2500); // 1s 轮询 + 文本重绘/quad 尺寸同步
    const titleMat1 = await materialOf(38);
    const titleW1 = titleMat1?.mapSize?.[0] ?? null;
    mediaStage = { ...mediaStage, title: 'E2E-LONGER-TITLE-2' }; // 同阶段换标题：画布宽度必须跟着变
    await sleep(2000);
    const titleMat2 = await materialOf(38);
    const artistMat = await materialOf(39);
    const textVis = await visibleOf([38, 39]);
    const titleW2 = titleMat2?.mapSize?.[0] ?? null;
    const artistW = artistMat?.mapSize?.[0] ?? null;
    const titleGrew = typeof titleW1 === 'number' && typeof titleW2 === 'number'
      && titleW1 > 4 && titleW2 > titleW1;
    judge('[3] playing 歌名画布宽度随标题变化（防静态占位假绿）', titleGrew,
      `obj38.mapSize[0] ${JSON.stringify(titleW1)} → ${JSON.stringify(titleW2)}（E2E-T1 → E2E-LONGER-TITLE-2）`);
    judge('[3b] playing 歌手文本画布非空（mapSize[0] > 4）', typeof artistW === 'number' && artistW > 4,
      `obj39.mapSize=${JSON.stringify(artistMat?.mapSize ?? null)} visible=${JSON.stringify(textVis[1])}`);
    judge('[3c] playing 歌名/歌手对象可见', textVis.every((v) => v === true), `visible=${JSON.stringify(textVis)}`);
    await probeMedia('playing');
    await shot('playing');

    // ── [2] 封面（Task 8）：封面像素 + 方向 + 主色链路（边框 tint 跟随封面主色）──────────
    const rect45 = await rectOf(45);
    const coverBox = rect45?.canvasCss ?? COVER_REGION;
    const coverImg = decodePng(await shot('cover'));
    const magenta = countMagenta(coverImg, coverBox);
    // [2c] 方向：bbox 高度对半切分。正立 = 上半洋红主导、下半绿主导（颠倒则相反）。
    const [cx0, cy0, cx1, cy1] = coverBox;
    const midY = Math.floor((cy0 + cy1) / 2);
    const upperMagenta = countMagenta(coverImg, [cx0, cy0, cx1, midY]);
    const upperGreen = countGreen(coverImg, [cx0, cy0, cx1, midY]);
    const lowerMagenta = countMagenta(coverImg, [cx0, midY + 1, cx1, cy1]);
    const lowerGreen = countGreen(coverImg, [cx0, midY + 1, cx1, cy1]);
    const tintMagenta = await tintOf(40);
    // 切绿色封面（rev 变化）⇒ 重新拉取/取色 ⇒ tint 必须跟着变，证明不是一次性静态色。
    setArt(ART_GREEN);
    await sleep(2500);
    const tintGreen = await tintOf(40);
    const near = (a, b, tol = 0.1) => Array.isArray(a) && a.length === 3
      && a.every((v, i) => Math.abs(v - b[i]) <= tol);
    judge('[2a] 封面洋红像素 > 200', magenta > 200,
      `magenta=${magenta} bbox=${JSON.stringify(coverBox)}`);
    judge('[2b] 主色链路：边框 tint 随封面主色（洋红→绿）', near(tintMagenta, [1, 0, 1]) && near(tintGreen, [0, 1, 0]),
      `tint ${JSON.stringify(tintMagenta)} → ${JSON.stringify(tintGreen)}`);
    judge('[2c] 封面方向：上半洋红主导、下半绿主导', upperMagenta > upperGreen * 4
      && lowerGreen > lowerMagenta * 1.15 && upperMagenta > 200 && lowerGreen > 100,
      `upper magenta=${upperMagenta} green=${upperGreen}; lower magenta=${lowerMagenta} green=${lowerGreen}（bbox 高度对半切分）`);

    // ── [4] 回到 stopped：媒体层再次隐藏 ─────────────────────────────────────────
    mediaStage = {
      available: true, playback: 'stopped', title: '', artist: '', album: '',
      contentType: 'music',
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
