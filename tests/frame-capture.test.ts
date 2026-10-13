// 单测：FrameCapture 的惰性（use() 前零 GPU 资源）、尺寸同步、dispose 后行为。
// 语义与资源契约见 src/client/frame-capture.ts 头部（WE `_rt_FullFrameBuffer`）。
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createFrameCapture } from '../src/client/frame-capture.js';

function fakeRenderer(calls: string[]) {
  const copy = vi.fn(() => { calls.push('copy'); });
  return {
    copyFramebufferToTexture: copy,
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(1600, 670),
  } as unknown as THREE.WebGLRenderer;
}

describe('createFrameCapture', () => {
  it('未 use() 时惰性：active=false 且不建 RT/纹理、不调用 copyFramebufferToTexture', () => {
    const calls: string[] = [];
    const cap = createFrameCapture(fakeRenderer(calls));
    expect(cap.active).toBe(false);
    expect(calls).toEqual([]);
  });

  it('use() 后 active=true；每次 capture() 都拍一次且返回同一实例', () => {
    const calls: string[] = [];
    const cap = createFrameCapture(fakeRenderer(calls));
    cap.use();
    const t1 = cap.capture();
    const t2 = cap.capture();
    expect(cap.active).toBe(true);
    expect(t1).toBe(t2);
    expect(calls).toEqual(['copy', 'copy']);
  });

  it('resize() 后 target 尺寸 = 画布缓冲尺寸，快照纹理同尺寸', () => {
    const cap = createFrameCapture(fakeRenderer([]));
    cap.use();
    cap.resize(2560, 1440);
    expect(cap.target.width).toBe(2560);
    expect(cap.target.height).toBe(1440);
    expect(cap.capture().image.width).toBe(2560);
  });

  it('dispose() 后再 capture() 抛错（调用方据此降级）', () => {
    const cap = createFrameCapture(fakeRenderer([]));
    cap.use();
    cap.capture();
    cap.dispose();
    expect(() => cap.capture()).toThrow();
  });

  it('resize() 在 use() 之前也安全：只记尺寸，capture() 时按记录尺寸建资源', () => {
    const calls: string[] = [];
    const cap = createFrameCapture(fakeRenderer(calls));
    cap.resize(2560, 1440);
    expect(calls).toEqual([]);
    const t = cap.capture();
    expect(t.image.width).toBe(2560);
    expect(t.image.height).toBe(1440);
    expect(cap.target.width).toBe(2560);
  });

  it('resize() 换了新纹理：capture() 返回新尺寸的纹理并重拍', () => {
    const calls: string[] = [];
    const cap = createFrameCapture(fakeRenderer(calls));
    cap.use();
    cap.capture();
    cap.resize(2560, 1440);
    expect(cap.capture().image.width).toBe(2560);
    expect(calls).toEqual(['copy', 'copy']);
  });

  it('dispose() 幂等：use()/resize() 静默无效，target 访问抛错', () => {
    const cap = createFrameCapture(fakeRenderer([]));
    cap.use();
    cap.capture();
    cap.dispose();
    expect(() => cap.dispose()).not.toThrow();
    expect(cap.active).toBe(false);
    expect(() => cap.use()).not.toThrow();
    expect(() => cap.resize(800, 600)).not.toThrow();
    expect(() => cap.target).toThrow();
  });

  it('target 为非 sRGB 字节 RT：ClampToEdge + Linear + 无 mip', () => {
    const cap = createFrameCapture(fakeRenderer([]));
    const t = cap.target.texture;
    expect(t.type).toBe(THREE.UnsignedByteType);
    expect(t.colorSpace).toBe(THREE.NoColorSpace);
    expect(t.wrapS).toBe(THREE.ClampToEdgeWrapping);
    expect(t.wrapT).toBe(THREE.ClampToEdgeWrapping);
    expect(t.minFilter).toBe(THREE.LinearFilter);
    expect(t.magFilter).toBe(THREE.LinearFilter);
    expect(t.generateMipmaps).toBe(false);
  });
});
