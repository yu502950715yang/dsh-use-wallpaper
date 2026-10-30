// 媒体集成 e2e harness：真实渲染场景壁纸，暴露媒体层可见性/像素/画布尺寸探针（只读）。
// 只 import `lib/client/*`（生产产物）；参考 harness-text-clock-entry.mjs 的 player 捕获方式。
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

/** 某对象材质 tint（colorBlendMode 6/7/31 的预乘 ShaderMaterial uniform）；无该 uniform → null。 */
window.__materialTint = (objectId) => {
  const p = window.__player;
  const o = p && p.displayObject(objectId);
  const t = o && o.material && o.material.uniforms && o.material.uniforms.tint && o.material.uniforms.tint.value;
  return t ? [t.x, t.y, t.z] : null;
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

/** 媒体层只读探针：可见性/不透明度 + 白块对象矩形（verify 的即时判据用）。 */
window.__mediaSnapshotNow = (ids = [35, 40, 45]) => {
  const p = window.__player;
  return {
    visible: ids.map((oid) => {
      const o = p && p.displayObject(oid);
      return o ? o.visible : null;
    }),
    opacity: ids.map((oid) => {
      const o = p && p.displayObject(oid);
      return o && o.material ? (o.material.opacity ?? null) : null;
    }),
    rect40: window.__objectRect(40),
  };
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

/** PNG 字节 → 画布区域内三通道 ≥250 的像素数（解码失败 → null）。 */
async function whitePixelsOf(png, box) {
  if (!png || png.length === 0) return null;
  const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0);
  const [x0, y0, x1, y1] = box;
  const sx = Math.max(0, Math.min(bmp.width - 1, x0));
  const sy = Math.max(0, Math.min(bmp.height - 1, y0));
  const ex = Math.max(0, Math.min(bmp.width - 1, x1));
  const ey = Math.max(0, Math.min(bmp.height - 1, y1));
  if (ex < sx || ey < sy) return 0;
  const { data } = ctx.getImageData(sx, sy, ex - sx + 1, ey - sy + 1);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] >= 250 && data[i + 1] >= 250 && data[i + 2] >= 250) n += 1;
  }
  return n;
}

// 首条 now-playing 请求延迟 600ms：确保「render resolve 后立即采样」早于任何轮询响应，
// 从而证明媒体层是装配期同步派发隐藏的，不是轮询回来才隐藏。只影响本 harness。
const rawFetch = window.fetch.bind(window);
let firstPollDelayed = false;
window.fetch = async (...args) => {
  const url = typeof args[0] === 'string' ? args[0] : String(args[0]?.url ?? '');
  if (!firstPollDelayed && url.includes('/wallpapers/now-playing?') && !url.includes('/thumbnail')) {
    firstPollDelayed = true;
    await new Promise((r) => setTimeout(r, 600));
  }
  return rawFetch(...args);
};

const renderer = createThreeSceneRenderer();
let ok = false, err = null;
try {
  ok = await renderer.render(id, canvas);
  window.__renderer = renderer;
} catch (e) { err = String((e && e.stack) || e); }

// render resolve 的同一微任务内先读可见性（同步），再抓一帧数白像素（下一帧，仍远早于轮询）。
const resolvedAt = performance.now();
const immediate = window.__mediaSnapshotNow();
let whitePixels = null;
let frameCaptured = false;
try {
  const png = await renderer.captureFrame();
  frameCaptured = !!png;
  if (png) whitePixels = await whitePixelsOf(png, immediate.rect40?.canvasCss ?? [1160, 280, 1260, 370]);
} catch (e) {
  window.__logs.push({ level: 'warn', text: '[harness] captureFrame 失败: ' + String(e) });
}
window.__mediaAtRenderResolve = {
  at: resolvedAt,
  visible: immediate.visible,
  opacity: immediate.opacity,
  rect: immediate.rect40 ? immediate.rect40.canvasCss : null,
  whitePixels,
  frameCaptured,
  firstPollDelayedMs: firstPollDelayed ? 600 : 0,
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(1200); // 让帧循环与轮询跑起来（媒体初始派发已在装配期落地）

// [perf] 帧率探针：统计 ms 毫秒内真实 rAF 回调次数（壁纸帧循环就是 rAF 驱动的）
window.__fpsProbe = (ms = 3000) => new Promise((resolve) => {
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

// [perf] 只读：真实 GPU 渲染器字符串（SwiftShader/软件光栅化的数字无意义，用它自证）。
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

console.log('[harness] ' + JSON.stringify({
  id, ok, err,
  viewport: [VW, VH],
  canvasBuffer: [canvas.width, canvas.height],
  playerCaught: !!window.__player,
  mediaWhiteBoxRect: window.__objectRect(40),
  mediaAtRenderResolve: window.__mediaAtRenderResolve,
}));
window.__ready = true;
