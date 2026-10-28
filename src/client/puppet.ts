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
      const last = Math.max(0, anim.frameCount - 1);
      const f = Math.min(Math.max(0, Math.floor(frame)), last);
      const next = Math.min(f + 1, last);
      const t = last === 0 ? 0 : Math.min(Math.max(0, frame - f), 1);
      for (const track of anim.tracks) {
        const bone = bones[track.boneId];
        // 越界 boneId / 空轨：跳过（本骨骼保持绑定姿态或上一帧值，绝不清零）。
        if (!bone || track.keys.length === 0) continue;
        const a = track.keys[Math.min(f, track.keys.length - 1)];
        const b = track.keys[Math.min(next, track.keys.length - 1)];
        bone.position.set(
          a.pos[0] + (b.pos[0] - a.pos[0]) * t,
          a.pos[1] + (b.pos[1] - a.pos[1]) * t,
          a.pos[2] + (b.pos[2] - a.pos[2]) * t,
        );
        _qa.set(a.rot[0], a.rot[1], a.rot[2], a.rot[3]);
        _qb.set(b.rot[0], b.rot[1], b.rot[2], b.rot[3]);
        bone.quaternion.copy(_qa).slerp(_qb, t);
        // MDLA 关键帧只存 scale.xy（z 恒 1，同 WE 的 2D 骨骼）。
        bone.scale.set(
          a.scale[0] + (b.scale[0] - a.scale[0]) * t,
          a.scale[1] + (b.scale[1] - a.scale[1]) * t,
          1,
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
