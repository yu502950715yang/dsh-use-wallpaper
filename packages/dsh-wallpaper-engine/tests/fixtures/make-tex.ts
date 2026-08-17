import { Buffer } from 'node:buffer';
// Wallpaper Engine .tex 容器：版本/尺寸头 + 内嵌 DDS 数据。
// 本工具生成最小可测容器：前 16 字节头（magic 'WETEX' + width/height u32），
// 随后直接是 DDS 头 + BC1 块数据。
export function makeTex(width: number, height: number, fourCC: string, blockData: Uint8Array): Buffer {
  const ddsHeader = Buffer.alloc(128);
  ddsHeader.write('DDS ', 0, 'ascii');
  ddsHeader.writeUInt32LE(124, 4);            // DDS_HEADER size
  ddsHeader.writeUInt32LE(0x1007, 8);         // flags: CAPS|HEIGHT|WIDTH|PIXELFORMAT|LINEARSIZE
  ddsHeader.writeUInt32LE(height, 12);
  ddsHeader.writeUInt32LE(width, 16);
  ddsHeader.writeUInt32LE(blockData.length, 20);
  ddsHeader.writeUInt32LE(0x1000, 76);        // DDPF_FOURCC
  ddsHeader.write(fourCC, 80, 'ascii');
  ddsHeader.writeUInt32LE(0x1000, 108);       // DDSCAPS_TEXTURE
  const header = Buffer.alloc(16);
  header.write('WETEX', 0, 'ascii');
  header.writeUInt32LE(width, 8);
  header.writeUInt32LE(height, 12);
  return Buffer.concat([header, ddsHeader, Buffer.from(blockData)]);
}
