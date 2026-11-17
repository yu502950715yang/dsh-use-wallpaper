import * as THREE from 'three';
export interface GlowOptions {
    threshold?: number;
    strength?: number;
}
/**
 * 缺省参数（2026-09-21 用户真机定档）。⚠️ 2026-11-17 起 bright-pass 改成 WE 口径：同阈值下的
 * 系数比旧口径小 (1-t) 倍 ⇒ 这组数在观感上比旧版本清淡（t=0.65 时约 1/2.86）。想要旧观感把
 * 强度调到 ≈1.0 即可（面板即时生效）。
 */
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
     * `outTarget`（两级串联）非空时 composite 写入该 RT（bloom → Glow）；缺省 null = 画布。
     */
    apply(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, preRendered?: THREE.WebGLRenderTarget | null, outTarget?: THREE.WebGLRenderTarget | null): void;
    resize(width: number, height: number): void;
    setOptions(opts: GlowOptions): void;
    dispose(): void;
}
export declare const BRIGHT_FRAG = "\nuniform sampler2D tSrc;\nuniform float uThreshold;\nvarying vec2 vUv;\nvoid main() {\n  vec3 c = texture2D(tSrc, vUv).rgb;\n  // WE downsample_quarter_bloom\uFF1Asaturate(max(rgb) - threshold)\uFF1B\u4E0D\u9664 (1 - t)\u3001\u4E0D\u7528 luma \u5224\u9608\u503C\n  float k = clamp(max(max(c.r, c.g), c.b) - uThreshold, 0.0, 1.0);\n  gl_FragColor = vec4(c * k, 1.0);\n}\n";
export declare const COMPOSITE_FRAG = "\nuniform sampler2D tBase;\nuniform sampler2D tL1;\nuniform sampler2D tL2;\nuniform sampler2D tL3;\nuniform float uStrength;\nuniform float uKnee;\nvarying vec2 vUv;\nvec3 shoulder(vec3 x) {\n  vec3 over = max(x - uKnee, vec3(0.0)) / (1.0 - uKnee);\n  vec3 curve = uKnee + (1.0 - uKnee) * (1.0 - exp(-over));\n  return mix(x, curve, step(vec3(uKnee), x));\n}\nvoid main() {\n  vec3 base = texture2D(tBase, vUv).rgb;\n  vec3 glow = (texture2D(tL1, vUv).rgb + texture2D(tL2, vUv).rgb + texture2D(tL3, vUv).rgb) / 3.0;\n  // max(base, ...)\uFF1A\u5E95\u56FE\u5DF2\u7ECF\u5230\u767D\u65F6\u4FDD\u6301 1.0\uFF08\u53EA\u538B\u5149\u6655\u65B0\u589E\u7684\u80FD\u91CF\uFF0C\u4E0D\u628A 255 \u538B\u6210\u7070\uFF09\n  vec3 summed = shoulder(base + glow * uStrength);\n  gl_FragColor = vec4(clamp(max(base, summed), 0.0, 1.0), 1.0);\n}\n";
export declare function createGlowStage(width: number, height: number, opts?: GlowOptions): GlowStage | null;
