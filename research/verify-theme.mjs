// 浅色模式适配的独立浏览器验证（不依赖 DSH 插件加载）：
// 1. 从 src/client/styles.ts 提取 WALLPAPER_CSS
// 2. 构造含模拟插件 UI（picker/fab/thumb/overlay/scrim）的 HTML
// 3. headless Edge 打开，分别截图「深色主题」「浅色主题」两版
// 4. 像素统计 + 输出颜色采样
// 用法：node research/verify-theme.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const OUT_DIR = 'E:/code/dsh-use-wallpaper/research/theme-shots';
mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. 提取 CSS
const src = readFileSync('E:/code/dsh-use-wallpaper/packages/dsh-wallpaper-engine/src/client/styles.ts', 'utf8');
const m = src.match(/const CSS = `([\s\S]*?)`;\nexport const WALLPAPER_CSS/);
if (!m) { console.error('无法提取 WALLPAPER_CSS'); process.exit(1); }
const css = m[1];

// 2. 构造 HTML
const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>theme verify</title>
<style>${css}
body{margin:0;font-family:system-ui;background:#f5f5f7}
/* 模拟 DSH 浅色/深色背景与文字 */
body[data-ds-dark-theme]{background:#151517;color:#eee}
.dsh-frame{position:absolute;inset:0;display:flex;padding:40px}
.dsh-panel{width:300px;height:200px;border-radius:12px;background:var(--dsw-specific-input-major, rgba(255,255,255,.15));border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1));display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-primary,#000)}
.wallpaper-sim{position:fixed;inset:0;background:linear-gradient(135deg,#2b5876,#4e4376);z-index:-1}
</style></head>
<body>
<div class="wallpaper-sim"></div>
<div class="wp-bg-overlay"></div>
<div class="dsh-frame"><div class="dsh-panel">DSH 主内容（文字对比度验证）</div></div>
<div class="wp-picker"><div class="wp-grid">
  <button class="wp-thumb wp-selected"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96'%3E%3Crect width='96' height='96' fill='%23333'/%3E%3C/svg%3E"><span class="wp-badge">SCENE</span><span class="wp-thumb-title">EVA 壁纸</span></button>
  <button class="wp-thumb"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96'%3E%3Crect width='96' height='96' fill='%23666'/%3E%3C/svg%3E"><span class="wp-badge">VIDEO</span><span class="wp-thumb-title">水波少女</span></button>
</div></div>
<button class="wp-fab">WP</button>
<button id="toggle" style="position:fixed;top:8px;left:8px;z-index:999;padding:6px 12px">切换主题</button>
<script>
document.getElementById('toggle').onclick = () => {
  const dark = document.body.hasAttribute('data-ds-dark-theme');
  document.body.toggleAttribute('data-ds-dark-theme', !dark);
  document.body.toggleAttribute('data-we-wallpaper', true);
};
document.body.setAttribute('data-we-wallpaper', 'true');
</script>
</body></html>`;
writeFileSync(`${OUT_DIR}/page.html`, html);

// 3. CDP 连接
let ws;
const pending = new Map();
let msgId = 0;
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('ws error'));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id) { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); } }
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
async function shot() {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  return Buffer.from(r.data, 'base64');
}

// 4. 启动流程：连接后导航到 file:// 页面
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
let page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:3080')) ?? targets.find((t) => t.type === 'page');
if (!page) { console.error('无页面'); process.exit(1); }
await connect(page.webSocketDebuggerUrl);
await send('Runtime.enable');
await send('Page.enable');
const fileUrl = 'file:///' + OUT_DIR.replace(/\\/g, '/') + '/page.html';
await send('Page.navigate', { url: fileUrl });
await sleep(1500);

// 采样函数：读取指定元素的计算颜色
async function sample(sel, props) {
  const v = await evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const cs = getComputedStyle(el); return ${JSON.stringify(props)}.reduce((o, p) => (o[p] = cs.getPropertyValue(p), o), {}); })()`);
  return v;
}

// 深色主题（初始无 data-ds-dark-theme → 通过 body 手动加）
await evalJS(`document.body.setAttribute('data-ds-dark-theme',''); document.body.setAttribute('data-we-wallpaper','true'); 'ok'`);
await sleep(600);
const darkShot = await shot();
writeFileSync(`${OUT_DIR}/dark.png`, darkShot);
const darkVars = await sample('.wp-picker', ['background-color', 'color']);
const darkThumb = await sample('.wp-thumb', ['color', 'border-color']);
const darkFab = await sample('.wp-fab', ['background-color', 'color']);
const darkPanel = await sample('.dsh-panel', ['background-color', 'color']);
console.log('深色主题: picker', JSON.stringify(darkVars), 'thumb', JSON.stringify(darkThumb), 'fab', JSON.stringify(darkFab), 'panel', JSON.stringify(darkPanel));

// 浅色主题
await evalJS(`document.body.removeAttribute('data-ds-dark-theme'); document.body.setAttribute('data-we-wallpaper','true'); 'ok'`);
await sleep(600);
const lightShot = await shot();
writeFileSync(`${OUT_DIR}/light.png`, lightShot);
const lightVars = await sample('.wp-picker', ['background-color', 'color']);
const lightThumb = await sample('.wp-thumb', ['color', 'border-color']);
const lightFab = await sample('.wp-fab', ['background-color', 'color']);
const lightPanel = await sample('.dsh-panel', ['background-color', 'color']);
console.log('浅色主题: picker', JSON.stringify(lightVars), 'thumb', JSON.stringify(lightThumb), 'fab', JSON.stringify(lightFab), 'panel', JSON.stringify(lightPanel));

ws.close();
console.log('验证完成，截图: research/theme-shots/{dark,light}.png');
