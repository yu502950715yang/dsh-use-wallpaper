import * as THREE from 'three';
import { DDSLoader } from 'three/examples/jsm/loaders/DDSLoader.js';

// fourCC → WebGL 压缩纹理格式常量。
// DXT1/3/5 对应 EXT_texture_compression_s3tc；BC4/BC5 对应 EXT_texture_compression_rgtc
// （BC4U=RED_RGTC1 0x8fbb、BC4S=SIGNED_RED_RGTC1 0x8fbc、BC5U=RED_GREEN_RGTC2 0x8fbd、BC5S=SIGNED_RED_GREEN_RGTC2 0x8fbe）。
const FORMAT_MAP: Record<string, number> = {
  DXT1: 0x83f1, DXT3: 0x83f2, DXT5: 0x83f3,
  BC4U: 0x8fbb, BC4S: 0x8fbc, BC5U: 0x8fbd, BC5S: 0x8fbe,
};

export function glFormatForDds(fourCC: string): number {
  return FORMAT_MAP[fourCC] ?? 0;
}

export interface TexInfo {
  width: number;
  height: number;
  dds: Uint8Array;   // 自 DDS 头起（含 128B 头）
  glFormat: number;
}

export function parseTex(buf: Uint8Array): TexInfo | null {
  if (buf.length < 16) return null;
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3], buf[4]);
  if (magic !== 'WETEX') return null;
  const width = buf[8] | (buf[9] << 8) | (buf[10] << 16) | (buf[11] << 24);
  const height = buf[12] | (buf[13] << 8) | (buf[14] << 16) | (buf[15] << 24);
  const rest = buf.subarray(16);
  if (rest.length < 128) return null;
  const ddsMagic = String.fromCharCode(rest[0], rest[1], rest[2], rest[3]);
  if (ddsMagic !== 'DDS ') return null;
  const fourCC = String.fromCharCode(rest[80], rest[81], rest[82], rest[83]);
  const glFormat = glFormatForDds(fourCC);
  if (!glFormat) return null;
  return { width, height, dds: rest, glFormat };
}

// 单次 fetch 方案：.tex 一次拉取 → parseTex 取出内嵌 DDS → DDSLoader.parse 直接解析
// （避免 CompressedTextureLoader.loadAsync 对同一 URL 的二次 fetch）。
export async function loadTexTexture(url: string): Promise<THREE.CompressedTexture | null> {
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const buf = new Uint8Array(await resp.arrayBuffer());
  const info = parseTex(buf);
  if (!info) return null;
  // parse 期望「自 DDS 头起的独立 ArrayBuffer」：slice 复制出精确子段（subarray 的 buffer 含 WETEX 头，不可直传）。
  const dds = new DDSLoader().parse(info.dds.slice().buffer, true);
  if (dds.mipmaps.length === 0) return null;
  const tex = new THREE.CompressedTexture(
    dds.mipmaps,
    dds.width,
    dds.height,
    dds.format as THREE.CompressedPixelFormat,
  );
  // 与 CompressedTextureLoader.load 行为一致：无 mipmap 链时改用线性过滤，避免采样越界。
  if (dds.mipmapCount === 1) tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
