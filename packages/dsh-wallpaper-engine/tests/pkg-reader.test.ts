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
    // 偏差修正（brief 原文为 subarray(0, 20)）：20B 包头部完整（16B）+ 条目表截断，
    // parsePkg 循环条件 pos+8<=len 不满足即静默返回，不会抛错；
    // 改为 subarray(0, 10) 截断头部，触发 'PKG too small'
    expect(() => parsePkg(pkg.subarray(0, 10))).toThrow();
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
