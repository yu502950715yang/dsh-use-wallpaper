import { describe, expect, it } from 'vitest';
import { createWallpaperController } from '../../src/client/wallpaper-controller.js';
import { createBackgroundLayer } from '../../src/client/background-layer.js';

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

  it('scene 分支只在 DOM 里放**一个** canvas（= 渲染/显示的那个，尺寸 = 视口×dpr）', async () => {
    // 2026-09-10 Task5（真机 console 实证）：`document.querySelector('canvas')` 得到 300×150
    // （HTML canvas 默认）—— 根因是 controller 额外创建了一个**没人设尺寸**的 bg canvas，被
    // background-layer 作为 `.wp-scene-blur` 先 append（DOM 序在前，故 querySelector 命中它）。
    // 修复后：只创建 fg 一个 canvas 并 append；它的缓冲尺寸由渲染器设为 视口×dpr。
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const layer = createBackgroundLayer(root);
    const seen: { id: string; fg: HTMLCanvasElement; bg?: HTMLCanvasElement }[] = [];
    const c = createWallpaperController(layer, {
      fetchList: async () => [sceneInfo] as any,
      sceneRenderer: {
        render: async (id, fg, bg) => {
          seen.push({ id, fg, bg });
          // 模拟 three 渲染器：渲染缓冲 = 视口逻辑尺寸 × dpr
          const dpr = window.devicePixelRatio || 1;
          fg.width = Math.floor(window.innerWidth * dpr);
          fg.height = Math.floor(window.innerHeight * dpr);
          return true;
        },
      },
    });
    await c.load();
    await c.select('2');

    expect(seen.length).toBe(1);
    expect(seen[0].bg).toBeUndefined(); // 不再创建/传递没人用的 bg canvas
    const canvases = [...document.querySelectorAll('canvas')];
    expect(canvases.length).toBe(1); // 页面里只有一个 canvas
    const q = document.querySelector('canvas') as HTMLCanvasElement;
    expect(q).toBe(seen[0].fg); // querySelector 命中的就是渲染 + 显示的那个
    expect(q.width).toBe(Math.floor(window.innerWidth * (window.devicePixelRatio || 1)));
    expect(q.height).toBe(Math.floor(window.innerHeight * (window.devicePixelRatio || 1)));
    expect(q.width).not.toBe(300);
    expect(q.height).not.toBe(150);
    expect(q.classList.contains('wp-scene-canvas')).toBe(true);
    expect(document.querySelector('.wp-scene-blur')).toBeNull();
  });
});
