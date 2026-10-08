// 真实 Chromium 计算样式验证：通知卡片（turn-trigger，「收到任务消息」）与代码块同底（AGENT.md §5.42）。
//
// 自起 http server + headless Edge（不依赖 DSH token），用 **DSH 真实样式**（从 app.asar 现场提取的
// 主题 token CSS + TurnTriggerNodeView / CodeBlock 组件 CSS）与 **插件真实 CSS**
// （esbuild 打包 src/client/styles.ts 导出的 WALLPAPER_CSS）渲染三种组合：
//   ?plugin=0&theme=dark   复现修复前的原生差异（卡片 = 8% 白 hover 底 vs 代码块 = 实色）
//   ?plugin=1&theme=dark   修复后应同底；卡内文字不被 --wp-chat-fg 反色（对照：普通正文仍被反色）
//   ?plugin=1&theme=light  浅色主题同样同底
// 用法：node e2e/verify/verify-turn-trigger-card.mjs [--port=9813] [--cdp-port=9228] [--asar=<path>]
// 退出码：0 = 全部判据通过；1 = 有判据失败或脚本异常（可作 CI 门禁）。
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { REPO, OUT_DIR, httpPort, cdpPort, resolveEdgePath, TIMEOUT_MS, argOf } from '../config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(OUT_DIR, 'turn-trigger');
mkdirSync(OUT, { recursive: true });
const PORT = httpPort(9813);
const CDP_PORT = cdpPort(9228);
const ASAR = argOf('asar', process.env.DSH_ASAR ?? 'E:/DeepseekHarness/resources/app.asar');
if (!existsSync(ASAR)) throw new Error(`找不到 DSH 的 app.asar：${ASAR}（可用 --asar=<path> 或 DSH_ASAR 指定）`);

const DSH = 'dsh/node_modules/@deepseek-ai';

// ── 极简 asar 读取（只取需要的几个文件） ──
const fd = openSync(ASAR, 'r');
const head = Buffer.alloc(16);
readSync(fd, head, 0, 16, 0);
const base = 8 + head.readUInt32LE(4);
const hb = Buffer.alloc(head.readUInt32LE(12));
readSync(fd, hb, 0, hb.length, 16);
const asarHeader = JSON.parse(hb.toString('utf8').replace(/\0+$/, ''));

function entryOf(path) {
  let cur = asarHeader;
  for (const seg of path.split('/')) {
    if (!cur.files?.[seg]) throw new Error(`asar 内缺文件：${path}`);
    cur = cur.files[seg];
  }
  return cur;
}
function textOf(path) {
  const e = entryOf(path);
  const buf = Buffer.alloc(e.size);
  readSync(fd, buf, 0, e.size, base + Number(e.offset));
  return buf.toString('utf8');
}

// DSH 主题 token CSS（内嵌在 theme client 里的一串 `var xxx_css_default = "..."`）
const themeJs = textOf(`${DSH}/dsh-client-ui-theme/lib/client.js`);
const themeCss = [...themeJs.matchAll(/var\s+(\w+_css_default)\s*=\s*"((?:[^"\\]|\\.)*)"/g)]
  .map((m) => JSON.parse(`"${m[2]}"`))
  .join('\n');
// 通知卡片组件 CSS（内联在 chat client 里，取哈希类名版本，最保真）
const chatJs = textOf(`${DSH}/dsh-client-ui-chat/lib/client.js`);
const triggerAt = chatJs.indexOf('TurnTriggerNodeView.module.css');
const triggerCss = JSON.parse(`"${/const\s+css\$\d+\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(chatJs.slice(triggerAt))[1]}"`);
// 代码块组件 CSS（源码形态，与下面 DOM 的 `.block` 类名自洽）
const codeCss = textOf(`${DSH}/dsh-client-ui-primitives/lib/markdown/CodeBlock.module.css`);

// 插件真实 CSS：esbuild 打包 styles.ts 后 import，直接拿导出常量（不用正则抓模板串）
const built = await esbuild.build({
  entryPoints: [join(REPO, 'src/client/styles.ts')],
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
});
const stylesTmp = join(OUT, 'styles.bundle.mjs');
writeFileSync(stylesTmp, built.outputFiles[0].text);
const { WALLPAPER_CSS } = await import(pathToFileURL(stylesTmp).href);

// ── 页面：真实 DOM 结构（类名/属性取自组件源码）+ 模拟亮壁纸写入 --wp-chat-fg=#000 ──
const page = (plugin, theme) => `<!doctype html><html><head><meta charset="utf-8">
<style>${themeCss}</style>
<style>${triggerCss}</style>
<style>${codeCss}</style>
${plugin ? `<style>${WALLPAPER_CSS}</style>` : ''}
<style>html,body{margin:0}</style>
</head>
<body ${theme === 'dark' ? 'data-ds-dark-theme' : ''} data-we-wallpaper>
<div class="xz4KEq_column">
  <div class="xz4KEq_flowItem">
    <section class="oE-XyW_root" data-turn-trigger>
      <button class="oE-XyW_header">
        <span class="oE-XyW_icon">✉</span>
        <span class="oE-XyW_title">收到任务消息</span>
        <span class="oE-XyW_time">16:11</span>
      </button>
      <div class="oE-XyW_body">
        <p class="oE-XyW_explanation">这条通知触发了本轮回复。</p>
        <div class="oE-XyW_content"><p>正文段落</p></div>
      </div>
    </section>
  </div>
  <div class="xz4KEq_flowItem"><p id="plain">普通正文（对照）</p></div>
  <div class="xz4KEq_flowItem">
    <div class="block">
      <div class="bannerWrap"><div class="banner"><span class="infostring">python</span></div></div>
      <pre class="shiki"><code><span class="line">print(1)</span></code></pre>
    </div>
  </div>
</div>
<script>document.documentElement.style.setProperty('--wp-chat-fg', '#000');</script>
</body></html>`;

const server = createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const plugin = u.searchParams.get('plugin') === '1';
  const theme = u.searchParams.get('theme') === 'light' ? 'light' : 'dark';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page(plugin, theme));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let edge, ws, msgId = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, { resolve: res, reject: rej });
  ws.send(JSON.stringify({ id, method, params }));
});

const PROBE = `(() => {
  const cs = (sel) => getComputedStyle(document.querySelector(sel));
  const card = document.querySelector('[data-turn-trigger]');
  return JSON.stringify({
    cardBg: getComputedStyle(card).backgroundColor,
    cardBgToken: getComputedStyle(card).getPropertyValue('--dsw-alias-turn-trigger-bg').trim(),
    cardHoverToken: getComputedStyle(card).getPropertyValue('--dsw-alias-turn-trigger-bg-hover').trim(),
    cardContentColor: cs('.oE-XyW_content p').color,
    cardContentShadow: cs('.oE-XyW_content p').textShadow,
    headerColor: cs('.oE-XyW_title').color,
    explColor: cs('.oE-XyW_explanation').color,
    plainColor: cs('#plain').color,
    codePreBg: cs('pre.shiki').backgroundColor,
    codeBlockBg: cs('.block').backgroundColor,
    bodyClass: document.body.getAttributeNames().join(','),
  });
})()`;

async function measure(plugin, theme) {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?plugin=${plugin}&theme=${theme}` });
  await sleep(400);
  const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
  const data = JSON.parse(r.result.value);
  // hover 伪态：用 CDP 强制 :hover，读卡片底是否仍与代码块同色（不再透回壁纸）
  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-turn-trigger]' });
  await send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
  const hr = await send('Runtime.evaluate', {
    expression: `getComputedStyle(document.querySelector('[data-turn-trigger]')).backgroundColor`,
    returnByValue: true,
  });
  data.cardHoverBg = hr.result.value;
  await send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
  return data;
}

try {
  await new Promise((r) => server.listen(PORT, r));
  console.log(`harness server: http://127.0.0.1:${PORT}/`);

  edge = spawn(resolveEdgePath(), [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(OUT, '.edge-tt')}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio', '--window-size=900,500',
    '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', 'about:blank',
  ], { stdio: 'ignore' });

  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) break; } catch {}
    await sleep(400);
  }
  const target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP WebSocket 连接失败')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable'); await send('CSS.enable');

  const before = await measure(0, 'dark');
  const dark = await measure(1, 'dark');
  const light = await measure(1, 'light');
  console.log('\n--- plugin=0 dark（修复前）---', JSON.stringify(before));
  console.log('\n--- plugin=1 dark（修复后）---', JSON.stringify(dark));
  console.log('\n--- plugin=1 light（修复后）---', JSON.stringify(light));

  const CODE_DARK = 'rgb(27, 27, 28)'; // --dsw-static-neutral-bluish-900
  const CODE_LIGHT = 'rgb(249, 250, 251)'; // --dsw-static-neutral-bluish-50
  const HOVER_NATIVE = 'rgba(255, 255, 255, 0.08)'; // --dsw-alias-interactive-bg-hover（深色）

  const checks = [
    ['修复前复现原生差异：卡片是 8% 白 hover 底、代码块是实色（两者不同）',
      before.cardBg === HOVER_NATIVE && before.codeBlockBg === CODE_DARK && before.cardBg !== before.codeBlockBg],
    ['修复后（深色）卡片底 == 代码块底 == #1b1b1c',
      dark.cardBg === CODE_DARK && dark.codeBlockBg === CODE_DARK && dark.codePreBg === CODE_DARK],
    ['修复后（深色）hover 卡片底仍 == 代码块底（不再透回壁纸）',
      dark.cardHoverBg === CODE_DARK],
    ['修复后（浅色）卡片底 == 代码块底 == #f9fafb',
      light.cardBg === CODE_LIGHT && light.codeBlockBg === CODE_LIGHT],
    ['修复后卡内文字用主题色（label-primary 深色 #f9fafb），不被 --wp-chat-fg 反色',
      dark.cardContentColor === 'rgb(249, 250, 251)'],
    ['对照：同一页面普通正文确实被 --wp-chat-fg 反成黑（证明反色机制生效，排除假通过）',
      dark.plainColor === 'rgb(0, 0, 0)' && dark.cardContentColor !== dark.plainColor],
    ['修复后卡内文字描边复位（text-shadow: none）',
      dark.cardContentShadow === 'none'],
    ['修复后 header（图标/标题/时间）保留 label-tertiary、说明保留 label-secondary',
      dark.headerColor !== dark.cardContentColor && dark.explColor !== dark.cardContentColor],
    ['body 主题属性符合预期（data-ds-dark-theme + data-we-wallpaper）',
      dark.bodyClass.includes('data-ds-dark-theme') && dark.bodyClass.includes('data-we-wallpaper')
      && !light.bodyClass.includes('data-ds-dark-theme')],
  ];

  console.log('\n===== 判定 =====');
  let ok = true;
  for (const [name, pass] of checks) { console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) ok = false; }
  console.log(`\n结论：${ok ? '全部通过' : '存在失败项'}`);
  if (!ok) process.exitCode = 1;
} catch (e) {
  console.error('ERROR:', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  edge?.kill();
  server.close();
  closeSync(fd);
}
