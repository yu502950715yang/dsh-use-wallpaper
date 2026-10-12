// 隔离对象 RT 的 e2e 验收网：**绝对性质**（锐度上限口径 / 外科性 / FPS），在**生产装配**下可重复跑。
//
// 目的是把「源纹理收口 4096、只升不降、按显存预算等比收窄 + 满屏对象关 MSAA + RT 放大开 mipmap」
// 这组性质变成一条命令（`npm run e2e:isolated-rt`）。判据**全部可从素材独立算出**，不提交/不比对
// 参考图，也不用 base arm：
//   [1] 每个隔离对象的 RT 长边 === max(屏占位长边, min(源纹理长边, 4096))（预算收窄时按收窄后的期望），
//       且 RT 像素总数 ≥ 屏占位像素总数（**只升不降**护栏）；屏占位 = |size × scale| × 屏幕密度，
//       密度 = floor(视口宽 × dpr) / cover 视锥宽（与生产同一把尺子，本脚本独立复述）。
//   [2] 满屏背景对象（kind=background 且 |world| ≥ 0.98 × 场景尺寸）samples === 0；
//       其余对象（贴片/粒子）samples === 4 —— 外科性：一个都不能被关掉。
//   [3] RT 长边 > 屏占位长边 ⇒ mip === true，否则 false（放大后的合成是缩小采样，必须开 mipmap）。
//   [4] 每张壁纸 `__fpsProbe(5000)` 的 FPS ≥ 30。**局限（如实）**：本机 60Hz vsync ⇒ 该数字只能当
//       **地板**用，测不出 60 以上的余量，也不覆盖低端 GPU / 4K 屏。
//   [5] 打印机器无关的工作量代理 Σ 隔离对象 RT 像素（写进 metrics.json）。
//   [6] 无「失败类」`[wallpaper-engine]` / `[three]` 告警（效果链编译失败、RT 超限…）；
//       其余告警逐条打印供人工核对（R28 禁 base arm ⇒ 「新增」无法严格做差，口径与
//       verify-text-clock-layer 的判定段一致：只判失败类）。
//   [7] **不声称「显存不会爆」**：384 MB 预算只是「尽力收窄升级幅度」的启发式，
//       不是硬保证（见下方输出与 metrics.json 的 budgetNote）。
//
// 被测对象 = **当前 `src/` 用仓库自己的 tsc 编译出的产物**（同 `npm run build` 的配置，输出到
// gitignored 的 `e2e/.out/isolated-rt/lib`），harness 的 `lib/client/*` import 被 esbuild 重定向到它。
// 理由：`lib/` 是 git 跟踪的产物、**落后于 src**（实测 `lib/client/object-range.js` 里没有
// `isolatedRtSize`）⇒ 不重定向就会拿旧实现验收，判据失去意义。重定向后「撤掉实现（src 回退到
// 本特性之前）脚本必红」这条反向验证也才有意义（见 task-9-report.md）。
//
// ⚠️ 串行假设：harness 端口固定（httpPort(9813)）+ Edge user-data-dir 固定 ⇒ **不得并行跑多份**，
//    否则 CDP 会连到别的实例的页面（实测过「读到没有 __ready 的空页面」）。脚本内也全程单实例串行。
// ⚠️ 依赖本机素材（workshop 5 张壁纸 + WE 安装目录）⇒ 不进 CI。必须带 `--gpu`（缺省即 GPU；
//    `--swiftshader` 显式降级，此时 FPS 判据降级为 SKIP —— 软件光栅化的数字无意义）。
// 用法：node e2e/verify/verify-isolated-rt-sharpness.mjs [--id=<壁纸id>] [--gpu] [--swiftshader]
//        [--workshop=<dir>] [--assets=<dir>] [--port=9813] [--cdp-port=9228]
// 退出码：0 = 全部判据通过；1 = 有判据失败或脚本异常。
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname, extname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { OUT_DIR, WE_WORKSHOP, WE_ASSETS, httpPort, cdpPort, resolveEdgePath, TIMEOUT_MS, argOf, flagOf, requireFile } from '../config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const OUT = join(OUT_DIR, 'isolated-rt');
const SHOTS = join(OUT, 'shots');
mkdirSync(SHOTS, { recursive: true });
const PORT = httpPort(9813);
const CDP_PORT = cdpPort(9228);
// 缺省 GPU（`--gpu` 与省略等价）：headless Edge 落到 SwiftShader 时 FPS 无意义。--swiftshader 显式降级。
const USE_GPU = !flagOf('swiftshader');
const WS = argOf('workshop', WE_WORKSHOP);
const WE = argOf('assets', WE_ASSETS);
// 固定视口/dpr（判据里的屏幕密度必须与本脚本**自己声明的**视口一致；页面会被钉到同一组数字上）
const VW = 1600, VH = 900, DPR = 1;

// R29：spec 证据表里的 5 张各一次。minGain 只用于报告（锐度增益是**手工**对照，不进本脚本判据）。
const CASES = [
  { id: '1922570576', name: '魔兽之门', minGain: 1.45 },
  { id: '3743126786', name: 'GTR', minGain: 1.10 },
  { id: '3765967112', name: 'Crimson', minGain: 1.10 },
  { id: '2911105183', name: 'Subway', minGain: 1.10 },
  { id: '1429403119', name: 'Orange', minGain: 1.10 },
];
const ONLY = argOf('id', null);
const RUN = ONLY ? CASES.filter((c) => c.id === ONLY) : CASES;
if (ONLY && RUN.length === 0) { console.error(`--id=${ONLY} 不在 R29 的清单里（${CASES.map((c) => c.id).join(', ')}）`); process.exit(1); }

// ── 判据常量（独立复述 src 的口径；不 import lib，保证「期望值」与实现分离）──────────────────
const OBJECT_RT_MAX = 4096;
const BUDGET_BYTES = 384_000_000;
const BYTES_PER_PX = 28;

// ── 素材侧 oracle（纯 node：scene.pkg + .tex 头 → 期望 RT）────────────────────────────────
const IDS = (n) => Math.max(1, Math.floor(n));
const readI32 = (b, p) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24);
const ascii = (b, p, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[p + i]); return s; };
const nums = (s) => (typeof s === 'string' ? s.trim().split(/\s+/).map(Number) : []);

// `.tex` 头（TEXV0005 + TEXI0001）：ImageWidth/Height = mip0 的 image 尺寸（不是 textureWidth/Height
// 的 NPOT padding 尺寸）——与 tex-loader.parseTex 同偏移，但本脚本只读头，不解 mip/LZ4。
function texHeader(buf) {
  if (ascii(buf, 0, 9) !== 'TEXV0005\0' || ascii(buf, 9, 9) !== 'TEXI0001\0') return null;
  const flags = readI32(buf, 22);
  return {
    imageW: readI32(buf, 34), imageH: readI32(buf, 38),
    video: (flags & 32) !== 0, sprite: (flags & 4) !== 0,
  };
}

// mip0 载荷（视频纹理里它是**完整 mp4 文件**）：按 TEXB 容器头走到第一条 mip 记录的数据段。
function mip0Payload(buf) {
  const container = ascii(buf, 46, 9);
  if (!/^TEXB000[1-4]\0$/.test(container)) return null;
  const v2 = container === 'TEXB0002\0';
  const v3 = container === 'TEXB0003\0' || container === 'TEXB0004\0';
  let pos = 55; // 46 + 9 (container) 之后是 imageCount
  if (readI32(buf, pos) <= 0) return null;
  pos += 4;
  if (v3) { pos += 4; if (container === 'TEXB0004\0') pos += 4; }
  const mipCount = readI32(buf, pos); pos += 4;
  const field = v2 || v3 ? 20 : 12;
  const bytesLen = readI32(buf, pos + (v2 || v3 ? 16 : 8));
  if (mipCount <= 0 || bytesLen <= 0 || pos + field + bytesLen > buf.length) return null;
  return buf.subarray(pos + field, pos + field + bytesLen);
}

// mp4 的显示尺寸：moov/trak/tkhd 的 width/height（16.16 定点）。取不到 → null（期望值按「只升不降」放宽）。
const u32be = (b, o) => b[o] * 0x1000000 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
function mp4Dims(mp4) {
  if (!mp4 || mp4.length < 8 || ascii(mp4, 4, 4) !== 'ftyp') return null;
  const walk = (start, end) => {
    let p = start;
    while (p + 8 <= end) {
      const size = u32be(mp4, p);
      const type = ascii(mp4, p + 4, 4);
      if (size < 8 || p + size > end) return null;
      if (type === 'tkhd') {
        const off = p + (mp4[p + 8] === 1 ? 96 : 84);
        if (off + 8 > mp4.length) return null;
        return { width: u32be(mp4, off) / 65536, height: u32be(mp4, off + 4) / 65536 };
      }
      if (type === 'moov' || type === 'trak' || type === 'mdia') {
        const r = walk(p + 8, p + size);
        if (r) return r;
      }
      p += size;
    }
    return null;
  };
  return walk(0, mp4.length);
}

// 材质→纹理路径（与 scene-assets.resolveTexPath 同语义）：不含 '/' → 材质同目录同名；含 '/' → materials/ 下。
const resolveTexPath = (matRef, texName) => (texName.includes('/')
  ? 'materials/' + texName + '.tex'
  : matRef.slice(0, matRef.lastIndexOf('/') + 1) + texName + '.tex');

// 对象 → 源纹理像素尺寸。任一步缺失 → null（实现回退屏占位，与 spec §3.4 一致）。
function sourcePixelsOf(reader, obj) {
  const load = (name) => reader.readEntry(name) ?? (existsSync(join(WE, 'assets', name)) ? readFileSync(join(WE, 'assets', name)) : null);
  const modelBuf = load(obj.image);
  if (!modelBuf) return { source: null, texPath: null, reason: 'model-missing' };
  let matRef;
  try { matRef = JSON.parse(Buffer.from(modelBuf).toString('utf8'))?.material; } catch { return { source: null, texPath: null, reason: 'model-invalid' }; }
  if (typeof matRef !== 'string' || !matRef) return { source: null, texPath: null, reason: 'no-material' };
  const matBuf = load(matRef);
  if (!matBuf) return { source: null, texPath: null, reason: 'material-missing' };
  let texName;
  try { texName = JSON.parse(Buffer.from(matBuf).toString('utf8'))?.passes?.[0]?.textures?.[0]; } catch { return { source: null, texPath: null, reason: 'material-invalid' }; }
  if (typeof texName !== 'string' || !texName) return { source: null, texPath: null, reason: 'no-texture-slot' };
  const texPath = resolveTexPath(matRef, texName);
  const texBuf = load(texPath);
  if (!texBuf) return { source: null, texPath, reason: 'tex-missing' };
  const h = texHeader(texBuf);
  if (!h) return { source: null, texPath, reason: 'tex-header-invalid' };
  if (h.video) {
    // 视频纹理：就绪前 videoWidth=0 ⇒ 实现回退屏占位；就绪后按视频尺寸升。两种都是合法结果（spec §3.4）。
    const dims = mp4Dims(mip0Payload(texBuf));
    return { source: dims ? { width: Math.round(dims.width), height: Math.round(dims.height) } : null, texPath, reason: dims ? 'video' : 'video-dims-unknown', video: true };
  }
  if (h.sprite) return { source: { width: h.imageW, height: h.imageH }, texPath, reason: 'sprite', sprite: true };
  return { source: { width: h.imageW, height: h.imageH }, texPath, reason: 'ok' };
}

// scene.json 的 kind 判定（parseSceneJson 同序：particle > image(util 单列) > text > 空粒子兜底）。
function kindOf(o) {
  if (typeof o.particle === 'string' && o.particle) return 'particle';
  if (typeof o.image === 'string' && o.image) return o.image.startsWith('models/util/') ? 'util' : 'image';
  if (o.text !== undefined && o.text !== null) return 'text';
  return 'particle'; // 无媒体字段的纯控制器对象（particle: '' 兜底，不参与隔离）
}
// 装载期静态隐藏（visibility.isStaticallyHidden）：plain/user 按 value 定论（e2e 页面无用户属性注入
// ⇒ user 键缺失回退绑定 value），script 恒不隐藏。
function staticallyHidden(vis) {
  if (typeof vis === 'boolean') return !vis;
  if (typeof vis !== 'object' || vis === null || Array.isArray(vis)) return false;
  if (typeof vis.user === 'string' && vis.user) return vis.value === false;
  return false;
}

// cover 语义的视锥宽（object-range.coverRange）：视口更宽 → 场景宽铺满；更窄 → 场景高铺满。
function coverWidth(sceneW, sceneH, viewAspect) {
  const sceneAspect = sceneW / sceneH;
  return viewAspect > sceneAspect ? sceneW : sceneH * viewAspect;
}
// 屏幕密度（设备像素 / 世界单位）= 画布缓冲宽 / cover 视锥宽（与生产同一把尺子）。
const screenDensity = (sceneW, sceneH, vw, vh, dpr) => IDS(vw * dpr) / coverWidth(sceneW, sceneH, vw / vh);
// 屏占位（等比收口 4096）= object-range.objectRtSize。
function objectRtSize(worldW, worldH, density, cap = OBJECT_RT_MAX) {
  const rawW = Math.abs(worldW) * density, rawH = Math.abs(worldH) * density;
  const k = Math.min(1, cap / Math.max(rawW, rawH, 1));
  return { width: Math.max(1, Math.round(rawW * k)), height: Math.max(1, Math.round(rawH * k)) };
}
// 隔离 RT 尺寸（方案 A′）= object-range.isolatedRtSize：期望长边 = max(屏占位长边, min(源长边, 4096))，
// budgetScale ∈ (0,1] 只收窄「超出屏占位」的升级幅度 ⇒ 下限恒为屏占位（只升不降）。
function isolatedRtSize(worldW, worldH, density, source, budgetScale = 1) {
  const occ = objectRtSize(worldW, worldH, density);
  const occLong = Math.max(occ.width, occ.height);
  const srcLong = source ? Math.max(source.width, source.height) : 0;
  const bs = budgetScale > 0 && budgetScale < 1 ? budgetScale : 1;
  const targetLong = Math.max(occLong, occLong + (Math.max(occLong, Math.min(srcLong, OBJECT_RT_MAX)) - occLong) * bs);
  if (targetLong <= occLong + 1e-6) return { ...occ, occ, expectedLong: occLong, upgraded: false };
  const base = Math.max(Math.abs(worldW), Math.abs(worldH));
  const k = base > 0 ? targetLong / base : 1;
  return {
    width: Math.max(1, Math.round(Math.abs(worldW) * k)), height: Math.max(1, Math.round(Math.abs(worldH) * k)),
    occ, expectedLong: Math.round(targetLong), upgraded: true,
  };
}
// 显存预算（object-range.fitIsolatedBudget）：预算内恰好 1；否则二分出能装下的最大比例。
function fitIsolatedBudget(items, density, budgetBytes = BUDGET_BYTES, perPx = BYTES_PER_PX) {
  const px = (s) => items.reduce((sum, it) => {
    const r = isolatedRtSize(it.worldW, it.worldH, density, it.source, s);
    return sum + r.width * r.height;
  }, 0);
  if (px(1) * perPx <= budgetBytes) return 1;
  let lo = 1e-4;
  if (px(lo) * perPx > budgetBytes) return lo;
  let hi = 1;
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (px(mid) * perPx <= budgetBytes) lo = mid; else hi = mid; }
  return lo;
}

// 一张壁纸的素材侧期望（键 = scene 对象 id）。
function analyseWallpaper(id, reader) {
  const scene = JSON.parse(Buffer.from(reader.readEntry('scene.json')).toString('utf8'));
  const sceneW = Number(scene.general?.orthogonalprojection?.width);
  const sceneH = Number(scene.general?.orthogonalprojection?.height);
  if (!(sceneW > 0) || !(sceneH > 0)) throw new Error(`${id}: scene.json 缺 general.orthogonalprojection`);
  const density = screenDensity(sceneW, sceneH, VW, VH, DPR);
  const items = [];
  for (const o of scene.objects ?? []) {
    if (!Array.isArray(o.effects) || o.effects.length === 0) continue;
    if (staticallyHidden(o.visible)) continue;
    const kind = kindOf(o);
    if (kind !== 'image' && kind !== 'particle') continue;
    const src = kind === 'image' ? sourcePixelsOf(reader, o) : { source: null, texPath: null, reason: 'particle' };
    const size = nums(o.size), scale = nums(o.scale);
    const sx = Number.isFinite(scale[0]) ? scale[0] : 1, sy = Number.isFinite(scale[1]) ? scale[1] : 1;
    // 世界尺寸 = 未钳制 |size × scale|；缺 size 按纹理像素兜底（与 three-renderer 挂载期同式）。
    const bw = Number.isFinite(size[0]) ? size[0] : (src.source?.width ?? 1);
    const bh = Number.isFinite(size[1]) ? size[1] : (src.source?.height ?? 1);
    items.push({
      obj: Number(o.id), kind, worldW: Math.abs(bw * sx), worldH: Math.abs(bh * sy),
      source: src.source, texPath: src.texPath, sourceReason: src.reason, video: !!src.video, sprite: !!src.sprite,
    });
  }
  const budgetScale = fitIsolatedBudget(items, density);
  const expected = new Map();
  for (const it of items) {
    const sized = isolatedRtSize(it.worldW, it.worldH, density, it.source, budgetScale);
    const rtLong = Math.max(sized.width, sized.height); // 期望长边 = 公式给出的 RT 实际长边
    const occLong = Math.max(sized.occ.width, sized.occ.height);
    // 合法长边集合：一般对象只有一个；**视频纹理**就绪与否是运行期竞态（spec §3.4：就绪前回退屏占位、
    // 就绪后按视频尺寸升），故两种都合法 —— 其余判据（只升不降 / samples / mip）对它仍然照判。
    const allowedLong = new Set([rtLong]);
    if (it.video) allowedLong.add(occLong);
    expected.set(it.obj, {
      ...it, density, budgetScale, occ: sized.occ, occLong, allowedLong,
      expectedLong: rtLong,
      // 满屏判定（spec §3.2）：kind=background（= image 对象）且世界尺寸 ≥ 0.98 × 场景尺寸
      fullscreen: it.kind === 'image' && it.worldW >= sceneW * 0.98 && it.worldH >= sceneH * 0.98,
      expectSamples: it.kind === 'image' && it.worldW >= sceneW * 0.98 && it.worldH >= sceneH * 0.98 ? 0 : 4,
      expectMip: rtLong > occLong, // R28 口径（实现另有 +0.5 容差，整数尺寸下等价）
    });
  }
  return { id, sceneW, sceneH, density, budgetScale, expected, itemCount: items.length };
}

// ── 被测产物：src 现编（tsc，同 npm run build 配置）→ 重定向 harness 的 lib/client import ──────
const TMP_LIB = join(OUT, 'lib');
function buildFreshLib() {
  rmSync(TMP_LIB, { recursive: true, force: true });
  const tsc = requireFile(join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '缺 typescript（pnpm install）');
  const r = spawnSync(process.execPath, [tsc, '-p', join(repo, 'tsconfig.json'), '--outDir', TMP_LIB, '--declaration', 'false'],
    { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tsc 编译 src 失败（status=${r.status}）：\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  if (!existsSync(join(TMP_LIB, 'client', 'three-renderer.js'))) throw new Error('tsc 未产出 lib/client/three-renderer.js');
  return join(TMP_LIB, 'client', 'three-renderer.js');
}
buildFreshLib();
// lib/**/*.js → 现编产物（同一份源码、同一个 tsc 配置；见文件头「被测对象」）
const freshLibPlugin = {
  name: 'fresh-lib',
  setup(b) {
    b.onResolve({ filter: /[\\/]lib[\\/].*\.js$/ }, (args) => {
      const abs = resolve(args.resolveDir || here, args.path);
      const rel = relative(join(repo, 'lib'), abs);
      if (!rel || rel.startsWith('..')) return null;
      const hit = join(TMP_LIB, rel);
      return existsSync(hit) ? { path: hit } : null;
    });
  },
};

// quickjs 沙箱 wasm（页面加载的就是 dist/static 里那份；与 verify-text-clock-layer 同逻辑）
function resolveQuickjsWasm() {
  const cands = [
    join(repo, 'dist', 'static', 'quickjs.wasm'),
    join(repo, 'node_modules', '@jitl', 'quickjs-wasmfile-release-sync', 'dist', 'emscripten-module.wasm'),
  ];
  const pnpmDir = join(repo, 'node_modules', '.pnpm');
  if (existsSync(pnpmDir)) {
    for (const d of readdirSync(pnpmDir).filter((n) => n.startsWith('@jitl+quickjs-wasmfile-release-sync@'))) {
      cands.push(join(pnpmDir, d, 'node_modules', '@jitl', 'quickjs-wasmfile-release-sync', 'dist', 'emscripten-module.wasm'));
    }
  }
  const hit = cands.find((p) => existsSync(p));
  if (!hit) throw new Error('找不到 quickjs.wasm（先 `npm run build:client` 或 `pnpm install`）');
  return hit;
}
const QUICKJS_WASM = resolveQuickjsWasm();

const { PkgReader } = await import(pathToFileURL(join(TMP_LIB, 'host', 'pkg-reader.js')).href);
const READERS = new Map();
const readerOf = (id) => {
  if (!READERS.has(id)) READERS.set(id, new PkgReader(requireFile(join(WS, id, 'scene.pkg'), `本机缺少壁纸 ${id}（用 --workshop=<dir> 指定）`)));
  return READERS.get(id);
};
// 素材侧期望（浏览器启动前全部算完：判据不依赖运行期状态）
const ANALYSIS = new Map(RUN.map((c) => [c.id, analyseWallpaper(c.id, readerOf(c.id))]));

const bundle = (await esbuild.build({
  entryPoints: [join(here, '..', 'harness', 'harness-text-clock-entry.mjs')],
  bundle: true, format: 'esm', target: 'es2022', write: false, logLevel: 'silent',
  plugins: [freshLibPlugin],
})).outputFiles[0].text;

const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.otf': 'font/otf',
};
const HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#000}canvas{display:block}</style>
</head><body><script type="module" src="/harness.js"></script></body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = decodeURIComponent(url.pathname);
  const send = (body, type, status = 200) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  try {
    if (p === '/' || p === '/index.html') return send(HTML, 'text/html; charset=utf-8');
    if (p === '/harness.js') return send(bundle, 'text/javascript; charset=utf-8');
    if (p.startsWith('/wallpapers/static/')) {
      const file = p.slice('/wallpapers/static/'.length);
      if (file === 'quickjs.wasm') return send(readFileSync(QUICKJS_WASM), 'application/wasm');
      const local = join(repo, 'dist', 'static', file);
      if (existsSync(local)) return send(readFileSync(local), MIME[extname(file)] ?? 'application/octet-stream');
      console.log('   [404 static]', file); return send('nf', 'text/plain', 404);
    }
    const m = /^\/wallpapers\/scene\/([^/]+)\/asset$/.exec(p);
    if (m) {
      const id = m[1];
      const name = url.searchParams.get('name') ?? '';
      const reader = READERS.get(id);
      const entry = reader?.readEntry(name);
      if (entry) return send(entry, MIME[extname(name)] ?? 'application/octet-stream');
      // 复刻 host 的二级查找：scene.pkg 未命中 → WE 引擎 assets（字体/内置材质等）
      const base = resolve(join(WE, 'assets'));
      const engine = name ? resolve(base, name) : base;
      if (name.includes('..') || engine === base || !engine.startsWith(base) || !existsSync(engine) || !statSync(engine).isFile()) {
        return send('nf', 'text/plain', 404);
      }
      return send(readFileSync(engine), MIME[extname(name)] ?? 'application/octet-stream');
    }
    if (p === '/wallpapers/particle-texture') {
      const name = url.searchParams.get('name') ?? '';
      const id = url.searchParams.get('id') ?? '';
      const inPkg = id ? READERS.get(id)?.readEntry(`materials/${name}.tex`) : null;
      if (inPkg) return send(inPkg, 'application/octet-stream');
      const file = resolve(join(WE, 'assets', 'materials'), name + '.tex');
      if (existsSync(file) && statSync(file).isFile()) return send(readFileSync(file), 'application/octet-stream');
      return send('nf', 'text/plain', 404);
    }
    console.log('   [404]', p);
    return send('nf', 'text/plain', 404);
  } catch (e) {
    console.log('   [500]', p, String(e && e.message));
    return send('err', 'text/plain', 500);
  }
});

// ── CDP ──────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let edge, ws, msgId = 0, logs = [];
const pending = new Map();
const send2 = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId; pending.set(id, { resolve: res, reject: rej });
  ws.send(JSON.stringify({ id, method, params }));
});
async function evalJs(expression) {
  const r = await send2('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
}
const jsonOf = async (expr) => JSON.parse(await evalJs(`JSON.stringify(${expr})`) ?? 'null');
// 失败类告警（效果链编译失败 / 具名 RT 超限 / 整链放弃…）：判据只认这一类。
// 其余告警（纹理槽留空、视频回退、未渲染对象上的效果链…）逐条打印供人工核对 —— R28 禁 base arm，
// 「新增」无法严格做差，故口径与 verify-text-clock-layer 的判定段一致：只判「失败类」。
const FAIL_WARN = /效果链\s*\d*\s*的具名 RT 超过|放弃该效果链|具名 RT 缺失|编译失败|无法创建|超限|out of memory|Failed to compile/i;

try {
  await new Promise((r) => server.listen(PORT, r));
  console.log(`[iso-rt] 视口 CSS ${VW}×${VH} dpr=${DPR}（页面会被钉到同一组数字）  GPU=${USE_GPU ? 'd3d11' : 'SwiftShader（--swiftshader：FPS 判据降级为 SKIP）'}`);
  console.log(`[iso-rt] 被测产物 = 现编 src（tsc → ${relative(repo, TMP_LIB)}），harness 的 lib/client import 已重定向`);
  console.log(`[iso-rt] 壁纸清单（R29）：${RUN.map((c) => `${c.id}(${c.name})`).join(', ')}  串行执行`);
  for (const c of RUN) {
    const a = ANALYSIS.get(c.id);
    console.log(`[iso-rt]   ${c.id}: 场景 ${a.sceneW}×${a.sceneH} 密度=${a.density.toFixed(6)} `
      + `素材侧隔离对象=${a.expected.size} budgetScale=${a.budgetScale.toFixed(4)}`);
  }

  edge = spawn(resolveEdgePath(), [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(OUT, '.edge-isolated-rt')}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-background-timer-throttling',
    `--window-size=${VW},${VH}`,
    ...(USE_GPU ? ['--use-angle=d3d11', '--ignore-gpu-blocklist'] : ['--enable-unsafe-swiftshader']),
    '--disable-gpu-sandbox', 'about:blank',
  ], { stdio: 'ignore' });

  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < TIMEOUT_MS) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) { up = true; break; } } catch { /* 未就绪 */ }
    await sleep(400);
  }
  if (!up) throw new Error(`CDP 未就绪（${TIMEOUT_MS}ms）`);
  const pages = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  // 只取本进程刚启动的 about:blank 页面（残留实例也会带同名端口/同 URL 的页面，连错就读到空页面）
  const page = pages.find((t) => t.type === 'page' && String(t.url).startsWith('about:')) ?? pages.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到 CDP page 目标');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) { const pp = pending.get(m.id); if (pp) { pending.delete(m.id); m.error ? pp.reject(new Error(m.error.message)) : pp.resolve(m.result); } return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args ?? []).map((x) => x.value ?? x.description ?? '').join(' ');
      logs.push({ level: m.params.type, text });
    } else if (m.method === 'Log.entryAdded') {
      logs.push({ level: m.params.entry.level, text: `${m.params.entry.url ?? ''} ${m.params.entry.text}` });
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push({ level: 'exception', text: m.params.exceptionDetails?.exception?.description ?? '' });
    }
  };
  await send2('Runtime.enable'); await send2('Log.enable'); await send2('Page.enable');
  const rendererInfo = { renderer: 'unknown', vendor: 'unknown', version: 'unknown' };

  const results = [];
  for (const c of RUN) {
    const isFirst = results.length === 0; // 渲染器字符串每轮一样，只在首张打印一次
    logs = [];
    await send2('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: DPR, mobile: false });
    await send2('Page.navigate', { url: `http://127.0.0.1:${PORT}/?id=${c.id}&vw=${VW}&vh=${VH}` });
    // 就绪：window.__ready（harness 在 render() 完成后置位）
    const tr = Date.now();
    let ready = false;
    while (Date.now() - tr < TIMEOUT_MS) {
      try { if (await evalJs('window.__ready === true')) { ready = true; break; } } catch { /* 导航中 */ }
      await sleep(200);
    }
    console.log(`\n===== ${c.id}（${c.name}）=====`);
    if (!ready) console.log(`  ⚠️ 页面在 ${TIMEOUT_MS}ms 内未就绪（判据将失败）`);
    await sleep(1500); // 挂载后让效果链/粒子跑起来再采（固定 sleep 之外另有轮询判据）
    // 视口必须真是脚本声明的数字：否则屏幕密度与判据不在同一个坐标系（text-clock 踩过一次）
    const vp = await jsonOf('({ iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio, '
      + 'cw: document.querySelector("canvas")?.width, ch: document.querySelector("canvas")?.height })');
    if (vp) Object.assign(rendererInfo, await jsonOf('window.__glRendererInfo()') ?? {});
    let iso = null;
    const ti = Date.now();
    while (Date.now() - ti < TIMEOUT_MS) {
      iso = await jsonOf('window.__isoInfo()');
      if (Array.isArray(iso) && iso.length > 0) break;
      await sleep(300);
    }
    const shotRes = await send2('Page.captureScreenshot', { format: 'png' });
    const shot = Buffer.from(shotRes.data, 'base64');
    const shotPath = join(SHOTS, `${c.id}.png`);
    writeFileSync(shotPath, shot);
    const fps = JSON.parse(await evalJs('(async () => JSON.stringify(await window.__fpsProbe(5000)))()') ?? 'null');
    const warns = logs.filter((l) => /\[wallpaper-engine\]|\[three\]/.test(l.text));
    const failWarns = warns.filter((l) => FAIL_WARN.test(l.text));
    results.push({ case: c, analysis: ANALYSIS.get(c.id), viewport: vp, ready, iso: Array.isArray(iso) ? iso : null, shotPath, fps, warns, failWarns });
    console.log(`  ready=${ready} 视口 innerW/H=${vp?.iw}×${vp?.ih} dpr=${vp?.dpr} 画布缓冲=${vp?.cw}×${vp?.ch}`
      + (isFirst ? `  渲染器=${rendererInfo.renderer}（${rendererInfo.version}）` : ''));
    console.log(`  隔离对象（__isoInfo）：${JSON.stringify(iso)}`);
    console.log(`  FPS=${fps?.fps ?? 'n/a'}（frames=${fps?.frames}）  告警 ${warns.length} 条（失败类 ${failWarns.length} 条）`);
    for (const w of warns.slice(0, 6)) console.log(`    [${w.level}] ${w.text.slice(0, 160)}`);
    console.log(`  截图：${relative(repo, shotPath)}`);
  }

  // ── 判定段 ─────────────────────────────────────────────────────────────────────────────
  console.log('\n===== 判定（绝对性质：可从素材独立算出；不比对参考图）=====');
  let ok = true;
  const caseMetrics = [];
  for (const r of results) {
    const c = r.case, a = r.analysis;
    const checks = [];
    const add = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); if (!pass) ok = false; };
    const rep = new Map((r.iso ?? []).map((o) => [o.obj, o]));
    console.log(`\n--- ${c.id}（${c.name}）---`);
    add('页面就绪（window.__ready）', r.ready, `ready=${r.ready}`);
    add(`视口/DPR 与脚本声明一致（${VW}×${VH} dpr=${DPR}）`,
      !!r.viewport && r.viewport.iw === VW && r.viewport.ih === VH && r.viewport.dpr === DPR && r.viewport.cw === VW && r.viewport.ch === VH,
      JSON.stringify(r.viewport));
    // ⚠️ 空断言防护：没有隔离对象时下面逐对象判据一条都不跑（历史教训：全绿 = 假绿）
    add(`素材侧隔离对象非空（否则逐对象判据是空断言）`, a.expected.size > 0, `素材侧 ${a.expected.size} 个`);
    add('__isoInfo() 可用（隔离 RT 实况可读）', Array.isArray(r.iso), r.iso === null ? '__isoInfo() 返回 null' : `${r.iso.length} 条`);
    // 集合一致性：素材侧说有、运行期没有（或反之）都要报出来
    const missing = [...a.expected.keys()].filter((id) => !rep.has(id));
    const extra = [...rep.keys()].filter((id) => !a.expected.has(id));
    add('隔离对象集合 == 素材侧期望（无漏隔离/多隔离）', missing.length === 0 && extra.length === 0,
      `缺=${JSON.stringify(missing)} 多=${JSON.stringify(extra)}`);
    let totalPx = 0;
    const objRows = [];
    for (const [objId, exp] of a.expected) {
      const got = rep.get(objId);
      if (!got) continue;
      const rtLong = Math.max(...got.rt);
      const rtPx = got.rt[0] * got.rt[1];
      const occPx = exp.occ.width * exp.occ.height;
      totalPx += rtPx;
      const longOk = exp.allowedLong.has(rtLong);
      add(`obj ${objId} RT 长边 === 期望 ${[...exp.allowedLong].join(' 或 ')}`, longOk,
        `实测 ${rtLong}（${got.rt.join('×')}；屏占位 ${exp.occ.width}×${exp.occ.height}；源 ${exp.source ? `${exp.source.width}×${exp.source.height}(${exp.sourceReason})` : `未知(${exp.sourceReason})`}）`);
      add(`obj ${objId} 只升不降（RT 像素 ${rtPx} ≥ 屏占位 ${occPx}）`, rtPx >= occPx, `${rtPx} vs ${occPx}`);
      add(`obj ${objId} samples === ${exp.expectSamples}（满屏背景关 MSAA / 其余保留）`, got.samples === exp.expectSamples,
        `实测 ${got.samples}（kind=${got.kind} world=${got.world?.map((v) => Math.round(v)).join('×')} 满屏=${exp.fullscreen}）`);
      add(`obj ${objId} mip === ${exp.expectMip}（RT 长边 ${rtLong} ${exp.expectMip ? '>' : '≤'} 屏占位长边 ${exp.occLong}）`,
        got.mip === exp.expectMip, `实测 ${got.mip}（minFilter=${got.minFilter}）`);
      objRows.push({
        obj: objId, kind: got.kind, world: got.world ?? [exp.worldW, exp.worldH],
        source: exp.source ? [exp.source.width, exp.source.height] : null, sourceReason: exp.sourceReason, texPath: exp.texPath,
        occ: [exp.occ.width, exp.occ.height], expectedLong: exp.expectedLong, rt: got.rt, rtPixels: rtPx,
        samples: got.samples, expectSamples: exp.expectSamples, mip: got.mip, expectMip: exp.expectMip,
        fullscreen: exp.fullscreen, onlyUp: rtPx >= occPx, longOk,
      });
    }
    add('无失败类 [wallpaper-engine]/[three] 告警', r.failWarns.length === 0,
      r.failWarns.map((w) => w.text.slice(0, 120)).join(' | ') || `${r.warns.length} 条一般告警（逐条已打印）`);
    if (USE_GPU) {
      add(`FPS ≥ 30（__fpsProbe(5000)；本机 60Hz vsync ⇒ 只能当地板）`, (r.fps?.fps ?? 0) >= 30, `fps=${r.fps?.fps ?? 'n/a'}`);
    } else {
      console.log(`  SKIP  FPS 判据（--swiftshader：软件光栅化数字无意义）fps=${r.fps?.fps ?? 'n/a'}`);
    }
    for (const ch of checks) console.log(`  ${ch.pass ? 'PASS' : 'FAIL'}  ${ch.name}${ch.pass ? '' : `  ← ${ch.detail}`}`);
    console.log(`  Σ 隔离对象 RT 像素（机器无关工作量代理）= ${(totalPx / 1e6).toFixed(3)} Mpx`
      + `（${totalPx} px；按 ${BYTES_PER_PX} B/px 粗估 ≈ ${(totalPx * BYTES_PER_PX / 1048576).toFixed(1)} MB，**不是显存保证**）`);
    caseMetrics.push({
      id: c.id, name: c.name, minGainTarget: c.minGain, ok: checks.every((x) => x.pass), checks,
      scene: [a.sceneW, a.sceneH], density: a.density, budgetScale: a.budgetScale,
      isolated: objRows, isolatedCount: objRows.length, totalRtPixels: totalPx,
      fps: r.fps?.fps ?? null, fpsFrames: r.fps?.frames ?? null, fpsChecked: USE_GPU,
      viewport: r.viewport, ready: r.ready,
      warnings: r.warns.map((w) => `[${w.level}] ${w.text}`), failWarnings: r.failWarns.map((w) => w.text),
      shot: relative(repo, r.shotPath),
    });
  }
  const spend = caseMetrics.reduce((s, m) => s + m.totalRtPixels, 0);
  const metrics = {
    generatedAt: new Date().toISOString(),
    viewport: [VW, VH], dpr: DPR, gpu: USE_GPU, renderer: rendererInfo,
    // 判据口径与常量（独立于 src 的一份复述）
    constants: { objectRtMax: OBJECT_RT_MAX, budgetBytes: BUDGET_BYTES, bytesPerPx: BYTES_PER_PX },
    densityFormula: 'floor(vw × dpr) / coverWidth(sceneW, sceneH, vw/vh)',
    expectedFormula: 'RT 长边 = max(屏占位长边, min(源纹理长边, 4096))；预算 budgetScale<1 时按收窄后的升级幅度',
    // R14/如实：预算不是硬保证，只是「尽力收窄升级幅度」的启发式
    budgetNote: `显存预算 ${BUDGET_BYTES} B / ${BYTES_PER_PX} B/px 只在超预算时收窄「超出屏占位」的升级幅度，`
      + `下限恒为屏占位；**不构成「显存不会爆」的保证**（驱动/其他上下文/纹理本身都占显存）。`,
    sharpnessNote: '本脚本不比对基线图；锐度增益是手工对照（96×96 块、NCC ≥ 0.6 过滤、取中位数），数据见 task-9-report.md。',
    fpsNote: '本机 60Hz vsync ⇒ FPS 只能当**地板**用，测不出 60 以上的余量，也不覆盖低端 GPU/4K 屏。',
    serialNote: 'harness 端口与 Edge user-data-dir 固定 ⇒ 不得并行跑多份。',
    cases: caseMetrics,
    summary: { cases: caseMetrics.length, pass: caseMetrics.filter((m) => m.ok).length, fail: caseMetrics.filter((m) => !m.ok).length,
      totalRtPixels: spend, minFps: Math.min(...caseMetrics.map((m) => m.fps ?? Infinity)) },
  };
  writeFileSync(join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 1));
  console.log(`\n===== 结论 =====`);
  console.log(`  壁纸 ${metrics.summary.pass}/${metrics.summary.cases} 通过；Σ 隔离对象 RT 像素（本轮 ${caseMetrics.length} 张**合计**，机器无关工作量代理）= ${(spend / 1e6).toFixed(3)} Mpx；最低 FPS = ${Number.isFinite(metrics.summary.minFps) ? metrics.summary.minFps : 'n/a'}`);
  console.log(`  （每张壁纸的 Σ 见上方逐张输出与 metrics.json；显存预算按**单张**壁纸算，不要拿这张合计值当显存。）`);
  console.log(`  ${metrics.budgetNote}`);
  console.log(`  FPS 局限：${metrics.fpsNote}`);
  console.log(`  产物：${relative(repo, OUT)}（截图 shots/<id>.png、metrics.json）`);
  if (!ok) process.exitCode = 1;
} catch (e) {
  console.error('ERROR:', (e && e.stack) || e);
  process.exitCode = 1; // 脚本异常也必须非零，否则 CI 会把崩溃当通过
} finally {
  try { ws?.close(); } catch { /* 已关 */ }
  edge?.kill();
  server.close();
}
