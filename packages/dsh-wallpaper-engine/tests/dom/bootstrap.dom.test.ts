import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// I1/I2/I6 集成测试：client bootstrap 的挂载行为。
// - I1: mount 读回设置后恢复已保存的选中壁纸（load + select）
// - I2: 注入浮动按钮（.wp-fab）与面板容器（.wp-picker-panel），点击 toggle picker
// - I6: show(scene) 委托 controller.select → 渲染失败回退 preview 图
//
// index.ts 在 import 时若 window.__ModuleLoader__ 存在则交给 loader 而非自动
// bootstrap —— 借此捕获 factory 手动控制挂载时机。

vi.mock('../../src/client/scene-renderer.js', () => ({
  renderScene: vi.fn(async () => false), // scene 渲染失败 → 触发 preview 回退（I6 路径）
}));

let capturedFactory: (() => unknown) | null = null;

function jsonResp(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as any;
}

function stubFetch(list: unknown[], settingsValue: unknown) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/wallpapers/list') return jsonResp(list);
    if (url === '/api/settings.describe') {
      return jsonResp({
        type: 'server-response', rpcId: 'r',
        result: {
          ok: true,
          value: {
            writable: true, hasDocument: true,
            namespaces: [{ ns: 'wallpaper-engine', value: settingsValue }],
          },
        },
      });
    }
    return { ok: false, status: 404, json: async () => ({}) } as any;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function boot(): Promise<any> {
  document.body.innerHTML = '';
  capturedFactory = null;
  (window as any).__ModuleLoader__ = { load: (spec: any) => { capturedFactory = spec.factory; } };
  vi.resetModules();
  await import('../../src/client/index.js');
  const factory = capturedFactory!;
  const api = factory() as { bootstrap: () => void };
  api.bootstrap();
  if (document.readyState === 'loading') document.dispatchEvent(new Event('DOMContentLoaded'));
  return (window as any).__wallpaperEngine;
}

const EMPTY_SETTINGS = { selectedWallpaperId: '', overlayOpacity: 0.35, blurEnabled: false, blurRadius: 12, kenBurns: true };

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as any).__wallpaperEngine;
  delete (window as any).__ModuleLoader__;
});

describe('client bootstrap 集成', () => {
  it('I1: mount 恢复已保存的选中壁纸（settings.selectedWallpaperId → load + select）', async () => {
    stubFetch(
      [{ id: '1', title: 'A', type: 'image', hasScene: false, hasPreviewGif: false, previewUrl: '/p1' }],
      { ...EMPTY_SETTINGS, selectedWallpaperId: '1' },
    );
    await boot();
    await vi.waitFor(() => {
      const img = document.querySelector('.wp-background-layer .wp-bg-fill img') as HTMLImageElement | null;
      expect(img?.src).toContain('/p1');
    });
  });
  it('I1: 未保存选中壁纸时挂载不触发 select', async () => {
    const fetchMock = stubFetch(
      [{ id: '1', title: 'A', type: 'image', hasScene: false, hasPreviewGif: false, previewUrl: '/p1' }],
      EMPTY_SETTINGS,
    );
    await boot();
    await new Promise((r) => setTimeout(r, 20));
    const img = document.querySelector('.wp-background-layer .wp-bg-fill img') as HTMLImageElement | null;
    expect(img).toBeNull();
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/wallpapers/list')).toHaveLength(0);
  });
  it('I2: bootstrap 注入浮动按钮，点击展开 picker 面板', async () => {
    stubFetch(
      [{ id: '1', title: 'A', type: 'image', hasScene: false, hasPreviewGif: false, previewUrl: '/p1' }],
      EMPTY_SETTINGS,
    );
    await boot();
    const fab = document.querySelector('.wp-fab') as HTMLButtonElement | null;
    expect(fab).not.toBeNull();
    const panel = document.querySelector('.wp-picker-panel') as HTMLElement | null;
    expect(panel).not.toBeNull();
    expect(panel!.hidden).toBe(true); // 默认收起
    fab!.click();
    await vi.waitFor(() => {
      expect((document.querySelector('.wp-picker-panel') as HTMLElement).hidden).toBe(false);
    });
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.wp-picker-panel .wp-thumb').length).toBe(1);
    });
    fab!.click(); // 再点收起
    expect((document.querySelector('.wp-picker-panel') as HTMLElement).hidden).toBe(true);
  });
  it('I6: show(scene) 委托 controller，渲染失败回退 preview 图', async () => {
    stubFetch(
      [{ id: '2', title: 'S', type: 'scene', hasScene: true, hasPreviewGif: false, previewUrl: '/p2' }],
      EMPTY_SETTINGS,
    );
    const api = await boot();
    api.show({ kind: 'scene', wallpaperId: '2' });
    await vi.waitFor(() => {
      const img = document.querySelector('.wp-background-layer .wp-bg-fill img') as HTMLImageElement | null;
      expect(img?.src).toContain('/p2');
    });
  });
  it('show(image) 直接显示图片（回归）', async () => {
    stubFetch([], EMPTY_SETTINGS);
    const api = await boot();
    api.show({ kind: 'image', url: '/p1', kenBurns: true });
    await vi.waitFor(() => {
      const img = document.querySelector('.wp-background-layer .wp-bg-fill img') as HTMLImageElement | null;
      expect(img?.src).toContain('/p1');
    });
  });
});
