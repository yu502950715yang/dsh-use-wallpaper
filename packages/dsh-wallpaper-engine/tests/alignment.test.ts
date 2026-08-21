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
  it('T4.4 负 worldSize（scale.y<0 镜像）：锚点对 scale 符号不变（对齐参考实现：偏移烘焙进未缩放几何空间、节点 scale 绕 origin 缩放）', () => {
    // 参考实现（open-wallpaper-engine SceneImageObjectParser）：alignment_offset 用
    // 未缩放 geometry_size 计算并烘焙进网格，scale 绕 origin 缩放 → 锚点恒钉在 origin，
    // 负 scale 的镜像绕锚点翻转内容而非挪动锚点。故 worldSize 须按幅值参与偏移：
    // 'bottomright' 锚点是右下角 → center = origin - (|w|/2, |h|/2) = (-5, -10)。
    expect(applyAlignment([0, 0, 0], [10, -20], 'bottomright')).toEqual([-5, -10, 0]);
    // 'top' 锚点是顶边 → center = origin + (0, |h|/2)（镜像后内容绕锚点翻转）
    expect(applyAlignment([100, 100, 0], [10, -20], 'top')).toEqual([100, 110, 0]);
    // 负 scale.x 同理（水平镜像不改变锚点）
    expect(applyAlignment([50, 50, 0], [-10, 20], 'bottomleft')).toEqual([55, 40, 0]);
  });
});
