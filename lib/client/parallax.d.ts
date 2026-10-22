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
 * 每帧向目标位置线性靠近（OWE UniformSource.cpp:249-274）：delay=0 立即跟随；delay>0 每帧按 min(dt, delay)/delay 靠近。
 * 滞后时钟按「本帧」取、不得跨帧累积（OWE 的减/加同帧抵消，推导与理由见 AGENT.md §5.47）。
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
/** 效果 shader 全局 uniform（F18）：pointerPosition = 原始指针（y 向下）；
 *  parallaxPosition = 0.5 + 中心化视差 × mouseinfluence（y 向上，关视差 = 中性 0.5）；第三参缺省用原始指针。 */
export declare function effectPointerUniforms(pointer: PointerState, cfg: ParallaxConfig, parallaxPointer?: PointerState): {
    pointerPosition: [number, number];
    parallaxPosition: [number, number];
};
