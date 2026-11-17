/** 软膝起点：≤ 该值恒等（不改正常亮度），之上按指数压向 1。 */
export declare const SHOULDER_KNEE = 0.9;
/** WE bloom 的 bright-pass 系数：`clamp(max(r,g,b) - t, 0, 1)`。t 非有限值按 0（= 不筛选）。 */
export declare function brightPassFactor(r: number, g: number, b: number, threshold: number): number;
/** 软膝：`x ≤ knee` 恒等；之上 `knee + (1-knee)·(1 - exp(-(x-knee)/(1-knee)))`（C1 连续、渐近 1）。 */
export declare function shoulderCurve(x: number, knee?: number): number;
/**
 * 合成：`max(base, 软膝(base + added))`。只压**新增**能量——已经到白（1.0）的底图必须保持 1.0，
 * 否则纯白像素会被压成 0.96 一类的灰（软膝单独作用在总和上就会出现这个副作用）。
 */
export declare function softShoulder(base: number, added: number, knee?: number): number;
