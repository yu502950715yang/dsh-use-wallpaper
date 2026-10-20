// 壁纸级 bloom（F8）：createBloomStage 是 createGlowStage 的薄封装，但缺省参数与 Glow 不同
// （strength=2 vs 0.35）⇒ 不得共用缺省常量。
import { describe, expect, it } from 'vitest';
import { createBloomStage } from '../src/client/bloom-stage.js';
import { GLOW_DEFAULTS } from '../src/client/glow-stage.js';

type Options = { threshold: number; strength: number };
const optionsOf = (stage: unknown): Options =>
  (stage as { options: Options }).options; // 诊断字段不在 GlowStage 接口里（仅测试观测）

describe('createBloomStage（壁纸级 bloom 参数）', () => {
  it('缺省 strength=2 / threshold=0.65（不复用 Glow 的 0.35 缺省）', () => {
    const stage = createBloomStage(1920, 1080);
    expect(optionsOf(stage)).toEqual({ threshold: 0.65, strength: 2 });
    expect(optionsOf(stage).strength).not.toBe(GLOW_DEFAULTS.strength);
    stage?.dispose();
  });

  it('作者参数原样下发（2454403969 实测 bloomstrength=0.98）', () => {
    const stage = createBloomStage(1920, 1080, { strength: 0.98, threshold: 0.65 });
    expect(optionsOf(stage)).toEqual({ threshold: 0.65, strength: 0.98 });
    stage?.dispose();
  });

  it('非法值回退 bloom 缺省；越界值交给 Glow 归一（strength→4、threshold→0.99）', () => {
    expect(optionsOf(createBloomStage(1920, 1080, { strength: NaN, threshold: NaN })))
      .toEqual({ threshold: 0.65, strength: 2 });
    const clamped = createBloomStage(1920, 1080, { strength: 99, threshold: 5 });
    expect(optionsOf(clamped)).toEqual({ threshold: 0.99, strength: 4 });
    clamped?.dispose();
  });

  it('非法视口 → null（与 createGlowStage 同一契约）', () => {
    expect(createBloomStage(0, 0)).toBeNull();
  });
});
