import * as THREE from 'three';
import LZ4 from 'lz4js';
import { fetchWithRetry } from './fetch-util.js';

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
  // 已解压的原始数据（独立 ArrayBuffer，非输入视图）。TS 5.9 泛型化后
  // 显式标注 ArrayBuffer 背景：Blob/DataTexture 等 DOM API 不接受
  // ArrayBufferLike（含 SharedArrayBuffer）背景的视图。
  data: Uint8Array<ArrayBuffer>;
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
function lz4Decompress(src: Uint8Array, decompressedSize: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(decompressedSize);
  const n = LZ4.decompressBlock(src, out, 0, src.length, 0);
  return n === decompressedSize ? out : out.subarray(0, Math.min(n, decompressedSize));
}

// 基础层 mip = 全分辨率（mip[0]）。此前 `pickMipmap` 选「宽度 ≤2048 的最大级」做下采样，
// 当场景/视口需要更高分辨率时该纹理被**放大** → 画面模糊（不是原始分辨率，用户实测「整体糊」）。
// 这里统一取 mip[0]（解压后的原始尺寸），使背景/粒子纹理**保持原始分辨率**（锐利）。
// 本仓库 three 页面所有纹理均经 textureFromTex 处理；mipmaps 非空（parseTex 空 → null）故 mip[0] 恒存在。

// 由解析结果构造 three 纹理：
//   TEXB0003+ 编码图像（imageFormat=JPEG/PNG/WEBP）→ 解码为 ImageBitmap 后包装为 Texture（异步）
//   （注意：编码图像的 format 字段仍为 RGBA8888(0)，但 mipmap 数据是 JPEG/PNG 字节流，
//    必须先按 imageFormat 判断，否则会被误当原始 RGBA 创建 DataTexture → 渲染乱码）
//   RGBA8888 → DataTexture（数据 top-down → 翻转行序为 bottom-up，与 ImageBitmap 路径方向语义一致）；
//   DXT1/3/5 → CompressedTexture
export async function textureFromTex(info: TexInfo): Promise<THREE.Texture | null> {
  const mip = info.mipmaps[0];
  if (!mip) return null;
  // 过滤/采样（关键，修复「模糊/不清」）：three.js `DataTexture` 缺省 **NearestFilter**
  //（逐像素最近采样，放大成马赛克方块、缩小无 mip 抗锯齿 → 观感「糊/不锐利」）。这里对
  // 非压缩背景/粒子纹理统一设 `magFilter=LinearFilter`（双线性）+ `minFilter=LinearMipmapLinearFilter`
  //（mip 链抗锯齿）+ `generateMipmaps=true`（GPU 自动生成 mip），匹配标准高质量采样：1:1 清晰、
  // 放大柔和、缩小抗锯齿（本仓库 three r170 仅 WebGL2，NPOT 也能生成 mip，无 WebGL1 NPOT 风险）。
  const applyLinearSampling = (tex: THREE.Texture): void => {
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
  };
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
      applyLinearSampling(tex);
      return tex;
    } catch {
      return null;
    }
  }
  // imageFormat=-1 或 TEXB0001/0002（无该字段）→ mipmap 数据为原始像素/块数据
  if (info.format === TEX_FORMAT.RGBA8888 || info.format === TEX_FORMAT.RG88 || info.format === TEX_FORMAT.R8) {
    // 方向语义（关键）：DataTexture 的 flipY 对 TypedArray 上传无效（WebGL 的
    // UNPACK_FLIP_Y_WEBGL 只对 DOM 元素源生效），数据第一行会落在纹理 v=0（底部）。
    // WE tex 原始数据是 top-down（第一行=图像顶部），直接上传会上下颠倒，
    // 因此手动翻转行序为 bottom-up（第一行=图像底部），与 ImageBitmap 路径一致。
    // RGBA8888 原样；RG88/R8 先展开为 RGBA（convertUnormToRgba，WE 粒子纹理 alpha-priority 语义）
    // 再翻转——此前 RG88/R8 无分支直接 return null（DK 雪片/wasam 雾纹理加载失败 → 白图兜底）。
    const src = info.format === TEX_FORMAT.RGBA8888 ? mip.data : convertUnormToRgba(mip.data, info.format);
    const flipped = flipRows(src, mip.width, mip.height, 4);
    const tex = new THREE.DataTexture(flipped, mip.width, mip.height, THREE.RGBAFormat);
    applyLinearSampling(tex);
    return tex;
  }
  const glFormat = FORMAT_TO_GL[info.format];
  if (glFormat) {
    // 方向语义（关键，修复 DXT 背景上下颠倒 —— Task 5 深挖）：WE .tex 压缩数据是 **top-down**
    // （第一行=图像顶部，同 RGBA8888）。`CompressedTexture` 构造器把 `flipY` 置 false，且 WebGL 的
    // `UNPACK_FLIP_Y_WEBGL` 对压缩纹理上传**无效**（只能按块数据原样写入，v=0=图像顶部），而 three
    // PlaneGeometry 的 v=0=quad 底部 → 图像顶部被渲染到底部 = **上下颠倒**（RGBA8888 路径靠
    // `flipRows` 手动翻为 bottom-up 规避，编码图像靠 `imageOrientation:'flipY'` 规避，唯独 DXT 漏掉）。
    // 此处按**块行**（每 4 像素行一块，DXT 压缩纹理尺寸须为 4 的倍数）反转数据，使 v=0=bottom-up，
    // 与 DataTexture/ImageBitmap 两条路径的行序**一致**（图像正立）。
    const blockSize = info.format === TEX_FORMAT.DXT1 ? 8 : 16;
    const tex = new THREE.CompressedTexture(
      info.mipmaps.map((m) => ({
        data: flipCompressedRows(m.data, m.width, m.height, blockSize),
        width: m.width,
        height: m.height,
      })),
      mip.width,
      mip.height,
      glFormat as THREE.CompressedPixelFormat,
    );
    // DXT 已内嵌完整 mip 链（info.mipmaps 全链传入），minFilter 保持 LinearMipmapLinear（有 mip）；
    // 显式 magFilter=Linear + generateMipmaps=false（压缩纹理不能生成 mip，mip 已内嵌）。
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }
  return null;
}

// 垂直翻转压缩纹理的**块行序**（top-down → bottom-up）。DXT（BC1/BC2/BC3）每 4×4 像素一块、
// 每块固定 `blockSize` 字节（DXT1=8、DXT3/5=16）；压缩纹理无法用 UNPACK_FLIP_Y 翻转，必须在数据层
// 反转块行（每块行 = 一块高 = 4 像素行，块内像素顺序不变）。尺寸须为 4 的倍数（DXT 约束），
// 不满足时按 `ceil` 对齐（超出区冗余，无害）。纯函数（native 可测）。
export function flipCompressedRows(
  data: Uint8Array,
  width: number,
  height: number,
  blockSize: number,
): Uint8Array<ArrayBuffer> {
  const blockW = Math.max(1, Math.ceil(width / 4));
  const blockH = Math.max(1, Math.ceil(height / 4));
  const rowBytes = blockW * blockSize;
  const out = new Uint8Array(data.length);
  for (let by = 0; by < blockH; by++) {
    const src = by * rowBytes;
    const dst = (blockH - 1 - by) * rowBytes;
    // rowBytes 可能超出 data 尾部（不满足 4 倍时的冗余），用 subarray 截断安全拷贝。
    const end = Math.min(src + rowBytes, data.length);
    out.set(data.subarray(src, end), dst);
  }
  return out;
}

// RG88（format 8，2 字节/像素）与 R8（format 9，1 字节/像素）→ RGBA8888。
// WebGL 无便捷 2 通道/1 通道 DataTexture 渲染路径（ShaderMaterial 直接按 vec4 采样），故展开为
// RGBA8，对齐 WE `ConvertTexture0Format` 的粒子语义：
//   - R8：rgb 恒白、alpha = R 通道（`vec4(1,1,1,_sample.r)`，fog/rain 雾形状——同 wasm
//     `r8_to_rgba_white_alpha`，纹理不调制颜色、alpha 由灰度调制）。
//   - RG88：`vec4(r, r, r, g)`——r=亮度灰度（复制到 rgb）、g=alpha 覆盖（snow 雪片形状；
//     `TextureFlags_AlphaChannelPriority` = "alpha is in G/R channel"，RG88 的 alpha 在 G 通道，
//     R8 的 alpha 在 R 通道）。
// 纯函数（native 可测）。
export function convertUnormToRgba(data: Uint8Array, format: number): Uint8Array<ArrayBuffer> {
  if (format === TEX_FORMAT.RG88) {
    const out = new Uint8Array(data.length * 2);
    for (let i = 0, o = 0; i < data.length; i += 2, o += 4) {
      const r = data[i];
      const g = data[i + 1];
      out[o] = r; out[o + 1] = r; out[o + 2] = r; out[o + 3] = g;
    }
    return out;
  }
  // R8：rgb 恒白、alpha = R 通道。
  const out = new Uint8Array(data.length * 4);
  for (let i = 0, o = 0; i < data.length; i++, o += 4) {
    const v = data[i];
    out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = v;
  }
  return out;
}

// 垂直翻转像素行序（top-down → bottom-up）。DataTexture 上传 TypedArray 时 flipY 无效，
// 必须在数据层面翻转，使第一行对应图像底部（v=0 语义与 ImageBitmap 路径对齐）。
export function flipRows(data: Uint8Array, width: number, height: number, bytesPerPixel: number): Uint8Array<ArrayBuffer> {
  const rowBytes = width * bytesPerPixel;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    const src = y * rowBytes;
    const dst = (height - 1 - y) * rowBytes;
    out.set(data.subarray(src, src + rowBytes), dst);
  }
  return out;
}

// 拉取 .tex（带瞬时失败重试）→ parseTex → 构造纹理。解析失败/格式不支持返回 null。
export async function loadTexTexture(url: string): Promise<THREE.Texture | null> {
  const buf = await fetchWithRetry(url);
  if (!buf) return null;
  const info = parseTex(buf);
  if (!info) return null;
  return textureFromTex(info);
}
