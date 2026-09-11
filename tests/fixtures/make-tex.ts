import { Buffer } from 'node:buffer';
import LZ4 from 'lz4js';

// Wallpaper Engine .tex 容器（TEXV0005）最小生成器：
//   "TEXV0005\0" + "TEXI0001\0" + 28B 头（Format/Flags/TextureW/TextureH/ImageW/ImageH/UnkInt0）
//   + "TEXB0001|0002\0" + imageCount(i32) + 每 image: mipmapCount(i32)
//   + 每 mipmap: V2: width height isLZ4 decompressedBytes bytesLen + 数据 / V1: width height bytesLen + 数据
// 数据为原始（未压缩）像素/块数据；lz4=true 时用 lz4js 压缩后写入。
export interface TexMipSpec {
  width: number;
  height: number;
  data: Uint8Array;   // 原始数据（未压缩）
  lz4?: boolean;      // 是否 LZ4 压缩存储（默认 false）
}

export interface MakeTexOptions {
  format?: number;            // TexFormat 枚举：RGBA8888=0, DXT5=4, DXT3=6, DXT1=7, RG88=8, R8=9
  flags?: number;             // flags 位 2（值 4）= sprite 精灵表动画
  textureWidth?: number;      // 默认取第一个 image 的 mip0 width
  textureHeight?: number;
  imageWidth?: number;        // 默认取 mip0 width
  imageHeight?: number;
  unk?: number;
  container?: 'TEXB0001' | 'TEXB0002' | 'TEXB0003' | 'TEXB0004';  // 默认 TEXB0002（V2 带 LZ4 字段）
  imageFormat?: number;       // TEXB0003/0004 的 FreeImage 格式（如 FIF_JPEG=2）
  images: TexMipSpec[][];     // 每元素为一个 image 的 mipmap 数组
  // 精灵表动画段（TEXS000x，紧跟在 mip 数据之后；对齐 open-wallpaper-engine 的 sprite 分支）。
  // 帧在纹理中按**行优先网格**排布（每帧 frameWidth×frameHeight），列数由 textureWidth 推出。
  sprite?: MakeTexSpriteSpec;
}

export interface MakeTexSpriteSpec {
  texs?: 1 | 2 | 3;           // TEXS 版本（默认 2；1 = 帧坐标为 i32，3 = 带 atlas 尺寸）
  frames: number;
  frameWidth: number;
  frameHeight: number;
  atlas?: [number, number];   // texs>=3 时的 atlas 尺寸
}

function lz4Compress(data: Uint8Array): Uint8Array {
  const hashTable = new Uint32Array(1 << 16);
  const dst = new Uint8Array(LZ4.compressBound(data.length));
  const n = LZ4.compressBlock(data, dst, 0, data.length, hashTable);
  return dst.subarray(0, n);
}

export function makeTex(opts: MakeTexOptions): Buffer {
  const container = opts.container ?? 'TEXB0002';
  const mip0 = opts.images[0]?.[0];
  const textureWidth = opts.textureWidth ?? mip0?.width ?? 0;
  const textureHeight = opts.textureHeight ?? mip0?.height ?? 0;
  const imageWidth = opts.imageWidth ?? mip0?.width ?? 0;
  const imageHeight = opts.imageHeight ?? mip0?.height ?? 0;

  const header = Buffer.alloc(28);
  header.writeUInt32LE(opts.format ?? 0, 0);
  header.writeUInt32LE(opts.flags ?? 0, 4);
  header.writeUInt32LE(textureWidth, 8);
  header.writeUInt32LE(textureHeight, 12);
  header.writeUInt32LE(imageWidth, 16);
  header.writeUInt32LE(imageHeight, 20);
  header.writeUInt32LE(opts.unk ?? 0, 24);

  const chunks: Buffer[] = [
    Buffer.from('TEXV0005\0', 'ascii'),
    Buffer.from('TEXI0001\0', 'ascii'),
    header,
    Buffer.from(container + '\0', 'ascii'),
  ];
  const imageCount = Buffer.alloc(4);
  imageCount.writeUInt32LE(opts.images.length, 0);
  chunks.push(imageCount);

  // TEXB0003/0004：imageCount 后紧跟 FreeImage 格式（V4 还有 isVideoMp4 标志）
  // imageFormat=-1（0xFFFFFFFF）表示 mipmap 为原始像素数据，用 writeInt32LE 写入带符号值
  if (container === 'TEXB0003' || container === 'TEXB0004') {
    const fmt = Buffer.alloc(4);
    fmt.writeInt32LE(opts.imageFormat ?? 2, 0); // 默认 FIF_JPEG=2
    chunks.push(fmt);
    if (container === 'TEXB0004') chunks.push(Buffer.alloc(4)); // isVideoMp4=0
  }

  for (const mips of opts.images) {
    const mc = Buffer.alloc(4);
    mc.writeUInt32LE(mips.length, 0);
    chunks.push(mc);
    for (const m of mips) {
      const payload = m.lz4 ? lz4Compress(m.data) : m.data;
      if (container === 'TEXB0001') {
        const meta = Buffer.alloc(12);
        meta.writeUInt32LE(m.width, 0);
        meta.writeUInt32LE(m.height, 4);
        meta.writeUInt32LE(payload.length, 8);   // bytesLen（V1 无 LZ4 字段）
        chunks.push(meta, Buffer.from(payload));
      } else {
        // V2/V3/V4 的 mipmap 记录结构一致：width height isLZ4 decompressedBytes bytesLen
        const meta = Buffer.alloc(20);
        meta.writeUInt32LE(m.width, 0);
        meta.writeUInt32LE(m.height, 4);
        meta.writeUInt32LE(m.lz4 ? 1 : 0, 8);
        meta.writeUInt32LE(m.data.length, 12);   // decompressedBytesCount
        meta.writeUInt32LE(payload.length, 16);  // bytesLen
        chunks.push(meta, Buffer.from(payload));
      }
    }
  }
  // 精灵表动画段（TEXS000x）：帧数 + 每帧 (imageId, frametime, x, y, xAxis[2], yAxis[2])。
  if (opts.sprite) {
    const sp = opts.sprite;
    const texs = sp.texs ?? 2;
    chunks.push(Buffer.from(`TEXS000${texs}\0`, 'ascii'));
    const fc = Buffer.alloc(4);
    fc.writeUInt32LE(sp.frames, 0);
    chunks.push(fc);
    if (texs >= 3) {
      const atlas = Buffer.alloc(8);
      atlas.writeUInt32LE(sp.atlas?.[0] ?? textureWidth, 0);
      atlas.writeUInt32LE(sp.atlas?.[1] ?? textureHeight, 4);
      chunks.push(atlas);
    }
    const cols = Math.max(1, Math.round(textureWidth / sp.frameWidth));
    const intCoords = texs === 1;
    for (let f = 0; f < sp.frames; f++) {
      const rec = Buffer.alloc(8 + 24);
      rec.writeInt32LE(0, 0);                                   // imageId
      rec.writeFloatLE(0, 4);                                   // frametime
      const coords = [
        (f % cols) * sp.frameWidth, Math.floor(f / cols) * sp.frameHeight,
        sp.frameWidth, 0, 0, sp.frameHeight,
      ];
      coords.forEach((v, i) => {
        if (intCoords) rec.writeInt32LE(v, 8 + i * 4);
        else rec.writeFloatLE(v, 8 + i * 4);
      });
      chunks.push(rec);
    }
  }
  return Buffer.concat(chunks);
}
