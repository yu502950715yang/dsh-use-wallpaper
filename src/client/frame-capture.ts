// src/client/frame-capture.ts
// 帧内快照：把「到这一刻为止已绘制的内容」拷进一张纹理，供折射等消费者读。
// 语义 = WE 的 `_rt_FullFrameBuffer`（lwe CParticle.cpp:2069-2079 / CScene.cpp:351-361）。
import * as THREE from 'three';

export interface FrameCapture {
  /** 是否已有消费者：调用方据此决定走不走段渲染。 */
  readonly active: boolean;
  /** 段渲染目标（画布尺寸）；首次读它或 capture() 时才建资源，无消费者时零 GPU 占用。 */
  readonly target: THREE.WebGLRenderTarget;
  /** 声明本帧有消费者（激活），并开启一次新快照。 */
  use(): void;
  /** 返回本帧快照（当前已绑定 framebuffer 的内容）；同一激活周期内只 blit 一次、复用同一张纹理。 */
  capture(): THREE.Texture;
  /** 同步 target 与快照尺寸；尺寸变化会重建快照纹理（FramebufferTexture 无 setSize），旧引用作废。 */
  resize(width: number, height: number): void;
  /** 释放两张资源且幂等；此后 use()/resize() 静默无效，capture()/target 抛错（调用方据此降级）。 */
  dispose(): void;
}

// 显式写死非 sRGB 字节 RT 的参数：全链路 outputColorSpace = LinearSRGBColorSpace，
// 缺省值将来若变会让快照域与效果链不一致（显式化以防回归）。
const TARGET_OPTIONS: THREE.RenderTargetOptions = {
  type: THREE.UnsignedByteType,
  format: THREE.RGBAFormat,
  wrapS: THREE.ClampToEdgeWrapping,
  wrapT: THREE.ClampToEdgeWrapping,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  generateMipmaps: false,
  colorSpace: THREE.NoColorSpace,
};

export function createFrameCapture(renderer: THREE.WebGLRenderer): FrameCapture {
  let active = false;
  let disposed = false;
  let hasSize = false;
  let width = 0;
  let height = 0;
  /** 本次 use() 之后是否已拍过快照（同一次激活只 blit 一次）。 */
  let captured = false;
  let target: THREE.WebGLRenderTarget | null = null;
  let snapshot: THREE.FramebufferTexture | null = null;

  /** 建资源前的兜底：0 尺寸的 RT/FramebufferTexture 非法（画布隐藏时 drawingBuffer 可能为 0）。 */
  function normalize(v: number): number {
    return Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 1;
  }

  /** 惰性建资源：首次 capture()/读 target 时按已记录尺寸建；dispose 后调用抛错。 */
  function ensure(): { target: THREE.WebGLRenderTarget; snapshot: THREE.FramebufferTexture } {
    if (disposed) throw new Error('[wallpaper-engine] FrameCapture 已 dispose');
    if (!hasSize) {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      width = normalize(size.x);
      height = normalize(size.y);
      hasSize = true;
    }
    if (target === null || snapshot === null) {
      target = new THREE.WebGLRenderTarget(width, height, TARGET_OPTIONS);
      snapshot = new THREE.FramebufferTexture(width, height);
    }
    return { target, snapshot };
  }

  function resize(w: number, h: number): void {
    if (disposed) return;
    const nw = Math.floor(w);
    const nh = Math.floor(h);
    if (!(nw >= 1) || !(nh >= 1)) return; // 非法尺寸不动资源（与 glow-stage 同策略）
    if (hasSize && nw === width && nh === height) return;
    width = nw;
    height = nh;
    hasSize = true;
    captured = false; // 新纹理是空的：同帧内的下一次 capture() 必须重拍
    if (target !== null && snapshot !== null) {
      target.setSize(nw, nh);
      snapshot.dispose();
      snapshot = new THREE.FramebufferTexture(nw, nh);
    }
  }

  function capture(): THREE.Texture {
    const res = ensure();
    if (!captured) {
      // 不切 render target：copyFramebufferToTexture 拷的是**当前已绑定**的 framebuffer。
      renderer.copyFramebufferToTexture(res.snapshot);
      captured = true;
    }
    return res.snapshot;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    active = false;
    target?.dispose();
    snapshot?.dispose();
    target = null;
    snapshot = null;
  }

  return {
    get active() { return active; },
    get target() { return ensure().target; },
    use() { if (!disposed) { active = true; captured = false; } },
    capture,
    resize,
    dispose,
  };
}
