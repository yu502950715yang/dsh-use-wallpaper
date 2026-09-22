import { describe, expect, it, vi } from 'vitest';
import {
  createBackgroundLayer,
  WEB_RESIZE_RELOAD_DELAY_MS,
  WEB_RESIZE_RELOAD_TIMEOUT_MS,
} from '../../src/client/background-layer.js';

describe('createBackgroundLayer (DOM)', () => {
  it('renders image into fill and toggles kenburns class', () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const layer = createBackgroundLayer(root);
    layer.showImage('/p.gif', false);
    const img = root.querySelector('.wp-bg-fill img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toContain('/p.gif');
    expect(img.classList.contains('wp-kenburns')).toBe(false);
    layer.showImage('/q.jpg', true);
    const img2 = root.querySelector('.wp-bg-fill img') as HTMLImageElement;
    expect(img2.classList.contains('wp-kenburns')).toBe(true);
  });
  it('applies overlay opacity', () => {
    const root = document.createElement('div');
    const layer = createBackgroundLayer(root);
    layer.setOverlayOpacity(0.5);
    const overlay = root.querySelector('.wp-bg-overlay') as HTMLElement;
    expect(overlay.style.opacity).toBe('0.5');
  });
  it('sets data-we-wallpaper on body when wallpaper active, removes when none', () => {
    document.body.innerHTML = '';
    document.body.removeAttribute('data-we-wallpaper');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const layer = createBackgroundLayer(root);
    expect(document.body.hasAttribute('data-we-wallpaper')).toBe(false);
    layer.showImage('/p.gif', false);
    expect(document.body.getAttribute('data-we-wallpaper')).toBe('true');
    layer.showNone();
    expect(document.body.hasAttribute('data-we-wallpaper')).toBe(false);
  });
  it('keeps data-we-wallpaper across media switches, clears on showNone', () => {
    document.body.innerHTML = '';
    document.body.removeAttribute('data-we-wallpaper');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const layer = createBackgroundLayer(root);
    layer.showImage('/a.jpg', true);
    layer.showVideo('/b.mp4');
    expect(document.body.getAttribute('data-we-wallpaper')).toBe('true');
    layer.showNone();
    expect(document.body.hasAttribute('data-we-wallpaper')).toBe(false);
  });

  it('showSceneCanvas 把模糊层 canvas 的缓冲对齐前景（不再停在 300×150 被 CSS 拉伸）', () => {
    // 2026-09-10 Task5：模糊层 canvas 若保持 HTML 默认 300×150，会被
    // `.wp-scene-blur{width:100%;height:100%;transform:scale(1.1)}` 放大到全屏（模糊/失真），
    // 且 DOM 序在前 → `document.querySelector('canvas')` 读到它而非真正渲染的 canvas。
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const layer = createBackgroundLayer(root);
    const fg = document.createElement('canvas');
    fg.width = 3840; // 视口 1920 × dpr 2
    fg.height = 2160;
    const blur = document.createElement('canvas');
    expect(blur.width).toBe(300); // HTML 默认值
    layer.showSceneCanvas(fg, blur);
    expect(blur.width).toBe(3840);
    expect(blur.height).toBe(2160);
    expect(blur.classList.contains('wp-scene-blur')).toBe(true);
    expect(fg.classList.contains('wp-scene-canvas')).toBe(true);
  });

  // AGENT.md §5.30：无 allow-same-origin 的沙箱是 opaque origin，壁纸自己的 img/video 也算跨源，
  // WebGL texImage2D 会抛 SecurityError（web 壁纸空白）⇒ 改用另一回环主机名承载壁纸。
  it('showWeb：另一回环主机名可达时跨源承载，并保留 allow-same-origin', async () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({} as Response);
    try {
      const layer = createBackgroundLayer(root);
      layer.showWeb('/wallpapers/web/9/index.html');
      await vi.waitFor(() => expect(root.querySelector('.wp-bg-fill iframe')).not.toBeNull());
      const frame = root.querySelector('.wp-bg-fill iframe') as HTMLIFrameElement;
      // jsdom 的 location 是 http://localhost:3000 → 应为互换后的 127.0.0.1
      expect(frame.getAttribute('src')).toBe('http://127.0.0.1:3000/wallpapers/web/9/index.html');
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
      expect(frame.getAttribute('allow')).toBe('autoplay; fullscreen');
      expect(frame.getAttribute('scrolling')).toBe('no'); // 壁纸是背景：不允许子帧滚动条吃掉视口
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:3000/wallpapers/web/9/index.html',
        expect.objectContaining({ mode: 'no-cors' }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('showWeb：另一主机名不可达时退回同源 + 纯 allow-scripts 沙箱', async () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network error'));
    try {
      const layer = createBackgroundLayer(root);
      layer.showWeb('/wallpapers/web/9/index.html');
      await vi.waitFor(() => expect(root.querySelector('.wp-bg-fill iframe')).not.toBeNull());
      const frame = root.querySelector('.wp-bg-fill iframe') as HTMLIFrameElement;
      expect(frame.getAttribute('src')).toBe('http://localhost:3000/wallpapers/web/9/index.html');
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('showWeb：探活未落地就切换壁纸时，旧 iframe 不再落地', async () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((res) => { release = res; });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(pending as Promise<Response>);
    try {
      const layer = createBackgroundLayer(root);
      layer.showWeb('/wallpapers/web/9/index.html');
      layer.showVideo('/v.mp4'); // 期间切换 → 递增 frameToken
      release({});
      await new Promise((r) => setTimeout(r, 0));
      expect(root.querySelector('.wp-bg-fill iframe')).toBeNull();
      expect(root.querySelector('.wp-bg-fill video')).not.toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // 省电（2026-09-21）：视频壁纸停/续播；web 壁纸在 iframe 内，插件无法控制。
  it('setPaused：视频壁纸暂停/恢复，且暂停态下换壁纸的新视频同样不播', () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const pauseSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const playSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined as never);
    try {
      const layer = createBackgroundLayer(root);
      layer.showVideo('/a.mp4');
      expect(pauseSpy).not.toHaveBeenCalled();
      layer.setPaused(true);
      expect(pauseSpy).toHaveBeenCalledTimes(1);
      layer.setPaused(false);
      expect(playSpy).toHaveBeenCalledTimes(1);
      // 暂停态下切壁纸：新视频也不播（否则「暂停」会被换壁纸悄悄解除）
      layer.setPaused(true); // 第 2 次：暂停当前视频
      layer.showVideo('/b.mp4'); // 第 3 次：新视频仍处暂停态
      expect(pauseSpy).toHaveBeenCalledTimes(3);
      expect(root.querySelectorAll('.wp-bg-fill video')).toHaveLength(1);
    } finally {
      pauseSpy.mockRestore();
      playSpy.mockRestore();
    }
  });

  // web 壁纸自适应（2026-09-22 用户报告「调整浏览器大小时不跟着自适应」）：本库部分 web 壁纸
  // 的脚本在初始化时把画布尺寸**快照**成 window.innerWidth/Height（`3789244610` 即如此，
  // 全 bundle 无 resize 监听）。headless 实测：宿主 iframe 与子帧视口都正确跟随，瓶颈在壁纸内部；
  // 跨源 iframe 无法注入脚本 ⇒ 只能按新视口**重建 iframe** 让壁纸重新初始化（重建实测有效）。
  describe('web 壁纸 resize 自适应', () => {
    const setViewport = (w: number, h: number) => {
      Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
    };
    const resetViewport = () => {
      Reflect.deleteProperty(window, 'innerWidth');
      Reflect.deleteProperty(window, 'innerHeight');
    };
    const framesOf = (root: HTMLElement) => [...root.querySelectorAll('.wp-bg-fill iframe')] as HTMLIFrameElement[];
    const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
    async function setupWeb(root: HTMLElement, fetchSpy: ReturnType<typeof vi.spyOn>) {
      const layer = createBackgroundLayer(root);
      layer.showWeb('/wallpapers/web/9/index.html');
      await flush(); // 探活是 promise 链，落地不需真实时间
      expect(framesOf(root)).toHaveLength(1);
      return { layer, frame: framesOf(root)[0] };
    }

    it('resize 后用新视口重建；新帧就绪前旧帧仍在画面里', async () => {
      vi.useFakeTimers();
      document.body.innerHTML = '';
      const root = document.createElement('div');
      document.body.appendChild(root);
      setViewport(1280, 720);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({} as Response);
      try {
        const { frame: old } = await setupWeb(root, fetchSpy);
        setViewport(900, 520);
        window.dispatchEvent(new Event('resize'));
        await vi.advanceTimersByTimeAsync(WEB_RESIZE_RELOAD_DELAY_MS);

        const pending = framesOf(root);
        expect(pending).toHaveLength(2); // 预载帧已挂、旧帧未撤（避免白屏）
        expect(pending[0]).toBe(old);
        expect(pending[1].style.visibility).toBe('hidden');
        expect(pending[1].getAttribute('src')).toBe(old.getAttribute('src')); // 复用探活结果
        expect(pending[1].getAttribute('scrolling')).toBe('no');

        pending[1].dispatchEvent(new Event('load'));
        expect(framesOf(root)).toHaveLength(1);
        expect(framesOf(root)[0]).toBe(pending[1]);
        expect(framesOf(root)[0].style.visibility).toBe('');
      } finally {
        fetchSpy.mockRestore(); resetViewport(); vi.useRealTimers();
      }
    });

    it('尺寸未变（只有 resize 事件）不重建', async () => {
      vi.useFakeTimers();
      document.body.innerHTML = '';
      const root = document.createElement('div');
      document.body.appendChild(root);
      setViewport(1280, 720);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({} as Response);
      try {
        await setupWeb(root, fetchSpy);
        window.dispatchEvent(new Event('resize'));
        await vi.advanceTimersByTimeAsync(WEB_RESIZE_RELOAD_DELAY_MS * 3);
        expect(framesOf(root)).toHaveLength(1);
      } finally {
        fetchSpy.mockRestore(); resetViewport(); vi.useRealTimers();
      }
    });

    it('非 web 背景（图片/视频）不因 resize 重建', async () => {
      vi.useFakeTimers();
      document.body.innerHTML = '';
      const root = document.createElement('div');
      document.body.appendChild(root);
      setViewport(1280, 720);
      try {
        const layer = createBackgroundLayer(root);
        layer.showImage('/p.gif', false);
        setViewport(640, 360);
        window.dispatchEvent(new Event('resize'));
        await vi.advanceTimersByTimeAsync(WEB_RESIZE_RELOAD_DELAY_MS * 3);
        expect(framesOf(root)).toHaveLength(0);
        expect(root.querySelector('.wp-bg-fill img')).not.toBeNull();
      } finally {
        resetViewport(); vi.useRealTimers();
      }
    });

    it('连续 resize 只重建一次（debounce 合并）', async () => {
      vi.useFakeTimers();
      document.body.innerHTML = '';
      const root = document.createElement('div');
      document.body.appendChild(root);
      setViewport(1280, 720);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({} as Response);
      try {
        await setupWeb(root, fetchSpy);
        setViewport(1000, 600); window.dispatchEvent(new Event('resize'));
        await vi.advanceTimersByTimeAsync(100);
        setViewport(1100, 700); window.dispatchEvent(new Event('resize'));
        await vi.advanceTimersByTimeAsync(100);
        setViewport(1200, 800); window.dispatchEvent(new Event('resize'));
        await vi.advanceTimersByTimeAsync(WEB_RESIZE_RELOAD_DELAY_MS);
        expect(framesOf(root)).toHaveLength(2); // 旧帧 + 唯一一个预载帧
      } finally {
        fetchSpy.mockRestore(); resetViewport(); vi.useRealTimers();
      }
    });

    it('预载期间切换壁纸：迟到的预载帧不落地', async () => {
      vi.useFakeTimers();
      document.body.innerHTML = '';
      const root = document.createElement('div');
      document.body.appendChild(root);
      setViewport(1280, 720);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({} as Response);
      try {
        const { layer } = await setupWeb(root, fetchSpy);
        setViewport(900, 520);
        window.dispatchEvent(new Event('resize'));
        await vi.advanceTimersByTimeAsync(WEB_RESIZE_RELOAD_DELAY_MS);
        const pending = framesOf(root)[1];
        layer.showImage('/p.gif', false);
        pending.dispatchEvent(new Event('load'));
        expect(framesOf(root)).toHaveLength(0);
        expect(root.querySelector('.wp-bg-fill img')).not.toBeNull();
      } finally {
        fetchSpy.mockRestore(); resetViewport(); vi.useRealTimers();
      }
    });

    it('预载超时：撤掉预载帧、保留旧帧（宁可尺寸不对也不留白）', async () => {
      vi.useFakeTimers();
      document.body.innerHTML = '';
      const root = document.createElement('div');
      document.body.appendChild(root);
      setViewport(1280, 720);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({} as Response);
      try {
        const { frame: old } = await setupWeb(root, fetchSpy);
        setViewport(900, 520);
        window.dispatchEvent(new Event('resize'));
        await vi.advanceTimersByTimeAsync(WEB_RESIZE_RELOAD_DELAY_MS);
        expect(framesOf(root)).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(WEB_RESIZE_RELOAD_TIMEOUT_MS);
        expect(framesOf(root)).toHaveLength(1);
        expect(framesOf(root)[0]).toBe(old);
      } finally {
        fetchSpy.mockRestore(); resetViewport(); vi.useRealTimers();
      }
    });

    it('showNone 后再 resize 不重建', async () => {
      vi.useFakeTimers();
      document.body.innerHTML = '';
      const root = document.createElement('div');
      document.body.appendChild(root);
      setViewport(1280, 720);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({} as Response);
      try {
        const { layer } = await setupWeb(root, fetchSpy);
        layer.showNone();
        setViewport(900, 520);
        window.dispatchEvent(new Event('resize'));
        await vi.advanceTimersByTimeAsync(WEB_RESIZE_RELOAD_DELAY_MS * 3);
        expect(framesOf(root)).toHaveLength(0);
      } finally {
        fetchSpy.mockRestore(); resetViewport(); vi.useRealTimers();
      }
    });
  });
});

