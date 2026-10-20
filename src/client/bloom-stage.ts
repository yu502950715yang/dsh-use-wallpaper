// 壁纸级 bloom（WE general.bloom*）：复用应用级 Glow 的管线，仅缺省参数不同（作者设定）。
import { createGlowStage, type GlowStage } from './glow-stage.js';

export interface BloomOptions {
  strength?: number;
  threshold?: number;
}

// WE 壁纸 bloom 缺省：strength=2、threshold=0.65。与 Glow 的 0.35 缺省有意不同，不共用常量。
const BLOOM_STRENGTH = 2;
const BLOOM_THRESHOLD = 0.65;

/** 创建壁纸级 bloom stage；非法视口返回 null（与 createGlowStage 同一契约）。 */
export function createBloomStage(
  width: number,
  height: number,
  opts?: BloomOptions,
): GlowStage | null {
  const strength = Number.isFinite(opts?.strength) ? (opts!.strength as number) : BLOOM_STRENGTH;
  const threshold = Number.isFinite(opts?.threshold) ? (opts!.threshold as number) : BLOOM_THRESHOLD;
  return createGlowStage(width, height, { strength, threshold });
}
