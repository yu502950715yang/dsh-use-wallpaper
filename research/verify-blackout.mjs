// 全库 scene 壁纸黑屏实测（CDP 驱动 DSH GUI）：
// 对每个 scene 壁纸调用 window.__wallpaperEngine.show，截图 + 像素统计 + console 错误收集
// 判定：BLACK(黑屏) / STATIC(静态) / OK(动态) / FALLBACK(回退 preview)
// 用法：node research/verify-blackout.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const OUT_DIR = 'E:/code/dsh-use-wallpaper/research/blackout-shots';
mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let msgId = 0;
const pending = new Map();
let events = [];
let ws;

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('ws error'));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id) {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
      } else if (msg.method) {
        events.push(msg);
      }
    };
  });
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJS(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { err: r.exceptionDetails.text + ': ' + (r.exceptionDetails.exception?.description ?? '') };
  return r.result?.value;
}
async function shot() {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  return Buffer.from(r.data, 'base64');
}
function decodePngPixels(buf) {
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = (v + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 0xff; }
      cur[x] = v;
    }
    prev = cur;
  }
  return { width, height, channels, data: out };
}
function stats(pngBuf) {
  const { width, height, channels, data } = decodePngPixels(pngBuf);
  let sum = 0, dark = 0, n = width * height;
  for (let i = 0; i < n; i++) {
    const lum = (data[i * channels] + data[i * channels + 1] + data[i * channels + 2]) / 3;
    sum += lum;
    if (lum < 16) dark++;
  }
  return { avg: Math.round(sum / n * 100) / 100, darkRatio: Math.round(dark / n * 10000) / 100 };
}
function diffRatio(aBuf, bBuf) {
  const a = decodePngPixels(aBuf), b = decodePngPixels(bBuf);
  const n = a.width * a.height;
  let diff = 0;
  for (let i = 0; i < n; i++) {
    const o = i * a.channels;
    if (Math.abs(a.data[o] - b.data[o]) > 8 || Math.abs(a.data[o + 1] - b.data[o + 1]) > 8 || Math.abs(a.data[o + 2] - b.data[o + 2]) > 8) diff++;
  }
  return Math.round(diff / n * 10000) / 100;
}

// —— 主流程 ——
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:3080'));
if (!page) { console.error('未找到 DSH 页面 target'); process.exit(1); }
console.log('目标页面:', page.url);
await connect(page.webSocketDebuggerUrl);
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

async function waitForApp(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await evalJS('!!(window.__wallpaperEngine && window.__wallpaperEngine.show)');
    if (ok) return true;
    await sleep(400);
  }
  return false;
}

// 不 reload：直接等 app 就绪（保留用户当前状态；若未就绪再 reload）
let ready = await waitForApp();
if (!ready) {
  console.log('app 未就绪，reload...');
  await send('Page.reload', { ignoreCache: true });
  await sleep(5000);
  ready = await waitForApp();
}
if (!ready) { console.error('__wallpaperEngine 未就绪'); process.exit(2); }
console.log('__wallpaperEngine 就绪 ✓');

// WebGL 可用性检查
const gl = await evalJS(`(() => { const c = document.createElement('canvas'); const gl2 = c.getContext('webgl2'); const gl1 = c.getContext('webgl'); return { webgl2: !!gl2, webgl1: !!gl1, renderer: gl2 ? gl2.getParameter(gl2.RENDERER) : (gl1 ? gl1.getParameter(gl1.RENDERER) : 'none') }; })()`);
console.log('WebGL:', JSON.stringify(gl));

// 拉取壁纸列表
const list = await evalJS(`fetch('/wallpapers/list').then(r => r.json())`);
const scenes = list.filter((w) => (w.type === 'scene' || w.type === 'unknown') && w.hasScene);
console.log(`scene 壁纸数: ${scenes.length}`);
const fallbacks = list.filter((w) => !((w.type === 'scene' || w.type === 'unknown') && w.hasScene));
console.log(`非 scene 壁纸: ${fallbacks.map((w) => `${w.id}(${w.type})`).join(', ')}`);

const results = [];
for (const w of scenes) {
  events = [];
  console.log(`\n=== ${w.id} ${w.title} ===`);
  const r = await evalJS(`window.__wallpaperEngine.show({kind:'scene', wallpaperId:'${w.id}'}); 'ok'`);
  if (r?.err) console.log('show 调用错误:', r.err);
  await sleep(9000); // 等纹理/效果链加载
  const png1 = await shot();
  await sleep(1500);
  const png2 = await shot();
  const s1 = stats(png1);
  const diff = diffRatio(png1, png2);
  writeFileSync(`${OUT_DIR}/${w.id}.png`, png1);

  // 检查 DOM 状态：canvas vs img（回退）
  const dom = await evalJS(`(() => { const fill = document.querySelector('.wp-bg-fill'); if (!fill) return {none: true}; const canvas = fill.querySelector('canvas'); const img = fill.querySelector('img'); return { canvasCount: fill.querySelectorAll('canvas').length, imgCount: fill.querySelectorAll('img').length, canvasVisible: canvas ? getComputedStyle(canvas).display !== 'none' : false }; })()`);

  const errs = events.filter((e) => e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type))
    .map((e) => `[${e.params.type}] ${e.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  const logErrs = events.filter((e) => e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level))
    .map((e) => `[log:${e.params.entry.level}] ${e.params.entry.text}`);
  const cat = { compile: [], texture: [], other: [] };
  for (const e of [...errs, ...logErrs]) {
    if (/编译失败|shader|Shader|program|link|uniform/i.test(e)) cat.compile.push(e);
    else if (/纹理|texture|tex |404|Failed to load|加载失败|fetch/i.test(e)) cat.texture.push(e);
    else cat.other.push(e);
  }

  const black = s1.avg < 6 && s1.darkRatio > 0.95;
  const verdict = black ? 'BLACK' : (diff < 0.5 ? 'STATIC' : 'OK');
  const row = { id: w.id, title: w.title.slice(0, 24), avg: s1.avg, dark: s1.darkRatio, diff, verdict, dom: `${dom.canvasCount}c/${dom.imgCount}i`, compile: cat.compile.length, texture: cat.texture.length, other: cat.other.length };
  results.push(row);
  console.log(`  avg=${s1.avg} dark=${s1.darkRatio}% diff=${diff}% → ${verdict} | DOM ${row.dom} | console: 编译${cat.compile.length} 纹理${cat.texture.length} 其他${cat.other.length}`);
  for (const s of [...cat.compile.slice(0, 2), ...cat.texture.slice(0, 2), ...cat.other.slice(0, 3)]) console.log('    ' + s.slice(0, 250));
}

console.log('\n========== 汇总 ==========');
for (const r of results) {
  console.log(`${r.id.padEnd(12)} ${r.verdict.padEnd(7)} avg=${String(r.avg).padStart(7)} dark=${String(r.dark).padStart(6)}% diff=${String(r.diff).padStart(6)}% DOM=${r.dom.padEnd(7)} 编译=${r.compile} 纹理=${r.texture} 其他=${r.other}`);
}
ws.close();
console.log('实测完成');
