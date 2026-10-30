// 媒体集成 e2e：生产 lib/ 渲染真实场景壁纸，自起 server mock now-playing 两条路由 + headless Edge/CDP。
// 判据：装配即隐藏（白像素 0）/ 播放显示文本且画布宽度随标题变化 / 封面纹理与主色 / 时间线淡入·世界变换
// / 文本锚点偏移随标题刷新 / 停止再隐藏；退出码 0/1。
// `--regression`：另一条独立路径，依次渲染 4 张既有壁纸做回归对照（无媒体脚本 ⇒ 不得发起轮询），
// 并复跑 2597392171 的 Fog loop 动画断言；默认（无参数）行为不变。
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
// 回归对照素材：三张受「每对象多脚本 / 时间线」影响的既有壁纸 + 带 solid util 的「红衣骑士」
// （Knight in a red cloak；Leon 是另一张 3812518176，勿混）+ 2980088441（text 层静态色被脚本
// color 二次乘暗的回归锚点）。
// 这些壁纸都没有媒体脚本、也没有 $mediaThumbnail ⇒ 不得发起任何 now-playing 请求。
const REGRESSION_IDS = ['2832263418', '3793620838', '2597392171', '3789452668', '2980088441'];
const FOG_OBJECT_ID = 251; // 2597392171 的「Fog 1」：origin loop 时间线（fps=1.36 / length=34）
const FOG_SAMPLE_MS = [0, 800, 1600]; // rAF 对齐：目标时刻后的首个帧回调里读位置（慢帧不重样）

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(OUT_DIR, 'media-layer');
// 回归截图按任务口径落在 e2e/.out/media/（与默认媒体判据的 media-layer/ 分开）。
const OUT_REGRESSION = join(OUT_DIR, 'media');
mkdirSync(OUT, { recursive: true });
mkdirSync(OUT_REGRESSION, { recursive: true });
const PORT = httpPort(9834);
const CDP_PORT = cdpPort(9247);
const USE_GPU = flagOf('gpu');
const REGRESSION = flagOf('regression');
const ID = argOf('id', WALLPAPER_ID);
const WS = argOf('workshop', WE_WORKSHOP);
const WE = argOf('assets', WE_ASSETS);
const PKG = REGRESSION
  ? null
  : requireFile(
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
// 每个壁纸 id 一个 PkgReader（回归模式要连续渲染多张；默认模式只有一张）。
const readers = new Map();
function readerOf(id) {
  const cached = readers.get(id);
  if (cached) return cached;
  const pkg = join(WS, id, 'scene.pkg');
  if (!existsSync(pkg)) return null;
  const created = new PkgReader(pkg);
  readers.set(id, created);
  return created;
}
if (PKG) readerOf(ID);
// 服务端收到的 now-playing 请求数（回归模式判「不该启动媒体轮询」；默认模式不参与判定）。
let mediaRequests = 0;
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
    // 回归素材都没有媒体脚本：仍然计数，任何 now-playing 请求都说明「零开销」承诺被打破。
    if (p === '/wallpapers/now-playing') { mediaRequests += 1; return json(mediaSnapshot()); }
    if (p === '/wallpapers/now-playing/thumbnail') {
      mediaRequests += 1;
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
    const sceneMatch = /^\/wallpapers\/scene\/([^/]+)\/asset$/.exec(p);
    if (sceneMatch) {
      const name = url.searchParams.get('name') ?? '';
      // 复刻 host 的两级查找：scene.pkg 优先，其次 WE 引擎 assets 目录。
      const reader = readerOf(decodeURIComponent(sceneMatch[1]));
      const entry = reader ? reader.readEntry(name) : null;
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
      const ptexId = url.searchParams.get('id') ?? '';
      // 默认模式保持旧行为（无 id 时用默认壁纸的 pkg）；回归模式按 id 取各自的 pkg。
      const reader = ptexId ? readerOf(ptexId) : (PKG ? readerOf(ID) : null);
      const inPkg = reader ? reader.readEntry(`materials/${name}.tex`) : null;
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

// ── 回归模式（--regression）────────────────────────────────────────────────────
// 判据口径（与默认媒体判据完全独立）：
// 1) `__ready === true`，`__logs` 无 error 级、CDP 无 exception；warning（如 2832263418 的
//    chromatic_aberration shader 编译失败）属既有已知项 ⇒ 不判红但打印；
//    ⚠️ 边界：CDP `Log.entryAdded` 的 error **不纳入 R1**（见 BENIGN_LOG_PATTERNS 处说明）。
// 2) `__listObjects().length > 0`（装配出对象）；
// 3) 截图写 `e2e/.out/media/regression-<id>.png`；
// 4) 这些壁纸没有媒体脚本/封面绑定 ⇒ 不得发起 now-playing 请求（零轮询承诺）；
// 5) `2597392171` 的 Fog（obj 251）origin loop：0/800/1600ms 三点均有限、相邻位移 > 1、落在场景×2 内
//    （采样 rAF 对齐：目标时刻后的首帧才读位置，慢帧下不会把两次采样落在同一帧）。
// 已知良性噪音：本地 harness 页没有 favicon，Chromium 自动请求 404（只出现在 CDP 浏览器日志里）。
// ⚠️ **R1 边界**：CDP `Log.entryAdded` 的 error 只打印、不判红 —— 其中混有 favicon/资源 404 与导航期的
// `net::ERR_ABORTED`，逐条豁免易随环境假红；页面级 error 已由 `__logs` + CDP `Runtime.exceptionThrown` 覆盖
// （`TESTING.md` §2.17 有记录）。favicon 在 exception/`__logs` 侧也豁免，避免浏览器差异。
const BENIGN_LOG_PATTERNS = [
  /favicon\.ico/i,
];
const isBenignLog = (text) => BENIGN_LOG_PATTERNS.some((re) => re.test(text));

/** 从 `__logs`（harness 的 console 镜像）分出致命 error 与允许的 warning。 */
function classifyPageLogs(entries) {
  const errors = [];
  const warnings = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const level = String(entry?.level ?? '');
    const text = String(entry?.text ?? '');
    if (level === 'warn') { warnings.push(text); continue; }
    if (level === 'error' && !isBenignLog(text)) errors.push(text);
  }
  return { errors, warnings };
}

async function waitNavigated(id) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const search = String(await evalJs('location.search'));
      if (search.includes(`id=${id}`)) return true;
    } catch { /* CDP 正在导航 */ }
    await sleep(100);
  }
  return false;
}

function pngBytesToFile(name, buf) {
  const file = join(OUT_REGRESSION, name);
  writeFileSync(file, buf);
  return { file, bytes: buf.length };
}

async function runRegression() {
  console.log(`regression mode: ${REGRESSION_IDS.join(' / ')}（截图 → ${OUT_REGRESSION}）`);
  for (const id of REGRESSION_IDS) {
    // 缺素材直接 fatal（e2e 依赖本机库；静默跳过会变成假绿）。
    requireFile(join(WS, id, 'scene.pkg'), `本机缺少回归素材 ${id}`);
    logs = [];
    const mediaBefore = mediaRequests;
    await send2('Page.navigate', { url: `http://127.0.0.1:${PORT}/?id=${id}&vw=${VW}&vh=${VH}` });
    const navigated = await waitNavigated(id);
    const ready = navigated && await waitReady();
    await sleep(600); // harness 自己等 1200ms；这里只让帧循环/时间线稳定
    let info = null;
    try {
      info = JSON.parse(await evalJs(`JSON.stringify({
        ready: window.__ready === true,
        logs: window.__logs ?? [],
        harness: (window.__logs ?? []).filter((l) => String(l.text ?? '').startsWith('[harness]')).map((l) => l.text),
        objectCount: typeof window.__listObjects === 'function' ? (window.__listObjects() ?? []).length : null,
        // 场景正交尺寸：player 的 sceneWidth/sceneHeight（harness 已暴露 __player；Fog 包围盒上限用）。
        // 取不到时回退「已登记对象里最大的几何世界尺寸」——背景层通常就等于场景尺寸。
        sceneSize: (() => {
          const p = window.__player;
          if (p && Number.isFinite(p.sceneWidth) && Number.isFinite(p.sceneHeight)) {
            return { width: p.sceneWidth, height: p.sceneHeight };
          }
          let best = null;
          for (const o of (typeof window.__listObjects === 'function' ? (window.__listObjects() ?? []) : [])) {
            const w = o?.worldSize?.[0], h = o?.worldSize?.[1];
            if (Number.isFinite(w) && Number.isFinite(h) && (!best || w * h > best.width * best.height)) {
              best = { width: w, height: h };
            }
          }
          return best;
        })(),
      })`) ?? 'null');
    } catch (e) {
      info = { error: String(e && e.message ? e.message : e) };
    }
    const harnessLine = info?.harness?.[0] ?? '(未捕获 [harness] 日志)';
    console.log(`  [${id}] ${harnessLine}`);
    const { errors, warnings } = classifyPageLogs(info?.logs);
    for (const w of warnings.slice(0, 6)) console.log(`   [warn] ${w.slice(0, 200)}`);
    const cdpExceptions = logs.filter((l) => l.startsWith('[exception]') && !isBenignLog(l));
    // CDP 浏览器日志的 error：只做诊断输出，不参与 R1 判定（边界见 BENIGN_LOG_PATTERNS 注释）。
    const cdpLogErrors = logs.filter((l) => l.startsWith('[error]') && !isBenignLog(l));
    for (const l of cdpLogErrors.slice(0, 6)) console.log(`   [cdp-error] ${l.slice(0, 200)}`);
    // 判据 1：就绪 + 无 error/exception（warning 不判红，但计数入 detail）。
    judge(`[R1] ${id} 就绪且日志无 error/exception`,
      ready && info?.ready === true && errors.length === 0 && cdpExceptions.length === 0,
      `ready=${JSON.stringify(info?.ready)} nav=${navigated} errors=${errors.length} cdpException=${cdpExceptions.length}` +
      ` cdpLogError=${cdpLogErrors.length} warnings=${warnings.length}` +
      `${errors.length ? ' firstError=' + JSON.stringify(errors[0].slice(0, 220)) : ''}` +
      `${cdpExceptions.length ? ' firstCdp=' + JSON.stringify(cdpExceptions[0].slice(0, 220)) : ''}` +
      `${info?.error ? ' evalError=' + info.error : ''}`);
    // 判据 2：对象齐全。
    const objectCount = info?.objectCount ?? null;
    judge(`[R2] ${id} 对象齐全（__listObjects > 0）`, typeof objectCount === 'number' && objectCount > 0,
      `objects=${JSON.stringify(objectCount)} sceneSize=${JSON.stringify(info?.sceneSize ?? null)}`);
    // 判据 3：截图落盘（默认媒体判据的媒体层截图不受影响）。
    let shotInfo = null;
    let shotBuf = null;
    try {
      const r = await send2('Page.captureScreenshot', { format: 'png' });
      shotBuf = Buffer.from(r.data, 'base64');
      shotInfo = pngBytesToFile(`regression-${id}.png`, shotBuf);
    } catch (e) {
      console.log(`  [${id}] 截图失败: ${String(e && e.message ? e.message : e)}`);
    }
    judge(`[R3] ${id} 截图已落盘`, !!shotInfo && shotInfo.bytes > 0,
      shotInfo ? `${shotInfo.file} ${shotInfo.bytes}B` : 'captureScreenshot 失败');
    // 判据 4：无媒体轮询（这些壁纸不声明媒体脚本/封面绑定）。
    const mediaDelta = mediaRequests - mediaBefore;
    judge(`[R4] ${id} 未发起媒体轮询`, mediaDelta === 0,
      `now-playing 请求数=${mediaDelta}（累计 ${mediaRequests}）`);

    // 判据 6（2980088441）：text 层材质 color 不得被脚本/时间线动态 color 改写（B2 回归）。
    // 主判据 = 材质 color ≈ [1,1,1]（text 静态色烘进 canvas）；截图文字区红像素只作辅助（解码失败不判红）。
    if (id === '2980088441') {
      const mat = JSON.parse(await evalJs('JSON.stringify(window.__objectMaterialInfo(54))') ?? 'null');
      const color = mat?.color;
      const white = Array.isArray(color) && color.length === 3
        && color.every((v) => typeof v === 'number' && Math.abs(v - 1) <= 0.01);
      const rect = await rectOf(54);
      let redPixels = null;
      if (shotBuf && rect?.canvasCss) {
        try {
          redPixels = countPixels(decodePng(shotBuf), rect.canvasCss, (r, g, b) => r > 100 && g < 80 && b < 80);
        } catch { redPixels = null; }
      }
      judge('[R6] 2980088441 text 层材质 color 未被脚本动态 color 改写（≈[1,1,1]）',
        white && mat?.visible === true && (redPixels === null || redPixels > 10),
        `obj54 color=${JSON.stringify(color)} visible=${JSON.stringify(mat?.visible)}` +
        ` 文本区红像素=${JSON.stringify(redPixels)} rect=${JSON.stringify(rect?.canvasCss ?? null)}`);
    }

    // 判据 5：2597392171 的 Fog origin loop 可复跑断言（Fog 现在会动，属预期）。
    if (id === '2597392171') {
      const sceneSize = info?.sceneSize ?? null;
      let fog = null;
      try {
        // rAF 对齐：目标时刻后的第一帧才读位置（软栅/慢渲染时 setTimeout 相邻采样可能落在同一帧，
        // 位置未推进 ⇒ steps>1 假红；帧回调里读到的才是该帧已求值后的世界位置）。
        await evalJs(`(() => {
          window.__fogSamples = [];
          const targets = ${JSON.stringify(FOG_SAMPLE_MS)};
          const t0 = performance.now();
          let next = 0;
          const step = () => {
            const now = performance.now() - t0;
            while (next < targets.length && now >= targets[next]) {
              const m = window.__objectMaterialInfo(${FOG_OBJECT_ID});
              window.__fogSamples.push({ at: targets[next], t: now, pos: m ? m.position : null });
              next += 1;
            }
            if (next < targets.length) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
          return true;
        })()`);
        // 等目标点全部采完（慢帧下比固定 sleep 稳）；超时按已采点判红并打印样本数（可诊断）。
        const sampleDeadline = Date.now() + 20_000;
        while (Date.now() < sampleDeadline) {
          const got = Number(await evalJs('(window.__fogSamples ?? []).length')) || 0;
          if (got >= FOG_SAMPLE_MS.length) break;
          await sleep(100);
        }
        fog = JSON.parse(await evalJs('JSON.stringify(window.__fogSamples ?? null)') ?? 'null');
      } catch (e) {
        console.log(`  [${id}] Fog 采样失败: ${String(e && e.message ? e.message : e)}`);
      }
      const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
      const points = Array.isArray(fog)
        ? fog.map((s) => (Array.isArray(s?.pos) && s.pos.length === 3 && s.pos.every(isNum) ? s.pos : null))
        : [];
      const allFinite = points.length === FOG_SAMPLE_MS.length && points.every((p) => p !== null);
      const steps = [];
      for (let i = 1; i < points.length; i += 1) {
        if (!points[i - 1] || !points[i]) { steps.push(null); continue; }
        steps.push(Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
      }
      const runs = steps.length > 0 && steps.every((s) => s !== null && s > 1);
      const w = sceneSize?.width ?? null, h = sceneSize?.height ?? null;
      const inBounds = allFinite && isNum(w) && isNum(h)
        && points.every((p) => Math.abs(p[0]) < w * 2 && Math.abs(p[1]) < h * 2);
      judge('[R5] 2597392171 Fog loop 时间线在跑（0/800/1600ms）',
        allFinite && runs && inBounds,
        `samples=${points.length}/${FOG_SAMPLE_MS.length} finite=${allFinite}` +
        ` positions=${JSON.stringify(points)} steps=${JSON.stringify(steps.map((s) => (s === null ? null : Number(s.toFixed(2)))))}` +
        ` scene=${JSON.stringify(sceneSize)} bounds(2×)=${JSON.stringify([w === null ? null : w * 2, h === null ? null : h * 2])}`);
    }
  }
}

try {
  await new Promise((r) => server.listen(PORT, r));
  console.log(`harness server: http://127.0.0.1:${PORT}/  （${REGRESSION ? '回归模式 ' + REGRESSION_IDS.length + ' 张' : '壁纸 ' + ID}）`);

  edge = spawn(resolveEdgePath(), [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${REGRESSION ? join(OUT_REGRESSION, '.edge-regression') : join(OUT, '.edge-media-layer')}`,
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

  if (REGRESSION) {
    await runRegression();
  } else {
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
    // [5a] 淡入前置：对象 45 的 alpha 时间线是 startpaused 第 0 帧 = 0，封面事件前必须≈0。
    // 轮询间隔 1s，这里紧接着切状态，先同步采样一次早期值（不等 1s 轮询把动画跑完）。
    const opacityOf = async (objectId) => (await materialOf(objectId))?.opacity ?? null;
    const earlyOpacity45 = await opacityOf(45);
    const earlyOpacity35 = await opacityOf(35);
    // stopped 锚点位置（文本为空 ⇒ 装配期锚点偏移 = 0，位置 = 对象锚点）：[5d] 用它判「偏移已生效」。
    const earlyPos38 = (await materialOf(38))?.position ?? null;
    const earlyPos39 = (await materialOf(39))?.position ?? null;
    // 浏览器侧 16ms 采样窗口：覆盖「播放事件 → 滑入/淡入 → 停稳」全过程（CDP 往返太稀疏）。
    await evalJs(`(() => {
      window.__animSamples = { opacity45: [], opacity35: [], pos38: [] };
      window.__animSampler = setInterval(() => {
        const m45 = window.__objectMaterialInfo(45);
        const m35 = window.__objectMaterialInfo(35);
        const m38 = window.__objectMaterialInfo(38);
        window.__animSamples.opacity45.push(m45 ? m45.opacity : null);
        window.__animSamples.opacity35.push(m35 ? m35.opacity : null);
        window.__animSamples.pos38.push(m38 ? m38.position : null);
      }, 16);
      return true;
    })()`);
    await sleep(2500); // 1s 轮询 + 文本重绘/quad 尺寸同步 + 动画采样窗口
    const animSamples = JSON.parse(await evalJs(
      '(() => { clearInterval(window.__animSampler); return JSON.stringify(window.__animSamples); })()',
    ) ?? 'null');
    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
    const op45 = (animSamples?.opacity45 ?? []).filter(isNum);
    const op35 = (animSamples?.opacity35 ?? []).filter(isNum);
    const pos38 = (animSamples?.pos38 ?? []).filter((p) => Array.isArray(p) && p.length === 3 && p.every(isNum));
    const min45 = op45.length ? Math.min(...op45) : null;
    const final45 = op45.length ? op45[op45.length - 1] : null;
    const min35 = op35.length ? Math.min(...op35) : null;
    const final35 = op35.length ? op35[op35.length - 1] : null;
    const basePos38 = earlyPos38 ?? pos38[0] ?? null;
    const maxDelta38 = basePos38 && pos38.length
      ? Math.max(...pos38.map((p) => Math.hypot(p[0] - basePos38[0], p[1] - basePos38[1])))
      : null;
    const lastPos = pos38[pos38.length - 1] ?? null;
    const prevPos = pos38[pos38.length - 2] ?? null;
    const stableDelta38 = lastPos && prevPos ? Math.hypot(lastPos[0] - prevPos[0], lastPos[1] - prevPos[1]) : null;
    judge('[5a] 淡入：obj45 早期 opacity < 0.6，封面事件后 → > 0.9',
      (earlyOpacity45 ?? 1) < 0.6 && min45 !== null && min45 < 0.6 && final45 !== null && final45 > 0.9,
      `early=${JSON.stringify(earlyOpacity45)} min=${JSON.stringify(min45)} final=${JSON.stringify(final45)}` +
      ` samples=${op45.length} early35=${JSON.stringify(earlyOpacity35)}`);
    // [5b] 时间线确实在跑（弱判据）：位移主要来自父对象 35 的 scale 时间线重播带动子树；
    // 「滑入」正确性（文本锚点偏移）由 [5d] 承担，本判据只证明时间线/世界变换没有被冻结。
    judge('[5b] 时间线在跑：obj38 position 位移 > 2（主要来自父级 scale 重播），且最终稳定（相邻采样差 < 0.5）',
      maxDelta38 !== null && maxDelta38 > 2 && stableDelta38 !== null && stableDelta38 < 0.5,
      `maxΔ=${maxDelta38 === null ? 'null' : maxDelta38.toFixed(3)} stableΔ=${stableDelta38 === null ? 'null' : stableDelta38.toFixed(3)}` +
      ` base=${JSON.stringify(basePos38)} last=${JSON.stringify(lastPos)} samples=${pos38.length}`);
    judge('[5c] 媒体区淡入：obj35 opacity 从 ≈0 升到 ≈0.5',
      min35 !== null && min35 < 0.1 && final35 !== null && final35 > 0.4 && final35 < 0.6,
      `min=${JSON.stringify(min35)} final=${JSON.stringify(final35)} samples=${op35.length}`);
    const titleMat1 = await materialOf(38);
    const titleW1 = titleMat1?.mapSize?.[0] ?? null;
    // [5d] 基线：E2E-T1 稳定后的文本 quad 几何宽 + 位置（换更长标题前的锚点偏移样本）。
    const rect38Before = await rectOf(38);
    const artistPosBefore = (await materialOf(39))?.position ?? null;
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

    // ── [5d] 文本锚点偏移刷新（C1 回归判据）────────────────────────────────────────
    // horizontalalign=left ⇒ origin 是文本左缘，quad 中心 = 锚点 + 文本宽/2。标题变长后 position.x
    // 必须跟着多走「半世界宽度差」——renderOffset 若冻结在装配期（空文本 = 0），每帧 syncWorld 会把
    // 位置覆盖回锚点，position 不随标题变化。
    // 注意：__objectRect().worldSize 是几何（本地）尺寸，未乘 mesh.scale；世界半宽差 = Δ几何宽 × scaleX / 2。
    await sleep(200);
    const rect38After = await rectOf(38);
    const titlePosLate = (await materialOf(38))?.position ?? null;
    const rect38Late = await rectOf(38);
    const artistPosAfter = (await materialOf(39))?.position ?? null;
    const sx38 = titleMat2?.scale?.[0] ?? null;
    const worldW1 = rect38Before?.worldSize?.[0] ?? null;
    const worldW2 = rect38After?.worldSize?.[0] ?? null;
    const posX1 = titleMat1?.position?.[0] ?? null;
    const posX2 = titleMat2?.position?.[0] ?? null;
    const posY2 = titleMat2?.position?.[1] ?? null;
    const posX3 = titlePosLate?.[0] ?? null;
    const posY3 = titlePosLate?.[1] ?? null;
    const halfWorldWidthDelta = worldW1 !== null && worldW2 !== null && sx38 !== null
      ? ((worldW2 - worldW1) * sx38) / 2 : null;
    // left 锚点 ⇒ 更长标题使中心右移（ΔposX > 0）；扩展名固定的容差 ±20%。
    const dPosX = posX1 !== null && posX2 !== null ? posX2 - posX1 : null;
    const relErr = dPosX !== null && halfWorldWidthDelta !== null && halfWorldWidthDelta !== 0
      ? Math.abs(dPosX - halfWorldWidthDelta) / Math.abs(halfWorldWidthDelta) : null;
    const offsetApplied38 = posX1 !== null && earlyPos38 ? posX1 - earlyPos38[0] > 2 : false;
    const posStable = posX2 !== null && posX3 !== null
      ? Math.hypot(posX3 - posX2, (posY3 ?? 0) - (posY2 ?? 0)) < 0.5 : false;
    const worldWStable = worldW2 !== null && rect38Late?.worldSize?.[0] === worldW2;
    // obj39 Artist 同族：标题变化不影响 artist 文本；但播放后位置必须含锚点偏移且稳定。
    const artistOffsetApplied39 = earlyPos39 && artistPosBefore
      ? artistPosBefore[0] - earlyPos39[0] > 2 : false;
    const artistStable39 = artistPosBefore && artistPosAfter
      ? Math.hypot(artistPosAfter[0] - artistPosBefore[0], artistPosAfter[1] - artistPosBefore[1]) < 0.5
      : false;
    judge('[5d] 文本锚点偏移随标题刷新（left 锚点：ΔpositionX ≈ 半世界宽度差 ±20%，且稳定）',
      worldW1 !== null && worldW2 !== null && worldW2 > worldW1 && sx38 !== null
        && halfWorldWidthDelta !== null && halfWorldWidthDelta > 0
        && dPosX !== null && dPosX > 0 && relErr !== null && relErr <= 0.2
        && offsetApplied38 && posStable && worldWStable
        && artistOffsetApplied39 && artistStable39,
      `obj38 worldSize(local) ${JSON.stringify(worldW1)}→${JSON.stringify(worldW2)} Δ=${worldW1 !== null && worldW2 !== null ? (worldW2 - worldW1).toFixed(3) : 'null'}` +
      ` scaleX=${sx38 === null ? 'null' : sx38.toFixed(5)} ⇒ 期望Δpos=${halfWorldWidthDelta === null ? 'null' : halfWorldWidthDelta.toFixed(3)};` +
      ` posX ${posX1 === null ? 'null' : posX1.toFixed(3)}→${posX2 === null ? 'null' : posX2.toFixed(3)}` +
      ` Δ=${dPosX === null ? 'null' : dPosX.toFixed(3)} 相对误差=${relErr === null ? 'null' : (relErr * 100).toFixed(1) + '%'};` +
      ` anchorX(stopped)=${earlyPos38 ? earlyPos38[0].toFixed(3) : 'null'} offsetApplied=${offsetApplied38};` +
      ` stable=${posStable} Δ=${posX3 !== null && posX2 !== null ? Math.hypot(posX3 - posX2, (posY3 ?? 0) - (posY2 ?? 0)).toFixed(3) : 'null'}` +
      ` worldWStable=${worldWStable};` +
      ` obj39 posX stopped=${earlyPos39 ? earlyPos39[0].toFixed(3) : 'null'}→playing=${artistPosBefore ? artistPosBefore[0].toFixed(3) : 'null'}` +
      ` offsetApplied=${artistOffsetApplied39} stable=${artistStable39}`);
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

    // ── [perf] 媒体壁纸 FPS（诊断输出，不参与判据：SwiftShader 数字不代表真机）────────
    try {
      const fps = await evalJs('window.__fpsProbe(3000)');
      const gl = await evalJs('JSON.stringify(window.__glRendererInfo())');
      console.log(`  [perf] 媒体壁纸 FPS=${JSON.stringify(fps)} gl=${gl}`);
    } catch (e) {
      console.log('  [perf] FPS 探针失败:', String(e && e.message ? e.message : e));
    }
  } // 默认媒体判据（if (!ready) … else 的收尾）
  } // if (REGRESSION) … else 的收尾
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
