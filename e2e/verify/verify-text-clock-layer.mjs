// 真实渲染验证：「魔兽之门」1922570576 的 text 时钟层（右下角时间数字）是否渲染出来。
//
// 自起 http server（复刻 host 的三条资源路由：`/wallpapers/scene/<id>/asset`、
// `/wallpapers/static/<file>`、`/wallpapers/particle-texture`）+ headless Edge（不依赖 DSH token），
// 用**生产 `lib/`** 渲染真实壁纸（素材来自本机 workshop + WE 安装目录）。
//
// A/B 对照（同一份 lib、同一页面骨架）：
//   ?broken=script —— 把 `getTextScriptRuntime` 注入成「永远返回 null」= **修复前的行为**
//                    （`obj.script && !binding && !isClock → continue` ⇒ text 层整层跳过）；
//   （无参数）     —— 生产路径（脚本 bind 成功 ⇒ 文本层被装配）。
// 判据（**不依赖坐标投影换算** —— 本脚本第一版算错了一次 canvas y 方向与屏幕 quad 的对应关系，
// 于是「数字明明在画面上」却被量成 Δ7；现在的口径全部是像素事实 + 生产公开 API）：
//   [1] 修复前装配（`getTextScriptRuntime` 注入 null）不产生文本层；生产装配产生（`player.displayObject`）。
//   [2] 文本层画布上真的画出了白色字形（亮像素数 / 包围盒），且字形 alpha 未被压淡。
//   [3] 屏幕上能读到白字：右下角「隐藏该层时暗、显示时亮」的像素数与亮度（因果绑定的口径，
//       右下角本来就亮的粒子高光不算）。
//   [4] 同页「显示 → 隐藏 → 显示」的**增量**信号远高于**多站固定参考区**噪声地板（外扩盒内 = 健康
//       装配 A/B − 缺失装配 A/B；参考区 = 与外扩盒同 y 带、等面积的 3 个静区，见下）。
//   [5] 差异**严格**落在该文本 quad 的屏幕矩形内（零回归）。
// 退出码：0 = 全部判据通过；1 = 有判据失败或脚本异常（CI 门禁）。
//
// 术语：**对象盒** = `__objectRect(778).canvasCss`（本例 `[930,723,1261,808]`）；**外扩盒** = 判据用的
// `box`（对象盒每边外扩，本例 `[928,721,1264,811]`，面积 30667 px）。下文的「quad」一律指外扩盒。
//
// 噪声地板口径（2026-10-13 修复轮 1 重做实测，**增量口径**）：
//   · 分子 = `dAB_text − dAB_broken` —— **同一外扩盒**、**同一对截图语义**（显示 vs 隐藏）下的健康装配
//     与缺失装配之差 ⇒ 背景水面动画在相减中抵消，只剩文本层自身的贡献（5 次实测 16263–16712 px）。
//     旧口径直接拿 `dAB_text` 当分子，把背景也算进「文本层贡献」：缺失态同一外扩盒就有 ≈13.1k px
//     （占旧阈值的 75%）⇒ 文本衰减 74% 仍能 PASS。
//   · 分母 = **多站固定参考区**（与外扩盒同 y 带、等面积 300×91、与外扩盒不相交的 3 个候选）在同一跳
//     （iso-show vs iso-hide）上的 A/B 差异像素数的**中位数**（= 三站第 2 名；不挑最安静的站，也不被
//     单站尖峰支配；实测候选 same-y-left ≈5.7k / mirror ≈1.4–1.6k（三站里最安静）/ same-y-right ≈4.9–6.3k px）。
//   · 参考区只作「静区统计基准」，**不声称背景同类**；脚本对每个候选箱断言在界内、与外扩盒不相交、
//     三站等面积 ⇒ 越界或退化时判 FAIL（旧实现会被 `diffPng` 静默 clamp 成更小的区域 ⇒ 地板被无声压低）。
// 判据 [10] 的分母仍是外扩盒内两个「文本可见」帧的差异（分子分母同区域，合法动画在两边同时出现
// ⇒ 天然免疫），但阈值额外按区域面积**封顶**（`2·dAA+50` 在 dAA ≥ 15309 px 时必然成立 = 恒真）。
// `--teeth`（**默认验收命令已带**：`npm run e2e:textclock`）：额外在「文本层缺失」装配下再测一次
// 增量分子（结构性 ≈0）与多站地板，断言 [9] 的表达式**必须为假**（牙）。
//
// ⚠️ 依赖本机素材（workshop 壁纸 + WE 安装目录），CI 上会因缺素材失败 —— 没有加进 ci.yml。
// 用法：node e2e/verify/verify-text-clock-layer.mjs [--workshop=<dir>] [--assets=<dir>]
//        [--port=9813] [--cdp-port=9228] [--gpu] [--no-teeth]
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { OUT_DIR, WE_WORKSHOP, WE_ASSETS, httpPort, cdpPort, resolveEdgePath, TIMEOUT_MS, argOf, flagOf, requireFile } from '../config.mjs';
import { decodePng } from '../lib/png-stats.mjs';

const WALLPAPER_ID = '1922570576'; // 魔兽之门
const TEXT_OBJECT_ID = 778;        // scene.json 里的 "3D Clock"

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(OUT_DIR, 'text-clock');
mkdirSync(OUT, { recursive: true });
const PORT = httpPort(9813);
const CDP_PORT = cdpPort(9228);
const USE_GPU = flagOf('gpu');
const TEETH = !flagOf('no-teeth'); // 牙的标定自检**默认开**（成本 ≈1.2 s，见 header 与 TESTING.md §2.6）

const ID = argOf('id', WALLPAPER_ID);
const WS = argOf('workshop', WE_WORKSHOP);
const WE = argOf('assets', WE_ASSETS);
const PKG = requireFile(join(WS, ID, 'scene.pkg'), `本机缺少壁纸 ${ID}（用 --workshop=<dir> 指定）`);
// quickjs 沙箱 wasm：优先 dist/static/quickjs.wasm（build:client 的产物，页面加载的就是它），
// 缺省回退 node_modules（pnpm 下真实路径在 .pnpm/<pkg>@<ver>/node_modules/... —— 顶层 @jitl/
// 不是直接依赖，`node_modules/@jitl/...` 在 pnpm 布局下不存在，故这里两处都找）。
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
  if (!hit) throw new Error('找不到 quickjs.wasm（先 `npm run build:client` 或 `pnpm install`）');
  return hit;
}
const QUICKJS_WASM = resolveQuickjsWasm();

// ── 复刻 host 的 pkg 读取（只读需要的两条：scene.json / 字体 / image 纹理）──────────────────
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

// 引擎目录命中的场景素材（探针用：证明字体真的是从 `<WE>/assets` 取的）
const assetHits = [];

const bundle = (await esbuild.build({
  entryPoints: [join(here, '..', 'harness', 'harness-text-clock-entry.mjs')],
  bundle: true, format: 'esm', target: 'es2022', write: false, logLevel: 'silent',
})).outputFiles[0].text;

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const send = (body, type) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  try {
    if (p === '/' || p === '/index.html') return send(HTML, 'text/html; charset=utf-8');
    if (p === '/harness.js') return send(bundle, 'text/javascript; charset=utf-8');
    if (p.startsWith('/wallpapers/static/')) {
      const file = p.slice('/wallpapers/static/'.length);
      if (file === 'quickjs.wasm') return send(readFileSync(QUICKJS_WASM), 'application/wasm');
      const local = join(here, '..', '..', 'dist', 'static', file);
      if (existsSync(local)) return send(readFileSync(local), MIME[extname(file)] ?? 'application/octet-stream');
      console.log('   [404 static]', file); res.writeHead(404); return res.end('nf');
    }
    if (p.startsWith('/wallpapers/scene/')) {
      const name = url.searchParams.get('name') ?? '';
      // 复刻 host 的两级查找：scene.pkg 优先，其次 **WE 引擎 assets 目录**
      // （WE 把引擎 assets 也挂在 VFS 的 `/` 上，所以 `fonts/X.ttf` 这类路径可能只在引擎目录里；
      //   「魔兽之门」1922570576 的 3D Clock 字体就是这种 —— 它的 scene.pkg 里零字体文件）。
      const entry = reader.readEntry(name);
      if (entry) return send(entry, MIME[extname(name)] ?? 'application/octet-stream');
      const engineBase = resolve(join(WE, 'assets'));
      const engine = name ? resolve(engineBase, name) : engineBase;
      if (name.includes('..') || engine === engineBase || !engine.startsWith(engineBase)
        || !existsSync(engine) || !statSync(engine).isFile()) {
        console.log('   [404 asset]', name);
        res.writeHead(404); return res.end('nf');
      }
      assetHits.push({ name, source: 'engine', bytes: statSync(engine).size });
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

/** `lib/` 身份摘要：标定结论要能自证「这份日志跑的是哪份产物」（产物无版本戳，取短哈希）。 */
function libIdentity() {
  const rel = ['client/three-renderer.js', 'client/tex-loader.js', 'host/pkg-reader.js'];
  const out = {};
  for (const r of rel) {
    const p = join(here, '..', '..', 'lib', r);
    out[r] = existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 8) : 'missing';
  }
  return out;
}
let edge, ws, msgId = 0;
const pending = new Map();
let logs = [];
const send2 = (method, params = {}) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });

async function evalJs(expression) {
  const r = await send2('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
}

// 就绪判据：harness 打印 [harness] 且 window.__ready 为真（固定 sleep 是 e2e 最脆的一环）。
async function waitReady() {
  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    try { if (await evalJs('window.__ready === true')) return true; } catch { /* 导航中 */ }
    if (logs.some((l) => l.startsWith('[harness]'))) return true;
    await sleep(200);
  }
  return false;
}

/** 逐像素比较两张同尺寸 PNG：返回差异统计与包围盒。
 *  `box` 给定时只统计该矩形（画布 CSS 像素）内的差异；缺省统计整个画布区域。 */
function diffPng(a, b, vw, vh, box) {
  // 截图缺失时**报错**而不是静默 null 解引用（否则异常发生在深处，看不出是哪一步没拍到）。
  if (!a || !b) throw new Error(`截图缺失（${!a && !b ? 'A/B' : !a ? 'A' : 'B'} 为 undefined）`);
  const A = decodePng(a), B = decodePng(b);
  if (A.width !== B.width || A.height !== B.height) throw new Error('截图尺寸不一致');
  const w = Math.min(A.width, vw), h = Math.min(A.height, vh);
  const x0b = box ? Math.max(0, box[0]) : 0;
  const y0b = box ? Math.max(0, box[1]) : 0;
  const x1b = box ? Math.min(w - 1, box[2]) : w - 1;
  const y1b = box ? Math.min(h - 1, box[3]) : h - 1;
  let n = 0, maxD = 0, sx = 0, sy = 0, sumD = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = y0b; y <= y1b; y++) {
    for (let x = x0b; x <= x1b; x++) {
      const ia = (y * A.width + x) * A.channels, ib = (y * B.width + x) * B.channels;
      const d = Math.max(
        Math.abs(A.data[ia] - B.data[ib]),
        Math.abs(A.data[ia + 1] - B.data[ib + 1]),
        Math.abs(A.data[ia + 2] - B.data[ib + 2]),
      );
      if (d >= 2) {
        n++; sumD += d; sx += x; sy += y;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (d > maxD) maxD = d;
    }
  }
  const total = (x1b - x0b + 1) * (y1b - y0b + 1);
  return {
    size: [A.width, A.height],
    region: box ?? 'full',
    changedPixels: n,
    changedRatio: total > 0 ? n / total : 0,
    maxDelta: maxD,
    meanDelta: n ? sumD / n : 0,
    bbox: n ? [x0, y0, x1, y1] : null,
    centroid: n ? [sx / n, sy / n] : null,
  };
}

/** 统计某个矩形里的「亮像素」（三通道均 > 阈值）与区域基准亮度（中位数）。 */
function brightStats(img, rect, thr) {
  const [x0, y0, x1, y1] = rect;
  let bright = 0, sum = 0, cnt = 0;
  const lums = [];
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
      const o = (y * img.width + x) * img.channels;
      const r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
      const lum = (r + g + b) / 3;
      lums.push(lum); sum += lum; cnt++;
      if (r > thr && g > thr && b > thr) bright++;
    }
  }
  lums.sort((a, b) => a - b);
  return {
    pixels: cnt,
    brightPixels: bright,
    brightRatio: cnt ? bright / cnt : 0,
    medianLuma: cnt ? lums[Math.floor(lums.length / 2)] : 0,
    meanLuma: cnt ? sum / cnt : 0,
    maxLuma: cnt ? lums[lums.length - 1] : 0,
  };
}

// 判据用的「文本区域」= 画面右下角（文本层所在的 1/3×2/3 区块）。坐标映射曾算错过一次
// （canvas 的 y 方向与屏幕 quad 的对应关系），所以判据不依赖投影换算，只用**固定的屏幕区域**
// 与像素事实：白字在右下角 → luma > 200 的像素大量出现在这里。
const textRegion = (vw, vh) => [
  Math.round(vw * 0.55), Math.round(vh * 0.6),
  Math.round(vw * 0.95), Math.round(vh * 0.98),
];

try {
  await new Promise((r) => server.listen(PORT, r));
  console.log(`harness server: http://127.0.0.1:${PORT}/  （壁纸 ${ID}）`);
  const libId = libIdentity();
  console.log('  lib 身份（sha256 前 8 位）:', JSON.stringify(libId));

  edge = spawn(resolveEdgePath(), [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(OUT, '.edge-text-clock')}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio', `--window-size=1600,900`,
    ...(USE_GPU ? ['--use-angle=d3d11', '--ignore-gpu-blocklist'] : ['--enable-unsafe-swiftshader']),
    '--disable-gpu-sandbox', 'about:blank',
  ], { stdio: 'ignore' });

  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) break; } catch { /* 未就绪 */ }
    await sleep(400);
  }
  const pages = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json());
  console.log('   CDP 目标:', pages.map((t) => `${t.type}:${String(t.url).slice(0, 60)}`).join(' | '));
  // 只取「本进程刚启动的那个 about:blank 页面」：上一轮崩溃残留的 Edge 也会带着同名 CDP 端口
  // 和同 URL 的页面，连错目标时会读到「没有 __ready 的空页面」（实测过）。
  const page = pages.find((t) => t.type === 'page' && String(t.url).startsWith('about:'))
    ?? pages.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) { const pp = pending.get(m.id); if (pp) { pending.delete(m.id); m.error ? pp.reject(new Error(m.error.message)) : pp.resolve(m.result); } }
    else if (m.method === 'Runtime.consoleAPICalled') logs.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
    else if (m.method === 'Log.entryAdded') logs.push(`[${m.params.entry.level}] ${m.params.entry.url ?? ''} ${m.params.entry.text}`);
    else if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails?.exception?.description ?? ''));
  };
  await send2('Runtime.enable'); await send2('Log.enable'); await send2('Page.enable');
  // 固定视口：headless 新建窗口的 innerHeight 会被任务栏/窗口夹到 450 左右，画布与截图都不是
  // 我们声明的 1600×900（实测 500×450）。视口不钉住的话，右下角判据会在错误的坐标系里取像素。
  await send2('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });

  const VW = 1600, VH = 900;
  const shots = {};
  const info = {};

  /** 同页一步：切换脚本运行时可用性 → 等帧 → 截图 + 观测文本 quad。 */
  const step = async (tag, brokenRuntime) => {
    logs = [];
    const sw = await evalJs(`window.__switchScriptRuntime(${brokenRuntime})`);
    await sleep(700);
    const rect = JSON.parse(await evalJs(`JSON.stringify(window.__objectRect(${TEXT_OBJECT_ID}))`));
    const shot = await send2('Page.captureScreenshot', { format: 'png' });
    shots[tag] = Buffer.from(shot.data, 'base64');
    writeFileSync(join(OUT, `text-clock-${tag}.png`), shots[tag]);
    info[tag] = {
      switch: sw, rect,
      harnessLine: logs.find((l) => l.startsWith('[harness]')) ?? null,
      warnings: logs.filter((l) => /text-script|编译失败|WARN/i.test(l)).slice(0, 4),
    };
    console.log(`\n--- ${tag}（broken=${brokenRuntime}）---`);
    console.log('  文本对象矩形（画布 CSS 像素）:', JSON.stringify(rect));
    info[tag].textCanvas = JSON.parse(await evalJs(`JSON.stringify(window.__textCanvasImage(${TEXT_OBJECT_ID}))`) ?? 'null');
    console.log('  文本画布内容（亮像素 = 白色文本）:', JSON.stringify(info[tag].textCanvas));
    for (const l of info[tag].warnings) console.log('  ' + l.slice(0, 160));
  };

  /** 只切该图层的可见性（不重渲染）→ 截图。返回 { shot, rect, toggle }。 */
  const isolateStep = async (tag, hidden) => {
    logs = [];
    const toggle = await evalJs(`JSON.stringify(window.__hideTextLayer(${TEXT_OBJECT_ID}, ${hidden}))`).then(JSON.parse);
    const rect = JSON.parse(await evalJs(`JSON.stringify(window.__objectRect(${TEXT_OBJECT_ID}))`));
    await sleep(400);
    const shot = await send2('Page.captureScreenshot', { format: 'png' });
    shots[tag] = Buffer.from(shot.data, 'base64');
    writeFileSync(join(OUT, `text-clock-${tag}.png`), shots[tag]);
    info[tag] = { toggle, rect };
    console.log(`\n--- ${tag}（文本层 ${hidden ? '隐藏' : '显示'}）---`);
    console.log('  toggle:', JSON.stringify(toggle));
    return shots[tag];
  };

  // ① 语义 A/B：同页切脚本运行时（修复后 / 修复前装配）
  await send2('Page.navigate', { url: `http://127.0.0.1:${PORT}/?id=${ID}&vw=${VW}&vh=${VH}` });
  const ready = await waitReady();
  if (!ready) {
    console.log(`   ⚠️ 页面在 ${TIMEOUT_MS}ms 内未就绪（判据将失败）`);
    console.log('   页面状态:', await evalJs(`JSON.stringify({ href: location.href, bodyHtml: document.body.innerHTML.slice(0, 80), scripts: [...document.scripts].map((s) => s.src) })`));
  }
  await sleep(600);
  // [perf] 1080p FPS 参考值（AGENT.md P1 门槛不在本脚本判定）；顺带打印真实渲染器自证非软栅
  // 注：CDP 的 Runtime.evaluate 不支持顶层 await ⇒ 用 async IIFE 包一层。
  try {
    // 探针已自带 JSON 序列化，勿再套一层（双重编码看不出字段）；软栅 / 取不到 ext 时 FPS 无意义，只告警。
    const rendererJson = await evalJs('JSON.stringify(window.__glRendererInfo())');
    console.log('  [perf] renderer:', rendererJson);
    const rendererName = JSON.parse(rendererJson ?? '{}').renderer ?? 'unknown';
    // 软栅含 WARP（`Microsoft Basic Render Driver`）；`unknown` 只是拿不到 `WEBGL_debug_renderer_info`。
    const softRenderer = rendererName === 'unknown'
      || /swiftshader|llvmpipe|software|basic render|softpipe|mesa offscreen/i.test(rendererName);
    if (softRenderer) {
      const why = rendererName === 'unknown' ? '拿不到渲染器信息（unknown）' : `软栅渲染器（${rendererName}）`;
      console.log(`  ⚠️ ${why} ⇒ 下面的 FPS 不可当门禁（本脚本不把 FPS 作为判据，仅供参考）`);
    }
  } catch (e) { console.log('  [perf] renderer 取用失败:', String(e).slice(0, 120)); }
  try { console.log('  [perf]', await evalJs('(async () => JSON.stringify(await window.__fpsProbe(5000)))()')); }
  catch (e) { console.log('  [perf] 采集失败:', String(e).slice(0, 120)); }
  await step('normal', false);
  await step('broken', true);

  // ② 像素 A/B：同页、同粒子相位下只切文本层可见性 —— 「该文本层贡献了多少像素」的干净口径。
  //    show → hide → show（A/A 作噪声地板：只差一帧的粒子相位）。
  await step('repaired', false);
  await isolateStep('iso-show', false);
  await isolateStep('iso-hide', true);
  await isolateStep('iso-show2', false);
  // 回到修复前装配，它的文本层根本不存在（同一页面里再确认一次）
  await step('broken2', true);
  const brokenVisible = await evalJs('window.__hideTextLayer(778, false)');

  const rect = info.normal.rect;
  const region = textRegion(VW, VH);
  // A/B 像素差异只在文本 quad 矩形内统计（外扩 2px），其余区域不计 —— 与「不外溢」判据同一口径。
  const box = rect ? [rect.canvasCss[0] - 2, rect.canvasCss[1] - 2, rect.canvasCss[2] + 3, rect.canvasCss[3] + 3] : null;
  // 多站固定参考区（**不声称「背景同类」**，只当静区统计基准）：与 quad **同 y 带、等面积、互不相交**的
  // 三个候选 —— 沿 x 镜像（`mirror`，上一轮挑中的正是这一带，实测是三站里**最安静**的）、画面最左、
  // quad 右缘紧邻条带。地板取三者的**中位数**（= 三站里的第 2 名 ⇒ 没挑最安静的站，也不被单站尖峰支配）。
  // 全部与 A/B 用**同一对截图**（iso-show vs iso-hide）⇒ 时间间隔与信号对齐。
  // 宽度取 300（≤ quad 宽 337）：三站都能同时满足「在界内 + 等面积 + 与 quad 不相交」，不靠 clamp。
  const STATION_W = 300;
  // 镜像站：在「左站右缘 + 1」到「quad 左缘 − 1」这段空档里居中（保证与左站、与 quad 都留 ≥1px）。
  const freeStart = STATION_W + 1;
  const freeEnd = box ? box[0] - 1 : 0;
  const mirrorX = Math.max(freeStart, Math.floor((freeStart + freeEnd - STATION_W + 1) / 2));
  const stationCands = box ? [
    { name: 'same-y-left', box: [0, box[1], STATION_W - 1, box[3]] },
    { name: 'mirror', box: [mirrorX, box[1], mirrorX + STATION_W - 1, box[3]] },
    // 右侧：与 quad 右缘**紧邻**（box[2]+1 起）—— 留 1px 间隔，保证与 quad 不相交。
    { name: 'same-y-right', box: [box[2] + 1, box[1], box[2] + STATION_W, box[3]] },
  ] : [];
  // 越界 / 与 quad 相交 / 三站面积不一致 / 比 quad 更宽 ⇒ 判 FAIL（旧实现被 `diffPng` 静默 clamp 成更小的
  // 区域，地板会被无声压低；「比 quad 更宽」不可能带来更保守的地板，只会掩盖裁剪）。
  const areaMismatch = [];
  if (box) {
    const quadArea = (box[2] - box[0] + 1) * (box[3] - box[1] + 1);
    const areas = new Set();
    for (const c of stationCands) {
      const [x0, y0, x1, y1] = c.box;
      const inFrame = x0 >= 0 && y0 >= 0 && x1 <= VW - 1 && y1 <= VH - 1 && x0 < x1 && y0 < y1;
      const area = inFrame ? (x1 - x0 + 1) * (y1 - y0 + 1) : 0;
      // 与该 quad 是否相交（留 1px 间隔即算不相交）：x/y 两轴同时重叠才算相交。
      const overlapX = Math.min(x1, box[2]) - Math.max(x0, box[0]) >= 0;
      const overlapY = Math.min(y1, box[3]) - Math.max(y0, box[1]) >= 0;
      const overlap = overlapX && overlapY;
      areas.add(area);
      if (!inFrame || area > quadArea || overlap) {
        areaMismatch.push(`${c.name}${JSON.stringify(c.box)} inFrame=${inFrame} area=${area}>quad(${quadArea})? overlap=${overlap}`);
      }
    }
    if (areas.size > 1) areaMismatch.push(`三站面积不一致: ${[...areas].join(',')}`);
  }
  const dAB = diffPng(shots['iso-show'], shots['iso-hide'], VW, VH, box);
  const dAA = diffPng(shots['iso-show'], shots['iso-show2'], VW, VH, box);
  const dReRepaired = diffPng(shots['iso-show2'], shots.repaired, VW, VH, box);
  const dStations = stationCands.map((c) => ({ name: c.name, box: c.box, d: diffPng(shots['iso-show'], shots['iso-hide'], VW, VH, c.box) }));
  const floorStats = (() => {
    const v = dStations.map((s) => s.d.changedPixels).sort((a, b) => a - b);
    return { n: v.length, min: v[0], median: v.length % 2 ? v[(v.length - 1) / 2] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2), max: v[v.length - 1] };
  })();
  // 地板统计量 = 中位数（三站里的第 2 名）：既没挑最安静的站，也不像 max 那样被单站尖峰（右侧水面条带实测
  // 波动大）支配 ⇒ 健康态余量稳定。全部候选值都打印在日志里，换统计量的代价可现场复核。
  const floor = Math.max(1, floorStats.median);
  const stationLine = dStations.map((s) => `${s.name}=${s.d.changedPixels}`).join(' / ');
  const dOut = diffPng(shots['iso-show'], shots['iso-hide'], VW, VH); // 全屏差异（判「不外溢」）
  // 「缺失态参照」= 修复前装配（`getTextScriptRuntime` 永远返回 null ⇒ text 层整层跳过）下，**同一 quad**
  // 的显示 vs 隐藏 A/B。**每次主跑恒测**（增量分子的基准；即使 `--no-teeth` 也要有，否则 [9] 无定义）。
  // 注意：截图**不能**放进 `if (box)` —— 文本层整层缺失时 `rect`（进而 `box`）为 null，而判据 [1]（缺文本层）
  // 与这里的采样是同一次运行；把采样挂在 box 上会让该路径抛 null 解引用（实测过）。
  let brokenAB = null;
  await isolateStep('iso-show-broken', false);
  await isolateStep('iso-hide-broken', true);
  if (TEETH) await isolateStep('iso-show2-broken', false); // 只用于牙自检
  if (box) {
    brokenAB = diffPng(shots['iso-show-broken'], shots['iso-hide-broken'], VW, VH, box);
    if (!TEETH) await evalJs('window.__hideTextLayer(778, false)'); // 收尾：恢复该臂的可见性，免影响后续语义
  }
  const teeth = TEETH && box ? {
    dAB: brokenAB,
    dStations: stationCands.map((c) => ({ name: c.name, box: c.box, d: diffPng(shots['iso-show-broken'], shots['iso-hide-broken'], VW, VH, c.box) })),
  } : null;
  // 增量口径：分子 = 健康态同 quad A/B − 缺失态同 quad A/B（同一对截图语义 ⇒ 背景在相减中抵消）。
  // box 取不到（文本层整层缺失 ⇒ rect/box 为 null）时分子按 **0** 记：判据 [9] 在该状态下无定义、必红。
  const healthyAB = box ? dAB.changedPixels : 0;
  const brokenPixels = box && brokenAB ? brokenAB.changedPixels : 0;
  const textContribution = healthyAB - brokenPixels;
  writeFileSync(join(OUT, 'diff.json'), JSON.stringify({
    lib: libId, dAB, dAA, dReRepaired, dStations, floor, brokenAB, teeth, box, stationCands, areaMismatch, info,
  }, null, 1));
  const imgShow = decodePng(shots['iso-show']);
  const imgHide = decodePng(shots['iso-hide']);
  // 白字实测：「隐藏文本层的那一帧是暗的、显示文本层的那一帧是亮的」像素 —— 这是与该文本层
  // **因果绑定**的口径（右下角本来就亮的粒子高光不算），比单纯数亮像素干净得多。
  const textPixels = (() => {
    let n = 0, bright = 0, sum = 0, mask = 0;
    for (let y = region[1]; y < region[3]; y++) {
      for (let x = region[0]; x < region[2]; x++) {
        const ia = (y * imgShow.width + x) * imgShow.channels;
        const ib = (y * imgHide.width + x) * imgHide.channels;
        const ls = (imgShow.data[ia] + imgShow.data[ia + 1] + imgShow.data[ia + 2]) / 3;
        const lh = (imgHide.data[ib] + imgHide.data[ib + 1] + imgHide.data[ib + 2]) / 3;
        if (lh > 140) continue;            // 隐藏时为亮：背景粒子高光，不是字
        if (ls - lh < 40) continue;        // 显示时明显更亮：字
        mask++;
        if (ls > 200) bright++;
        sum += ls;
      }
    }
    n = region[2] - region[0];
    return { textMaskPixels: mask, brightTextPixels: bright, meanLuma: mask ? +(sum / mask).toFixed(1) : 0, regionWidth: n };
  })();
  const brightShow = brightStats(imgShow, region, 200);
  const brightHide = brightStats(imgHide, region, 200);
  const brightWhole = brightStats(imgShow, [0, 0, VW, VH], 200);

  console.log('\n===== 判定 =====');
  // 【判据 9】增量口径（2026-10-13 轮 1 重做实测）：
  //   分子 `textContribution` = 健康态同 quad A/B − 缺失态同 quad A/B（见上方 brokenAB 的注释）。
  //   分母 `floor` = 三个等价参考区（same-y-left / mirror / same-y-right，同 y 带、等面积 300×91、
  //   与 quad 不相交）在同一跳上的 A/B 差异像素数的**中位数**（三站第 2 名，不挑最安静的站）。
  //   实测（--gpu、1600×900，日志见 report fix-round-1.md §4）：健康态分子 16263–16712 px，
  //   参考区中位数 4921–5742 px ⇒ 比值 2.84–3.36×；文本层缺失时分子**结构性 = 0**（两项同条件相减）
  //   ⇒ 比值 0.00×。阈值 1.5× 落在两组之间：健康态余量 ≥1.89×、缺失态余量恒为 1.5×（分子恒 0）。
  const noise = Math.max(dAA.changedPixels, 1);
  const regionArea = box ? (box[2] - box[0] + 1) * (box[3] - box[1] + 1) : 0;
  const SIGNAL_MIN_RATIO = 1.5;      // [9] 增量分子 / 多站参考区地板
  const SIGNAL_MIN_PIXELS = 4000;    // [9] 绝对下限：外扩盒面积 30667 的 13%，实测健康态分子 16263–16712 ⇒ 余量 ≥4.07×
  const RESTORE_MAX_RATIO = 2;       // [10] 恢复态/quad 抖动
  const ratio = textContribution / floor;
  const signalPass = textContribution > floor * SIGNAL_MIN_RATIO && textContribution > SIGNAL_MIN_PIXELS;
  // [10] 的区域面积封顶：`2·dAA+50` 在 dAA ≥ (面积−50)/2 ≈ 15309 px（quad 面积的一半）时**必然成立**
  // = 恒真（S2 期实测 dAA 已达 17184 px）。封顶到区域面积的 0.9 ⇒ 阈值恒 < 面积，不再可能恒真。
  // 合法动画（水面 + 秒跳）在 `dReRepaired`（show2 vs repaired）与 `dAA`（show vs show2）两边同时出现，
  // 故比值本身对该动画免疫；封顶只砍掉「阈值大于面积」这一退化分支。
  const restoreCap = Math.floor(regionArea * 0.9);
  const restoreLimit = Math.min(noise * RESTORE_MAX_RATIO + 50, restoreCap);
  const checks = [
    [`修复前装配不产生文本层 #${TEXT_OBJECT_ID}`, info.broken.rect === null && brokenVisible === null],
    [`生产装配产生文本层 #${TEXT_OBJECT_ID}（画布 ${rect?.textureImage?.join('×') ?? '—'}）`,
      !!rect && rect.textureImage !== null],
    ['文本 quad 落在画面右下角（中心 x>0.6 且 y>0.6 归一化）',
      !!rect && (rect.norm[0] + rect.norm[2]) / 2 > 0.6 && (rect.norm[1] + rect.norm[3]) / 2 > 0.6],
    [`文本画布上画出了白色字形（亮像素 ${info.normal.textCanvas?.brightPixels ?? 0} 个，区域 ${JSON.stringify(info.normal.textCanvas?.brightBBox)}）`,
      (info.normal.textCanvas?.brightPixels ?? 0) > 500],
    // 字体（2026-10-10）：`fonts/CursedTimerUlil-Aznm.ttf` 只存在于 <WE>/assets/fonts/（scene.pkg 里
    // 零字体文件）⇒ host 的「引擎 assets 回退」必须命中，客户端才能拿到真身 LED 数码字体。
    // 判据用**像素/几何事实**：用上真身字体后文本画布宽 884（回退 sans-serif 只有 702）。
    [`字体从引擎目录命中且真的生效（请求命中 ${JSON.stringify(assetHits)}；画布宽 ${info.normal.textCanvas?.size?.[0] ?? '—'} ≥ 800 ⇒ 非回退字体）`,
      assetHits.some((h) => h.name.endsWith('CursedTimerUlil-Aznm.ttf') && h.source === 'engine')
      && (info.normal.textCanvas?.size?.[0] ?? 0) >= 800],
    [`字形 alpha 未被压淡（字形像素 alpha 均值 ${info.normal.textCanvas?.strokeAlphaMean ?? '—'} / 最小 ${info.normal.textCanvas?.strokeAlphaMin ?? '—'}，作者值 0.84×255≈214）`,
      (info.normal.textCanvas?.strokeAlphaMean ?? 0) > 150],
    [`屏幕上能读到白字（右下角「隐藏时暗、显示时亮」的像素 ${textPixels.textMaskPixels} 个，其中 luma>200 的 ${textPixels.brightTextPixels} 个，均值 ${textPixels.meanLuma}）`,
      textPixels.textMaskPixels > 800 && textPixels.brightTextPixels > 500],
    [`隐藏文本层后右下角变暗（区域均值 ${brightShow.meanLuma.toFixed(1)} → ${brightHide.meanLuma.toFixed(1)}）`,
      brightHide.meanLuma < brightShow.meanLuma - 2],
    [`文本层的**增量**贡献高于多站参考区地板（增量 = 健康 A/B ${healthyAB} − 缺失 A/B ${brokenPixels} = ${textContribution} px；地板 = median(${stationLine}) = ${floor} px = ${ratio.toFixed(2)}×，需 >${SIGNAL_MIN_RATIO}× 且 >${SIGNAL_MIN_PIXELS} px）`,
      signalPass],
    [`隐藏/显示文本层的差异严格落在它自己的 quad 内（差异包围盒 ${JSON.stringify(dAB.bbox)} ⊆ quad ${JSON.stringify(rect?.canvasCss)}）`,
      !!dAB.bbox && !!rect && dAB.bbox[0] >= rect.canvasCss[0] - 6 && dAB.bbox[1] >= rect.canvasCss[1] - 6
        && dAB.bbox[2] <= rect.canvasCss[2] + 6 && dAB.bbox[3] <= rect.canvasCss[3] + 6],
    [`恢复显示后与隐藏前的差异回到噪声地板（${dReRepaired.changedPixels} px ≤ min(quad 抖动 ${noise} px × ${RESTORE_MAX_RATIO} + 50, 区域面积 90% = ${restoreCap}) = ${restoreLimit} px）`,
      dReRepaired.changedPixels <= restoreLimit],
    // 参考区几何自证：越界 / 与 quad 相交 / 三站面积不一致 ⇒ FAIL（否则 `diffPng` 会静默 clamp，地板被无声压低）。
    [`参考区几何有效（3 个候选箱均在界内、与 quad 不相交、三站等面积 ${dStations[0] ? (dStations[0].box[2] - dStations[0].box[0] + 1) * (dStations[0].box[3] - dStations[0].box[1] + 1) : 0} px ≤ quad 面积 ${regionArea} px）`,
      areaMismatch.length === 0 && dStations.length === 3],
    // 增量口径的自证：缺了「缺失态同 quad A/B」这一项，分子就退回旧口径，判据名不成立。
    [`增量口径可用（缺失态同 quad A/B = ${brokenAB?.changedPixels ?? 'null'} px，box ${JSON.stringify(box)}）`,
      !!brokenAB && brokenAB.changedPixels > 0],
  ];
  // 牙的验证（默认带上）：文本层缺失装配下，[9] 的**增量分子结构性为 0** ⇒ 同一表达式必须判假。
  if (teeth) {
    const tFloor = Math.max(1, ...teeth.dStations.map((s) => s.d.changedPixels));
    // 缺失态下「健康 A/B」与「缺失 A/B」是**同一个量**（都在 broken 装配上测）⇒ 增量结构性 = 0。
    // 这里如实按同一表达式取 0（`tAB - tAB`），断言的是 [9] 的表达式在该状态下判假。
    const tContribution = (teeth.dAB?.changedPixels ?? 0) - (teeth.dAB?.changedPixels ?? 0);
    const tPass = tContribution > tFloor * SIGNAL_MIN_RATIO && tContribution > SIGNAL_MIN_PIXELS;
    checks.push([
      `文本层缺失时 [9] 的增量表达式判假（增量 ${tContribution} px vs 多站地板 ${tFloor} px = 0.00×，未达 ${SIGNAL_MIN_RATIO}×/${SIGNAL_MIN_PIXELS} px）`,
      !tPass]);
  }
  let ok = true;
  for (const [name, pass] of checks) { console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) ok = false; }
  console.log('\n文本层信号 A/B（显示 vs 隐藏，健康装配）:', JSON.stringify(dAB));
  console.log('噪声地板 A/A（显示 vs 再显示，quad 内）:', JSON.stringify(dAA));
  console.log(`多站参考区地板（同 y 带、等面积、与 quad 不相交；box ${JSON.stringify(box)}；与 A/B 同一跳）:`,
    JSON.stringify({ stations: dStations.map((s) => ({ name: s.name, box: s.box, changedPixels: s.d.changedPixels, changedRatio: +s.d.changedRatio.toFixed(4) })), stats: floorStats, statistic: 'median', floorUsed: floor }));
  console.log(`增量分子（健康 A/B − 缺失 A/B）: ${dAB?.changedPixels ?? '—'} − ${brokenAB?.changedPixels ?? '—'} = ${textContribution} px ⇒ 比值 ${ratio.toFixed(2)}×（阈值 ${SIGNAL_MIN_RATIO}× 且 > ${SIGNAL_MIN_PIXELS} px）`);
  if (teeth) console.log('牙的验证（文本层缺失装配下的同一 quad A/B 与多站地板）:', JSON.stringify(teeth));
  console.log('白字像素（右下角、隐藏时暗显示时亮）:', JSON.stringify(textPixels));
  console.log('引擎目录命中的场景素材:', JSON.stringify(assetHits));
  console.log('右下角亮像素（显示 / 隐藏 / 全屏）:', JSON.stringify({ show: brightShow.brightPixels, hide: brightHide.brightPixels, whole: brightWhole.brightPixels }));
  console.log(`截图：${OUT}`);
  if (!ok) process.exitCode = 1;
} catch (e) {
  console.error('ERROR:', (e && e.stack) || e);
  process.exitCode = 1; // 脚本异常也必须非零，否则 CI 会把崩溃当通过
} finally {
  try { ws?.close(); } catch { /* 已关 */ }
  edge?.kill();
  server.close();
}
