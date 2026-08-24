import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
const HEADER_SIZE = 16;
export function parsePkg(buf) {
    if (buf.length < HEADER_SIZE)
        throw new Error('PKG too small');
    if (buf[4] !== 0x50 || buf[5] !== 0x4b || buf[6] !== 0x47 || buf[7] !== 0x56) {
        throw new Error('Bad PKG magic');
    }
    const entries = [];
    let pos = HEADER_SIZE;
    while (pos + 4 <= buf.length) {
        const nameLen = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24);
        if (nameLen <= 0 || nameLen > 1024)
            break; // 文件表结束
        const nameStart = pos + 4;
        const entryEnd = nameStart + nameLen + 8;
        if (entryEnd > buf.length)
            throw new Error('PKG truncated'); // 条目表被截断（name/off/size 不完整）
        const name = Buffer.from(buf.slice(nameStart, nameStart + nameLen)).toString('utf8');
        const off = buf[nameStart + nameLen] |
            (buf[nameStart + nameLen + 1] << 8) |
            (buf[nameStart + nameLen + 2] << 16) |
            (buf[nameStart + nameLen + 3] << 24);
        const size = buf[nameStart + nameLen + 4] |
            (buf[nameStart + nameLen + 5] << 8) |
            (buf[nameStart + nameLen + 6] << 16) |
            (buf[nameStart + nameLen + 7] << 24);
        if (off < 0 || size < 0)
            throw new Error('Entry out of bounds');
        entries.push({ name, offset: off, size });
        pos = entryEnd;
        if (entries.length > 10000)
            throw new Error('Too many entries');
    }
    const dataStart = pos;
    // off 相对 dataStart，二次校验：dataStart + off + size 不得越过缓冲区末尾
    for (const e of entries) {
        if (dataStart + e.offset + e.size > buf.length)
            throw new Error('Entry out of bounds');
    }
    return { entries, dataStart };
}
function isSafeName(name) {
    return !name.includes('..') && !name.startsWith('/') && !name.includes('\\');
}
export class PkgReader {
    buf;
    entries;
    dataStart;
    constructor(pkgPathOrBuf) {
        const buf = typeof pkgPathOrBuf === 'string' ? readFileSync(pkgPathOrBuf) : Buffer.from(pkgPathOrBuf);
        const parsed = parsePkg(buf);
        this.buf = buf;
        this.entries = parsed.entries;
        this.dataStart = parsed.dataStart;
    }
    listEntries() {
        return this.entries.map((e) => ({ ...e }));
    }
    readEntry(name) {
        if (!isSafeName(name))
            return null;
        const e = this.entries.find((x) => x.name === name);
        if (!e)
            return null;
        return this.buf.subarray(this.dataStart + e.offset, this.dataStart + e.offset + e.size);
    }
}
