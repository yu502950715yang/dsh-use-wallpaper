import { describe, it, expect } from 'vitest';
import { buildInitialObjectState, normalizeReadback } from '../src/client/scene-script.js';

describe('buildInitialObjectState', () => {
  it('构造 origin/scale/image.alpha 嵌套状态', () => {
    const s = buildInitialObjectState([1, 2, 0], [2, 2, 1], 0.5, 1.5);
    expect(s.origin).toEqual({ x: 1, y: 2, z: 0 });
    expect(s.scale).toEqual({ x: 2, y: 2, z: 1 });
    expect(s.alpha).toBe(0.5);
    expect(s.image.alpha).toBe(0.5);
    expect(s.image.brightness).toBe(1.5);
  });
});

describe('normalizeReadback', () => {
  it('clamp imageAlpha 到 0-1', () => {
    const rb = normalizeReadback({ imageAlpha: 1.7 });
    expect(rb.imageAlpha).toBe(1);
    const rb2 = normalizeReadback({ imageAlpha: -0.2 });
    expect(rb2.imageAlpha).toBe(0);
  });

  it('仅输出有值的字段（origin 缺省保留 undefined）', () => {
    const rb = normalizeReadback({ imageAlpha: 0.4 });
    expect(rb.origin).toBeUndefined();
    expect(rb.imageAlpha).toBe(0.4);
  });

  it('origin/scale 原样保留', () => {
    const rb = normalizeReadback({ origin: { x: 1, y: 2, z: 0 }, scale: { x: 3, y: 3, z: 1 } });
    expect(rb.origin).toEqual({ x: 1, y: 2, z: 0 });
    expect(rb.scale).toEqual({ x: 3, y: 3, z: 1 });
  });
});
