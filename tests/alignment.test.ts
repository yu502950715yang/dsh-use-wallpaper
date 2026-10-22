// v0.8.2 F13：image alignment 的锚点 → 中心偏移纯函数。
// 语义与 WE `WPImageAlignment.hpp::ResolveImageAlignmentOffset` 同向：origin 钉在命名边/角
// （left/top 等），中心相对 origin 偏移半个尺寸；与 text anchor（textLayerOffset）同一口径。
import { describe, expect, it } from 'vitest';
import { alignOffset } from '../src/client/alignment.js';

describe('alignOffset（WE image alignment）', () => {
  it('9 种对齐 → 锚点→中心偏移（100×50：left +50 / right -50 / top -25 / bottom +25）', () => {
    expect(alignOffset(100, 50, 'center')).toEqual({ x: 0, y: 0 });
    expect(alignOffset(100, 50, 'left')).toEqual({ x: 50, y: 0 });
    expect(alignOffset(100, 50, 'right')).toEqual({ x: -50, y: 0 });
    expect(alignOffset(100, 50, 'top')).toEqual({ x: 0, y: -25 });
    expect(alignOffset(100, 50, 'bottom')).toEqual({ x: 0, y: 25 });
    expect(alignOffset(100, 50, 'topleft')).toEqual({ x: 50, y: -25 });
    expect(alignOffset(100, 50, 'topright')).toEqual({ x: -50, y: -25 });
    expect(alignOffset(100, 50, 'bottomleft')).toEqual({ x: 50, y: 25 });
    expect(alignOffset(100, 50, 'bottomright')).toEqual({ x: -50, y: 25 });
  });

  it('缺省 / center / none / 未知值 → 无偏移（fail-open，不抛错）', () => {
    expect(alignOffset(100, 50, undefined)).toEqual({ x: 0, y: 0 });
    expect(alignOffset(100, 50, 'none')).toEqual({ x: 0, y: 0 });
    expect(alignOffset(100, 50, 'weird')).toEqual({ x: 0, y: 0 });
  });

  it('尺寸取幅值（负 scale 的镜像由调用方乘回）、非有限尺寸按 0', () => {
    expect(alignOffset(-100, -50, 'topleft')).toEqual({ x: 50, y: -25 });
    expect(alignOffset(Number.NaN, 50, 'left')).toEqual({ x: 0, y: 0 });
  });
});
