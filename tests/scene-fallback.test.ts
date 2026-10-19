// scene 降级链（v0.8 Task 6）：内嵌视频 → 首帧缓存 → 作者预览图 → 空。
// 所有失败路径只 warn / 返回 null，不向调用方抛错（绝不白屏）。
import { describe, expect, it, vi } from 'vitest';
import {
  ensureSceneFrame,
  probeEmbeddedVideo,
  showSceneFallback,
  type SceneFallbackDeps,
} from '../src/client/scene-fallback.js';
import type { WallpaperInfo } from '../src/shared/types.js';

type VideoResult = 'ok' | 'unsupported' | 'timeout';

function fakeLayer() {
  return {
    showImage: vi.fn((_url: string, _kenBurns: boolean) => {}),
    showVideo: vi.fn(async (_url: string): Promise<VideoResult> => 'ok'),
    showNone: vi.fn(() => {}),
  };
}

const info = {
  id: '42', title: 't', type: 'scene', hasPreviewGif: false, hasScene: true, previewUrl: '/prev',
} as WallpaperInfo;

function captureRenderer(png: Uint8Array | null = Uint8Array.from([1, 2, 3])) {
  return { captureFrame: vi.fn(async () => png) };
}

describe('probeEmbeddedVideo', () => {
  it('video=true → 内嵌视频 URL', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ video: true }), { status: 200 }));
    await expect(probeEmbeddedVideo('42', f as any)).resolves.toBe('/wallpapers/scene/42/embedded-video');
    expect(f).toHaveBeenCalledWith('/wallpapers/scene/42/video-probe');
  });

  it('video=false / 非 2xx / 响应体异常 / 网络异常 → null（不抛）', async () => {
    await expect(probeEmbeddedVideo('42', vi.fn(async () => new Response(JSON.stringify({ video: false }))) as any))
      .resolves.toBeNull();
    await expect(probeEmbeddedVideo('42', vi.fn(async () => new Response(null, { status: 404 })) as any))
      .resolves.toBeNull();
    await expect(probeEmbeddedVideo('42', vi.fn(async () => new Response('not json')) as any))
      .resolves.toBeNull();
    await expect(probeEmbeddedVideo('42', vi.fn(async () => { throw new Error('offline'); }) as any))
      .resolves.toBeNull();
  });
});

describe('ensureSceneFrame', () => {
  it('HEAD 200（已有缓存）→ 不抓帧、不 POST', async () => {
    const f = vi.fn(async () => new Response(null, { status: 200 }));
    const renderer = captureRenderer();
    await ensureSceneFrame('42', { fetch: f as any, renderer });
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledWith('/wallpapers/frame/42', { method: 'HEAD' });
    expect(renderer.captureFrame).not.toHaveBeenCalled();
  });

  it('HEAD 404 → 抓帧 → POST image/png', async () => {
    const png = Uint8Array.from([1, 2, 3]);
    const f = vi.fn(async (_url: string, init?: { method?: string }) => (
      init?.method === 'HEAD'
        ? new Response(null, { status: 404 })
        : new Response(JSON.stringify({ ok: true }), { status: 201 })
    ));
    const renderer = captureRenderer(png);
    await ensureSceneFrame('42', { fetch: f as any, renderer });
    expect(renderer.captureFrame).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(2);
    const [url, init] = f.mock.calls[1] as unknown as [string, { method: string; headers: Record<string, string>; body: ArrayBuffer }];
    expect(url).toBe('/wallpapers/frame/42');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'image/png' });
    expect([...new Uint8Array(init.body)]).toEqual([...png]);
  });

  it('抓帧返回 null / 渲染器无 captureFrame → 不发 POST', async () => {
    const f = vi.fn(async (_url: string, init?: { method?: string }) => (
      init?.method === 'HEAD' ? new Response(null, { status: 404 }) : new Response(null, { status: 201 })
    ));
    await ensureSceneFrame('42', { fetch: f as any, renderer: captureRenderer(null) });
    await ensureSceneFrame('43', { fetch: f as any, renderer: {} });
    expect(f).toHaveBeenCalledTimes(2); // 两次都只有 HEAD
  });

  it('抓帧抛错 / HEAD 抛错 / POST 非 2xx → resolve 且只 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const head404 = vi.fn(async (_url: string, init?: { method?: string }) => (
      init?.method === 'HEAD' ? new Response(null, { status: 404 }) : new Response(null, { status: 500 })
    ));
    await expect(ensureSceneFrame('42', {
      fetch: head404 as any,
      renderer: { captureFrame: async () => Uint8Array.from([1]) },
    })).resolves.toBeUndefined();
    await expect(ensureSceneFrame('43', {
      fetch: head404 as any,
      renderer: { captureFrame: async () => { throw new Error('gl lost'); } },
    })).resolves.toBeUndefined();
    await expect(ensureSceneFrame('44', {
      fetch: vi.fn(async () => { throw new Error('offline'); }) as any,
      renderer: captureRenderer(),
    })).resolves.toBeUndefined();
    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(2);
    warn.mockRestore();
  });

  it('同 id 并发去重：只发一次 HEAD / 一次抓帧', async () => {
    let release!: (r: Response) => void;
    const gate = new Promise<Response>((res) => { release = res; });
    const f = vi.fn(async (_url: string, init?: { method?: string }) => (
      init?.method === 'HEAD' ? gate : new Response(null, { status: 201 })
    ));
    const renderer = captureRenderer();
    const deps = { fetch: f as any, renderer };
    const a = ensureSceneFrame('7', deps);
    const b = ensureSceneFrame('7', deps);
    expect(f).toHaveBeenCalledTimes(1);
    release(new Response(null, { status: 404 }));
    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined]);
    expect(renderer.captureFrame).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('showSceneFallback', () => {
  it('有内嵌视频 → 先播视频；视频失败 → 抓帧；无帧 → 预览', async () => {
    const layer = fakeLayer();
    const f1 = vi.fn(async (url: string) => (url.includes('video-probe')
      ? new Response(JSON.stringify({ video: true }), { status: 200 })
      : url.includes('embedded-video') ? new Response(null, { status: 200 })
        : new Response(null, { status: 404 })));
    await expect(showSceneFallback(info, { fetch: f1 as any, layer })).resolves.toBe('video');
    expect(layer.showVideo).toHaveBeenCalledWith('/wallpapers/scene/42/embedded-video');

    layer.showVideo.mockResolvedValueOnce('unsupported');
    const f2 = vi.fn(async (url: string) => (url.includes('video-probe')
      ? new Response(JSON.stringify({ video: true }))
      : url.includes('/wallpapers/frame/') ? new Response(Uint8Array.from([1])) : new Response(null, { status: 404 })));
    await expect(showSceneFallback(info, { fetch: f2 as any, layer })).resolves.toBe('frame');
    expect(layer.showImage).toHaveBeenLastCalledWith('/wallpapers/frame/42', false);
  });

  it('无内嵌视频但已有帧缓存 → frame（不播视频）', async () => {
    const layer = fakeLayer();
    const f = vi.fn(async (url: string) => (url.includes('video-probe')
      ? new Response(JSON.stringify({ video: false }))
      : new Response(Uint8Array.from([1]))));
    await expect(showSceneFallback(info, { fetch: f as any, layer })).resolves.toBe('frame');
    expect(layer.showVideo).not.toHaveBeenCalled();
    expect(layer.showImage).toHaveBeenLastCalledWith('/wallpapers/frame/42', false);
  });

  it('视频/帧都不可用 → 作者预览图（按 GIF 决定 Ken Burns）', async () => {
    const layer = fakeLayer();
    const f = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(showSceneFallback(info, { fetch: f as any, layer })).resolves.toBe('preview');
    expect(layer.showImage).toHaveBeenLastCalledWith('/prev', true);

    const gifLayer = fakeLayer();
    await expect(showSceneFallback({ ...info, hasPreviewGif: true } as WallpaperInfo, { fetch: f as any, layer: gifLayer }))
      .resolves.toBe('preview');
    expect(gifLayer.showImage).toHaveBeenLastCalledWith('/prev', false);
  });

  it('无 preview → showNone / none', async () => {
    const layer = fakeLayer();
    const f = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(showSceneFallback({ ...info, previewUrl: '' } as WallpaperInfo, { fetch: f as any, layer }))
      .resolves.toBe('none');
    expect(layer.showNone).toHaveBeenCalledTimes(1);
  });

  it('probe / HEAD 抛异常同样继续降级；showVideo 抛错也不阻断', async () => {
    const layer = fakeLayer();
    layer.showVideo.mockRejectedValueOnce(new Error('decode failed'));
    const f = vi.fn(async (url: string) => {
      if (url.includes('video-probe')) return new Response(JSON.stringify({ video: true }));
      if (url.includes('/wallpapers/frame/')) throw new Error('offline');
      return new Response(null, { status: 404 });
    });
    await expect(showSceneFallback(info, { fetch: f as any, layer })).resolves.toBe('preview');
    expect(layer.showImage).toHaveBeenLastCalledWith('/prev', true);
  });

  it('类型契约：deps 只要求 fetch/layer 三项显示能力', async () => {
    const deps: SceneFallbackDeps = { fetch: (async () => new Response(null, { status: 404 })) as typeof fetch, layer: fakeLayer() };
    await expect(showSceneFallback(info, deps)).resolves.toBe('preview');
  });
});
