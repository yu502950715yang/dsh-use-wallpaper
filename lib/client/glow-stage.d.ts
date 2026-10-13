import * as THREE from 'three';
export interface GlowOptions {
    threshold?: number;
    strength?: number;
}
/** 缺省参数（低阈值保光晕、低强度压过曝；阈值过高会在亮部多的壁纸上过曝，见 AGENT.md §7.1）。 */
export declare const GLOW_DEFAULTS: {
    readonly threshold: 0.65;
    readonly strength: 0.35;
};
/** 参数归一：缺省 / NaN / 越界一律收敛到合法区间，绝不把非法值灌进 uniform。 */
export declare function normalizeGlowOptions(opts?: GlowOptions): Required<GlowOptions>;
/** 三级降采样 RT 尺寸（L1 = 1/2、L2 = 1/4、L3 = 1/8），逐级取半且不小于 1px。 */
export declare function glowLevelSizes(width: number, height: number): Array<{
    w: number;
    h: number;
}>;
export interface GlowStage {
    /**
     * 跑一遍 Glow 链。`preRendered`（段渲染）非空时**跳过自渲主场景**那一步，直接把它当 base RT 做
     * bright-pass（调用方已把主场景写进该 RT，且它就是画布缓冲尺寸的段目标）。
     */
    apply(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, preRendered?: THREE.WebGLRenderTarget): void;
    resize(width: number, height: number): void;
    setOptions(opts: GlowOptions): void;
    dispose(): void;
}
export declare function createGlowStage(width: number, height: number, opts?: GlowOptions): GlowStage | null;
