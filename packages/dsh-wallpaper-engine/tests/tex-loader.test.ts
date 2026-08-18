import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { parseTex, glFormatForDds, TEX_FORMAT, textureFromTex, FIF } from '../src/client/tex-loader.js';
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

  it('支持 TEXB0003 容器：imageCount 后读 FreeImage 格式，mipmap 记录同 V2', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]); // 模拟 JPEG 字节流
    const buf = makeTex({ container: 'TEXB0003', imageFormat: 2 /* FIF_JPEG */, images: [[{ width: 32, height: 16, data: jpeg }]] });
    const info = parseTex(buf)!;
    expect(info.imageFormat).toBe(2);
    expect(info.mipmaps).toHaveLength(1);
    expect(info.mipmaps[0].data).toEqual(jpeg);
  });

  it('支持 TEXB0004 容器：额外读 isVideoMp4 标志', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
    const buf = makeTex({ container: 'TEXB0004', imageFormat: 2, images: [[{ width: 16, height: 8, data: jpeg }]] });
    const info = parseTex(buf)!;
    expect(info.imageFormat).toBe(2);
    expect(info.mipmaps).toHaveLength(1);
    expect(info.mipmaps[0].data).toEqual(jpeg);
  });

  it('TEXB0003 多 mipmap：逐层解析并保留顺序', () => {
    const buf = makeTex({
      container: 'TEXB0003', imageFormat: 13 /* FIF_PNG */,
      images: [[
        { width: 64, height: 32, data: new Uint8Array([1, 2, 3, 4]) },
        { width: 32, height: 16, data: new Uint8Array([5, 6, 7, 8]) },
      ]],
    });
    const info = parseTex(buf)!;
    expect(info.imageFormat).toBe(13);
    expect(info.mipmaps).toHaveLength(2);
    expect(info.mipmaps[0].width).toBe(64);
    expect(info.mipmaps[1].width).toBe(32);
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

// textureFromTex 的分支选择：TEXB0003+ 编码图像（imageFormat=JPEG/PNG/WEBP）即使
// format 字段仍为 RGBA8888(0)，mipmap 数据也是 JPEG/PNG 字节流，必须走 createImageBitmap
// 解码分支，而不是当原始 RGBA 创建 DataTexture（否则渲染乱码/失败）。
// 真实库样本：1429403119 的 waterripplenormal.tex（imgFmt=-1 原始 RGBA）、
// 2011060960 的 53.tex（imgFmt=13 PNG）、1968789468 的 wallhaven-2ew3pm.tex（imgFmt=2 JPEG）。
describe('textureFromTex 分支选择', () => {
  let decodeCalls: { blob: Blob; opts: object }[];

  beforeEach(() => {
    decodeCalls = [];
    vi.stubGlobal('createImageBitmap', async (blob: Blob, opts?: object) => {
      decodeCalls.push({ blob, opts: opts ?? {} });
      return { width: 32, height: 16, close: () => {} };
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('TEXB0003 + imageFormat=PNG(13) + format=RGBA8888(0)：走解码分支而非 DataTexture', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const buf = makeTex({
      container: 'TEXB0003', imageFormat: FIF.PNG, format: TEX_FORMAT.RGBA8888,
      images: [[{ width: 32, height: 16, data: png }]],
    });
    const tex = await textureFromTex(parseTex(buf)!);
    expect(tex).not.toBeNull();
    expect(tex).toBeInstanceOf(THREE.Texture);
    expect(tex).not.toBeInstanceOf(THREE.DataTexture); // 编码图像不是原始 RGBA
    expect(decodeCalls).toHaveLength(1);
    expect(decodeCalls[0].blob.type).toBe('image/png');
    expect(tex!.image).toEqual({ width: 32, height: 16, close: expect.any(Function) });
  });

  it('编码图像必须带 imageOrientation:flipY 解码且纹理 flipY=false（修复颠倒渲染）', async () => {
    // three.js 已知行为：texture.flipY 对 ImageBitmap 无效（翻转只能在 bitmap 创建时指定）。
    // WE tex 编码图像是 top-down（第一行=顶部），而 DataTexture 原始数据是 bottom-up；
    // 必须用 imageOrientation:'flipY' 在解码时翻转，使两条路径最终行序一致，否则渲染上下颠倒。
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const buf = makeTex({
      container: 'TEXB0003', imageFormat: FIF.JPEG, format: TEX_FORMAT.RGBA8888,
      images: [[{ width: 32, height: 16, data: jpeg }]],
    });
    const tex = await textureFromTex(parseTex(buf)!);
    expect(decodeCalls).toHaveLength(1);
    expect(decodeCalls[0].opts).toMatchObject({ imageOrientation: 'flipY' });
    expect(tex!.flipY).toBe(false); // 与 DataTexture 路径（flipY=false）方向语义一致
  });

  it('TEXB0003 + imageFormat=JPEG(2) + format=RGBA8888(0)：走解码分支', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const buf = makeTex({
      container: 'TEXB0003', imageFormat: FIF.JPEG, format: TEX_FORMAT.RGBA8888,
      images: [[{ width: 32, height: 16, data: jpeg }]],
    });
    const tex = await textureFromTex(parseTex(buf)!);
    expect(tex).not.toBeNull();
    expect(tex).not.toBeInstanceOf(THREE.DataTexture);
    expect(decodeCalls).toHaveLength(1);
    expect(decodeCalls[0].blob.type).toBe('image/jpeg');
  });

  it('TEXB0003 + imageFormat=WEBP(21)：走解码分支', async () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
    const buf = makeTex({
      container: 'TEXB0003', imageFormat: FIF.WEBP, format: TEX_FORMAT.RGBA8888,
      images: [[{ width: 32, height: 16, data: webp }]],
    });
    const tex = await textureFromTex(parseTex(buf)!);
    expect(tex).not.toBeNull();
    expect(tex).not.toBeInstanceOf(THREE.DataTexture);
    expect(decodeCalls).toHaveLength(1);
    expect(decodeCalls[0].blob.type).toBe('image/webp');
  });

  it('TEXB0003 + imageFormat=-1（原始 RGBA）→ 仍走 DataTexture（回归）', async () => {
    const rgba = new Uint8Array(32 * 16 * 4).fill(0x80);
    const buf = makeTex({
      container: 'TEXB0003', imageFormat: -1, format: TEX_FORMAT.RGBA8888,
      images: [[{ width: 32, height: 16, data: rgba }]],
    });
    const tex = await textureFromTex(parseTex(buf)!);
    expect(tex).toBeInstanceOf(THREE.DataTexture);
    expect(decodeCalls).toHaveLength(0); // 原始数据不触发解码
  });

  it('TEXB0002（无 imageFormat）→ 仍走 DataTexture（回归）', async () => {
    const rgba = new Uint8Array(32 * 16 * 4).fill(0x40);
    const buf = makeTex({ format: TEX_FORMAT.RGBA8888, images: [[{ width: 32, height: 16, data: rgba }]] });
    const tex = await textureFromTex(parseTex(buf)!);
    expect(tex).toBeInstanceOf(THREE.DataTexture);
    expect(decodeCalls).toHaveLength(0);
  });

  it('原始 RGBA 数据必须翻转行序（修复 DataTexture 路径上下颠倒）', async () => {
    // three.js 的 DataTexture.flipY 对 TypedArray 上传无效（UNPACK_FLIP_Y 只对 DOM 源生效），
    // 而 WE tex 原始 RGBA 数据是 top-down（第一行=图像顶部）。若直接上传，
    // 图像顶部会落在 v=0（纹理底部）→ 渲染上下颠倒。必须在构造 DataTexture 前手动翻转行序，
    // 使数据变为 bottom-up（第一行=图像底部），与 ImageBitmap 修复后的方向语义一致。
    const w = 8, h = 8;
    const data = new Uint8Array(w * h * 4);
    // 第一行全红（代表图像顶部），最后一行全蓝（代表图像底部）
    for (let x = 0; x < w; x++) { data[x * 4] = 255; data[x * 4 + 3] = 255; }          // row 0: R
    for (let x = 0; x < w; x++) { data[(h - 1) * w * 4 + x * 4 + 2] = 255; data[(h - 1) * w * 4 + x * 4 + 3] = 255; } // row h-1: B
    const buf = makeTex({
      format: TEX_FORMAT.RGBA8888,
      images: [[{ width: w, height: h, data }]],
    });
    const tex = await textureFromTex(parseTex(buf)!) as THREE.DataTexture;
    expect(tex).toBeInstanceOf(THREE.DataTexture);
    const out = tex.image.data as Uint8Array;
    // 翻转后：新第一行应来自原最后一行（蓝）
    expect(out[2]).toBe(255);          // 新 row0 的 B 通道
    expect(out[0]).toBe(0);            // 新 row0 无 R
    // 新最后一行应来自原第一行（红）
    expect(out[(h - 1) * w * 4]).toBe(255);
    expect(out[(h - 1) * w * 4 + 2]).toBe(0);
  });

  it('解码失败（createImageBitmap reject）→ 返回 null 而非抛错', async () => {
    vi.stubGlobal('createImageBitmap', async () => { throw new Error('decode failed'); });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const buf = makeTex({
      container: 'TEXB0003', imageFormat: FIF.PNG, format: TEX_FORMAT.RGBA8888,
      images: [[{ width: 32, height: 16, data: png }]],
    });
    await expect(textureFromTex(parseTex(buf)!)).resolves.toBeNull();
  });
});
