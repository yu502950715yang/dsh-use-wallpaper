import { describe, expect, it } from 'vitest';
import { resolveBackground } from '../src/client/background-layer.js';

const base = { previewUrl: '/p.png', hasPreviewGif: false, hasScene: false } as any;

describe('resolveBackground', () => {
  it('scene with hasScene prefers scene plan', () => {
    const plan = resolveBackground({ ...base, id: '1', type: 'scene', hasScene: true });
    expect(plan.kind).toBe('scene');
  });
  it('video uses video plan with file url', () => {
    const plan = resolveBackground({ ...base, id: '2', type: 'video', file: 'scene.mp4', hasPreviewGif: true });
    expect(plan).toEqual({ kind: 'video', url: '/wallpapers/media/2/file' });
  });
  it('image plan for scene without pkg and for unknown', () => {
    expect(resolveBackground({ ...base, id: '3', type: 'scene', hasScene: false }).kind).toBe('image');
    expect(resolveBackground({ ...base, id: '4', type: 'unknown' }).kind).toBe('image');
  });
  it('gif preview sets kenBurns false, jpg sets true', () => {
    const gif = resolveBackground({ ...base, id: '5', type: 'unknown', hasPreviewGif: true, previewUrl: '/wallpapers/media/5/preview' });
    expect(gif).toEqual({ kind: 'image', url: '/wallpapers/media/5/preview', kenBurns: false });
    const jpg = resolveBackground({ ...base, id: '6', type: 'unknown', hasPreviewGif: false, previewUrl: '/wallpapers/media/6/preview' });
    expect(jpg).toEqual({ kind: 'image', url: '/wallpapers/media/6/preview', kenBurns: true });
  });
  it('none plan when no preview url', () => {
    expect(resolveBackground({ ...base, id: '7', type: 'unknown', previewUrl: '' }).kind).toBe('none');
  });
});
