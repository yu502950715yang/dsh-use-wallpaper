// 单测：FrameCapture 的惰性（use() 前零 GPU 资源）、尺寸同步、reset/dispose 后行为、纹理参数。
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

/** 快照纹理与段目标共用的四项采样参数（ClampToEdge + Linear + 无 mip + 非 sRGB）。 */
function expectTexParams(t: THREE.Texture) {
  expect(t.colorSpace).toBe(THREE.NoColorSpace);
  expect(t.wrapS).toBe(THREE.ClampToEdgeWrapping);
  expect(t.wrapT).toBe(THREE.ClampToEdgeWrapping);
  expect(t.minFilter).toBe(THREE.LinearFilter);
  expect(t.magFilter).toBe(THREE.LinearFilter);
  expect(t.generateMipmaps).toBe(false);
}

describe('createFrameCapture', () => {
  it('未 use() 时惰性：active=false 且 RT/纹理都未构造、不调用 copyFramebufferToTexture', () => {
    const calls: string[] = [];
    const made: string[] = [];
    const cap = createFrameCapture(fakeRenderer(calls), {
      createTarget: (w, h) => {
        made.push(`rt:${w}x${h}`);
        return new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType });
      },
      createTexture: (w, h) => {
        made.push(`tex:${w}x${h}`);
        return new THREE.FramebufferTexture(w, h);
      },
    });
    expect(cap.active).toBe(false);
    cap.use();
    expect(cap.active).toBe(true);
    expect(made).toEqual([]); // use() 本身不建资源
    expect(calls).toEqual([]);
    expect(cap.capture().image.width).toBe(1600);
    expect(made).toEqual(['rt:1600x670', 'tex:1600x670']); // 首次 capture() 才建
    expect(calls).toEqual(['copy']);
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

  it('reset() 复位 active 但不释放资源：随后 use()/capture() 仍是同一实例可用', () => {
    const calls: string[] = [];
    const rt = new THREE.WebGLRenderTarget(1600, 670);
    const tex = new THREE.FramebufferTexture(1600, 670);
    const rtDispose = vi.spyOn(rt, 'dispose');
    const texDispose = vi.spyOn(tex, 'dispose');
    const cap = createFrameCapture(fakeRenderer(calls), {
      createTarget: () => rt,
      createTexture: () => tex,
    });
    cap.use();
    const t1 = cap.capture();
    cap.reset();
    expect(cap.active).toBe(false);
    expect(rtDispose).not.toHaveBeenCalled();
    expect(texDispose).not.toHaveBeenCalled();
    expect(cap.target).toBe(rt);
    cap.use();
    expect(cap.active).toBe(true);
    expect(cap.capture()).toBe(t1); // 未重建 = 资源未释放
    expect(calls).toEqual(['copy', 'copy']);
    cap.dispose();
    expect(rtDispose).toHaveBeenCalledTimes(1);
    expect(texDispose).toHaveBeenCalledTimes(1);
    expect(() => cap.reset()).not.toThrow(); // dispose 后 reset 静默无害
    expect(cap.active).toBe(false);
  });

  it('resize() 后 target 尺寸 = 画布缓冲尺寸，快照纹理同尺寸', () => {
    const cap = createFrameCapture(fakeRenderer([]));
    cap.use();
    cap.resize(2560, 1440);
    expect(cap.target.width).toBe(2560);
    expect(cap.target.height).toBe(1440);
    expect(cap.capture().image.width).toBe(2560);
  });

  it('resize() 拒绝非有限值（Infinity/NaN）：尺寸与快照纹理都不变', () => {
    const calls: string[] = [];
    const cap = createFrameCapture(fakeRenderer(calls));
    cap.use();
    const t1 = cap.capture();
    cap.resize(Infinity, 600);
    cap.resize(600, Number.POSITIVE_INFINITY);
    cap.resize(Number.NaN, Number.NaN);
    expect(cap.target.width).toBe(1600);
    expect(cap.target.height).toBe(670);
    expect(cap.capture()).toBe(t1);
    expect(calls).toEqual(['copy', 'copy']);
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

  it('dispose() 幂等：use()/reset()/resize() 静默无效，target 访问抛错', () => {
    const cap = createFrameCapture(fakeRenderer([]));
    cap.use();
    cap.capture();
    cap.dispose();
    expect(() => cap.dispose()).not.toThrow();
    expect(cap.active).toBe(false);
    expect(() => cap.use()).not.toThrow();
    expect(cap.active).toBe(false); // dispose 后 use() 静默无效
    expect(() => cap.reset()).not.toThrow();
    expect(cap.active).toBe(false);
    expect(() => cap.resize(800, 600)).not.toThrow();
    expect(() => cap.target).toThrow();
  });

  it('段目标与快照纹理同参数：ClampToEdge + Linear + 无 mip + 非 sRGB', () => {
    const cap = createFrameCapture(fakeRenderer([]));
    cap.use();
    expect(cap.target.texture.type).toBe(THREE.UnsignedByteType);
    expectTexParams(cap.target.texture);
    expectTexParams(cap.capture()); // 覆盖 FramebufferTexture 写死的 NearestFilter
    cap.resize(2560, 1440); // 重建后的快照纹理同样受约束
    expectTexParams(cap.capture());
  });

  // 消费方（effect-runner 的异步串行队列）可能在本帧快照入队**之后**遇到 resize：
  // resize 会 dispose 旧快照并换新实例 ⇒ 仍握着旧引用的 update 会采到已释放纹理（该对象整块黑）。
  // 故快照实例代号必须在「重建 / 释放」时自增，供消费方在执行当刻丢弃作废引用。
  it('snapshotVersion 在 resize 重建快照 / dispose 时自增，尺寸未变时不变', () => {
    const cap = createFrameCapture(fakeRenderer([]));
    expect(cap.snapshotVersion).toBe(0);
    cap.use();
    cap.capture();
    expect(cap.snapshotVersion).toBe(0); // 拍快照不换代（同一张纹理只被覆盖）
    cap.resize(2560, 1440);
    expect(cap.snapshotVersion).toBe(1); // 快照纹理被 dispose + 重建 ⇒ 旧引用作废
    const v = cap.snapshotVersion;
    cap.resize(2560, 1440); // 同尺寸：不重建
    expect(cap.snapshotVersion).toBe(v);
    cap.resize(Number.NaN, 100); // 非法尺寸：不动资源
    expect(cap.snapshotVersion).toBe(v);
    cap.dispose();
    expect(cap.snapshotVersion).toBe(v + 1); // dispose 同样作废
  });
});
