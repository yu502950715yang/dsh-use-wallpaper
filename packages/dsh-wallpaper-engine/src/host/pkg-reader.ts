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
  while (pos + 8 <= buf.length) {
    const nameLen = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24);
    if (nameLen <= 0 || nameLen > 1024) break; // 文件表结束
    const nameStart = pos + 4;
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
    if (off < 0 || size < 0 || off + size > buf.length - 0) throw new Error('Entry out of bounds');
    entries.push({ name, offset: off, size });
    pos = nameStart + nameLen + 8;
    if (entries.length > 10000) throw new Error('Too many entries');
  }
  return { entries, dataStart: pos };
}

function isSafeName(name: string): boolean {
  return !name.includes('..') && !name.startsWith('/') && !name.includes('\\');
}

export class PkgReader {
  private buf: Buffer;
  private entries: PkgEntry[];
  private dataStart: number;

  constructor(pkgPathOrBuf: string | Uint8Array) {
    const buf = typeof pkgPathOrBuf === 'string' ? readFileSync(pkgPathOrBuf) : Buffer.from(pkgPathOrBuf);
    const parsed = parsePkg(buf);
    this.buf = buf;
    this.entries = parsed.entries;
    this.dataStart = parsed.dataStart;
  }

  listEntries(): PkgEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  readEntry(name: string): Buffer | null {
    if (!isSafeName(name)) return null;
    const e = this.entries.find((x) => x.name === name);
    if (!e) return null;
    return this.buf.subarray(this.dataStart + e.offset, this.dataStart + e.offset + e.size);
  }
}
