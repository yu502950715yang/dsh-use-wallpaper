// 真实渲染验证：`colorBlendMode`（WE 图像颜色混合模式）在 three 路径下的效果。
//
// 自起 http server + headless Edge（**不依赖 DSH token、不依赖 Wallpaper Engine 素材**），
// 用**生产代码**（`lib/client/threejs-player.js` 的 `loadSceneToThree`）渲染两个场景：
//   ?mode=7   背景 + "黑底白云" 云层（colorBlendMode: 7 = Screen）
//   ?mode=0   同一场景但 colorBlendMode: 0（旧行为 = 普通 alpha 混合）
// 期望：mode=7 时云层的**黑底完全不改变背景**（只看到云）；mode=0 时黑底把背景压暗一半。
//
// 用法：node e2e/verify/verify-colorblend.mjs [--port=9811] [--cdp-port=9226]
// 退出码：0 = 全部判据通过；1 = 有判据失败或脚本异常（CI 门禁）。
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { OUT_DIR, httpPort, cdpPort, resolveEdgePath, TIMEOUT_MS, requireFile } from '../config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(OUT_DIR, 'colorblend');
mkdirSync(OUT, { recursive: true });
const PORT = httpPort(9811);
const CDP_PORT = cdpPort(9226);
// DXT1 正确解码的 clouds.tex（黑底 + 白云）；本仓库 fixture，不再依赖本机 workshop。
const CLOUDS_PNG = requireFile(
  join(here, '..', 'fixtures', 'clouds-dxt1.png'),
  'fixture 缺失时无法验证 colorBlendMode',
);

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#000}canvas{display:block}</style>
</head><body><script type="module" src="/harness.js"></script></body></html>`;

// 用 esbuild 把 harness 入口打成一个自包含 bundle（含 three / lz4js 等 bare specifier 依赖）。
const bundle = (await esbuild.build({
  entryPoints: [join(here, '..', 'harness', 'harness-colorblend-entry.mjs')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
  logLevel: 'silent',
})).outputFiles[0].text;

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.map': 'application/json' };
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let file;
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return;
  } else if (url.pathname === '/harness.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(bundle); return;
  } else if (url.pathname === '/clouds.png') {
    file = CLOUDS_PNG;
  } else {
    console.log('   [404]', url.pathname);
    res.writeHead(404); res.end('nf'); return;
  }
  if (!existsSync(file)) { res.writeHead(404); res.end('nf ' + file); return; }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let edge, ws, msgId = 0;
const pending = new Map();
const logs = [];
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });

// 就绪判据：harness 渲染完并采样后才打印 [probe]。轮询它替代固定 sleep —— 固定等待是 e2e 最脆的一环。
async function waitForProbe() {
  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    const line = logs.find((l) => l.startsWith('[probe]'));
    if (line) return line;
    await sleep(200);
  }
  return null;
}

try {
  await new Promise((r) => server.listen(PORT, r));
  console.log(`harness server: http://127.0.0.1:${PORT}/`);

  edge = spawn(resolveEdgePath(), [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(OUT, '.edge-cb')}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio', `--window-size=${800},${420}`,
    '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', 'about:blank',
  ], { stdio: 'ignore' });

  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) break; } catch {}
    await sleep(400);
  }
  const page = ((await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page'));
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }
    else if (m.method === 'Runtime.consoleAPICalled') logs.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
    else if (m.method === 'Log.entryAdded') logs.push(`[${m.params.entry.level}] ${m.params.entry.url ?? ''} ${m.params.entry.text}`);
    else if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? ''));
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');

  const results = {};
  for (const mode of [7, 0]) {
    logs.length = 0;
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?mode=${mode}` });
    const line = await waitForProbe();
    if (!line) console.log(`   ⚠️ mode=${mode} 在 ${TIMEOUT_MS}ms 内未打印 [probe]（判据将失败）`);
    const png = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `colorblend-mode${mode}.png`), Buffer.from(png.data, 'base64'));
    results[mode] = line ? JSON.parse(line.replace('[probe] ', '')) : null;
    console.log(`\n--- mode=${mode} ---`);
    console.log('  probe:', JSON.stringify(results[mode]));
    for (const l of logs.filter((l) => !l.startsWith('[probe]')).slice(0, 5)) console.log('  ' + l.slice(0, 180));
  }

  console.log('\n===== 判定 =====');
  const m7 = results[7], m0 = results[0];
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const checks = [
    ['mode=7（Screen）：云层黑底 == 纯背景（黑色完全不改变背景）',
      !!m7 && near(m7.samples.inCloudBlack[0], m7.samples.bgLeftRef[0], 3)],
    ['mode=0（旧行为）：同一处黑底把背景**压暗**（明显低于纯背景）',
      !!m0 && m0.samples.inCloudBlack[0] < m0.samples.bgLeftRef[0] * 0.7],
    ['mode=7 的黑底处明显亮于 mode=0（Screen 生效的直接证据）',
      !!m7 && !!m0 && m7.samples.inCloudBlack[0] > m0.samples.inCloudBlack[0] + 4],
    ['mode=7 的白云处亮于 mode=0（Screen 对亮部提亮）',
      !!m7 && !!m0 && m7.samples.inCloudTop[0] >= m0.samples.inCloudTop[0]],
    ['云层外的背景不受影响（两种模式一致）',
      !!m7 && !!m0 && near(m7.samples.bgRightRef[0], m0.samples.bgRightRef[0], 2)],
  ];
  let ok = true;
  for (const [name, pass] of checks) { console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) ok = false; }
  console.log(`\n结论：${ok ? '全部通过' : '存在失败项'}`);
  console.log(`截图：${OUT}`);
  if (!ok) process.exitCode = 1;
} catch (e) {
  console.error('ERROR:', e.message);
  process.exitCode = 1; // 脚本异常也必须非零，否则 CI 会把崩溃当通过
} finally {
  try { ws?.close(); } catch {}
  edge?.kill();
  server.close();
}
