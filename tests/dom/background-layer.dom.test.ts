import { describe, expect, it, vi } from 'vitest';
import { createBackgroundLayer } from '../../src/client/background-layer.js';

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
});

