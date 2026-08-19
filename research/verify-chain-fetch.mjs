// 研究：在真实浏览器环境逐 URL 复现效果链 fetch，定位 7 条"解析失败"的具体请求
// 用法：node research/verify-chain-fetch.mjs
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

// 浏览器内执行：遍历 7 个壁纸的所有效果链引用，逐个 fetch 并记录失败
const expr = `(async () => {
  const TARGETS = ['1429403119','2011060960','2597392171','2897292240','2911105183','3743126786','3765967112'];
  const results = [];
  for (const id of TARGETS) {
    const scene = await (await fetch('/wallpapers/scene/'+id+'/asset?name=scene.json')).json();
    const refs = [];
    for (const o of scene.objects ?? []) {
      for (const fx of Array.isArray(o.effects) ? o.effects : []) {
        if (typeof fx.file === 'string') refs.push({ obj: o.name, file: fx.file, passes: fx.passes });
      }
    }
    // 每壁纸逐条解析（串行，模拟 renderScene 的 utilEffects 循环）
    for (const ref of refs) {
      const failUrls = [];
      const tryFetch = async (name) => {
        const resp = await fetch('/wallpapers/scene/'+id+'/asset?name='+encodeURIComponent(name));
        if (!resp.ok) failUrls.push(name + ' → ' + resp.status);
        return resp.ok ? new Uint8Array(await resp.arrayBuffer()) : null;
      };
      let ok = true;
      try {
        const effectRaw = await tryFetch(ref.file);
        if (!effectRaw) { ok = false; }
        else {
          const effect = JSON.parse(new TextDecoder().decode(effectRaw));
          const scenePasses = Array.isArray(ref.passes) ? ref.passes : [];
          if (!Array.isArray(effect.passes) || effect.passes.length === 0) { ok = false; failUrls.push('passes 空'); }
          for (let i = 0; i < effect.passes.length; i++) {
            const matRef = scenePasses[i]?.material ?? effect.passes[i].material;
            if (typeof matRef !== 'string') { ok = false; failUrls.push('pass'+i+' matRef 非字符串'); break; }
            if (matRef.startsWith('materials/util/')) continue;
            const matRaw = await tryFetch(matRef);
            if (!matRaw) { ok = false; break; }
            const mat = JSON.parse(new TextDecoder().decode(matRaw));
            const shaderName = mat?.passes?.[0]?.shader;
            if (typeof shaderName !== 'string') { ok = false; failUrls.push('pass'+i+' 无 shader'); break; }
            if (!(await tryFetch('shaders/'+shaderName+'.vert'))) { ok = false; break; }
            if (!(await tryFetch('shaders/'+shaderName+'.frag'))) { ok = false; break; }
          }
        }
      } catch (e) {
        ok = false;
        failUrls.push('异常: ' + String(e));
      }
      if (!ok) results.push({ id, obj: ref.obj, file: ref.file, failUrls });
    }
  }
  return results;
})()`;

const results = await evalJS(expr);
if (results.err) { console.error('执行错误:', results.err); process.exit(2); }
if (!results || results.length === 0) {
  console.log('✅ 浏览器内全部效果链引用 fetch 成功（7 条失败与静态 fetch 无关，是运行时其他因素）');
} else {
  console.log('❌ 发现失败引用:');
  for (const r of results) {
    console.log(`[${r.id}] 对象"${r.obj}" ${r.file}`);
    for (const u of r.failUrls) console.log('    ' + u);
  }
}
ws.close();
