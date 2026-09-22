import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createLayerStateTable, applyLayerState } from '../src/client/layer-state.js';

describe('LayerStateTable', () => {
  it('write 合并同一对象的多次写入，read 返回最新值', () => {
    const t = createLayerStateTable();
    t.write(100, { alpha: 0.5 });
    t.write(100, { alpha: 0.2, origin: [1, 2, 0] });
    expect(t.read(100)).toEqual({ alpha: 0.2, origin: [1, 2, 0] });
  });

  it('takeDirty 返回脏项并清空；未再写入则第二次为空', () => {
    const t = createLayerStateTable();
    t.write(100, { alpha: 1 });
    const d1 = t.takeDirty();
    expect(d1.get(100)).toEqual({ alpha: 1 });
    expect(t.takeDirty().size).toBe(0);
    t.write(100, { alpha: 0.5 });
    expect(t.takeDirty().get(100)).toEqual({ alpha: 0.5 });
  });

  it('重复写同值不产生脏项（避免每帧无谓应用）', () => {
    const t = createLayerStateTable();
    t.write(100, { alpha: 1 });
    t.takeDirty();
    t.write(100, { alpha: 1 });
    expect(t.takeDirty().size).toBe(0);
  });

  it('数组值按分量比较（值等价不算脏）', () => {
    const t = createLayerStateTable();
    t.write(7, { origin: [1, 2, 3] });
    t.takeDirty();
    t.write(7, { origin: [1, 2, 3] });
    expect(t.takeDirty().size).toBe(0);
  });

  it('size 反映已登记对象数', () => {
    const t = createLayerStateTable();
    t.write(1, { alpha: 1 }); t.write(2, { alpha: 1 });
    expect(t.size()).toBe(2);
  });
});

describe('applyLayerState', () => {
  const mk = (objectId: number) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
    return { target: { object: mesh as THREE.Object3D, sceneW: 2560, sceneH: 1440 }, mesh };
  };

  it('origin 走 we_to_three（减 scene/2，y 不翻）', () => {
    const { target, mesh } = mk(1);
    const n = applyLayerState(new Map([[1, { origin: [100, 200, 0] }]]), () => target);
    expect(n).toBe(1);
    expect(mesh.position.x).toBeCloseTo(100 - 1280);
    expect(mesh.position.y).toBeCloseTo(200 - 720);
  });

  it('scale / angles 直接落到对象', () => {
    const { target, mesh } = mk(1);
    applyLayerState(new Map([[1, { scale: [2, 3, 1], angles: [0, 0, -0.5] }]]), () => target);
    expect(mesh.scale.toArray()).toEqual([2, 3, 1]);
    expect(mesh.rotation.z).toBeCloseTo(-0.5);
  });

  it('visible=false 映射成 object.visible=false（alpha=0 等价表达）', () => {
    const { target, mesh } = mk(1);
    applyLayerState(new Map([[1, { visible: false }]]), () => target);
    expect(mesh.visible).toBe(false);
  });

  it('alpha 落到 MeshBasicMaterial.opacity；为 0 时隐藏', () => {
    const { target, mesh } = mk(1);
    const mat = mesh.material as THREE.MeshBasicMaterial;
    applyLayerState(new Map([[1, { alpha: 0.25 }]]), () => target);
    expect(mesh.visible).toBe(true);
    expect(mat.opacity).toBeCloseTo(0.25);
    applyLayerState(new Map([[1, { alpha: 0 }]]), () => target);
    expect(mesh.visible).toBe(false);
  });

  it('alpha 也支持 ShaderMaterial.uniforms.opacity', () => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
      uniforms: { opacity: { value: 1 } }, vertexShader: '', fragmentShader: '',
    }));
    applyLayerState(new Map([[1, { alpha: 0.4 }]]), () => ({ object: mesh, sceneW: 0, sceneH: 0 }));
    expect((mesh.material as THREE.ShaderMaterial).uniforms['opacity']!.value).toBeCloseTo(0.4);
  });

  it('lookup 未命中时跳过（util / 未渲染对象只记账不应用）', () => {
    const n = applyLayerState(new Map([[999, { alpha: 0 }]]), () => undefined);
    expect(n).toBe(0);
  });
});
