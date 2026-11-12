// 视差传播契约（WE 语义）：子层没有自己的视差深度时，继承父链锚点的视差位移；
// 双方都声明非零深度时各算各的；父层 `disablepropagation: true` 阻断继承。
// 语义对齐参考实现（本地研究目录 `.superpowers/we-layerd-src` 的
// `src/test/scene/parallax_propagation_test.cpp` 与 `WPNodeTransformResolver.cpp` 的 `ComputeParallaxOffset`）。
import { describe, expect, it } from 'vitest';
import { resolveParallaxContracts } from '../src/client/parallax-contract.js';

/** 节点原点的取法：测试里直接用「id*1000」这种可辨识值。 */
const originOf = (id: number): [number, number, number] => [id * 1000, id * 100, 0];

const DEPTH_A: [number, number] = [0.1, 0.2];
const DEPTH_B: [number, number] = [0.5, 0.25];

describe('resolveParallaxContracts（视差传播）', () => {
  it('子层缺省深度 ⇒ 继承父的深度与父锚点原点（子自己的原点不参与偏移）', () => {
    const map = resolveParallaxContracts([
      { id: 10, parallaxDepth: DEPTH_A },
      { id: 11, parent: 10 },
    ], originOf);
    expect(map.get(11)).toEqual({ depth: DEPTH_A, node: originOf(10), anchorId: 10 });
    // 父自身仍是自己的锚点。
    expect(map.get(10)).toEqual({ depth: DEPTH_A, node: originOf(10), anchorId: 10 });
  });

  it('子层显式零深度（"0.00000 0.00000"）⇒ 同样继承父锚点', () => {
    const map = resolveParallaxContracts([
      { id: 10, parallaxDepth: DEPTH_A },
      { id: 11, parent: 10, parallaxDepth: [0, 0] },
    ], originOf);
    expect(map.get(11)).toEqual({ depth: DEPTH_A, node: originOf(10), anchorId: 10 });
  });

  it('父子都声明非零深度 ⇒ 各算各的（子保留自己的深度与原点）', () => {
    const map = resolveParallaxContracts([
      { id: 10, parallaxDepth: DEPTH_A },
      { id: 11, parent: 10, parallaxDepth: DEPTH_B },
    ], originOf);
    expect(map.get(11)).toEqual({ depth: DEPTH_B, node: originOf(11), anchorId: 11 });
  });

  it('父层 disablepropagation=true ⇒ 子不继承，用子自己的深度', () => {
    const map = resolveParallaxContracts([
      { id: 10, parallaxDepth: DEPTH_A, disablePropagation: true },
      { id: 11, parent: 10, parallaxDepth: DEPTH_B },
      { id: 12, parent: 10 },
    ], originOf);
    expect(map.get(11)).toEqual({ depth: DEPTH_B, node: originOf(11), anchorId: 11 });
    // 没声明深度的子层：不继承（父被禁止传播）⇒ 不参与视差。
    expect(map.get(12)).toEqual({ depth: null, node: originOf(12), anchorId: 12 });
  });

  it('传递：child → mid（无深度）→ root（非零深度）⇒ child/mid 都用 root 的深度与原点', () => {
    const map = resolveParallaxContracts([
      { id: 1, parallaxDepth: DEPTH_A },
      { id: 2, parent: 1 },
      { id: 3, parent: 2 },
    ], originOf);
    expect(map.get(2)).toEqual({ depth: DEPTH_A, node: originOf(1), anchorId: 1 });
    expect(map.get(3)).toEqual({ depth: DEPTH_A, node: originOf(1), anchorId: 1 });
  });

  it('父零深度且自身无锚点 ⇒ 子继承父（位移恒 0，参考实现的 zero-depth parent 口径）', () => {
    const map = resolveParallaxContracts([
      { id: 10, parallaxDepth: [0, 0] },
      { id: 11, parent: 10, parallaxDepth: DEPTH_B },
    ], originOf);
    expect(map.get(11)).toEqual({ depth: null, node: originOf(10), anchorId: 10 });
  });

  it('循环 parent 不挂死：退化为自身契约', () => {
    const map = resolveParallaxContracts([
      { id: 10, parent: 11, parallaxDepth: DEPTH_A },
      { id: 11, parent: 10, parallaxDepth: DEPTH_B },
    ], originOf);
    expect(map.get(10)?.anchorId).toBe(10);
    expect(map.get(11)?.anchorId).toBe(11);
  });

  it('未知 parent id / 缺省原点回退 [0,0,0]，不影响其它对象', () => {
    const map = resolveParallaxContracts([
      { id: 10, parent: 999, parallaxDepth: DEPTH_A },
      { id: 11, parallaxDepth: DEPTH_B },
    ], (id) => (id === 11 ? undefined : originOf(id)));
    expect(map.get(10)).toEqual({ depth: DEPTH_A, node: originOf(10), anchorId: 10 });
    expect(map.get(11)).toEqual({ depth: DEPTH_B, node: [0, 0, 0], anchorId: 11 });
  });
});
