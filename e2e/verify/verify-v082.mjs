// v0.8.2「可见修复包」的端到端像素判据（F2 util 后处理 / pulse、F12 text brightness、F18 指针 uniform）。
//
// 目的：在**真实 WebGL**（headless Edge，SwiftShader 软件光栅化）下走生产装配入口
// `createThreeSceneRenderer().render(id, canvas)`（lib 编译产物 + 真实 scene.pkg 素材），做像素级 A/B。
// 对照档只改「服务给页面的 scene.json 字节」或冻结时钟/指针，**壁纸目录只读**。
//
// 四组判据（阈值均可用 --<name>=<数值> / 环境变量覆盖；数值非有限值直接 throw，防判据静默退化成 0）：
//   ① 2911105183 util 后处理：清空 projectlayer(58) 的 effects（bloom+bokeh）→ 整屏平均通道差
//      与变化像素占比（T3 实测 bloom Δ12.01、bokeh Δ2.93；阈值取保守的 meanAbs≥3 且 changed≥5%）。
//   ② 2132420420 pulse：冻结时钟相位 5s vs 0s（同页、只改 g_Time）→ 平均差与变化像素占比
//      （T3 实测 1.07 / 5.38%；阈值 meanAbs≥0.5 且 changed≥2%，该 pulse 是局部弱信号，不按整屏均值定死）。
//   ③ 3765967112 text brightness：服务端把 text 的 brightness 强制 1（= 修复前忽略该字段的观感）
//      → 文字区域变化像素数 ≥200 且 maxΔ ≥8（T4 实测 1600×900 下 963px / maxΔ20）。
//   ④ 3780477933 指针 uniform：asis 原样（作者常量把点阵关成 no-op）指针 A/B 像素差 ≈0（<0.1%）；
//      defaults 变体（服务端恢复 shader 默认圆点尺寸 + util/white opacitymask）指针 A/B 变化 ≥2%，
//      且差异分成双簇、质心分别落在两个指针位置附近（bbox/centroid 断言，含 y 向下方向）。
//
// 硬门禁：任一档的 effect pass 编译失败（warn 文案 / `window.__fxShaderErrors`）⇒ 整轮 FAIL；
// ① 还断言全屏 bbox 覆盖视口、目标 util 对象链就绪；③ 断言 diff bbox 落在已知文字区。
// `--only` 必须来自白名单，且运行后所有期望判据都要**出现且 pass**（默认四组缺一即 FAIL）。
//
// 每个对照档独立 Edge 进程（模块态/GL 上下文不跨档污染）；生产卡片与帧序不变。
//
// 用法：node e2e/verify/verify-v082.mjs [--only=util,pulse,text,pointer] [--vw=1280] [--vh=720]
//        [--tag=v082] [--port=9852] [--cdp-port=9262] + 各判据阈值（见 THRESHOLDS）
// 环境变量等价形式：ONLY / VW / VH / TAG / E2E_PORT / E2E_CDP_PORT / MIN_UTIL_MEAN_ABS / ...
// 另需 WE_WORKSHOP（壁纸目录）与 WE_ASSETS（WE 安装目录），见 e2e/config.mjs。
// 退出码：0 = 四组判据全 PASS；1 = 有 FAIL、判据缺失或脚本异常（CI 门禁）。
//
// 产物：e2e/.out/v082/summary.json（含每判据实测数值与阈值）+ 各档 PNG / diff 图。
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import * as esbuild from 'esbuild';
import { decodePng, meanAbsDiff } from '../lib/hidpi-metrics.mjs';
import { OUT_DIR, WE_WORKSHOP, WE_ASSETS as WE_ASSETS_ROOT, resolveEdgePath, httpPort, cdpPort as resolveCdpPort } from '../config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const OUT = join(OUT_DIR, 'v082');
mkdirSync(OUT, { recursive: true });

// ── 参数 ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq < 0 ? true : hit.slice(eq + 1);
};
// 数值参数统一经此解析：空串 / NaN / Infinity（含裸 `--flag`）直接 throw，避免判据静默退化。
function numArg(name, envName, dflt) {
  const raw = argOf(name, process.env[envName] ?? dflt);
  const n = Number(raw);
  if (typeof raw === 'boolean' || String(raw).trim() === '' || !Number.isFinite(n)) {
    throw new Error(`数值参数非法：--${name} / ${envName} = ${JSON.stringify(raw)}（必须是非空有限数值）`);
  }
  return n;
}
const TAG = String(argOf('tag', process.env.TAG ?? 'v082'));
const VIEW = {
  w: Math.max(1, Math.round(numArg('vw', 'VW', 1280))),
  h: Math.max(1, Math.round(numArg('vh', 'VH', 720))),
};
// text brightness 判据用 1600×900（T4 标定口径；1280×720 下文字像素更少）。
const TEXT_VIEW = {
  w: Math.max(1, Math.round(numArg('text-vw', 'TEXT_VW', 1600))),
  h: Math.max(1, Math.round(numArg('text-vh', 'TEXT_VH', 900))),
};
// 显存/时钟：冻结在 5000ms（相位判据另用 0ms）。
const PHASE_MS = 5000;
const PHASE_A_MS = Math.round(numArg('pulse-phase-a', 'PULSE_PHASE_A', 0));
const PHASE_B_MS = Math.round(numArg('pulse-phase-b', 'PULSE_PHASE_B', 5000));

// 判据白名单：`--only` 只接受这些键（`all` = 全跑）；未知/空 ⇒ 主流程 throw（summary 仍写 pass:false）。
const CRITERIA_ORDER = ['util', 'pulse', 'text', 'pointer'];
const CRITERIA_NAME = {
  util: '2911105183-util-postprocess',
  pulse: '2132420420-pulse',
  text: '3765967112-text-brightness',
  pointer: '3780477933-pointer-uniform',
};
const ONLY = String(argOf('only', process.env.ONLY ?? CRITERIA_ORDER.join(',')))
  .split(',').map((s) => s.trim()).filter(Boolean);
const unknownOnly = ONLY.filter((k) => k !== 'all' && !CRITERIA_ORDER.includes(k));
const onlyInvalid = ONLY.length === 0
  ? `--only / ONLY 不能为空（可选：${[...CRITERIA_ORDER, 'all'].join(',')}）`
  : unknownOnly.length > 0
    ? `未知判据：${unknownOnly.join(',')}（可选：${[...CRITERIA_ORDER, 'all'].join(',')}）`
    : null;
const expectedKeys = ONLY.includes('all') ? [...CRITERIA_ORDER] : CRITERIA_ORDER.filter((k) => ONLY.includes(k));
const want = (name) => ONLY.includes(name) || ONLY.includes('all');

// ── 判据阈值（实现时用真实素材标定，见 task-3/4/6a 报告）──────────────────────────
const THRESHOLDS = {
  // ① util 后处理（2911105183，projectlayer bloom+bokeh）：T3 bloom-only meanAbs=12.011 / changed=47.15%，
  //    bokeh-only 2.929 / 48.05%；两者同开只会更大。取保守阈值（约 1/4 实测均值、1/9 变化占比）。
  utilMeanAbs: numArg('min-util-mean-abs', 'MIN_UTIL_MEAN_ABS', 3),
  utilChanged: numArg('min-util-changed-ratio', 'MIN_UTIL_CHANGED_RATIO', 0.05),
  // ① 全屏覆盖：diff bbox 每边到视口边缘的未变化余量（px）。全屏后处理 ⇒ bbox 应贴满整屏。
  utilBboxTol: Math.round(numArg('util-bbox-tol', 'UTIL_BBOX_TOL', 2)),
  // ② pulse（2132420420，冻结相位 5s vs 0s）：T3 实测 meanAbs=1.068 / changed=5.38%。
  pulseMeanAbs: numArg('min-pulse-mean-abs', 'MIN_PULSE_MEAN_ABS', 0.5),
  pulseChanged: numArg('min-pulse-changed-ratio', 'MIN_PULSE_CHANGED_RATIO', 0.02),
  // ③ text brightness（3765967112，全部 text brightness→1）：T4 实测 changed=963px / maxΔ=20。
  textChangedPx: Math.round(numArg('min-text-changed-px', 'MIN_TEXT_CHANGED_PX', 200)),
  textMaxDelta: numArg('min-text-max-delta', 'MIN_TEXT_MAX_DELTA', 8),
  // ③ diff bbox 必须落在已知文字区（1600×900 下 [728,305,841,368]，T4 为 [721,305,847,367]）±容差。
  textBboxTol: Math.round(numArg('text-bbox-tol', 'TEXT_BBOX_TOL', 16)),
  // ④ 指针 uniform（3780477933）：asis 必须≈0；defaults T6a 实测 changed=4.65%。
  pointerAsisMax: numArg('max-pointer-asis-changed', 'MAX_POINTER_ASIS_CHANGED', 0.001),
  pointerDefaultsMin: numArg('min-pointer-defaults-changed', 'MIN_POINTER_DEFAULTS_CHANGED', 0.02),
  // 双簇质心到对应指针的屏幕像素距离上限（实测 4.3/5.8px；留 ~20× 裕度仍能钉住「跟随指针」）。
  pointerClusterRadiusPx: numArg('pointer-cluster-radius', 'POINTER_CLUSTER_RADIUS', 120),
};

const ID_UTIL = String(argOf('util-id', process.env.UTIL_ID ?? '2911105183'));
const ID_PULSE = String(argOf('pulse-id', process.env.PULSE_ID ?? '2132420420'));
const ID_TEXT = String(argOf('text-id', process.env.TEXT_ID ?? '3765967112'));
const ID_POINTER = String(argOf('pointer-id', process.env.POINTER_ID ?? '3780477933'));
// ③ 已知文字区（1600×900 基准）；其它 TEXT_VIEW 按比例缩放后再加容差。
const TEXT_BBOX_BASE_VIEW = [1600, 900];
const TEXT_BBOX_BASE = [728, 305, 841, 368];
const POINTER_A = [0.2, 0.2];
const POINTER_B = [0.8, 0.8];

const PORT = httpPort(9852);
const CDP_PORT = resolveCdpPort(9262);
const EDGE = resolveEdgePath();
const WE_ASSETS = join(WE_ASSETS_ROOT, 'assets');
const STATIC_DIR = join(repo, 'dist', 'static');

const USE_COLOR = process.stdout.isTTY === true && !process.env.NO_COLOR;
const RED = USE_COLOR ? '\x1b[31m' : '';
const GRN = USE_COLOR ? '\x1b[32m' : '';
const YEL = USE_COLOR ? '\x1b[33m' : '';
const RST = USE_COLOR ? '\x1b[0m' : '';

// ── scene.pkg 读取（与 verify-v081 / verify-hidpi-object-rt 同实现）──────────────
function readPkg(id) {
  const pkgPath = join(WE_WORKSHOP, id, 'scene.pkg');
  if (!existsSync(pkgPath)) throw new Error(`缺少 scene.pkg：${pkgPath}`);
  const buf = readFileSync(pkgPath);
  const entries = [];
  let pos = 16, dataStart = -1;
  while (pos + 8 <= buf.length) {
    const nameLen = buf.readUInt32LE(pos);
    if (nameLen <= 0 || nameLen > 1024) { dataStart = pos; break; }
    const nameStart = pos + 4;
    const name = buf.toString('utf8', nameStart, nameStart + nameLen);
    entries.push({ name, off: buf.readUInt32LE(nameStart + nameLen), size: buf.readUInt32LE(nameStart + nameLen + 4) });
    pos = nameStart + nameLen + 8;
  }
  if (dataStart < 0) throw new Error(`scene.pkg 目录解析失败：${pkgPath}`);
  const files = new Map();
  for (const e of entries) files.set(e.name, buf.subarray(dataStart + e.off, dataStart + e.off + e.size));
  return files;
}
const PKGS = new Map();
function pkgOf(id) {
  if (!PKGS.has(id)) PKGS.set(id, readPkg(id));
  return PKGS.get(id);
}
function sceneTextOf(id) {
  const raw = pkgOf(id).get('scene.json');
  if (!raw) throw new Error(`${id} 的 scene.pkg 内缺 scene.json`);
  return Buffer.from(raw).toString('utf8');
}

// ── 对照档：只改**服务给页面的 scene.json 字节**（壁纸目录只读）────────────────────
/** ① 2911105183：清空 projectlayer 的 effects（= 修复前的 util 后处理关闭档）。 */
function patchStripProjectEffects(id) {
  const sc = JSON.parse(sceneTextOf(id));
  const patched = [];
  for (const o of sc.objects ?? []) {
    if (!String(o.image ?? '').includes('projectlayer')) continue;
    patched.push({ object: o.id, from: (o.effects ?? []).map((f) => f.file ?? f.id) });
    o.effects = [];
  }
  if (patched.length === 0) throw new Error(`${id} 的 scene.json 里找不到 projectlayer 对象`);
  return { text: JSON.stringify(sc), patched };
}
/** ③ 3765967112：把全部 text 对象的 brightness 强制为 1（= 修复前忽略该字段的观感）。 */
function patchTextBrightnessOne(id) {
  const sc = JSON.parse(sceneTextOf(id));
  const patched = [];
  for (const o of sc.objects ?? []) {
    if (!o.text) continue;
    patched.push({ object: o.id, from: o.brightness ?? null });
    o.brightness = 1;
  }
  if (patched.length === 0) throw new Error(`${id} 的 scene.json 里找不到 text 对象`);
  return { text: JSON.stringify(sc), patched };
}
/** ④ 3780477933：把 dot_matrix 效果恢复成 shader/材质默认（默认圆点尺寸 + util/white opacitymask）。 */
function patchDotMatrixDefaults(id) {
  const sc = JSON.parse(sceneTextOf(id));
  const patched = [];
  for (const o of sc.objects ?? []) {
    for (const fx of o.effects ?? []) {
      if (!String(fx.file ?? '').includes('dot_matrix')) continue;
      for (const p of fx.passes ?? []) {
        p.constantshadervalues = { ...(p.constantshadervalues ?? {}), 'Default Circle Size': 0.3 };
        p.textures = [null, null, 'util/white'];
        patched.push({ object: o.id, pass: p.id, size: 0.3, mask: 'util/white' });
      }
    }
  }
  if (patched.length === 0) throw new Error(`${id} 的 scene.json 里找不到 dot_matrix 效果`);
  return { text: JSON.stringify(sc), patched };
}

// 服务端全局：非 null ⇒ 下一次 scene.json 请求返回这份改写文本（对照档）；每档渲染前设置。
let sceneOverride = null;

// ── esbuild 打包 harness（只 import lib/client 生产编译产物）────────────────────
const bundle = (await esbuild.build({
  entryPoints: [join(here, '..', 'harness', 'harness-object-effects-entry.mjs')],
  bundle: true, format: 'esm', target: 'es2022', write: false, logLevel: 'silent',
})).outputFiles[0].text;

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#000;overflow:hidden}canvas{display:block}</style>
</head><body><script type="module" src="/harness.js"></script></body></html>`;
const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.tex': 'application/octet-stream', '.png': 'image/png',
  '.frag': 'text/plain', '.vert': 'text/plain', '.ps1': 'application/octet-stream',
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = decodeURIComponent(url.pathname);
  const send = (body, type, status = 200) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  if (p === '/' || p === '/index.html') return send(HTML, 'text/html; charset=utf-8');
  if (p === '/harness.js') return send(bundle, 'text/javascript; charset=utf-8');
  if (p.startsWith('/wallpapers/static/')) {
    const f = join(STATIC_DIR, p.slice('/wallpapers/static/'.length));
    if (!existsSync(f)) return send('nf', 'text/plain', 404);
    return send(readFileSync(f), MIME[extname(f)] ?? 'application/octet-stream');
  }
  if (p === '/wallpapers/particle-texture') {
    const name = url.searchParams.get('name') ?? '';
    const id = url.searchParams.get('id') ?? '';
    if (id) {
      const inPkg = pkgOf(id).get(`materials/${name}.tex`);
      if (inPkg) return send(inPkg, 'application/octet-stream');
    }
    const f = join(WE_ASSETS, 'materials', name + '.tex');
    if (!existsSync(f)) return send('nf', 'text/plain', 404);
    return send(readFileSync(f), 'application/octet-stream');
  }
  const m = /^\/wallpapers\/scene\/([^/]+)\/asset$/.exec(p);
  if (m) {
    const id = m[1];
    const name = url.searchParams.get('name') ?? '';
    if (name === 'scene.json' && sceneOverride !== null) return send(sceneOverride, 'application/json');
    const entry = pkgOf(id).get(name);
    if (!entry) return send('nf', 'text/plain', 404);
    return send(entry, MIME[extname(name)] ?? 'application/octet-stream');
  }
  return send('not found', 'text/plain', 404);
});

// ── CDP / 浏览器 ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 冻结 performance.now（钉住 g_Time 动画相位；初值 0 ⇒ 装配 startedAt=0，之后设 __vnow 即相位）。
const CLOCK_SHIM = `(() => {
  try {
    const orig = performance.now.bind(performance);
    let vnow = 0;
    Object.defineProperty(window, '__vnow', {
      get: () => vnow, set: (v) => { vnow = Number(v) || 0; }, configurable: true,
    });
    performance.now = () => vnow;
    window.__vnowRaw = () => orig();
  } catch (e) { /* 注入失败会体现为相位不稳定 */ }
})();`;
// 冻结 Date（text 的时钟/日期脚本按 Date 重绘；两档必须落在同一日期/分钟）。
const DATE_SHIM = `(() => {
  try {
    const FIXED = Date.UTC(2026, 9, 22, 2, 0, 0); // 2026-10-22T10:00:00+08:00
    const RealDate = Date;
    class FixedDate extends RealDate {
      constructor(...args) { super(...(args.length > 0 ? args : [FIXED])); }
      static now() { return FIXED; }
    }
    window.Date = FixedDate;
  } catch (e) { /* 注入失败会在结果里体现为文字相位漂移 */ }
})();`;
const pngDims = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** 最小 RGB PNG 编码（只用于 diff 差分图）。 */
function encodeRgbPng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
function diffPng(a, b) {
  const w = a.width, h = a.height;
  const out = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const oa = i * a.channels, ob = i * b.channels;
    const d = Math.min(255, 8 * Math.max(
      Math.abs(a.data[oa] - b.data[ob]),
      Math.abs(a.data[oa + 1] - b.data[ob + 1]),
      Math.abs(a.data[oa + 2] - b.data[ob + 2]),
    ));
    out[i * 3] = d; out[i * 3 + 1] = d; out[i * 3 + 2] = d;
  }
  return encodeRgbPng(w, h, out);
}

let cdpCursor = 0;
/**
 * 开一个独立 Edge 页跑一档。`capture(ctx)` 里做截图/读数；返回 `{ ok, ...capture 结果, errors }`。
 * ctx = { shot, setPhase, setPointer, uniformRead, evalJS, json }。
 */
async function runPage(spec, capture) {
  const cdpPort = CDP_PORT + cdpCursor++;
  const profile = join(OUT, `.edge-${TAG}-${spec.label}`);
  const winW = Math.max(1400, spec.view.w);
  const winH = Math.max(900, spec.view.h);
  const logs = [];
  let edge, ws, msgId = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      return { __err: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '') };
    }
    return r.result?.value;
  };
  const json = async (expr) => {
    const raw = await evalJS(`JSON.stringify(${expr})`);
    return typeof raw === 'string' ? JSON.parse(raw) : { __err: raw?.__err ?? String(raw) };
  };
  try {
    sceneOverride = spec.sceneText ?? null;
    edge = spawn(EDGE, [
      '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
      `--window-size=${winW},${winH}`, '--force-device-scale-factor=1',
      '--enable-unsafe-swiftshader', '--disable-gpu-sandbox',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
    ], { stdio: 'ignore' });
    const t1 = Date.now();
    let up = false;
    while (Date.now() - t1 < 30000) {
      try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`); if (r.ok) { up = true; break; } } catch { /* retry */ }
      await sleep(400);
    }
    if (!up) throw new Error('CDP 未就绪（30s）');
    const page = ((await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((t) => t.type === 'page'));
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id) {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        logs.push({ level: msg.params.type, text: (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ') });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        logs.push({
          level: 'error',
          text: msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? '',
        });
      }
    };
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: winW, height: winH, deviceScaleFactor: 1, mobile: false });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SHIM });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: DATE_SHIM });
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?id=${spec.id}&vw=${spec.view.w}&vh=${spec.view.h}&glow=off&wasm=none` });
    const t0 = Date.now();
    let ready = null;
    while (Date.now() - t0 < 90000) {
      const r = await evalJS('window.__fxReady ? JSON.stringify(window.__fxReady) : null');
      if (typeof r === 'string' && r) { ready = JSON.parse(r); break; }
      await sleep(300);
    }
    if (!ready) throw new Error('harness 未就绪（90s 超时）');
    if (ready.ok !== true) throw new Error(`render 未成功：${JSON.stringify(ready.err ?? ready)}`);
    const vp = await json('window.__fxApplyViewport()');
    if (vp?.ok !== true) throw new Error(`__fxApplyViewport 失败：${JSON.stringify(vp)}`);
    const stats = await json('window.__fxStats()');
    if (stats?.view?.[0] !== spec.view.w || stats?.view?.[1] !== spec.view.h) {
      throw new Error(`视口尺寸不符：${JSON.stringify(stats?.view)}（期望 ${spec.view.w}×${spec.view.h}）`);
    }
    if (vp.view?.[0] !== spec.view.w || vp.view?.[1] !== spec.view.h) {
      throw new Error(`player 视口未生效：${JSON.stringify(vp.view)}（期望 ${spec.view.w}×${spec.view.h}）`);
    }
    if (stats?.canvasAttrW !== spec.view.w || stats?.canvasAttrH !== spec.view.h) {
      throw new Error(`canvas 属性尺寸不符：${stats?.canvasAttrW}×${stats?.canvasAttrH}（期望 ${spec.view.w}×${spec.view.h}）`);
    }
    if (stats?.canvasCssW !== spec.view.w || stats?.canvasCssH !== spec.view.h) {
      throw new Error(`canvas CSS 尺寸不符：${stats?.canvasCssW}×${stats?.canvasCssH}（期望 ${spec.view.w}×${spec.view.h}）`);
    }
    const shot = async () => {
      const s = await send('Page.captureScreenshot', {
        format: 'png', clip: { x: 0, y: 0, width: spec.view.w, height: spec.view.h, scale: 1 }, captureBeyondViewport: false,
      });
      const buf = Buffer.from(s.data, 'base64');
      const dims = pngDims(buf);
      if (dims.w !== spec.view.w || dims.h !== spec.view.h) {
        throw new Error(`截图尺寸 ${dims.w}×${dims.h} ≠ ${spec.view.w}×${spec.view.h}`);
      }
      return buf;
    };
    const setPhase = (ms) => evalJS(`window.__vnow = ${ms}`);
    const setPointer = (x, y) => evalJS(`(() => {
      const ev = new PointerEvent('pointermove', {
        clientX: ${x} * window.innerWidth, clientY: ${y} * window.innerHeight, bubbles: true,
      });
      window.dispatchEvent(ev);
      return { clientX: ev.clientX, clientY: ev.clientY, innerW: window.innerWidth, innerH: window.innerHeight };
    })()`);
    // runner 材质里的全局 uniform 读数（证明指针注入真的到 shader；asis 的零差异因此不是空判据）。
    const uniformRead = () => json(`(() => {
      const st = window.__stage;
      if (!st) return null;
      const out = {};
      for (const [id, r] of st.debugRunners()) {
        const m = r.materials && r.materials.get ? r.materials.get('0:0') : null;
        out[id] = m ? {
          g_PointerPosition: m.uniforms.g_PointerPosition ? m.uniforms.g_PointerPosition.value : null,
          g_ParallaxPosition: m.uniforms.g_ParallaxPosition ? m.uniforms.g_ParallaxPosition.value : null,
        } : null;
      }
      return out;
    })()`);
    const result = await capture({ shot, setPhase, setPointer, uniformRead, evalJS, json });
    const pageLogs = await json('window.__fxLogs ?? []');
    const glShaderErrors = await json('window.__fxShaderErrors ?? []');
    const allLogs = [...logs, ...(Array.isArray(pageLogs) ? pageLogs : [])];
    const shaderErrors = [];
    const addShaderError = (text) => {
      const t = String(text).slice(0, 500);
      if (t && !shaderErrors.includes(t)) shaderErrors.push(t);
    };
    // effect pass 编译失败只打 warn（不是 console.error）⇒ 必须按文案单独收；GL info log 是第二证据源。
    for (const l of allLogs) if (/效果 pass 编译失败/.test(String(l.text))) addShaderError(l.text);
    if (Array.isArray(glShaderErrors)) for (const e of glShaderErrors) addShaderError(e);
    const errors = allLogs
      .filter((l) => l.level === 'error' || /shader 编译\/链接失败/.test(String(l.text)))
      .map((l) => String(l.text).slice(0, 300));
    const chains = await json('window.__fxChains ? window.__fxChains() : null');
    return { ok: true, label: spec.label, ready, vp, stats, chains, errors, shaderErrors, result };
  } catch (e) {
    return { ok: false, label: spec.label, fail: e?.message ?? String(e) };
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    edge?.kill();
    sceneOverride = null;
  }
}

/** 差异像素按 x 分左右两簇，返回各簇像素数 / 质心 / bbox（用于指针位置断言）。 */
function changedClusters(a, b, splitX) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('两图尺寸不一致');
  const w = a.width, h = a.height, ca = a.channels, cb = b.channels;
  const mk = () => ({ count: 0, sx: 0, sy: 0, minX: Infinity, maxX: -1, minY: Infinity, maxY: -1 });
  const left = mk(), right = mk();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, oa = i * ca, ob = i * cb;
      const d = Math.max(
        Math.abs(a.data[oa] - b.data[ob]),
        Math.abs(a.data[oa + 1] - b.data[ob + 1]),
        Math.abs(a.data[oa + 2] - b.data[ob + 2]),
      );
      if (d < 2) continue;
      const c = x < splitX ? left : right;
      c.count++; c.sx += x; c.sy += y;
      if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
    }
  }
  const fin = (c) => (c.count > 0
    ? { count: c.count, centroid: [c.sx / c.count, c.sy / c.count], bbox: [c.minX, c.minY, c.maxX, c.maxY] }
    : { count: 0, centroid: null, bbox: null });
  return { total: left.count + right.count, left: fin(left), right: fin(right) };
}

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const pct = (v) => `${(v * 100).toFixed(2)}%`;

// ── 判据实现 ──────────────────────────────────────────────────────────────────
let failed = false;
const criteria = {};

function recordPass(name, pass, detail) {
  const line = `${pass ? `${GRN}PASS${RST}` : `${RED}FAIL${RST}`} ${name}`;
  console.log(`${line}${detail ? `  ${detail}` : ''}`);
  if (!pass) failed = true;
}

function checkReadyAll(runs) {
  for (const r of runs) {
    if (!r) continue;
    if (!r.ok) {
      console.log(`${RED}[FAIL]${RST} ${r.label} 渲染失败：${r.fail}`);
      return false;
    }
    for (const e of r.errors.slice(0, 5)) console.log(`${YEL}[WARN]${RST} ${r.label} 页面错误：${e}`);
  }
  return true;
}

// effect pass 编译失败是 warn 而非 error（three 跳过绘制不抛）⇒ 门禁必须单独收，否则页面上「少一层后处理」
// 仍可能全 PASS。任一档命中即整轮失败（至少覆盖 ①，这里对四组统一收紧）。
function checkShaderErrors(runs) {
  const hits = [];
  for (const r of runs) {
    if (!r?.ok) continue;
    for (const e of r.shaderErrors ?? []) hits.push({ label: r.label, text: e });
  }
  if (hits.length === 0) return true;
  failed = true;
  for (const h of hits.slice(0, 8)) console.log(`${RED}[FAIL]${RST} ${h.label} shader 编译错误：${h.text}`);
  if (hits.length > 8) console.log(`${RED}[FAIL]${RST} ... 另有 ${hits.length - 8} 条 shader 错误`);
  console.log(`${RED}[FAIL]${RST} effect pass / GL shader 编译失败 ⇒ 整轮失败（禁止假 PASS）`);
  return false;
}

/** 全屏覆盖：diff bbox 每条边到视口边缘的未变化余量都 ≤ tol（证明是整屏后处理，不是局部一块）。 */
function coversViewport(bbox, w, h, tol) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return false;
  return bbox[0] <= tol && bbox[1] <= tol && (w - 1 - bbox[2]) <= tol && (h - 1 - bbox[3]) <= tol;
}

/** ③ 已知文字区（TEXT_VIEW 不是 1600×900 时按比例缩放）。 */
function textBboxRegion() {
  const sx = TEXT_VIEW.w / TEXT_BBOX_BASE_VIEW[0];
  const sy = TEXT_VIEW.h / TEXT_BBOX_BASE_VIEW[1];
  return [TEXT_BBOX_BASE[0] * sx, TEXT_BBOX_BASE[1] * sy, TEXT_BBOX_BASE[2] * sx, TEXT_BBOX_BASE[3] * sy];
}

/** diff bbox 必须整体落在文字区 ± tol；非文字区域的差异会把 bbox 撑出去 ⇒ FAIL。 */
function withinTextRegion(bbox, tol) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return false;
  const r = textBboxRegion();
  return bbox[0] >= r[0] - tol && bbox[1] >= r[1] - tol && bbox[2] <= r[2] + tol && bbox[3] <= r[3] + tol;
}

// ① 2911105183 util 后处理（projectlayer bloom+bokeh）：启用档 vs 清空 effects 档。
async function runUtilPostprocess() {
  console.log(`\n===== ① 2911105183 util 后处理（projectlayer bloom+bokeh）=====`);
  const offPatch = patchStripProjectEffects(ID_UTIL);
  console.log(`  对照=服务端清空 projectlayer 的 effects：${JSON.stringify(offPatch.patched)}`);
  const on = await runPage({ label: '291-util-on', id: ID_UTIL, view: VIEW }, async (ctx) => {
    await ctx.setPhase(PHASE_MS);
    await sleep(900);
    return { png: await ctx.shot() };
  });
  const off = await runPage({ label: '291-util-off', id: ID_UTIL, view: VIEW, sceneText: offPatch.text }, async (ctx) => {
    await ctx.setPhase(PHASE_MS);
    await sleep(900);
    return { png: await ctx.shot() };
  });
  if (!checkReadyAll([on, off]) || !on.ok || !off.ok) {
    recordPass('2911105183-util-postprocess', false, '渲染未完成');
    return { id: ID_UTIL, view: VIEW, patched: offPatch.patched, pass: false, fail: '渲染未完成' };
  }
  writeFileSync(join(OUT, `${TAG}-291-util-on.png`), on.result.png);
  writeFileSync(join(OUT, `${TAG}-291-util-off.png`), off.result.png);
  const a = decodePng(on.result.png);
  const b = decodePng(off.result.png);
  const diff = meanAbsDiff(a, b);
  writeFileSync(join(OUT, `${TAG}-291-util-diff.png`), diffPng(a, b));
  const shaderOk = checkShaderErrors([on, off]);
  const chainsOn = on.chains?.ready ?? null;
  // 对照改写命中的 util 对象（291 为 #58 projectlayer）必须真的挂上并产出了链；这只是 per-object 证据，
  // per-pass 由上面的 shader 门禁与像素差共同钉住。
  const targetIds = offPatch.patched.map((p) => Number(p.object));
  const chainsTarget = Object.fromEntries(targetIds.map((id) => [id, chainsOn?.[String(id)] === true]));
  const chainsTargetOk = targetIds.length > 0 && targetIds.every((id) => chainsTarget[id]);
  const bboxOk = coversViewport(diff.bbox, VIEW.w, VIEW.h, THRESHOLDS.utilBboxTol);
  console.log(`  bloom+bokeh 开：chains=${JSON.stringify(chainsOn)} 目标对象链就绪=${chainsTargetOk ? 'PASS' : 'FAIL'}（${JSON.stringify(chainsTarget)}）`);
  console.log(`  差分：meanAbs=${diff.meanAbs.toFixed(3)} changed=${diff.changed}（${pct(diff.changedRatio)}）max=${diff.max} bbox=${JSON.stringify(diff.bbox)}`);
  console.log(`  全屏覆盖：bbox 每边余量 ≤${THRESHOLDS.utilBboxTol}px=${bboxOk ? 'PASS' : 'FAIL'}（视口 ${VIEW.w}×${VIEW.h}）`);
  console.log(`  阈值：meanAbs ≥ ${THRESHOLDS.utilMeanAbs} 且 changed ≥ ${pct(THRESHOLDS.utilChanged)}`);
  const pass = shaderOk && chainsTargetOk && bboxOk
    && diff.meanAbs >= THRESHOLDS.utilMeanAbs && diff.changedRatio >= THRESHOLDS.utilChanged;
  recordPass('2911105183-util-postprocess', pass,
    `meanAbs=${diff.meanAbs.toFixed(3)} changed=${pct(diff.changedRatio)} bboxOk=${bboxOk} chainsTarget=${chainsTargetOk ? 'PASS' : 'FAIL'}`);
  criteria.utilPostprocess = {
    id: ID_UTIL, view: VIEW, patched: offPatch.patched, chainsOn, chainsTarget, chainsTargetOk,
    thresholds: {
      meanAbs: THRESHOLDS.utilMeanAbs, changedRatio: THRESHOLDS.utilChanged, bboxTol: THRESHOLDS.utilBboxTol,
    },
    bboxOk, shaderOk,
    diff, errors: { on: on.errors, off: off.errors },
    shaderErrors: { on: on.shaderErrors, off: off.shaderErrors },
    png: { on: `${TAG}-291-util-on.png`, off: `${TAG}-291-util-off.png`, diff: `${TAG}-291-util-diff.png` },
    pass,
  };
  return criteria.utilPostprocess;
}

// ② 2132420420 pulse：同页只冻结时钟相位 0s vs 5s。
async function runPulse() {
  console.log(`\n===== ② 2132420420 pulse（冻结相位 ${PHASE_A_MS}ms vs ${PHASE_B_MS}ms）=====`);
  const page = await runPage({ label: '213-pulse', id: ID_PULSE, view: VIEW }, async (ctx) => {
    await ctx.setPhase(PHASE_A_MS);
    await sleep(1000);
    const a = await ctx.shot();
    await ctx.setPhase(PHASE_B_MS);
    await sleep(1400);
    const b = await ctx.shot();
    return { a, b };
  });
  if (!checkReadyAll([page]) || !page.ok) {
    recordPass('2132420420-pulse', false, '渲染未完成');
    return { id: ID_PULSE, view: VIEW, pass: false, fail: '渲染未完成' };
  }
  writeFileSync(join(OUT, `${TAG}-213-pulse-a.png`), page.result.a);
  writeFileSync(join(OUT, `${TAG}-213-pulse-b.png`), page.result.b);
  const a = decodePng(page.result.a);
  const b = decodePng(page.result.b);
  const diff = meanAbsDiff(a, b);
  writeFileSync(join(OUT, `${TAG}-213-pulse-diff.png`), diffPng(a, b));
  const shaderOk = checkShaderErrors([page]);
  console.log(`  chains=${JSON.stringify(page.chains?.ready ?? null)}`);
  console.log(`  差分：meanAbs=${diff.meanAbs.toFixed(3)} changed=${diff.changed}（${pct(diff.changedRatio)}）max=${diff.max} bbox=${JSON.stringify(diff.bbox)}`);
  console.log(`  阈值：meanAbs ≥ ${THRESHOLDS.pulseMeanAbs} 且 changed ≥ ${pct(THRESHOLDS.pulseChanged)}`);
  const pass = shaderOk
    && diff.meanAbs >= THRESHOLDS.pulseMeanAbs && diff.changedRatio >= THRESHOLDS.pulseChanged;
  recordPass('2132420420-pulse', pass, `meanAbs=${diff.meanAbs.toFixed(3)} changed=${pct(diff.changedRatio)}`);
  criteria.pulse = {
    id: ID_PULSE, view: VIEW, phase: { a: PHASE_A_MS, b: PHASE_B_MS }, chains: page.chains?.ready ?? null,
    thresholds: { meanAbs: THRESHOLDS.pulseMeanAbs, changedRatio: THRESHOLDS.pulseChanged },
    diff, errors: page.errors, shaderErrors: page.shaderErrors, shaderOk,
    png: { a: `${TAG}-213-pulse-a.png`, b: `${TAG}-213-pulse-b.png`, diff: `${TAG}-213-pulse-diff.png` },
    pass,
  };
  return criteria.pulse;
}

// ③ 3765967112 text brightness：素材值 vs 服务端强制 brightness=1（= 修复前观感）。
async function runTextBrightness() {
  console.log(`\n===== ③ 3765967112 text brightness（素材值 vs 强制 1）=====`);
  const offPatch = patchTextBrightnessOne(ID_TEXT);
  console.log(`  对照=服务端把 text brightness 强制 1：${JSON.stringify(offPatch.patched)}`);
  const on = await runPage({ label: '376-text-on', id: ID_TEXT, view: TEXT_VIEW }, async (ctx) => {
    await ctx.setPhase(PHASE_MS);
    await sleep(1000);
    return { png: await ctx.shot() };
  });
  const off = await runPage({ label: '376-text-off', id: ID_TEXT, view: TEXT_VIEW, sceneText: offPatch.text }, async (ctx) => {
    await ctx.setPhase(PHASE_MS);
    await sleep(1000);
    return { png: await ctx.shot() };
  });
  if (!checkReadyAll([on, off]) || !on.ok || !off.ok) {
    recordPass('3765967112-text-brightness', false, '渲染未完成');
    return { id: ID_TEXT, view: TEXT_VIEW, patched: offPatch.patched, pass: false, fail: '渲染未完成' };
  }
  writeFileSync(join(OUT, `${TAG}-376-text-on.png`), on.result.png);
  writeFileSync(join(OUT, `${TAG}-376-text-off.png`), off.result.png);
  const a = decodePng(on.result.png);
  const b = decodePng(off.result.png);
  const diff = meanAbsDiff(a, b);
  writeFileSync(join(OUT, `${TAG}-376-text-diff.png`), diffPng(a, b));
  const shaderOk = checkShaderErrors([on, off]);
  const bboxRegion = textBboxRegion();
  const bboxOk = withinTextRegion(diff.bbox, THRESHOLDS.textBboxTol);
  console.log(`  差分：changed=${diff.changed}px max=${diff.max} meanAbs=${diff.meanAbs.toFixed(3)} bbox=${JSON.stringify(diff.bbox)}`);
  console.log(`  文字区：bbox 应落在 ${JSON.stringify(bboxRegion.map((v) => Math.round(v)))} ±${THRESHOLDS.textBboxTol}px=${bboxOk ? 'PASS' : 'FAIL'}`);
  console.log(`  阈值：changed ≥ ${THRESHOLDS.textChangedPx}px 且 maxΔ ≥ ${THRESHOLDS.textMaxDelta}`);
  const pass = shaderOk && bboxOk
    && diff.changed >= THRESHOLDS.textChangedPx && diff.max >= THRESHOLDS.textMaxDelta;
  recordPass('3765967112-text-brightness', pass,
    `changed=${diff.changed}px max=${diff.max} bbox=${JSON.stringify(diff.bbox)} textBboxOk=${bboxOk}`);
  criteria.textBrightness = {
    id: ID_TEXT, view: TEXT_VIEW, patched: offPatch.patched,
    bboxRegion, bboxOk, shaderOk,
    thresholds: {
      changedPx: THRESHOLDS.textChangedPx, maxDelta: THRESHOLDS.textMaxDelta, bboxTol: THRESHOLDS.textBboxTol,
    },
    diff, errors: { on: on.errors, off: off.errors },
    shaderErrors: { on: on.shaderErrors, off: off.shaderErrors },
    png: { on: `${TAG}-376-text-on.png`, off: `${TAG}-376-text-off.png`, diff: `${TAG}-376-text-diff.png` },
    pass,
  };
  return criteria.textBrightness;
}

// ④ 3780477933 指针 uniform：asis（作者常量 no-op）+ defaults（恢复默认圆点/掩膜）。
async function runPointerUniform() {
  console.log(`\n===== ④ 3780477933 指针 uniform（pointer A/B）=====`);
  const defaultsPatch = patchDotMatrixDefaults(ID_POINTER);
  console.log(`  defaults 变体=服务端改写：${JSON.stringify(defaultsPatch.patched)}`);
  const uniformOk = (reads, pointer) => {
    const vals = Object.values(reads ?? {}).map((u) => u?.g_PointerPosition).filter(Array.isArray);
    return vals.length > 0 && vals.every((v) => Math.abs(v[0] - pointer[0]) < 1e-3 && Math.abs(v[1] - pointer[1]) < 1e-3);
  };
  const runMode = async (mode, sceneText) => runPage(
    { label: `378-pointer-${mode}`, id: ID_POINTER, view: VIEW, sceneText },
    async (ctx) => {
      await ctx.setPhase(PHASE_MS);
      await ctx.setPointer(POINTER_A[0], POINTER_A[1]);
      await sleep(1400);
      const a = await ctx.shot();
      const ua = await ctx.uniformRead();
      await ctx.setPointer(POINTER_B[0], POINTER_B[1]);
      await sleep(1400);
      const b = await ctx.shot();
      const ub = await ctx.uniformRead();
      return { a, b, ua, ub };
    },
  );
  const asis = await runMode('asis', null);
  const defaults = await runMode('defaults', defaultsPatch.text);
  if (!checkReadyAll([asis, defaults]) || !asis.ok || !defaults.ok) {
    recordPass('3780477933-pointer-uniform', false, '渲染未完成');
    return { id: ID_POINTER, view: VIEW, patched: defaultsPatch.patched, pass: false, fail: '渲染未完成' };
  }
  const shaderOk = checkShaderErrors([asis, defaults]);
  const summarize = (mode, r) => {
    writeFileSync(join(OUT, `${TAG}-378-${mode}-a.png`), r.result.a);
    writeFileSync(join(OUT, `${TAG}-378-${mode}-b.png`), r.result.b);
    const a = decodePng(r.result.a);
    const b = decodePng(r.result.b);
    const diff = meanAbsDiff(a, b);
    writeFileSync(join(OUT, `${TAG}-378-${mode}-diff.png`), diffPng(a, b));
    const uniform = { a: r.result.ua, b: r.result.ub };
    return { a, b, diff, uniform, png: { a: `${TAG}-378-${mode}-a.png`, b: `${TAG}-378-${mode}-b.png`, diff: `${TAG}-378-${mode}-diff.png` } };
  };
  const asisS = summarize('asis', asis);
  const defS = summarize('defaults', defaults);
  const asisUniformOk = uniformOk(asisS.uniform.a, POINTER_A) && uniformOk(asisS.uniform.b, POINTER_B);
  const defUniformOk = uniformOk(defS.uniform.a, POINTER_A) && uniformOk(defS.uniform.b, POINTER_B);
  const asisPass = shaderOk && asisS.diff.changedRatio < THRESHOLDS.pointerAsisMax && asisUniformOk;
  const clusters = changedClusters(defS.a, defS.b, Math.round(VIEW.w / 2));
  const pa = [POINTER_A[0] * VIEW.w, POINTER_A[1] * VIEW.h];
  const pb = [POINTER_B[0] * VIEW.w, POINTER_B[1] * VIEW.h];
  const leftFrac = clusters.total > 0 ? clusters.left.count / clusters.total : 0;
  const rightFrac = clusters.total > 0 ? clusters.right.count / clusters.total : 0;
  const leftDist = clusters.left.centroid ? dist(clusters.left.centroid, pa) : Infinity;
  const rightDist = clusters.right.centroid ? dist(clusters.right.centroid, pb) : Infinity;
  const clustersOk = leftFrac >= 0.05 && rightFrac >= 0.05
    && leftDist <= THRESHOLDS.pointerClusterRadiusPx
    && rightDist <= THRESHOLDS.pointerClusterRadiusPx
    && clusters.left.centroid[1] < VIEW.h / 2 && clusters.right.centroid[1] > VIEW.h / 2; // y 向下
  const defaultsPass = shaderOk && defS.diff.changedRatio >= THRESHOLDS.pointerDefaultsMin && defUniformOk && clustersOk;
  const pass = asisPass && defaultsPass;
  console.log(`  shader 编译=${shaderOk ? 'PASS' : 'FAIL'}`);
  console.log(`  asis：uniform A/B=${asisUniformOk ? 'PASS' : 'FAIL'} changed=${pct(asisS.diff.changedRatio)}（阈值 <${pct(THRESHOLDS.pointerAsisMax)}）`);
  console.log(`  defaults：uniform A/B=${defUniformOk ? 'PASS' : 'FAIL'} changed=${defS.diff.changed}（${pct(defS.diff.changedRatio)}，阈值 ≥${pct(THRESHOLDS.pointerDefaultsMin)}）`);
  console.log(`  defaults 双簇：left=${clusters.left.count}px 质心=${JSON.stringify(clusters.left.centroid)}（指针 A ${JSON.stringify(pa)}，距离 ${leftDist.toFixed(1)}px）`
    + ` right=${clusters.right.count}px 质心=${JSON.stringify(clusters.right.centroid)}（指针 B ${JSON.stringify(pb)}，距离 ${rightDist.toFixed(1)}px）`);
  console.log(`  双簇判据：两侧占比 ≥5% 且质心距指针 ≤${THRESHOLDS.pointerClusterRadiusPx}px（left 在上半屏、right 在下半屏）`);
  recordPass('3780477933-pointer-uniform', pass,
    `asis changed=${pct(asisS.diff.changedRatio)} / defaults changed=${pct(defS.diff.changedRatio)} clusters=${clustersOk ? 'PASS' : 'FAIL'}`);
  criteria.pointerUniform = {
    id: ID_POINTER, view: VIEW, patched: defaultsPatch.patched,
    thresholds: {
      asisMaxChangedRatio: THRESHOLDS.pointerAsisMax,
      defaultsMinChangedRatio: THRESHOLDS.pointerDefaultsMin,
      clusterRadiusPx: THRESHOLDS.pointerClusterRadiusPx,
    },
    asis: {
      uniform: asisS.uniform, uniformOk: asisUniformOk, diff: asisS.diff,
      errors: asis.errors, shaderErrors: asis.shaderErrors, png: asisS.png, pass: asisPass,
    },
    defaults: {
      uniform: defS.uniform, uniformOk: defUniformOk, diff: defS.diff,
      clusters, clustersOk, errors: defaults.errors, shaderErrors: defaults.shaderErrors,
      png: defS.png, pass: defaultsPass,
    },
    shaderOk,
    pass,
  };
  return criteria.pointerUniform;
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
let runError = null;
try {
  if (onlyInvalid) throw new Error(onlyInvalid); // 参数错误也走 summary，不能留下上一轮的 pass:true
  await new Promise((r) => server.listen(PORT, r));
  console.log(`[v082] 视口 ${VIEW.w}×${VIEW.h}（text ${TEXT_VIEW.w}×${TEXT_VIEW.h}）  判据=${ONLY.join(',')}  端口=${PORT}`);
  if (want('util')) criteria[CRITERIA_NAME.util] = await runUtilPostprocess();
  if (want('pulse')) criteria[CRITERIA_NAME.pulse] = await runPulse();
  if (want('text')) criteria[CRITERIA_NAME.text] = await runTextBrightness();
  if (want('pointer')) criteria[CRITERIA_NAME.pointer] = await runPointerUniform();
} catch (e) {
  runError = e?.message ?? String(e);
  console.error('ERROR:', e?.stack ?? runError);
  failed = true;
} finally {
  server.close();
}

// 期望判据必须全部出现且 pass：`--only` 白名单外的值已在上方 throw；默认四组缺一/任一 FAIL ⇒ exit 1。
if (!onlyInvalid) {
  for (const key of expectedKeys) {
    const name = CRITERIA_NAME[key];
    if (!criteria[name] || criteria[name].pass !== true) {
      failed = true;
      if (!criteria[name]) criteria[name] = { pass: false, fail: '渲染未完成' };
      console.log(`${RED}[FAIL]${RST} 期望判据缺失或未通过：${name}`);
    }
  }
}
const coverage = onlyInvalid
  ? null
  : { expected: expectedKeys.map((k) => CRITERIA_NAME[k]), ok: expectedKeys.every((k) => criteria[CRITERIA_NAME[k]]?.pass === true) };
const summary = {
  tag: TAG,
  view: VIEW,
  textView: TEXT_VIEW,
  only: ONLY,
  expected: expectedKeys.map((k) => CRITERIA_NAME[k]),
  coverage,
  thresholds: THRESHOLDS,
  criteria,
  error: runError,
  pass: !failed,
};
const summaryPath = join(OUT, 'summary.json');
writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
console.log(`\nE2E_OUT=${OUT}`);
console.log(`summary：${summaryPath}`);
console.log(`[v082] ${failed ? `${RED}FAIL${RST}` : `${GRN}PASS${RST}`}`);
if (failed) process.exitCode = 1;
