// v0.8.2 F18：效果 shader 全局 uniform（g_PointerPosition）的端到端像素验证。
//
// 被测素材：3780477933（spider man bnd 2）的 dot_matrix_mobile_fix 效果——真实 shader 里
// `vec2 mouse = g_PointerPosition;`，鼠标影响中心应跟随指针。走生产入口
// `createThreeSceneRenderer().render()`（lib 编译产物），用真实 scene.pkg 资源。
//
// 两个模式（--mode=asis|defaults|both，默认 both）：
//   asis     —— 素材原样。该效果在**本库与 WE 里都被作者常量关闭**：`Default Circle Size=-1`
//               ⇒ fragLV 恒 0；scene 又没给 g_Texture2（opacitymask，材质默认 util/white）⇒ 不透明度 0。
//               因此像素差天然为 0；本模式用来钉住「uniform 确实在变、但没有可见输出」这一事实。
//   defaults —— 只替换**服务给页面的 scene.json 字节**（壁纸目录只读）：把该效果的
//               `Default Circle Size` 恢复成 shader 默认 0.3、`textures` 给出材质默认
//               `util/white` 作 g_Texture2 ⇒ 效果可见，指针 A/B 的像素差即证明 uniform→像素链路。
//
// 判据：
//   1. 两帧的 runner 材质里 `g_PointerPosition.value` 必须分别等于 (0.2,0.2) / (0.8,0.8)；
//   2. asis 像素差 ≈ 0（changedRatio < 0.1%）；defaults 像素差 ≥ 阈值（changedRatio ≥ 0.5%）。
//
// 用法：node e2e/verify/verify-pointer-uniform.mjs [--mode=both] [--port=9843] [--cdp-port=9251]
// 环境：WE_WORKSHOP / WE_ASSETS（见 e2e/config.mjs）。产物在 e2e/.out/pointer-uniform/。
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
const OUT = join(OUT_DIR, 'pointer-uniform');
mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq < 0 ? true : hit.slice(eq + 1);
};
const ID = '3780477933';
const MODES = String(argOf('mode', 'both')) === 'both' ? ['asis', 'defaults'] : [String(argOf('mode', 'both'))];
const PORT = httpPort(9843);
const CDP_PORT = resolveCdpPort(9251);
const EDGE = resolveEdgePath();
const WE_ASSETS = join(WE_ASSETS_ROOT, 'assets');
const STATIC_DIR = join(repo, 'dist', 'static');
const VIEW = { w: 1280, h: 720 };
const WINDOW = { w: 1280, h: 720 };
const POINTER_A = [0.2, 0.2];
const POINTER_B = [0.8, 0.8];
const THRESHOLD_DEFAULTS_CHANGED = 0.005;
const ASIS_NOISE_MAX = 0.001;

// ── scene.pkg 读取（与 verify-hidpi-object-rt.mjs 同实现）──
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
  const files = new Map();
  for (const e of entries) files.set(e.name, buf.subarray(dataStart + e.off, dataStart + e.off + e.size));
  return files;
}
const PKG = readPkg(ID);
const SCENE_RAW = PKG.get('scene.json');
if (!SCENE_RAW) throw new Error('scene.pkg 内缺 scene.json');

// defaults 模式：把 dot_matrix 效果恢复成「shader 默认圆点尺寸 + 材质默认白 mask」。
function patchSceneForDefaults() {
  const sc = JSON.parse(SCENE_RAW.toString('utf8'));
  const patched = [];
  for (const o of sc.objects ?? []) {
    for (const fx of o.effects ?? []) {
      if (!String(fx.file).includes('dot_matrix')) continue;
      for (const p of fx.passes ?? []) {
        p.constantshadervalues = { ...(p.constantshadervalues ?? {}), 'Default Circle Size': 0.3 };
        p.textures = [null, null, 'util/white'];
        patched.push({ object: o.id, pass: p.id, size: 0.3, mask: 'util/white' });
      }
    }
  }
  if (patched.length === 0) throw new Error('scene.json 里找不到 dot_matrix 效果');
  return { text: JSON.stringify(sc), patched };
}
let currentMode = 'asis';
const SCENE_DEFAULTS = patchSceneForDefaults();

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.tex': 'application/octet-stream', '.png': 'image/png', '.frag': 'text/plain', '.vert': 'text/plain', '.ps1': 'application/octet-stream' };

const bundle = (await esbuild.build({
  entryPoints: [join(here, '..', 'harness', 'harness-object-effects-entry.mjs')],
  bundle: true, format: 'esm', target: 'es2022', write: false, logLevel: 'silent',
})).outputFiles[0].text;

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#000;overflow:hidden}canvas{display:block}</style>
</head><body><script type="module" src="/harness.js"></script></body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = decodeURIComponent(url.pathname);
  const send = (body, type, status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
  if (p === '/' || p === '/index.html') return send(HTML, 'text/html; charset=utf-8');
  if (p === '/harness.js') return send(bundle, 'text/javascript; charset=utf-8');
  if (p.startsWith('/wallpapers/static/')) {
    const f = join(STATIC_DIR, p.slice('/wallpapers/static/'.length));
    if (!existsSync(f)) return send('nf', 'text/plain', 404);
    return send(readFileSync(f), MIME[extname(f)] ?? 'application/octet-stream');
  }
  if (p === '/wallpapers/particle-texture') {
    const name = url.searchParams.get('name') ?? '';
    const f = join(WE_ASSETS, 'materials', name + '.tex');
    if (!existsSync(f)) return send('nf', 'text/plain', 404);
    return send(readFileSync(f), 'application/octet-stream');
  }
  const m = /^\/wallpapers\/scene\/([^/]+)\/asset$/.exec(p);
  if (m) {
    const name = url.searchParams.get('name') ?? '';
    if (name === 'scene.json') {
      return send(currentMode === 'defaults' ? SCENE_DEFAULTS.text : SCENE_RAW.toString('utf8'), 'application/json');
    }
    const entry = PKG.get(name);
    if (!entry) return send('nf', 'text/plain', 404);
    return send(entry, MIME[extname(name)] ?? 'application/octet-stream');
  }
  return send('not found', 'text/plain', 404);
});

// ── CDP ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const pngDims = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

// 最小 RGB PNG 编码（只用于 diff 差分图）。
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

async function runMode(mode) {
  currentMode = mode;
  const profile = join(OUT, `.edge-${mode}`);
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
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '') };
    return r.result?.value;
  };
  const json = async (expr) => {
    const raw = await evalJS(`JSON.stringify(${expr})`);
    return typeof raw === 'string' ? JSON.parse(raw) : { __err: raw?.__err ?? String(raw) };
  };
  try {
    edge = spawn(EDGE, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
      `--window-size=${WINDOW.w},${WINDOW.h}`, '--force-device-scale-factor=1',
      '--enable-unsafe-swiftshader', '--disable-gpu-sandbox',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
    ], { stdio: 'ignore' });
    const t1 = Date.now();
    let up = false;
    while (Date.now() - t1 < 30000) {
      try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) { up = true; break; } } catch { /* retry */ }
      await sleep(400);
    }
    if (!up) throw new Error('CDP 未就绪（30s）');
    const page = ((await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page'));
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
        logs.push({ kind: 'cdp-console', level: msg.params.type, text: (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ') });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        logs.push({ kind: 'cdp-exception', level: 'error', text: msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? '' });
      }
    };
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: WINDOW.w, height: WINDOW.h, deviceScaleFactor: 1, mobile: false });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SHIM });
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?id=${ID}&vw=${VIEW.w}&vh=${VIEW.h}&wasm=none` });
    const t0 = Date.now();
    let ready = null;
    while (Date.now() - t0 < 90000) {
      const r = await evalJS('window.__fxReady ? JSON.stringify(window.__fxReady) : null');
      if (typeof r === 'string' && r) { ready = JSON.parse(r); break; }
      await sleep(300);
    }
    if (!ready) throw new Error('harness 未就绪（90s 超时）');
    const vp = await json('window.__fxApplyViewport()');
    const stats = await json('window.__fxStats()');
    if (stats?.view?.[0] !== VIEW.w || stats?.innerW !== WINDOW.w) {
      throw new Error(`窗口/画布尺寸不符：${JSON.stringify(stats)}`);
    }
    // 冻结动画时钟：两帧只有指针不同（g_Time 恒 5s）。
    await evalJS('window.__vnow = 5000');
    await sleep(900);

    const uniformExpr = `(() => {
      const st = window.__stage;
      if (!st) return null;
      const out = {};
      for (const [id, r] of st.debugRunners()) {
        const mats = r.materials;
        const m = mats && mats.get ? mats.get('0:0') : null;
        out[id] = m ? {
          g_PointerPosition: m.uniforms.g_PointerPosition ? m.uniforms.g_PointerPosition.value : null,
          g_ParallaxPosition: m.uniforms.g_ParallaxPosition ? m.uniforms.g_ParallaxPosition.value : null,
        } : null;
      }
      return out;
    })()`;
    const setPointer = (fx, fy) => evalJS(`(() => {
      const ev = new PointerEvent('pointermove', {
        clientX: ${fx} * window.innerWidth, clientY: ${fy} * window.innerHeight, bubbles: true,
      });
      window.dispatchEvent(ev);
      return { clientX: ev.clientX, clientY: ev.clientY, innerW: window.innerWidth, innerH: window.innerHeight };
    })()`);
    const shot = async () => {
      const s = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: VIEW.w, height: VIEW.h, scale: 1 }, captureBeyondViewport: false });
      const buf = Buffer.from(s.data, 'base64');
      return { buf, dims: pngDims(buf) };
    };

    const dispatchedA = await setPointer(POINTER_A[0], POINTER_A[1]);
    await sleep(1400);
    const uniformsA = await json(uniformExpr);
    const chainsA = await json('window.__fxChains()');
    const shotA = await shot();

    const dispatchedB = await setPointer(POINTER_B[0], POINTER_B[1]);
    await sleep(1400);
    const uniformsB = await json(uniformExpr);
    const chainsB = await json('window.__fxChains()');
    const shotB = await shot();

    const imgA = decodePng(shotA.buf);
    const imgB = decodePng(shotB.buf);
    const diff = meanAbsDiff(imgA, imgB);
    const pageLogs = await json('window.__fxLogs ?? []');
    const consErrs = [...logs, ...(Array.isArray(pageLogs) ? pageLogs : [])].filter((l) => l.level === 'error');

    const uniformOf = (u) => (u && typeof u === 'object' ? Object.values(u)[0] : null);
    const uA = uniformOf(uniformsA)?.g_PointerPosition ?? null;
    const uB = uniformOf(uniformsB)?.g_PointerPosition ?? null;
    const pointerOk = Array.isArray(uA) && Math.abs(uA[0] - POINTER_A[0]) < 1e-3 && Math.abs(uA[1] - POINTER_A[1]) < 1e-3
      && Array.isArray(uB) && Math.abs(uB[0] - POINTER_B[0]) < 1e-3 && Math.abs(uB[1] - POINTER_B[1]) < 1e-3;
    const pixelsOk = mode === 'asis'
      ? diff.changedRatio < ASIS_NOISE_MAX
      : diff.changedRatio >= THRESHOLD_DEFAULTS_CHANGED;

    const prefix = join(OUT, mode);
    writeFileSync(`${prefix}-a.png`, shotA.buf);
    writeFileSync(`${prefix}-b.png`, shotB.buf);
    writeFileSync(`${prefix}-diff.png`, diffPng(imgA, imgB));
    const summary = {
      mode, id: ID, view: VIEW, window: WINDOW,
      pointerness: { a: POINTER_A, b: POINTER_B, dispatchedA, dispatchedB },
      scenePatch: mode === 'defaults' ? SCENE_DEFAULTS.patched : null,
      uniforms: { a: uniformsA, b: uniformsB },
      chains: { a: chainsA, b: chainsB },
      screenshots: {
        a: { path: `${prefix}-a.png`, w: shotA.dims.w, h: shotA.dims.h },
        b: { path: `${prefix}-b.png`, w: shotB.dims.w, h: shotB.dims.h },
        diff: `${prefix}-diff.png`,
      },
      diff,
      pointerOk, pixelsOk,
      consoleErrors: consErrs.slice(0, 10),
    };
    writeFileSync(`${prefix}-summary.json`, JSON.stringify(summary, null, 2));
    return { ok: pointerOk && pixelsOk, summary };
  } catch (e) {
    return { ok: false, mode, fail: e?.message ?? String(e) };
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    edge?.kill();
  }
}

let failed = 0;
try {
  await new Promise((r) => server.listen(PORT, r));
  console.log(`[pointer-uniform] 壁纸=${ID}  模式=${MODES.join('+')}  端口=${PORT}`);
  const results = [];
  for (const mode of MODES) {
    const r = await runMode(mode);
    results.push(r.ok ? { mode, ok: true, summary: r.summary } : { mode, ok: false, fail: r.fail ?? null });
    if (!r.ok) failed++;
  }
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ id: ID, modes: MODES, results }, null, 2));
  for (const r of results) {
    if (!r.ok) continue;
    const s = r.summary;
    console.log(`\n[${s.mode}] 均匀值 A=${JSON.stringify(s.uniforms?.a)} B=${JSON.stringify(s.uniforms?.b)}`);
    console.log(`[${s.mode}] 差分：meanAbs=${s.diff.meanAbs.toFixed(4)} changed=${s.diff.changed}（${(s.diff.changedRatio * 100).toFixed(2)}%）max=${s.diff.max} bbox=${JSON.stringify(s.diff.bbox)}`);
    console.log(`[${s.mode}] 截图：${s.screenshots.a.path} / ${s.screenshots.b.path} / ${s.screenshots.diff}`);
    console.log(`[${s.mode}] 判定：uniform=${s.pointerOk ? 'PASS' : 'FAIL'} pixels=${s.pixelsOk ? 'PASS' : 'FAIL'}`);
  }
  console.log(`\n[pointer-uniform] ${failed === 0 ? 'PASS' : 'FAIL'}（${results.length - failed}/${results.length} 模式通过）`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  server.close();
}
