import { describe, expect, it, vi } from 'vitest';
import { createWallpaperController } from '../src/client/wallpaper-controller.js';

function fakeLayer() {
  const calls: string[] = [];
  const fg: string[] = [];
  const outline: string[] = [];
  return {
    calls,
    fg,
    outline,
    showImage: (u: string) => calls.push('image:' + u),
    showVideo: (u: string) => calls.push('video:' + u),
    showSceneCanvas: () => calls.push('scene'),
    showNone: () => calls.push('none'),
    setOverlayOpacity: () => {},
    setBlur: () => {},
    // 文字颜色跟随壁纸亮度：单独记录 setChatFg，不污染主 calls（不影响 switch 展示断言）。
    setChatFg: (c: string) => fg.push('fg:' + c),
    setChatOutline: (c: string, lv: number) => outline.push(`outline:${c}:${lv}`),
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

// 贴壁纸文字颜色（2026-10-01，用户报告「某些壁纸文字看不清」）：设置面板可手动指定文字色，
// 手动档**跳过** preview 亮度测量直接下发固定色（否则异步测量会把手选颜色覆盖掉）；
// auto 档保持既有行为（测不出来 → 清变量回主题默认）。描边档位随颜色一起下发。
describe('createWallpaperController 文字颜色（手动档优先于自动测量）', () => {
  const style = (patch: Partial<{ mode: string; custom: string; outline: number }> = {}) =>
    ({ mode: 'auto', custom: '#ff8800', outline: 0, ...patch });
  const luma = (id: string) => ({ id, type: 'unknown', hasScene: false, hasPreviewGif: false, previewUrl: '/p' + id, title: 't' });
  const setup = (opts: any = {}) => {
    const layer = fakeLayer();
    const c = createWallpaperController(layer, { fetchList: async () => [luma('1')] as any, ...opts });
    return { layer, c };
  };

  it('手动白/黑/自定义：select 后直接下发固定色（不依赖 preview 测量）', async () => {
    for (const [mode, want] of [['white', '#ffffff'], ['black', '#000000'], ['custom', '#ff8800']] as const) {
      const { layer, c } = setup({ textStyle: () => style({ mode }) });
      await c.load();
      await c.select('1');
      expect(layer.fg.at(-1)).toBe('fg:' + want);
    }
  });

  it('自定义色非法时回退白色（不把任意串写进 CSS 变量）', async () => {
    const { layer, c } = setup({ textStyle: () => style({ mode: 'custom', custom: 'red;x' }) });
    await c.load();
    await c.select('1');
    expect(layer.fg.at(-1)).toBe('fg:#ffffff');
  });

  it('描边档位随文字色一起下发（对立色由 layer 计算）', async () => {
    const { layer, c } = setup({ textStyle: () => style({ mode: 'black', outline: 2 }) });
    await c.load();
    await c.select('1');
    expect(layer.outline.at(-1)).toBe('outline:#000000:2');
  });

  it('auto 档：测量不出亮度 → 清空颜色与描边（回主题默认，与既有行为一致）', async () => {
    const { layer, c } = setup({ measurePreviewLuma: async () => null, textStyle: () => style({ outline: 3 }) });
    await c.load();
    await c.select('1');
    expect(layer.fg.at(-1)).toBe('fg:');
    expect(layer.outline.at(-1)).toBe('outline::0');
  });

  it('auto 档：测出暗壁纸 → 白字 + 描边档位生效', async () => {
    const { layer, c } = setup({ measurePreviewLuma: async () => 32, textStyle: () => style({ outline: 1 }) });
    await c.load();
    await c.select('1');
    expect(layer.fg.at(-1)).toBe('fg:#f9fafb');
    expect(layer.outline.at(-1)).toBe('outline:#f9fafb:1');
  });

  it('auto 档：测出亮壁纸 → 黑字', async () => {
    const { layer, c } = setup({ measurePreviewLuma: async () => 220, textStyle: () => style() });
    await c.load();
    await c.select('1');
    expect(layer.fg.at(-1)).toBe('fg:#0f1115');
  });

  it('测量回调期间用户改成手动档 → 迟到的测量结果不得覆盖手选颜色', async () => {
    let release: (v: number | null) => void = () => {};
    const pending = new Promise<number | null>((r) => { release = r; });
    let mode = 'auto';
    const { layer, c } = setup({ measurePreviewLuma: () => pending, textStyle: () => style({ mode }) });
    await c.load();
    await c.select('1');          // auto：启动测量（挂起）
    mode = 'white';
    c.applyTextStyle();           // 用户改设置 → 立即按手动档下发
    expect(layer.fg.at(-1)).toBe('fg:#ffffff');
    release(32);                  // 迟到的测量结果回来
    await new Promise((r) => setTimeout(r, 0));
    expect(layer.fg.at(-1)).toBe('fg:#ffffff'); // 仍是手选色
  });

  it('applyTextStyle()：设置变更后无需重选壁纸即可生效', async () => {
    let s = style({ mode: 'auto' });
    const { layer, c } = setup({ measurePreviewLuma: async () => 220, textStyle: () => s });
    await c.load();
    await c.select('1');
    expect(layer.fg.at(-1)).toBe('fg:#0f1115');
    s = style({ mode: 'custom', custom: '#00ff00', outline: 2 });
    c.applyTextStyle();
    expect(layer.fg.at(-1)).toBe('fg:#00ff00');
    expect(layer.outline.at(-1)).toBe('outline:#00ff00:2');
  });

  it('取消壁纸（select 空 id）清空颜色与描边变量', async () => {
    const { layer, c } = setup({ textStyle: () => style({ mode: 'white', outline: 1 }) });
    await c.load();
    await c.select('1');
    await c.select('');
    expect(layer.fg.at(-1)).toBe('fg:');
    expect(layer.outline.at(-1)).toBe('outline::0');
  });

  // auto 档改描边（2026-10-01，用户报告「选自动时描边像不生效」）：首次测光结果要**缓存**，
  // 之后改档位/描边同步下发（拖动即时可见），且不再为每次拖动重新测图。
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('auto 档：测光完成后改描边同步生效（拖动即时可见），且不再重新测图', async () => {
    let outline = 0;
    const measure = vi.fn(async () => 220);
    const layer = fakeLayer();
    const c = createWallpaperController(layer, {
      fetchList: async () => [luma('1')] as any,
      measurePreviewLuma: measure,
      textStyle: () => style({ outline }),
    });
    await c.load();
    await c.select('1'); // 首次：启动测光
    await tick();
    expect(layer.fg.at(-1)).toBe('fg:#0f1115');
    expect(measure).toHaveBeenCalledTimes(1);

    outline = 2;
    c.applyTextStyle(); // 用户拖描边 → 同步下发（无需 await）
    expect(layer.outline.at(-1)).toBe('outline:#0f1115:2');
    await tick();
    expect(measure).toHaveBeenCalledTimes(1); // 没有为拖滑杆重新测图
  });

  it('auto 档：切换壁纸不复用上一张的测光结果（各自重新测光）', async () => {
    const two = [luma('1'), luma('2')];
    const measure = vi.fn(async (url: string) => (url.includes('p2') ? 220 : 32));
    const layer = fakeLayer();
    const c = createWallpaperController(layer, {
      fetchList: async () => two as any,
      measurePreviewLuma: measure,
      textStyle: () => style(),
    });
    await c.load();
    await c.select('1');
    await tick();
    expect(layer.fg.at(-1)).toBe('fg:#f9fafb'); // 暗壁纸 → 白字
    await c.select('2');
    await tick();
    expect(layer.fg.at(-1)).toBe('fg:#0f1115'); // 新壁纸重新测光，而非沿用白字
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('auto 档：测光瞬时失败但有上次结果 → 保留旧色与描边（不闪回主题默认）', async () => {
    const measure = vi.fn(async () => 32);
    const layer = fakeLayer();
    const c = createWallpaperController(layer, {
      fetchList: async () => [luma('1')] as any,
      measurePreviewLuma: measure,
      textStyle: () => style({ outline: 1 }),
    });
    await c.load();
    await c.select('1');
    await tick();
    expect(layer.fg.at(-1)).toBe('fg:#f9fafb');
    measure.mockImplementation(async () => null); // 第二次测光失败（网络抖动 / 跨源）
    await c.select('1');
    await tick();
    expect(layer.fg.at(-1)).toBe('fg:#f9fafb');                  // 保留旧色
    expect(layer.outline.at(-1)).toBe('outline:#f9fafb:1');      // 描边同样保留
  });
});
