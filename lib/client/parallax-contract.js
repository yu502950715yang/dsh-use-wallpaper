// 与参考实现同口径：|depth| ≤ 1e-4 视为零（"0.00000 0.00000" 是真实库里的显式零值）。
const ZERO_EPSILON = 1e-4;
function normalizeDepth(depth) {
    if (!depth)
        return null;
    const [x, y] = depth;
    if (!Number.isFinite(x) || !Number.isFinite(y))
        return null;
    return Math.abs(x) <= ZERO_EPSILON && Math.abs(y) <= ZERO_EPSILON ? null : [x, y];
}
/**
 * 解析每个对象的视差契约。`nodeOriginOf(id)` 返回该对象的**世界** origin（WE 场景坐标）；
 * 取不到时回退 [0,0,0]（不抛错：视差不是渲染主路径，缺元数据不应整场失败）。
 */
export function resolveParallaxContracts(objects, nodeOriginOf) {
    const byId = new Map();
    for (const o of objects)
        byId.set(o.id, o);
    // 与参考实现一致：disablepropagation 只作用于「作为父层」的场景（父 id 进禁止集合）。
    const disabled = new Set();
    for (const o of objects)
        if (o.disablePropagation === true)
            disabled.add(o.id);
    const memo = new Map();
    const resolving = new Set();
    const originOf = (id) => nodeOriginOf(id) ?? [0, 0, 0];
    const resolve = (obj) => {
        const hit = memo.get(obj.id);
        if (hit)
            return hit;
        const self = {
            depth: normalizeDepth(obj.parallaxDepth),
            node: originOf(obj.id),
            anchorId: obj.id,
        };
        // 环（畸形 parent 互指）不挂死：退化为自身契约，不缓存（外层 finally 只删 resolving）。
        if (resolving.has(obj.id))
            return self;
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
        }
        finally {
            resolving.delete(obj.id);
        }
    };
    const out = new Map();
    for (const o of objects)
        out.set(o.id, resolve(o));
    return out;
}
/**
 * 子层是否继承父层锚点（对齐参考实现 `ShouldInheritParentParallax`）：
 * ① 子层未声明非零深度 ⇒ 继承；② 父层自己就继承自更上层 ⇒ 继承（锚点链）；
 * ③ 父层深度为零（未声明/显式零）⇒ 保留旧「父锚点」行为（父不动 ⇒ 子也不动）；
 * ④ 双方都声明了非零深度 ⇒ 不继承，各算各的。
 */
function inheritsFromParent(childDepth, parentId, parentContract) {
    if (!childDepth)
        return true;
    if (parentContract.anchorId !== parentId)
        return true;
    if (!parentContract.depth)
        return true;
    return false;
}
