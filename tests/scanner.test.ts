import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanWallpapers, kindFromProjectJson } from '../src/host/scanner.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wp-scan-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function addWallpaper(id: string, pj: Record<string, unknown>, extraFiles: string[] = []) {
  const d = join(dir, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'project.json'), JSON.stringify(pj));
  for (const f of extraFiles) writeFileSync(join(d, f), 'x');
}

describe('kindFromProjectJson', () => {
  it('maps types', () => {
    expect(kindFromProjectJson({ type: 'scene' })).toBe('scene');
    expect(kindFromProjectJson({ type: 'video' })).toBe('video');
    expect(kindFromProjectJson({ type: 'web' })).toBe('web');
    expect(kindFromProjectJson({ type: 'image' })).toBe('image');
    expect(kindFromProjectJson({})).toBe('unknown');
  });
  it('type 大小写不敏感（WE 会写 "Web"/"Scene"）', () => {
    expect(kindFromProjectJson({ type: 'Web' })).toBe('web');
    expect(kindFromProjectJson({ type: 'Scene' })).toBe('scene');
    expect(kindFromProjectJson({ type: 'Video' })).toBe('video');
    expect(kindFromProjectJson({ type: ' web ' })).toBe('web');
  });
});

describe('scanWallpapers', () => {
  it('scans workshop dir into WallpaperInfo list', async () => {
    addWallpaper('111', { title: 'A', type: 'video', file: 'a.mp4' }, ['a.mp4', 'preview.gif']);
    addWallpaper('222', { title: 'B', type: 'scene' }, ['scene.pkg', 'preview.jpg']);
    addWallpaper('333', { title: 'C', type: 'web', file: 'index.html' }, ['index.html', 'preview.jpg']);
    const list = await scanWallpapers(dir);
    expect(list).toHaveLength(3);
    const a = list.find((w) => w.id === '111')!;
    expect(a.title).toBe('A');
    expect(a.type).toBe('video');
    expect(a.hasPreviewGif).toBe(true);
    expect(a.previewUrl).toBe('/wallpapers/media/111/preview');
    const b = list.find((w) => w.id === '222')!;
    expect(b.hasScene).toBe(true);
    expect(b.type).toBe('scene');
  });
  it('skips dirs without project.json', async () => {
    mkdirSync(join(dir, 'empty'), { recursive: true });
    const list = await scanWallpapers(dir);
    expect(list).toHaveLength(0);
  });
  it('I5: 跳过 project.json 非对象（null/数组/字符串）的目录', async () => {
    for (const [id, content] of [
      ['null-pj', 'null'],
      ['arr-pj', '[1,2]'],
      ['str-pj', '"hi"'],
    ] as const) {
      const d = join(dir, id);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'project.json'), content);
    }
    const list = await scanWallpapers(dir);
    expect(list).toHaveLength(0);
  });
});


describe('preset 壁纸（WE 预设：dependency + preset，无 type/file）', () => {
  it('kindFromProjectJson：无 type 但有 dependency → preset；空 dependency → unknown', () => {
    expect(kindFromProjectJson({ dependency: '3118949804' })).toBe('preset');
    expect(kindFromProjectJson({ dependency: '3118949804', preset: { speed: 2 } })).toBe('preset');
    expect(kindFromProjectJson({ dependency: '  ' })).toBe('unknown');
    expect(kindFromProjectJson({ dependency: 123 })).toBe('unknown');
  });

  it('scanWallpapers：preset 标记 presetOf，hasScene 取依赖目录的 scene.pkg', async () => {
    addWallpaper('100', { title: 'Base', type: 'scene' }, ['scene.pkg', 'preview.jpg']);
    addWallpaper('200', { title: 'Preset', dependency: '100', preset: { speed: 2.5 } }, ['preview.jpg']);
    addWallpaper('300', { title: 'Orphan', dependency: '999' }, ['preview.jpg']);
    const list = await scanWallpapers(dir);
    const preset = list.find((w) => w.id === '200')!;
    expect(preset.type).toBe('preset');
    expect(preset.presetOf).toBe('100');
    expect(preset.hasScene).toBe(true);
    const orphan = list.find((w) => w.id === '300')!;
    expect(orphan.type).toBe('preset');
    expect(orphan.hasScene).toBe(false);
  });
});
