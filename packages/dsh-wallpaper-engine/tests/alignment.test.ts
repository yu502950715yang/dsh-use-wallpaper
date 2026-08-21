import { describe, expect, it } from 'vitest';
import { alignmentOffset, applyAlignment } from '../src/client/alignment.js';

// T4.1：WE 对象 alignment 锚点 → 中心偏移（共享纯函数，scene-renderer 与 wasm-renderer 共用）。
// WE 坐标约定（AGENT.md §2.3）：左下原点、y 向上，不做 y 翻转——'top' 锚点=顶边，
// 中心在锚点下方（offset.y = -0.5）、'bottom' 锚点=底边，中心在锚点上方（offset.y = +0.5）；
// 但 offset 直接加进 origin（center = origin + offset×size），故：
//   'topleft' → [0.5, 0.5]（锚点是左上角，中心在锚点右上方）；
//   'bottomright' → [-0.5, -0.5]（锚点是右下角，中心在锚点左下方）。
describe('alignmentOffset（alignment → 中心偏移，对象尺寸的分数）', () => {
  it('center / undefined / 未知值 → [0,0]（origin 即中心，无偏移）', () => {
    expect(alignmentOffset('center')).toEqual([0, 0]);
    expect(alignmentOffset(undefined)).toEqual([0, 0]);
    expect(alignmentOffset('gibberish' as string)).toEqual([0, 0]);
  });
  it('9 种 WE 对齐值 → 期望的分数偏移（y 向上不翻转）', () => {
    // 四角：对角线方向偏移 ±0.5
    expect(alignmentOffset('topleft')).toEqual([0.5, 0.5]);
    expect(alignmentOffset('topright')).toEqual([-0.5, 0.5]);
    expect(alignmentOffset('bottomright')).toEqual([-0.5, -0.5]);
    expect(alignmentOffset('bottomleft')).toEqual([0.5, -0.5]);
    // 四边：仅单轴偏移
    expect(alignmentOffset('top')).toEqual([0, 0.5]);
    expect(alignmentOffset('right')).toEqual([-0.5, 0]);
    expect(alignmentOffset('bottom')).toEqual([0, -0.5]);
    expect(alignmentOffset('left')).toEqual([0.5, 0]);
    // 中心
    expect(alignmentOffset('center')).toEqual([0, 0]);
  });
});

describe('applyAlignment（锚点 origin → 中心 = origin + offset×worldSize）', () => {
  it('bottomright：center = origin + (-w/2, -h/2)（2937346640 Simple Visualizer 实测形态）', () => {
    expect(applyAlignment([113.7, 83.1, 0], [4, 4], 'bottomright')).toEqual([111.7, 81.1, 0]);
  });
  it('topleft：center = origin + (+w/2, +h/2)', () => {
    expect(applyAlignment([100, 100, 0], [10, 20], 'topleft')).toEqual([105, 110, 0]);
  });
  it('center → origin 不变（无偏移，默认语义）', () => {
    expect(applyAlignment([100, 100, 0], [10, 20], 'center')).toEqual([100, 100, 0]);
    expect(applyAlignment([100, 100, 0], [10, 20], undefined)).toEqual([100, 100, 0]);
  });
  it('top / bottom / left / right：仅对应轴偏移 ±h/2 或 ±w/2', () => {
    expect(applyAlignment([0, 0, 0], [10, 20], 'top')).toEqual([0, 10, 0]);
    expect(applyAlignment([0, 0, 0], [10, 20], 'bottom')).toEqual([0, -10, 0]);
    expect(applyAlignment([0, 0, 0], [10, 20], 'left')).toEqual([5, 0, 0]);
    expect(applyAlignment([0, 0, 0], [10, 20], 'right')).toEqual([-5, 0, 0]);
  });
  it('保留 z 分量（偏移只作用 x/y 平面）', () => {
    expect(applyAlignment([1, 2, 3], [10, 20], 'topleft')).toEqual([6, 12, 3]);
  });
});
