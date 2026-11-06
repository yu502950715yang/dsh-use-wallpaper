// MdlPuppet → three：骨骼层级 + 蒙皮网格 + 关键帧采样。蒙皮矩阵交给 three：bind() 时按**绑定姿态**算
// boneInverses，逐帧 = 世界(动画) · 世界(绑定)⁻¹（正合 WE 语义）；材质必须是内建材质才会注入蒙皮 shader。
import * as THREE from 'three';
import type { MdlAnimation, MdlPuppet } from './mdl-parser.js';
// v 约定翻转的唯一实现（WE 的 UV 是 v=0=图像顶部，见 AGENT.md §5.20，不另写一份公式）。
import { flipGeometryUvY } from './object-range.js';

export interface PuppetInstance {
  // 有蒙皮数据且骨表非空 = SkinnedMesh；否则普通 Mesh（本机唯一 .mdl 样本走的就是后者）。
  mesh: THREE.Mesh | THREE.SkinnedMesh;
  bones: THREE.Bone[];
  skeleton: THREE.Skeleton | null;
  animations: MdlAnimation[];
  /** 采样某动画的某一帧（帧号可为小数 = 帧内插值；越界夹到 [0, frameCount-1]）。 */
  applyFrame(anim: MdlAnimation, frame: number): void;
  dispose(): void;
}

// 采样用的临时四元数（逐轨道逐帧新建会成为每帧 GC 压力）。
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qx = new THREE.Quaternion();
const _qy = new THREE.Quaternion();
const _qz = new THREE.Quaternion();
const _axisX = new THREE.Vector3(1, 0, 0);
const _axisY = new THREE.Vector3(0, 1, 0);
const _axisZ = new THREE.Vector3(0, 0, 1);

/** MDLA 关键帧的欧拉角（弧度）→ 四元数：WE 的组合顺序是 Rz·Ry·Rx（= three 的 Euler order 'ZYX'）。 */
export function keyframeQuaternion(out: THREE.Quaternion, angle: readonly [number, number, number]): THREE.Quaternion {
  _qx.setFromAxisAngle(_axisX, angle[0]);
  _qy.setFromAxisAngle(_axisY, angle[1]);
  _qz.setFromAxisAngle(_axisZ, angle[2]);
  return out.copy(_qz).multiply(_qy).multiply(_qx);
}

/** MDLS 绑定矩阵（列主序局部矩阵）→ 骨骼本地变换；bind() 的 boneInverses 据此计算。 */
function decomposeBind(bone: THREE.Bone, bind: Float32Array): void {
  new THREE.Matrix4().fromArray(bind).decompose(bone.position, bone.quaternion, bone.scale);
}

// puppet 材质：three 内建材质 + 普通 alpha 混合；`colorBlendMode`（含 ≠ 0）**不复刻** —— 复刻要预乘
// ShaderMaterial，那会让「内建材质才自动注入蒙皮 shader」这条前提失效。参数只为把该决定钉在调用点。
export function createPuppetMaterial(map: THREE.Texture | null, _colorBlendMode?: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ map, transparent: true, side: THREE.DoubleSide, depthWrite: false });
}

export function createPuppetMesh(puppet: MdlPuppet, material: THREE.Material): PuppetInstance {
  const { mesh: data, bones: boneDefs, animations } = puppet;
  const vertexCount = data.vertexCount > 0 ? data.vertexCount : Math.floor(data.positions.length / 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  // uv 缺失/长度不符（畸形 puppet）⇒ 补零；长度符合则**拷贝** —— 下面的翻 v 是就地改写，
  // 直接塞入参会把同一个 MdlPuppet 二次建网格时翻回去（T8 复用同一实例）。
  const uvs = data.uvs.length === vertexCount * 2 ? new Float32Array(data.uvs) : new Float32Array(vertexCount * 2);
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  // MDL 的 UV 是 WE 约定（v=0=图像顶部），而 `.tex` 按显示约定（行序已翻）加载 ⇒ 翻 v 才是正立画面。
  flipGeometryUvY(geometry);
  const skinned = Boolean(data.blendIndices && data.blendWeights);
  if (skinned) {
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(data.blendIndices as Uint16Array, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(data.blendWeights as Float32Array, 4));
  }
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));

  // 骨骼树：先建全部再挂（父索引可能大于子索引）；父索引无效的按根处理，避免建树成环。
  const bones = boneDefs.map(() => new THREE.Bone());
  const roots: THREE.Bone[] = [];
  boneDefs.forEach((def, i) => {
    decomposeBind(bones[i], def.bind);
    if (def.parent >= 0 && def.parent < bones.length && def.parent !== i) bones[def.parent].add(bones[i]);
    else roots.push(bones[i]);
  });

  // 蒙皮绑定姿势 = **主动画（animations[0]）第 0 帧**，不是 MDLS 局部矩阵链。
  // 顶点是按动画起播姿势烘焙的：用 MDLS 当 bind 时，frame0 蒙皮矩阵 ≠ 单位，人物整体带着一个
  // 固定错位（假人实测：黑武者帽檐/刀鞘偏 20°+），播放起来就像「运动方向不对」。真实素材
  // 3828798871 与 WE 独立窗口逐帧对拍确认见 AGENT.md §7.40；MDLS 只兜底无动画 / 无作者姿态轨。
  const bindAnim = animations.length > 0 ? animations[0] : null;
  if (bindAnim) {
    for (const track of bindAnim.tracks) {
      const bone = bones[track.boneId];
      if (!bone || !track.authored || track.keys.length === 0) continue;
      const k = track.keys[0];
      bone.position.set(k.pos[0], k.pos[1], k.pos[2]);
      keyframeQuaternion(bone.quaternion, k.angle);
      bone.scale.set(k.scale[0], k.scale[1], k.scale[2]);
    }
  }

  let mesh: THREE.Mesh | THREE.SkinnedMesh;
  let skeleton: THREE.Skeleton | null = null;
  if (skinned && bones.length > 0) {
    const sm = new THREE.SkinnedMesh(geometry, material);
    // 骨骼必须在被渲染的场景图里（游离骨的 matrixWorld 不更新 = 蒙皮用陈旧矩阵）；多根骨全部挂上。
    for (const root of roots) sm.add(root);
    // 此刻 mesh 自身矩阵 = 单位 ⇒ Skeleton 的 boneInverses 正是绑定姿态的逆。
    sm.updateMatrixWorld(true);
    skeleton = new THREE.Skeleton(bones);
    sm.bind(skeleton);
    mesh = sm;
  } else {
    mesh = new THREE.Mesh(geometry, material);
  }

  return {
    mesh,
    bones,
    skeleton,
    animations,
    applyFrame(anim: MdlAnimation, frame: number): void {
      // 帧索引口径对齐 WE（webwallgl mdl-skin.js frameIndices / 参考引擎 genInterpolationInfo）：
      // loop 按**区间数**环绕（关键帧数 - 1 = 动画长度；末帧与首帧重合），
      // mirror 正播到头再倒播，其余模式 clamp 到 [0, n-1]。
      for (const track of anim.tracks) {
        const bone = bones[track.boneId];
        // 越界 boneId / 空轨 / 无作者姿态的轨：跳过（本骨骼保持绑定姿态或上一帧值，绝不清零）。
        if (!bone || track.keys.length === 0 || !track.authored) continue;
        const n = track.keys.length;
        const span = Math.max(1, n - 1);
        let pos: number;
        if (anim.mode === 'loop') pos = ((frame % span) + span) % span;
        else if (anim.mode === 'mirror') {
          const period = span * 2;
          let w = ((frame % period) + period) % period;
          if (w > span) w = period - w;
          pos = w;
        } else pos = Math.min(Math.max(frame, 0), span);
        const f = Math.min(Math.floor(pos), n - 1);
        const next = Math.min(f + 1, n - 1);
        const t = Math.min(Math.max(pos - f, 0), 1);
        const a = track.keys[f];
        const b = track.keys[next];
        bone.position.set(
          a.pos[0] + (b.pos[0] - a.pos[0]) * t,
          a.pos[1] + (b.pos[1] - a.pos[1]) * t,
          a.pos[2] + (b.pos[2] - a.pos[2]) * t,
        );
        keyframeQuaternion(_qa, a.angle);
        keyframeQuaternion(_qb, b.angle);
        bone.quaternion.copy(_qa).slerp(_qb, t);
        bone.scale.set(
          a.scale[0] + (b.scale[0] - a.scale[0]) * t,
          a.scale[1] + (b.scale[1] - a.scale[1]) * t,
          a.scale[2] + (b.scale[2] - a.scale[2]) * t,
        );
      }
    },
    dispose(): void {
      geometry.dispose();
      skeleton?.dispose();
      material.dispose();
    },
  };
}
