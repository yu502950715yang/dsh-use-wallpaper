// WE 场景树（parent）的世界变换累积。
//
// 子对象变换相对父节点：scale 逐分量相乘（OME `cwiseProduct`），origin 经**父的世界旋转 ×
// 父的世界 scale** 后叠加到父的世界 origin，angles 用旋转矩阵累积后按 R = Rz·Ry·Rx 分解
// （同轴父链精确，多轴为近似，见 spec §3.2）。无 parent / 悬空引用 / 环 / 超深 → 逐字段返回局部值。
import * as THREE from 'three';

export interface SceneGraphNode {
  id: number;
  parent?: number;
  // 真实 scene.json 里子对象的 origin/scale 常缺失（3798688689 实测 158/278 个）→ 可选
  origin?: [number, number, number];
  scale?: [number, number, number];
  angles?: [number, number, number];
}

export interface WorldTransform {
  origin: [number, number, number];
  scale: [number, number, number];
  angles: [number, number, number];
}

// 防御畸形数据：深度上限（正常场景最深 11 层，远低于此）
const MAX_DEPTH = 64;

const LOCAL_ZERO: [number, number, number] = [0, 0, 0];
const LOCAL_ONE: [number, number, number] = [1, 1, 1];

// WE 场景系旋转序（AGENT.md §5.14：R = Rz·Ry·Rx）。
const ANGLE_ORDER = 'ZYX' as const;

const outEuler = /* @__PURE__ */ new THREE.Euler();
const worldRotation = /* @__PURE__ */ new THREE.Matrix4();

// 欧拉角（Rz·Ry·Rx）→ 旋转矩阵。每次新建，避免共享实例被父子两次调用互相覆盖。
function rotationMatrix(angles: [number, number, number]): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(angles[0], angles[1], angles[2], ANGLE_ORDER),
  );
}

export function resolveWorldTransforms(nodes: SceneGraphNode[]): Map<number, WorldTransform> {
  const byId = new Map<number, SceneGraphNode>();
  for (const n of nodes) byId.set(n.id, n);
  const out = new Map<number, WorldTransform>();
  const visiting = new Set<number>();

  const local = (n: SceneGraphNode): WorldTransform => ({
    origin: [...(n.origin ?? LOCAL_ZERO)],
    scale: [...(n.scale ?? LOCAL_ONE)],
    angles: [...(n.angles ?? LOCAL_ZERO)],
  });

  const resolve = (n: SceneGraphNode, depth: number): WorldTransform => {
    const cached = out.get(n.id);
    if (cached) return cached;
    const self = local(n);
    const parent = n.parent !== undefined ? byId.get(n.parent) : undefined;
    // 无父 / 悬空引用 / 环 / 超深 → 退化为局部值（保证「无 parent 逐字段相等」）
    if (!parent || depth >= MAX_DEPTH || visiting.has(n.id)) {
      out.set(n.id, self);
      return self;
    }
    visiting.add(n.id);
    const pw = resolve(parent, depth + 1);
    visiting.delete(n.id);
    // origin：父的世界 scale ⊙ 子 origin，经父的世界旋转后叠加到父的世界 origin
    const offset = new THREE.Vector3(
      self.origin[0] * pw.scale[0],
      self.origin[1] * pw.scale[1],
      self.origin[2] * pw.scale[2],
    ).applyMatrix4(rotationMatrix(pw.angles));
    // 父链全无旋转时退回逐分量相加：与矩阵累积逐位一致，且避免无谓的浮点噪声。
    let angles: [number, number, number] = [0, 0, 0];
    if (!pw.angles.every((a) => a === 0) || !self.angles.every((a) => a === 0)) {
      worldRotation.multiplyMatrices(rotationMatrix(pw.angles), rotationMatrix(self.angles));
      outEuler.setFromRotationMatrix(worldRotation, ANGLE_ORDER);
      angles = [outEuler.x, outEuler.y, outEuler.z];
    }
    const world: WorldTransform = {
      origin: [pw.origin[0] + offset.x, pw.origin[1] + offset.y, pw.origin[2] + offset.z],
      scale: [pw.scale[0] * self.scale[0], pw.scale[1] * self.scale[1], pw.scale[2] * self.scale[2]],
      angles,
    };
    out.set(n.id, world);
    return world;
  };

  for (const n of nodes) resolve(n, 0);
  return out;
}
