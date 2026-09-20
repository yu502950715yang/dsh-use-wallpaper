// src/client/glow-stage.ts
// 应用级 Glow（全屏后处理）：bright-pass → 三级降采样 box blur → composite 加法回叠。
// 语义来源是 WE 的应用级设置（general.user.postprocessing），不属于任何壁纸字段。
// 设计：docs/superpowers/specs/2026-09-20-app-level-glow-design.md。
export interface GlowOptions {
  threshold?: number;
  strength?: number;
}

/** 离线实验 A 档（最贴桌面）：见 spec §2.2。 */
export const GLOW_DEFAULTS = { threshold: 0.65, strength: 1.0 } as const;

const THRESHOLD_MAX = 0.99; // 不允许 1：bright-pass 的分母是 (1 - t)
const STRENGTH_MAX = 4;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 参数归一：缺省 / NaN / 越界一律收敛到合法区间，绝不把非法值灌进 uniform。 */
export function normalizeGlowOptions(opts?: GlowOptions): Required<GlowOptions> {
  const t = Number(opts?.threshold);
  const s = Number(opts?.strength);
  return {
    threshold: Number.isFinite(t) ? clamp(t, 0, THRESHOLD_MAX) : GLOW_DEFAULTS.threshold,
    strength: Number.isFinite(s) ? clamp(s, 0, STRENGTH_MAX) : GLOW_DEFAULTS.strength,
  };
}

/** 三级降采样 RT 尺寸（L1 = 1/2、L2 = 1/4、L3 = 1/8），逐级取半且不小于 1px。 */
export function glowLevelSizes(width: number, height: number): Array<{ w: number; h: number }> {
  const out: Array<{ w: number; h: number }> = [];
  let w = Math.max(1, Math.floor(width));
  let h = Math.max(1, Math.floor(height));
  for (let i = 0; i < 3; i++) {
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
    out.push({ w, h });
  }
  return out;
}
