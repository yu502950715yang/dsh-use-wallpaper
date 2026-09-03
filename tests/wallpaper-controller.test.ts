import { describe, expect, it } from 'vitest';
import { createWallpaperController } from '../src/client/wallpaper-controller.js';

function fakeLayer() {
  const calls: string[] = [];
  const fg: string[] = [];
  return {
    calls,
    fg,
    showImage: (u: string) => calls.push('image:' + u),
    showVideo: (u: string) => calls.push('video:' + u),
    showSceneCanvas: () => calls.push('scene'),
    showNone: () => calls.push('none'),
    setOverlayOpacity: () => {},
    setBlur: () => {},
    // 文字颜色跟随壁纸亮度：单独记录 setChatFg，不污染主 calls（不影响 switch 展示断言）。
    setChatFg: (c: string) => fg.push('fg:' + c),
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
  it('REPRO(I1): 缓存列表不含新添加壁纸时，select 该 id 应重新拉取列表后再选中', async () => {
    // 新添加壁纸在设置面板可见（组件独立 fetch），但 controller 内部缓存的 list 是旧列表。
    // 旧行为：list.find(id) 找不到 → 直接 return → 背景无任何变化（bug）。
    // 期望：select 找不到时重新 load 一次，列表刷新后能选中新壁纸。
    const layer = fakeLayer();
    let fetched = 0;
    const c = createWallpaperController(layer, {
      fetchList: async () => {
        fetched++;
        // 第一次（controller 初次缓存）：旧列表，不含新壁纸 '4'
        if (fetched === 1) {
          return ([{ id: '1', type: 'video', file: 'a.mp4', hasScene: false, hasPreviewGif: false, previewUrl: '/p1', title: 'v' }] as any);
        }
        // 之后：含新添加壁纸 '4'（新壁纸选择后按 preview 回退显示）
        return ([
          { id: '1', type: 'video', file: 'a.mp4', hasScene: false, hasPreviewGif: false, previewUrl: '/p1', title: 'v' },
          { id: '4', type: 'unknown', hasScene: false, hasPreviewGif: true, previewUrl: '/p4', title: 'new' },
        ] as any);
      },
    });
    await c.load();      // 缓存旧列表（不含 '4'）
    await c.select('4'); // 选择新添加的壁纸
    expect(layer.calls.at(-1)).toBe('image:/p4'); // 修复后命中 preview 回退
  });
});
