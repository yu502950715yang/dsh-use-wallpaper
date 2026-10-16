// 真实渲染验证：web 壁纸的「跟随鼠标」直传（pointer-events:none 的 iframe 拿不到 mousemove）。
//
// 复刻宿主真实结构：父页 .wp-background-layer{pointer-events:none} + 跨源 iframe
// （localhost 父页 / 127.0.0.1 子帧，沙箱 allow-scripts allow-same-origin），iframe 里的 HTML
// 走**生产代码** `lib/client/pointer-shim.js` 的 `injectPointerShim()` 注入（与 host /wallpapers/web
// 路由同一函数）。然后用 CDP 派发**真实鼠标移动**，比较移动前后的图层位移与像素。
//
// 两个模式：
//   ?mode=raw   不注入 shim（= 修复前）：库在跑、指针进不来 ⇒ 画面零位移
//   ?mode=shim  注入 shim（= 修复后）：父页 pointermove → postMessage → iframe 内合成 mousemove ⇒ 画面位移
//
// 用法：node e2e/verify/verify-web-pointer-parallax.mjs [--port=9830] [--cdp-port=9241] [--wallpaper=<dir>]
// 退出码：0 = 全部判据通过；1 = 有判据失败或脚本异常（CI 门禁）。
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT_DIR, httpPort, cdpPort, resolveEdgePath, TIMEOUT_MS, argOf } from '../config.mjs';
import { decodePng } from '../lib/png-stats.mjs';
import { injectPointerShim } from '../../lib/client/pointer-shim.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(OUT_DIR, 'web-pointer-parallax');
mkdirSync(OUT, { recursive: true });
const PORT = httpPort(9830);
const CDP_PORT = cdpPort(9241);

// 本机样本：工坊 1184182304（jquery.parallax 五层视差）。缺素材即跳过（不误报为失败）。
const WALL_DIR = argOf('wallpaper', process.env.WE_WALLPAPER ?? 'D:/Steam/steamapps/workshop/content/431960/1184182304');
const haveWall = existsSync(join(WALL_DIR, 'index.html')) && existsSync(join(WALL_DIR, 'js/jquery.parallax.min.js'));
if (!haveWall) {
  console.log(`跳过：缺少 web 壁纸样本 ${WALL_DIR}（设置 --wallpaper=<dir> 或删除本门禁）`);
  process.exit(0);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg' };

// 父页：与宿主 styles.ts 的 .wp-background-layer 同一条关键声明（pointer-events:none）。
const PARENT = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#111;overflow:hidden}
.wp-background-layer{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none}
.wp-bg-fill{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.wp-bg-fill iframe{width:100%;height:100%;object-fit:cover;border:0}
</style></head><body>
<div class="wp-background-layer"><div class="wp-bg-fill">
  <iframe id="f" sandbox="allow-scripts allow-same-origin" scrolling="no"></iframe>
</div></div>
<script src="/parent.js"></script>
</body></html>`;

// 父页脚本 = 生产 background-layer 的等价最小实现（同一 postMessage 契约与坐标算法）。
const PARENT_JS = `
var frame = document.getElementById('f');
function post(ev){
  var r = frame.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0)) return;
  var x = ev.clientX - r.left, y = ev.clientY - r.top;
  var inside = x >= 0 && x <= r.width && y >= 0 && y <= r.height;
  try { frame.contentWindow.postMessage({ __wpPointer: 1, nx: x / r.width, ny: y / r.height,
    px: inside ? Math.round(x) : -1, py: inside ? Math.round(y) : -1 }, '*'); } catch (e) {}
}
window.__hostMoves = 0;
window.__hostMoveEvts = 0;
window.addEventListener('pointermove', function (ev) { window.__hostMoves++; post(ev); }, { capture: true, passive: true });
window.addEventListener('mousemove', function (ev) { window.__hostMoveEvts++; if (!window.__hostMoves) post(ev); }, { passive: true });
frame.getBoundingClientRect();
frame.src = '/wall/?mode=' + new URLSearchParams(location.search).get('mode');
`;

let wallHtml = null;
function wallIndexHtml(mode) {
  if (wallHtml === null) wallHtml = readFileSync(join(WALL_DIR, 'index.html'), 'utf8');
  if (mode !== 'shim') return wallHtml;
  const patched = injectPointerShim(wallHtml); // 生产函数；注入失败即原样返回
  if (patched === null) throw new Error('injectPointerShim 返回 null（无可用锚点）');
  return patched;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const mode = url.searchParams.get('mode') ?? 'shim';
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': MIME['.html'] });
    return res.end(PARENT);
  }
  if (url.pathname === '/parent.js') {
    res.writeHead(200, { 'content-type': MIME['.js'] });
    return res.end(PARENT_JS);
  }
  if (url.pathname === '/wall/' || url.pathname === '/wall/index.html') {
    res.writeHead(200, { 'content-type': MIME['.html'] });
    return res.end(wallIndexHtml(mode));
  }
  if (url.pathname.startsWith('/wall/')) {
    const p = join(WALL_DIR, url.pathname.slice('/wall/'.length));
    if (!existsSync(p)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
    return res.end(readFileSync(p));
  }
  res.writeHead(404);
  res.end('nf');
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let edge, ws, msgId = 0;
const pending = new Map();
const logs = [];
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

async function waitForProbe() {
  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    const line = logs.find((l) => l.startsWith('[probe]'));
    if (line) return line;
    await sleep(200);
  }
  return null;
}

/** 读 iframe 内（同源副本）的图层位移与库状态。 */
const READ_STATE = `(() => {
  const f = document.getElementById('f');
  const d = f.contentWindow.document;
  const layers = [...d.querySelectorAll('.layer')];
  const off = (el) => { const m = /matrix\\(([^)]+)\\)/.exec(getComputedStyle(el).transform); const p = m ? m[1].split(',').map(Number) : [1,0,0,1,0,0]; return [p[4] || 0, p[5] || 0]; };
  return JSON.stringify({
    hostMoves: window.__hostMoves,
    hostMoveEvts: window.__hostMoveEvts,
    libOk: !!f.contentWindow.__libOk,
    apiOk: !!f.contentWindow.__apiOk,
    shimHits: f.contentWindow.__wpPointerHits || 0,
    offsets: layers.map(off),
  });
})()`;

const maxAbs = (state) => Math.max(...state.offsets.flat().map(Math.abs));
const stateDelta = (a, b) => Math.max(...a.offsets.flat().map((v, i) => Math.abs(v - b.offsets.flat()[i])));

function pixelDiff(a, b) {
  const A = decodePng(a), B = decodePng(b);
  if (A.width !== B.width || A.height !== B.height) throw new Error('尺寸不一致');
  let diff = 0, max = 0, n = 0;
  for (let i = 0; i < A.data.length; i += A.channels) {
    const d = Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]);
    if (d > 6) { diff++; if (d > max) max = d; }
    n++;
  }
  return { changedRatio: diff / n, max };
}

async function runMode(mode) {
  logs.length = 0;
  await send('Page.navigate', { url: `http://localhost:${PORT}/?mode=${mode}` });
  await sleep(1500); // 壁纸自带的 jQuery/parallax 加载 + ready
  const libState = await evalJs(`(() => {
    const f = document.getElementById('f');
    const w = f.contentWindow;
    if (typeof w.$ !== 'function' || !w.$.fn.parallax) return null;
    if (!w.eval("!!$('#scene').data('api')")) w.eval("$('#scene').parallax();"); // ready 未跑则手动初始化
    w.__libOk = true; w.__apiOk = w.eval("!!$('#scene').data('api')");
    return { libOk: w.__libOk, apiOk: w.__apiOk };
  })()`);
  if (!libState) return { mode, error: '壁纸未加载出 jQuery/parallax（页面或资源有问题）' };

  // 基线必须在**任何鼠标移动之前**取：否则「移动前后」的差异可能只是摩擦游走，判据会变弱。
  const baselineShot = await send('Page.captureScreenshot', { format: 'png' });
  const baseline = JSON.parse(await evalJs(READ_STATE));

  // headless 下 CDP 的 mouseMoved **不会**触发 pointermove（实测只有部分鼠标事件被合成），
  // 故这里用 mousemove 兼容路径补发；父页脚本按同一契约 postMessage。
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 60, y: 60, button: 'none' });
  await sleep(600); // friction 收敛（frictionX/Y = 0.1）
  const landed = JSON.parse(await evalJs(READ_STATE));
  const movedShot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${mode}-baseline.png`), Buffer.from(baselineShot.data, 'base64'));
  writeFileSync(join(OUT, `${mode}-moved.png`), Buffer.from(movedShot.data, 'base64'));

  return {
    mode,
    hostMoves: landed.hostMoves,
    hostMoveEvts: landed.hostMoveEvts,
    shimHits: landed.shimHits,
    baselineOffsets: baseline.offsets,
    movedOffsets: landed.offsets,
    maxShift: maxAbs(landed),
    delta: stateDelta(baseline, landed),
    pixels: pixelDiff(Buffer.from(baselineShot.data, 'base64'), Buffer.from(movedShot.data, 'base64')),
  };
}

let ok = false;
try {
  await new Promise((r) => server.listen(PORT, r));
  console.log(`harness server: http://localhost:${PORT}/（iframe 走 127.0.0.1，复刻跨源条件）`);

  edge = spawn(resolveEdgePath(), [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(OUT, '.edge')}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio', '--window-size=1280,720',
    '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', 'about:blank',
  ], { stdio: 'ignore' });

  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) break; } catch {}
    await sleep(400);
  }
  const page = ((await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page'));
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws open failed')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }
    else if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails?.exception?.description ?? ''));
  };
  await send('Runtime.enable'); await send('Page.enable');

  const raw = await runMode('raw');
  const shim = await runMode('shim');
  console.log('\n--- mode=raw（修复前）---');
  console.log('  ', JSON.stringify(raw));
  console.log('--- mode=shim（修复后）---');
  console.log('  ', JSON.stringify(shim));

  console.log('\n===== 判定 =====');
  const checks = [
    ['raw：宿主确实收到了真实鼠标移动（输入链路有效，不是没鼠标）', !!raw && raw.hostMoves + raw.hostMoveEvts > 0],
    ['raw：库在跑却没有指针直传 ⇒ 图层仍停在零点', !!raw && raw.maxShift === 0],
    ['raw：画面像素完全没变（修复前的现状签名）', !!raw && raw.pixels.changedRatio === 0],
    ['shim：iframe 内 shim 收到坐标（postMessage 链路生效）', !!shim && shim.shimHits > 0],
    ['shim：图层位移 = 真实像素级位移且量级足够（> 20px）', !!shim && shim.maxShift > 20 && shim.delta > 20],
    ['shim：真实渲染像素确实变了（不是只改了 style 字符串）', !!shim && shim.pixels.changedRatio > 0.02],
    ['raw 与 shim 对照成立（关掉直传就零位移）', !!raw && !!shim && raw.pixels.changedRatio < shim.pixels.changedRatio],
  ];
  ok = true;
  for (const [name, pass] of checks) { console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) ok = false; }
  console.log(`\n结论：${ok ? '全部通过' : '存在失败项'}`);
  console.log(`截图：${OUT}`);
  if (!ok) process.exitCode = 1;
} catch (e) {
  console.error('ERROR:', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  edge?.kill();
  server.close();
}
