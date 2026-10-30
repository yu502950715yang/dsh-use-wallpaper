import type { MediaPalette } from '../shared/media.js';
/** 像素（RGBA，任意尺寸）→ 调色板：4-bit/通道直方图，按覆盖面积取主/次/三色；全透明 → 中性。 */
export declare function paletteFromPixels(width: number, height: number, rgba: Uint8ClampedArray): MediaPalette;
/** 位图 → 32×32 降采样 → 调色板（无 canvas/像素读取失败 → 中性）。 */
export declare function paletteFromImage(source: ImageBitmap | HTMLImageElement): Promise<MediaPalette>;
