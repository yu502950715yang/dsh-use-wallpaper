import { describe, expect, it } from 'vitest';
import { createWallpaperController } from '../../src/client/wallpaper-controller.js';

function fakeLayer() {
  const calls: { name: string; args: unknown[] }[] = [];
  return {
    calls,
    showImage: (u: string, kenBurns: boolean) => calls.push({ name: 'image', args: [u, kenBurns] }),
    showVideo: (u: string) => calls.push({ name: 'video', args: [u] }),
    showSceneCanvas: (c: HTMLCanvasElement) => calls.push({ name: 'scene', args: [c] }),
    showNone: () => calls.push({ name: 'none', args: [] }),
    setOverlayOpacity: () => {},
    setBlur: () => {},
  } as any;
}

const sceneInfo = {
  id: '2', type: 'scene', hasScene: true,
  hasPreviewGif: false, previewUrl: '/p2', title: 's',
};

async function controllerWith(render: (id: string, canvas: HTMLCanvasElement) => Promise<boolean>) {
  const layer = fakeLayer();
  const c = createWallpaperController(layer, {
    fetchList: async () => [sceneInfo] as any,
    sceneRenderer: { render },
  });
  await c.load();
  return { layer, c };
}

describe('createWallpaperController scene 分支（DOM）', () => {
  it('render resolve(true) -> showSceneCanvas', async () => {
    const { layer, c } = await controllerWith(async (_id, canvas) => {
      expect(canvas).toBeInstanceOf(HTMLCanvasElement);
      return true;
    });
    await c.select('2');
    expect(layer.calls.at(-1)?.name).toBe('scene');
  });
  it('render resolve(false) -> 回退 preview（含 kenBurns）', async () => {
    const { layer, c } = await controllerWith(async () => false);
    await c.select('2');
    expect(layer.calls.at(-1)).toEqual({ name: 'image', args: ['/p2', true] });
  });
  it('render reject -> 回退 preview 且不抛出', async () => {
    const { layer, c } = await controllerWith(async () => {
      throw new Error('boom');
    });
    await expect(c.select('2')).resolves.toBeUndefined();
    expect(layer.calls.at(-1)).toEqual({ name: 'image', args: ['/p2', true] });
  });
  it('I3: 旧的 scene 渲染完成不覆盖更新的选择（竞态防护）', async () => {
    const layer = fakeLayer();
    let resolveRender: ((v: boolean) => void) | null = null;
    const c = createWallpaperController(layer, {
      fetchList: async () => ([
        { id: '2', type: 'scene', hasScene: true, hasPreviewGif: false, previewUrl: '/p2', title: 's' },
        { id: '1', type: 'video', file: 'a.mp4', hasScene: false, hasPreviewGif: false, previewUrl: '/p1', title: 'v' },
      ] as any),
      sceneRenderer: {
        render: () => new Promise<boolean>((r) => { resolveRender = r; }),
      },
    });
    await c.load();
    const pendingScene = c.select('2'); // scene 渲染挂起
    await c.select('1');               // 新选择 video（同步应用）
    resolveRender!(true);              // 旧 scene 渲染此时才完成
    await pendingScene;
    expect(layer.calls.at(-1)?.name).toBe('video'); // 旧渲染被丢弃
  });
  it('I3/I6: 列表未加载时 select 自动 load 后再应用', async () => {
    const layer = fakeLayer();
    const c = createWallpaperController(layer, {
      fetchList: async () => [sceneInfo] as any,
      sceneRenderer: { render: async () => true },
    });
    // 不调用 load，直接 select：内部应自动拉取列表
    await c.select('2');
    expect(layer.calls.at(-1)?.name).toBe('scene');
  });
});
