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
  data: Uint8Array<ArrayBuffer>;   // 已解压的原始数据（独立 ArrayBuffer，非输入视图）
}

export interface TexInfo {
  width: number;        // ImageWidth（实际图像尺寸）
  height: number;       // ImageHeight
  textureWidth: number; // 纹理尺寸（可能大于 ImageSize）
  textureHeight: number;
  format: number;       // TexFormat 枚举值
  flags: number;
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
  if (container !== 'TEXB0002\0' && container !== 'TEXB0001\0') return null;
  const v2 = container === 'TEXB0002\0';

  let pos = 46 + 9;
  const imageCount = readI32(buf, pos);
  if (imageCount <= 0 || imageCount > 64) return null;
  pos += 4;

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
      if (v2) {
        isLZ4 = readI32(buf, pos + 8);
        decompressedBytes = readI32(buf, pos + 12);
        bytesLen = readI32(buf, pos + 16);
      } else {
        bytesLen = readI32(buf, pos + 8);
      }
      pos += fieldLen;
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
  return { width, height, textureWidth, textureHeight, format, flags, mipmaps };
}

// LZ4 block 解压（Wallpaper Engine .tex 内嵌为 LZ4 block，非 frame 格式）
function lz4Decompress(src: Uint8Array, decompressedSize: number): Uint8Array<ArrayBuffer> {
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

// 由解析结果构造 three 纹理：RGBA8888 → DataTexture；DXT1/3/5 → CompressedTexture
export function textureFromTex(info: TexInfo): THREE.Texture | null {
  const mip = pickMipmap(info.mipmaps);
  if (!mip) return null;
  if (info.format === TEX_FORMAT.RGBA8888) {
    const tex = new THREE.DataTexture(mip.data, mip.width, mip.height, THREE.RGBAFormat);
    tex.needsUpdate = true;
    return tex;
  }
  const glFormat = FORMAT_TO_GL[info.format];
  if (!glFormat) return null;
  const tex = new THREE.CompressedTexture(
    info.mipmaps.map((m) => ({ data: m.data, width: m.width, height: m.height })),
    mip.width,
    mip.height,
    glFormat as THREE.CompressedPixelFormat,
  );
  tex.needsUpdate = true;
  return tex;
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
