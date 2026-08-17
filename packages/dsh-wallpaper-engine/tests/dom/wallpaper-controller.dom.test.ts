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
});
