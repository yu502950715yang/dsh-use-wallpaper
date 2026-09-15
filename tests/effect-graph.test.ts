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
  it('base 非法（NaN / Infinity）→ 也按 1（导出 API 不透出 NaN / Infinity 尺寸）', () => {
    expect(namedRtSize(Number.NaN, 600, 4)).toEqual({ width: 1, height: 150 });
    expect(namedRtSize(Number.POSITIVE_INFINITY, 600, 4)).toEqual({ width: 1, height: 150 });
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
    // 链 0 超限被整体丢弃 → 不产出 pass；链 1 正常产出（Task 2 起 passes 真正生成）
    expect(plan.passes.map((p) => [p.chainIndex, p.passIndex])).toEqual([[1, 0]]);
  });
  it('base 非法（0 / NaN）→ 按 1 计算，不产生 0 尺寸 RT', () => {
    const plan = buildEffectPlan([[pass({ target: '_rt_a' })]], { baseWidth: 0, baseHeight: Number.NaN });
    expect([plan.namedTargets[0].width, plan.namedTargets[0].height]).toEqual([1, 1]);
  });
});

describe('buildEffectPlan — bind 覆盖项（读端）', () => {
  it('bind.index 就是 g_Texture<index>（不是 index+1）：index 0 与 1 分别落槽', () => {
    const chain = [
      pass({ target: '_rt_F' }),
      pass({ bind: [{ index: 0, name: '_rt_F' }, { index: 1, name: 'previous' }] }),
    ];
    const plan = buildEffectPlan([chain], { baseWidth: 10, baseHeight: 10 });
    expect(plan.passes[1].bindings).toEqual([
      { slot: 0, source: { type: 'named', key: '0:_rt_F' } },
      { slot: 1, source: { type: 'previous' } },
    ]);
  });
  it('blur 的 combine 形态：bind[2]=previous 落在 slot 2，且 slot 0 仍绑具名 RT', () => {
    const fb = { _rt_Q1: 4 };
    const chain = [
      pass({ target: '_rt_Q1', fboScale: fb }),
      pass({ target: '_rt_Q1', fboScale: fb }),
      pass({ bind: [{ index: 0, name: '_rt_Q1' }, { index: 2, name: 'previous' }], fboScale: fb }),
    ];
    const plan = buildEffectPlan([chain], { baseWidth: 100, baseHeight: 100 });
    expect(plan.passes[2].bindings).toEqual([
      { slot: 0, source: { type: 'named', key: '0:_rt_Q1' } },
      { slot: 2, source: { type: 'previous' } },
    ]);
    expect(plan.passes[2].unresolvedBinds).toBeUndefined();
  });
  it('链内不存在的名字（_rt_FullFrameBuffer）→ 不产出覆盖项 + 记入 unresolvedBinds', () => {
    const chain = [
      pass({ target: '_rt_H' }),
      pass({ bind: [{ index: 0, name: '_rt_H' }, { index: 2, name: '_rt_FullFrameBuffer' }] }),
    ];
    const plan = buildEffectPlan([chain], { baseWidth: 10, baseHeight: 10 });
    expect(plan.passes[1].bindings).toEqual([{ slot: 0, source: { type: 'named', key: '0:_rt_H' } }]);
    expect(plan.passes[1].unresolvedBinds).toEqual(['_rt_FullFrameBuffer']);
  });
  it('空名 bind → 记入 unresolvedBinds（不猜语义，保持该槽默认）', () => {
    const chain = [pass({ bind: [{ index: 1, name: '' }] })];
    const plan = buildEffectPlan([chain], { baseWidth: 10, baseHeight: 10 });
    expect(plan.passes[0].bindings).toEqual([]);
    expect(plan.passes[0].unresolvedBinds).toEqual(['']);
  });
  it('passIndex 保留链内下标、chainIndex 保留链序（多链不串位）', () => {
    const plan = buildEffectPlan([[pass(), pass()], [pass()]], { baseWidth: 10, baseHeight: 10 });
    expect(plan.passes.map((p) => [p.chainIndex, p.passIndex])).toEqual([[0, 0], [0, 1], [1, 0]]);
  });
  it('blendMode 与 target 名随 pass 带出（供执行器与诊断使用）', () => {
    const chain = [pass({ target: '_rt_F', blendMode: 'additive' })];
    const plan = buildEffectPlan([chain], { baseWidth: 10, baseHeight: 10 });
    expect(plan.passes[0].blendMode).toBe('additive');
    expect(plan.passes[0].target).toBe('_rt_F');
  });
});
