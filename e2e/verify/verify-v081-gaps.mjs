// v0.8.1 缺口修复的端到端像素判据（F8 壁纸级 bloom / F15 清屏色 / F13 image 精灵表）。
//
// 目的：在**真实 WebGL**（headless Edge，SwiftShader 软件光栅化）下走生产装配入口
// `createThreeSceneRenderer().render(id, canvas)`，用真实壁纸素材做像素级判据：
//
//   ① F8 bloom（缺省 2454403969，general.bloom=true）：同页两档对照（原始 scene.json vs 服务端把
//      general.bloom 改成 false），统计 luma>200 的亮部占比；开启档必须显著更高。
//   ② F15 clearcolor（缺省 2980088441，general.clearcolor="0.06667 0.07843 0.09412"）：画布四角
//      像素必须 ≈ #111418（每通道 ±8）。该场景只有居中文本对象，四角必为清屏色。
//   ③ F13 spritesheet（缺省 3765967112，图标材质 combos.spritesheet=1、TEXS 1 列×3 行）：对照档由
//      服务端删掉材质的 combos.spritesheet（= 改动前的整表渲染）；判据要求图标区域 luma 方差
//      低于「整表渲染」且不超过绝对上限（阈值用 before/after 标定，见 SPRITE_MAX_VARIANCE）。
//
// 为什么用像素而不是读 stage 状态：判据要证明「scene.json / 材质 → 解析 → 装配 → 渲染」整条链路生效，
// 而不是某个中间对象存在。对照档只改服务给页面的字节（与 git 工作树无关，不动源码）。
//
// 用法：
//   node e2e/verify/verify-v081-gaps.mjs [--id=2454403969] [--vw=1280] [--vh=720]
//        [--tag=v081] [--luma=200] [--clear-id=2980088441] [--sprite-id=3765967112]
//        [--sprite-vw=1280] [--sprite-vh=2160]
// 环境变量等价形式：ID / VW / VH / TAG / LUMA / CLEAR_ID / SPRITE_ID / SPRITE_VW / SPRITE_VH；
// 另需 WE_WORKSHOP（壁纸目录）与 WE_ASSETS（WE 安装目录）。
// 退出码：0 = 判据通过；1 = 判据失败或脚本异常（CI 门禁）。
//
// 产物：e2e/.out/v081-gaps/<tag>-bloom-on.png / <tag>-bloom-off.png / <tag>-clearcolor.png /
//       <tag>-sprite-after.png / <tag>-sprite-before.png / <tag>-summary.json
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { decodePng } from '../lib/png-stats.mjs';
import { OUT_DIR, WE_WORKSHOP, WE_ASSETS as WE_ASSETS_ROOT, resolveEdgePath, httpPort, cdpPort as resolveCdpPort } from '../config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

// ── 参数 ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq < 0 ? true : hit.slice(eq + 1);
};
const ID = String(argOf('id', process.env.ID ?? '2454403969'));
const VIEW = {
  w: Math.max(1, Math.round(Number(argOf('vw', process.env.VW ?? 1280)))),
  h: Math.max(1, Math.round(Number(argOf('vh', process.env.VH ?? 720)))),
};
// F15 / F13 用的素材与视口（独立参数，互不影响 bloom 判据）。
const CLEAR_ID = String(argOf('clear-id', process.env.CLEAR_ID ?? '2980088441'));
const SPRITE_ID = String(argOf('sprite-id', process.env.SPRITE_ID ?? '3765967112'));
// 精灵表素材场景 3840×2160、图标约 50 世界单位；竖长视口（aspect < 场景）让 cover 相机 1:1 取景，
// 图标在截图上约 50px（1280×720 时只有 ~17px，方差统计样本太小）。
const SPRITE_VIEW = {
  w: Math.max(1, Math.round(Number(argOf('sprite-vw', process.env.SPRITE_VW ?? 1280)))),
  h: Math.max(1, Math.round(Number(argOf('sprite-vh', process.env.SPRITE_VH ?? 2160)))),
};
const WINDOW = { w: 1400, h: 900 };
const TAG = String(argOf('tag', process.env.TAG ?? 'v081'));
const OUT = join(OUT_DIR, 'v081-gaps');
mkdirSync(OUT, { recursive: true });

// ── 判据常量（实现时用真实素材标定，见 task-7-report）──────────────────────────
// luma = 0.299R + 0.587G + 0.114B；>200 视为「亮部」。2454403969 的 bloom 缺省参数
// （threshold=0.65 / strength=0.98）会把 ≥0.65 的区域抬过 200，关闭档则不会。
const LUMA_THRESHOLD = Math.max(0, Math.min(255, Number(argOf('luma', process.env.LUMA ?? 200))));
// 开启档亮部占比必须比关闭档高出至少这么多（占全图比例）。标定：2454403969 实测
// 2.245% vs 0.604% ⇒ delta≈1.64pp（同一时钟相位）；留 ~2× 裕度取 0.8pp。
const MIN_RATIO_DELTA = Number(process.env.MIN_RATIO_DELTA ?? 0.008);
// 开启档亮部占比下限：防止「两档都几乎全黑、差值恰好达标」的假阳性。
const MIN_WITH_BLOOM_RATIO = Number(process.env.MIN_WITH_BLOOM_RATIO ?? 0.005);
// F15：2980088441 的 general.clearcolor = "0.06667 0.07843 0.09412" ×255 = #111418。
const CLEAR_RGB = [17, 20, 24];
const CLEAR_TOL = Number(process.env.CLEAR_TOL ?? 8);
// F13：图标区域 luma 方差与亮行组。整表渲染（对照档，3 帧压进同一 quad）三帧竖排 ⇒ 3 个亮行组、
// 且把不同帧内容挤进同一区域 ⇒ 方差更高；单帧渲染 ⇒ 1 组。阈值由 before/after 实测标定：
// 方差 单帧 3319.05 vs 整表 4473.26（比值 0.742）；亮行组 1 vs 3（minPx=8）。
const SPRITE_MAX_VARIANCE = Number(process.env.SPRITE_MAX_VARIANCE ?? 3700);
const SPRITE_MAX_BEFORE_RATIO = Number(process.env.SPRITE_MAX_BEFORE_RATIO ?? 0.8);
const SPRITE_BRIGHT_LUMA = Number(process.env.SPRITE_BRIGHT_LUMA ?? 200);
const SPRITE_BRIGHT_MIN_PX = Number(process.env.SPRITE_BRIGHT_MIN_PX ?? 8);

const PORT = httpPort(9832);
const CDP_PORT = resolveCdpPort(9242);
const EDGE = resolveEdgePath();
const WALLPAPER_DIR = WE_WORKSHOP;
const WE_ASSETS = join(WE_ASSETS_ROOT, 'assets');
const STATIC_DIR = join(repo, 'dist', 'static');

// 终端着色（判定结果不依赖颜色；另有字面 [PASS]/[FAIL] 标记）。
const USE_COLOR = process.stdout.isTTY === true && !process.env.NO_COLOR;
const RED = USE_COLOR ? '\x1b[31m' : '';
const GRN = USE_COLOR ? '\x1b[32m' : '';
const YEL = USE_COLOR ? '\x1b[33m' : '';
const RST = USE_COLOR ? '\x1b[0m' : '';

// ── scene.pkg 读取（与 verify-hidpi-object-rt.mjs 同实现）────────────────────────
function readPkg(id) {
  const pkgPath = join(WALLPAPER_DIR, id, 'scene.pkg');
  if (!existsSync(pkgPath)) return null;
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
  const files = new Map();
  for (const e of entries) files.set(e.name, buf.subarray(dataStart + e.off, dataStart + e.off + e.size));
  return files;
}
const PKGS = new Map();
const pkgOf = (id) => { if (!PKGS.has(id)) PKGS.set(id, readPkg(id)); return PKGS.get(id); };
const sceneOf = (id) => JSON.parse(Buffer.from(pkgOf(id).get('scene.json')).toString('utf8'));

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
  '.frag': 'text/plain', '.vert': 'text/plain',
};
// 服务端全局：true ⇒ 下一次页面请求拿到的 scene.json 去掉壁纸 bloom（对照档）。
let serveNoBloom = false;
// true ⇒ 下一次页面请求拿到的 image 材质删掉 combos.spritesheet（= F13 改动前的整表渲染）。
let serveStripSpritesheet = false;

/** 删除 image 材质 passes[].combos.spritesheet，返回改写后的 JSON 文本（无该 combo → null）。 */
function stripSpritesheetMaterial(entry) {
  try {
    const mat = JSON.parse(Buffer.from(entry).toString('utf8'));
    let hit = false;
    for (const pass of Array.isArray(mat?.passes) ? mat.passes : []) {
      if (!pass?.combos || typeof pass.combos !== 'object') continue;
      for (const key of ['spritesheet', 'SPRITESHEET']) {
        if (key in pass.combos) { delete pass.combos[key]; hit = true; }
      }
    }
    return hit ? JSON.stringify(mat) : null;
  } catch {
    return null; // 非 JSON/畸形材质：保持原字节，不因对照档把页面搞坏
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = decodeURIComponent(url.pathname);
  const send = (body, type, status = 200, headers = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
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
    // 与生产路由同序（src/host/routes.ts）：壁纸 scene.pkg 先、引擎 assets 后。
    const id = url.searchParams.get('id') ?? '';
    if (id) {
      const inPkg = pkgOf(id)?.get(`materials/${name}.tex`);
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
    const files = pkgOf(id);
    if (!files) return send('no pkg', 'text/plain', 404);
    // ★ 对照档：只改服务给页面的字节（general.bloom=false ⇒ 解析器不产出 bloom）。
    if (serveNoBloom && name === 'scene.json') {
      const sc = sceneOf(id);
      const variant = { ...sc, general: { ...(sc.general ?? {}), bloom: false } };
      return send(JSON.stringify(variant), 'application/json');
    }
    // ★ F13 对照档：材质删 combos.spritesheet ⇒ player 不接管帧 UV（复刻改动前的整表渲染）。
    if (serveStripSpritesheet && name.startsWith('materials/') && name.endsWith('.json')) {
      const stripped = stripSpritesheetMaterial(files.get(name));
      if (stripped) return send(stripped, 'application/json');
    }
    const entry = files.get(name);
    if (!entry) return send('nf', 'text/plain', 404);
    return send(entry, MIME[extname(name)] ?? 'application/octet-stream');
  }
  return send('not found', 'text/plain', 404);
});

// ── CDP / 浏览器 ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 把 performance.now 换成可控虚拟时钟（页面最早时机注入）：钉住 player.elapsedSeconds() 的动画相位。 */
const CLOCK_SHIM = `(() => {
  try {
    const orig = performance.now.bind(performance);
    let vnow = 0;                       // 默认常量 0：player 构造时 startedAt = 0
    Object.defineProperty(window, '__vnow', {
      get: () => vnow, set: (v) => { vnow = Number(v) || 0; }, configurable: true,
    });
    performance.now = () => vnow;
    window.__vnowRaw = () => orig();
  } catch (e) { /* 注入失败会在结果里体现为相位不稳定 */ }
})();`;

function pngDims(buf) { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }

/**
 * 渲染一档并截图。每档独立 Edge 进程，避免模块态/GL 上下文跨档污染。
 * spec = { label, id, view, noBloom?, stripSpritesheet?, cdpPort }
 * 返回里带 `quads`（`__fxQuads()` 的视口像素矩形），供 Node 侧定位对象区域。
 */
async function runVariant(spec) {
  const { label, id, view, noBloom = false, stripSpritesheet = false, cdpPort } = spec;
  const profile = join(OUT, `.edge-${TAG}-${label}`);
  const winW = Math.max(WINDOW.w, view.w);
  const winH = Math.max(WINDOW.h, view.h);
  const logs = [];
  let edge, ws, msgId = 0;
  const pending = new Map();
  let page = null;
  const send = (method, params = {}) => new Promise((res, rej) => {
    const msgId2 = ++msgId;
    pending.set(msgId2, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: msgId2, method, params }));
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
    serveNoBloom = noBloom;
    serveStripSpritesheet = stripSpritesheet;
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
      try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`); if (r.ok) { up = true; break; } } catch {}
      await sleep(400);
    }
    if (!up) throw new Error('CDP 未就绪（30s）');
    page = ((await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((t) => t.type === 'page'));
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
    await send('Emulation.setDeviceMetricsOverride', {
      width: winW, height: winH, deviceScaleFactor: 1, mobile: false,
    });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SHIM });
    // 应用级 Glow 关闭（单一变量）；粒子整层跳过（相位确定性）。
    await send('Page.navigate', {
      url: `http://127.0.0.1:${PORT}/?id=${id}&vw=${view.w}&vh=${view.h}&glow=off&wasm=none`,
    });
    const t0 = Date.now();
    let ready = null;
    while (Date.now() - t0 < 90000) {
      const r = await evalJS('window.__fxReady ? JSON.stringify(window.__fxReady) : null');
      if (typeof r === 'string' && r) { ready = JSON.parse(r); break; }
      await sleep(300);
    }
    if (!ready) throw new Error('harness 未就绪（90s 超时）');
    await json('window.__fxApplyViewport()');
    // 冻结时钟 → 两档落在同一动画相位；等 900ms 让若干帧用同一 g_Time 重绘。
    await evalJS('window.__vnow = 5000');
    await sleep(900);
    const shot = await send('Page.captureScreenshot', {
      format: 'png', clip: { x: 0, y: 0, width: view.w, height: view.h, scale: 1 }, captureBeyondViewport: false,
    });
    const buf = Buffer.from(shot.data, 'base64');
    const dims = pngDims(buf);
    const pageLogs = await json('window.__fxLogs ?? []');
    const quads = await json('window.__fxQuads() ?? []');
    const errors = [...logs, ...(Array.isArray(pageLogs) ? pageLogs : [])]
      .filter((l) => l.level === 'error' || /shader 编译\/链接失败/.test(String(l.text)))
      .map((l) => String(l.text).slice(0, 300));
    return { ok: true, label, id, ready, quads, size: [dims.w, dims.h], png: buf, errors };
  } catch (e) {
    return { ok: false, label, id, fail: e?.message ?? String(e) };
  } finally {
    try { ws?.close(); } catch {}
    edge?.kill();
  }
}

/** 统计 luma > threshold 的像素数与占比。 */
function brightStats(img, threshold) {
  const { width, height, channels: ch, data } = img;
  let bright = 0;
  let sum = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * ch;
    const luma = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    sum += luma;
    if (luma > threshold) bright += 1;
  }
  const n = width * height;
  return {
    size: [width, height], brightPixels: bright, ratio: bright / n,
    meanLuma: sum / n, threshold,
  };
}

/** 读一个像素（截图坐标系，左上原点）。 */
function pixelAt(img, x, y) {
  const { width, height, channels: ch, data } = img;
  const px = Math.max(0, Math.min(width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(height - 1, Math.round(y)));
  const o = (py * width + px) * ch;
  return [data[o], data[o + 1], data[o + 2]];
}

/** 区域 luma 统计（方差 = 总体方差；样本 < 2 时方差记 0）。rect = [x0, y0, x1, y1]（已含端点外扩）。 */
function regionLumaStats(img, rect) {
  const { width, height, channels: ch, data } = img;
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(rect[0])));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(rect[1])));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil(rect[2])));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil(rect[3])));
  const values = [];
  let sum = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * width + x) * ch;
      const luma = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      values.push(luma);
      sum += luma;
    }
  }
  const n = values.length;
  const mean = n > 0 ? sum / n : 0;
  let acc = 0;
  for (const v of values) acc += (v - mean) ** 2;
  const variance = n > 0 ? acc / n : 0;
  return {
    rect: [x0, y0, x1, y1], pixels: n, meanLuma: mean,
    variance, stdDev: Math.sqrt(variance),
  };
}

/** 两图同区域逐像素 RGB 平均绝对差（诊断用；同一时钟相位下仅精灵表帧内容不同）。 */function regionMeanAbsDiff(a, b, rect) {
  const { width, channels: ch } = a;
  const x0 = Math.max(0, Math.floor(rect[0]));
  const y0 = Math.max(0, Math.floor(rect[1]));
  const x1 = Math.min(a.width, Math.ceil(rect[2]));
  const y1 = Math.min(a.height, Math.ceil(rect[3]));
  let acc = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * width + x) * ch;
      acc += Math.abs(a.data[o] - b.data[o])
        + Math.abs(a.data[o + 1] - b.data[o + 1])
        + Math.abs(a.data[o + 2] - b.data[o + 2]);
      n += 3;
    }
  }
  return n > 0 ? acc / n : 0;
}

/**
 * 亮行组：区域内逐行统计 luma > threshold 的像素数，≥ minPx 视为「图标亮行」，连续亮行为一组。
 * 整表渲染时 3 帧竖排 ⇒ 3 组（图标被压扁且被行间空隙分开）；单帧渲染 ⇒ 1 组（大图标连续）。
 * 这是「不再把整张表画出来」的直接结构判据（方差判据受背景照片影响，只作辅助）。
 */
function brightRowGroups(img, rect, { threshold = 200, minPx = 8 } = {}) {
  const { width, channels: ch, data } = img;
  const x0 = Math.max(0, Math.floor(rect[0]));
  const y0 = Math.max(0, Math.floor(rect[1]));
  const x1 = Math.min(img.width, Math.ceil(rect[2]));
  const y1 = Math.min(img.height, Math.ceil(rect[3]));
  const counts = [];
  for (let y = y0; y < y1; y++) {
    let c = 0;
    for (let x = x0; x < x1; x++) {
      const o = (y * width + x) * ch;
      const luma = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      if (luma > threshold) c++;
    }
    counts.push(c);
  }
  const groups = [];
  let start = -1;
  for (let i = 0; i <= counts.length; i++) {
    const bright = i < counts.length && counts[i] >= minPx;
    if (bright && start < 0) start = i;
    if (!bright && start >= 0) { groups.push([start, i - 1]); start = -1; }
  }
  return { count: groups.length, groups, counts, threshold, minPx };
}

/**
 * 定位精灵表图标 quad（`__fxQuads()` 的视口像素矩形）：
 * 该对象的 scene.json size=256×256（PlaneGeometry parameters），屏上约 50px（竖长视口 1:1 cover）。
 * 找不到 256×256 时退化为「屏上 < 120px 且最接近 50px」的 quad。
 */
function findSpriteIconRect(quads, view) {
  const list = (Array.isArray(quads) ? quads : [])
    .filter((q) => q && Array.isArray(q.rect) && q.rect.length === 4 && q.visible !== false)
    .map((q) => {
      const [rx0, ry0, rx1, ry1] = q.rect.map(Number);
      return {
        worldW: Number(q.worldW), worldH: Number(q.worldH),
        w: rx1 - rx0, h: ry1 - ry0,
        rect: [rx0, ry0, rx1, ry1],
      };
    })
    .filter((q) => Number.isFinite(q.w) && Number.isFinite(q.h) && q.w > 8 && q.h > 8);
  const small = list.filter((q) => q.w < 120 && q.h < 120);
  const exact = small.find((q) => q.worldW === 256 && q.worldH === 256);
  const pick = exact ?? small.sort((a, b) => Math.abs(a.w - 50) - Math.abs(b.w - 50))[0];
  if (!pick) return { rect: null, candidates: list.slice(0, 8).map((q) => ({ world: [q.worldW, q.worldH], rect: q.rect })) };
  const clampX = (v) => Math.max(0, Math.min(view.w, v));
  const clampY = (v) => Math.max(0, Math.min(view.h, v));
  return {
    rect: [
      clampX(Math.floor(pick.rect[0])), clampY(Math.floor(pick.rect[1])),
      clampX(Math.ceil(pick.rect[2])), clampY(Math.ceil(pick.rect[3])),
    ],
    world: [pick.worldW, pick.worldH],
    screen: [pick.w, pick.h],
    candidates: list.slice(0, 8).map((q) => ({ world: [q.worldW, q.worldH], rect: q.rect })),
  };
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
let failed = false;
const summary = { bloom: null, clearcolor: null, spritesheet: null };
try {
  await new Promise((r) => server.listen(PORT, r));

  // ① F8 壁纸 bloom：同一壁纸两档对照。
  const sc = sceneOf(ID);
  const bloomField = sc.general?.bloom;
  console.log(`\n===== ① F8 壁纸 bloom =====`);
  console.log(`[v081] 壁纸=${ID}  场景=${sc.general?.orthogonalprojection?.width}×${sc.general?.orthogonalprojection?.height}`
    + `  对象数=${(sc.objects ?? []).length}  general.bloom=${JSON.stringify(bloomField)}`
    + `  bloomstrength=${JSON.stringify(sc.general?.bloomstrength)}  bloomthreshold=${JSON.stringify(sc.general?.bloomthreshold)}`);
  console.log(`[v081] 视口 CSS ${VIEW.w}×${VIEW.h}  对照=同一壁纸（服务端把 general.bloom 改成 false）  应用级 Glow=off`);
  let on = null;
  let off = null;
  if (bloomField !== true) {
    console.log(`${RED}[FAIL]${RST} 壁纸 ${ID} 的 scene.json 没有 general.bloom=true ⇒ 本判据无从对照`);
    failed = true;
  } else {
    on = await runVariant({ label: 'bloom-on', id: ID, view: VIEW, cdpPort: CDP_PORT });
    off = await runVariant({ label: 'bloom-off', id: ID, view: VIEW, noBloom: true, cdpPort: CDP_PORT + 1 });
    for (const r of [on, off]) {
      if (!r.ok) { console.log(`${RED}[FAIL]${RST} ${r.label} 渲染失败：${r.fail}`); failed = true; continue; }
      if (r.ready?.ok !== true) {
        console.log(`${RED}[FAIL]${RST} ${r.label} harness 报告 render 未成功：${JSON.stringify(r.ready)}`);
        failed = true;
      }
      if (r.size[0] !== VIEW.w || r.size[1] !== VIEW.h) {
        console.log(`${YEL}[WARN]${RST} ${r.label} 截图尺寸=${r.size.join('×')}（期望 ${VIEW.w}×${VIEW.h}）`);
      }
      for (const e of r.errors.slice(0, 5)) console.log(`${YEL}[WARN]${RST} ${r.label} 页面错误：${e}`);
    }
    if (!on.ok || !off.ok) {
      console.log(`${RED}[FAIL]${RST} bloom 两档渲染未完成，无法比较`);
      failed = true;
    } else {
      const onImg = decodePng(on.png);
      const offImg = decodePng(off.png);
      const onStats = brightStats(onImg, LUMA_THRESHOLD);
      const offStats = brightStats(offImg, LUMA_THRESHOLD);
      const delta = onStats.ratio - offStats.ratio;
      writeFileSync(join(OUT, `${TAG}-bloom-on.png`), on.png);
      writeFileSync(join(OUT, `${TAG}-bloom-off.png`), off.png);

      console.log(`\n===== 判据：壁纸 bloom 亮部像素占比（luma>${LUMA_THRESHOLD}）=====`);
      console.log(`  bloom 开启：${onStats.brightPixels}/${onStats.size[0] * onStats.size[1]}`
        + ` = ${(onStats.ratio * 100).toFixed(3)}%  平均 luma=${onStats.meanLuma.toFixed(2)}`);
      console.log(`  bloom 关闭：${offStats.brightPixels}/${offStats.size[0] * offStats.size[1]}`
        + ` = ${(offStats.ratio * 100).toFixed(3)}%  平均 luma=${offStats.meanLuma.toFixed(2)}`);
      console.log(`  差值（开启 − 关闭）= ${(delta * 100).toFixed(3)} 个百分点（要求 ≥ ${(MIN_RATIO_DELTA * 100).toFixed(2)}）`);
      if (delta < MIN_RATIO_DELTA) {
        console.log(`${RED}[FAIL]${RST} 壁纸 bloom 未产生足够的亮部增量：delta=${(delta * 100).toFixed(3)}% < ${(MIN_RATIO_DELTA * 100).toFixed(2)}%`);
        failed = true;
      } else {
        console.log(`${GRN}[PASS]${RST} 开启档亮部占比显著高于关闭档（差值 ${(delta * 100).toFixed(3)} 个百分点）`);
      }
      if (onStats.ratio < MIN_WITH_BLOOM_RATIO) {
        console.log(`${RED}[FAIL]${RST} 开启档亮部占比过低（${(onStats.ratio * 100).toFixed(3)}% < ${(MIN_WITH_BLOOM_RATIO * 100).toFixed(2)}%），判据无意义`);
        failed = true;
      } else {
        console.log(`${GRN}[PASS]${RST} 开启档亮部像素非空（${onStats.brightPixels} 个）`);
      }
      summary.bloom = {
        id: ID, view: VIEW, lumaThreshold: LUMA_THRESHOLD,
        minRatioDelta: MIN_RATIO_DELTA, minWithBloomRatio: MIN_WITH_BLOOM_RATIO,
        scene: { bloom: bloomField, bloomstrength: sc.general?.bloomstrength, bloomthreshold: sc.general?.bloomthreshold },
        on: { ...onStats, png: `${TAG}-bloom-on.png` },
        off: { ...offStats, png: `${TAG}-bloom-off.png` },
        delta,
        pass: !failed,
      };
    }
  }

  // ② F15 清屏色：四角像素 = general.clearcolor（2980088441 → #111418）。
  console.log(`\n===== ② F15 清屏色 =====`);
  const clearScene = sceneOf(CLEAR_ID);
  const clearRaw = clearScene?.general?.clearcolor;
  const cc = await runVariant({ label: 'clearcolor', id: CLEAR_ID, view: VIEW, cdpPort: CDP_PORT + 2 });
  if (!cc.ok) {
    console.log(`${RED}[FAIL]${RST} clearcolor 渲染失败：${cc.fail}`);
    failed = true;
  } else {
    if (cc.ready?.ok !== true) {
      console.log(`${RED}[FAIL]${RST} clearcolor harness 报告 render 未成功：${JSON.stringify(cc.ready)}`);
      failed = true;
    }
    for (const e of cc.errors.slice(0, 5)) console.log(`${YEL}[WARN]${RST} clearcolor 页面错误：${e}`);
    const img = decodePng(cc.png);
    writeFileSync(join(OUT, `${TAG}-clearcolor.png`), cc.png);
    const corners = [
      ['左上', 2, 2], ['右上', img.width - 3, 2],
      ['左下', 2, img.height - 3], ['右下', img.width - 3, img.height - 3],
    ];
    const samples = corners.map(([where, x, y]) => ({ where, xy: [x, y], rgb: pixelAt(img, x, y) }));
    const hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
    console.log(`  壁纸=${CLEAR_ID}  general.clearcolor=${JSON.stringify(clearRaw)}  期望 ${hex(CLEAR_RGB)}（±${CLEAR_TOL}）`);
    for (const s of samples) console.log(`  ${s.where} (${s.xy.join(',')}) = ${hex(s.rgb)}`);
    const badCorners = samples.filter((s) => s.rgb.some((v, i) => Math.abs(v - CLEAR_RGB[i]) > CLEAR_TOL));
    const clearOk = badCorners.length === 0 && img.width === VIEW.w && img.height === VIEW.h;
    if (!clearOk) {
      console.log(`${RED}[FAIL]${RST} 角落像素偏离清屏色 ${hex(CLEAR_RGB)}：`
        + (badCorners.length ? badCorners.map((s) => `${s.where}=${hex(s.rgb)}`).join(' ') : `截图尺寸 ${img.width}×${img.height} ≠ ${VIEW.w}×${VIEW.h}`));
      failed = true;
    } else {
      console.log(`${GRN}[PASS]${RST} 四角均为清屏色（容差 ±${CLEAR_TOL}）`);
    }
    summary.clearcolor = {
      id: CLEAR_ID, view: VIEW, clearcolorRaw: clearRaw,
      expected: CLEAR_RGB, tol: CLEAR_TOL, samples, size: [img.width, img.height],
      png: `${TAG}-clearcolor.png`, pass: clearOk,
    };
  }

  // ③ F13 image 精灵表：对照档删材质 combos.spritesheet（= 改动前整表渲染）。
  // 判据：图标区域亮行组 1（单帧）vs ≥3（整表三帧竖排）；luma 方差（brief 判据）作辅助。
  console.log(`\n===== ③ F13 image 精灵表帧 UV =====`);
  console.log(`  壁纸=${SPRITE_ID}  视口 ${SPRITE_VIEW.w}×${SPRITE_VIEW.h}（竖长 → cover 1:1 取景，图标约 50px）`);
  const spriteAfter = await runVariant({ label: 'sprite-after', id: SPRITE_ID, view: SPRITE_VIEW, cdpPort: CDP_PORT + 3 });
  const spriteBefore = await runVariant({ label: 'sprite-before', id: SPRITE_ID, view: SPRITE_VIEW, stripSpritesheet: true, cdpPort: CDP_PORT + 4 });
  let spritePass = true;
  if (!spriteAfter.ok || !spriteBefore.ok) {
    console.log(`${RED}[FAIL]${RST} spritesheet 两档渲染失败：${spriteAfter.fail ?? ''} ${spriteBefore.fail ?? ''}`);
    failed = true;
  } else {
    for (const r of [spriteAfter, spriteBefore]) {
      if (r.ready?.ok !== true) {
        console.log(`${RED}[FAIL]${RST} ${r.label} harness 报告 render 未成功：${JSON.stringify(r.ready)}`);
        failed = true;
      }
      for (const e of r.errors.slice(0, 5)) console.log(`${YEL}[WARN]${RST} ${r.label} 页面错误：${e}`);
    }
    const afterImg = decodePng(spriteAfter.png);
    const beforeImg = decodePng(spriteBefore.png);
    writeFileSync(join(OUT, `${TAG}-sprite-after.png`), spriteAfter.png);
    writeFileSync(join(OUT, `${TAG}-sprite-before.png`), spriteBefore.png);
    const icon = findSpriteIconRect(spriteAfter.quads, SPRITE_VIEW);
    if (!icon.rect) {
      console.log(`${RED}[FAIL]${RST} 找不到精灵表图标 quad（scene.json 256×256 的对象）。候选：`
        + JSON.stringify(icon.candidates));
      failed = true;
      spritePass = false;
    } else {
      const aStats = regionLumaStats(afterImg, icon.rect);
      const bStats = regionLumaStats(beforeImg, icon.rect);
      const diff = regionMeanAbsDiff(afterImg, beforeImg, icon.rect);
      const aBands = brightRowGroups(afterImg, icon.rect, { threshold: SPRITE_BRIGHT_LUMA, minPx: SPRITE_BRIGHT_MIN_PX });
      const bBands = brightRowGroups(beforeImg, icon.rect, { threshold: SPRITE_BRIGHT_LUMA, minPx: SPRITE_BRIGHT_MIN_PX });
      console.log(`  图标 quad：world=${icon.world.join('×')}  屏上≈${icon.screen.map((v) => v.toFixed(1)).join('×')}px`
        + `  区域=[${aStats.rect.join(',')}]  ${aStats.pixels}px`);
      console.log(`  单帧（after） luma 方差=${aStats.variance.toFixed(2)}  sd=${aStats.stdDev.toFixed(2)}  平均=${aStats.meanLuma.toFixed(2)}`
        + `  亮行组=${aBands.count} ${JSON.stringify(aBands.groups)}`);
      console.log(`  整表（before）luma 方差=${bStats.variance.toFixed(2)}  sd=${bStats.stdDev.toFixed(2)}  平均=${bStats.meanLuma.toFixed(2)}`
        + `  亮行组=${bBands.count} ${JSON.stringify(bBands.groups)}`);
      console.log(`  after/before 方差比=${(bStats.variance > 0 ? aStats.variance / bStats.variance : Infinity).toFixed(3)}`
        + `（要求 ≤ ${SPRITE_MAX_BEFORE_RATIO}）  before↔after 平均逐像素差=${diff.toFixed(2)}`);
      // ① 结构判据（主）：整表三帧竖排 ⇒ ≥3 个亮行组；单帧 ⇒ 1 个亮行组。
      if (aBands.count !== 1) {
        console.log(`${RED}[FAIL]${RST} 单帧渲染的图标区域应只有 1 个亮行组，实际 ${aBands.count} 个（整表三帧未切开？）`);
        failed = true;
        spritePass = false;
      }
      if (!(bBands.count >= 3)) {
        console.log(`${RED}[FAIL]${RST} 整表对照档应呈现 ≥3 个亮行组（3 帧竖排），实际 ${bBands.count} 个 ⇒ 对照档失效，本判据无意义`);
        failed = true;
        spritePass = false;
      }
      // ② 方差判据（辅助，brief 指定）：单帧方差 ≤ 整表 × 系数 且 ≤ 绝对上限。
      if (bStats.variance <= 0) {
        console.log(`${RED}[FAIL]${RST} 整表对照档方差为 0，判据无意义`);
        failed = true;
        spritePass = false;
      }
      if (!(aStats.variance <= bStats.variance * SPRITE_MAX_BEFORE_RATIO)) {
        console.log(`${RED}[FAIL]${RST} 单帧方差未显著低于整表：${aStats.variance.toFixed(2)} > ${(bStats.variance * SPRITE_MAX_BEFORE_RATIO).toFixed(2)}`);
        failed = true;
        spritePass = false;
      }
      if (!(aStats.variance <= SPRITE_MAX_VARIANCE)) {
        console.log(`${RED}[FAIL]${RST} 单帧方差超过绝对上限：${aStats.variance.toFixed(2)} > ${SPRITE_MAX_VARIANCE}`);
        failed = true;
        spritePass = false;
      }
      if (spritePass) {
        console.log(`${GRN}[PASS]${RST} 图标区域只含当前帧（亮行组 1 vs 整表 ${bBands.count}；方差显著更低）`);
      }
      summary.spritesheet = {
        id: SPRITE_ID, view: SPRITE_VIEW, iconRect: aStats.rect, iconWorld: icon.world,
        maxVariance: SPRITE_MAX_VARIANCE, maxBeforeRatio: SPRITE_MAX_BEFORE_RATIO,
        brightLuma: SPRITE_BRIGHT_LUMA, brightMinPx: SPRITE_BRIGHT_MIN_PX,
        after: { ...aStats, brightBands: aBands.groups, png: `${TAG}-sprite-after.png` },
        before: { ...bStats, brightBands: bBands.groups, png: `${TAG}-sprite-before.png` },
        varianceRatio: bStats.variance > 0 ? aStats.variance / bStats.variance : null,
        meanAbsDiff: diff, pass: spritePass,
      };
    }
  }

  writeFileSync(join(OUT, `${TAG}-summary.json`), JSON.stringify({
    tag: TAG, pass: !failed, criteria: summary,
  }, null, 2));
  console.log(`\n产物：${OUT}`);
} catch (e) {
  console.error('ERROR:', e?.stack ?? e?.message ?? e);
  process.exitCode = 1;
} finally {
  server.close();
}
if (failed) process.exitCode = 1;
