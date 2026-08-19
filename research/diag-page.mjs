// 诊断 DSH 页面状态（CDP）
import { writeFileSync } from 'node:fs';
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page');
console.log('页面:', page.url);
let ws;
const pending = new Map();
let msgId = 0;
ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id) { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); p.resolve(msg.result); } }
  else if (msg.method === 'Runtime.consoleAPICalled') {
    console.log('[console:' + msg.params.type + ']', msg.params.args?.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  }
};
const send = (method, params = {}) => new Promise((resolve) => { const id = ++msgId; pending.set(id, { resolve }); ws.send(JSON.stringify({ id, method, params })); });
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:3080' });
await new Promise((r) => setTimeout(r, 6000));
const r = await send('Runtime.evaluate', { expression: `(() => ({ title: document.title, hasWE: !!(window.__wallpaperEngine), hasLoader: !!(window.__ModuleLoader__), hasBoot: !!(window.__DSH_BOOT__), bodyKids: document.body ? document.body.children.length : -1, scripts: [...document.querySelectorAll('script')].map(s => s.src || s.id || '(inline)').slice(0, 10) }))()`, returnByValue: true });
console.log(JSON.stringify(r.result?.value, null, 2));
// 收集最近的 console 错误
await new Promise((r) => setTimeout(r, 5000));
const r2 = await send('Runtime.evaluate', { expression: `document.body ? document.body.innerHTML.slice(0, 500) : 'no body'`, returnByValue: true });
console.log('body html head:', r2.result?.value);
ws.close();
