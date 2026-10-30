import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// I1/I6/S1 集成测试：client bootstrap 的挂载行为。
// - I1: mount 读回设置后恢复已保存的选中壁纸（load + select）
// - I6: show(scene) 委托 controller.select → 渲染失败回退 preview 图
// - S1: 注册 DSH 设置对话框侧边栏 "壁纸" 菜单（settings.section slot），不再注入 FAB
//
// bundle 的模块注册由构建产物 wrapper（window.__ModuleLoader__.load）完成，
// 源码 index.ts 只导出 apply/bootstrap —— 测试直接调用 apply(ctx)。

function jsonResp(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as any;
}

// 插件设置走 ctx.remote.settings（DSH 0.1.2-rc.1 起的 Typert 远程方法，见 settings.ts 文件头）。
// ⚠️ 旧版 fetch('/api/settings.describe') 已不被识别 —— 曾按它写的用例永远读不到
// selectedWallpaperId（恒返回 DEFAULTS），是 I1 用例长期失败的真因。
function settingsCtx(settingsValue: unknown) {
  return {
    remote: {
      settings: {
        describe: async () => ({
          ok: true,
          value: { writable: true, hasDocument: true, namespaces: [{ ns: 'wallpaper-engine', value: settingsValue }] },
        }),
        update: async () => ({}),
      },
    },
  };
}

// 壁纸列表仍走 host HTTP 路由（controller.fetchList → fetch('/wallpapers/list')）。
function stubFetch(list: unknown[]) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/wallpapers/list') return jsonResp(list);
    return { ok: false, status: 404, json: async () => ({}) } as any;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function mockSlotsCtx() {
  const sections: Array<{ opts: any; Component: unknown }> = [];
  const ctx = {
    slots: {
      // 回调内可注册多个 section：register 立即登记并返回注销函数（与真实 SlotRegistry 同款）。
      inject: (name: string, fn: () => unknown) => {
        if (name === 'settings.section') fn();
      },
      register: (opts: any, Component: unknown) => {
        sections.push({ opts, Component });
        return () => {};
      },
    },
  };
  return { ctx, sections };
}

async function boot(ctx?: unknown): Promise<any> {
  document.body.innerHTML = '';
  vi.resetModules();
  const mod = await import('../../src/client/index.js');
  mod.apply(ctx);
  if (document.readyState === 'loading') document.dispatchEvent(new Event('DOMContentLoaded'));
  return (window as any).__wallpaperEngine;
}

const EMPTY_SETTINGS = { selectedWallpaperId: '', wallpaperDir: '', weAssetsDir: '', overlayOpacity: 0.35, blurEnabled: false, blurRadius: 12, kenBurns: true };

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as any).__wallpaperEngine;
  delete (window as any).__wallpaperEngineBoot;
});

describe('client bootstrap 集成', () => {
  it('I1: mount 恢复已保存的选中壁纸（settings.selectedWallpaperId → load + select）', async () => {
    stubFetch(
      [{ id: '1', title: 'A', type: 'image', hasScene: false, hasPreviewGif: false, previewUrl: '/p1' }],
    );
    await boot(settingsCtx({ ...EMPTY_SETTINGS, selectedWallpaperId: '1' }));
    await vi.waitFor(() => {
      const img = document.querySelector('.wp-background-layer .wp-bg-fill img') as HTMLImageElement | null;
      expect(img?.src).toContain('/p1');
    });
  });
  it('I1: 未保存选中壁纸时挂载不触发 select', async () => {
    const fetchMock = stubFetch(
      [{ id: '1', title: 'A', type: 'image', hasScene: false, hasPreviewGif: false, previewUrl: '/p1' }],
    );
    await boot(settingsCtx(EMPTY_SETTINGS));
    await new Promise((r) => setTimeout(r, 20));
    const img = document.querySelector('.wp-background-layer .wp-bg-fill img') as HTMLImageElement | null;
    expect(img).toBeNull();
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/wallpapers/list')).toHaveLength(0);
  });
  it('I2: 首次启用轮播但列表未 load ⇒ 懒加载一次；随后设置变更不重复拉列表', async () => {
    const fetchMock = stubFetch(
      [{ id: '1', title: 'A', type: 'image', hasScene: false, hasPreviewGif: false, previewUrl: '/p1' }],
    );
    await boot(settingsCtx({ ...EMPTY_SETTINGS, rotationEnabled: true }));
    const listCalls = () => fetchMock.mock.calls.filter((c) => c[0] === '/wallpapers/list').length;
    await vi.waitFor(() => expect(listCalls()).toBe(1));
    // 列表已 load ⇒ 后续 applyRuntimeSettings（visibilitychange）不再重复拉
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 20));
    expect(listCalls()).toBe(1);
  });
  it('S1: bootstrap 注册设置菜单 settings.section（壁纸 + 开机动画），不再注入 FAB', async () => {
    stubFetch(
      [{ id: '1', title: 'A', type: 'image', hasScene: false, hasPreviewGif: false, previewUrl: '/p1' }],
    );
    const { ctx, sections } = mockSlotsCtx();
    await boot(ctx);
    expect(sections.length).toBe(2);
    expect(sections[0]!.opts.id).toBe('wallpaper-engine');
    expect(sections[0]!.opts.label()).toBe('Wallpaper 壁纸');
    expect(sections[0]!.Component).toBeTruthy(); // WallpaperSettingsSection
    expect(sections[1]!.opts.id).toBe('wallpaper-engine-boot');
    expect(sections[1]!.opts.order).toBe(21);
    expect(sections[1]!.opts.label()).toBe('开机动画');
    expect(sections[1]!.Component).toBeTruthy(); // BootSettingsSection
    // 不再注入浮动按钮
    expect(document.querySelector('.wp-fab')).toBeNull();
  });
  it('I6: show(scene) 委托 controller，渲染失败回退 preview 图', async () => {
    stubFetch(
      [{ id: '2', title: 'S', type: 'scene', hasScene: true, hasPreviewGif: false, previewUrl: '/p2' }],
    );
    const api = await boot();
    api.show({ kind: 'scene', wallpaperId: '2' });
    await vi.waitFor(() => {
      const img = document.querySelector('.wp-background-layer .wp-bg-fill img') as HTMLImageElement | null;
      expect(img?.src).toContain('/p2');
    });
  });
  it('show(image) 直接显示图片（回归）', async () => {
    stubFetch([]);
    const api = await boot();
    api.show({ kind: 'image', url: '/p1', kenBurns: true });
    await vi.waitFor(() => {
      const img = document.querySelector('.wp-background-layer .wp-bg-fill img') as HTMLImageElement | null;
      expect(img?.src).toContain('/p1');
    });
  });
});
