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

console.log('[harness] ' + JSON.stringify({
  id, ok, err, broken: scriptRuntimeBroken,
  viewport: [VW, VH],
  canvasBuffer: [canvas.width, canvas.height],
  textObjectRect: window.__objectRect(778),
  playerCaught: !!window.__player,
}));
window.__ready = true;
