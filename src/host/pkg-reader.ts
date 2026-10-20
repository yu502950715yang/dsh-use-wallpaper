import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import type { PkgEntry } from '../shared/types.js';

const HEADER_SIZE = 16;

export function parsePkg(buf: Uint8Array): { entries: PkgEntry[]; dataStart: number } {
  if (buf.length < HEADER_SIZE) throw new Error('PKG too small');
  if (buf[4] !== 0x50 || buf[5] !== 0x4b || buf[6] !== 0x47 || buf[7] !== 0x56) {
    throw new Error('Bad PKG magic');
  }
  const entries: PkgEntry[] = [];
  let pos = HEADER_SIZE;
  while (pos + 4 <= buf.length) {
    const nameLen = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24);
    if (nameLen <= 0 || nameLen > 1024) break; // 文件表结束
    const nameStart = pos + 4;
    const entryEnd = nameStart + nameLen + 8;
    if (entryEnd > buf.length) throw new Error('PKG truncated'); // 条目表被截断（name/off/size 不完整）
    const name = Buffer.from(buf.slice(nameStart, nameStart + nameLen)).toString('utf8');
    const off =
      buf[nameStart + nameLen] |
      (buf[nameStart + nameLen + 1] << 8) |
      (buf[nameStart + nameLen + 2] << 16) |
      (buf[nameStart + nameLen + 3] << 24);
    const size =
      buf[nameStart + nameLen + 4] |
      (buf[nameStart + nameLen + 5] << 8) |
      (buf[nameStart + nameLen + 6] << 16) |
      (buf[nameStart + nameLen + 7] << 24);
    if (off < 0 || size < 0) throw new Error('Entry out of bounds');
    entries.push({ name, offset: off, size });
    pos = entryEnd;
    if (entries.length > 10000) throw new Error('Too many entries');
  }
  const dataStart = pos;
  // off 相对 dataStart，二次校验：dataStart + off + size 不得越过缓冲区末尾
  for (const e of entries) {
    if (dataStart + e.offset + e.size > buf.length) throw new Error('Entry out of bounds');
  }
  return { entries, dataStart };
}

function isSafeName(name: string): boolean {
  return !name.includes('..') && !name.startsWith('/') && !name.includes('\\');
}

export class PkgReader {
  private buf: Buffer;
  private entries: PkgEntry[];
  private dataStart: number;
  private readonly pkgPathValue: string;

  constructor(pkgPathOrBuf: string | Uint8Array) {
    const buf = typeof pkgPathOrBuf === 'string' ? readFileSync(pkgPathOrBuf) : Buffer.from(pkgPathOrBuf);
    const parsed = parsePkg(buf);
    this.buf = buf;
    this.entries = parsed.entries;
    this.dataStart = parsed.dataStart;
    // 内存包没有路径（流式读取需要文件路径）；只读暴露给路由
    this.pkgPathValue = typeof pkgPathOrBuf === 'string' ? pkgPathOrBuf : '';
  }

  get pkgPath(): string {
    return this.pkgPathValue;
  }

  listEntries(): PkgEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  private findEntry(name: string): PkgEntry | null {
    if (!isSafeName(name)) return null;
    return this.entries.find((x) => x.name === name) ?? null;
  }

  entryInfo(name: string): { offset: number; size: number } | null {
    const e = this.findEntry(name);
    return e ? { offset: e.offset, size: e.size } : null;
  }

  // 绝对字节区间：start 含、end 不含（size = end - start），供 createReadStream 定位
  entryAbsRange(name: string): { start: number; end: number } | null {
    const e = this.findEntry(name);
    if (!e) return null;
    const start = this.dataStart + e.offset;
    return { start, end: start + e.size };
  }

  readEntry(name: string): Buffer | null {
    const e = this.findEntry(name);
    if (!e) return null;
    return this.buf.subarray(this.dataStart + e.offset, this.dataStart + e.offset + e.size);
  }
}
