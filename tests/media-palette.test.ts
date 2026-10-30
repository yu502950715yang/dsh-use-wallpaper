import { describe, expect, it } from 'vitest';
import { paletteFromPixels } from '../src/client/media-palette.js';

const solid = (r: number, g: number, b: number, n = 32 * 32) => {
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  return data;
};

describe('paletteFromPixels', () => {
  it('纯色图：primary/secondary/tertiary 都是该色；highContrast 取黑或白', () => {
    const p = paletteFromPixels(32, 32, solid(255, 0, 0));
    for (const rgb of [p.primary, p.secondary, p.tertiary]) {
      expect(rgb[0]).toBeCloseTo(1, 2); expect(rgb[1]).toBeCloseTo(0, 2); expect(rgb[2]).toBeCloseTo(0, 2);
    }
    expect([[0, 0, 0], [1, 1, 1]]).toContainEqual(p.highContrast);
  });
  it('黑/白边界：纯白图 primary≈白、highContrast=黑', () => {
    const p = paletteFromPixels(32, 32, solid(255, 255, 255));
    expect(p.primary[0]).toBeCloseTo(1, 2);
    expect(p.highContrast).toEqual([0, 0, 0]);
    const black = paletteFromPixels(32, 32, solid(0, 0, 0));
    expect(black.highContrast).toEqual([1, 1, 1]);
  });
  it('两色图：主色覆盖面积更大者', () => {
    const data = new Uint8ClampedArray(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i++) {
      const red = i % 4 !== 0;
      data[i * 4] = red ? 200 : 20; data[i * 4 + 1] = 20; data[i * 4 + 2] = 20; data[i * 4 + 3] = 255;
    }
    expect(paletteFromPixels(32, 32, data).primary[0]).toBeGreaterThan(0.5);
  });
  it('全透明/空像素 ⇒ 中性调色板（不抛错）', () => {
    const p = paletteFromPixels(4, 4, new Uint8ClampedArray(4 * 4 * 4));
    expect(p.primary).toEqual([0, 0, 0]);
  });
});
