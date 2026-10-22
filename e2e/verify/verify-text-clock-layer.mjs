// 真实渲染验证：「魔兽之门」1922570576 的 text 时钟层（右下角 `HH:MM:SS` LED 数字）是否渲染出来。
//
// 自起 http server（复刻 host 的三条资源路由：`/wallpapers/scene/<id>/asset`、
// `/wallpapers/static/<file>`、`/wallpapers/particle-texture`）+ headless Edge（不依赖 DSH token），
// 用**生产 `lib/`** 渲染真实壁纸（素材来自本机 workshop + WE 安装目录）。
//
// A/B 对照（同一份 lib、同一页面骨架）：
//   ?broken=script —— 把 `getTextScriptRuntime` 注入成「永远返回 null」= **修复前的行为**
//                    （`obj.script && !binding && !isClock → continue` ⇒ text 层整层跳过）；
//   （无参数）     —— 生产路径（脚本 bind 成功 ⇒ 文本层被装配）。
// 判据（**不依赖坐标投影换算** —— 本脚本第一版算错了一次 canvas y 方向与屏幕 quad 的对应关系，
// 于是「数字明明在画面上」却被量成 Δ7；现在的口径全部是像素事实 + 生产公开 API）：
//   [1] 修复前装配（`getTextScriptRuntime` 注入 null）不产生文本层；[2] 生产装配产生（`player.displayObject`）。
//   [3] 文本 quad 落在右下角；[3b] 矩形精确匹配 anchor 语义基线（±2px，锚点/布局回归的硬判据）。
//   [4] 文本层画布上真的画出了白色字形（亮像素数 / 包围盒）。
//   [5] 字体从引擎目录命中（<WE>/assets/fonts/CursedTimerUlil-Aznm.ttf）。 [6] 字形 alpha 未被压淡。
//   [7] 屏幕上能读到白字（右下角「隐藏该层时暗、显示时亮」的像素数与亮度 —— 因果绑定的口径，
//       右下角本来就亮的粒子高光不算）。 [8] 隐藏该层后右下角确实变暗。
//   [9]（**核心，2026-10-13 修复轮 2 → 修复轮 4 改相对口径**）**同相位 + 相对（尺度无关）**判据：接管 rAF
//       （受控推帧）、把动画时钟（`performance.now`）与墙钟（`Date`）都钉死在同一时刻 ⇒ 「该层显示帧 vs
//       隐藏帧」的背景逐像素一致（两帧都隐藏的对照实测 0 px），且时钟文本内容确定。
//       分母 = **同一冻结帧内该层自身字形足迹** `glyphMask`（`__textGlyphScreenPixels`：把该层纹理按 quad
//       投影反投到屏幕、按纹理足迹 alpha 均值 ≥15 取掩码；只读「该层纹理 + 几何」⇒ 与覆盖率/透明度注入
//       无关）。两个分子都取**足迹内**的强变化（全屏 Δ≥8 中落在足迹外的那部分是它带动的屏幕空间光晕）：
//       ① 点亮比例 = 足迹内 Δ≥8 像素数 ÷ 足迹（健康态 ≈0.96–0.99；文本衰减 k% ⇒ ≈1−k）；
//       ② 平均亮度 = 足迹内亮度总量 ÷ 足迹（健康态 ≈124–130；透明度衰减只压亮度、几乎不减像素）。
//       **绝对阈值（旧的 7800 px / 480000 ink）已删**：它们随时钟内容整体换挡（最窄内容 `11:11:11`
//       健康态只有 4782 px / 338839 ink ⇒ 旧口径必然假红）。旧绝对值仍逐次打印作对照，但不进判定。
//   [10] 同相位基线（两帧都隐藏时的背景残差：全屏 / 外扩盒 / 三站）必须 ≈0 —— 「背景真的抵消了」的自证；
//       **并且**断言墙钟冻结真的生效：两次「显示」帧的 A/A 残差 `spAA ≤ 60 px`（(2026-10-13 修复轮 3)
//       此前这一半只打印不断言 ⇒ 墙钟一旦没冻住，内容变化会混进分子而全线假绿；负向对照见 `--live-wallclock`）。
//   [11] 受控推帧生效（真正在推帧、帧内无异常）。 [12] 判据用**全屏 Δ≥8**（强阈值）差异的包围盒必须落在
//       该文本 quad ±6 内；弱阈值 Δ≥2 下盒外仍有 ≤7 的量化级响应（判据行有 Δ≥8 限定，别按它写「严格」）。
//   [13] 恢复显示后与隐藏前的差异回到噪声地板。 [14] 参考区几何有效（防 `diffPng` 静默 clamp）。
//   [15]–[20] 牙（默认开，`--no-teeth` 关）：整层缺失 / 覆盖率 50% / 覆盖率 90% / 透明度 50% / 透明度 90%
//       各断言 [9] 判假，并自证「能检出的最小衰减 ≤50%」。
// 退出码：0 = 全部判据通过；1 = 有判据失败或脚本异常（CI 门禁）。
//
// 术语：**对象盒** = `__objectRect(778).canvasCss`（本例 `[930,692,1261,777]`，判据 [3b] 按 ±2px 精确断言）；
// **外扩盒** = 判据用的 `box`（对象盒每边外扩，本例 `[928,690,1264,780]`，面积 30667 px）。下文的「quad」一律指外扩盒。
//
// 为什么不再是「增量口径」（修复轮 1 → 轮 2）：轮 1 的分子 = 「健康装配 A/B」−「缺失装配 A/B」，
// 两臂是**两次独立渲染**（水面相位不同）⇒ 跨装配水面基线 ≈13k px 压过了该层自身 ≈3k px 的贡献，
// 阈值被顶到 7.4–8.6k ⇒ 部分衰减检不出（只有整层缺失必然红）。轮 2 改成**同相位**：两帧只差
// 「该层渲染出多少」，背景残差实测 0 px ⇒ 阈值降到 7.8k/48 万（按实测标定），50% 的覆盖衰减与
// 50% 的亮度衰减都能判红（逐档数字见 report fix-round-2.md 与 §5.45 的日志文件名）。
// 为什么轮 4 又改成**相对口径**：那对绝对阈值随**冻结那一刻的时钟内容**整体换挡（分子 ≈ 点亮段数）——
// 三个内容档实测全屏分子 14752 / 8337 / 4782 px（`08:08:08` / `10:14:41` / `11:11:11`），最窄档双双
// 低于旧阈值 ⇒ 健康态假红；同一阈值还要同时压在「覆盖率 0.5 档最高 7022 px」之下，两侧最坏只差 1.28×。
// 改相对后同一三档的比值 0.988 / 0.976 / 0.959（n=3，逐次日志见 fix-round-4.md 的表）。
// 旧口径的跨帧数字仍打印（`【对照】跨帧口径（旧）`），用于对照「同相位消掉了多少背景噪声」。
// [13] 恢复态判据沿用轮 1 的口径（外扩盒内两个「文本可见」帧的差异 ×2 + 50，并按区域面积 90% 封顶，
// 否则 `2·dAA+50` 在 dAA ≥ 15309 px 时必然成立 = 恒真）。
// `--teeth`（**默认验收命令已带**：`npm run e2e:textclock`）：额外跑「整层缺失装配」与部分衰减扫描
// （覆盖率 / 透明度），断言 [9] 的表达式在这些状态下**必须为假**（牙），并报出能检出的最小衰减。
//
// ⚠️ 依赖本机素材（workshop 壁纸 + WE 安装目录），CI 上会因缺素材失败 —— 没有加进 ci.yml。
// 用法：node e2e/verify/verify-text-clock-layer.mjs [--workshop=<dir>] [--assets=<dir>]
//        [--port=9813] [--cdp-port=9228] [--gpu] [--no-teeth] [--sweep=<覆盖率列表>] [--dim=<透明度列表>]
//        [--at=HH:MM:SS（把冻结墙钟钉到该本地时刻 ⇒ 时钟内容可控，用来验尺度无关性；缺省钉在当下；
//         时/分/秒越界（0–23 / 0–59 / 0–59）直接报错退出，不做归一化）]
//        [--live-wallclock（负向对照：不冻墙钟 + 真实时间前进 1.2 s ⇒ [10] 必须判 FAIL）]
//        （`--sweep`/`--dim` 只**追加**扫描档位；牙指定的 0.5 / 0.1 两档永远在列）
// ⚠️ `--at` 只覆盖**内容**维度（冻结那一刻的时钟文本）。**换 quad 几何（对象世界尺寸 / 屏幕占位）或纹理尺寸
//    后必须重标定**：掩码的**孔径 = 足迹半径**（`W/sw/2`，本例 1.33 texel ⇒ round 成 3×3 texel 积分窗口）
//    与两个阈值（0.65 / 88）都只在本例几何（纹理 884×228 → 屏幕 ≈332×86）下成立，照原样跑会假红/假绿。
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { OUT_DIR, WE_WORKSHOP, WE_ASSETS, httpPort, cdpPort, resolveEdgePath, TIMEOUT_MS, argOf, flagOf, requireFile } from '../config.mjs';
import { decodePng } from '../lib/png-stats.mjs';

const WALLPAPER_ID = '1922570576'; // 魔兽之门
const TEXT_OBJECT_ID = 778;        // scene.json 里的 "3D Clock"
// anchor 语义基线（v0.8.2 F12 评审）：obj778 = anchor center + verticalalign top ⇒ quad 中心 = origin，
// 故比仅按 verticalalign=top 时上移约 31px。rect 由固定视口/布局唯一决定，判据 [3b] 用 ±2px 精确断言。
const TEXT_RECT_BASELINE = [930, 692, 1261, 777];

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(OUT_DIR, 'text-clock');
mkdirSync(OUT, { recursive: true });
const PORT = httpPort(9813);
const CDP_PORT = cdpPort(9228);
const USE_GPU = flagOf('gpu');
const TEETH = !flagOf('no-teeth'); // 牙的标定自检**默认开**（成本 ≈1.2 s，见 header 与 TESTING.md §2.6）
// `--live-wallclock` = **负向对照**（默认关，正常验收不跑）：不冻墙钟，并在两次「显示」帧之间让**真实**
// 时间前进 1.2 s ⇒ 秒位必然跳动。用来证明 [10] 里新加的 `spAA ≤ 60 px` 那一半**真的会红**（不是只打印）。
const LIVE_WALLCLOCK = flagOf('live-wallclock');
// `--at=HH:MM:SS`（本地时间，默认关 = 钉在当下）：把冻结墙钟钉到指定时刻 ⇒ **时钟内容可控**。
// 用途：[9] 改相对口径后，要在多个差异明显的内容档（全宽 `08:08:08` / 窄 `10:14:41` / 最窄 `11:11:11`）
// 上验证「比值与内容无关」，而真实时间不可等；不指定时行为与修复轮 3 完全一致（钉在当下那一刻）。
const AT_SPEC = argOf('at', '');
function atMsOf(spec) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(spec ?? ''));
  if (!m) return null;
  const [hh, mm, ss] = m.slice(1).map(Number);
  // 范围校验：`setHours` 会把越界值静默进位（`25:00:00` → 次日 `01:00:00`）⇒ 冻结内容与请求不符，直接判非法。
  if (hh > 23 || mm > 59 || ss > 59) return null;
  const d = new Date();
  d.setHours(hh, mm, ss, 0);
  return d.getTime();
}
const AT_MS = AT_SPEC ? atMsOf(AT_SPEC) : null;
if (AT_SPEC && AT_MS === null) {
  console.error(`✗ --at 需为本地 24 小时制 HH:MM:SS（时 0–23、分 0–59、秒 0–59）；收到 ${AT_SPEC}`);
  process.exit(1); // 不做静默归一化：那样日志会打着传入值、实际冻的却是另一天的时刻
}
/** 本地 `HH:MM:SS`（日志里自证「这一跑冻的是哪段时钟内容」）。 */
function localHmsOf(ms) {
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
// 判据 [9] 分子的「强变化」下限：逐像素最大通道差 ≥ 8 才计入（该层显示时水面有 ±2..4 的量化级响应，
// 实测 Δ≥8 的部分全屏为 0 px ⇒ 盒外上界只能**推出** ≤7 = STRONG_DELTA−1；见 §5.45 的「为什么不是 Δ≥2」）。
const STRONG_DELTA = 8;

const ID = argOf('id', WALLPAPER_ID);
const WS = argOf('workshop', WE_WORKSHOP);
const WE = argOf('assets', WE_ASSETS);
const PKG = requireFile(join(WS, ID, 'scene.pkg'), `本机缺少壁纸 ${ID}（用 --workshop=<dir> 指定）`);
// quickjs 沙箱 wasm：优先 dist/static/quickjs.wasm（build:client 的产物，页面加载的就是它），
// 缺省回退 node_modules（pnpm 下真实路径在 .pnpm/<pkg>@<ver>/node_modules/... —— 顶层 @jitl/
// 不是直接依赖，`node_modules/@jitl/...` 在 pnpm 布局下不存在，故这里两处都找）。
function resolveQuickjsWasm() {
  const candidates = [
    join(here, '..', '..', 'dist', 'static', 'quickjs.wasm'),
    join(here, '..', '..', 'node_modules', '@jitl', 'quickjs-wasmfile-release-sync', 'dist', 'emscripten-module.wasm'),
  ];
  const pnpmDir = join(here, '..', '..', 'node_modules', '.pnpm');
  if (existsSync(pnpmDir)) {
    for (const d of readdirSync(pnpmDir).filter((n) => n.startsWith('@jitl+quickjs-wasmfile-release-sync@'))) {
      candidates.push(join(pnpmDir, d, 'node_modules', '@jitl', 'quickjs-wasmfile-release-sync', 'dist', 'emscripten-module.wasm'));
    }
  }
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error('找不到 quickjs.wasm（先 `npm run build:client` 或 `pnpm install`）');
  return hit;
}
const QUICKJS_WASM = resolveQuickjsWasm();

// ── 复刻 host 的 pkg 读取（只读需要的两条：scene.json / 字体 / image 纹理）──────────────────
const { PkgReader } = await import('../../lib/host/pkg-reader.js');
const reader = new PkgReader(PKG);
const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.map': 'application/json',
};

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#000}canvas{display:block}</style>
</head><body><script type="module" src="/harness.js"></script></body></html>`;

// 引擎目录命中的场景素材（探针用：证明字体真的是从 `<WE>/assets` 取的）
const assetHits = [];

const bundle = (await esbuild.build({
  entryPoints: [join(here, '..', 'harness', 'harness-text-clock-entry.mjs')],
  bundle: true, format: 'esm', target: 'es2022', write: false, logLevel: 'silent',
})).outputFiles[0].text;

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const send = (body, type) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  try {
    if (p === '/' || p === '/index.html') return send(HTML, 'text/html; charset=utf-8');
    if (p === '/harness.js') return send(bundle, 'text/javascript; charset=utf-8');
    if (p.startsWith('/wallpapers/static/')) {
      const file = p.slice('/wallpapers/static/'.length);
      if (file === 'quickjs.wasm') return send(readFileSync(QUICKJS_WASM), 'application/wasm');
      const local = join(here, '..', '..', 'dist', 'static', file);
      if (existsSync(local)) return send(readFileSync(local), MIME[extname(file)] ?? 'application/octet-stream');
      console.log('   [404 static]', file); res.writeHead(404); return res.end('nf');
    }
    if (p.startsWith('/wallpapers/scene/')) {
      const name = url.searchParams.get('name') ?? '';
      // 复刻 host 的两级查找：scene.pkg 优先，其次 **WE 引擎 assets 目录**
      // （WE 把引擎 assets 也挂在 VFS 的 `/` 上，所以 `fonts/X.ttf` 这类路径可能只在引擎目录里；
      //   「魔兽之门」1922570576 的 3D Clock 字体就是这种 —— 它的 scene.pkg 里零字体文件）。
      const entry = reader.readEntry(name);
      if (entry) return send(entry, MIME[extname(name)] ?? 'application/octet-stream');
      const engineBase = resolve(join(WE, 'assets'));
      const engine = name ? resolve(engineBase, name) : engineBase;
      if (name.includes('..') || engine === engineBase || !engine.startsWith(engineBase)
        || !existsSync(engine) || !statSync(engine).isFile()) {
        console.log('   [404 asset]', name);
        res.writeHead(404); return res.end('nf');
      }
      assetHits.push({ name, source: 'engine', bytes: statSync(engine).size });
      return send(readFileSync(engine), MIME[extname(name)] ?? 'application/octet-stream');
    }
    if (p === '/wallpapers/particle-texture') {
      const name = url.searchParams.get('name') ?? '';
      const inPkg = reader.readEntry(`materials/${name}.tex`);
      if (inPkg) return send(inPkg, 'application/octet-stream');
      const file = resolve(join(WE, 'assets', 'materials'), name + '.tex');
      if (existsSync(file) && statSync(file).isFile()) return send(readFileSync(file), 'application/octet-stream');
      console.log('   [404 ptex]', name); res.writeHead(404); return res.end('nf');
    }
    console.log('   [404]', p);
    res.writeHead(404); res.end('nf');
  } catch (e) {
    console.log('   [500]', p, String(e && e.message));
    res.writeHead(500); res.end('err');
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `lib/` 身份摘要：标定结论要能自证「这份日志跑的是哪份产物」（产物无版本戳，取短哈希）。 */
function libIdentity() {
  const rel = ['client/three-renderer.js', 'client/tex-loader.js', 'host/pkg-reader.js'];
  const out = {};
  for (const r of rel) {
    const p = join(here, '..', '..', 'lib', r);
    out[r] = existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 8) : 'missing';
  }
  return out;
}
let edge, ws, msgId = 0;
const pending = new Map();
let logs = [];
const send2 = (method, params = {}) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });

async function evalJs(expression) {
  const r = await send2('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
}

// 就绪判据：harness 打印 [harness] 且 window.__ready 为真（固定 sleep 是 e2e 最脆的一环）。
async function waitReady() {
  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    try { if (await evalJs('window.__ready === true')) return true; } catch { /* 导航中 */ }
    if (logs.some((l) => l.startsWith('[harness]'))) return true;
    await sleep(200);
  }
  return false;
}

/** 逐像素比较两张同尺寸 PNG：返回差异统计与包围盒。
 *  `box` 给定时只统计该矩形（画布 CSS 像素）内的差异；缺省统计整个画布区域。
 *  `minDelta` = 计入统计的逐像素最大通道差下限（缺省 2 = 全仓 e2e 的「变过」口径）。
 *  `maskSet` = 像素集合（打包 `y*VW+x`，见 `__textGlyphScreenPixels` 的 mask）；给了就额外统计
 *  「落在掩码内」的变化像素数 `changedInMask` 与其亮度总量 `inkInMask`（判据 [9] 的两个相对分子：
 *  足迹内的点亮比例与平均亮度 —— 剔除该层带动的光晕，只留它自己的字形足迹）。 */
function diffPng(a, b, vw, vh, box, minDelta = 2, maskSet = null) {
  // 截图缺失时**报错**而不是静默 null 解引用（否则异常发生在深处，看不出是哪一步没拍到）。
  if (!a || !b) throw new Error(`截图缺失（${!a && !b ? 'A/B' : !a ? 'A' : 'B'} 为 undefined）`);
  const A = decodePng(a), B = decodePng(b);
  if (A.width !== B.width || A.height !== B.height) throw new Error('截图尺寸不一致');
  const w = Math.min(A.width, vw), h = Math.min(A.height, vh);
  const x0b = box ? Math.max(0, box[0]) : 0;
  const y0b = box ? Math.max(0, box[1]) : 0;
  const x1b = box ? Math.min(w - 1, box[2]) : w - 1;
  const y1b = box ? Math.min(h - 1, box[3]) : h - 1;
  let n = 0, maxD = 0, sx = 0, sy = 0, sumD = 0, nMask = 0, sumMask = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = y0b; y <= y1b; y++) {
    for (let x = x0b; x <= x1b; x++) {
      const ia = (y * A.width + x) * A.channels, ib = (y * B.width + x) * B.channels;
      const d = Math.max(
        Math.abs(A.data[ia] - B.data[ib]),
        Math.abs(A.data[ia + 1] - B.data[ib + 1]),
        Math.abs(A.data[ia + 2] - B.data[ib + 2]),
      );
      if (d >= minDelta) {
        n++; sumD += d; sx += x; sy += y;
        if (maskSet && maskSet.has(y * vw + x)) { nMask++; sumMask += d; }
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (d > maxD) maxD = d;
    }
  }
  const total = (x1b - x0b + 1) * (y1b - y0b + 1);
  return {
    size: [A.width, A.height],
    region: box ?? 'full',
    changedPixels: n,
    changedInMask: maskSet ? nMask : null,
    inkInMask: maskSet ? Math.round(sumMask) : null,
    changedRatio: total > 0 ? n / total : 0,
    maxDelta: maxD,
    meanDelta: n ? sumD / n : 0,
    bbox: n ? [x0, y0, x1, y1] : null,
    centroid: n ? [sx / n, sy / n] : null,
  };
}

/** 只统计 `box` **之外**的差异（`minDelta` 缺省 2 = 全仓弱阈值）：盒外渗了多少像素、峰值多大、蔓延到哪。
 *  只作对照打印（判据 [12] 用**强阈值**全屏包围盒）：弱阈值下盒外本来就有该层带动的量化级响应。 */
function diffOutsidePng(a, b, vw, vh, box, minDelta = 2) {
  const A = decodePng(a), B = decodePng(b);
  const w = Math.min(A.width, vw), h = Math.min(A.height, vh);
  const inBox = (x, y) => !!box && x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
  let n = 0, maxD = 0, over = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (inBox(x, y)) continue;
      const ia = (y * A.width + x) * A.channels, ib = (y * B.width + x) * B.channels;
      const d = Math.max(
        Math.abs(A.data[ia] - B.data[ib]),
        Math.abs(A.data[ia + 1] - B.data[ib + 1]),
        Math.abs(A.data[ia + 2] - B.data[ib + 2]),
      );
      if (d > maxD) maxD = d;
      if (d >= minDelta) {
        n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        // 「外溢」= 变化像素超出 quad **边界**的最大距离（判据 [12] 的容差是 ±6 ⇒ 越出容差的部分 = 该值 − 6）。
        if (box) over = Math.max(over, box[0] - x, x - box[2], box[1] - y, y - box[3]);
      }
    }
  }
  return { minDelta, changedPixels: n, maxDelta: maxD, bbox: n ? [x0, y0, x1, y1] : null, maxOverflowPx: over };
}

/** 统计某个矩形里的「亮像素」（三通道均 > 阈值）与区域基准亮度（中位数）。 */
function brightStats(img, rect, thr) {
  const [x0, y0, x1, y1] = rect;
  let bright = 0, sum = 0, cnt = 0;
  const lums = [];
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
      const o = (y * img.width + x) * img.channels;
      const r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
      const lum = (r + g + b) / 3;
      lums.push(lum); sum += lum; cnt++;
      if (r > thr && g > thr && b > thr) bright++;
    }
  }
  lums.sort((a, b) => a - b);
  return {
    pixels: cnt,
    brightPixels: bright,
    brightRatio: cnt ? bright / cnt : 0,
    medianLuma: cnt ? lums[Math.floor(lums.length / 2)] : 0,
    meanLuma: cnt ? sum / cnt : 0,
    maxLuma: cnt ? lums[lums.length - 1] : 0,
  };
}

// 判据用的「文本区域」= 画面右下角（文本层所在的 1/3×2/3 区块）。坐标映射曾算错过一次
// （canvas 的 y 方向与屏幕 quad 的对应关系），所以判据不依赖投影换算，只用**固定的屏幕区域**
// 与像素事实：白字在右下角 → luma > 200 的像素大量出现在这里。
const textRegion = (vw, vh) => [
  Math.round(vw * 0.55), Math.round(vh * 0.6),
  Math.round(vw * 0.95), Math.round(vh * 0.98),
];

/** 精确 rect 断言（画布 CSS 像素，每边容差 tol）：obj778 的 quad 几何由 anchor/布局唯一决定。 */
const rectNear = (r, want, tol) => !!r && Array.isArray(r.canvasCss) && r.canvasCss.length === 4
  && r.canvasCss.every((v, i) => Math.abs(v - want[i]) <= tol);

try {
  await new Promise((r) => server.listen(PORT, r));
  console.log(`harness server: http://127.0.0.1:${PORT}/  （壁纸 ${ID}）`);
  const libId = libIdentity();
  console.log('  lib 身份（sha256 前 8 位）:', JSON.stringify(libId));

  edge = spawn(resolveEdgePath(), [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(OUT, '.edge-text-clock')}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio', `--window-size=1600,900`,
    ...(USE_GPU ? ['--use-angle=d3d11', '--ignore-gpu-blocklist'] : ['--enable-unsafe-swiftshader']),
    '--disable-gpu-sandbox', 'about:blank',
  ], { stdio: 'ignore' });

  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) break; } catch { /* 未就绪 */ }
    await sleep(400);
  }
  const pages = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json());
  console.log('   CDP 目标:', pages.map((t) => `${t.type}:${String(t.url).slice(0, 60)}`).join(' | '));
  // 只取「本进程刚启动的那个 about:blank 页面」：上一轮崩溃残留的 Edge 也会带着同名 CDP 端口
  // 和同 URL 的页面，连错目标时会读到「没有 __ready 的空页面」（实测过）。
  const page = pages.find((t) => t.type === 'page' && String(t.url).startsWith('about:'))
    ?? pages.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) { const pp = pending.get(m.id); if (pp) { pending.delete(m.id); m.error ? pp.reject(new Error(m.error.message)) : pp.resolve(m.result); } }
    else if (m.method === 'Runtime.consoleAPICalled') logs.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
    else if (m.method === 'Log.entryAdded') logs.push(`[${m.params.entry.level}] ${m.params.entry.url ?? ''} ${m.params.entry.text}`);
    else if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails?.exception?.description ?? ''));
  };
  await send2('Runtime.enable'); await send2('Log.enable'); await send2('Page.enable');
  // 固定视口：headless 新建窗口的 innerHeight 会被任务栏/窗口夹到 450 左右，画布与截图都不是
  // 我们声明的 1600×900（实测 500×450）。视口不钉住的话，右下角判据会在错误的坐标系里取像素。
  await send2('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });

  const VW = 1600, VH = 900;
  const shots = {};
  const info = {};

  /** 同页一步：切换脚本运行时可用性 → 等帧 → 截图 + 观测文本 quad。 */
  const step = async (tag, brokenRuntime) => {
    logs = [];
    const sw = await evalJs(`window.__switchScriptRuntime(${brokenRuntime})`);
    await sleep(700);
    const rect = JSON.parse(await evalJs(`JSON.stringify(window.__objectRect(${TEXT_OBJECT_ID}))`));
    const shot = await send2('Page.captureScreenshot', { format: 'png' });
    shots[tag] = Buffer.from(shot.data, 'base64');
    writeFileSync(join(OUT, `text-clock-${tag}.png`), shots[tag]);
    info[tag] = {
      switch: sw, rect,
      harnessLine: logs.find((l) => l.startsWith('[harness]')) ?? null,
      warnings: logs.filter((l) => /text-script|编译失败|WARN/i.test(l)).slice(0, 4),
    };
    console.log(`\n--- ${tag}（broken=${brokenRuntime}）---`);
    console.log('  文本对象矩形（画布 CSS 像素）:', JSON.stringify(rect));
    info[tag].textCanvas = JSON.parse(await evalJs(`JSON.stringify(window.__textCanvasImage(${TEXT_OBJECT_ID}))`) ?? 'null');
    console.log('  文本画布内容（亮像素 = 白色文本）:', JSON.stringify(info[tag].textCanvas));
    for (const l of info[tag].warnings) console.log('  ' + l.slice(0, 160));
  };

  /** 只切该图层的可见性（不重渲染）→ 截图。返回 { shot, rect, toggle }。 */
  const isolateStep = async (tag, hidden) => {
    logs = [];
    const toggle = await evalJs(`JSON.stringify(window.__hideTextLayer(${TEXT_OBJECT_ID}, ${hidden}))`).then(JSON.parse);
    const rect = JSON.parse(await evalJs(`JSON.stringify(window.__objectRect(${TEXT_OBJECT_ID}))`));
    await sleep(400);
    const shot = await send2('Page.captureScreenshot', { format: 'png' });
    shots[tag] = Buffer.from(shot.data, 'base64');
    writeFileSync(join(OUT, `text-clock-${tag}.png`), shots[tag]);
    info[tag] = { toggle, rect };
    console.log(`\n--- ${tag}（文本层 ${hidden ? '隐藏' : '显示'}）---`);
    console.log('  toggle:', JSON.stringify(toggle));
    return shots[tag];
  };

  // ① 语义 A/B：同页切脚本运行时（修复后 / 修复前装配）
  await send2('Page.navigate', { url: `http://127.0.0.1:${PORT}/?id=${ID}&vw=${VW}&vh=${VH}` });
  const ready = await waitReady();
  if (!ready) {
    console.log(`   ⚠️ 页面在 ${TIMEOUT_MS}ms 内未就绪（判据将失败）`);
    console.log('   页面状态:', await evalJs(`JSON.stringify({ href: location.href, bodyHtml: document.body.innerHTML.slice(0, 80), scripts: [...document.scripts].map((s) => s.src) })`));
  }
  await sleep(600);
  // [perf] 1080p FPS 参考值（AGENT.md P1 门槛不在本脚本判定）；顺带打印真实渲染器自证非软栅
  // 注：CDP 的 Runtime.evaluate 不支持顶层 await ⇒ 用 async IIFE 包一层。
  try {
    // 探针已自带 JSON 序列化，勿再套一层（双重编码看不出字段）；软栅 / 取不到 ext 时 FPS 无意义，只告警。
    const rendererJson = await evalJs('JSON.stringify(window.__glRendererInfo())');
    console.log('  [perf] renderer:', rendererJson);
    const rendererName = JSON.parse(rendererJson ?? '{}').renderer ?? 'unknown';
    // 软栅含 WARP（`Microsoft Basic Render Driver`）；`unknown` 只是拿不到 `WEBGL_debug_renderer_info`。
    const softRenderer = rendererName === 'unknown'
      || /swiftshader|llvmpipe|software|basic render|softpipe|mesa offscreen/i.test(rendererName);
    if (softRenderer) {
      const why = rendererName === 'unknown' ? '拿不到渲染器信息（unknown）' : `软栅渲染器（${rendererName}）`;
      console.log(`  ⚠️ ${why} ⇒ 下面的 FPS 不可当门禁（本脚本不把 FPS 作为判据，仅供参考）`);
    }
  } catch (e) { console.log('  [perf] renderer 取用失败:', String(e).slice(0, 120)); }
  try { console.log('  [perf]', await evalJs('(async () => JSON.stringify(await window.__fpsProbe(5000)))()')); }
  catch (e) { console.log('  [perf] 采集失败:', String(e).slice(0, 120)); }
  await step('normal', false);
  await step('broken', true);

  // ② 跨帧像素 A/B（**只服务 [3] 白字 / [8] 变暗 / [13] 恢复态** —— 这三条不要求背景同相位）：
  //    show → hide → show（A/A 作恢复态噪声地板：只差数百 ms 的粒子/水面相位）。
  await step('repaired', false);
  await isolateStep('iso-show', false);
  await isolateStep('iso-hide', true);
  await isolateStep('iso-show2', false);
  // 回到修复前装配，它的文本层根本不存在（同一页面里再确认一次）
  await step('broken2', true);
  const brokenVisible = await evalJs('window.__hideTextLayer(778, false)');

  const rect = info.normal.rect;
  const region = textRegion(VW, VH);
  // A/B 像素差异只在文本 quad 矩形内统计（外扩 2px），其余区域不计 —— 与「不外溢」判据同一口径。
  const box = rect ? [rect.canvasCss[0] - 2, rect.canvasCss[1] - 2, rect.canvasCss[2] + 3, rect.canvasCss[3] + 3] : null;
  // 多站固定参考区（**不声称「背景同类」**）：与 quad **同 y 带、等面积（300×91）、互不相交**的三个候选 ——
  // 沿 x 镜像（`mirror`）、画面最左、quad 右缘紧邻条带。修复轮 2 起它们的角色是**同相位基线对照**
  // （两帧都隐藏时该区域的背景残差必须 ≈0）；跨帧的 A/B 中位数只作「旧口径下背景自身能贡献多少」的对照打印。
  // 宽度取 300（≤ quad 宽 337）：三站都能同时满足「在界内 + 等面积 + 与 quad 不相交」，不靠 clamp。
  const STATION_W = 300;
  // 镜像站：在「左站右缘 + 1」到「quad 左缘 − 1」这段空档里居中（保证与左站、与 quad 都留 ≥1px）。
  const freeStart = STATION_W + 1;
  const freeEnd = box ? box[0] - 1 : 0;
  const mirrorX = Math.max(freeStart, Math.floor((freeStart + freeEnd - STATION_W + 1) / 2));
  const stationCands = box ? [
    { name: 'same-y-left', box: [0, box[1], STATION_W - 1, box[3]] },
    { name: 'mirror', box: [mirrorX, box[1], mirrorX + STATION_W - 1, box[3]] },
    // 右侧：与 quad 右缘**紧邻**（box[2]+1 起）—— 留 1px 间隔，保证与 quad 不相交。
    { name: 'same-y-right', box: [box[2] + 1, box[1], box[2] + STATION_W, box[3]] },
  ] : [];
  // 越界 / 与 quad 相交 / 三站面积不一致 / 比 quad 更宽 ⇒ 判 FAIL（旧实现被 `diffPng` 静默 clamp 成更小的
  // 区域，地板会被无声压低；「比 quad 更宽」不可能带来更保守的地板，只会掩盖裁剪）。
  const areaMismatch = [];
  if (box) {
    const quadArea = (box[2] - box[0] + 1) * (box[3] - box[1] + 1);
    const areas = new Set();
    for (const c of stationCands) {
      const [x0, y0, x1, y1] = c.box;
      const inFrame = x0 >= 0 && y0 >= 0 && x1 <= VW - 1 && y1 <= VH - 1 && x0 < x1 && y0 < y1;
      const area = inFrame ? (x1 - x0 + 1) * (y1 - y0 + 1) : 0;
      // 与该 quad 是否相交（留 1px 间隔即算不相交）：x/y 两轴同时重叠才算相交。
      const overlapX = Math.min(x1, box[2]) - Math.max(x0, box[0]) >= 0;
      const overlapY = Math.min(y1, box[3]) - Math.max(y0, box[1]) >= 0;
      const overlap = overlapX && overlapY;
      areas.add(area);
      if (!inFrame || area > quadArea || overlap) {
        areaMismatch.push(`${c.name}${JSON.stringify(c.box)} inFrame=${inFrame} area=${area}>quad(${quadArea})? overlap=${overlap}`);
      }
    }
    if (areas.size > 1) areaMismatch.push(`三站面积不一致: ${[...areas].join(',')}`);
  }
  // 跨帧口径（**仅作对照与 [3]/[8]/[13] 用**）：同一屏上「显示 vs 隐藏」相隔数百 ms ⇒ 水面/粒子相位
  // 不同，差分里混着背景自身的变化。这正是修复轮 1 的口径，行 [9] 就是被这条基线顶高的（见下 §同相位）。
  const dAB = diffPng(shots['iso-show'], shots['iso-hide'], VW, VH, box);
  const dAA = diffPng(shots['iso-show'], shots['iso-show2'], VW, VH, box);
  const dReRepaired = diffPng(shots['iso-show2'], shots.repaired, VW, VH, box);
  const dStations = stationCands.map((c) => ({ name: c.name, box: c.box, d: diffPng(shots['iso-show'], shots['iso-hide'], VW, VH, c.box) }));
  const floorStats = (() => {
    const v = dStations.map((s) => s.d.changedPixels).sort((a, b) => a - b);
    return { n: v.length, min: v[0], median: v.length % 2 ? v[(v.length - 1) / 2] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2), max: v[v.length - 1] };
  })();
  // 「活水多站地板」= 参考站在**跨帧**（水面在动）下的 A/B 差分中位数。修复轮 2 起它**不再进判据**
  // （判据改用同相位测量，背景结构性抵消），只作对照打印：它量出「旧口径下背景自身能贡献多少像素」。
  const liveFloorMedian = floorStats.median;
  const stationLine = dStations.map((s) => `${s.name}=${s.d.changedPixels}`).join(' / ');
  const dOut = diffPng(shots['iso-show'], shots['iso-hide'], VW, VH); // 全屏差异（判「不外溢」）

  // ── ③ 同相位采样（修复轮 2 的核心）───────────────────────────────────────────────
  // 旧口径的分子 = 「健康装配 A/B」−「缺失装配 A/B」：两臂是**两次独立渲染**（水面相位不同）⇒ 它既不是
  // 该层贡献、也不是纯背景差（实测 16463–16712 px，而该层自身是 30169 px@Δ≥2 / ≈12k px@Δ≥8）⇒ 阈值被
  // 顶在跨帧背景噪声（≈13k px）之上，部分衰减检不出。现在改成**同相位**：把 rAF 换进受控队列、把动画时钟
  // （`performance.now`，生产帧体用它差分算 dt，见 lib/client/threejs-player.js:665,672）与墙钟（`Date`，
  // 时钟文本由脚本 `new Date()` 生成，见 :1617）都钉死在同一时刻 ⇒ dt=0 且文本内容不动 ⇒ 两帧背景逐像素
  // 一致（两帧都隐藏的对照实测 0 px）。剩下两帧只差「该层渲染出多少」。分子按**全屏 Δ≥8** 统计（见下）。
  console.log('\n--- 同相位采样（受控 rAF + 冻结动画时钟/墙钟）---');
  const frozenAt = await evalJs('window.__freezeClock()');
  // 墙钟默认钉死（同相位的前提）。`--live-wallclock` 是**负向对照**：不冻墙钟 ⇒ 秒位随真实时间前进。
  const frozenDate = LIVE_WALLCLOCK
    ? JSON.parse(await evalJs('JSON.stringify(window.__unfreezeWallClock())'))
    : JSON.parse(await evalJs(`JSON.stringify(window.__freezeWallClock(${AT_MS === null ? '' : AT_MS}))`));
  const wallClockState = JSON.parse(await evalJs('JSON.stringify(window.__wallClockState())'));
  /** 把 three 的帧循环停进受控队列（找不到待排队时放行真实 rAF 重新武装；期间 dt=0，背景不前进）。 */
  const parkLoop = async () => {
    let st = null;
    for (let i = 0; i < 3; i++) {
      await evalJs('window.__setRafControlled(false)');
      await sleep(i === 0 ? 150 : 300);
      await evalJs('window.__setRafControlled(true)');
      await sleep(i === 0 ? 150 : 300);
      st = JSON.parse(await evalJs('JSON.stringify(window.__setRafControlled(true))'));
      if (st.queued > 0) return st;
    }
    return st;
  };
  /** 装配切换期间放行真实 rAF（切换内部可能等帧；dt=0 ⇒ 背景仍不前进），随后停回受控队列。 */
  const switchAssembly = async (brokenRuntime) => {
    await evalJs('window.__setRafControlled(false)');
    const sw = await evalJs(`window.__switchScriptRuntime(${brokenRuntime})`);
    await parkLoop();
    return sw;
  };
  const pumpStats = { frames: 0, errs: 0 };
  const pump = async (n) => {
    for (let i = 0; i < n; i++) {
      const r = JSON.parse(await evalJs('JSON.stringify(window.__pumpFrame())'));
      pumpStats.frames += r.ran;
      if (r.err) pumpStats.errs++;
    }
  };
  /** 同相位取帧：设定该层的「渲染量」（覆盖率 / 透明度 / 可见性）→ 推 2 帧 → 截图。 */
  const phaseShot = async (tag, { coverage = 1, opacity = 1, hidden = false } = {}) => {
    const cov = JSON.parse(await evalJs(`JSON.stringify(window.__setTextCoverage(${TEXT_OBJECT_ID}, ${coverage}))`) ?? 'null');
    const op = JSON.parse(await evalJs(`JSON.stringify(window.__setTextOpacity(${TEXT_OBJECT_ID}, ${opacity}))`) ?? 'null');
    const toggle = JSON.parse(await evalJs(`JSON.stringify(window.__hideTextLayer(${TEXT_OBJECT_ID}, ${hidden}))`) ?? 'null');
    await pump(2);
    const shot = await send2('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(shot.data, 'base64');
    shots[`sp-${tag}`] = buf;
    writeFileSync(join(OUT, `text-clock-sp-${tag}.png`), buf);
    return { buf, cov, op, toggle };
  };
  const inkOf = (d) => Math.round(d.changedPixels * d.meanDelta); // 亮度总量 = Σ 逐像素最大通道差
  const arms = {};
  const armed = await parkLoop();
  arms.frozenAt = frozenAt; arms.armed = armed; arms.frozenDate = frozenDate; arms.wallClockState = wallClockState;
  console.log(`  [同相位] 冻结动画时钟于 ${frozenAt} ms、墙钟于 ${frozenDate.iso}（frozen=${frozenDate.frozen}，Date 真身=${wallClockState.real}）；受控 rAF 队列 ${armed.queued} 帧待推`);
  // 主测必须在**健康装配**上：① 之前的流程刚把页面留在「缺失装配」（step broken2），先切回来；
  //   ② 材质/隔离对象的只读探针也要在这时候取（缺失装配下 `displayObject(778)` 是 null）。
  await switchAssembly(false);
  console.log('  [同相位] 文本层材质:', await evalJs(`JSON.stringify(window.__objectMaterialInfo(${TEXT_OBJECT_ID}))`));
  console.log('  [同相位] 隔离对象:', await evalJs('JSON.stringify(window.__isoInfo())'));
  // 主测：健康装配、全量文本层。四帧 = 显示 / 隐藏 / 显示 / 隐藏 ——
  //   · `spAB`   = 显示 vs 隐藏（**紧邻**的一对）⇒ [9] 的分子（该层自身的像素贡献，背景同相位）；
  //   · `spBase` = 隐藏 vs 隐藏（两帧都没有该层）⇒ **背景残差**：它才是分子里混进来的那一份，
  //                也是「同相位真的成立」的自证（[10]）；stations 用同一对算，覆盖 quad 之外。
  //   · `spAA`   = 显示 vs 显示 ⇒ 该层**自身内容**的变化：墙钟冻住时恒为 0（实测多次全 0），而墙钟一旦
  //                没冻住，秒位跳动会让它到千 px 量级 ⇒ (修复轮 3) 它进 [10] 的判定（`spAA ≤ SP_AA_MAX`）。
  const spOn = await phaseShot('healthy-on', {});
  const spOff = await phaseShot('healthy-off', { hidden: true });
  // 判据 [9] 的**分母**：同一冻结帧内该层自身字形点亮的屏幕像素（`__textGlyphScreenPixels` 的 `mask`）。
  // 它只读「该层纹理 + quad 投影」，与覆盖率/透明度注入无关 ⇒ 时钟内容（点亮段数）在分子分母里同时约掉。
  // 分子取**该掩码内**的强变化像素（掩码外是该层带动的屏幕空间光晕：实测约 5 px 宽的边圈，随内容漂移，
  // 不属于该层自己的字形）。同时取同帧纹理空间字形像素（`[4]` 口径）作对照读数。
  const glyph = JSON.parse(await evalJs(`JSON.stringify(window.__textGlyphScreenPixels(${TEXT_OBJECT_ID}))`) ?? 'null');
  const glyphCanvas = JSON.parse(await evalJs(`JSON.stringify(window.__textCanvasImage(${TEXT_OBJECT_ID}))`) ?? 'null');
  const glyphMask = new Set(glyph?.mask ?? []);
  // 日志打**实际冻结**的本地时刻（不直接回显 `--at` 传入串，避免「打印的」与「冻住的」不一致）。
  const clockContent = AT_MS !== null ? localHmsOf(AT_MS) : localHmsOf(frozenDate.ms);
  console.log(`  [同相位] 冻结内容（本地时钟文本）${clockContent}；该层自身字形足迹 ${glyphMask.size} px ${JSON.stringify({ ...glyph, mask: undefined })}、纹理空间亮像素 ${glyphCanvas?.brightPixels ?? '—'}`);
  // 负向对照：不冻墙钟时让**真实**时间前进 1.2 s，保证 on/on2 跨过秒位边界（99.9% 概率变成 ~100%）。
  if (LIVE_WALLCLOCK) await sleep(1200);
  const spOn2 = await phaseShot('healthy-on2', {});
  const spOff2 = await phaseShot('healthy-off2', { hidden: true });
  console.log('  [同相位] 注入回执（覆盖率/透明度/可见性）:', JSON.stringify({ on: spOn.cov, off: spOff.toggle, on2: spOn2.toggle, off2: spOff2.toggle }));
  const spAB = diffPng(spOn.buf, spOff.buf, VW, VH, box);        // 外扩盒内、弱阈值（对照）
  const spAA = diffPng(spOn.buf, spOn2.buf, VW, VH, box);        // 该层自身内容变化（判据 [10] 的一半）
  const spBase = diffPng(spOff.buf, spOff2.buf, VW, VH, box);    // 背景残差（盒内，弱阈值）
  const spBaseFull = diffPng(spOff.buf, spOff2.buf, VW, VH);     // 背景残差（全屏，弱阈值）
  const spStations = stationCands.map((c) => ({ name: c.name, box: c.box, d: diffPng(spOff.buf, spOff2.buf, VW, VH, c.box) }));
  const spFullWeak = diffPng(spOn.buf, spOff.buf, VW, VH);       // 全屏弱阈值（含水面 ≤4 的量化级响应）
  const spOutsideWeak = diffOutsidePng(spOn.buf, spOff.buf, VW, VH, box);          // 盒外弱阈值（量「外溢」多大）
  const spOutsideStrong = diffOutsidePng(spOn.buf, spOff.buf, VW, VH, box, STRONG_DELTA); // 盒外强阈值（应 0）
  // 判据 [9] 的分子：**强变化像素**（逐像素最大通道差 ≥ STRONG_DELTA），全屏统计 + 掩码内计数。
  // 为什么加这个下限：该层显示时水面会有量化级响应（盒外逐像素差实测见 `【对照】盒外` 行，
  // 本轮实测 maxΔ ∈ [4,7]），弱阈值会把它们算进「贡献」；Δ≥8 时这部分为 **0 px**（可推上界 7 = Δ−1）。
  const spStrong = diffPng(spOn.buf, spOff.buf, VW, VH, null, STRONG_DELTA, glyphMask);
  const spStrongBox = diffPng(spOn.buf, spOff.buf, VW, VH, box, STRONG_DELTA); // 盒内同口径：与全屏值相等 ⇒ 盒外无强变化成分
  const spStrongBase = diffPng(spOff.buf, spOff2.buf, VW, VH, null, STRONG_DELTA);
  // 部分衰减扫描（默认在 `--teeth` 下跑，也是「最小可检出衰减」的实测数据来源）：
  //   coverage = 沿该 quad 局部 +x 轴只渲染左 c 份（局部裁剪面，不改几何 ⇒ 判据矩形不变）；
  //   opacity  = 整层变淡（白字 → 灰字）。
  // 0.5 / 0.1 两档是牙的指定档位，**永远在列**（`--sweep` / `--dim` 只做追加，不能把它们挤掉）。
  const nums = (s) => s.split(',').map(Number).filter((v) => v >= 0 && v < 1);
  const SWEEP_COV = [...new Set([...nums(argOf('sweep', '') || '0.9,0.75,0.5,0.25,0.1'), 0.5, 0.1])].sort((a, b) => b - a);
  const SWEEP_OP = [...new Set([...nums(argOf('dim', '') || '0.5,0.1'), 0.5, 0.1])].sort((a, b) => b - a);
  const sweep = [];
  if (TEETH) {
    for (const c of SWEEP_COV) {
      const img = await phaseShot(`cov${Math.round(c * 100)}`, { coverage: c });
      const d = diffPng(img.buf, spOff.buf, VW, VH, null, STRONG_DELTA, glyphMask);
      sweep.push({ knob: 'coverage', value: c, changedPixels: d.changedPixels, inMask: d.changedInMask, inkInMask: d.inkInMask, ink: inkOf(d), maxDelta: d.maxDelta, diffs: d, applied: img.cov });
      console.log(`  [同相位] 覆盖率 ${c}: 强变化 ${d.changedPixels} px（字形足迹内 ${d.changedInMask}）/ ink ${inkOf(d)}（maxΔ ${d.maxDelta}）`);
    }
    for (const o of SWEEP_OP) {
      const img = await phaseShot(`op${Math.round(o * 100)}`, { opacity: o });
      const d = diffPng(img.buf, spOff.buf, VW, VH, null, STRONG_DELTA, glyphMask);
      sweep.push({ knob: 'opacity', value: o, changedPixels: d.changedPixels, inMask: d.changedInMask, inkInMask: d.inkInMask, ink: inkOf(d), maxDelta: d.maxDelta, diffs: d, applied: img.op });
      console.log(`  [同相位] 透明度 ${o}: 强变化 ${d.changedPixels} px（字形足迹内 ${d.changedInMask}）/ ink ${inkOf(d)}（maxΔ ${d.maxDelta}）`);
    }
  }
  // 缺失装配（= 修复前装配，文本层整层跳过）：同相位 A/B 须 ≈0 —— 该层不存在时两帧完全一样。
  await evalJs(`window.__setTextCoverage(${TEXT_OBJECT_ID}, 1)`);
  await evalJs(`window.__setTextOpacity(${TEXT_OBJECT_ID}, 1)`);
  await switchAssembly(true);
  const spbOn = await phaseShot('broken-on', {});
  const spbOff = await phaseShot('broken-off', { hidden: true });
  const spBroken = diffPng(spbOn.buf, spbOff.buf, VW, VH, null, STRONG_DELTA, glyphMask);
  const spBrokenStations = stationCands.map((c) => ({ name: c.name, box: c.box, d: diffPng(spbOn.buf, spbOff.buf, VW, VH, c.box) }));
  console.log(`  [同相位] 缺失装配强变化 ${spBroken.changedPixels} px / ink ${inkOf(spBroken)}（toggle ${JSON.stringify(spbOn.toggle)}）`);
  writeFileSync(join(OUT, 'diff.json'), JSON.stringify({
    lib: libId, dAB, dAA, dReRepaired, dStations, liveFloorMedian, box, stationCands, areaMismatch, info,
    samePhase: { arms, pumpStats, strongDelta: STRONG_DELTA, clockContent, at: AT_SPEC || null, glyph: glyph ? { ...glyph, mask: `[${glyph.mask.length} px]` } : null, glyphCanvas, spStrong, spStrongBox, spStrongBase, spAB, spAA, spBase, spBaseFull, spStations, spFullWeak, spOutsideWeak, spOutsideStrong, sweep, spBroken, spBrokenStations },
  }, null, 1));
  const imgShow = decodePng(shots['iso-show']);
  const imgHide = decodePng(shots['iso-hide']);
  // 白字实测：「隐藏文本层的那一帧是暗的、显示文本层的那一帧是亮的」像素 —— 这是与该文本层
  // **因果绑定**的口径（右下角本来就亮的粒子高光不算），比单纯数亮像素干净得多。
  const textPixels = (() => {
    let n = 0, bright = 0, sum = 0, mask = 0;
    for (let y = region[1]; y < region[3]; y++) {
      for (let x = region[0]; x < region[2]; x++) {
        const ia = (y * imgShow.width + x) * imgShow.channels;
        const ib = (y * imgHide.width + x) * imgHide.channels;
        const ls = (imgShow.data[ia] + imgShow.data[ia + 1] + imgShow.data[ia + 2]) / 3;
        const lh = (imgHide.data[ib] + imgHide.data[ib + 1] + imgHide.data[ib + 2]) / 3;
        if (lh > 140) continue;            // 隐藏时为亮：背景粒子高光，不是字
        if (ls - lh < 40) continue;        // 显示时明显更亮：字
        mask++;
        if (ls > 200) bright++;
        sum += ls;
      }
    }
    n = region[2] - region[0];
    return { textMaskPixels: mask, brightTextPixels: bright, meanLuma: mask ? +(sum / mask).toFixed(1) : 0, regionWidth: n };
  })();
  const brightShow = brightStats(imgShow, region, 200);
  const brightHide = brightStats(imgHide, region, 200);
  const brightWhole = brightStats(imgShow, [0, 0, VW, VH], 200);

  console.log('\n===== 判定 =====');
  // 【判据 9】同相位强变化分子（2026-10-13 修复轮 2 重做）：把 rAF 接管、动画时钟（`performance.now`）
  //   与墙钟（`Date`）都钉死在同一时刻 ⇒ 「该层显示帧 vs 隐藏帧」的背景逐像素一致（两帧都隐藏的
  //   对照实测 **0 px**），差分只剩该层自身。分子 = **全屏**逐像素最大通道差 ≥ STRONG_DELTA(8) 的像素数
  //   （弱阈值 Δ≥2 会把水面被该层带动的量化级响应算进来：同一次运行全屏 39230 px vs 盒内 30221 px，
  //   而 Δ≥8 时盒内值 = 全屏值 = 12813 px ⇒ 盒外成分为 0；见 §5.45 标定的日志文件名），
  //   并要求**亮度总量** `ink = Σ 逐像素最大通道差` 同步达标：像素数在「整层变淡」时会掉，
  //   但 ink 是直接的亮度口径（像素与 ink 两个下限都按实测标定，见脚本头/§5.45 的日志文件名）。
  // 【判据 10】同相位基线 = **两帧都隐藏**时的背景残差（全屏 + 外扩盒 + 三站）必须 ≈0：这是「背景真的
  //   抵消了」的自证，也是混进分子的背景上界（旧口径正是在这里失效：同一区域跨帧就有 1.3–1.4 万 px）。
  //   **并且**（修复轮 3）断言墙钟冻结生效：`spAA`（两次「显示」帧的 A/A 残差）必须 ≤ `SP_AA_MAX` ——
  //   否则内容变化会混进分子而全线假绿（此前这一半只打印）。
  const noise = Math.max(dAA.changedPixels, 1);
  const regionArea = box ? (box[2] - box[0] + 1) * (box[3] - box[1] + 1) : 0;
  // 【判据 9】**相对（尺度无关）口径**（2026-10-13 修复轮 4）：两个半边都用**同一冻结帧内该层自身
  //   字形足迹**（`__textGlyphScreenPixels` 的 mask，只读「该层自己的纹理 + quad 投影」）作分母，
  //   与覆盖率/透明度注入无关 ⇒ 时钟内容（点亮段数）在分子分母里同时约掉：
  //   ① 点亮比例 = |强变化像素 ∩ 足迹| ÷ |足迹| —— 健康态 ≈1，文本衰减 k% ⇒ ≈ (1−k)（管「画出多少字形」）；
  //   ② 平均亮度 = (足迹内强变化的亮度总量) ÷ |足迹| —— 管「字形有多亮」（透明度衰减只压亮度、几乎不减像素）。
  //   **绝对阈值已删**（旧 `7800 px` / `480000 ink` 正是「内容窄就假红」的来源：分子 ≈ 点亮段数
  //   ⇒ 窄内容健康态只有 8337 px，距 7800 仅 1.07×）。绝对值仍逐次打印作对照，但**不进判定**。
  //   足迹外那部分强变化是该层带动的屏幕空间光晕（实测 quad 内约 5 px 宽的边圈），不是它自己的字形。
  const SP_MIN_RATIO = 0.65;      // [9]① 足迹内点亮比例下限：健康态三内容档实测 0.959–0.988（最窄 `11:11:11` 最低）、
                                  //       覆盖率 0.5 档实测 0.466–0.483（最宽 `08:08:08` 最高）⇒ 0.65 落在两者之间，
                                  //       健康态余量 1.48×、衰减档余量 1.35×（取 0.55 会让衰减档只剩 1.18×，故不取）。
  const SP_MIN_INK_RATIO = 88;    // [9]② 足迹内平均亮度下限（Δ/px）：健康态实测 124.3–129.7、透明度 0.5 档实测 60.5–62.2
                                  //       ⇒ 88 两侧余量各 ≈1.41×（像素口径抓不住亮度衰减：透明度 0.1 档点亮比例仍有 0.76）。
  const SP_BASELINE_MAX = 600;   // [10] 背景残差绝对上限
  const SP_AA_MAX = 60;          // [10] 「墙钟冻结生效」上限：冻结态 spAA 实测恒为 0 px（修复轮 3 连跑 5 次全 0），
                                 //      60 px ≈ 外扩盒面积 27300 的 0.2%；而墙钟没冻住时 spAA 实测 1431 / 2435 px
                                 //      （`--live-wallclock` 两次负向对照，各只跳一个秒位数字）⇒ 余量 23.9×。
  const RESTORE_MAX_RATIO = 2;   // [13] 恢复态/quad 抖动（沿用修复轮 1 的封顶口径）
  const spPixels = spStrong.changedPixels;
  const spInk = inkOf(spStrong);
  // [9] 的分母 = 同帧字形足迹像素数（`glyphMask.size`）；分子 = 足迹内 Δ≥8 的像素数与它们的亮度总量。
  const glyphPx = glyphMask.size;
  const ratioOf = (inMask) => (inMask ?? 0) / Math.max(1, glyphPx);
  const inkRatioOf = (inkInMask) => (inkInMask ?? 0) / Math.max(1, glyphPx);
  const spRatio = ratioOf(spStrong.changedInMask);
  const spInkRatio = inkRatioOf(spStrong.inkInMask);
  const spBasePixels = Math.max(spStrongBase.changedPixels, spBaseFull.changedPixels, spBase.changedPixels, ...spStations.map((s) => s.d.changedPixels));
  const spBaselineOk = spStrongBase.changedPixels <= SP_BASELINE_MAX && spBaseFull.changedPixels <= SP_BASELINE_MAX
    && spBase.changedPixels <= SP_BASELINE_MAX && spStations.every((s) => s.d.changedPixels <= SP_BASELINE_MAX);
  // 墙钟冻结自证：两次「显示」帧只差「那一段时间里该层的内容变了没有」（同相位下背景不前进）。
  const spAaOk = spAA.changedPixels <= SP_AA_MAX;
  // 判定式只吃**两个比值**（尺度无关）；绝对量（全屏 px / ink）仍打印作对照，但不进判定（它们随内容换挡）。
  const judgeSp = (inMask, inkInMask) => ratioOf(inMask) > SP_MIN_RATIO && inkRatioOf(inkInMask) > SP_MIN_INK_RATIO;
  const spPass = judgeSp(spStrong.changedInMask, spStrong.inkInMask);
  // [13] 的区域面积封顶：`2·dAA+50` 在 dAA ≥ (面积−50)/2 ≈ 15309 px（quad 面积的一半）时**必然成立**
  // = 恒真（S2 期实测 dAA 已达 17184 px）。封顶到区域面积的 0.9 ⇒ 阈值恒 < 面积，不再可能恒真。
  // 合法动画（水面 + 秒跳）在 `dReRepaired`（show2 vs repaired）与 `dAA`（show vs show2）两边同时出现，
  // 故比值本身对该动画免疫；封顶只砍掉「阈值大于面积」这一退化分支。
  const restoreCap = Math.floor(regionArea * 0.9);
  const restoreLimit = Math.min(noise * RESTORE_MAX_RATIO + 50, restoreCap);
  const checks = [
    [`修复前装配不产生文本层 #${TEXT_OBJECT_ID}`, info.broken.rect === null && brokenVisible === null],
    [`生产装配产生文本层 #${TEXT_OBJECT_ID}（画布 ${rect?.textureImage?.join('×') ?? '—'}）`,
      !!rect && rect.textureImage !== null],
    ['文本 quad 落在画面右下角（中心 x>0.6 且 y>0.6 归一化）',
      !!rect && (rect.norm[0] + rect.norm[2]) / 2 > 0.6 && (rect.norm[1] + rect.norm[3]) / 2 > 0.6],
    // 精确几何（评审 Important 1）：只判「右下角区域」抓不住 anchor 语义回归；obj778 带 anchor=center +
    // verticalalign=top，rect 由固定视口与文本布局唯一决定 ⇒ 对具体对象 rect 断言 ±2px。
    [`文本 quad 矩形精确匹配 anchor 语义基线（canvasCss ${JSON.stringify(rect?.canvasCss)} ≈ ${JSON.stringify(TEXT_RECT_BASELINE)} ±2px）`,
      rectNear(rect, TEXT_RECT_BASELINE, 2)],
    [`文本画布上画出了白色字形（亮像素 ${info.normal.textCanvas?.brightPixels ?? 0} 个，区域 ${JSON.stringify(info.normal.textCanvas?.brightBBox)}）`,
      (info.normal.textCanvas?.brightPixels ?? 0) > 500],
    // 字体（2026-10-10）：`fonts/CursedTimerUlil-Aznm.ttf` 只存在于 <WE>/assets/fonts/（scene.pkg 里
    // 零字体文件）⇒ host 的「引擎 assets 回退」必须命中，客户端才能拿到真身 LED 数码字体。
    // 判据用**像素/几何事实**：用上真身字体后文本画布宽 884（回退 sans-serif 只有 702）。
    [`字体从引擎目录命中且真的生效（请求命中 ${JSON.stringify(assetHits)}；画布宽 ${info.normal.textCanvas?.size?.[0] ?? '—'} ≥ 800 ⇒ 非回退字体）`,
      assetHits.some((h) => h.name.endsWith('CursedTimerUlil-Aznm.ttf') && h.source === 'engine')
      && (info.normal.textCanvas?.size?.[0] ?? 0) >= 800],
    [`字形 alpha 未被压淡（字形像素 alpha 均值 ${info.normal.textCanvas?.strokeAlphaMean ?? '—'} / 最小 ${info.normal.textCanvas?.strokeAlphaMin ?? '—'}，作者值 0.84×255≈214）`,
      (info.normal.textCanvas?.strokeAlphaMean ?? 0) > 150],
    [`屏幕上能读到白字（右下角「隐藏时暗、显示时亮」的像素 ${textPixels.textMaskPixels} 个，其中 luma>200 的 ${textPixels.brightTextPixels} 个，均值 ${textPixels.meanLuma}）`,
      textPixels.textMaskPixels > 800 && textPixels.brightTextPixels > 500],
    [`隐藏文本层后右下角变暗（区域均值 ${brightShow.meanLuma.toFixed(1)} → ${brightHide.meanLuma.toFixed(1)}）`,
      brightHide.meanLuma < brightShow.meanLuma - 2],
    [`同相位相对分子高于标定下限（冻结内容 ${clockContent}；自身字形足迹 ${glyphPx} px 内 Δ≥${STRONG_DELTA} 像素 ${spStrong.changedInMask} px = **${spRatio.toFixed(3)}** > ${SP_MIN_RATIO}，平均亮度 ${spStrong.inkInMask}÷${glyphPx} = **${spInkRatio.toFixed(1)}** > ${SP_MIN_INK_RATIO}；对照：全屏强变化 ${spPixels} px（含足迹外光晕 ${spPixels - spStrong.changedInMask} px）、全屏亮度总量 ${spInk}、纹理空间字形像素 ${glyphCanvas?.brightPixels ?? '—'}；旧跨帧口径同一盒内是 ${dAB.changedPixels} px，混着水面自身的变化）`,
      spPass],
    [`同相位基线 ≈0 且内容（墙钟）冻结生效（两帧都隐藏 ⇒ 纯背景残差：全屏 Δ≥${STRONG_DELTA} ${spStrongBase.changedPixels} px、全屏 Δ≥2 ${spBaseFull.changedPixels} px、外扩盒 ${spBase.changedPixels} px、三站 ${spStations.map((s) => `${s.name}=${s.d.changedPixels}`).join(' / ')}；max ${spBasePixels} ≤ ${SP_BASELINE_MAX} px ⇒ ${spBaselineOk ? 'PASS' : 'FAIL'}｜两次显示帧 A/A 残差 ${spAA.changedPixels} px ≤ ${SP_AA_MAX} px ⇒ ${spAaOk ? 'PASS' : 'FAIL'}）`,
      spBaselineOk && spAaOk],
    [`受控推帧生效（累计渲染 ${pumpStats.frames} 帧、帧内异常 ${pumpStats.errs}；冻结的是时钟而不是把循环停死）`,
      pumpStats.frames >= 8 && pumpStats.errs === 0],
    [`隐藏/显示文本层的强阈值差异落在它自己的 quad 内（全屏 Δ≥${STRONG_DELTA} 差异包围盒 ${JSON.stringify(spStrong.bbox)} ⊆ quad ${JSON.stringify(rect?.canvasCss)} ±6；弱阈值 Δ≥2 下盒外仍会外溢 ${spOutsideWeak.changedPixels} px / 最远 ${spOutsideWeak.maxOverflowPx} px，故本判据不用弱阈值）`,
      !!spStrong.bbox && !!rect && spStrong.bbox[0] >= rect.canvasCss[0] - 6 && spStrong.bbox[1] >= rect.canvasCss[1] - 6
        && spStrong.bbox[2] <= rect.canvasCss[2] + 6 && spStrong.bbox[3] <= rect.canvasCss[3] + 6],
    [`恢复显示后与隐藏前的差异回到噪声地板（${dReRepaired.changedPixels} px ≤ min(quad 抖动 ${noise} px × ${RESTORE_MAX_RATIO} + 50, 区域面积 90% = ${restoreCap}) = ${restoreLimit} px）`,
      dReRepaired.changedPixels <= restoreLimit],
    // 参考区几何自证：越界 / 与 quad 相交 / 三站面积不一致 ⇒ FAIL（否则 `diffPng` 会静默 clamp，地板被无声压低）。
    [`参考区几何有效（3 个候选箱均在界内、与 quad 不相交、三站等面积 ${dStations[0] ? (dStations[0].box[2] - dStations[0].box[0] + 1) * (dStations[0].box[3] - dStations[0].box[1] + 1) : 0} px ≤ quad 面积 ${regionArea} px）`,
      areaMismatch.length === 0 && dStations.length === 3],
  ];
  // 牙（默认带；`--no-teeth` 关掉，只跳过扫描与这几条）：把「该层出问题」的形态注入进去，断言
  // [9] 的表达式**判假**（= 真出问题时判据会红）。
  //   · 整层缺失 = **结构性 0**：该层不存在 ⇒ 显示/隐藏两帧逐像素相同（不是「差得远」）；
  //   · 部分衰减（覆盖率）/ 亮度衰减（透明度）= 实测值，阈值就架在它们与健康态之间。
  let teethSummary = null;
  if (TEETH) {
    const rowOf = (knob, value) => sweep.find((s) => s.knob === knob && s.value === value) ?? null;
    const pct = (x) => (x === null ? '—' : `${(x * 100).toFixed(0)}%`);
    const redCov = sweep.filter((s) => s.knob === 'coverage' && !judgeSp(s.inMask, s.inkInMask));
    const redOp = sweep.filter((s) => s.knob === 'opacity' && !judgeSp(s.inMask, s.inkInMask));
    // 「最小可检出衰减」= 扫描点里**仍判红**的最轻那一档。两个口径都给出：
    //   · `nominal` = 1 − 旋钮值（覆盖率/透明度，即「该层只渲染了这一份」）；判据自证用它（与档位同口径）；
    //   · `measured` = 1 − 该档实测保留率（足迹内像素 / 足迹内亮度），是「实际贡献掉了多少」的独立读数。
    const nominal = (rows) => (rows.length ? 1 - Math.max(...rows.map((s) => s.value)) : null);
    // 实测口径取**最轻的那一档红**（保留率最大的红档）⇒ 两者都表示「刚能被检出」的衰减量。
    const measuredPx = (rows) => (rows.length ? 1 - Math.max(...rows.map((s) => s.inMask)) / Math.max(1, spStrong.changedInMask) : null);
    const measuredInk = (rows) => (rows.length ? 1 - Math.max(...rows.map((s) => s.inkInMask)) / Math.max(1, spStrong.inkInMask) : null);
    const minAttenCov = nominal(redCov);
    const minAttenOp = nominal(redOp);
    const atten = { covNominal: minAttenCov, covMeasuredPx: measuredPx(redCov), covMeasuredInk: measuredInk(redCov), opNominal: minAttenOp, opMeasuredPx: measuredPx(redOp), opMeasuredInk: measuredInk(redOp) };
    const c50 = rowOf('coverage', 0.5);
    const c10 = rowOf('coverage', 0.1);
    const o50 = rowOf('opacity', 0.5);
    const o10 = rowOf('opacity', 0.1);
    const rowTxt = (r) => (r ? `足迹内 ${r.inMask} px / 亮度 ${r.inkInMask} ⇒ 比值 ${ratioOf(r.inMask).toFixed(3)} / 亮度比 ${inkRatioOf(r.inkInMask).toFixed(1)}（全屏 ${r.changedPixels} px / ink ${r.ink}）` : '—');
    const brokenTxt = `足迹内 ${spBroken.changedInMask} px / 亮度 ${spBroken.inkInMask} ⇒ 比值 ${ratioOf(spBroken.changedInMask).toFixed(3)} / 亮度比 ${inkRatioOf(spBroken.inkInMask).toFixed(1)}`;
    teethSummary = { broken: { px: spBroken.changedPixels, inMask: spBroken.changedInMask, inkInMask: spBroken.inkInMask, ink: inkOf(spBroken), ratio: +ratioOf(spBroken.changedInMask).toFixed(3) }, glyphPx, c50, c10, o50, o10, atten, sweep };
    checks.push(
      [`文本层缺失（整层跳过）时 [9] 判假（${brokenTxt} ≤ ${SP_MIN_RATIO} / ${SP_MIN_INK_RATIO}，分母仍是该层的 ${glyphPx} px）`,
        !judgeSp(spBroken.changedInMask, spBroken.inkInMask)],
      [`部分衰减 50%（覆盖率 0.5：该层只渲染左半）时 [9] 判假（${rowTxt(c50)}）`,
        !!c50 && !judgeSp(c50.inMask, c50.inkInMask)],
      [`部分衰减 90%（覆盖率 0.1）时 [9] 判假（${rowTxt(c10)}）`,
        !!c10 && !judgeSp(c10.inMask, c10.inkInMask)],
      [`亮度衰减 50%（透明度 0.5：整层变淡一半）时 [9] 判假（${rowTxt(o50)}）`,
        !!o50 && !judgeSp(o50.inMask, o50.inkInMask)],
      [`亮度衰减 90%（透明度 0.1）时 [9] 判假（${rowTxt(o10)}）`,
        !!o10 && !judgeSp(o10.inMask, o10.inkInMask)],
      [`[9] 能检出的最小文本层衰减 ≤50%（覆盖率口径 ${pct(minAttenCov)}（实测贡献损失 ${pct(atten.covMeasuredPx)}/px、${pct(atten.covMeasuredInk)}/ink）、亮度口径 ${pct(minAttenOp)}（实测 ${pct(atten.opMeasuredPx)}/px、${pct(atten.opMeasuredInk)}/ink）；扫描点 ${sweep.length} 个）`,
        minAttenCov !== null && minAttenCov <= 0.5 && minAttenOp !== null && minAttenOp <= 0.5],
    );
  }
  let ok = true;
  for (const [name, pass] of checks) { console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) ok = false; }
  console.log('\n同相位强变化分子（全屏 Δ≥' + STRONG_DELTA + '，显示 vs 隐藏）:', JSON.stringify(spStrong));
  console.log(`【对照】同相位弱阈值口径（全屏 Δ≥2，含水面被该层带动的 ±2..4）:`, JSON.stringify(spFullWeak));
  console.log('【对照】同相位外扩盒内弱阈值差分（该层在该区域的覆盖度）:', JSON.stringify(spAB));
  console.log(`【对照】强阈值口径（Δ≥${STRONG_DELTA}）盒内 ${spStrongBox.changedPixels} px vs 全屏 ${spStrong.changedPixels} px（相等 ⇒ 盒外无强变化成分）:`, JSON.stringify(spStrongBox));
  console.log(`【对照】盒外（quad 之外）弱阈值 Δ≥2 ${spOutsideWeak.changedPixels} px / maxΔ ${spOutsideWeak.maxDelta} / 最远外溢 ${spOutsideWeak.maxOverflowPx} px；强阈值 Δ≥${STRONG_DELTA} ${spOutsideStrong.changedPixels} px / maxΔ ${spOutsideStrong.maxDelta}:`, JSON.stringify({ weak: spOutsideWeak, strong: spOutsideStrong }));
  console.log(`【对照】同相位 A/A（两次显示；判据 [10] 的「墙钟冻结生效」半边，应 ≤ ${SP_AA_MAX} px）:`, JSON.stringify(spAA));
  console.log(`同相位基线（两帧都隐藏 ⇒ 纯背景残差；判据 [10] 用它）:`,
    JSON.stringify({ strong: spStrongBase, box: spBase, stations: spStations.map((s) => ({ name: s.name, box: s.box, changedPixels: s.d.changedPixels })), full: spBaseFull, max: spBasePixels, aa: spAA.changedPixels, aaMax: SP_AA_MAX }));
  console.log(`同相位分子（相对口径）: 足迹内强变化 ${spStrong.changedInMask} px ÷ 同帧字形足迹 ${glyphPx} px = **${spRatio.toFixed(3)}**（阈值 ${SP_MIN_RATIO} ⇒ 余量 ${(spRatio / SP_MIN_RATIO).toFixed(2)}×）；足迹内亮度 ${spStrong.inkInMask} ÷ ${glyphPx} = **${spInkRatio.toFixed(1)}**（阈值 ${SP_MIN_INK_RATIO} ⇒ 余量 ${(spInkRatio / SP_MIN_INK_RATIO).toFixed(2)}×）；对照绝对量：全屏强变化 ${spPixels} px（足迹外光晕 ${spPixels - spStrong.changedInMask} px）、全屏亮度总量 ${spInk}（**不进判定**）`);
  console.log(`同帧字形分母（冻结内容 ${clockContent}）:`, JSON.stringify({
    maskPx: glyphPx, maskBBox: glyph?.maskBBox ?? null, texels: glyph?.texels ?? null, texelsBright: glyph?.texelsBright ?? null,
    support: glyph?.support ?? null, cov15: glyph?.cov15 ?? null, cov40: glyph?.cov40 ?? null, cov100: glyph?.cov100 ?? null,
    quadScreen: glyph?.quadScreen ?? null, footprintTexelRadius: glyph?.footprintTexelRadius ?? null,
    textureBrightPixels: glyphCanvas?.brightPixels ?? null,
    ratioTextureSpace: glyphCanvas?.brightPixels ? +(spPixels / glyphCanvas.brightPixels).toFixed(3) : null,
  }));
  console.log(`受控推帧: 累计 ${pumpStats.frames} 帧、异常 ${pumpStats.errs}（受控队列 ${armed.queued} 帧/批）`);
  console.log('【对照】跨帧口径（旧）：文本层信号 A/B:', JSON.stringify(dAB));
  console.log('【对照】跨帧口径（旧）：噪声 A/A（显示 vs 再显示，quad 内）:', JSON.stringify(dAA));
  console.log(`【对照】跨帧口径（旧）：活水多站地板（同 y 带、等面积、与 quad 不相交；box ${JSON.stringify(box)}）:`,
    JSON.stringify({ stations: dStations.map((s) => ({ name: s.name, box: s.box, changedPixels: s.d.changedPixels, changedRatio: +s.d.changedRatio.toFixed(4) })), stats: floorStats, statistic: 'median', floorUsed: liveFloorMedian, line: stationLine }));
  if (teethSummary) {
    console.log('牙（整层缺失 + 衰减扫描）:', JSON.stringify(teethSummary));
    console.log('衰减扫描表（同相位、与同一张隐藏帧比；ratio = 足迹内强变化 ÷ 足迹、inkRatio = 足迹内亮度 ÷ 足迹，red 按两者判）:',
      JSON.stringify(sweep.map((s) => ({ [s.knob]: s.value, inMask: s.inMask, ratio: +ratioOf(s.inMask).toFixed(3), inkInMask: s.inkInMask, inkRatio: +inkRatioOf(s.inkInMask).toFixed(1), px: s.changedPixels, ink: s.ink, maxDelta: s.maxDelta, red: !judgeSp(s.inMask, s.inkInMask) }))));
  }
  console.log('白字像素（右下角、隐藏时暗显示时亮）:', JSON.stringify(textPixels));
  console.log('引擎目录命中的场景素材:', JSON.stringify(assetHits));
  console.log('右下角亮像素（显示 / 隐藏 / 全屏）:', JSON.stringify({ show: brightShow.brightPixels, hide: brightHide.brightPixels, whole: brightWhole.brightPixels }));
  console.log(`截图：${OUT}`);
  if (!ok) process.exitCode = 1;
} catch (e) {
  console.error('ERROR:', (e && e.stack) || e);
  process.exitCode = 1; // 脚本异常也必须非零，否则 CI 会把崩溃当通过
} finally {
  try { ws?.close(); } catch { /* 已关 */ }
  edge?.kill();
  server.close();
}

