// 研究：hook console.warn + fetch，重现"效果链解析失败"警告并抓调用栈
// 用法：node research/verify-chain-warn.mjs
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

// 安装 hook：记录 warn 调用栈 + fetch 失败
const hook = await evalJS(`(() => {
  window.__warnLog = [];
  window.__fetchLog = [];
  const origWarn = console.warn;
  console.warn = (...args) => {
    const msg = args.map(String).join(' ');
    if (msg.includes('效果链解析失败')) {
      window.__warnLog.push({ msg, stack: new Error().stack });
    }
    origWarn(...args);
  };
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    const url = String(args[0]);
    if (url.includes('/wallpapers/scene/')) {
      const t0 = performance.now();
      const resp = await origFetch(...args);
      if (!resp.ok) window.__fetchLog.push({ url, status: resp.status, ms: Math.round(performance.now() - t0) });
      return resp;
    }
    return origFetch(...args);
  };
  return 'hooked';
})()`);
console.log('hook:', hook);

// 串行切换 7 个目标壁纸，每个等 11 秒（与 verify-blackout 时序接近）
for (const id of ['1429403119', '2011060960', '2597392171', '2897292240', '2911105183', '3743126786', '3765967112']) {
  await evalJS(`window.__warnLog.length = 0; window.__fetchLog.length = 0;`);
  await evalJS(`window.__wallpaperEngine.show({kind:'scene', wallpaperId:'${id}'}); 'ok'`);
  await sleep(11000);
  const logs = await evalJS(`JSON.stringify({warns: window.__warnLog, fetches: window.__fetchLog})`);
  const parsed = JSON.parse(logs);
  console.log(`\n=== [${id}] ===`);
  console.log('  失败 fetch:', parsed.fetches.length);
  for (const f of parsed.fetches.slice(0, 6)) console.log(`    ${f.status} ${f.url}`);
  if (parsed.fetches.length > 6) console.log(`    ... 共 ${parsed.fetches.length} 条`);
  console.log('  效果链解析失败警告:', parsed.warns.length);
  for (const w of parsed.warns) {
    console.log('    ' + w.msg);
    // 打印栈中关键帧
    const frames = (w.stack ?? '').split('\n').slice(1, 8).join('\n      ');
    console.log('      ' + frames);
  }
}
ws.close();
