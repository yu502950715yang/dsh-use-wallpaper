import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeMp4HasAudio } from '../src/host/mp4-audio-probe.js';
import { scanWallpapers } from '../src/host/scanner.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeMp4(data: Buffer): string {
  const file = join(tempDir('we-mp4-'), 'video.mp4');
  writeFileSync(file, data);
  return file;
}

// —— 最小 mp4 构造：box = size(4) + type(4) + 载荷 ——
function box(type: string, ...payloads: Buffer[]): Buffer {
  const payload = Buffer.concat(payloads);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

// 64-bit size 形态：size=1 + largesize(8) + type + 载荷。
function box64(type: string, ...payloads: Buffer[]): Buffer {
  const payload = Buffer.concat(payloads);
  const size = 16 + payload.length;
  const head = Buffer.alloc(16);
  head.writeUInt32BE(1, 0);
  head.write(type, 4, 'latin1');
  head.writeUInt32BE(Math.floor(size / 0x100000000), 8);
  head.writeUInt32BE(size % 0x100000000, 12);
  return Buffer.concat([head, payload]);
}

// hdlr：version/flags(4) + pre_defined(4) + handler_type(4) + reserved(12) + name。
function hdlr(handlerType: string): Buffer {
  const payload = Buffer.alloc(24);
  payload.write(handlerType, 8, 'latin1');
  return box('hdlr', payload);
}

function trak(handlerType: string): Buffer {
  return box('trak', box('mdia', hdlr(handlerType)));
}

function ftyp(): Buffer {
  return box('ftyp', Buffer.from('isomiso2', 'latin1'), Buffer.alloc(8));
}

function moov(...traks: Buffer[]): Buffer {
  return box('moov', ...traks);
}

describe('probeMp4HasAudio', () => {
  it('moov 里有 soun trak → true（moov 在 mdat 前）', () => {
    const file = writeMp4(Buffer.concat([ftyp(), moov(trak('vide'), trak('soun')), box('mdat', Buffer.alloc(16))]));
    expect(probeMp4HasAudio(file)).toBe(true);
  });

  it('只有 vide trak → false', () => {
    const file = writeMp4(Buffer.concat([ftyp(), moov(trak('vide')), box('mdat', Buffer.alloc(16))]));
    expect(probeMp4HasAudio(file)).toBe(false);
  });

  it('moov 存在但没有 trak → false', () => {
    const file = writeMp4(Buffer.concat([ftyp(), moov(), box('mdat', Buffer.alloc(8))]));
    expect(probeMp4HasAudio(file)).toBe(false);
  });

  it('moov 在 mdat 后 + mdat 用 64-bit size → true', () => {
    const file = writeMp4(Buffer.concat([ftyp(), box64('mdat', Buffer.alloc(32)), moov(trak('soun'))]));
    expect(probeMp4HasAudio(file)).toBe(true);
  });

  it('moov 自身用 64-bit size → true', () => {
    const file = writeMp4(Buffer.concat([ftyp(), box64('moov', trak('soun'))]));
    expect(probeMp4HasAudio(file)).toBe(true);
  });

  it('有 ftyp/mdat 但无 moov → null（无法判断）', () => {
    const file = writeMp4(Buffer.concat([ftyp(), box('mdat', Buffer.alloc(16))]));
    expect(probeMp4HasAudio(file)).toBeNull();
  });

  it('非 mp4 文本 → null', () => {
    expect(probeMp4HasAudio(writeMp4(Buffer.from('this is not an mp4 file')))).toBeNull();
  });

  it('顶层 box 声明大小超出文件（截断）→ null', () => {
    const bad = Buffer.alloc(16);
    bad.writeUInt32BE(4096, 0);
    bad.write('moov', 4, 'latin1');
    expect(probeMp4HasAudio(writeMp4(bad))).toBeNull();
  });

  it('box size 小于头部（结构非法）→ null', () => {
    const bad = Buffer.alloc(16);
    bad.writeUInt32BE(4, 0);
    bad.write('ftyp', 4, 'latin1');
    expect(probeMp4HasAudio(writeMp4(bad))).toBeNull();
  });

  it('moov 内部子 box 损坏 → null', () => {
    const badInner = Buffer.alloc(8);
    badInner.writeUInt32BE(4, 0);
    badInner.write('trak', 4, 'latin1');
    expect(probeMp4HasAudio(writeMp4(box('moov', badInner)))).toBeNull();
  });

  it('文件不存在 → null', () => {
    expect(probeMp4HasAudio(join(tempDir('we-mp4-'), 'missing.mp4'))).toBeNull();
  });
});

describe('scanner 集成（type=video 才写 hasAudio）', () => {
  function addVideo(dir: string, id: string, file: string, data?: Buffer): void {
    const d = join(dir, id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'project.json'), JSON.stringify({ title: id, type: 'video', file }));
    if (data) writeFileSync(join(d, file), data);
  }

  it('探测结果写入 hasAudio；无法判断时保持 undefined', async () => {
    const dir = tempDir('we-scan-');
    addVideo(dir, '100', 'a.mp4', Buffer.concat([ftyp(), moov(trak('soun'))]));
    addVideo(dir, '200', 'b.mp4', Buffer.concat([ftyp(), moov(trak('vide'))]));
    addVideo(dir, '300', 'broken.mp4', Buffer.from('not mp4'));
    addVideo(dir, '400', 'missing.mp4');
    const list = await scanWallpapers(dir);
    expect(list.find((w) => w.id === '100')!.hasAudio).toBe(true);
    expect(list.find((w) => w.id === '200')!.hasAudio).toBe(false);
    expect(list.find((w) => w.id === '300')!.hasAudio).toBeUndefined();
    expect(list.find((w) => w.id === '400')!.hasAudio).toBeUndefined();
  });

  it('file 含越界路径（../）时不探测', async () => {
    const dir = tempDir('we-scan-');
    addVideo(dir, '500', '../evil.mp4');
    writeFileSync(join(dir, 'evil.mp4'), Buffer.concat([ftyp(), moov(trak('soun'))]));
    const w = (await scanWallpapers(dir)).find((x) => x.id === '500')!;
    expect(w.hasAudio).toBeUndefined();
  });

  it('非 video 壁纸不写 hasAudio', async () => {
    const dir = tempDir('we-scan-');
    const d = join(dir, '600');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'project.json'), JSON.stringify({ title: 'img', type: 'image', file: 'a.mp4' }));
    writeFileSync(join(d, 'a.mp4'), Buffer.concat([ftyp(), moov(trak('soun'))]));
    const w = (await scanWallpapers(dir)).find((x) => x.id === '600')!;
    expect(w.hasAudio).toBeUndefined();
  });
});
