// 脚本对「图层」的写入落在这里：纯数据、无 three 依赖 ⇒ 可 node 单测。
// 键 = scene.json 的对象 id（脚本用 thisScene.getLayerByID(id) 拿到的就是它）。

// 应用器需要 three 的类型，但本模块不在运行时 import three（上面部分保持纯数据、可 node 直测）。
import type * as THREE from 'three';

export interface LayerWrite {
  origin?: [number, number, number];
  angles?: [number, number, number];
  scale?: [number, number, number];
  alpha?: number;
  visible?: boolean;
  /** `layer.color` 的写入（92000 的粒子着色、94000 的按钮亮度渐变）。
   *  一期**只记录不应用**：隔离对象的颜色语义在对象 RT → 合成 quad 路径下与直接设材质色不等价，
   *  贸然应用会引入新的错误视觉；等有对照样本再定。 */
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

// `color` 故意**不参与**脏判定：一期只记录不应用（见 LayerWrite.color 注释），
// 若把它算作变化，每帧都会产生「脏但应用器不处理」的空转脏项。
function patchEq(a: LayerWrite, b: LayerWrite): boolean {
  return vecEq(a.origin, b.origin) && vecEq(a.angles, b.angles) && vecEq(a.scale, b.scale)
    && a.alpha === b.alpha && a.visible === b.visible;
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
    if (w.angles) obj.rotation.set(w.angles[0], w.angles[1], w.angles[2]);
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
