import { describe, expect, it } from 'vitest';
import { resolveBackground, alternateLoopbackOrigin, webFrameSpec } from '../src/client/background-layer.js';

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
  it('unknown with hasScene prefers scene plan (project.json 无 type 但含 scene.pkg)', () => {
    const plan = resolveBackground({ ...base, id: '8', type: 'unknown', hasScene: true });
    expect(plan).toEqual({ kind: 'scene', wallpaperId: '8' });
  });
  it('web type uses web plan with iframe url', () => {
    const plan = resolveBackground({ ...base, id: '9', type: 'web' });
    expect(plan).toEqual({ kind: 'web', url: '/wallpapers/web/9/index.html' });
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

describe('alternateLoopbackOrigin', () => {
  it('回环主机名互换（含 IPv6 写法），非回环返回 null', () => {
    expect(alternateLoopbackOrigin({ protocol: 'http:', hostname: 'localhost', port: '3080' })).toBe('http://127.0.0.1:3080');
    expect(alternateLoopbackOrigin({ protocol: 'http:', hostname: '127.0.0.1', port: '3080' })).toBe('http://localhost:3080');
    expect(alternateLoopbackOrigin({ protocol: 'http:', hostname: '[::1]', port: '3080' })).toBe('http://localhost:3080');
    expect(alternateLoopbackOrigin({ protocol: 'http:', hostname: '192.168.1.5', port: '3080' })).toBeNull();
    expect(alternateLoopbackOrigin({ protocol: 'https:', hostname: 'example.com', port: '' })).toBeNull();
  });
});

describe('webFrameSpec', () => {
  const loc = { protocol: 'http:', hostname: '127.0.0.1', port: '3080' };
  it('另一主机名可达：跨源承载壁纸，保留 allow-same-origin（否则 WebGL 贴图被判定跨源）', () => {
    expect(webFrameSpec('/wallpapers/web/9/index.html', loc, 'http://localhost:3080')).toEqual({
      url: 'http://localhost:3080/wallpapers/web/9/index.html',
      sandbox: 'allow-scripts allow-same-origin',
    });
  });
  it('另一主机名不可达：退回同源 + 纯 allow-scripts（隔离优先）', () => {
    expect(webFrameSpec('/wallpapers/web/9/index.html', loc, null)).toEqual({
      url: 'http://127.0.0.1:3080/wallpapers/web/9/index.html',
      sandbox: 'allow-scripts',
    });
  });
});

