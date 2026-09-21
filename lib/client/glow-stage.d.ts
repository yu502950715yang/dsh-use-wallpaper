import * as THREE from 'three';
export interface GlowOptions {
    threshold?: number;
    strength?: number;
}
/** 缺省参数 = 2026-09-21 多壁纸网格标定的保守档（旧 A 档 0.65/1.0 在亮部多的壁纸上过曝，见 AGENT.md §7.1）。 */
export declare const GLOW_DEFAULTS: {
    readonly threshold: 0.75;
    readonly strength: 0.4;
};
/** 参数归一：缺省 / NaN / 越界一律收敛到合法区间，绝不把非法值灌进 uniform。 */
export declare function normalizeGlowOptions(opts?: GlowOptions): Required<GlowOptions>;
/** 三级降采样 RT 尺寸（L1 = 1/2、L2 = 1/4、L3 = 1/8），逐级取半且不小于 1px。 */
export declare function glowLevelSizes(width: number, height: number): Array<{
    w: number;
    h: number;
}>;
export interface GlowStage {
    apply(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void;
    resize(width: number, height: number): void;
    setOptions(opts: GlowOptions): void;
    dispose(): void;
}
export declare function createGlowStage(width: number, height: number, opts?: GlowOptions): GlowStage | null;
