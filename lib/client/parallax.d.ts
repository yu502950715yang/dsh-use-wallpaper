import type { ParallaxConfig } from '../shared/types.js';
export type { ParallaxConfig };
/** OWE 解析器缺省：cameraparallax=false / amount=0 / delay=0 / mouseinfluence=0。 */
export declare const DEFAULT_PARALLAX: ParallaxConfig;
/** 读 scene.json 的 general.cameraparallax* 四字段（非对象/畸形一律回落缺省，不误开视差）。 */
export declare function readParallaxConfig(gen: unknown): ParallaxConfig;
/** 归一化指针（[0,1]，y 向下 = 屏幕约定；缺省居中）。 */
export interface PointerState {
    x: number;
    y: number;
}
export declare const POINTER_CENTER: PointerState;
/** 指针跟随状态：`value` = 当前插值位置；`elapsed` = **本帧**的滞后时钟（见 advancePointer）。 */
export interface PointerFollow {
    value: PointerState;
    elapsed: number;
}
/**
 * 每帧向目标位置线性靠近（OWE UniformSource.cpp:249-274）：delay=0 立即跟随；delay>0 时每帧按
 * `min(dt, delay) / delay` 靠近（时间常数 ≈ delay 的一阶平滑，滞后感**每次**移动都在）。
 *
 * ⚠️ 与 OWE 字面写法的唯一偏离：OWE 每帧先 `SetPointerInput`（滞后时钟减去已流逝时间）再 `Advance`
 * （加回同一个 `frame.delta`），两者在同一帧内抵消 ⇒ `elapsed` 只剩「历史最大帧长」（`max(0,e−dt)+dt = e`）。
 * 本播放器 dt 被 clamp 到 0.1s，而本机唯一开视差壁纸的 delay 恰好是 0.1 ⇒ 一次长帧（切走标签页再切回）
 * 就会把 amount 永久打成 1、平滑消失。故这里每帧直接取 `min(dt, delay)`：稳态比例与 OWE 相同、不残留历史。
 */
export declare function advancePointer(follow: PointerFollow, target: PointerState, cfg: ParallaxConfig, dt: number): PointerFollow;
/**
 * 逐对象 2D 平移（世界/场景单位）：
 *   mouse_x = (0.5 − px) × W × mi        mouse_y = (py − 0.5) × H × mi
 *   shift   = depth ⊙ ((node − cam) + mouse) × amount
 * cam 在 three 坐标下是 (0,0)（we_to_three 把场景中心移到原点），node 传 three 坐标。
 */
export declare function parallaxShift(o: {
    pointer: PointerState;
    orthoW: number;
    orthoH: number;
    nodeX: number;
    nodeY: number;
    camX: number;
    camY: number;
    depth: [number, number];
    cfg: ParallaxConfig;
}): [number, number];
