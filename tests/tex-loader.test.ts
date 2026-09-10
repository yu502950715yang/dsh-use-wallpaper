import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { parseTex, glFormatForDds, TEX_FORMAT, textureFromTex, convertUnormToRgba, flipCompressedRows, FIF } from '../src/client/tex-loader.js';
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
// convertUnormToRgba：RG88/R8 单/双通道粒子纹理 → RGBA8888（WE ConvertTexture0Format alpha 语义）。
// 这是 DK 雪片（RG88）/ fog（R8）纹理能在 three 路径加载的关键——此前 format 8/9 无分支直接
// return null → 白图兜底 → 实心方块（无纹理形状）。
describe('convertUnormToRgba', () => {
  it('RG88（format 8）：r 复制到 rgb、g 为 alpha（vec4(r,r,r,g)）', () => {
    // 2 像素：px0=(r=200,g=50) px1=(r=10,g=255)
    const src = new Uint8Array([200, 50, 10, 255]);
    const out = convertUnormToRgba(src, TEX_FORMAT.RG88);
    expect(out).toHaveLength(8); // 2px（4 字节 RG88）× 4B
    expect(Array.from(out)).toEqual([
      200, 200, 200, 50,
      10, 10, 10, 255,
    ]);
  });

  it('R8（format 9）：rgb 恒白、alpha = R 通道（vec4(1,1,1,r)）', () => {
    const src = new Uint8Array([77, 255, 0]);
    const out = convertUnormToRgba(src, TEX_FORMAT.R8);
    expect(out).toHaveLength(12); // 3px × 4B
    expect(Array.from(out)).toEqual([
      255, 255, 255, 77,
      255, 255, 255, 255,
      255, 255, 255, 0,
    ]);
  });
});

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

  it('RG88（format 8）：加载为 DataTexture（修复 DK 雪片黑方块——此前 return null）', async () => {
    // 2 像素 RG88：px0=(200,50)（较暗+半透明）、px1=(255,255)（亮+不透明）。
    const w = 2, h = 1;
    const rg88 = new Uint8Array([200, 50, 255, 255]);
    const buf = makeTex({ format: TEX_FORMAT.RG88, images: [[{ width: w, height: h, data: rg88 }]] });
    const info = parseTex(buf)!;
    expect(info.format).toBe(TEX_FORMAT.RG88);
    const tex = await textureFromTex(info) as THREE.DataTexture;
    expect(tex).toBeInstanceOf(THREE.DataTexture); // 不再 return null
    const out = tex.image.data as Uint8Array;
    // 经 convertUnormToRgba(r,r,r,g) + flipRows（单行翻转不变）：
    expect(Array.from(out)).toEqual([200, 200, 200, 50, 255, 255, 255, 255]);
  });

  it('R8（format 9）：加载为 DataTexture（修复 fog/rain 雾粒子——此前 return null）', async () => {
    const w = 2, h = 1;
    const r8 = new Uint8Array([128, 255]);
    const buf = makeTex({ format: TEX_FORMAT.R8, images: [[{ width: w, height: h, data: r8 }]] });
    const tex = await textureFromTex(parseTex(buf)!) as THREE.DataTexture;
    expect(tex).toBeInstanceOf(THREE.DataTexture);
    const out = tex.image.data as Uint8Array;
    // rgb 恒白、alpha=R；单行翻转不变：
    expect(Array.from(out)).toEqual([255, 255, 255, 128, 255, 255, 255, 255]);
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

  it('使用全分辨率 mip0（不再下采样 ≤2048）—— 修复「非原始分辨率」模糊', async () => {
    // 旧 pickMipmap 选「宽度 ≤2048 的最大级」做下采样：mip0(3000) 超限被跳过 → 退回 mip1(1500)。
    // 当场景/视口需要更高分辨率时 1500 被放大 → 画面模糊。此处验证 textureFromTex 取 mip0（全分辨率）
    // 作为基础层，尺寸与数据均为 mip0（3000×4），而非下采样后的 mip1（1500×2）。
    const mip0 = new Uint8Array(3000 * 4 * 4).fill(0x80); // 3000×4 RGBA
    const mip1 = new Uint8Array(1500 * 2 * 4).fill(0x40); // 1500×2 RGBA
    const buf = makeTex({
      format: TEX_FORMAT.RGBA8888,
      images: [[
        { width: 3000, height: 4, data: mip0 },
        { width: 1500, height: 2, data: mip1 },
      ]],
    });
    const info = parseTex(buf)!;
    const tex = await textureFromTex(info) as THREE.DataTexture;
    expect(tex).toBeInstanceOf(THREE.DataTexture);
    expect(tex.image.width).toBe(3000);   // mip0 全分辨率（此前会退到 1500）
    expect(tex.image.height).toBe(4);
    expect((tex.image.data as Uint8Array).length).toBe(3000 * 4 * 4);
  });

  it('textureFromTex 设 LinearFilter 采样 + generateMipmaps（修复 NearestFilter 马赛克/放大模糊）', async () => {
    // three.js DataTexture 缺省 magFilter/minFilter = NearestFilter（逐像素最近采样：放大成马赛克
    // 方块、缩小无 mip 抗锯齿 → 观感「糊/不锐利」）。textureFromTex 应统一设为双线性 + mip 抗锯齿。
    const rgba = new Uint8Array(32 * 16 * 4).fill(0x80);
    const buf = makeTex({ format: TEX_FORMAT.RGBA8888, images: [[{ width: 32, height: 16, data: rgba }]] });
    const tex = await textureFromTex(parseTex(buf)!) as THREE.DataTexture;
    expect(tex.magFilter).toBe(THREE.LinearFilter);
    expect(tex.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(tex.generateMipmaps).toBe(true);
  });

  // Task 5 深挖：DXT 压缩背景纹理上下颠倒（Lycoris Recoil-锦木千束）。
  // WE .tex 压缩数据是 top-down，而 CompressedTexture.flipY=false + WebGL UNPACK_FLIP_Y 对压缩纹理
  // 无效 → v=0=图像顶部被渲染到 quad 底部 = 上下颠倒。RGBA8888 路径用 flipRows、编码图像路径用
  // imageOrientation:'flipY' 均已修正，唯独 DXT 漏掉 → 本组测试锁定并修复「块行反转」。
  describe('flipCompressedRows（DXT 块行反转）', () => {
    it('DXT1（blockSize=8）反转块行序（top-down→bottom-up）', () => {
      // 8×8 = 2 块宽 × 2 块高（每块 4×4）。块索引：row0=block0,1；row1=block2,3。
      const w = 8, h = 8, blockSize = 8;
      const blocks = new Uint8Array(4 * blockSize);
      for (let i = 0; i < 4; i++) for (let j = 0; j < blockSize; j++) blocks[i * blockSize + j] = i * 100 + j;
      const flipped = flipCompressedRows(blocks, w, h, blockSize);
      // 反转后：新第一块行 = 旧 row1（block2,3），新最后块行 = 旧 row0（block0,1）。
      expect(Array.from(flipped.slice(0, blockSize))).toEqual(Array.from(blocks.slice(2 * blockSize, 3 * blockSize)));
      expect(Array.from(flipped.slice(blockSize, 2 * blockSize))).toEqual(Array.from(blocks.slice(3 * blockSize, 4 * blockSize)));
      expect(Array.from(flipped.slice(2 * blockSize, 3 * blockSize))).toEqual(Array.from(blocks.slice(0, blockSize)));
      expect(Array.from(flipped.slice(3 * blockSize, 4 * blockSize))).toEqual(Array.from(blocks.slice(blockSize, 2 * blockSize)));
    });

    it('DXT3/5（blockSize=16）按块行反转', () => {
      const w = 4, h = 8, blockSize = 16; // 1 块宽 × 2 块高
      const blocks = new Uint8Array(2 * blockSize);
      for (let i = 0; i < 2; i++) for (let j = 0; j < blockSize; j++) blocks[i * blockSize + j] = i * 50 + j;
      const flipped = flipCompressedRows(blocks, w, h, blockSize);
      expect(Array.from(flipped.slice(0, blockSize))).toEqual(Array.from(blocks.slice(blockSize, 2 * blockSize)));
      expect(Array.from(flipped.slice(blockSize, 2 * blockSize))).toEqual(Array.from(blocks.slice(0, blockSize)));
    });

    it('DXT5（format=4）textureFromTex：加载为 CompressedTexture 且块行已反转（修复 Lycoris 颠倒）', async () => {
      const w = 8, h = 8, blockSize = 16; // DXT5 每块 16B
      const blocks = new Uint8Array(4 * blockSize);
      for (let i = 0; i < 4; i++) for (let j = 0; j < blockSize; j++) blocks[i * blockSize + j] = i * 30 + j;
      const buf = makeTex({ format: TEX_FORMAT.DXT5, images: [[{ width: w, height: h, data: blocks }]] });
      const tex = await textureFromTex(parseTex(buf)!) as THREE.CompressedTexture;
      expect(tex).toBeInstanceOf(THREE.CompressedTexture);
      expect(tex.flipY).toBe(false); // CompressedTexture 缺省 flipY=false（且 WebGL 对压缩忽略 flip）
      const m0 = tex.mipmaps[0] as { data: Uint8Array };
      // 数据已翻为 bottom-up：新第一块行取自旧最后一块行（block2,3）。
      expect(Array.from(m0.data.slice(0, blockSize))).toEqual(Array.from(blocks.slice(2 * blockSize, 3 * blockSize)));
      expect(Array.from(m0.data.slice(2 * blockSize, 3 * blockSize))).toEqual(Array.from(blocks.slice(0, blockSize)));
    });

    // 2026-09-10 Task5 深挖（真机复现）：DXT 背景模糊。根因 = 压缩纹理用了**内嵌 mip 链 + 三线性过滤**：
    // ① WE 的 DXT mip 链常常不完整（Lycoris materials/111.tex：DXT1 6144×3072 只有 5 级，完整需 13 级），
    //    three 以 `texStorage2D(levels=mipmaps.length)` 分配不可变存储 → 纹理非 mipmap complete（ES 3.0
    //    下 mipmap 过滤器结果由实现定义）；② 即便驱动宽松，三线性过滤在常见视口取到 mip1/mip2（实测锐度
    //    −31%），观感「糊」。修复 = 与 RGBA8888/编码图像路径对齐：只用 mip0 全分辨率基础层 + LinearFilter。
    it('DXT：只用 mip0 全分辨率基础层 + LinearFilter（修复「内嵌不完整 mip 链 + 三线性」导致的模糊）', async () => {
      const w = 64, h = 32, blockSize = 8; // DXT1
      const mip0 = new Uint8Array((w / 4) * (h / 4) * blockSize).fill(0x11);
      const mip1 = new Uint8Array((w / 8) * (h / 8) * blockSize).fill(0x22);
      const buf = makeTex({
        format: TEX_FORMAT.DXT1,
        images: [[{ width: w, height: h, data: mip0 }, { width: w / 2, height: h / 2, data: mip1 }]],
      });
      const info = parseTex(buf)!;
      expect(info.mipmaps.length).toBe(2); // 解析层仍保留全部内嵌 mip（parseTex 不改语义）
      const tex = await textureFromTex(info) as THREE.CompressedTexture;
      // 只有 1 个 mipmap 层级（= mip0），尺寸 = mip0 全分辨率（不是 mip1 的 32×16）。
      expect(tex.mipmaps.length).toBe(1);
      expect(tex.mipmaps[0].width).toBe(64);
      expect(tex.mipmaps[0].height).toBe(32);
      expect((tex.mipmaps[0].data as Uint8Array).length).toBe(mip0.length);
      expect(tex.image.width).toBe(64);
      expect(tex.image.height).toBe(32);
      // 非 mipmap 过滤器：LinearFilter（基础层双线性）→ 纹理必然 complete，且无 mip 下采样损失。
      expect(tex.minFilter).toBe(THREE.LinearFilter);
      expect(tex.magFilter).toBe(THREE.LinearFilter);
      expect(tex.generateMipmaps).toBe(false);
    });

    it('DXT1（format=7）：纹理为 CompressedTexture 且 base 尺寸 = mip0（回归 Lycoris 全分辨率）', async () => {
      const w = 8, h = 8, blockSize = 8;
      const blocks = new Uint8Array(4 * blockSize).fill(0x7f);
      const buf = makeTex({ format: TEX_FORMAT.DXT1, images: [[{ width: w, height: h, data: blocks }]] });
      const tex = await textureFromTex(parseTex(buf)!) as THREE.CompressedTexture;
      expect(tex).toBeInstanceOf(THREE.CompressedTexture);
      expect(tex.format).toBe(0x83f1);
      expect(tex.mipmaps.length).toBe(1);
      expect(tex.minFilter).toBe(THREE.LinearFilter);
    });
  });
});
