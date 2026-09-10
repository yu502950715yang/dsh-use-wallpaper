import { describe, expect, it } from 'vitest';
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
});
