// 研究：确认效果链解析失败 = fetch reject（abort/超时），记录拒绝详情与耗时
// 用法：node research/verify-fetch-reject.mjs
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let msgId = 0;
const pending = new Map();
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

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:3080'));
if (!page) { console.error('未找到 DSH 页面'); process.exit(1); }
await connect(page.webSocketDebuggerUrl);
await send('Runtime.enable');

const hook = await evalJS(`(() => {
  window.__rejects = [];
  window.__slow = [];
  window.__rejEvents = [];
  window.addEventListener('unhandledrejection', (e) => {
    window.__rejEvents.push(String(e.reason && e.reason.stack || e.reason));
  });
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    const url = String(args[0]);
    if (!url.includes('/wallpapers/')) return origFetch(...args);
    const t0 = performance.now();
    try {
      const resp = await origFetch(...args);
      const ms = Math.round(performance.now() - t0);
      if (ms > 1500) window.__slow.push({ url, ms, status: resp.status });
      return resp;
    } catch (e) {
      window.__rejects.push({ url, ms: Math.round(performance.now() - t0), err: String(e) });
      throw e;
    }
  };
  return 'hooked';
})()`);
console.log('hook:', hook);

// 连续切两个壁纸：先 2897292240（blur 失败者），再 2911105183（tint 失败者，32 链高负载）
for (const id of ['2897292240', '2911105183']) {
  await evalJS(`window.__rejects.length = 0; window.__slow.length = 0; window.__rejEvents.length = 0;`);
  await evalJS(`window.__wallpaperEngine.show({kind:'scene', wallpaperId:'${id}'}); 'ok'`);
  await sleep(12000);
  const logs = await evalJS(`JSON.stringify({rejects: window.__rejects, slow: window.__slow.slice(0,8), slowCount: window.__slow.length, rejEvents: window.__rejEvents})`);
  const parsed = JSON.parse(logs);
  console.log(`\n=== [${id}] ===`);
  console.log('  fetch rejects:', parsed.rejects.length);
  for (const r of parsed.rejects.slice(0, 5)) console.log(`    ${r.ms}ms ${r.url} → ${r.err}`);
  console.log('  慢请求(>1500ms):', parsed.slowCount);
  for (const s of parsed.slow.slice(0, 8)) console.log(`    ${s.ms}ms ${s.status} ${s.url}`);
  console.log('  unhandledrejection:', parsed.rejEvents.length);
  for (const e of parsed.rejEvents.slice(0, 3)) console.log('    ' + e.slice(0, 300));
}
ws.close();
