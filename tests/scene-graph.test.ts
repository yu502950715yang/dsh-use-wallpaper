import { describe, expect, it } from 'vitest';
import { resolveWorldTransforms, type SceneGraphNode } from '../src/client/scene-graph.js';

// 3798688689 的真实层级截取（1 → 1000 → 1001 → 1003 → 10030）
const CHAIN = [
  { id: 1, origin: [1280, 720, 0], scale: [1.64103, 1.64103, 1] },
  { id: 1000, parent: 1, origin: [0, 0, 0], scale: [1, 1, 1] },
  { id: 1001, parent: 1000, origin: [0, 0, 0], scale: [1, 1, 1] },
  { id: 1003, parent: 1001, origin: [0, 0, 0], scale: [1, 1, 1] },
  { id: 10030, parent: 1003, scale: [15.6, 9.6, 1] },   // origin/scale 可缺失
] as unknown as SceneGraphNode[];

// 同一张壁纸的另两层背景（父链更长，且中间节点同样缺 origin/scale）
const CHAIN_10070 = [
  { id: 1, origin: [1280, 720, 0], scale: [1.64103, 1.64103, 1] },
  { id: 1000, parent: 1 },
  { id: 1001, parent: 1000 },
  { id: 1004, parent: 1001 },
  { id: 1005, parent: 1004 },
  { id: 1006, parent: 1005 },
  { id: 1007, parent: 1006 },
  { id: 10070, parent: 1007, scale: [3.04709, 2.26553, 1] },
] as unknown as SceneGraphNode[];

const CHAIN_10080 = [
  { id: 1, origin: [1280, 720, 0], scale: [1.64103, 1.64103, 1] },
  { id: 1000, parent: 1 },
  { id: 1001, parent: 1000 },
  { id: 1004, parent: 1001 },
  { id: 1005, parent: 1004 },
  { id: 1006, parent: 1005 },
  { id: 1008, parent: 1006 },
  { id: 10080, parent: 1008, scale: [0.3333, 0.3333, 1] },
] as unknown as SceneGraphNode[];

describe('resolveWorldTransforms', () => {
  it('反算基准：累积 scale 使 100×100 的 solidlayer 铺满场景宽 2560', () => {
    const w = resolveWorldTransforms(CHAIN);
    const t = w.get(10030)!;
    expect(t.scale[0]).toBeCloseTo(25.6001, 3);      // 1.64103 × 15.6
    expect(t.scale[1]).toBeCloseTo(15.7539, 3);
    expect(t.origin[0]).toBeCloseTo(1280, 3);        // 父的世界 origin
    expect(100 * t.scale[0]).toBeCloseTo(2560, 0);
  });

  it('反算基准：另两层背景（更长父链）世界宽同样命中 2560', () => {
    const w1 = resolveWorldTransforms(CHAIN_10070).get(10070)!;
    expect(w1.scale[0]).toBeCloseTo(5.0, 3);
    expect(w1.scale[1]).toBeCloseTo(3.718, 3);
    expect(512 * w1.scale[0]).toBeCloseTo(2560, 0);

    const w2 = resolveWorldTransforms(CHAIN_10080).get(10080)!;
    expect(w2.scale[0]).toBeCloseTo(0.547, 3);
    expect(4680 * w2.scale[0]).toBeCloseTo(2560, 0);
  });

  it('退化保证：无 parent 的对象逐字段等于局部值（含负 scale）', () => {
    const nodes = [{ id: 7, origin: [10, 20, 0], scale: [-1, 0.5, 1], angles: [0, 0, 1.2] }] as unknown as SceneGraphNode[];
    expect(resolveWorldTransforms(nodes).get(7)).toEqual({
      origin: [10, 20, 0], scale: [-1, 0.5, 1], angles: [0, 0, 1.2],
    });
  });

  it('缺 angles 的对象 angles 取 [0,0,0]', () => {
    const nodes = [{ id: 1, origin: [0, 0, 0], scale: [1, 1, 1] }] as unknown as SceneGraphNode[];
    expect(resolveWorldTransforms(nodes).get(1)!.angles).toEqual([0, 0, 0]);
  });

  it('子对象缺 origin/scale 时按父链继承（origin=0 / scale=1）', () => {
    const nodes = [
      { id: 1, origin: [100, 100, 0], scale: [2, 2, 1] },
      { id: 2, parent: 1 },
    ] as unknown as SceneGraphNode[];
    const w = resolveWorldTransforms(nodes);
    expect(w.get(2)).toEqual({ origin: [100, 100, 0], scale: [2, 2, 1], angles: [0, 0, 0] });
  });

  it('子对象的 origin 按父的世界 scale 缩放后叠加到父的世界 origin', () => {
    const nodes = [
      { id: 1, origin: [100, 100, 0], scale: [2, 2, 1] },
      { id: 2, parent: 1, origin: [10, 5, 0], scale: [1, 1, 1] },
    ] as unknown as SceneGraphNode[];
    const w = resolveWorldTransforms(nodes);
    expect(w.get(2)!.origin[0]).toBeCloseTo(120, 6);   // 100 + 2×10
    expect(w.get(2)!.origin[1]).toBeCloseTo(110, 6);   // 100 + 2×5
    expect(w.get(2)!.scale).toEqual([2, 2, 1]);
  });

  it('父链含旋转时不产出 NaN，且 origin 随旋转改变', () => {
    const nodes = [
      { id: 1, origin: [0, 0, 0], scale: [1, 1, 1], angles: [0, 0, Math.PI / 2] },
      { id: 2, parent: 1, origin: [10, 0, 0], scale: [1, 1, 1] },
    ] as unknown as SceneGraphNode[];
    const t = resolveWorldTransforms(nodes).get(2)!;
    expect(t.origin.every(Number.isFinite)).toBe(true);
    expect(t.origin[0]).toBeCloseTo(0, 3);      // 绕 z 转 90° → (10,0) → (0,10)
    expect(t.origin[1]).toBeCloseTo(10, 3);
  });

  it('环状 parent 链不挂死：结果有限且每个节点都在表内', () => {
    const nodes = [
      { id: 1, parent: 2, origin: [1, 1, 0], scale: [1, 1, 1] },
      { id: 2, parent: 1, origin: [2, 2, 0], scale: [1, 1, 1] },
    ] as unknown as SceneGraphNode[];
    const w = resolveWorldTransforms(nodes);
    expect(w.size).toBe(2);
    // 环检测只保证「不挂死 + 不产出 NaN/Infinity」：环内节点退化为局部值时，另一个也可能是
    // 局部值叠加一次偏移（实现细节，不断言具体数值）。
    for (const t of w.values()) expect(t.origin.every(Number.isFinite)).toBe(true);
  });

  it('超深父链不挂死：到达深度上限后退化为局部值', () => {
    const nodes: Array<{ id: number; parent?: number; origin?: [number, number, number]; scale?: [number, number, number] }> = [];
    const DEPTH = 100;
    for (let i = 0; i < DEPTH; i++) {
      nodes.push({ id: i, parent: i === 0 ? undefined : i - 1, origin: [1, 0, 0], scale: [1, 1, 1] });
    }
    const w = resolveWorldTransforms(nodes as unknown as SceneGraphNode[]);
    expect(w.size).toBe(DEPTH);
    for (const t of w.values()) expect(t.origin.every(Number.isFinite)).toBe(true);
    // 根节点逐字段等于局部值
    expect(w.get(0)).toEqual({ origin: [1, 0, 0], scale: [1, 1, 1], angles: [0, 0, 0] });
  });

  it('未知 parent id（悬空引用）→ 按无父处理', () => {
    const nodes = [{ id: 5, parent: 999, origin: [3, 4, 0], scale: [1, 1, 1] }] as unknown as SceneGraphNode[];
    expect(resolveWorldTransforms(nodes).get(5)!.origin).toEqual([3, 4, 0]);
  });
});
