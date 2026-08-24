// src/client/alignment.ts —— T4.1：WE 对象 alignment 锚点 → 中心偏移（共享纯函数）。
// scene-renderer.ts 与 wasm-renderer.ts 共用（Controller Ruling P4-1：JS 侧预处理 origin，
// Rust 保持「origin=中心」约定不改，避免 Rust/WGSL 双改与 std140 连锁）。
//
// 语义（task-4.1 brief 的表为权威约定，不做 y 翻转——注意下表的偏移符号按 y 向上
// 约定给出，'top' = +h/2、'bottom' = -h/2）：对象 origin 是锚点（对齐点），渲染器按
// 「中心锚定 quad」放置——center = origin + offset × |worldSize|（offset 为相对对象
// 尺寸的分数；T4.4 起 worldSize 取幅值，锚点对 scale 符号不变，见 applyAlignment 注释）。
// 9 种 WE 对齐值（'center' 缺省即无偏移）：
//   'center'/undefined/未知 → [0, 0]
//   'topleft'      → [0.5,  0.5]   'top'         → [0,    0.5]
//   'topright'     → [-0.5, 0.5]   'right'       → [-0.5, 0  ]
//   'bottomright'  → [-0.5, -0.5]  'bottom'      → [0,   -0.5]
//   'bottomleft'   → [0.5, -0.5]   'left'        → [0.5,  0  ]
// 注意：这与 T3.3 barAnchorOffsetY（bottom→+h/2、top→-h/2，scene-renderer.ts）的
// 符号相反——那是「中心锚定 quad 相对锚点的 y 偏移」（加法位移），本表是「锚点换算
// 中心的分数偏移」，两者各自内部一致、互不混用（T3.3 近似保持原样，见任务 Notes）。
/** alignment → 中心偏移（每轴为对象尺寸的分数 ∈ {-0.5, 0, 0.5}；未知值按 center）。 */
export function alignmentOffset(alignment) {
    switch (alignment) {
        case 'topleft': return [0.5, 0.5];
        case 'top': return [0, 0.5];
        case 'topright': return [-0.5, 0.5];
        case 'right': return [-0.5, 0];
        case 'bottomright': return [-0.5, -0.5];
        case 'bottom': return [0, -0.5];
        case 'bottomleft': return [0.5, -0.5];
        case 'left': return [0.5, 0];
        default: return [0, 0]; // 'center' / undefined / 未知值 → 无偏移
    }
}
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
export function applyAlignment(origin, worldSize, alignment) {
    const [ox, oy] = alignmentOffset(alignment);
    return [
        origin[0] + ox * Math.abs(worldSize[0]),
        origin[1] + oy * Math.abs(worldSize[1]),
        origin[2],
    ];
}
