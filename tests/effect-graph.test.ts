// RT 图执行计划的纯函数单测（语义依据见 docs/superpowers/specs/2026-09-15-three-rt-graph-executor-design.md）。
import { describe, expect, it } from 'vitest';
import {
  buildEffectPlan, namedRtKey, namedRtScale, namedRtSize, NAMED_RT_LIMIT,
} from '../src/client/effect-graph.js';
import type { CompiledEffectPass } from '../src/client/shader/effect-chain.js';

// 最小 CompiledEffectPass：只填本文件关心的字段。
function pass(over: Partial<CompiledEffectPass> = {}): CompiledEffectPass {
  return {
    vertSrc: '', fragSrc: '', rawVert: '', rawFrag: '',
    combos: {}, uniforms: new Map(), textureSlots: [], samplerModes: {},
    blendMode: 'normal', target: null, bind: [], fboScale: {},
    ...over,
  };
}

describe('namedRtKey / namedRtScale / namedRtSize（具名 RT 口径）', () => {
  it('key 带链序号 → 两条链的同名 RT 互不覆盖', () => {
    expect(namedRtKey(0, '_rt_Q1')).toBe('0:_rt_Q1');
    expect(namedRtKey(1, '_rt_Q1')).toBe('1:_rt_Q1');
  });
  it('scale 缺失 / 0 / 负 / NaN → 1（缺省全尺寸）', () => {
    expect(namedRtScale({}, '_rt_a')).toBe(1);
    expect(namedRtScale({ _rt_a: 0 }, '_rt_a')).toBe(1);
    expect(namedRtScale({ _rt_a: -4 }, '_rt_a')).toBe(1);
    expect(namedRtScale({ _rt_a: Number.NaN }, '_rt_a')).toBe(1);
    expect(namedRtScale(undefined, '_rt_a')).toBe(1);
  });
  it('scale 正常值原样返回（含小数）', () => {
    expect(namedRtScale({ _rt_a: 4 }, '_rt_a')).toBe(4);
    expect(namedRtScale({ _rt_a: 1.5 }, '_rt_a')).toBe(1.5);
  });
  it('尺寸 = base ÷ scale，四舍五入，下限 1', () => {
    expect(namedRtSize(1000, 600, 4)).toEqual({ width: 250, height: 150 });
    expect(namedRtSize(1000, 600, 2)).toEqual({ width: 500, height: 300 });
    expect(namedRtSize(1000, 600, 3)).toEqual({ width: 333, height: 200 });
    expect(namedRtSize(1, 1, 4)).toEqual({ width: 1, height: 1 });
  });
  it('scale 非法 / 0 / 负 → 按 1（导出 API 自身设防，不透出 Infinity / NaN）', () => {
    expect(namedRtSize(1000, 600, 0)).toEqual({ width: 1000, height: 600 });
    expect(namedRtSize(1000, 600, Number.NaN)).toEqual({ width: 1000, height: 600 });
    expect(namedRtSize(1000, 600, -2)).toEqual({ width: 1000, height: 600 });
  });
});

describe('buildEffectPlan — 具名 RT 清单', () => {
  it('按 target 建表（同名多 pass 只建一张），scale 查 fbos', () => {
    const fb = { _rt_Q1: 4, _rt_Q2: 4 };
    const chain = [
      pass({ target: '_rt_Q1', fboScale: fb }),
      pass({ target: '_rt_Q2', fboScale: fb }),
      pass({ target: '_rt_Q1', fboScale: fb }),
      pass({ fboScale: fb }),
    ];
    const plan = buildEffectPlan([chain], { baseWidth: 1000, baseHeight: 600 });
    expect(plan.namedTargets).toEqual([
      { key: '0:_rt_Q1', name: '_rt_Q1', width: 250, height: 150 },
      { key: '0:_rt_Q2', name: '_rt_Q2', width: 250, height: 150 },
    ]);
  });
  it('target 出现但 fbos 未声明 → 照建、scale=1（GTR 的 blur_start_* 形态）', () => {
    const chain = [pass({ target: 'blur_start_2' }), pass({ target: 'blur_end_2' })];
    const plan = buildEffectPlan([chain], { baseWidth: 1000, baseHeight: 600 });
    expect(plan.namedTargets.map((t) => [t.name, t.width, t.height])).toEqual([
      ['blur_start_2', 1000, 600],
      ['blur_end_2', 1000, 600],
    ]);
  });
  it('两条链同名 RT → 各持一份', () => {
    const chain = [pass({ target: '_rt_Q1', fboScale: { _rt_Q1: 4 } })];
    const plan = buildEffectPlan([chain, chain], { baseWidth: 800, baseHeight: 400 });
    expect(plan.namedTargets.map((t) => t.key)).toEqual(['0:_rt_Q1', '1:_rt_Q1']);
  });
  it('单链具名 RT 超上限 → 该链进 droppedChains 且不产出 pass', () => {
    const many = Array.from({ length: NAMED_RT_LIMIT + 1 }, (_, i) => pass({ target: `_rt_${i}` }));
    const plan = buildEffectPlan([many, [pass({ target: '_rt_ok' })]], { baseWidth: 100, baseHeight: 100 });
    expect(plan.droppedChains).toEqual([0]);
    expect(plan.namedTargets.map((t) => t.key)).toEqual(['1:_rt_ok']);
    // passes 由后续任务产出（本任务恒为空），届时升级为「链 0 无 pass / 链 1 有 pass」的真断言
    expect(plan.passes).toEqual([]);
  });
  it('base 非法（0 / NaN）→ 按 1 计算，不产生 0 尺寸 RT', () => {
    const plan = buildEffectPlan([[pass({ target: '_rt_a' })]], { baseWidth: 0, baseHeight: Number.NaN });
    expect([plan.namedTargets[0].width, plan.namedTargets[0].height]).toEqual([1, 1]);
  });
});
