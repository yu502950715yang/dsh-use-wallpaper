import { describe, expect, it, vi } from 'vitest';
import { BOOT_PLAYED_KEY, bootAssetFromSettings, createBootPlayer, shouldPlayBoot } from '../src/client/boot-player.js';
import type { ClientSettings } from '../src/client/types.js';
import { DEFAULTS } from '../src/client/settings.js';

const S = (patch: Partial<ClientSettings> = {}): ClientSettings => ({ ...DEFAULTS, ...patch });

function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, dump: () => Object.fromEntries(m) };
}

describe('bootAssetFromSettings', () => {
  it('本地视频 → boot 路由 URL（路径编码）', () => {
    expect(bootAssetFromSettings(S({ bootAnimationSource: 'local', bootAnimationLocalPath: 'E:\\clips\\a b.mp4' })))
      .toEqual({ kind: 'video', url: '/wallpapers/boot/local-video?path=' + encodeURIComponent('E:\\clips\\a b.mp4') });
  });
  it('WE 视频/图片壁纸 → media 路由', () => {
    expect(bootAssetFromSettings(S({ bootAnimationWallpaperId: '9', bootAnimationWallpaperKind: 'video' })))
      .toEqual({ kind: 'video', url: '/wallpapers/media/9/file' });
    expect(bootAssetFromSettings(S({ bootAnimationWallpaperId: '9', bootAnimationWallpaperKind: 'image' })))
      .toEqual({ kind: 'image', url: '/wallpapers/media/9/preview' });
  });
  it('缺字段 → null', () => {
    expect(bootAssetFromSettings(S())).toBeNull();
    expect(bootAssetFromSettings(S({ bootAnimationWallpaperId: '9', bootAnimationWallpaperKind: '' }))).toBeNull();
  });
});

describe('shouldPlayBoot', () => {
  it('关闭或已播过 → false', () => {
    expect(shouldPlayBoot(S(), memStorage())).toBe(false);
    expect(shouldPlayBoot(S({ bootAnimationEnabled: true }), memStorage({ [BOOT_PLAYED_KEY]: '1' }))).toBe(false);
    expect(shouldPlayBoot(S({ bootAnimationEnabled: true }), memStorage())).toBe(true);
  });
});

describe('createBootPlayer', () => {
  it('start：播放并写标记、记录结果', async () => {
    const storage = memStorage();
    const overlay = { play: vi.fn(async () => 'ended' as const), dispose: vi.fn() };
    const player = createBootPlayer({
      readSettings: async () => S({ bootAnimationEnabled: true, bootAnimationSource: 'local', bootAnimationLocalPath: '/a.mp4' }),
      overlay, storage,
    });
    await expect(player.start()).resolves.toBe('ended');
    expect(overlay.play).toHaveBeenCalledTimes(1);
    expect(storage.dump()[BOOT_PLAYED_KEY]).toBe('1');
    expect(player.getLast()?.asset).toEqual({ kind: 'video', url: '/wallpapers/boot/local-video?path=' + encodeURIComponent('/a.mp4') });
  });
  it('未启用 → disabled；已播过 → already-played（不调 overlay）', async () => {
    const overlay = { play: vi.fn(async () => 'ended' as const), dispose: vi.fn() };
    const off = createBootPlayer({ readSettings: async () => S(), overlay });
    await expect(off.start()).resolves.toBe('disabled');

    const storage = memStorage({ [BOOT_PLAYED_KEY]: '1' });
    const done = createBootPlayer({
      readSettings: async () => S({ bootAnimationEnabled: true, bootAnimationSource: 'local', bootAnimationLocalPath: '/a.mp4' }),
      overlay, storage,
    });
    await expect(done.start()).resolves.toBe('already-played');
    expect(overlay.play).not.toHaveBeenCalled();
  });
  it('无素材 → no-asset；力播放（force）绕过开关与标记', async () => {
    const overlay = { play: vi.fn(async () => 'skipped' as const), dispose: vi.fn() };
    const storage = memStorage({ [BOOT_PLAYED_KEY]: '1' });
    const player = createBootPlayer({
      readSettings: async () => S({ bootAnimationEnabled: true, bootAnimationSource: 'local', bootAnimationLocalPath: '/a.mp4' }),
      overlay, storage,
    });
    await expect(player.play({ force: true })).resolves.toBe('skipped');
    await expect(player.play({ force: true })).resolves.toBe('skipped');

    const empty = createBootPlayer({ readSettings: async () => S({ bootAnimationEnabled: true }), overlay });
    await expect(empty.start()).resolves.toBe('no-asset');
  });
  it('overlay 抛错 → failed，不抛出；dispose 后不再播放', async () => {
    const overlay = { play: vi.fn(async () => { throw new Error('boom'); }), dispose: vi.fn() };
    const player = createBootPlayer({
      readSettings: async () => S({ bootAnimationEnabled: true, bootAnimationSource: 'local', bootAnimationLocalPath: '/a.mp4' }),
      overlay, storage: memStorage(),
    });
    await expect(player.start()).resolves.toBe('failed');
    player.dispose();
    expect(overlay.dispose).toHaveBeenCalledTimes(1);
    await expect(player.play({ force: true })).resolves.toBe('failed');
  });
});
