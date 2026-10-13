// 「魔兽之门」1922570576 的 text 层端到端 harness 入口。
//
// ⚠️ 只 import `lib/client/*`（`npm run build` 的生产产物），不 import `src/`：
// 由 e2e/verify/verify-text-clock-layer.mjs 用 esbuild 打包成自包含 bundle，headless Edge 打开。
//
// 走生产的 `createThreeSceneRenderer().render(id, canvas)` 入口。`broken=script` 时把
// `getTextScriptRuntime` 注入成「永远返回 null」（**生产入口的公开注入点**，与脚本 bind 失败
// 落在同一条分支：`obj.script && !binding && !isClock → continue`）⇒ text 层被整层跳过 = 修复前行为。
//
// 观测口径只走生产公开 API：`player.displayObject(对象 id)`（脚本图层桥用的公开方法）+
// `player.camera`。不读私有字段、不为观测在生产代码里加导出。
import * as THREE from 'three';
import { createThreeSceneRenderer } from '../../lib/client/three-renderer.js';
import { ThreeScenePlayer } from '../../lib/client/threejs-player.js';

// ── 受控帧推进 + 可冻结的动画时钟（修复轮 2：同相位采样）────────────────────────────
// 目的：让「显示文本层」与「隐藏文本层」两帧的**背景像素完全一致**，两帧之差才只剩文本层自身。
// 依据：生产帧体用 `performance.now()` 差分算 dt（`lib/client/threejs-player.js:665,672`）且模拟只按
// dt 推进 ⇒ 把 now 钉住即 dt=0（背景不前进）；rAF 代理让帧只在 `__pumpFrame()` 时推进一帧。
// 只改 e2e 观测侧；`lib/` 的时间源与帧序未动。
const realRaf = window.requestAnimationFrame.bind(window);
const realCancelRaf = window.cancelAnimationFrame.bind(window);
const realNow = performance.now.bind(performance);
let vnow = null;            // 非 null = 冻结在该时刻
let rafControlled = false;  // true = rAF 回调入队，等 __pumpFrame()
let rafSeq = 0;
const rafQueue = new Map();
performance.now = () => (vnow === null ? realNow() : vnow);
window.requestAnimationFrame = (cb) => {
  if (!rafControlled) return realRaf(cb);
  rafQueue.set(++rafSeq, cb);
  return rafSeq;
};
window.cancelAnimationFrame = (id2) => { if (!rafQueue.delete(id2)) realCancelRaf(id2); };
window.__setRafControlled = (on) => { rafControlled = !!on; return { rafControlled, queued: rafQueue.size, vnow }; };
window.__freezeClock = () => { vnow = realNow(); return vnow; };
const RealDate = Date; // 反冻结用（必须在任何冻结之前取）
let wallClockFrozen = false;
/** 冻结**墙钟**：时钟脚本的文本是 `new Date()` 生成的（`lib/client/threejs-player.js:1617` 每帧喂给
 *  文本驱动，本例脚本 `showSeconds=true` ⇒ 秒位每秒重绘、quad 布局随之微调）——只冻 performance.now
 *  挡不住它。把 `Date` / `Date.now` 钉在同一时刻 ⇒ 文本内容也确定，两帧才只差「该层渲染出多少」。 */
/** `ms` 给定时钉到该时刻（本地 `HH:MM:SS` 内容可控 ⇒ 判据可在多个内容档上验证尺度无关性），缺省钉在当下。 */
window.__freezeWallClock = (ms) => {
  const fixed = Number.isFinite(ms) ? ms : RealDate.now();
  const Frozen = function (...args) { return args.length === 0 ? new RealDate(fixed) : new RealDate(...args); };
  Frozen.now = () => fixed;
  Frozen.parse = RealDate.parse;
  Frozen.UTC = RealDate.UTC;
  Frozen.prototype = RealDate.prototype;
  window.Date = Frozen;
  wallClockFrozen = true;
  return { ms: fixed, iso: new RealDate(fixed).toISOString(), frozen: true };
};
/** **反**冻结墙钟（只服务负向对照：验证「墙钟没冻住 ⇒ 判据必须红」，不影响默认路径）。
 *  还原后 `Date` 随真实时间前进 ⇒ 两次「显示」帧跨越秒位边界时文本内容会变。 */
window.__unfreezeWallClock = () => {
  window.Date = RealDate;
  wallClockFrozen = false;
  return { ms: RealDate.now(), iso: new RealDate().toISOString(), frozen: false };
};
/** 只读自证：`Date` 现在是真身还是被钉死的替身（日志里打印，防「以为冻住了其实没冻」）。 */
window.__wallClockState = () => ({ frozen: wallClockFrozen, real: window.Date === RealDate, now: window.Date.now() });
/** 推进受控队列里的一帧（回调内新排的帧进入下一批）。返回本批执行数与残留队列长度。 */
window.__pumpFrame = () => {
  const batch = [...rafQueue.values()];
  rafQueue.clear();
  let ran = 0, err = null;
  for (const cb of batch) {
    try { cb(performance.now()); ran++; } catch (e) { err = String((e && e.message) || e); }
  }
  return { ran, queued: rafQueue.size, err };
};

const q = new URLSearchParams(location.search);
const id = q.get('id') ?? '';
const broken = q.get('broken') === 'script';
const VW = Math.max(1, Math.round(Number(q.get('vw') ?? 1600)));
const VH = Math.max(1, Math.round(Number(q.get('vh') ?? 900)));

// console 镜像（CDP 之外的双保险）
window.__logs = [];
for (const lv of ['log', 'info', 'warn', 'error']) {
  const orig = console[lv].bind(console);
  console[lv] = (...a) => {
    try { window.__logs.push({ level: lv, text: a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ') }); } catch { /* 镜像失败不影响页面 */ }
    orig(...a);
  };
}
window.addEventListener('error', (e) => window.__logs.push({ level: 'error', text: '[window.onerror] ' + e.message }));

// 抓生产 player 实例（补丁打在**类方法**上；renderer 内部 `new ThreeScenePlayer` 与本文件 import
// 到的是同一模块实例 ⇒ 补丁对生产路径创建的实例同样生效）。
const proto = ThreeScenePlayer.prototype;
for (const name of ['setSceneSize', 'resize']) {
  const orig = proto[name];
  if (typeof orig !== 'function') continue;
  proto[name] = function (...args) { window.__player = this; return orig.apply(this, args); };
}

const canvas = document.createElement('canvas');
canvas.width = VW;
canvas.height = VH;
canvas.style.cssText = `display:block;width:${VW}px;height:${VH}px`;
document.body.appendChild(canvas);

// 生产入口（与线上逐字相同）；`broken=script` 时注入「永远返回 null 的脚本运行时」。
// 关键：**同一个 renderer 实例 + 同一个 canvas** 下用 `__switchScriptRuntime()` 反复切换 ——
// 粒子相位/动画源在两帧之间保持一致（跨导航重开页面会因为粒子随机相位产生 ~4% 的噪声地板，
// 那种对照组量不出「只有文本层变了」）。wasm 模块在 renderer 内被缓存，切换不重载。
const makeRenderer = (brokenRuntime) => createThreeSceneRenderer(
  brokenRuntime ? { getTextScriptRuntime: async () => null } : undefined,
);
let renderer = makeRenderer(broken);
let ok = false, err = null;
let scriptRuntimeBroken = broken;
try {
  ok = await renderer.render(id, canvas);
  window.__renderer = renderer;
} catch (e) { err = String((e && e.stack) || e); }

/** 切换「脚本运行时可用 / 不可用」并同页重渲染（= 修复后 / 修复前的装配结果）。 */
window.__switchScriptRuntime = async (brokenRuntime) => {
  scriptRuntimeBroken = !!brokenRuntime;
  try { renderer.dispose(); } catch { /* 旧实例释放失败不影响重渲染 */ }
  renderer = makeRenderer(scriptRuntimeBroken);
  window.__renderer = renderer;
  const ok2 = await renderer.render(id, canvas);
  return { ok: ok2, broken: scriptRuntimeBroken };
};

/** 帧内隔离：直接切 text 图层的可见性（**不重渲染** ⇒ 粒子相位/动画源完全不变）。
 *  这是「该文本层在画面上贡献了多少像素」的唯一干净口径 —— 重渲染会重置粒子随机相位，
 *  产生 ~7% 的噪声地板，足以淹没文本层。 */
window.__hideTextLayer = (objectId, hidden) => {
  const p = window.__player;
  const o = p && p.displayObject(objectId);
  if (!o) return null;
  const prev = o.visible;
  o.visible = !hidden;
  return { objectId, prevVisible: prev, visible: o.visible };
};

// 原材质状态（对齐用：只改「这一层渲染出多少」，不改其它任何东西）。按对象 id 缓存 `transparent`：
// 条目不清理（每个被测对象最多 1 条，且后续每次注入都会按它还原），不是跨用例的状态泄漏。
const origMat = new Map();
// `localClippingEnabled` 是 renderer 级开关，注入覆盖率时会置 true ⇒ 记下原值，清掉裁剪面时还原。
let origLocalClipping = null;

/** 「该层只渲染了一部分」的注入开关（模拟部分衰减；不改 lib/，也不改几何参数 ⇒ 判据矩形不变）。
 *  `coverage` = 沿该 quad 自身局部 +x 轴保留的比例（1 = 全量 ⇒ 清掉裁剪面并还原 renderer 开关）。
 *  裁掉一半 ⇒ 屏幕上的字形像素/亮度总量大致按比例减少。 */
window.__setTextCoverage = (objectId, coverage) => {
  const p = window.__player;
  const o = p && p.displayObject(objectId);
  if (!o || !o.material) return null;
  const c = Math.max(0, Math.min(1, Number(coverage)));
  const w = (o.geometry && o.geometry.parameters && o.geometry.parameters.width) || 0;
  if (!(w > 0)) return null;
  const r = p.renderer;
  if (r && typeof r === 'object') {
    if (origLocalClipping === null) origLocalClipping = !!r.localClippingEnabled;
    r.localClippingEnabled = true;
  }
  if (c >= 1) {
    o.material.clippingPlanes = null;
    o.material.needsUpdate = true;
    if (r && origLocalClipping !== null) r.localClippingEnabled = origLocalClipping; // 还原：不留状态泄漏
    return { coverage: 1, clippingPlanes: 0, localClippingEnabled: !!r?.localClippingEnabled };
  }
  o.updateMatrixWorld(true);
  const a = new THREE.Vector3(-w / 2, 0, 0); o.localToWorld(a);
  const b = new THREE.Vector3(w / 2, 0, 0); o.localToWorld(b);
  const axis = b.clone().sub(a);
  const len = axis.length();
  if (!(len > 0)) return null;
  axis.divideScalar(len);
  // 保留 `axis·(p − a) ≤ c·len` 的一侧：平面条件为 `normal·p + constant ≥ 0`。
  const normal = axis.clone().negate();
  o.material.clippingPlanes = [new THREE.Plane(normal, axis.dot(a) + c * len)];
  o.material.needsUpdate = true;
  return {
    coverage: c, clippingPlanes: o.material.clippingPlanes.length,
    localClippingEnabled: !!r?.localClippingEnabled, worldAxis: [+axis.x.toFixed(3), +axis.y.toFixed(3), +axis.z.toFixed(3)],
  };
};

/** 「该层整体变淡」的注入开关（模拟亮度衰减；1 = 还原原状）。 */
window.__setTextOpacity = (objectId, opacity) => {
  const p = window.__player;
  const o = p && p.displayObject(objectId);
  if (!o || !o.material) return null;
  const key = String(objectId);
  if (!origMat.has(key)) origMat.set(key, { transparent: o.material.transparent });
  const base = origMat.get(key);
  const v = Math.max(0, Math.min(1, Number(opacity)));
  o.material.opacity = v;
  o.material.transparent = v < 1 ? true : base.transparent;
  o.material.needsUpdate = true;
  return { opacity: o.material.opacity, transparent: o.material.transparent, type: o.material.type };
};

/** 只读观测：把 text 图层的画布内容读回来（白色文本应在哪个像素区间、画布自身尺寸）。
 *  不依赖 WebGL 读回，也不改任何渲染语义。 */
window.__textCanvasImage = (objectId) => {
  const p = window.__player;
  const o = p && p.displayObject(objectId);
  const canvasEl = o && o.material && o.material.map ? o.material.map.image : null;
  if (!canvasEl || typeof canvasEl.toDataURL !== 'function') return null;
  // 逐行统计「亮像素」（三通道都 ≥ 200）的列范围，用来判断文本在画布里的实际位置
  const ctx = canvasEl.getContext('2d');
  const { width, height } = canvasEl;
  const data = ctx.getImageData(0, 0, width, height).data;
  // 「白色字形」判据：三通道都 ≥ 200 且 alpha > 100（排除透明边角）。顺带统计 alpha 均值/最小值。
  let bright = 0, y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
  let sumA = 0, minA = 255;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o2 = (y * width + x) * 4;
      if (data[o2] > 200 && data[o2 + 1] > 200 && data[o2 + 2] > 200 && data[o2 + 3] > 100) {
        bright++;
        sumA += data[o2 + 3];
        if (data[o2 + 3] < minA) minA = data[o2 + 3];
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
      }
    }
  }
  return {
    size: [width, height],
    brightPixels: bright,
    brightBBox: bright ? [x0, y0, x1, y1] : null,
    // 字形像素的实测量：作者写的是 alpha 0.84（≈214）；被压淡的话这里会明显偏低。
    strokeAlphaMean: bright ? Math.round(sumA / bright) : 0,
    strokeAlphaMin: bright ? minA : 0,
  };
};

/** 只读观测：该层**自身字形**投影到屏幕后会点亮多少像素 —— 判据 [9] 的**尺度无关分母**。
 *  只读「该层自己的纹理 + quad 投影」，不读渲染结果、不受覆盖率/透明度注入影响（注入不改纹理），
 *  因此「分子 ÷ 它」时时钟内容（点亮段数）在两侧同时约掉。
 *  口径 = 把屏幕像素反投影回 quad 局部平面取纹理坐标，再对它的**纹理足迹**（该像素处半径 1.33 texel 的
 *  3×3 texel 积分窗口 ⇒ **面积** ≈2.7²，minify 时字形会被"糊"开一圈）求 alpha 均值 ≈ 该像素覆盖到的字形
 *  比例；按阈值计数。换 quad 几何 / 纹理尺寸后这张足迹口径与判定阈值都要重标定（只标定在本例几何上）。
 *  返回的 `mask`（cov15）是判据 [9] 的分子掩码：**分子必须与它取交** —— 全屏强变化里还有该层带动的
 *  屏幕空间光晕（实测 quad 内约 5 px 宽的边圈，同内容档 8337 px 里占 4739 px），那不是它自己的字形。 */
window.__textGlyphScreenPixels = (objectId) => {
  try {
    const p = window.__player;
    const o = p && p.displayObject(objectId);
    if (!o || !o.geometry || !o.material) return null;
    const prm = o.geometry.parameters || {};
    const w = prm.width, h = prm.height;
    if (!(w > 0) || !(h > 0)) return null;
    const img = o.material.map && o.material.map.image;
    if (!img || typeof img.getContext !== 'function') return null;
    const W = img.width, H = img.height;
    const data = img.getContext('2d').getImageData(0, 0, W, H).data;
    const alphaAt = (tx, ty) => (tx < 0 || ty < 0 || tx >= W || ty >= H ? 0 : data[(ty * W + tx) * 4 + 3]);
    let texels = 0, texelsBright = 0;
    for (let i4 = 0; i4 < data.length; i4 += 4) {
      if (data[i4 + 3] <= 8) continue;
      texels++;
      if (data[i4] > 200 && data[i4 + 1] > 200 && data[i4 + 2] > 200 && data[i4 + 3] > 100) texelsBright++;
    }
    // 局部平面 (x,y,0) → ndc 的齐次 3×3 = (projectionMatrix · matrixWorld) 的第 0/1/3 列（投影是 homography）。
    p.scene.updateMatrixWorld(true);
    p.camera.updateMatrixWorld(true);
    const e = new THREE.Matrix4().multiplyMatrices(p.camera.projectionMatrix, o.matrixWorld).elements;
    const [a, b, c] = [e[0], e[4], e[12]];   // 第 1 行
    const [d, f, g] = [e[1], e[5], e[13]];   // 第 2 行
    const [i2, j, k] = [e[3], e[7], e[15]];  // 第 3 行（齐次分母）
    const ndcAt = (x, y) => {
      const cw = i2 * x + j * y + k;
      return [((a * x + b * y + c) / cw + 1) / 2 * VW, (1 - (d * x + f * y + g) / cw) / 2 * VH];
    };
    const corner = [[-w / 2, -h / 2], [w / 2, -h / 2], [-w / 2, h / 2], [w / 2, h / 2]].map(([x, y]) => ndcAt(x, y));
    const csx = corner.map((q) => q[0]), csy = corner.map((q) => q[1]);
    const bx0 = Math.max(0, Math.floor(Math.min(...csx))), bx1 = Math.min(VW - 1, Math.ceil(Math.max(...csx)));
    const by0 = Math.max(0, Math.floor(Math.min(...csy))), by1 = Math.min(VH - 1, Math.ceil(Math.max(...csy)));
    // 逆矩阵（ndc → 局部平面）：伴随矩阵 / 行列式。
    const det = a * (f * k - g * j) - b * (d * k - g * i2) + c * (d * j - f * i2);
    if (!(Math.abs(det) > 1e-12)) return null;
    const inv = [
      [(f * k - g * j) / det, (c * j - b * k) / det, (b * g - c * f) / det],
      [(g * i2 - d * k) / det, (a * k - c * i2) / det, (c * d - a * g) / det],
      [(d * j - f * i2) / det, (b * i2 - a * j) / det, (a * f - b * d) / det],
    ];
    const localAt = (nx, ny) => {
      const cw = inv[2][0] * nx + inv[2][1] * ny + inv[2][2];
      return [(inv[0][0] * nx + inv[0][1] * ny + inv[0][2]) / cw, (inv[1][0] * nx + inv[1][1] * ny + inv[1][2]) / cw];
    };
    // 纹理足迹**半径**（texel）= 纹理像素 / 屏幕像素 / 2：取 quad 两组对边的屏幕长度 ⇒ 同时是积分孔径。
    // 循环实际覆盖 round 出的 (2·round(r)+1)² 个 texel（本例 1.33 ⇒ 3×3 块 ≈2.7² 的**面积**，不是 r²）。
    const len = (q1, q2) => Math.hypot(q1[0] - q2[0], q1[1] - q2[1]);
    const sw = (len(corner[0], corner[1]) + len(corner[2], corner[3])) / 2;
    const sh = (len(corner[0], corner[2]) + len(corner[1], corner[3])) / 2;
    if (!(sw > 0) || !(sh > 0)) return null;
    const rx = W / sw / 2, ry = H / sh / 2;
    let support = 0, cov15 = 0, cov40 = 0, cov100 = 0;
    const mask = []; // cov15 的像素（打包成 y*VW+x）：判据把分子限制在「该层自己的字形足迹」内，剔除它带动的光晕
    let mx0 = Infinity, my0 = Infinity, mx1 = -Infinity, my1 = -Infinity;
    for (let sy = by0; sy <= by1; sy++) {
      for (let sx = bx0; sx <= bx1; sx++) {
        const [x, y] = localAt(((sx + 0.5) / VW) * 2 - 1, 1 - ((sy + 0.5) / VH) * 2);
        if (x < -w / 2 || x > w / 2 || y < -h / 2 || y > h / 2) continue; // quad 之外不计
        // mapFlipY=true：画布行 0 → v=1
        const cx = (x / w + 0.5) * W - 0.5, cy = (1 - (y / h + 0.5)) * H - 0.5;
        let s = 0, n = 0;
        for (let ty = Math.round(cy - ry); ty <= Math.round(cy + ry); ty++) {
          for (let tx = Math.round(cx - rx); tx <= Math.round(cx + rx); tx++) { s += alphaAt(tx, ty); n++; }
        }
        const m = n ? s / n : 0;
        if (m > 0) support++;
        if (m >= 15) {
          cov15++; mask.push(sy * VW + sx);
          if (sx < mx0) mx0 = sx; if (sx > mx1) mx1 = sx;
          if (sy < my0) my0 = sy; if (sy > my1) my1 = sy;
        }
        if (m >= 40) cov40++;
        if (m >= 100) cov100++;
      }
    }
    return {
      size: [W, H], texels, texelsBright, support, cov15, cov40, cov100,
      quadScreen: [bx0, by0, bx1, by1], footprintTexelRadius: [+rx.toFixed(2), +ry.toFixed(2)],
      mask, maskBBox: mask.length ? [mx0, my0, mx1, my1] : null,
    };
  } catch { return null; } // 只读旁路：形状不符一律 null，绝不把异常抛进判定流程
};

/** 诊断（只读）：dump 某个 scene 对象显示对象的材质参数 —— 核对「文本层用什么材质/混合/透明度画的」。 */
window.__objectMaterialInfo = (objectId) => {
  const p = window.__player;
  const o = p && p.displayObject(objectId);
  if (!o) return null;
  const m = o.material || {};
  return {
    type: m.type ?? null,
    transparent: m.transparent ?? null,
    opacity: m.opacity ?? null,
    blending: m.blending ?? null,
    blendSrc: m.blendSrc ?? null,
    blendDst: m.blendDst ?? null,
    premultipliedAlpha: m.premultipliedAlpha ?? null,
    depthTest: m.depthTest ?? null,
    depthWrite: m.depthWrite ?? null,
    color: m.color ? [m.color.r, m.color.g, m.color.b] : null,
    mapKind: m.map ? (m.map.constructor?.name ?? 'tex') : null,
    mapColorSpace: m.map?.colorSpace ?? null,
    mapFlipY: m.map?.flipY ?? null,
    mapPremultiplyAlpha: m.map?.premultiplyAlpha ?? null,
    mapSize: m.map?.image ? [m.map.image.width, m.map.image.height] : null,
    renderOrder: o.renderOrder ?? null,
    visible: o.visible,
    position: [o.position.x, o.position.y, o.position.z],
    scale: [o.scale.x, o.scale.y, o.scale.z],
  };
};

/** 某个 scene 对象 id 在**画布 CSS 像素**里的矩形（世界 quad 四角投影）；未登记 → null。 */
window.__objectRect = (objectId) => {
  const p = window.__player;
  const o = p && p.displayObject(objectId);
  if (!o || !o.geometry) return null;
  const prm = o.geometry.parameters || {};
  const w = prm.width, h = prm.height;
  if (!(w > 0) || !(h > 0)) return null;
  const cam = p.camera;
  const v = new THREE.Vector3();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  p.scene.updateMatrixWorld(true);
  for (const [dx, dy] of [[-w / 2, -h / 2], [w / 2, -h / 2], [-w / 2, h / 2], [w / 2, h / 2]]) {
    v.set(dx, dy, 0);
    o.localToWorld(v);
    v.project(cam);
    const sx = ((v.x + 1) / 2) * VW;
    const sy = ((1 - v.y) / 2) * VH;
    if (sx < x0) x0 = sx;
    if (sx > x1) x1 = sx;
    if (sy < y0) y0 = sy;
    if (sy > y1) y1 = sy;
  }
  const img = o.material && o.material.map ? o.material.map.image : null;
  return {
    objectId,
    canvasCss: [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)],
    norm: [x0 / VW, y0 / VH, x1 / VW, y1 / VH].map((n) => Math.round(n * 1000) / 1000),
    worldSize: [w, h],
    worldPos: [o.position.x, o.position.y, o.position.z],
    textureImage: img ? [img.width, img.height] : null,
    visible: o.visible,
  };
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(1500); // 让帧循环跑一会儿（脚本驱动每帧问一次 update）

// [perf] 帧率探针：统计 ms 毫秒内真实 rAF 回调次数（壁纸帧循环就是 rAF 驱动的）
window.__fpsProbe = (ms = 5000) => new Promise((resolve) => {
  let frames = 0;
  const t0 = performance.now();
  const tick = () => {
    frames++;
    const dt = performance.now() - t0;
    if (dt >= ms) resolve({ fps: Math.round((frames / dt) * 1000 * 10) / 10, frames, ms: Math.round(dt) });
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// [perf] 只读：取真实 GPU 渲染器字符串（SwiftShader/软件光栅化的数字无意义，用它自证）
window.__glRendererInfo = () => {
  try {
    const gl = window.__player?.renderer?.getContext?.();
    const ext = gl?.getExtension?.('WEBGL_debug_renderer_info');
    return {
      renderer: (ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || 'unknown',
      vendor: (ext && gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) || 'unknown',
      version: gl ? gl.getParameter(gl.VERSION) : 'unknown',
    };
  } catch { return { renderer: 'unknown', vendor: 'unknown', version: 'unknown' }; }
};

/** 只读观测：隔离对象 RT 实况（Task 9 验收网：锐度/外科性/FPS）。
 *  `rt`/`world` = 像素尺寸与对象世界尺寸（world 供交叉核对，判据由脚本从素材独立算出）。 */
window.__isoInfo = () => {
  const p = window.__player;
  if (!p || !p.isolated || typeof p.isolated.values !== 'function') return null;
  return [...p.isolated.values()].map((o) => ({
    obj: o.id, kind: o.kind,
    rt: [o.rtWidth, o.rtHeight], world: [o.worldW, o.worldH],
    samples: o.rt ? o.rt.samples : null,
    mip: o.rt && o.rt.texture ? !!o.rt.texture.generateMipmaps : null,
    minFilter: o.rt && o.rt.texture ? o.rt.texture.minFilter : null,
  }));
};

/** 只读观测（Task 3）：各隔离对象效果 pass 材质里 `g_TextureNResolution` 的实况。
 *  判据 = 四分量同值（= 各分支实际上传尺寸 ⇒ z/x === 1），且 `x` 应等于 `texImage[0]`（[8]②）；形状不符一律返回 null，不抛异常。 */
window.__fxResProbe = () => {
  try {
    const stage = window.__player && window.__player.objectEffectStage;
    const entries = stage && stage.entries;
    if (!entries || typeof entries[Symbol.iterator] !== 'function') return null;
    const out = [];
    for (const [objId, entry] of entries) {
      const mats = entry && entry.runner && entry.runner.materials;
      if (!mats || typeof mats.values !== 'function') continue;
      for (const m of mats.values()) {
        const us = m && m.uniforms;
        if (!us || typeof us !== 'object') continue;
        for (const name of Object.keys(us)) {
          const mm = /^g_Texture(\d+)Resolution$/.exec(name);
          if (!mm) continue;
          const slot = Number(mm[1]);
          const v = us[name] && us[name].value;
          const t = us['g_Texture' + slot];
          const img = t && t.value && t.value.image;
          const dim = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
          out.push({
            obj: objId, slot,
            x: v ? dim(v.x) : null, y: v ? dim(v.y) : null, z: v ? dim(v.z) : null, w: v ? dim(v.w) : null,
            texImage: img ? [dim(img.width), dim(img.height)] : null,
          });
        }
      }
    }
    return out;
  } catch { return null; } // 任何形状不符走这里：探针是只读旁路，绝不把异常抛进判定流程
};

console.log('[harness] ' + JSON.stringify({
  id, ok, err, broken: scriptRuntimeBroken,
  viewport: [VW, VH],
  canvasBuffer: [canvas.width, canvas.height],
  textObjectRect: window.__objectRect(778),
  playerCaught: !!window.__player,
}));
window.__ready = true;
