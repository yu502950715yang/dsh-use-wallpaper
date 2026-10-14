// @vitest-environment jsdom
// Task 7：MdlPuppet → three 网格/蒙皮。本机唯一 .mdl 样本是**静态族**（无 MDLS/MDLA）⇒ 蒙皮与动画
// 路径全部由本文件的合成夹具覆盖，静态路径（blendIndices=null）才是本机可验的真实路径。
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createPuppetMaterial, createPuppetMesh } from '../src/client/puppet.js';
import type { MdlAnimation, MdlPuppet } from '../src/client/mdl-parser.js';

/** MDLS 的绑定矩阵是**列主序**局部矩阵，平移落在 [12..14]。 */
function bindAt(tx: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, 0, 0, 1]);
}

const idle: MdlAnimation = {
  id: 7, name: 'idle', mode: 'loop', fps: 30, frameCount: 2,
  tracks: [{
    boneId: 1,
    keys: [
      { pos: [5, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1] },
      { pos: [9, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1] },
    ],
  }],
};

/** 3 顶点三角：v0 绑骨 0、v1/v2 绑骨 1（权重全给第 0 槽）。 */
function makePuppet(over: Partial<MdlPuppet> = {}): MdlPuppet {
  return {
    version: 'MDLV0021',
    mesh: {
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
      blendIndices: new Uint16Array([0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1]),
      blendWeights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
      indices: new Uint16Array([0, 1, 2]),
      vertexCount: 3,
      materialPath: 'materials/m.json',
    },
    bones: [
      { index: 0, parent: -1, bind: bindAt(0) },
      { index: 1, parent: 0, bind: bindAt(5) },
    ],
    animations: [idle],
    segments: { mdls: 'ok', mdla: 'ok' },
    boneIdMapping: 'identity',
    ...over,
  };
}

function material(): THREE.Material {
  return new THREE.MeshBasicMaterial();
}

/** 骨骼矩阵（= 世界(动画) · 世界(绑定)⁻¹）的第 12 个元素（列主序平移 x）。 */
function boneMatrixX(skeleton: THREE.Skeleton, i: number): number {
  return skeleton.boneMatrices[i * 16 + 12];
}

describe('puppet → three 网格/蒙皮', () => {
  it('骨骼层级按 parent 建树，根骨挂在 mesh 下', () => {
    const p = createPuppetMesh(makePuppet(), material());
    expect(p.bones).toHaveLength(2);
    expect(p.bones[1].parent).toBe(p.bones[0]);
    expect(p.mesh.isSkinnedMesh).toBe(true);
    expect(p.skeleton!.bones).toHaveLength(2);
    expect(p.mesh.children).toContain(p.bones[0]);
  });

  it('几何属性名必须是 three 内建 skinIndex/skinWeight（自定义名会被静默忽略）', () => {
    const p = createPuppetMesh(makePuppet(), material());
    const g = p.mesh.geometry;
    expect(g.getAttribute('position')).toBeTruthy();
    expect(g.getAttribute('uv')).toBeTruthy();
    expect(g.getAttribute('skinIndex')).toBeTruthy();
    expect(g.getAttribute('skinWeight')).toBeTruthy();
    // 顶点 v1、v2 绑骨 1（第 2 个分量 = 顶点 1 的第 0 槽）
    expect((g.getAttribute('skinIndex') as THREE.BufferAttribute).getComponent(1, 0)).toBe(1);
    expect((g.getAttribute('skinWeight') as THREE.BufferAttribute).getComponent(1, 0)).toBe(1);
    expect(g.getIndex()!.count).toBe(3);
  });

  it('UV 翻 v：MDL 是 WE 约定（v=0=图像顶部），.tex 按显示约定加载', () => {
    const p = createPuppetMesh(makePuppet(), material());
    const uv = p.mesh.geometry.getAttribute('uv') as THREE.BufferAttribute;
    // 夹具 uv = [0,0, 1,0, 0,1] ⇒ 翻转后 v → 1−v
    expect([...uv.array]).toEqual([0, 1, 1, 1, 0, 0]);
  });

  it('boneInverses = 绑定姿态的逆（不能按动画后的世界矩阵现算）', () => {
    const p = createPuppetMesh(makePuppet(), material());
    // 绑定姿态：骨 0 世界 T(0)、骨 1 世界 T(0)·T(5) ⇒ 逆矩阵平移 -5
    expect(p.skeleton!.boneInverses[0].elements[12]).toBeCloseTo(0, 6);
    expect(p.skeleton!.boneInverses[1].elements[12]).toBeCloseTo(-5, 6);
  });

  it('applyFrame 采样关键帧并写回骨骼本地变换，蒙皮矩阵 = 动画位移 − 绑定位移', () => {
    const p = createPuppetMesh(makePuppet(), material());
    p.applyFrame(p.animations[0], 0);
    expect(p.bones[1].position.x).toBeCloseTo(5, 5);
    p.mesh.updateMatrixWorld(true);
    p.skeleton!.update();
    expect(boneMatrixX(p.skeleton!, 1)).toBeCloseTo(0, 5);   // 世界(帧 0)=T(5) ⇒ 5 − 5
    p.applyFrame(p.animations[0], 1);
    expect(p.bones[1].position.x).toBeCloseTo(9, 5);
    p.mesh.updateMatrixWorld(true);
    p.skeleton!.update();
    expect(boneMatrixX(p.skeleton!, 1)).toBeCloseTo(4, 5);   // 世界(帧 1)=T(9) ⇒ 9 − 5
  });

  it('没有轨道的骨骼保持绑定姿态（帧间不得被清成 0）', () => {
    // 骨 0 绑定平移 3 且无轨道：帧间被清成 0 会被这条抓住
    const p = createPuppetMesh(makePuppet({
      bones: [
        { index: 0, parent: -1, bind: bindAt(3) },
        { index: 1, parent: 0, bind: bindAt(5) },
      ],
    }), material());
    p.applyFrame(p.animations[0], 1);
    expect(p.bones[0].position.x).toBeCloseTo(3, 5);
    p.mesh.updateMatrixWorld(true);
    p.skeleton!.update();
    expect(boneMatrixX(p.skeleton!, 0)).toBeCloseTo(0, 5);   // 绑定姿态 ⇒ 恒等
  });

  it('applyFrame 越界帧号被夹到合法区间（不产生 NaN 骨骼，且落在首/末帧）', () => {
    const p = createPuppetMesh(makePuppet(), material());
    p.applyFrame(p.animations[0], 99);
    expect(Number.isFinite(p.bones[1].position.x)).toBe(true);
    expect(p.bones[1].position.x).toBeCloseTo(9, 5);
    p.applyFrame(p.animations[0], -1);
    expect(Number.isFinite(p.bones[1].position.x)).toBe(true);
    expect(p.bones[1].position.x).toBeCloseTo(5, 5);
  });

  it('applyFrame 帧号可取小数（帧内插值）', () => {
    const p = createPuppetMesh(makePuppet(), material());
    p.applyFrame(p.animations[0], 0.5);
    expect(p.bones[1].position.x).toBeCloseTo(7, 5);
  });

  // T8：player 逐帧喂进来的是 (elapsed × fps) % frameCount（循环播）。本用例钉住「回绕结果恒落在
  // [0, frameCount)」这条不变量，以及它取到的关键帧真的对得上（不是越界夹取掩盖了公式错误）。
  it('(elapsed×fps)%frameCount 回绕恒落在 [0, frameCount) 且取到对应关键帧', () => {
    const walk: MdlAnimation = {
      id: 3, name: 'walk', mode: 'loop', fps: 10, frameCount: 3,
      tracks: [{
        boneId: 1,
        keys: [
          { pos: [5, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1] },
          { pos: [9, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1] },
          { pos: [13, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1] },
        ],
      }],
    };
    const p = createPuppetMesh(makePuppet({ animations: [walk] }), material());
    const frameAt = (elapsed: number) => (elapsed * walk.fps) % walk.frameCount;
    for (let t = 0; t < 1.2; t += 0.01) {
      expect(frameAt(t)).toBeGreaterThanOrEqual(0);
      expect(frameAt(t)).toBeLessThan(walk.frameCount);
    }
    p.applyFrame(walk, frameAt(0));     // 帧 0
    expect(p.bones[1].position.x).toBeCloseTo(5, 5);
    p.applyFrame(walk, frameAt(0.2));   // 帧 2（末帧）
    expect(p.bones[1].position.x).toBeCloseTo(13, 5);
    p.applyFrame(walk, frameAt(0.3));   // 3 帧 % 3 = 0 ⇒ 回绕回首帧
    expect(p.bones[1].position.x).toBeCloseTo(5, 5);
    p.applyFrame(walk, frameAt(0.45));  // 4.5 帧 % 3 = 1.5 ⇒ 帧 1 与帧 2 之间
    expect(p.bones[1].position.x).toBeCloseTo(11, 5);
  });

  it('轨 boneId 越界 / 空轨 / 未知动画不影响其他骨骼（不抛、不写坏）', () => {
    const p = createPuppetMesh(makePuppet(), material());
    p.applyFrame({
      id: 1, name: 'x', mode: 'loop', fps: 30, frameCount: 1,
      tracks: [{ boneId: 99, keys: [{ pos: [1, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1] }] }, { boneId: 0, keys: [] }],
    }, 0);
    expect(p.bones[0].position.x).toBeCloseTo(0, 5);
    expect(p.bones[1].position.x).toBeCloseTo(5, 5);
  });

  it('无骨骼权重（blendIndices=null）时退化为静态网格但仍可渲染', () => {
    const p = createPuppetMesh(makePuppet({
      mesh: { ...makePuppet().mesh, blendIndices: null, blendWeights: null },
    }), material());
    expect(p.mesh.isSkinnedMesh ?? false).toBe(false);
    expect(p.skeleton).toBeNull();
    expect(p.mesh.geometry.getAttribute('position')).toBeTruthy();
    expect(p.mesh.geometry.getAttribute('uv')).toBeTruthy();
    expect(p.mesh.geometry.getAttribute('skinIndex')).toBeUndefined(); // three 的 getAttribute 未命中返回 undefined
    // 静态网格不挂骨（骨骼没意义），但动画表原样带出（供诊断/T8）
    expect(p.mesh.children).toHaveLength(0);
    expect(p.animations).toHaveLength(1);
  });

  it('有蒙皮数据但骨表为空（MDLS 解析失败）⇒ 退化普通网格，不抛', () => {
    const p = createPuppetMesh(makePuppet({ bones: [] }), material());
    expect(p.mesh.isSkinnedMesh ?? false).toBe(false);
    expect(p.mesh.geometry.getAttribute('position')).toBeTruthy();
  });

  it('uv 缺失/长度不符 ⇒ 补零 uv（材质仍拿得到 uv 属性，不读越界）', () => {
    const p = createPuppetMesh(makePuppet({
      mesh: { ...makePuppet().mesh, uvs: new Float32Array(0) },
    }), material());
    const uv = p.mesh.geometry.getAttribute('uv') as THREE.BufferAttribute;
    expect(uv.count).toBe(3);
    // 补零后再翻 v ⇒ 全部采样图像顶端（无 UV 的模型当作纯色/单点纹理看待，不炸就行）
    expect([...uv.array]).toEqual([0, 1, 0, 1, 0, 1]);
  });

  // uv 翻转是就地改写：不拷贝入参的话，同一个 MdlPuppet 二次建网格会被翻回去（T8 复用同一实例时会踩）。
  it('不改写入参：同一 MdlPuppet 二次建网格得到同一份 uv', () => {
    const puppet = makePuppet();
    const before = [...puppet.mesh.uvs];
    const first = createPuppetMesh(puppet, material());
    const uvFirst = [...(first.mesh.geometry.getAttribute('uv').array as Float32Array)];
    expect([...puppet.mesh.uvs]).toEqual(before); // 入参未被改写
    const second = createPuppetMesh(puppet, material());
    const uvSecond = [...(second.mesh.geometry.getAttribute('uv').array as Float32Array)];
    expect(uvSecond).toEqual(uvFirst);            // 二次建网格不二次翻转
  });

  it('多根骨骼（父索引全 -1）全部挂进 mesh，否则游离骨的 matrixWorld 不更新', () => {
    const p = createPuppetMesh(makePuppet({
      bones: [
        { index: 0, parent: -1, bind: bindAt(0) },
        { index: 1, parent: -1, bind: bindAt(2) },
      ],
    }), material());
    expect(p.mesh.children).toContain(p.bones[0]);
    expect(p.mesh.children).toContain(p.bones[1]);
  });

  it('dispose 释放 geometry/material/skeleton', () => {
    const p = createPuppetMesh(makePuppet(), material());
    const seen: string[] = [];
    p.mesh.geometry.addEventListener('dispose', () => seen.push('geometry'));
    (p.mesh.material as THREE.Material).addEventListener('dispose', () => seen.push('material'));
    p.dispose();
    expect(seen).toEqual(['geometry', 'material']);
  });
});

describe('puppet 材质：内建材质 + colorBlendMode 一律回退普通 alpha', () => {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);

  it('0 / 6 / 31 都返回内建 MeshBasicMaterial（three 只对内建材质自动注入蒙皮 shader）', () => {
    for (const mode of [undefined, 0, 6, 31]) {
      const m = createPuppetMaterial(tex, mode);
      expect(m).toBeInstanceOf(THREE.MeshBasicMaterial);
      expect(m.map).toBe(tex);
      expect(m.transparent).toBe(true);
      // WE 的自定义混合（6/7/31）不复刻：默认普通 alpha 混合
      expect(m.blending).toBe(THREE.NormalBlending);
      expect(m.side).toBe(THREE.DoubleSide);
      expect(m.depthWrite).toBe(false);
    }
  });

  it('无纹理（贴图解析失败）也能出材质（白图兜底，不阻断渲染）', () => {
    const m = createPuppetMaterial(null, 0);
    expect(m.map).toBeNull();
    expect(m.transparent).toBe(true);
  });
});
