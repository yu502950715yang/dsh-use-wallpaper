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
/**
 * 解析每个对象的视差契约。`nodeOriginOf(id)` 返回该对象的**世界** origin（WE 场景坐标）；
 * 取不到时回退 [0,0,0]（不抛错：视差不是渲染主路径，缺元数据不应整场失败）。
 */
export declare function resolveParallaxContracts(objects: readonly ParallaxContractNode[], nodeOriginOf: (id: number) => [number, number, number] | undefined): Map<number, ParallaxContract>;
