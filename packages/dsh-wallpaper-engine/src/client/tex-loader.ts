import * as THREE from 'three';
import LZ4 from 'lz4js';

// Wallpaper Engine .tex 容器（TEXV0005）解析器：
//   "TEXV0005\0" + "TEXI0001\0" + 28B 头（Format/Flags/TextureW/TextureH/ImageW/ImageH/UnkInt0）
//   + "TEXB0001|0002\0" + imageCount(i32) + 每 image: mipmapCount(i32)
//   + 每 mipmap: V2: width height isLZ4 decompressedBytes bytesLen + 数据 / V1: width height bytesLen + 数据
// mipmap 数据为 LZ4 block 或未压缩；本模块负责解压为原始像素/块数据。

// TexFormat 枚举（真实格式，与 RePKG 逆向一致）
export const TEX_FORMAT = {
  RGBA8888: 0,
  DXT5: 4,
  DXT3: 6,
  DXT1: 7,
  RG88: 8,
  R8: 9,
} as const;

// FreeImage 格式枚举（TEXB0003+ 容器的 ImageFormat 字段，与 RePKG 一致）
export const FIF = {
  JPEG: 2,
  PNG: 13,
  WEBP: 21,
} as const;

// fourCC → three/WebGL 压缩纹理格式常量。
// DXT1/3/5 对应 EXT_texture_compression_s3tc；BC4/BC5 采用 three 的 CompressedPixelFormat 常量
// （RED_RGTC1=0x8dbb、SIGNED_RED_RGTC1=0x8dbc、RED_GREEN_RGTC2=0x8dbd、SIGNED_RED_GREEN_RGTC2=0x8dbe，注意是 0x8d 而非 0x8f）。
const FORMAT_MAP: Record<string, number> = {
  DXT1: 0x83f1, DXT3: 0x83f2, DXT5: 0x83f3,
  BC4U: 0x8dbb, BC4S: 0x8dbc, BC5U: 0x8dbd, BC5S: 0x8dbe,
};

export function glFormatForDds(fourCC: string): number {
  return FORMAT_MAP[fourCC] ?? 0;
}

// TexFormat 枚举值 → three 压缩纹理格式（仅压缩格式，非压缩格式走 DataTexture 分支）
const FORMAT_TO_GL: Record<number, number> = {
  [TEX_FORMAT.DXT1]: 0x83f1,
  [TEX_FORMAT.DXT3]: 0x83f2,
  [TEX_FORMAT.DXT5]: 0x83f3,
};

export interface TexMipmap {
  width: number;
  height: number;
  data: Uint8Array;   // 已解压的原始数据（独立 ArrayBuffer，非输入视图）
}

export interface TexInfo {
  width: number;        // ImageWidth（实际图像尺寸）
  height: number;       // ImageHeight
  textureWidth: number; // 纹理尺寸（可能大于 ImageSize）
  textureHeight: number;
  format: number;       // TexFormat 枚举值
  flags: number;
  imageFormat?: number; // TEXB0003+ 容器的 FreeImage 格式（mipmap 数据为 JPEG/PNG 编码）
  mipmaps: TexMipmap[]; // 全部 image 的所有 mipmap（按文件顺序）
}

function readI32(buf: Uint8Array, pos: number): number {
  return buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24);
}

function ascii(buf: Uint8Array, pos: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[pos + i]);
  return s;
}

const MIN_LEN = 18 + 28 + 9 + 4 + 4; // magic + header + container + imageCount + mipmapCount

export function parseTex(buf: Uint8Array): TexInfo | null {
  if (buf.length < MIN_LEN) return null;
  if (ascii(buf, 0, 9) !== 'TEXV0005\0') return null;
  if (ascii(buf, 9, 9) !== 'TEXI0001\0') return null;

  const format = readI32(buf, 18);
  const flags = readI32(buf, 22);
  const textureWidth = readI32(buf, 26);
  const textureHeight = readI32(buf, 30);
  const width = readI32(buf, 34);   // ImageWidth
  const height = readI32(buf, 38);  // ImageHeight

  const container = ascii(buf, 46, 9);
  if (container !== 'TEXB0002\0' && container !== 'TEXB0001\0'
    && container !== 'TEXB0003\0' && container !== 'TEXB0004\0') return null;
  const v2 = container === 'TEXB0002\0';
  const v3plus = container === 'TEXB0003\0' || container === 'TEXB0004\0';

  let pos = 46 + 9;
  const imageCount = readI32(buf, pos);
  if (imageCount <= 0 || imageCount > 64) return null;
  pos += 4;

  // TEXB0003/0004：imageCount 后紧跟 FreeImage 格式（V4 还有 isVideoMp4 标志）
  let imageFormat: number | undefined;
  if (v3plus) {
    imageFormat = readI32(buf, pos);
    pos += 4;
    if (container === 'TEXB0004\0') pos += 4;
  }

  const mipmaps: TexMipmap[] = [];
  for (let img = 0; img < imageCount; img++) {
    if (pos + 4 > buf.length) return null;
    const mipmapCount = readI32(buf, pos);
    if (mipmapCount <= 0 || mipmapCount > 256) return null;
    pos += 4;
    for (let m = 0; m < mipmapCount; m++) {
      const fieldLen = v2 ? 20 : 12;
      if (pos + fieldLen > buf.length) return null;
      const mw = readI32(buf, pos);
      const mh = readI32(buf, pos + 4);
      let isLZ4 = 0;
      let decompressedBytes = 0;
      let bytesLen: number;
      if (v2 || v3plus) {
        // V2/V3/V4 的 mipmap 记录结构一致：width height isLZ4 decompressedBytes bytesLen
        isLZ4 = readI32(buf, pos + 8);
        decompressedBytes = readI32(buf, pos + 12);
        bytesLen = readI32(buf, pos + 16);
      } else {
        bytesLen = readI32(buf, pos + 8);
      }
      pos += v2 || v3plus ? 20 : 12;
      if (mw <= 0 || mh <= 0 || bytesLen < 0) return null;
      if (pos + bytesLen > buf.length) return null;
      const payload = buf.subarray(pos, pos + bytesLen);
      pos += bytesLen;
      if (isLZ4) {
        if (decompressedBytes <= 0 || decompressedBytes > 1 << 30) return null;
        mipmaps.push({ width: mw, height: mh, data: lz4Decompress(payload, decompressedBytes) });
      } else {
        // 拷贝为纯 Uint8Array：与 LZ4 分支输出类型一致，且不 alias 输入 buffer
        mipmaps.push({ width: mw, height: mh, data: new Uint8Array(payload) });
      }
    }
  }
  if (mipmaps.length === 0) return null;
  return { width, height, textureWidth, textureHeight, format, flags, imageFormat, mipmaps };
}

// LZ4 block 解压（Wallpaper Engine .tex 内嵌为 LZ4 block，非 frame 格式）
function lz4Decompress(src: Uint8Array, decompressedSize: number): Uint8Array {
  const out = new Uint8Array(decompressedSize);
  const n = LZ4.decompressBlock(src, out, 0, src.length, 0);
  return n === decompressedSize ? out : out.subarray(0, Math.min(n, decompressedSize));
}

// 选取纹理 mip：优先取宽度不超过 2048 的最大级（避免 4K 原始数据全量上传），全部超限时退而取最小级
function pickMipmap(mips: TexMipmap[]): TexMipmap | null {
  let best: TexMipmap | null = null;
  for (const m of mips) {
    if (m.width <= 2048 && (!best || m.width > best.width)) best = m;
  }
  return best ?? mips[mips.length - 1] ?? null;
}

// 由解析结果构造 three 纹理：
//   TEXB0003+ 编码图像（imageFormat=JPEG/PNG/WEBP）→ 解码为 ImageBitmap 后包装为 Texture（异步）
//   （注意：编码图像的 format 字段仍为 RGBA8888(0)，但 mipmap 数据是 JPEG/PNG 字节流，
//    必须先按 imageFormat 判断，否则会被误当原始 RGBA 创建 DataTexture → 渲染乱码）
//   RGBA8888 → DataTexture（数据 top-down → 翻转行序为 bottom-up，与 ImageBitmap 路径方向语义一致）；
//   DXT1/3/5 → CompressedTexture
export async function textureFromTex(info: TexInfo): Promise<THREE.Texture | null> {
  const mip = pickMipmap(info.mipmaps);
  if (!mip) return null;
  // 编码图像优先：imageFormat 是 FreeImage 枚举（JPEG/PNG/WEBP）时数据为编码字节流
  const mime = info.imageFormat === FIF.JPEG ? 'image/jpeg'
    : info.imageFormat === FIF.PNG ? 'image/png'
    : info.imageFormat === FIF.WEBP ? 'image/webp' : '';
  if (mime) {
    if (typeof createImageBitmap !== 'function') return null;
    try {
      // 方向语义（关键）：three.js 的 texture.flipY 对 ImageBitmap 无效（翻转只能在 bitmap
      // 创建时通过 imageOrientation 指定）。WE tex 编码图像是 top-down（第一行=顶部），
      // 而 DataTexture 路径的原始 RGBA 数据是 bottom-up（第一行=底部）——若不解码时翻转，
      // 编码图像渲染会上下颠倒。imageOrientation:'flipY' 解码 + flipY=false 与 DataTexture 一致。
      const bitmap = await createImageBitmap(
        new Blob([mip.data], { type: mime }),
        { imageOrientation: 'flipY' },
      );
      const tex = new THREE.Texture(bitmap as unknown as HTMLImageElement);
      tex.flipY = false;
      tex.needsUpdate = true;
      return tex;
    } catch {
      return null;
    }
  }
  // imageFormat=-1 或 TEXB0001/0002（无该字段）→ mipmap 数据为原始像素/块数据
  if (info.format === TEX_FORMAT.RGBA8888) {
    // 方向语义（关键）：DataTexture 的 flipY 对 TypedArray 上传无效（WebGL 的
    // UNPACK_FLIP_Y_WEBGL 只对 DOM 元素源生效），数据第一行会落在纹理 v=0（底部）。
    // WE tex 原始数据是 top-down（第一行=图像顶部），直接上传会上下颠倒，
    // 因此手动翻转行序为 bottom-up（第一行=图像底部），与 ImageBitmap 路径一致。
    const flipped = flipRows(mip.data, mip.width, mip.height, 4);
    const tex = new THREE.DataTexture(flipped, mip.width, mip.height, THREE.RGBAFormat);
    tex.needsUpdate = true;
    return tex;
  }
  const glFormat = FORMAT_TO_GL[info.format];
  if (glFormat) {
    const tex = new THREE.CompressedTexture(
      info.mipmaps.map((m) => ({ data: m.data, width: m.width, height: m.height })),
      mip.width,
      mip.height,
      glFormat as THREE.CompressedPixelFormat,
    );
    tex.needsUpdate = true;
    return tex;
  }
  return null;
}

// 垂直翻转像素行序（top-down → bottom-up）。DataTexture 上传 TypedArray 时 flipY 无效，
// 必须在数据层面翻转，使第一行对应图像底部（v=0 语义与 ImageBitmap 路径对齐）。
export function flipRows(data: Uint8Array, width: number, height: number, bytesPerPixel: number): Uint8Array {
  const rowBytes = width * bytesPerPixel;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    const src = y * rowBytes;
    const dst = (height - 1 - y) * rowBytes;
    out.set(data.subarray(src, src + rowBytes), dst);
  }
  return out;
}

// 单次 fetch：拉取 .tex → parseTex → 构造纹理。解析失败/格式不支持返回 null。
export async function loadTexTexture(url: string): Promise<THREE.Texture | null> {
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const buf = new Uint8Array(await resp.arrayBuffer());
  const info = parseTex(buf);
  if (!info) return null;
  return textureFromTex(info);
}
