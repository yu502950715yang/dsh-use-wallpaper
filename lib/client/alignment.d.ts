/** alignment → 中心偏移（每轴为对象尺寸的分数 ∈ {-0.5, 0, 0.5}；未知值按 center）。 */
export declare function alignmentOffset(alignment: string | undefined): [number, number];
/**
 * 锚点 origin → 中心：center = origin + (offset.x×|worldW|, offset.y×|worldH|, 0)。
 * worldSize 为对象世界尺寸（场景像素 = size×scale；无尺寸时调用方应跳过——见
 * wasm-renderer.ts：纹理尺寸在 origin 计算时未知则原样直传）。
 * T4.4：worldSize 按**幅值**参与偏移——锚点对 scale 符号不变。对齐参考实现
 * （open-wallpaper-engine SceneImageObjectParser：alignment_offset 用未缩放
 * geometry_size 计算并烘焙进网格，节点 scale 绕 origin 缩放 → 锚点恒钉在 origin，
 * 负 scale 的镜像绕锚点翻转内容而非挪动锚点）。正 scale 下幅值 = 原值，行为不变；
 * 负 scale（镜像）下 'bottomright' 等锚点仍指未镜像图像的对应角/边。
 */
export declare function applyAlignment(origin: [number, number, number], worldSize: [number, number], alignment: string | undefined): [number, number, number];
