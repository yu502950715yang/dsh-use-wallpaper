import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBootOverlay } from '../../src/client/boot-overlay.js';

// jsdom 不解码媒体：测试用事件派发 + fake timers 驱动状态机；play() 打桩避免 not-implemented。
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  document.documentElement.innerHTML = '<body></body>';
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.innerHTML = '<body></body>';
});

const layer = () => document.querySelector<HTMLElement>('.wp-boot-layer');

describe('createBootOverlay', () => {
  it('视频：loadeddata 后按 maxDuration 结束，淡出后移除层', async () => {
    const overlay = createBootOverlay({ readyTimeoutMs: 1000, fadeMs: 50 });
    const p = overlay.play({ kind: 'video', url: '/v.mp4' }, 'cover', 300);
    const video = layer()!.querySelector('video')!;
    expect(video.style.objectFit).toBe('cover');
    video.dispatchEvent(new Event('loadeddata'));
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(50);
    await expect(p).resolves.toBe('ended');
    expect(layer()).toBeNull();
  });

  it('视频 ended 提前结束', async () => {
    const overlay = createBootOverlay({ fadeMs: 10 });
    const p = overlay.play({ kind: 'video', url: '/v.mp4' }, 'contain', 0);
    const video = layer()!.querySelector('video')!;
    video.dispatchEvent(new Event('loadeddata'));
    video.dispatchEvent(new Event('ended'));
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('ended');
  });

  it('图片：平铺用 repeat 背景 div；到时长结束', async () => {
    const overlay = createBootOverlay({ imageDurationMs: 200, fadeMs: 10 });
    const p = overlay.play({ kind: 'image', url: '/p.png' }, 'tile', 0);
    const tile = layer()!.querySelector<HTMLElement>('.wp-boot-tile')!;
    expect(tile.style.backgroundRepeat).toBe('repeat');
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('ended');
  });

  it('图片：cover 用 img 且不等待 load 即计时', async () => {
    const overlay = createBootOverlay({ imageDurationMs: 150, fadeMs: 10 });
    const p = overlay.play({ kind: 'image', url: '/p.png' }, 'cover', 0);
    const img = layer()!.querySelector('img')!;
    expect(img.style.objectFit).toBe('cover');
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('ended');
  });

  it('图片 error → failed', async () => {
    const overlay = createBootOverlay({ fadeMs: 10 });
    const p = overlay.play({ kind: 'image', url: '/bad.png' }, 'cover', 0);
    layer()!.querySelector('img')!.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('failed');
    expect(layer()).toBeNull();
  });

  it('跳过：pointerdown 立即结束（skipped）', async () => {
    const overlay = createBootOverlay({ fadeMs: 10 });
    const p = overlay.play({ kind: 'image', url: '/p.png' }, 'cover', 0);
    window.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('skipped');
  });

  it('跳过：keydown 也结束（skipped）', async () => {
    const overlay = createBootOverlay({ fadeMs: 10 });
    const p = overlay.play({ kind: 'image', url: '/p.png' }, 'cover', 0);
    window.dispatchEvent(new Event('keydown'));
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('skipped');
  });

  it('就绪超时 → timeout', async () => {
    const overlay = createBootOverlay({ readyTimeoutMs: 500, fadeMs: 10 });
    const p = overlay.play({ kind: 'video', url: '/v.mp4' }, 'cover', 0);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('timeout');
  });

  it('dispose 立即移除层并把进行中的 play 解为 skipped（幂等）', async () => {
    const overlay = createBootOverlay({ fadeMs: 10 });
    const p = overlay.play({ kind: 'image', url: '/p.png' }, 'cover', 0);
    overlay.dispose();
    overlay.dispose();
    expect(layer()).toBeNull();
    await expect(p).resolves.toBe('skipped');
    await vi.advanceTimersByTimeAsync(10);
    expect(layer()).toBeNull();
  });

  it('dispose 在淡出中也立即解为 skipped 并移除层', async () => {
    const overlay = createBootOverlay({ imageDurationMs: 100, fadeMs: 50 });
    const p = overlay.play({ kind: 'image', url: '/p.png' }, 'cover', 0);
    await vi.advanceTimersByTimeAsync(100); // 自然结束，进入淡出
    expect(layer()).not.toBeNull();
    overlay.dispose();
    expect(layer()).toBeNull();
    await expect(p).resolves.toBe('skipped');
  });

  it('dispose 后 play 解为 failed 且不建层', async () => {
    const overlay = createBootOverlay();
    overlay.dispose();
    await expect(overlay.play({ kind: 'image', url: '/p.png' }, 'cover', 0)).resolves.toBe('failed');
    expect(layer()).toBeNull();
  });
});
