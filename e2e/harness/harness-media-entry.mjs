// 媒体集成端到端 harness 入口（白框修复验收）：渲染真实场景壁纸，暴露对象矩形/材质/可见性。
//
// ⚠️ 只 import `lib/client/*`（`npm run build` 的生产产物），不 import `src/`：
// 由 e2e/verify/verify-media-layer.mjs 用 esbuild 打包成自包含 bundle，headless Edge 打开。
// 走生产的 `createThreeSceneRenderer().render(id, canvas)` 入口（与线上逐字相同）。
import * as THREE from 'three';
import { createThreeSceneRenderer } from '../../lib/client/three-renderer.js';
import { ThreeScenePlayer } from '../../lib/client/threejs-player.js';

const q = new URLSearchParams(location.search);
const id = q.get('id') ?? '3797976859';
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

// 抓生产 player 实例（补丁打在**类方法**上；renderer 内部 new ThreeScenePlayer 与本文件 import
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

const renderer = createThreeSceneRenderer();
let ok = false, err = null;
try {
  ok = await renderer.render(id, canvas);
  window.__renderer = renderer;
} catch (e) { err = String((e && e.stack) || e); }

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
    worldSize: [w, h],
    worldPos: [o.position.x, o.position.y, o.position.z],
    textureImage: img ? [img.width, img.height] : null,
    visible: o.visible,
  };
};

/** dump 某个 scene 对象显示对象的材质参数（文本层判据看 mapSize）。 */
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
    color: m.color ? [m.color.r, m.color.g, m.color.b] : null,
    mapSize: m.map?.image ? [m.map.image.width, m.map.image.height] : null,
    renderOrder: o.renderOrder ?? null,
    visible: o.visible,
    position: [o.position.x, o.position.y, o.position.z],
    scale: [o.scale.x, o.scale.y, o.scale.z],
  };
};

/** 列出所有已登记显示对象 id 与基础信息（诊断）。 */
window.__listObjects = () => {
  const p = window.__player;
  if (!p) return null;
  const ids = [];
  if (p.displayObjects && typeof p.displayObjects.keys === 'function') ids.push(...p.displayObjects.keys());
  return ids.map((oid) => {
    const rect = window.__objectRect(oid);
    const o = p.displayObject(oid);
    return {
      id: oid,
      rect: rect ? rect.canvasCss : null,
      worldSize: rect ? rect.worldSize : null,
      visible: o ? o.visible : null,
      type: o ? (o.type ?? null) : null,
      material: o && o.material ? (o.material.type ?? null) : null,
      mapSize: rect ? rect.textureImage : null,
    };
  });
};

/** 设置某对象显示/隐藏（不重渲染，直接切 three 对象；诊断用）。 */
window.__hideObject = (objectId, hidden) => {
  const p = window.__player;
  const o = p && p.displayObject(objectId);
  if (!o) return null;
  const prev = o.visible;
  o.visible = !hidden;
  return { objectId, prevVisible: prev, visible: o.visible };
};

/** 媒体层诊断：可见性/父链/是否仍在场景/纹理尺寸（判据失败时定位用）。 */
window.__probeMedia = (ids = [35, 38, 39, 40, 45]) => {
  const p = window.__player;
  if (!p) return null;
  return ids.map((objectId) => {
    const o = p.displayObject(objectId);
    return {
      objectId,
      found: !!o,
      visible: o ? o.visible : null,
      parentVisible: o && o.parent ? o.parent.visible : null,
      inScene: o ? !!o.parent : false,
      mapSize: o && o.material && o.material.map && o.material.map.image
        ? [o.material.map.image.width, o.material.map.image.height] : null,
      opacity: o && o.material ? (o.material.opacity ?? null) : null,
    };
  });
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(1200); // 让帧循环跑几帧（媒体初始派发已在装配期落地）

console.log('[harness] ' + JSON.stringify({
  id, ok, err,
  viewport: [VW, VH],
  canvasBuffer: [canvas.width, canvas.height],
  playerCaught: !!window.__player,
  mediaWhiteBoxRect: window.__objectRect(40),
}));
window.__ready = true;
