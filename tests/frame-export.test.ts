// 帧导出纯函数（v0.8 Task 6）：GL 底行在上 → 图像行序的翻转；RGBA → PNG 编码（可注入 encoder）。
// node 环境没有 OffscreenCanvas/ImageData，默认编码路径在此只覆盖「不支持 → null」。
import { describe, expect, it, vi } from 'vitest';
import { encodeRgbaToPng, flipRgbaRows, readPixelsToPng, type RgbaEncoder } from '../src/client/frame-export.js';

describe('flipRgbaRows', () => {
  it('flipRgbaRows 上下翻转（每行 4 字节像素）', () => {
    const src = Uint8Array.from([1, 1, 1, 1, 2, 2, 2, 2]);
    expect([...flipRgbaRows(src, 1, 2)]).toEqual([2, 2, 2, 2, 1, 1, 1, 1]);
  });

  it('多列多行只倒序行、不碰行内像素', () => {
    const src = Uint8Array.from([
      1, 1, 1, 1, 2, 2, 2, 2,
      3, 3, 3, 3, 4, 4, 4, 4,
      5, 5, 5, 5, 6, 6, 6, 6,
    ]);
    expect([...flipRgbaRows(src, 2, 3)]).toEqual([
      5, 5, 5, 5, 6, 6, 6, 6,
      3, 3, 3, 3, 4, 4, 4, 4,
      1, 1, 1, 1, 2, 2, 2, 2,
    ]);
  });

  it('单行 / 零高不抛错', () => {
    const src = Uint8Array.from([9, 9, 9, 9]);
    expect([...flipRgbaRows(src, 1, 1)]).toEqual([9, 9, 9, 9]);
    expect([...flipRgbaRows(new Uint8Array(0), 1, 0)]).toEqual([]);
  });
});

describe('encodeRgbaToPng', () => {
  it('encodeRgbaToPng 注入 encoder 时返回其字节；encoder 抛错返回 null', async () => {
    const enc = async () => Uint8Array.from([9, 9]);
    await expect(encodeRgbaToPng(new Uint8Array(4), 1, 1, enc)).resolves.toEqual(Uint8Array.from([9, 9]));
    await expect(encodeRgbaToPng(new Uint8Array(4), 1, 1, async () => { throw new Error('x'); })).resolves.toBeNull();
  });

  it('注入 encoder 收到原始 rgba 与尺寸（不在编码层翻转）', async () => {
    const enc = vi.fn<RgbaEncoder>(async () => Uint8Array.from([7]));
    const rgba = Uint8Array.from([1, 2, 3, 4]);
    await encodeRgbaToPng(rgba, 1, 1, enc);
    expect(enc).toHaveBeenCalledWith(rgba, 1, 1);
  });

  it('默认编码环境不支持（node 无 OffscreenCanvas）→ null，不抛', async () => {
    await expect(encodeRgbaToPng(new Uint8Array(4), 1, 1)).resolves.toBeNull();
  });

  it('零/非法尺寸 → null（不调用默认编码器）', async () => {
    await expect(encodeRgbaToPng(new Uint8Array(4), 0, 1)).resolves.toBeNull();
    await expect(encodeRgbaToPng(new Uint8Array(4), 1, -1)).resolves.toBeNull();
  });
});

describe('readPixelsToPng（fake gl）', () => {
  it('读默认 framebuffer 的 RGBA → 翻成图像行序 → 交 encoder', async () => {
    const readPixels = vi.fn(
      (_x: number, _y: number, _w: number, _h: number, _f: number, _t: number, out: Uint8Array) => {
        out.set([1, 1, 1, 1, 2, 2, 2, 2]);
      },
    );
    const gl = { RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, readPixels };
    const enc = vi.fn(async (rgba: Uint8Array) => rgba);
    await expect(readPixelsToPng(gl, 1, 2, enc)).resolves.toEqual(Uint8Array.from([2, 2, 2, 2, 1, 1, 1, 1]));
    expect(readPixels).toHaveBeenCalledWith(0, 0, 1, 2, 0x1908, 0x1401, expect.any(Uint8Array));
    expect(enc).toHaveBeenCalledWith(Uint8Array.from([2, 2, 2, 2, 1, 1, 1, 1]), 1, 2);
  });

  it('readPixels 抛错 / 尺寸非法 → null', async () => {
    const gl = {
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      readPixels: () => { throw new Error('gl lost'); },
    };
    await expect(readPixelsToPng(gl, 1, 1, async () => Uint8Array.from([1]))).resolves.toBeNull();
    await expect(readPixelsToPng(gl, 0, 1, async () => Uint8Array.from([1]))).resolves.toBeNull();
  });
});
