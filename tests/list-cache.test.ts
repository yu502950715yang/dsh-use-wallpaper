import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWallpaperListCache } from '../src/host/list-cache.js';

// 壁纸列表缓存：按根目录 mtimeMs 指纹复用 scanWallpapers 结果。
// Windows 上写/删子目录可能连带改父目录 mtime，故每次改动后用 utimesSync 显式还原。

const FIXED = new Date('2026-01-02T03:04:05.000Z');
const LATER = new Date('2026-01-02T03:04:06.000Z');

let roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wp-list-cache-'));
  roots.push(root);
  return root;
}

function makeWallpaper(root: string, id: string, title: string): void {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, 'project.json'), JSON.stringify({ title, type: 'video' }));
}

function touchDir(root: string, date: Date): void {
  utimesSync(root, date, date);
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('createWallpaperListCache', () => {
  it('首次 get 扫描；同 mtime 命中缓存（子目录内容变了也不重扫）', async () => {
    const root = makeRoot();
    makeWallpaper(root, '1', '旧标题');
    touchDir(root, FIXED);
    const cache = createWallpaperListCache();

    const first = await cache.get(root);
    expect(first.list.map((w) => w.title)).toEqual(['旧标题']);

    // 只改子目录内容 + 还原根目录 mtime → 指纹未变，必须仍返回旧列表
    makeWallpaper(root, '1', '新标题');
    touchDir(root, FIXED);
    const second = await cache.get(root);
    expect(second.list.map((w) => w.title)).toEqual(['旧标题']);
  });

  it('根目录 mtime 变化 → 重扫拿到新结果', async () => {
    const root = makeRoot();
    makeWallpaper(root, '1', '旧标题');
    touchDir(root, FIXED);
    const cache = createWallpaperListCache();
    await cache.get(root);

    makeWallpaper(root, '1', '新标题');
    touchDir(root, LATER);
    const second = await cache.get(root);
    expect(second.list.map((w) => w.title)).toEqual(['新标题']);
  });

  it('refresh: true 绕过缓存重扫，并把新结果写回缓存', async () => {
    const root = makeRoot();
    makeWallpaper(root, '1', '旧标题');
    touchDir(root, FIXED);
    const cache = createWallpaperListCache();
    await cache.get(root);

    makeWallpaper(root, '1', '新标题');
    touchDir(root, FIXED); // mtime 未变：只能靠 refresh 拿到新结果
    const refreshed = await cache.get(root, { refresh: true });
    expect(refreshed.list.map((w) => w.title)).toEqual(['新标题']);

    // 新结果已写回缓存：后续普通 get 不再返回旧列表
    const after = await cache.get(root);
    expect(after.list.map((w) => w.title)).toEqual(['新标题']);
    expect(after.etag).toBe(refreshed.etag);
  });

  it('etag 含内容指纹：同内容稳定，mtime 变但内容不变也稳定', async () => {
    const root = makeRoot();
    makeWallpaper(root, '1', '标题');
    touchDir(root, FIXED);
    const cache = createWallpaperListCache();

    const a = await cache.get(root);
    expect(a.etag).toMatch(/^W\/"1-[0-9a-f]{12}"$/);
    const b = await cache.get(root);
    expect(b.etag).toBe(a.etag);

    // mtime 变会重扫，但内容没变 ⇒ 版本号必须不变（否则客户端白下载一次）
    touchDir(root, LATER);
    const c = await cache.get(root);
    expect(c.etag).toBe(a.etag);
  });

  it('refresh 后内容变而 mtime 未变 → etag 必须变（否则旧 If-None-Match 误判 304）', async () => {
    const root = makeRoot();
    makeWallpaper(root, '1', '旧标题');
    touchDir(root, FIXED);
    const cache = createWallpaperListCache();

    const before = await cache.get(root);
    makeWallpaper(root, '1', '新标题');
    touchDir(root, FIXED); // 指纹不变：只能靠 refresh 发现内容变化
    const after = await cache.get(root, { refresh: true });
    expect(after.list.map((w) => w.title)).toEqual(['新标题']);
    expect(after.etag).not.toBe(before.etag);
    // 刷新后的 etag 已写回缓存，后续普通 get 返回同一版本
    expect((await cache.get(root)).etag).toBe(after.etag);
  });

  it('目录不存在 → 空列表、不抛、etag 稳定 W/"0-0"', async () => {
    const root = join(makeRoot(), 'missing');
    const cache = createWallpaperListCache();

    const a = await cache.get(root);
    const b = await cache.get(root);
    expect(a.list).toEqual([]);
    expect(a.etag).toBe('W/"0-0"');
    expect(b.etag).toBe('W/"0-0"');
  });

  it('最多缓存 4 个目录，第 5 个写入时淘汰最旧', async () => {
    const cache = createWallpaperListCache();
    const dirs = Array.from({ length: 5 }, (_, i) => {
      const root = makeRoot();
      makeWallpaper(root, '1', `标题${i}`);
      touchDir(root, FIXED);
      return root;
    });
    for (const root of dirs) await cache.get(root);

    // 第 1 个目录已被淘汰 ⇒ 改内容后即使 mtime 还原也会重扫
    makeWallpaper(dirs[0], '1', '改动后');
    touchDir(dirs[0], FIXED);
    const again = await cache.get(dirs[0]);
    expect(again.list.map((w) => w.title)).toEqual(['改动后']);
  });
});
