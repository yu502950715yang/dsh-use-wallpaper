import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { parsePkg, PkgReader } from '../src/host/pkg-reader.js';
import { makePkg } from './fixtures/make-pkg.js';

const pkg = makePkg([
  { name: 'scene.json', data: Buffer.from('{"objects":[]}', 'utf8') },
  { name: 'materials/a.tex', data: new Uint8Array([0x44, 0x44, 0x53, 0x20]) },
]);

describe('parsePkg', () => {
  it('parses entry table with offsets relative to data segment', () => {
    const { entries, dataStart } = parsePkg(pkg);
    expect(entries).toHaveLength(2);
    // 偏差修正（brief 原文为 size:15 / offset:15）：'{"objects":[]}' 为 14 字节，
    // 故 scene.json size=14、第二条目 offset=14（运行时验证：Buffer.byteLength 为 14）
    expect(entries[0]).toEqual({ name: 'scene.json', offset: 0, size: 14 });
    expect(entries[1]).toEqual({ name: 'materials/a.tex', offset: 14, size: 4 });
    expect(dataStart).toBe(16 + (4 + 10 + 8) + (4 + 15 + 8)); // header + 两条目
  });
  it('rejects truncated buffer', () => {
    // Fix round 1（reviewer Important 1）：条目不完整必须抛错
    // - <16B：头部截断 → 'PKG too small'
    // - 20B：头部完整但条目表截断（条目需 4+10+8=22B，name 不全）
    // - 24B / 26B：name / off / size 不完整 → 'PKG truncated'
    expect(() => parsePkg(pkg.subarray(0, 10))).toThrow();
    expect(() => parsePkg(pkg.subarray(0, 20))).toThrow();
    expect(() => parsePkg(pkg.subarray(0, 24))).toThrow();
    expect(() => parsePkg(pkg.subarray(0, 26))).toThrow();
  });
  it('rejects entry whose declared size exceeds buffer', () => {
    // Fix round 1（reviewer Minor 1）：off 相对 dataStart，dataStart+off+size 越界须抛错
    const hdr = Buffer.alloc(16);
    hdr.writeUInt32LE(8, 0);
    hdr.write('PKGV0001', 4, 'ascii');
    hdr.writeUInt32LE(1, 12);
    const name = Buffer.from('x.bin', 'utf8');
    const row = Buffer.alloc(4 + name.length + 8);
    row.writeUInt32LE(name.length, 0);
    name.copy(row, 4);
    row.writeUInt32LE(0, 4 + name.length); // off = 0
    row.writeUInt32LE(999, 4 + name.length + 4); // size = 999，远超实际数据 3B
    const bad = Buffer.concat([hdr, row, Buffer.from([1, 2, 3])]);
    expect(() => parsePkg(bad)).toThrow();
  });
});

describe('PkgReader', () => {
  it('reads entry bytes by name', () => {
    const r = new PkgReader(pkg);
    const scene = r.readEntry('scene.json')!;
    expect(scene.toString('utf8')).toBe('{"objects":[]}');
    const tex = r.readEntry('materials/a.tex')!;
    expect([...tex]).toEqual([0x44, 0x44, 0x53, 0x20]);
  });
  it('returns null for unknown entry and rejects traversal names', () => {
    const r = new PkgReader(pkg);
    expect(r.readEntry('../secret')).toBeNull();
    expect(r.readEntry('nope.json')).toBeNull();
  });
});
