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
});
