// Task 7 全库浏览器验证（M3 里程碑）：headless Chrome + CDP 驱动 DSH GUI，
// 对 15 个带 effects 的壁纸 + EVA 回归逐个切换、截图、收集 console error/warn，
// 并对截图做像素统计（平均亮度/暗像素占比/两帧差异）自动判定 黑屏/静态/动态。
// 用法：node research/task7-browser-verify.mjs <cdpPort>
import { writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const CDP_PORT = process.argv[2] ?? '9222';
const OUT_DIR = 'E:/code/dsh-use-wallpaper/.superpowers/sdd/2026-08-18-dsh-wallpaper-engine-effects/browser-shots';
mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— CDP 客户端（Node 22 原生 WebSocket）——
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
  return r.result?.value;
}

// —— 简易 PNG 解码（仅需亮度统计）：解析 IHDR + IDAT，zlib 解压 + 反 filter ——
function decodePngPixels(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (!width || !height) throw new Error('no IHDR');
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
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        v = (v + pr) & 0xff;
      }
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
  if (a.width !== b.width || a.height !== b.height) return 1;
  const n = a.width * a.height;
  let diff = 0;
  for (let i = 0; i < n; i++) {
    const o = i * a.channels;
    if (Math.abs(a.data[o] - b.data[o]) > 8 || Math.abs(a.data[o + 1] - b.data[o + 1]) > 8 || Math.abs(a.data[o + 2] - b.data[o + 2]) > 8) diff++;
  }
  return Math.round(diff / n * 10000) / 100;
}

// —— 主流程 ——
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && (t.url.includes('127.0.0.1:3080') || t.url.includes('localhost:3080')))
  ?? targets.find((t) => t.type === 'page');
if (!page) { console.error('未找到页面 target'); process.exit(1); }
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
    await sleep(300);
  }
  return false;
}

console.log('reload 页面加载最新 bundle...');
await send('Page.reload', { ignoreCache: true });
await sleep(5000);
console.log('等待 __wallpaperEngine 就绪...');
if (!(await waitForApp())) { console.error('__wallpaperEngine 未就绪'); process.exit(2); }
console.log('__wallpaperEngine 就绪 ✓');

async function shot() {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  return Buffer.from(r.data, 'base64');
}

// 壁纸列表：15 个带 effects（scan-effects.mjs 实测）+ 1280029027 EVA（无效果链回归）
const WALLPAPERS = [
  ['1429403119', 'waterripple/waterwaves 密集'],
  ['1968789468', 'shake/waterflow/shine'],
  ['2011060960', 'blur/clouds/filmgrain/pulse/shake'],
  ['2132420420', 'localcontrast/pulse'],
  ['2454403969', 'clouds/vhs/waterripple'],
  ['2460786246', 'vhs'],
  ['2597392171', 'scroll/waterripple/shake/godrays/blur'],
  ['2683211654', 'waterwaves'],
  ['2832263418', 'spin/audio_bars/chromatic_aberration/iris/shake'],
  ['2897292240', 'clouds/blur/waterwaves/opacity'],
  ['2911105183', 'perspective/blurprecise/audio_bars/waterwaves/skew/bloom/bokeh'],
  ['2937346640', 'godrays/foliagesway/iris'],
  ['3303428996', 'lightshafts'],
  ['3743126786', 'shake/pulse/bloom/foliagesway/scroll/waterripple'],
  ['3765967112', 'waterflow/foliagesway/blurprecise'],
  ['1280029027', 'EVA 无效果链（回归）'],
];

const results = [];
for (const [id, desc] of WALLPAPERS) {
  events = [];
  console.log(`\n=== ${id} (${desc}) ===`);
  await evalJS(`window.__wallpaperEngine.show({kind:'scene', wallpaperId:'${id}'}); 'ok'`);
  await sleep(12000);
  const png1 = await shot();
  await sleep(1200);
  const png2 = await shot();
  const s1 = stats(png1);
  const diff = diffRatio(png1, png2);
  writeFileSync(`${OUT_DIR}/t7_${id}.png`, png1);

  const errs = events.filter((e) => e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type))
    .map((e) => `[${e.params.type}] ${e.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  const logErrs = events.filter((e) => e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level))
    .map((e) => `[log:${e.params.entry.level}] ${e.params.entry.text}`);

  // console 消息分类：编译失败 / 纹理资源 / 其他
  const cat = { compile: [], texture: [], other: [] };
  for (const e of [...errs, ...logErrs]) {
    if (/编译失败|shader|Shader|program|link|uniform/i.test(e)) cat.compile.push(e);
    else if (/纹理|texture|tex |404|Failed to load|Unable to load|加载失败|fetch/i.test(e)) cat.texture.push(e);
    else cat.other.push(e);
  }
  // 渲染判定：平均亮度 + 动态差异
  const black = s1.avg < 6 && s1.darkRatio > 0.95;
  const verdict = black ? 'BLACK' : (diff < 0.5 && s1.darkRatio > 0.9 ? 'STATIC' : 'OK');
  const row = { id, avg: s1.avg, darkRatio: s1.darkRatio, diffPct: diff, verdict, compile: cat.compile.length, texture: cat.texture.length, other: cat.other.length, samples: cat.compile.slice(0, 2).concat(cat.texture.slice(0, 2)).concat(cat.other.slice(0, 2)) };
  results.push(row);
  console.log(`  亮度均值=${s1.avg} 暗像素=${s1.darkRatio}% 两帧差异=${diff}% → ${verdict} | console: 编译${cat.compile.length} 纹理${cat.texture.length} 其他${cat.other.length}`);
  for (const s of row.samples) console.log('    ' + s.slice(0, 300));
}

console.log('\n========== 汇总 ==========');
for (const r of results) {
  console.log(`${r.id.padEnd(12)} ${r.verdict.padEnd(7)} avg=${String(r.avg).padStart(7)} dark=${String(r.darkRatio).padStart(6)}% diff=${String(r.diffPct).padStart(6)}% compile=${r.compile} tex=${r.texture} other=${r.other}`);
}
ws.close();
console.log('验证脚本完成');
