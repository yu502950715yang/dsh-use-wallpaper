import { describe, expect, it } from 'vitest';
import { parseTex, glFormatForDds, TEX_FORMAT } from '../src/client/tex-loader.js';
import { makeTex } from './fixtures/make-tex.js';

describe('glFormatForDds', () => {
  it('maps fourCC to GL compressed formats', () => {
    expect(glFormatForDds('DXT1')).toBe(0x83f1);
    expect(glFormatForDds('DXT3')).toBe(0x83f2);
    expect(glFormatForDds('DXT5')).toBe(0x83f3);
    expect(glFormatForDds('BC4U')).toBe(0x8dbb);
    expect(glFormatForDds('BC4S')).toBe(0x8dbc);
    expect(glFormatForDds('BC5U')).toBe(0x8dbd);
    expect(glFormatForDds('BC5S')).toBe(0x8dbe);
    expect(glFormatForDds('????')).toBe(0);
  });
});

describe('parseTex', () => {
  it('解析 header：ImageSize 作为 width/height，texture 尺寸与 format 单独保留', () => {
    const buf = makeTex({
      format: TEX_FORMAT.RGBA8888,
      flags: 2,
      textureWidth: 64,
      textureHeight: 32,
      imageWidth: 60,
      imageHeight: 30,
      images: [[{ width: 64, height: 32, data: new Uint8Array(64 * 32 * 4).fill(7) }]],
    });
    const info = parseTex(buf)!;
    expect(info.format).toBe(TEX_FORMAT.RGBA8888);
    expect(info.flags).toBe(2);
    expect(info.textureWidth).toBe(64);
    expect(info.textureHeight).toBe(32);
    expect(info.width).toBe(60);   // ImageWidth
    expect(info.height).toBe(30);  // ImageHeight
    expect(info.mipmaps).toHaveLength(1);
  });

  it('解析 mipmap 数量与尺寸（未压缩数据原样返回）', () => {
    const mips = [
      { width: 64, height: 32, data: new Uint8Array(64 * 32 * 4).fill(1) },
      { width: 32, height: 16, data: new Uint8Array(32 * 16 * 4).fill(2) },
      { width: 16, height: 8, data: new Uint8Array(16 * 8 * 4).fill(3) },
    ];
    const buf = makeTex({ format: TEX_FORMAT.RGBA8888, images: [mips] });
    const info = parseTex(buf)!;
    expect(info.mipmaps).toHaveLength(3);
    expect(info.mipmaps[0].width).toBe(64);
    expect(info.mipmaps[0].height).toBe(32);
    expect(info.mipmaps[1].width).toBe(32);
    expect(info.mipmaps[1].height).toBe(16);
    expect(info.mipmaps[0].data).toEqual(mips[0].data);
    expect(info.mipmaps[2].data).toEqual(mips[2].data);
  });

  it('LZ4 压缩 mipmap 解压后与原始数据一致（混合 lz4=0/1）', () => {
    const raw0 = new Uint8Array(128 * 64 * 4);
    const raw1 = new Uint8Array(64 * 32 * 4);
    for (let i = 0; i < raw0.length; i++) raw0[i] = (i * 31) & 0xff; // 有规律、可压缩
    for (let i = 0; i < raw1.length; i++) raw1[i] = (i * 7 + 3) & 0xff;
    const buf = makeTex({
      format: TEX_FORMAT.RGBA8888,
      images: [[
        { width: 128, height: 64, data: raw0, lz4: true },
        { width: 64, height: 32, data: raw1, lz4: false },
      ]],
    });
    const info = parseTex(buf)!;
    expect(info.mipmaps).toHaveLength(2);
    expect(info.mipmaps[0].data).toEqual(raw0); // LZ4 解压往返
    expect(info.mipmaps[1].data).toEqual(raw1);
  });

  it('DXT1 压缩纹理（format=7）：块数据按原样解出', () => {
    const blocks = new Uint8Array(8 * (64 / 4) * (32 / 4)).fill(0xff); // BC1 每块 8B
    const buf = makeTex({ format: TEX_FORMAT.DXT1, images: [[{ width: 64, height: 32, data: blocks }]] });
    const info = parseTex(buf)!;
    expect(info.format).toBe(TEX_FORMAT.DXT1);
    expect(info.mipmaps[0].data).toEqual(blocks);
  });

  it('支持 TEXB0001 容器（mipmap 无 LZ4 字段）', () => {
    const data = new Uint8Array(32 * 16 * 4).fill(9);
    const buf = makeTex({ container: 'TEXB0001', images: [[{ width: 32, height: 16, data }]] });
    const info = parseTex(buf)!;
    expect(info.mipmaps).toHaveLength(1);
    expect(info.mipmaps[0].data).toEqual(data);
  });

  it('多 image 支持：imageCount 与各 image 的 mipmap 均解析', () => {
    const buf = makeTex({
      images: [
        [{ width: 16, height: 16, data: new Uint8Array(16 * 16 * 4).fill(1) }],
        [
          { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(2) },
          { width: 4, height: 4, data: new Uint8Array(4 * 4 * 4).fill(3) },
        ],
      ],
    });
    const info = parseTex(buf)!;
    expect(info.mipmaps).toHaveLength(3);
  });

  it('非 TEXV0005 返回 null', () => {
    expect(parseTex(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(parseTex(new TextEncoder().encode('WETEX1234'))).toBeNull();
    expect(parseTex(new TextEncoder().encode('TEXV0004\0TEXI0001\0'))).toBeNull();
  });

  it('截断容错：数据/字段被截断时返回 null 而非抛错', () => {
    const full = makeTex({
      images: [[
        { width: 64, height: 32, data: new Uint8Array(64 * 32 * 4).fill(5), lz4: true },
        { width: 32, height: 16, data: new Uint8Array(32 * 16 * 4).fill(6) },
      ]],
    });
    for (const cut of [0, 1, 4, 12, 40, 100, full.length - 1]) {
      const truncated = new Uint8Array(full.subarray(0, Math.max(0, full.length - cut)));
      expect(() => parseTex(truncated)).not.toThrow();
      if (cut > 0) expect(parseTex(truncated)).toBeNull();
    }
  });
});
