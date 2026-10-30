// 从封面位图提取 WE MediaThumbnailEvent 需要的主/次/三色与对比色（启发式近似，非 WE 原算法）。
import type { MediaPalette, MediaRgb } from '../shared/media.js';

const SAMPLE = 32;

/** 无可用像素（全透明/解码失败）时的中性调色板：不影响任何图层可见性。 */
const NEUTRAL: MediaPalette = {
  primary: [0, 0, 0], secondary: [0, 0, 0], tertiary: [0, 0, 0], text: [1, 1, 1], highContrast: [1, 1, 1],
};

const luminance = (c: MediaRgb): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** 像素（RGBA，任意尺寸）→ 调色板：4-bit/通道直方图，按覆盖面积取主/次/三色；全透明 → 中性。 */
export function paletteFromPixels(width: number, height: number, rgba: Uint8ClampedArray): MediaPalette {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  const count = Math.min(width * height, rgba.length >> 2);
  for (let i = 0; i < count; i += 1) {
    const a = rgba[i * 4 + 3]!;
    if (a < 32) continue; // 近似全透明的像素不参与取色
    const r = rgba[i * 4]!; const g = rgba[i * 4 + 1]!; const b = rgba[i * 4 + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4); // 4-bit/通道直方图
    const box = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    box.n += 1; box.r += r; box.g += g; box.b += b; buckets.set(key, box);
    total += 1;
  }
  if (total === 0) return NEUTRAL;
  const colors = [...buckets.values()]
    .map((box) => ({
      n: box.n,
      rgb: [box.r / box.n / 255, box.g / box.n / 255, box.b / box.n / 255] as MediaRgb,
    }))
    .sort((a, b) => b.n - a.n)
    .map((c) => c.rgb);
  const primary = colors[0]!;
  const secondary = colors[1] ?? colors[0]!;
  const tertiary = colors[2] ?? secondary;
  const contrast = (c: MediaRgb): number => Math.abs(luminance(c) - luminance(primary));
  const candidates: MediaRgb[] = [secondary, tertiary, [0, 0, 0], [1, 1, 1]];
  const text = candidates.reduce(
    (best, c) => (contrast(c) > contrast(best) ? c : best),
    [1, 1, 1] as MediaRgb,
  );
  const highContrast: MediaRgb = luminance(primary) > 0.5 ? [0, 0, 0] : [1, 1, 1];
  return { primary, secondary, tertiary, text, highContrast };
}

/** 位图 → 32×32 降采样 → 调色板（无 canvas/像素读取失败 → 中性）。 */
export async function paletteFromImage(source: ImageBitmap | HTMLImageElement): Promise<MediaPalette> {
  const w = source.width;
  const h = source.height;
  if (!w || !h || typeof document === 'undefined') return NEUTRAL;
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE; canvas.height = SAMPLE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return NEUTRAL;
  ctx.drawImage(source, 0, 0, SAMPLE, SAMPLE);
  return paletteFromPixels(SAMPLE, SAMPLE, ctx.getImageData(0, 0, SAMPLE, SAMPLE).data);
}
