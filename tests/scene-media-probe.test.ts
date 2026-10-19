import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePkg } from './fixtures/make-pkg.js';
import { makeTex } from './fixtures/make-tex.js';
import { probeEmbeddedMp4, extractEmbeddedMp4 } from '../src/host/scene-media-probe.js';

const dirs: string[] = [];

function writePkg(files: Array<{ name: string; data: Uint8Array }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'we-pkg-'));
  dirs.push(dir);
  const file = join(dir, 'scene.pkg');
  writeFileSync(file, makePkg(files));
  return file;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
const videoTex = makeTex({ flags: 32, container: 'TEXB0004', images: [[{ width: 2, height: 2, data: mp4 }]] });

it('识别 TEXB0004 + flags bit5 的内嵌 MP4，返回从 ftyp box 起的数据', () => {
  const file = writePkg([
    { name: 'scene.json', data: Buffer.from('{}') },
    { name: 'materials/video.tex', data: videoTex },
  ]);
  expect(probeEmbeddedMp4(file)).toBe(true);
  const hit = extractEmbeddedMp4(file)!;
  expect(hit).not.toBeNull();
  expect(hit.entryName).toBe('materials/video.tex');
  expect(Buffer.from(hit.bytes.subarray(4, 8)).toString('ascii')).toBe('ftyp');
});

it('无 video flag 的 .tex 不误报', () => {
  const plain = makeTex({ flags: 0, images: [[{ width: 2, height: 2, data: Buffer.alloc(64) }]] });
  const file = writePkg([{ name: 'materials/plain.tex', data: plain }]);
  expect(probeEmbeddedMp4(file)).toBe(false);
  expect(extractEmbeddedMp4(file)).toBeNull();
});

it('flags bit5 但载荷无合法 ftyp box 时不误报', () => {
  const fake = makeTex({ flags: 32, container: 'TEXB0004', images: [[{ width: 2, height: 2, data: Buffer.alloc(64) }]] });
  const file = writePkg([{ name: 'materials/fake.tex', data: fake }]);
  expect(probeEmbeddedMp4(file)).toBe(false);
  expect(extractEmbeddedMp4(file)).toBeNull();
});

it('pkg 不存在或 ftyp 只在非 .tex 条目里时不报视频', () => {
  const missing = join(tmpdir(), `we-pkg-missing-${process.pid}-${Date.now()}`, 'scene.pkg');
  expect(probeEmbeddedMp4(missing)).toBe(false);
  expect(extractEmbeddedMp4(missing)).toBeNull();
  const file = writePkg([{ name: 'notes.txt', data: mp4 }]);
  expect(probeEmbeddedMp4(file)).toBe(false);
});

it('包被替换后按 mtime 重新探测（缓存失效）', () => {
  const file = writePkg([{ name: 'materials/video.tex', data: videoTex }]);
  expect(probeEmbeddedMp4(file)).toBe(true);
  writeFileSync(file, makePkg([{ name: 'scene.json', data: Buffer.from('{}') }]));
  utimesSync(file, new Date(Date.now() + 60000), new Date(Date.now() + 60000));
  expect(probeEmbeddedMp4(file)).toBe(false);
  expect(extractEmbeddedMp4(file)).toBeNull();
});
