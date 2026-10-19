import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSceneFrameStore } from '../src/host/scene-frame-store.js';

const dirs: string[] = [];
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'we-frames-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

it('写入/读取/删除 PNG，校验签名与大小上限', () => {
  const dir = makeDir();
  const store = createSceneFrameStore(dir, { maxBytes: 1024 });
  const png = PNG;
  expect(store.write('123', png)).toEqual({ ok: true });
  expect(store.read('123')?.equals(png)).toBe(true);
  expect(store.write('124', Buffer.from('not png'))).toEqual({ ok: false, reason: 'bad-png' });
  expect(store.write('125', Buffer.alloc(2048))).toEqual({ ok: false, reason: 'too-large' });
  store.remove('123');
  expect(store.read('123')).toBeNull();
});

it('覆盖写原子替换内容，且不留 .tmp 文件', () => {
  const dir = makeDir();
  const store = createSceneFrameStore(dir);
  const next = Buffer.concat([PNG, Buffer.from([1, 2, 3])]);
  expect(store.write('7', PNG)).toEqual({ ok: true });
  expect(store.write('7', next)).toEqual({ ok: true });
  expect(store.read('7')?.equals(next)).toBe(true);
  expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toHaveLength(0);
});

it('id 白名单拒绝穿越与路径分隔符', () => {
  const dir = makeDir();
  const store = createSceneFrameStore(dir);
  for (const bad of ['../x', 'a/b', 'a\\b', '', 'a..b']) {
    expect(store.write(bad, PNG)).toEqual({ ok: false, reason: 'bad-id' });
    expect(store.read(bad)).toBeNull();
    expect(store.remove(bad)).toEqual({ ok: true });
  }
});

it('超过 maxFiles 时按 mtime 淘汰最旧帧，非 PNG 文件不参与', () => {
  const dir = makeDir();
  const store = createSceneFrameStore(dir, { maxFiles: 2 });
  writeFileSync(join(dir, 'keep.txt'), 'not a frame');
  const t = Date.now();
  expect(store.write('a', PNG)).toEqual({ ok: true });
  utimesSync(join(dir, 'a.png'), new Date(t - 20000), new Date(t - 20000));
  expect(store.write('b', PNG)).toEqual({ ok: true });
  utimesSync(join(dir, 'b.png'), new Date(t - 10000), new Date(t - 10000));
  expect(store.write('c', PNG)).toEqual({ ok: true });
  expect(store.read('a')).toBeNull();
  expect(store.read('b')).not.toBeNull();
  expect(store.read('c')).not.toBeNull();
  expect(readdirSync(dir).sort()).toEqual(['b.png', 'c.png', 'keep.txt']);
});
