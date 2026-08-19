// 验证 DSH GUI 中插件加载状态（CDP）
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
let page = targets.find((t) => t.type === 'page');
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
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:3080' });
await new Promise((r) => setTimeout(r, 8000));
const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const hasWE = !!(window.__wallpaperEngine && window.__wallpaperEngine.show);
    const layer = document.querySelector('.wp-background-layer');
    const fab = document.querySelector('.wp-fab');
    return { hasWE, hasLayer: !!layer, hasFab: !!fab, title: document.title };
  })()`,
  returnByValue: true,
});
console.log('插件状态:', JSON.stringify(r.result?.value));
// 拉取壁纸列表验证 host 路由
const r2 = await send('Runtime.evaluate', {
  expression: `fetch('/wallpapers/list').then(r => r.ok ? r.json().then(l => ({ ok: true, count: l.length, sample: l[0]?.title })) : { ok: false, status: r.status })`,
  returnByValue: true,
  awaitPromise: true,
});
console.log('壁纸列表:', JSON.stringify(r2.result?.value));
ws.close();
