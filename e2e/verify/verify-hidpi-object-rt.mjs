// HiDPI（devicePixelRatio > 1）下对象级 RT 局部相机修复的端到端像素验证。
//
// 目的：在**真实 WebGL**（headless Edge，SwiftShader 软件光栅化）下，对**同一张 scene 壁纸**、
// **同一动画相位**，分别在 dpr=1 与 dpr=2 渲染并截图，给出「修复后两者一致」的像素证据。
//
// ⚠️ 与既有 research/verify-object-effects.mjs 的差别（这正是此前漏检该缺陷的原因）：
//   1. 本脚本显式设置 deviceScaleFactor（Edge `--force-device-scale-factor=<dpr>` +
//      CDP `Emulation.setDeviceMetricsOverride({deviceScaleFactor})`），使 window.devicePixelRatio
//      = dpr → player 按 dpr 放大对象 RT，从而真正走到出问题的那条路径；
//   2. 本脚本**冻结动画时钟**（`Page.addScriptToEvaluateOnNewDocument` 把 performance.now 换成
//      可控虚拟时钟，player 的 `elapsedSeconds()` 正是 (performance.now - startedAt)/1000），
//      使两次渲染落在**同一 g_Time**上 → 两图可直接逐像素比较（既有脚本只能同长度等待 + 帧间差分）。
//      `--no-particles` 变体把粒子 spec 返回 404（等价「该壁纸没有粒子对象」），并给页面加
//      `wasm=none`（假 loader，粒子整层跳过），排除粒子每帧随机推进带来的相位噪声
//      （粒子由 RAF dt 驱动，不受虚拟时钟约束）。
//
// ⚠️ 装配路径：harness 入口 `harness-object-effects-entry.mjs` 调用的是**生产入口**
//    `createThreeSceneRenderer()`（`lib/client/three-renderer.js`）——isolate 尺寸预算、
//    隔离装配、ObjectEffectStage 接线全部由生产代码完成，脚本只做只读观测（观测口径也只用
//    生产公开 API：`player.isolatedObjects()` / `debugRunners()` / `player.camera`）。
//    此前 e2e 自己复制一套装配逻辑，导致「e2e 全绿但真机模糊」（见提交 3fd6b00）。
//
// 用法：
//   node e2e/verify/verify-hidpi-object-rt.mjs [--id=2683211654] [--dprs=1,2] [--phase=5]
//        [--no-particles] [--tag=post] [--out=hidpi-object-rt]
// 环境变量等价形式：ID / DPRS / PHASE / NO_PARTICLES=1 / TAG / OUT，
// 另需 WE_WORKSHOP（壁纸目录）与 WE_ASSETS（WE 安装目录）。
// 退出码：0 = 全部断言通过；1 = 有断言失败或脚本异常（CI 门禁）。
//
// 产物：e2e/.out/<out>/<tag>-dpr<d>.png（+ -t2.png 相位稳定性自检帧）与 <tag>-summary.json
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { decodePng, downsampleBox, meanAbsDiff, clampBands, bestZoom } from '../lib/hidpi-metrics.mjs';
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
const ID = String(argOf('id', process.env.ID ?? '2683211654'));
const DPRS = String(argOf('dprs', process.env.DPRS ?? '1,2')).split(',').map((s) => Number(s.trim()));
const PHASE = Number(argOf('phase', process.env.PHASE ?? 5));            // 冻结的动画时刻（秒）
const NO_PARTICLES = !!(argOf('no-particles', process.env.NO_PARTICLES === '1' ? true : false) || process.env.NO_PARTICLES === '1');
// --strip-effects：把 scene.json 里所有对象的 effects 清空后再喂给页面（**只改服务给页面的字节**，
// 与 git 工作树无关）。用作「无对象 RT」的**地板对照**：此时对象不隔离、由主相机直接渲染，
// 两 dpr 的差异只剩「画布缓冲分辨率不同（2560×1440 下采样 vs 原生 1280×720）」的采样差。
const STRIP_EFFECTS = !!(argOf('strip-effects', process.env.STRIP_EFFECTS === '1' ? true : false) || process.env.STRIP_EFFECTS === '1');
// --only-effect=<子串>：只保留 file 路径含该子串的效果（**诊断用**：逐个效果二分，
// 定位「哪个效果造成全图变化」）。空 = 不启用。
const ONLY_FX = String(argOf('only-effect', process.env.ONLY_EFFECT ?? ''));
const TAG = String(argOf('tag', process.env.TAG ?? 'post'));
const OUT = join(OUT_DIR, String(argOf('out', process.env.OUT ?? 'hidpi-object-rt')));
// --vclock=HH:MM[:SS]：可选。把**页面** new Date() 钉到该时刻（quickjs 时钟脚本的时间源），
// 并在装配完成（harness 赋 __vnow）后跨 +5s —— 用于确定性复现「文本变长 → 画布/quad 需重算」。
const VCLOCK = String(argOf('vclock', process.env.VCLOCK ?? ''));
// ★ 临时实验仪器透传（清晰度归因）：见 harness-object-effects-entry.mjs 顶部说明。
const RT_FIX = String(argOf('rt', process.env.RT ?? ''));
const RT_MAP = String(argOf('rtmap', process.env.RT_MAP ?? ''));
const MAG = String(argOf('mag', process.env.MAG ?? ''));
const RT_SAMPLES = String(argOf('rtsamples', process.env.RT_SAMPLES ?? ''));
const RT_DUMP = !!(argOf('rtdump', process.env.RTDUMP === '1' ? true : false) || process.env.RTDUMP === '1');
const EXP_QS = `${RT_FIX ? `&rt=${RT_FIX}` : ''}${RT_MAP ? `&rtmap=${RT_MAP}` : ''}${MAG ? `&mag=${MAG}` : ''}${RT_SAMPLES ? `&rtsamples=${RT_SAMPLES}` : ''}${RT_DUMP ? '&rtdump=1' : ''}`;
mkdirSync(OUT, { recursive: true });

const PORT = httpPort(9831);
const CDP_PORT = resolveCdpPort(9241);
const EDGE = resolveEdgePath();
const WALLPAPER_DIR = WE_WORKSHOP;
const WE_ASSETS = join(WE_ASSETS_ROOT, 'assets');
const STATIC_DIR = join(repo, 'dist', 'static');
// 画布/截图坐标系：固定 CSS 1280×720（窗口 1400×900）；截图裁到画布区域。
// dpr=2 时画布缓冲 = 2560×1440，截图应为 2560×1440（脚本会实测并自适应 clip.scale）。
const VIEW = { w: 1280, h: 720 };
const WINDOW = { w: 1400, h: 900 };

// 终端着色（FAIL 标红）——判定结果不依赖颜色（另有字面 `[FAIL]`/`[PASS]` 标记），
// 颜色只在真 TTY 下输出，避免重定向到日志文件时混入 ANSI 控制码。
const USE_COLOR = process.stdout.isTTY === true && !process.env.NO_COLOR;
const RED = USE_COLOR ? '\x1b[31m' : '';
const GRN = USE_COLOR ? '\x1b[32m' : '';
const RST = USE_COLOR ? '\x1b[0m' : '';

// ── scene.pkg 读取（与 research/verify-object-effects.mjs / scan-effect-multipass.mjs 同实现）──
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

function particleNames(id) {
  const sc = sceneOf(id);
  const names = new Set();
  for (const o of sc.objects ?? []) {
    if (typeof o.particle === 'string' && o.particle) names.add(o.particle);
    if (typeof o.image === 'string' && o.image.startsWith('particles/')) names.add(o.image);
  }
  return names;
}

// ── esbuild 打包 harness（只 import lib/client 生产编译产物；three 由 esbuild 解析）──
const bundle = (await esbuild.build({
  entryPoints: [join(here, '..', 'harness', 'harness-object-effects-entry.mjs')],
  bundle: true, format: 'esm', target: 'es2022', write: false, logLevel: 'silent',
  alias: { '@webgpu/glslang': join(here, '..', 'lib', 'stub-glslang.mjs') },
})).outputFiles[0].text;

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#000;overflow:hidden}canvas{display:block}</style>
</head><body><script type="module" src="/harness.js"></script></body></html>`;
const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.tex': 'application/octet-stream', '.png': 'image/png',
  '.frag': 'text/plain', '.vert': 'text/plain',
};
let noParticlesActive = false;
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
    const id = m[1];
    const name = url.searchParams.get('name') ?? '';
    const files = pkgOf(id);
    if (!files) return send('no pkg', 'text/plain', 404);
    if (noParticlesActive && particleNames(id).has(name)) return send('suppressed (variant: noparticles)', 'text/plain', 404);
    if (STRIP_EFFECTS && name === 'scene.json') {
      const sc = sceneOf(id);
      const stripped = { ...sc, objects: (sc.objects ?? []).map((o) => ({ ...o, effects: [] })) };
      return send(JSON.stringify(stripped), 'application/json');
    }
    if (ONLY_FX && name === 'scene.json') {
      const sc = sceneOf(id);
      const filtered = {
        ...sc,
        objects: (sc.objects ?? []).map((o) => ({
          ...o,
          effects: (o.effects ?? []).filter((fx) => String(fx.file).includes(ONLY_FX)),
        })),
      };
      // ★ 临时（本次空槽实验专用，跑完还原）：EMPTY_FLOWMASK=1 时把 effects/shake 的 passes[].textures
      // 截成 `[null]` —— 即「flowmask 槽（g_Texture1）未被提供」，用于在真实浏览器里验证
      // 「空 flowmask 槽 → 中灰（零位移）」这条修复路径（本库无天然实例：全库扫描 emptyFlow=0）。
      if (process.env.EMPTY_FLOWMASK === '1') {
        for (const o of filtered.objects) {
          for (const fx of o.effects ?? []) {
            if (!String(fx.file).includes('effects/shake')) continue;
            for (const p of fx.passes ?? []) p.textures = [null];
          }
        }
      }
      return send(JSON.stringify(filtered), 'application/json');
    }
    const entry = files.get(name);
    if (!entry) return send('nf', 'text/plain', 404);
    return send(entry, MIME[extname(name)] ?? 'application/octet-stream');
  }
  return send('not found', 'text/plain', 404);
});

// ── CDP ──────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 把 performance.now 换成可控虚拟时钟（页面最早时机注入）：
 *  player 的 elapsedSeconds() = (performance.now() - startedAt)/1000 → 设 __vnow 即钉住 g_Time。 */
const CLOCK_SHIM = `(() => {
  try {
    const orig = performance.now.bind(performance);
    let vnow = 0;                       // 默认常量 0：player 构造时 startedAt = 0
    let onArm = null;
    Object.defineProperty(window, '__vnow', {
      get: () => vnow, set: (v) => { vnow = Number(v) || 0; if (onArm) onArm(); }, configurable: true,
    });
    performance.now = () => vnow;
    window.__vnowRaw = () => orig();
    // 可选 --vclock：装配期页面时间 = 指定时刻（如 16:09:59），__vnow 被赋值后跳到 +5s。
    // emscripten 的 gettimeofday 走全局 Date.now() ⇒ quickjs 里的 new Date() 同步受影响。
    const m = /[?&]vclock=(\\d{1,2}):(\\d{2})(?::(\\d{2}))?/.exec(location.search);
    if (m) {
      const RealDate = Date;
      const base0 = new RealDate();
      base0.setHours(Number(m[1]), Number(m[2]), Number(m[3] || 0), 0);
      const base = base0.getTime();
      let armed = false, real0 = 0;
      const virtualNow = () => (armed ? base + 5000 + (RealDate.now() - real0) : base);
      class VDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(virtualNow()); else super(...a); }
        static now() { return virtualNow(); }
      }
      VDate.parse = RealDate.parse; VDate.UTC = RealDate.UTC;
      window.Date = VDate;
      window.__vclock = () => new RealDate(virtualNow()).toString();
      onArm = () => { if (!armed) { armed = true; real0 = RealDate.now(); } };
    }
  } catch (e) { /* 注入失败会在结果里体现为相位不稳定 */ }
})();`;

function pngDims(buf) { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }

async function runDpr(dpr, cdpPort) {
  const profile = join(OUT, `.edge-hidpi-${TAG}-dpr${dpr}`);
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
      '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
      `--window-size=${WINDOW.w},${WINDOW.h}`, `--force-device-scale-factor=${dpr}`,
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
        logs.push({ kind: 'cdp-console', level: msg.params.type, text: (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ') });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        logs.push({ kind: 'cdp-exception', level: 'error', text: msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? '' });
      }
    };
    await send('Runtime.enable'); await send('Page.enable');
    // ★ dpr 支持：把页面的设备像素比钉到 dpr（window.devicePixelRatio = dpr）
    await send('Emulation.setDeviceMetricsOverride', { width: WINDOW.w, height: WINDOW.h, deviceScaleFactor: dpr, mobile: false });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SHIM });
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?id=${ID}&vw=${VIEW.w}&vh=${VIEW.h}${NO_PARTICLES ? '&wasm=none' : ''}${VCLOCK ? `&vclock=${VCLOCK}` : ''}${EXP_QS}` });
    const t0 = Date.now();
    let ready = null;
    while (Date.now() - t0 < 90000) {
      const r = await evalJS('window.__fxReady ? JSON.stringify(window.__fxReady) : null');
      if (typeof r === 'string' && r) { ready = JSON.parse(r); break; }
      await sleep(300);
    }
    if (!ready) throw new Error('harness 未就绪（90s 超时）');
    const vp = await json('window.__fxApplyViewport()');
    // 冻结时钟 → 钉相位；等若干帧用同一 g_Time 重绘
    await evalJS(`window.__vnow = ${Math.round(PHASE * 1000)}`);
    await sleep(900);
    const state = await json(`{ stats: window.__fxStats(), cam: window.__fxCameraRect(), chains: window.__fxChains(),
      vclock: window.__vclock ? window.__vclock() : null,
      isolated: window.__fxIsolated(), quads: window.__fxQuads(), mountedRt: window.__fxMountedRt,
      msaa: window.__fxMsaaProbe ? window.__fxMsaaProbe() : null,
      rtDump: window.__fxRtDump ? window.__fxRtDump() : null, rtMemory: window.__fxRtMemory ? window.__fxRtMemory() : null }`);
    /** 截图：clip 固定 CSS (0,0)-(1280,720)；实测 PNG 尺寸，必要时用 clip.scale 自适应到 VIEW×dpr。 */
    const shotAt = async () => {
      let s = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: VIEW.w, height: VIEW.h, scale: 1 }, captureBeyondViewport: false });
      let buf = Buffer.from(s.data, 'base64');
      let d = pngDims(buf);
      if (d.w !== VIEW.w * dpr || d.h !== VIEW.h * dpr) {
        s = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: VIEW.w, height: VIEW.h, scale: dpr }, captureBeyondViewport: false });
        buf = Buffer.from(s.data, 'base64');
        d = pngDims(buf);
      }
      return { buf, w: d.w, h: d.h };
    };
    const A = await shotAt();
    await sleep(900);
    const B = await shotAt();
    // ★ 临时实验仪器 ⑤：读回对象 RT 与效果链输出（定界「模糊出现在哪一步」）
    const readbacks = {};
    for (const which of ['rt', 'out']) {
      const rb = await json(`window.__fxReadRt ? window.__fxReadRt(17, '${which}') : null`);
      if (rb && rb.png && rb.w) {
        const b64 = String(rb.png).replace(/^data:image\/png;base64,/, '');
        readbacks[which] = { w: rb.w, h: rb.h, buf: Buffer.from(b64, 'base64') };
      }
    }
    const pageLogs = await json('window.__fxLogs ?? []');
    const consErrs = [...logs, ...(Array.isArray(pageLogs) ? pageLogs : [])].filter((l) => l.level === 'error');
    return { ok: true, dpr, ready, viewport: vp, state, A: A.buf, B: B.buf, sizeA: [A.w, A.h], sizeB: [B.w, B.h], consErrs, logs, readbacks };
  } catch (e) {
    return { ok: false, dpr, fail: e?.message ?? String(e) };
  } finally {
    try { ws?.close(); } catch {}
    edge?.kill();
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
try {
  noParticlesActive = NO_PARTICLES;
  await new Promise((r) => server.listen(PORT, r));
  console.log(`[hidpi] 壁纸=${ID}  tag=${TAG}  相位=${PHASE}s  粒子=${NO_PARTICLES ? '抑制(变体 noparticles)' : '照常'}  效果链=${STRIP_EFFECTS ? '全部清空（变体 strip-effects：无对象 RT 的地板对照）' : '照常'}`);
  if (EXP_QS) console.log(`[hidpi] ★ 临时实验仪器：${EXP_QS.slice(1)}`);
  console.log(`[hidpi] 假想视口 CSS ${VIEW.w}×${VIEW.h}（窗口 ${WINDOW.w}×${WINDOW.h}）  dpr 列表=${DPRS.join(',')}`);
  const sc = sceneOf(ID);
  console.log(`[hidpi] 场景固有尺寸=${sc.general?.orthogonalprojection?.width}×${sc.general?.orthogonalprojection?.height}  对象数=${sc.objects.length}`);

  const shots = {};
  const mountedAssertions = []; // ★ 挂载期 RT 断言结果（回归 3fd6b00）
  for (let i = 0; i < DPRS.length; i++) {
    const dpr = DPRS[i];
    const r = await runDpr(dpr, CDP_PORT + i);
    if (!r.ok) { console.log(`\n===== dpr=${dpr} 失败：${r.fail}`); shots[dpr] = { ok: false, dpr, fail: r.fail }; continue; }
    const st = r.state.stats;
    console.log(`\n===== dpr=${dpr} =====`);
    console.log(`  harness ok=${r.ready.ok} err=${r.ready.err ?? 'null'}  playerCaught=${r.ready.playerCaught} stageCaught=${r.ready.stageCaught}`);
    if (VCLOCK) console.log(`  页面虚拟时间（--vclock=${VCLOCK}，装配后 +5s）= ${r.state.vclock ?? 'n/a'}`);
    console.log(`  window.devicePixelRatio=${st.devicePixelRatio}  画布缓冲=${st.canvasAttrW}×${st.canvasAttrH}  CSS=${st.canvasCssW}×${st.canvasCssH}`);
    console.log(`  截图尺寸=${r.sizeA[0]}×${r.sizeA[1]}（期望 ${VIEW.w * dpr}×${VIEW.h * dpr}）  连拍第二帧=${r.sizeB[0]}×${r.sizeB[1]}`);
    console.log(`  隔离对象数=${st.isolated}  主相机视锥=${JSON.stringify(r.state.cam)}`);
    console.log(`  效果链条目=${JSON.stringify(r.state.chains)}`);
    for (const e of r.state.isolated) {
      console.log(`    隔离 obj ${e.id}(${e.kind}) world=${e.world.map((v) => Math.round(v)).join('×')}`
        + `  RT像素=${e.rt.join('×')}  局部相机世界范围=${e.cam.map((v) => Math.round(v)).join(',')}`
        + `  ⇒ 相机宽/RT宽=${(Math.abs(e.cam[1] - e.cam[0]) / e.rt[0]).toFixed(3)}`);
      console.log(`      内容材质=${e.contentMat} blending=${e.contentBlending}`
        + `  合成quad材质=${e.quadMat} blending=${e.quadBlending} src=${e.quadBlendSrc} dst=${e.quadBlendDst}`);
    }
    // 主场景平面 quad 的**截图像素矩形**（生产 API：player.scene/camera 投影，坐标系与截图一致）——
    // 判定「变化区域是否落在某个对象所在画面区域」的依据。
    for (const qd of (r.state.quads ?? [])) {
      const rc = qd.rect.map((v) => Math.round(v));
      console.log(`    主场景 quad ${qd.material} world=${Math.round(qd.worldW)}×${Math.round(qd.worldH)}`
        + ` pos=(${qd.pos.map((v) => Math.round(v)).join(',')})  截图像素矩形=[${rc[0]},${rc[1]}]..[${rc[2]},${rc[3]}]`);
    }
    // ── ★ 挂载期 RT 尺寸断言（回归 3fd6b00 + 2026-09-14 清晰度口径）──────────────
    // 采样点在 harness 里、**早于** `__fxApplyViewport()`：它记录的是 `three-renderer` 在挂载期
    // 算出的 rtWidth/rtHeight（真机上从不 resize，这就是最终值）。期望值由 harness 里的**独立
    // oracle**给出：|world| × 屏幕密度（= 画布缓冲宽 / cover 视锥宽），等比收口到 4096。
    // ⚠️ 这里必须**判定**，不能只打印：此前 e2e 全绿而真机模糊，正是因为没有任何一条断言看这个值。
    const mrt = r.state.mountedRt;
    let mountFail = false;
    console.log('  ── 挂载期 RT 断言 ──');
    if (!mrt || mrt.ok !== true) {
      mountFail = true;
      console.log(`  ${RED}[FAIL] 挂载期隔离 RT 观测不可用：${mrt?.why ?? 'window.__fxMountedRt 缺失'}`);
      console.log(`  ${RED}[FAIL] 挂载期 RT 尺寸偏差 —— 这类缺陷曾被 onViewportResize 掩盖（见提交 3fd6b00）${RST}`);
    } else {
      console.log(`    挂载期视口(player)=${mrt.mountViewport.join('×')}  window.innerWidth/Height=${mrt.windowInner.join('×')}`
        + `  dpr=${mrt.dpr}  场景=${(mrt.scene ?? []).map((v) => Math.round(v)).join('×')}`);
      console.log(`    屏幕密度（独立 oracle）：挂载期=${mrt.mountScale?.toFixed(6)}`
        + `  声明视口=${mrt.declaredScale?.toFixed(6)}（声明视口=${mrt.declaredViewport.join('×')}）`);
      console.log('    期望值口径：|world| × 屏幕密度（画布缓冲宽 / cover 视锥宽），等比收口 4096（独立 oracle，不 import lib）');
      for (const it of mrt.items) {
        const post = (r.state.isolated ?? []).find((e) => e.id === it.id)?.rt ?? null;
        const tag = it.match ? `${GRN}MATCH${RST}` : `${RED}MISMATCH${RST}`;
        console.log(`    [挂载期] obj ${it.id}(${it.kind}) world=${it.world.map((v) => Math.round(v)).join('×')}`
          + `  挂载期 RT=${it.rt.join('×')}  期望=${it.expect.join('×')}  ⇒ ${tag}`);
        console.log(`       对照：旧口径(world×dpr 收口视口×dpr)@挂载期预算=${it.expectOldFormula?.join('×')}`
          + `${it.matchOldFormula ? `  ${RED}← 挂载期 RT 与旧口径一致（清晰度回归）${RST}` : ''}`
          + `  | 声明视口期望=${it.expectDeclared.join('×')}`
          + `  | 旧口径@声明视口预算=${it.expectOldFormulaDeclared?.join('×')}`
          + `  | 3fd6b00 前公式=${it.expectDefectFormula.join('×')}`
          + `  | __fxApplyViewport() 之后 RT=${post ? post.join('×') : 'n/a'}`);
        if (!it.match) mountFail = true;
      }
      if (mountFail) {
        console.log(`  ${RED}[FAIL] 挂载期 RT 尺寸与期望不符（期望口径：|world| × 屏幕密度，等比收口 4096）`);
        console.log(`  ${RED}[FAIL] 挂载期 RT 尺寸偏差 —— 这类缺陷曾被 onViewportResize 掩盖（见提交 3fd6b00）${RST}`);
      } else {
        console.log(`  ${GRN}[PASS]${RST} 挂载期 RT 尺寸 == 期望（|world| × 屏幕密度，等比收口 4096）`);
      }
    }
    mountedAssertions.push({ dpr, fail: mountFail, sample: mrt });
    console.log(`  console error 条数=${r.consErrs.length}`);
    for (const e of r.consErrs.slice(0, 5)) console.log(`    [${e.level}] ${String(e.text).slice(0, 200)}`);
    // ★ 临时实验仪器输出（清晰度归因：RT 尺寸 / 采样过滤 / MSAA / 颜色空间的运行时事实）
    if (r.state.rtDump) {
      const d = r.state.rtDump;
      console.log(`  ── 运行时事实（rtdump）──`);
      console.log(`    renderer.outputColorSpace=${d.rendererOutputColorSpace}  antialias=${d.rendererAntialias}  webgl2=${d.webgl2}`);
      console.log(`    gl.MAX_SAMPLES=${d.maxSamples}  对象 RT 的 MSAA framebuffer=${JSON.stringify(d.multisampledFbo)}`);
      for (const it of d.isolated) {
        console.log(`    obj ${it.id} RT=${it.rt.join('×')} samples=${it.samples} depth=${it.depthBuffer} stencil=${it.stencilBuffer}`);
        console.log(`      RT纹理: min=${it.rtTex?.min} mag=${it.rtTex?.mag} mips=${it.rtTex?.mips} colorSpace=${it.rtTex?.colorSpace} wrap=${it.rtTex?.wrapS},${it.rtTex?.wrapT} type=${it.rtTex?.type} format=${it.rtTex?.format}`);
        console.log(`      内容纹理: min=${it.contentMap?.min} mag=${it.contentMap?.mag} mips=${it.contentMap?.mips} colorSpace=${it.contentMap?.colorSpace} size=${it.contentMap?.size?.join('×')}`);
        console.log(`      合成quad map: min=${it.quadMap?.min} mag=${it.quadMap?.mag} colorSpace=${it.quadMap?.colorSpace} size=${it.quadMap?.size?.join('×')}  uv范围=${JSON.stringify(it.quadUvRange)}`);
      }
      for (const ro of d.runnerOut) console.log(`    效果链输出 obj ${ro.id} size=${ro.size ? ro.size.join('×') : 'null'}`);
    }
    if (r.state.msaa) console.log(`  ── MSAA 探针（斜置双色 quad → samples 0/4）── ${JSON.stringify(r.state.msaa)}`);
    if (r.state.rtMemory) {
      const m = r.state.rtMemory;
      console.log(`  ── 对象 RT 显存估算（rtW×rtH×4 ×(1+2 ping-pong)）──`);
      for (const it of m.items) console.log(`    obj ${it.id} ${it.rtWidth}×${it.rtHeight} runner=${it.runner} → ${(it.bytes / 1048576).toFixed(2)} MB`);
      console.log(`    合计 ${(m.totalBytes / 1048576).toFixed(2)} MB`);
    }
    writeFileSync(join(OUT, `${TAG}-dpr${dpr}.png`), r.A);
    writeFileSync(join(OUT, `${TAG}-dpr${dpr}-t2.png`), r.B);
    for (const [which, rb] of Object.entries(r.readbacks ?? {})) {
      writeFileSync(join(OUT, `${TAG}-dpr${dpr}-${which}.png`), rb.buf);
      console.log(`  已写读回：${TAG}-dpr${dpr}-${which}.png（${rb.w}×${rb.h}）`);
    }
    console.log(`  已写：${join(OUT, `${TAG}-dpr${dpr}.png`)}`);
    shots[dpr] = { ok: true, dpr, sizeA: r.sizeA, sizeB: r.sizeB, state: r.state, ready: r.ready, consErrs: r.consErrs, bufA: r.A, bufB: r.B };
  }

  const okDprs = DPRS.filter((d) => shots[d]?.ok);
  if (okDprs.length >= 2) {
    const [d1, d2] = okDprs;
    console.log(`\n===== 逐像素比较：dpr=${d1} vs dpr=${d2} =====`);
    const A1 = decodePng(shots[d1].bufA);
    const A2 = decodePng(shots[d2].bufA);
    console.log(`  尺寸：dpr=${d1} → ${A1.width}×${A1.height}；dpr=${d2} → ${A2.width}×${A2.height}`
      + `（比值 ${(A2.width / A1.width).toFixed(3)}×${(A2.height / A1.height).toFixed(3)}）`);
    const det1 = meanAbsDiff(A1, decodePng(shots[d1].bufB));
    const det2 = meanAbsDiff(A2, decodePng(shots[d2].bufB));
    console.log(`  相位自检（同 g_Time=${PHASE}s 下相隔 900ms 两帧的差）：dpr=${d1} 平均=${det1.meanAbs.toFixed(3)} 最大=${det1.max} ≥2 占比=${(det1.changedRatio * 100).toFixed(4)}%`
      + `；dpr=${d2} 平均=${det2.meanAbs.toFixed(3)} 最大=${det2.max} ≥2 占比=${(det2.changedRatio * 100).toFixed(4)}%`);
    const fx = A2.width / A1.width, fy = A2.height / A1.height;
    const metrics = { determinism: { [d1]: det1, [d2]: det2 } };
    if (Number.isInteger(fx) && Number.isInteger(fy)) {
      const A2d = downsampleBox(A2, fx, fy);
      const d = meanAbsDiff(A1, A2d);
      const zoom = bestZoom(A1, A2d);
      metrics.diff = d; metrics.zoom = zoom;
      console.log(`  [判据 B] dpr=${d2} 下采样到 ${A2d.width}×${A2d.height} 后逐像素：`
        + `平均绝对差=${d.meanAbs.toFixed(3)}/255  最大差=${d.max}  ≥2 的像素占比=${(d.changedRatio * 100).toFixed(3)}%  差异 bbox=${JSON.stringify(d.bbox)}`);
      console.log(`  [判据 A-尺度] 中心不动点最优缩放 k=${zoom.k.toFixed(3)}（k=1 ⇒ 两图尺度一致），`
        + `对齐后 MAD=${zoom.mad.toFixed(3)}，k=1 处 MAD=${zoom.madAtOne.toFixed(3)}`);
      const c1 = clampBands(A1), c2 = clampBands(A2d);
      metrics.clamp = { [d1]: c1, [d2]: c2 };
      const fmt = (c) => `左重复列=${c.leftRun} 右重复列=${c.rightRun} 上重复行=${c.topRun} 下重复行=${c.bottomRun}`
        + ` 重复列总数=${c.dupCols}/${c.w} 细节列跨度=${c.detailSpanX ? c.detailSpanX.join('..') : '无'}`;
      console.log(`  [判据 A-clamp] dpr=${d1}：${fmt(c1)}`);
      console.log(`  [判据 A-clamp] dpr=${d2}（已下采样到同尺寸）：${fmt(c2)}`);
    } else {
      console.log(`  ⚠️ 尺寸比非整数（${fx}×${fy}）→ 无法做下采样比较，如实记录`);
    }
    writeFileSync(join(OUT, `${TAG}-summary.json`), JSON.stringify({
      id: ID, tag: TAG, phase: PHASE, noParticles: NO_PARTICLES, stripEffects: STRIP_EFFECTS,
      dprs: DPRS.map((d) => (shots[d]?.ok ? { dpr: d, size: shots[d].sizeA, state: shots[d].state } : { dpr: d, fail: shots[d]?.fail })),
      mountedRtAssertion: mountedAssertions,
      metrics,
    }, null, 2));
  }
  // 挂载期 RT 断言的原始证据（无论 dpr 个数都会写）
  writeFileSync(join(OUT, `${TAG}-mounted-rt.json`), JSON.stringify({
    id: ID, tag: TAG, dprs: DPRS, mountedRtAssertion: mountedAssertions,
  }, null, 2));

  // ── ★ 结论：挂载期 RT 尺寸断言 ──────────────────────────────────────────────
  console.log('\n===== 结论：挂载期 RT 尺寸断言 =====');
  console.log(`  断言口径：挂载期（__fxApplyViewport() 之前）的 player.isolatedObjects()[].rtWidth/rtHeight`
    + ` 必须 == |world| × 屏幕密度（画布缓冲宽 / cover 视锥宽），等比收口 4096。`);
  const mountFails = mountedAssertions.filter((m) => m.fail);
  if (mountedAssertions.length === 0) {
    console.log(`  ${RED}[FAIL] 未采集到任何挂载期样本（所有 dpr 都失败或未跑）—— 断言未生效${RST}`);
    process.exitCode = 1;
  } else if (mountFails.length > 0) {
    console.log(`  ${RED}[FAIL] 挂载期 RT 尺寸断言**未通过**（dpr=${mountFails.map((m) => m.dpr).join(',')}，共 ${mountFails.length}/${mountedAssertions.length} 个 dpr 偏差）${RST}`);
    for (const m of mountFails) {
      const bad = (m.sample?.items ?? []).filter((i) => !i.match);
      for (const b of bad) {
        console.log(`  ${RED}[FAIL] dpr=${m.dpr} obj ${b.id}: 挂载期 RT=${b.rt.join('×')} ≠ 期望 ${b.expect.join('×')}`
          + `（world=${b.world.map((v) => Math.round(v)).join('×')}；旧口径=${b.expectOldFormula?.join('×')}，`
          + `3fd6b00 前公式=${b.expectDefectFormula.join('×')}，声明视口期望=${b.expectDeclared.join('×')}）${RST}`);
      }
    }
    console.log(`  ${RED}[FAIL] 挂载期 RT 尺寸偏差 —— 这类缺陷曾被 onViewportResize 掩盖（见提交 3fd6b00）：`
      + `本脚本后续的 __fxApplyViewport() 会用 stage 记录的未钳制 world 重算 RT，把挂载期的错误尺寸覆盖成正确尺寸，`
      + `因此像素比较/尺度判据全绿而真机（从不 resize）一直是错的。${RST}`);
    process.exitCode = 1; // 断言是**门禁**：不等即非零退出（可接 CI），不是只打印一行日志
  } else {
    console.log(`  ${GRN}[PASS]${RST} 挂载期 RT 尺寸断言全部通过（dpr=${mountedAssertions.map((m) => m.dpr).join(',')}）`);
  }
  console.log(`\n产物目录：${OUT}`);
} catch (e) {
  console.error('ERROR:', e?.stack ?? e?.message ?? e);
  process.exitCode = 1;
} finally {
  server.close();
}
