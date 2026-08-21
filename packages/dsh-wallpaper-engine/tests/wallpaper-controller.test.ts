import { describe, expect, it } from 'vitest';
import { createWallpaperController } from '../src/client/wallpaper-controller.js';

function fakeLayer() {
  const calls: string[] = [];
  return {
    calls,
    showImage: (u: string) => calls.push('image:' + u),
    showVideo: (u: string) => calls.push('video:' + u),
    showSceneCanvas: () => calls.push('scene'),
    showNone: () => calls.push('none'),
    setOverlayOpacity: () => {},
    setBlur: () => {},
  } as any;
}

const list = [
  { id: '1', type: 'video', file: 'a.mp4', hasScene: false, hasPreviewGif: false, previewUrl: '/p1', title: 'v' },
  { id: '2', type: 'scene', hasScene: true, hasPreviewGif: false, previewUrl: '/p2', title: 's' },
  { id: '3', type: 'unknown', hasScene: false, hasPreviewGif: true, previewUrl: '/p3', title: 'g' },
];

describe('createWallpaperController', () => {
  it('loads the wallpaper list once', async () => {
    const layer = fakeLayer();
    const c = createWallpaperController(layer, { fetchList: async () => list as any });
    const got = await c.load();
    expect(got).toHaveLength(3);
  });
  it('select video -> video plan', async () => {
    const layer = fakeLayer();
    const c = createWallpaperController(layer, { fetchList: async () => list as any });
    await c.load();
    await c.select('1');
    expect(layer.calls.at(-1)).toBe('video:/wallpapers/media/1/file');
  });
  it('select scene -> falls back to image when scene renderer absent', async () => {
    const layer = fakeLayer();
    const c = createWallpaperController(layer, { fetchList: async () => list as any });
    await c.load();
    await c.select('2');
    // 阶段 2 前 scene 无渲染器 → 回退 preview 图
    expect(layer.calls.at(-1)).toBe('image:/p2');
  });
  it('select gif wallpaper -> image without kenburns', async () => {
    const layer = fakeLayer();
    const c = createWallpaperController(layer, { fetchList: async () => list as any });
    await c.load();
    await c.select('3');
    expect(layer.calls.at(-1)).toBe('image:/p3');
  });
  it('select empty id -> 取消壁纸（showNone 恢复默认背景）', async () => {
    const layer = fakeLayer();
    const c = createWallpaperController(layer, { fetchList: async () => list as any });
    await c.load();
    await c.select('');
    expect(layer.calls.at(-1)).toBe('none');
  });
  it('select empty id 在列表未加载时也能取消（不依赖 fetchList）', async () => {
    const layer = fakeLayer();
    let fetched = false;
    const c = createWallpaperController(layer, { fetchList: async () => { fetched = true; return list as any; } });
    await c.select('');
    expect(layer.calls.at(-1)).toBe('none');
    expect(fetched).toBe(false);
  });
});
