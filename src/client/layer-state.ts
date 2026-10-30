// 脚本对「图层」的写入落在这里：纯数据、无 three 依赖 ⇒ 可 node 单测。
// 键 = scene.json 的对象 id（脚本用 thisScene.getLayerByID(id) 拿到的就是它）。

// 应用器需要 three 的类型，但本模块不在运行时 import three（上面部分保持纯数据、可 node 直测）。
import type * as THREE from 'three';

export interface LayerWrite {
  origin?: [number, number, number];
  /** 脚本写入的角度（**度**，WE SceneScript 的 angles 单位；applyLayerState 落 three 时转弧度）。 */
  angles?: [number, number, number];
  scale?: [number, number, number];
  alpha?: number;
  visible?: boolean;
  /** `layer.color` 的写入（92000 的粒子着色、94000 的按钮亮度渐变、媒体边框主色）。
   *  脚本 Vec3：max 分量 ≤ 1 视为 0-1（WE MediaThumbnailEvent 颜色），否则按 0-255；落点见 writeColor。 */
  color?: [number, number, number];
}

export interface LayerStateTable {
  write(objectId: number, patch: LayerWrite): void;
  read(objectId: number): LayerWrite;
  takeDirty(): Map<number, LayerWrite>;
  size(): number;
}

function vecEq(a: [number, number, number] | undefined, b: [number, number, number] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

// `color` 参与脏判定：Task 8 起会被真正应用到材质（只写同值仍不置脏）。
function patchEq(a: LayerWrite, b: LayerWrite): boolean {
  return vecEq(a.origin, b.origin) && vecEq(a.angles, b.angles) && vecEq(a.scale, b.scale)
    && vecEq(a.color, b.color) && a.alpha === b.alpha && a.visible === b.visible;
}

export function createLayerStateTable(): LayerStateTable {
  const state = new Map<number, LayerWrite>();
  const dirty = new Map<number, LayerWrite>();
  return {
    write(objectId: number, patch: LayerWrite): void {
      const cur = state.get(objectId) ?? {};
      const next: LayerWrite = { ...cur, ...patch };
      state.set(objectId, next);
      // 写同值不置脏：脚本每帧无条件写同一值，脏项会变成每帧全量应用。
      if (!patchEq(cur, next)) dirty.set(objectId, { ...dirty.get(objectId), ...patch });
    },
    read(objectId: number): LayerWrite {
      return { ...(state.get(objectId) ?? {}) };
    },
    takeDirty(): Map<number, LayerWrite> {
      const out = new Map(dirty);
      dirty.clear();
      return out;
    },
    size(): number {
      return state.size;
    },
  };
}

/** 应用器要写到哪个对象上：three 的最终显示对象 + 场景固有尺寸（we_to_three 的基准）。 */
export interface DisplayTarget {
  object: THREE.Object3D;
  sceneW: number;
  sceneH: number;
}

/** alpha 折算下限：低于它视为不可见（spec §6.1 的 alpha≈0 折算）。 */
const ALPHA_EPSILON = 0.002;

/** WE SceneScript 的 angles 是度（官方 snippet：`%1*360` / `WEMath.rad2deg`）；three 用弧度。 */
const DEG2RAD = Math.PI / 180;

/** 尽力把 alpha 写到材质上：Mesh*Material 的 opacity、ShaderMaterial 的 uniforms.opacity.value。 */
function writeOpacity(object: THREE.Object3D, alpha: number): void {
  const mat = (object as { material?: unknown }).material;
  const list = Array.isArray(mat) ? mat : mat ? [mat] : [];
  for (const m of list) {
    const anyMat = m as { opacity?: unknown; uniforms?: Record<string, { value?: unknown }> };
    if (typeof anyMat.opacity === 'number') anyMat.opacity = alpha;
    const u = anyMat.uniforms?.['opacity'];
    if (u && typeof u.value === 'number') u.value = alpha;
  }
}

/** 脚本 color 的两种语义：max 分量 ≤ 1 = 0-1（WE MediaThumbnailEvent 颜色），否则 0-255。 */
function scriptColor01(c: [number, number, number]): [number, number, number] {
  const scale = Math.max(c[0], c[1], c[2]) > 1 ? 1 / 255 : 1;
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, Number.isFinite(v) ? v * scale : 0));
  return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
}

/** 把脚本 color 写到材质：ShaderMaterial 的 tint uniform 优先（colorBlendMode 6/7/31 的预乘材质），
 *  否则写到 MeshBasicMaterial.color（脚本 color 覆盖对象 color，再乘装配期记录的 brightness）。 */
function writeColor(object: THREE.Object3D, rgb: [number, number, number]): void {
  const mat = (object as { material?: unknown }).material;
  const list = Array.isArray(mat) ? mat : mat ? [mat] : [];
  const rawBrightness = (object as { userData?: { weBrightness?: unknown } }).userData?.weBrightness;
  const brightness = typeof rawBrightness === 'number' && Number.isFinite(rawBrightness) ? rawBrightness : 1;
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v * brightness));
  for (const m of list) {
    const anyMat = m as {
      color?: { setRGB(r: number, g: number, b: number): void };
      uniforms?: Record<string, { value?: unknown }>;
    };
    // tint 路径：脚本 color 直接覆盖 tint（brightness 已在装配期乘进 tint 初值，本任务不保留）。
    const tint = anyMat.uniforms?.['tint']?.value as { set?: (r: number, g: number, b: number) => void } | undefined;
    if (tint && typeof tint.set === 'function') {
      tint.set(rgb[0], rgb[1], rgb[2]);
      continue;
    }
    if (anyMat.color && typeof anyMat.color.setRGB === 'function') {
      anyMat.color.setRGB(clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2]));
    }
  }
}

/** 把脏写入应用到 three 对象。返回实际应用的对象数（lookup 未命中的跳过 —— util / 未渲染对象只记账）。
 *
 *  ⚠️ visible=false 或 alpha≈0 走 three 的 `Object3D.visible` —— 这是**对象级隐藏**，**不动**引擎既有
 *  的 scene.json visible 过滤（那会影响其他 28 张壁纸的画面，见 spec §6.1 的零回归决策）。 */
export function applyLayerState(
  dirty: Map<number, LayerWrite>,
  lookup: (objectId: number) => DisplayTarget | undefined,
): number {
  let applied = 0;
  for (const [objectId, w] of dirty) {
    const target = lookup(objectId);
    if (!target) continue;
    const obj = target.object;
    // we_to_three：origin - scene/2（y 不翻，见 AGENT.md §2.3）。
    if (w.origin) obj.position.set(w.origin[0] - target.sceneW / 2, w.origin[1] - target.sceneH / 2, w.origin[2]);
    if (w.scale) obj.scale.set(w.scale[0], w.scale[1], w.scale[2]);
    if (w.angles) obj.rotation.set(w.angles[0] * DEG2RAD, w.angles[1] * DEG2RAD, w.angles[2] * DEG2RAD);
    if (w.color) writeColor(obj, scriptColor01(w.color));
    const alpha = w.alpha;
    if (alpha !== undefined) {
      const a = Math.max(0, Math.min(1, alpha));
      writeOpacity(obj, a);
      obj.visible = a > ALPHA_EPSILON;
    }
    // 同一 patch 里同时给了 alpha 与 visible 时，alpha 的可见性判定优先（二者语义一致）。
    if (w.visible === false) obj.visible = false;
    else if (w.visible === true && alpha === undefined) obj.visible = true;
    applied++;
  }
  return applied;
}
