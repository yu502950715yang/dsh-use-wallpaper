// 视差传播契约（WE 语义）：子层没有自己的视差深度时继承父链锚点的视差位移；
// 双方都声明非零深度时各算各的；父层 `disablepropagation: true` 阻断继承。
//
// 语义来源（本地研究目录，未入库）：`.superpowers/we-layerd-src` 的
// `src/test/scene/parallax_propagation_test.cpp` 与 `WPNodeTransformResolver.cpp::ComputeParallaxOffset`
// —— 有锚点 ⇒ 偏移直接取锚点（递归到根），而不是用自身原点重算。
export interface ParallaxContractNode {
  id: number;
  /** scene.json 的 parent（场景树父对象 id）。 */
  parent?: number;
  /** 对象自己的视差深度；缺省/零 = 不声明（父链锚点可继承）。 */
  parallaxDepth?: [number, number];
  /** 该层是否禁止子层继承自己的视差（scene.json 的 `disablepropagation`）。 */
  disablePropagation?: boolean;
}

export interface ParallaxContract {
  /** 有效视差深度；null = 不参与视差（零深度/缺省且无可继承锚点）。 */
  depth: [number, number] | null;
  /** 视差位移的节点原点（锚点对象的**世界** origin，WE 场景坐标）。 */
  node: [number, number, number];
  /** 提供 depth/node 的锚点对象 id（继承时 ≠ 自身）。 */
  anchorId: number;
}

// 与参考实现同口径：|depth| ≤ 1e-4 视为零（"0.00000 0.00000" 是真实库里的显式零值）。
const ZERO_EPSILON = 1e-4;

function normalizeDepth(depth: [number, number] | undefined): [number, number] | null {
  if (!depth) return null;
  const [x, y] = depth;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return Math.abs(x) <= ZERO_EPSILON && Math.abs(y) <= ZERO_EPSILON ? null : [x, y];
}

/**
 * 解析每个对象的视差契约。`nodeOriginOf(id)` 返回该对象的**世界** origin（WE 场景坐标）；
 * 取不到时回退 [0,0,0]（不抛错：视差不是渲染主路径，缺元数据不应整场失败）。
 */
export function resolveParallaxContracts(
  objects: readonly ParallaxContractNode[],
  nodeOriginOf: (id: number) => [number, number, number] | undefined,
): Map<number, ParallaxContract> {
  const byId = new Map<number, ParallaxContractNode>();
  for (const o of objects) byId.set(o.id, o);
  // 与参考实现一致：disablepropagation 只作用于「作为父层」的场景（父 id 进禁止集合）。
  const disabled = new Set<number>();
  for (const o of objects) if (o.disablePropagation === true) disabled.add(o.id);

  const memo = new Map<number, ParallaxContract>();
  const resolving = new Set<number>();
  const originOf = (id: number): [number, number, number] => nodeOriginOf(id) ?? [0, 0, 0];

  const resolve = (obj: ParallaxContractNode): ParallaxContract => {
    const hit = memo.get(obj.id);
    if (hit) return hit;
    const self: ParallaxContract = {
      depth: normalizeDepth(obj.parallaxDepth),
      node: originOf(obj.id),
      anchorId: obj.id,
    };
    // 环（畸形 parent 互指）不挂死：退化为自身契约，不缓存（外层 finally 只删 resolving）。
    if (resolving.has(obj.id)) return self;
    const parent = obj.parent !== undefined ? byId.get(obj.parent) : undefined;
    if (!parent) {
      memo.set(obj.id, self);
      return self;
    }
    resolving.add(obj.id);
    try {
      const parentContract = resolve(parent);
      if (!disabled.has(parent.id) && inheritsFromParent(self.depth, parent.id, parentContract)) {
        memo.set(obj.id, parentContract);
        return parentContract;
      }
      memo.set(obj.id, self);
      return self;
    } finally {
      resolving.delete(obj.id);
    }
  };

  const out = new Map<number, ParallaxContract>();
  for (const o of objects) out.set(o.id, resolve(o));
  return out;
}

/**
 * 子层是否继承父层锚点（对齐参考实现 `ShouldInheritParentParallax`）：
 * ① 子层未声明非零深度 ⇒ 继承；② 父层自己就继承自更上层 ⇒ 继承（锚点链）；
 * ③ 父层深度为零（未声明/显式零）⇒ 保留旧「父锚点」行为（父不动 ⇒ 子也不动）；
 * ④ 双方都声明了非零深度 ⇒ 不继承，各算各的。
 */
function inheritsFromParent(
  childDepth: [number, number] | null,
  parentId: number,
  parentContract: ParallaxContract,
): boolean {
  if (!childDepth) return true;
  if (parentContract.anchorId !== parentId) return true;
  if (!parentContract.depth) return true;
  return false;
}
