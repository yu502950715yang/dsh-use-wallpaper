// 按已验证的 PKGV0001 格式构造内存包：
// 头部16B = version(4,=8) + "PKGV0001"(8) + entryCount(4)
// 条目 = nameLen(u32) + name + off(u32) + size(u32)，off 相对数据段起点
import { Buffer } from 'node:buffer';

export function makePkg(files: Array<{ name: string; data: Uint8Array }>): Buffer {
  const nameBytes = files.map((f) => Buffer.from(f.name, 'utf8'));
  const header = Buffer.alloc(16);
  header.writeUInt32LE(8, 0);
  header.write('PKGV0001', 4, 'ascii');
  header.writeUInt32LE(files.length, 12);
  const table: Buffer[] = [];
  let offset = 0;
  for (let i = 0; i < files.length; i++) {
    const nb = nameBytes[i];
    const row = Buffer.alloc(4 + nb.length + 8);
    row.writeUInt32LE(nb.length, 0);
    nb.copy(row, 4);
    row.writeUInt32LE(offset, 4 + nb.length);
    row.writeUInt32LE(files[i].data.length, 4 + nb.length + 4);
    table.push(row);
    offset += files[i].data.length;
  }
  return Buffer.concat([header, ...table, ...files.map((f) => Buffer.from(f.data))]);
}
