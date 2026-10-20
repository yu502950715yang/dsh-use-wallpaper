// v0.8.1 缺口修复的端到端像素判据（当前覆盖 F8：壁纸级 bloom）。
//
// 目的：在**真实 WebGL**（headless Edge，SwiftShader 软件光栅化）下走生产装配入口
// `createThreeSceneRenderer().render(id, canvas)`，对同一张真实壁纸（缺省 2454403969，
// 作者 scene.json 的 general.bloom=true / bloomstrength=0.98）做**同页两档对照**：
//   ① 壁纸 bloom 开启（原始 scene.json）
//   ② 壁纸 bloom 关闭（服务端把 scene.json 的 general.bloom 改成 false 后再喂给页面）
// 两档关闭应用级 Glow（URL `glow=off`）并冻结动画时钟，逐像素统计 luma>200 的亮部占比；
// 判据：开启档的亮部占比必须显著高于关闭档（阈值常量见 LUMA_THRESHOLD / MIN_RATIO_DELTA）。
//
// 为什么用像素而不是读 stage 状态：判据要证明「scene.json → 解析 → 装配 → 渲染」整条链路生效，
// 而不是某个中间对象存在。对照档只改 scene.json 字段（与 git 工作树无关，不动源码）。
//
// 用法：
//   node e2e/verify/verify-v081-gaps.mjs [--id=2454403969] [--vw=1280] [--vh=720]
//        [--tag=v081] [--luma=200]
// 环境变量等价形式：ID / VW / VH / TAG / LUMA；另需 WE_WORKSHOP（壁纸目录）与 WE_ASSETS（WE 安装目录）。
// 退出码：0 = 判据通过；1 = 判据失败或脚本异常（CI 门禁）。
//
// 产物：e2e/.out/v081-gaps/<tag>-bloom-on.png / <tag>-bloom-off.png / <tag>-summary.json
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
const WINDOW = { w: 1400, h: 900 };
const TAG = String(argOf('tag', process.env.TAG ?? 'v081'));
const OUT = join(OUT_DIR, 'v081-gaps');
mkdirSync(OUT, { recursive: true });

// ── 判据常量（实现时用 2454403969 标定，见 task-6-report）────────────────────────
// luma = 0.299R + 0.587G + 0.114B；>200 视为「亮部」。2454403969 的 bloom 缺省参数
// （threshold=0.65 / strength=0.98）会把 ≥0.65 的区域抬过 200，关闭档则不会。
const LUMA_THRESHOLD = Math.max(0, Math.min(255, Number(argOf('luma', process.env.LUMA ?? 200))));
// 开启档亮部占比必须比关闭档高出至少这么多（占全图比例）。标定：2454403969 实测
// 2.245% vs 0.604% ⇒ delta≈1.64pp（同一时钟相位）；留 ~2× 裕度取 0.8pp。
const MIN_RATIO_DELTA = Number(process.env.MIN_RATIO_DELTA ?? 0.008);
// 开启档亮部占比下限：防止「两档都几乎全黑、差值恰好达标」的假阳性。
const MIN_WITH_BLOOM_RATIO = Number(process.env.MIN_WITH_BLOOM_RATIO ?? 0.005);

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

/** 渲染一档（bloom on/off）并截图。每档独立 Edge 进程，避免模块态/GL 上下文跨档污染。 */
async function runVariant(bloomOn, cdpPort) {
  const profile = join(OUT, `.edge-${TAG}-bloom${bloomOn ? 'on' : 'off'}`);
  const logs = [];
  let edge, ws, msgId = 0;
  const pending = new Map();
  let page = null;
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
    serveNoBloom = !bloomOn;
    edge = spawn(EDGE, [
      '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
      `--window-size=${WINDOW.w},${WINDOW.h}`, '--force-device-scale-factor=1',
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
      width: WINDOW.w, height: WINDOW.h, deviceScaleFactor: 1, mobile: false,
    });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SHIM });
    // 应用级 Glow 关闭（隔离壁纸 bloom 单一变量）；粒子整层跳过（相位确定性；本壁纸也无粒子）。
    await send('Page.navigate', {
      url: `http://127.0.0.1:${PORT}/?id=${ID}&vw=${VIEW.w}&vh=${VIEW.h}&glow=off&wasm=none`,
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
      format: 'png', clip: { x: 0, y: 0, width: VIEW.w, height: VIEW.h, scale: 1 }, captureBeyondViewport: false,
    });
    const buf = Buffer.from(shot.data, 'base64');
    const dims = pngDims(buf);
    const pageLogs = await json('window.__fxLogs ?? []');
    const errors = [...logs, ...(Array.isArray(pageLogs) ? pageLogs : [])]
      .filter((l) => l.level === 'error' || /shader 编译\/链接失败/.test(String(l.text)))
      .map((l) => String(l.text).slice(0, 300));
    return { ok: true, bloomOn, ready, size: [dims.w, dims.h], png: buf, errors };
  } catch (e) {
    return { ok: false, bloomOn, fail: e?.message ?? String(e) };
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

// ── 主流程 ────────────────────────────────────────────────────────────────────
let failed = false;
try {
  await new Promise((r) => server.listen(PORT, r));
  const sc = sceneOf(ID);
  const bloomField = sc.general?.bloom;
  console.log(`[v081] 壁纸=${ID}  场景=${sc.general?.orthogonalprojection?.width}×${sc.general?.orthogonalprojection?.height}`
    + `  对象数=${(sc.objects ?? []).length}  general.bloom=${JSON.stringify(bloomField)}`
    + `  bloomstrength=${JSON.stringify(sc.general?.bloomstrength)}  bloomthreshold=${JSON.stringify(sc.general?.bloomthreshold)}`);
  console.log(`[v081] 视口 CSS ${VIEW.w}×${VIEW.h}  对照=同一壁纸（服务端把 general.bloom 改成 false）  应用级 Glow=off`);
  if (bloomField !== true) {
    console.log(`${RED}[FAIL]${RST} 壁纸 ${ID} 的 scene.json 没有 general.bloom=true ⇒ 本判据无从对照`);
    throw new Error('scene.json 缺 general.bloom=true');
  }

  const on = await runVariant(true, CDP_PORT);
  const off = await runVariant(false, CDP_PORT + 1);
  for (const [label, r] of [['bloom-on', on], ['bloom-off', off]]) {
    if (!r.ok) { console.log(`${RED}[FAIL]${RST} ${label} 渲染失败：${r.fail}`); failed = true; continue; }
    if (r.ready?.ok !== true) {
      console.log(`${RED}[FAIL]${RST} ${label} harness 报告 render 未成功：${JSON.stringify(r.ready)}`);
      failed = true;
    }
    if (r.size[0] !== VIEW.w || r.size[1] !== VIEW.h) {
      console.log(`${YEL}[WARN]${RST} ${label} 截图尺寸=${r.size.join('×')}（期望 ${VIEW.w}×${VIEW.h}）`);
    }
    for (const e of r.errors.slice(0, 5)) console.log(`${YEL}[WARN]${RST} ${label} 页面错误：${e}`);
  }

  if (!on.ok || !off.ok) throw new Error('两档渲染未完成，无法比较');

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
  writeFileSync(join(OUT, `${TAG}-summary.json`), JSON.stringify({
    id: ID, view: VIEW, lumaThreshold: LUMA_THRESHOLD,
    minRatioDelta: MIN_RATIO_DELTA, minWithBloomRatio: MIN_WITH_BLOOM_RATIO,
    scene: { bloom: bloomField, bloomstrength: sc.general?.bloomstrength, bloomthreshold: sc.general?.bloomthreshold },
    on: { ...onStats, png: `${TAG}-bloom-on.png` },
    off: { ...offStats, png: `${TAG}-bloom-off.png` },
    delta, pass: !failed,
  }, null, 2));
  console.log(`\n产物：${OUT}`);
} catch (e) {
  console.error('ERROR:', e?.stack ?? e?.message ?? e);
  process.exitCode = 1;
} finally {
  server.close();
}
if (failed) process.exitCode = 1;
