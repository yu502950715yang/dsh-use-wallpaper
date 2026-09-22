import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { resolveVertexLayout, inferQuadCount, DynamicMeshRegistry } from '../src/client/dynamic-mesh.js';

const LAYOUT = { stride: 9, position: 0, uv: 3, color: 5 };

describe('resolveVertexLayout', () => {
  it('支持 [POSITION(0), UV(1), COLOR(2)] → stride 9', () => {
    expect(resolveVertexLayout([0, 1, 2])).toEqual(LAYOUT);
  });

  it('其他组合一律不支持（本期只做实测到的那一种）', () => {
    expect(resolveVertexLayout([0, 1])).toBeNull();       // 缺 COLOR
    expect(resolveVertexLayout([1, 0, 2])).toBeNull();    // 顺序不同
    expect(resolveVertexLayout([0, 1, 2, 3])).toBeNull(); // 多 NORMAL
    expect(resolveVertexLayout([])).toBeNull();
  });
});

describe('inferQuadCount', () => {
  it('全空 → 0', () => {
    expect(inferQuadCount(new Float32Array(36), LAYOUT, 1)).toBe(0);
  });

  it('只有第 0 个 quad 有 position → 1', () => {
    const buf = new Float32Array(2 * 36);
    buf[0] = 10; buf[1] = 20; // quad0 顶点0 的 position.xy
    expect(inferQuadCount(buf, LAYOUT, 2)).toBe(1);
  });

  it('第 1 个 quad 也有 → 2（取最后一个非空下标 +1）', () => {
    const buf = new Float32Array(3 * 36);
    buf[0] = 10; buf[1] = 20;
    buf[36] = 5; buf[37] = 6;
    expect(inferQuadCount(buf, LAYOUT, 3)).toBe(2);
  });

  it('只有 y 非零也算非空（x=0 的粒子不能被漏掉）', () => {
    const buf = new Float32Array(36);
    buf[1] = -7; // position.y 非零
    expect(inferQuadCount(buf, LAYOUT, 1)).toBe(1);
  });

  it('capacity 超过 buffer 容量时按 buffer 截断（防御）', () => {
    const buf = new Float32Array(36); // 只够 1 个 quad
    buf[0] = 1;
    expect(inferQuadCount(buf, LAYOUT, 100)).toBe(1);
  });

  it('4 个顶点都要检查（只有最后一个顶点非零也算）', () => {
    const buf = new Float32Array(36);
    buf[3 * 9] = 9; // quad0 的第 4 个顶点 position.x
    expect(inferQuadCount(buf, LAYOUT, 1)).toBe(1);
  });
});

function mk() {
  const parent = new THREE.Scene();
  const warns: string[] = [];
  const registry = new DynamicMeshRegistry({
    parent, materialFor: () => new THREE.MeshBasicMaterial(), onWarn: (m) => warns.push(m),
  });
  return { parent, registry, warns };
}

describe('DynamicMeshRegistry', () => {
  it('createModel 建 BufferGeometry：position/uv/color(4) + 索引，容量按 quad 预算', () => {
    const { registry } = mk();
    const id = registry.createModel({ capacity: 3, vertexFormat: [0, 1, 2], materialPath: 'm.json' });
    expect(id).toBe(0);
    const g = registry.geometryOf(id!)!;
    expect(g.getAttribute('position').count).toBe(12); // 3 quad × 4 顶点
    expect(g.getAttribute('position').itemSize).toBe(3);
    expect(g.getAttribute('uv').itemSize).toBe(2);
    expect(g.getAttribute('color').itemSize).toBe(4);
    expect(g.getIndex()!.count).toBe(18);              // 3 quad × 6 索引
    expect(Array.from(g.getIndex()!.array.slice(0, 6))).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('不支持的 vertexFormat → 返回 null 并 warn 一次', () => {
    const { registry, warns } = mk();
    expect(registry.createModel({ capacity: 1, vertexFormat: [0, 1], materialPath: null })).toBeNull();
    expect(registry.createModel({ capacity: 1, vertexFormat: [0, 1], materialPath: null })).toBeNull();
    expect(registry.unsupportedCount).toBe(2);
    expect(warns.length).toBe(1); // 同因只 warn 一次
  });

  it('createLayer 建 Mesh 挂到 parent，renderOrder 在背景之上', () => {
    const { registry, parent } = mk();
    const m = registry.createModel({ capacity: 1, vertexFormat: [0, 1, 2], materialPath: null })!;
    const l = registry.createLayer(m, '发射器 1');
    const mesh = registry.meshOf(l)!;
    expect(parent.children).toContain(mesh);
    expect(mesh.renderOrder).toBe(1);
    expect(mesh.name).toBe('发射器 1');
  });

  it('applyData 写入顶点：position/uv/color 各自 updateRange，drawRange 只画使用的 quad', () => {
    const { registry } = mk();
    const m = registry.createModel({ capacity: 2, vertexFormat: [0, 1, 2], materialPath: null })!;
    const l = registry.createLayer(m, 'x');
    const buf = new Float32Array(2 * 36);
    // 顶点 0 的 position.xy / uv.xy / color.rgba（stride 9：pos 0-2、uv 3-4、color 5-8）
    buf[0] = 1; buf[1] = 2;
    buf[3] = 0.5; buf[4] = 0.25;
    buf[5] = 0.125; buf[6] = 0.75; buf[7] = 0.375; buf[8] = 0.625;
    registry.applyData(m, buf);
    const g = registry.geometryOf(m)!;
    expect(g.getAttribute('position').array[0]).toBeCloseTo(1);
    expect(g.getAttribute('uv').array[0]).toBeCloseTo(0.5);   // uv 从 stride 偏移 3 起
    expect(g.getAttribute('uv').array[1]).toBeCloseTo(0.25);
    expect(g.getAttribute('color').array[0]).toBeCloseTo(0.125); // color 从偏移 5 起
    expect(g.getAttribute('color').array[3]).toBeCloseTo(0.625); // 第 4 个分量（alpha）也要解包
    expect(g.drawRange.count).toBe(6);                          // 只用 1 个 quad
    expect(g.getAttribute('position').updateRanges.length).toBeGreaterThan(0);
    expect(registry.isVisible(l)).toBe(true);
  });

  it('只标记实际使用区间：updateRange.count = 使用顶点数 × 分量数', () => {
    const { registry } = mk();
    const m = registry.createModel({ capacity: 4, vertexFormat: [0, 1, 2], materialPath: null })!;
    const buf = new Float32Array(4 * 36);
    buf[0] = 1; buf[36] = 1; // 2 个 quad 非空
    registry.applyData(m, buf);
    const g = registry.geometryOf(m)!;
    const pos = g.getAttribute('position').updateRanges;
    const uv = g.getAttribute('uv').updateRanges;
    const col = g.getAttribute('color').updateRanges;
    expect(pos.length).toBe(1);
    expect(pos[0]).toMatchObject({ start: 0, count: 8 * 3 });  // 2 quad × 4 顶点 ⇒ 8 顶点
    expect(uv[0]).toMatchObject({ start: 0, count: 8 * 2 });
    expect(col[0]).toMatchObject({ start: 0, count: 8 * 4 });
    expect(g.drawRange.count).toBe(12);
  });

  it('连续 applyData 不累积 updateRange（每帧先清再标）', () => {
    const { registry } = mk();
    const m = registry.createModel({ capacity: 4, vertexFormat: [0, 1, 2], materialPath: null })!;
    const full = new Float32Array(4 * 36);
    for (let i = 0; i < 4; i++) full[i * 36] = 1;
    registry.applyData(m, full);
    const small = new Float32Array(4 * 36);
    small[0] = 1;
    registry.applyData(m, small);
    const g = registry.geometryOf(m)!;
    const pos = g.getAttribute('position').updateRanges;
    expect(pos.length).toBe(1);                                 // 不是 2
    expect(pos[0]).toMatchObject({ start: 0, count: 4 * 3 });   // 用当帧的 1 个 quad
    expect(g.drawRange.count).toBe(6);
  });

  it('全空顶点 → drawRange.count = 0（不画，也不报错）', () => {
    const { registry } = mk();
    const m = registry.createModel({ capacity: 1, vertexFormat: [0, 1, 2], materialPath: null })!;
    registry.applyData(m, new Float32Array(36));
    expect(registry.geometryOf(m)!.drawRange.count).toBe(0);
  });

  it('setVisible / isVisible', () => {
    const { registry } = mk();
    const m = registry.createModel({ capacity: 1, vertexFormat: [0, 1, 2], materialPath: null })!;
    const l = registry.createLayer(m, 'x');
    registry.setVisible(l, false);
    expect(registry.meshOf(l)!.visible).toBe(false);
    expect(registry.isVisible(l)).toBe(false);
  });

  it('applyData 的 buffer 短于容量时不越界（防御）', () => {
    const { registry } = mk();
    const m = registry.createModel({ capacity: 5, vertexFormat: [0, 1, 2], materialPath: null })!;
    const buf = new Float32Array(36); // 只够 1 个 quad
    buf[0] = 1;
    registry.applyData(m, buf);
    expect(registry.geometryOf(m)!.drawRange.count).toBe(6);
  });

  it('dispose 释放几何体，重复调用安全', () => {
    const { registry, parent } = mk();
    const m = registry.createModel({ capacity: 1, vertexFormat: [0, 1, 2], materialPath: null })!;
    registry.createLayer(m, 'x');
    expect(() => registry.dispose()).not.toThrow();
    expect(() => registry.dispose()).not.toThrow();
    expect(parent.children.length).toBe(0);
  });

  // 以下两条特征测试针对 setMaterialForPath（Task 5 的材质异步回填通道，非 Task 1/2 范围）
  it('setMaterialForPath 回填已建 mesh 的材质', () => {
    const { registry } = mk();
    const m = registry.createModel({ capacity: 1, vertexFormat: [0, 1, 2], materialPath: 'materials/x.json' })!;
    const l = registry.createLayer(m, 'a');
    const mat = new THREE.MeshBasicMaterial();
    registry.setMaterialForPath('materials/x.json', mat);
    expect(registry.meshOf(l)!.material).toBe(mat);
  });

  it('setMaterialForPath 之后新建的 layer 直接用该材质', () => {
    const { registry } = mk();
    const m = registry.createModel({ capacity: 1, vertexFormat: [0, 1, 2], materialPath: 'materials/x.json' })!;
    const mat = new THREE.MeshBasicMaterial();
    registry.setMaterialForPath('materials/x.json', mat);
    const l = registry.createLayer(m, 'b');
    expect(registry.meshOf(l)!.material).toBe(mat);
  });

  it('未知 modelId 的 applyData/createLayer 安全返回', () => {
    const { registry } = mk();
    expect(() => registry.applyData(99, new Float32Array(36))).not.toThrow();
    expect(() => registry.createLayer(99, 'x')).not.toThrow();
    expect(registry.geometryOf(99)).toBeNull();
    expect(registry.meshOf(99)).toBeNull();
    expect(registry.createLayer(99, 'x')).toBe(-1);
    expect(registry.isVisible(99)).toBe(false);
    expect(() => registry.setVisible(99, true)).not.toThrow();
  });
});
