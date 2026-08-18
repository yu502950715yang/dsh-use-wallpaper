// Task 6 浏览器集成验证（M2 里程碑）：headless Chrome + CDP 驱动 DSH GUI，
// 调用 window.__wallpaperEngine.show({kind:'scene', wallpaperId}) 切换壁纸并截图，
// 同时收集 console 消息（error/warn）。用法：node research/task6-browser-verify.mjs <cdpPort>
import { writeFileSync } from 'node:fs';

const CDP_PORT = process.argv[2] ?? '9222';
const OUT_DIR = 'E:/code/dsh-use-wallpaper/.superpowers/sdd/2026-08-18-dsh-wallpaper-engine-effects/browser-shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— CDP 客户端（Node 22 原生 WebSocket）——
let msgId = 0;
const pending = new Map();
const events = [];
let ws;

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(new Error('ws error'));
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
await send('Page.setDownloadBehavior', { behavior: 'deny' });

// 等待页面与应用就绪
async function waitForApp(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await evalJS('!!(window.__wallpaperEngine && window.__wallpaperEngine.show)');
    if (ok) return true;
    await sleep(300);
  }
  return false;
}
// 强制 reload 加载最新 client bundle（rev 变化后 headless 页面需刷新）
console.log('reload 页面加载最新 bundle...');
await send('Page.reload', { ignoreCache: true });
await sleep(4000);
console.log('等待 __wallpaperEngine 就绪...');
const ready = await waitForApp();
if (!ready) { console.error('__wallpaperEngine 未就绪'); process.exit(2); }
console.log('__wallpaperEngine 就绪 ✓');

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT_DIR}/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log('截图:', name);
}

async function showAndShot(id, name, waitMs = 9000) {
  events.length = 0;
  await evalJS(`window.__wallpaperEngine.show({kind:'scene', wallpaperId:'${id}'}); 'ok'`);
  await sleep(waitMs); // 等 scene 加载 + 效果链解析 + 若干帧渲染
  await shot(name);
  await sleep(500);
  const errs = events.filter((e) => e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type))
    .map((e) => `[${e.params.type}] ${e.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  const logErrs = events.filter((e) => e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level))
    .map((e) => `[log:${e.params.entry.level}] ${e.params.entry.text}`);
  console.log(`--- ${id} ${name} console error/warn (${errs.length + logErrs.length}) ---`);
  for (const e of [...errs, ...logErrs].slice(0, 20)) console.log('  ' + e);
}

// Step 6.2/6.3: 2911105183（waterwaves + Simple_Audio_Bars）
await showAndShot('2911105183', '01_2911105183_waterwaves', 10000);
// Step 6.4: 1429403119（waterripple/waterwaves 密集）
await showAndShot('1429403119', '02_1429403119_waterripple', 10000);
// Step 6.5: 2832263418（spin/chromatic_aberration/audio_bars/iris/shake）
await showAndShot('2832263418', '03_2832263418_aberration', 10000);
// Step 6.6: 1280029027 EVA（无效果链，回归）
await showAndShot('1280029027', '04_1280029027_eva', 8000);

// FPS 采样：读 performance 无直接帧率，改用 rAF 计数 3 秒
const fps = await evalJS(`new Promise((resolve) => {
  let n = 0; const t0 = performance.now();
  function tick() { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else resolve(Math.round(n / 3)); }
  requestAnimationFrame(tick);
})`);
console.log('--- FPS（3 秒 rAF 采样，1280029027）:', fps);

ws.close();
console.log('验证脚本完成');
