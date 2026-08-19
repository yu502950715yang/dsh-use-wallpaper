// 真实 DSH 环境浅色模式验证（CDP）：
// 1. 检查当前主题与插件 UI 颜色（深色）
// 2. 切换浅色主题，检查插件 UI 颜色（应变为白底深字）
// 3. 选择一张视频壁纸确认渲染
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page');
let ws;
const pending = new Map();
let msgId = 0;
ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id) { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); } }
};
const evalJS = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 检查深色主题下 UI 颜色
const dark = await evalJS(`(() => {
  const isDark = document.body.hasAttribute('data-ds-dark-theme');
  const fab = document.querySelector('.wp-fab');
  const cs = fab ? getComputedStyle(fab) : null;
  return { isDark, fabBg: cs?.backgroundColor, fabColor: cs?.color };
})()`);
console.log('深色主题状态:', JSON.stringify(dark));

// 切换浅色主题
await evalJS(`document.body.removeAttribute('data-ds-dark-theme'); document.body.setAttribute('data-we-wallpaper','true'); 'ok'`);
await sleep(500);
const light = await evalJS(`(() => {
  const fab = document.querySelector('.wp-fab');
  const cs = fab ? getComputedStyle(fab) : null;
  const root = document.getElementById('root');
  const rootBg = root ? getComputedStyle(root).backgroundColor : null;
  return { fabBg: cs?.backgroundColor, fabColor: cs?.color, rootBg, bodyBg: getComputedStyle(document.body).backgroundColor };
})()`);
console.log('浅色主题状态:', JSON.stringify(light));

// 选择一张壁纸（视频优先）验证渲染
const sel = await evalJS(`(async () => {
  const list = await fetch('/wallpapers/list').then(r => r.json());
  const v = list.find(w => w.type === 'video') ?? list[0];
  await window.__wallpaperEngine.show({kind: 'video', url: '/wallpapers/media/' + v.id + '/file'});
  await new Promise(r => setTimeout(r, 2500));
  const fill = document.querySelector('.wp-bg-fill');
  return { picked: v.title, kind: v.type, fillKids: fill ? fill.children.length : 0, hasVideo: !!(fill && fill.querySelector('video')) };
})()`);
console.log('壁纸渲染:', JSON.stringify(sel));

// 恢复深色主题
await evalJS(`document.body.setAttribute('data-ds-dark-theme',''); 'ok'`);
ws.close();
console.log('验证完成');
