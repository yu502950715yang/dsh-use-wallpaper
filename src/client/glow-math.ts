// 亮度数学（纯函数）：应用级 Glow 与壁纸 bloom 共用。GLSL 侧在 glow-stage.ts 逐式镜像。
// 2026-11-17 A 方案：bright-pass 对齐 WE `assets/shaders/downsample_quarter_bloom.frag`
//（max 通道 + saturate，**不除** (1 - t)）；合成处加软膝，避免亮部被硬截断成死白。
// 旧口径 `(luma - t) / (1 - t)` 在 t=0.5 / 0.65 时分别把效果放大 2× / 2.86×（见 AGENT.md §7.42 ③）。

/** 软膝起点：≤ 该值恒等（不改正常亮度），之上按指数压向 1。 */
export const SHOULDER_KNEE = 0.9;

function clamp01(v: number): number {
  return v > 1 ? 1 : v < 0 ? 0 : v;
}

/** WE bloom 的 bright-pass 系数：`clamp(max(r,g,b) - t, 0, 1)`。t 非有限值按 0（= 不筛选）。 */
export function brightPassFactor(r: number, g: number, b: number, threshold: number): number {
  const t = Number.isFinite(threshold) ? clamp01(threshold) : 0;
  return clamp01(Math.max(r, g, b) - t);
}

/** 软膝：`x ≤ knee` 恒等；之上 `knee + (1-knee)·(1 - exp(-(x-knee)/(1-knee)))`（C1 连续、渐近 1）。 */
export function shoulderCurve(x: number, knee: number = SHOULDER_KNEE): number {
  if (!(x > knee)) return x; // 含 NaN / 无穷小的负值：原样返回，由调用方决定语义
  const span = 1 - knee;
  return knee + span * (1 - Math.exp(-(x - knee) / span));
}

/**
 * 合成：`max(base, 软膝(base + added))`。只压**新增**能量——已经到白（1.0）的底图必须保持 1.0，
 * 否则纯白像素会被压成 0.96 一类的灰（软膝单独作用在总和上就会出现这个副作用）。
 */
export function softShoulder(base: number, added: number, knee: number = SHOULDER_KNEE): number {
  return Math.max(base, shoulderCurve(base + added, knee));
}
