// @vitest-environment jsdom
// v0.8.2 F13：image color 调制 —— color 0-255 乘进**内容材质**（与 alpha 同口径），
// 隔离路径的合成 quad 保持中性（内容 RT 已承载 tint，二次相乘会变暗/双重调制）。
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { materialModulation } from '../src/client/object-range.js';
import { ThreeScenePlayer } from '../src/client/threejs-player.js';

// addBackground 只用到 renderer 的少量接口（node/jsdom 无 WebGL，不能构造 WebGLRenderer）。
function makePlayer(): ThreeScenePlayer {
  const canvas = document.createElement('canvas');
  const renderer = {
    setAnimationLoop: vi.fn(),
    setPixelRatio: vi.fn(),
    setSize: vi.fn(),
    render: vi.fn(),
    setRenderTarget: vi.fn(),
    domElement: canvas,
  } as unknown as THREE.WebGLRenderer;
  return new ThreeScenePlayer(canvas, 1000, 600, renderer);
}

describe('materialModulation（F13 color）', () => {
  it('color 0-255 → 0-1；brightness 乘入并逐通道 clamp；alpha 缺省 1', () => {
    const mod = materialModulation([128, 0, 255], 1, 1);
    expect(mod.r).toBeCloseTo(128 / 255, 6);
    expect(mod.g).toBe(0);
    expect(mod.b).toBe(1);
    expect(mod.a).toBe(1);
  });

  it('brightness > 1：color × brightness 后 clamp 到 1（不是整色一起失效）', () => {
    const mod = materialModulation([128, 64, 32], 0.5, 2);
    expect(mod.r).toBe(1);                       // 128/255 × 2 = 1.004 → clamp
    expect(mod.g).toBeCloseTo(128 / 255, 6);     // 64/255 × 2
    expect(mod.b).toBeCloseTo(64 / 255, 6);      // 32/255 × 2
    expect(mod.a).toBe(0.5);
  });

  it('缺省 color / alpha / brightness → 中性 (1,1,1,1)', () => {
    expect(materialModulation()).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });
});

describe('image color → 内容材质（F13）', () => {
  it('直渲：color tint 乘进材质 color，alpha/brightness 同口径', () => {
    const player = makePlayer();
    player.addBackground({
      origin: [500, 300, 0], size: [100, 50], scale: [1, 1, 1],
      color: [128, 64, 32], alpha: 0.5, brightness: 2, sceneW: 1000, sceneH: 600,
    });
    const mesh = player.scene.children[0] as THREE.Mesh;
    const mat = mesh.material as THREE.MeshBasicMaterial;
    expect(mat.color.r).toBe(1);                     // 128/255 × 2 后 clamp
    expect(mat.color.g).toBeCloseTo(128 / 255, 6);
    expect(mat.color.b).toBeCloseTo(64 / 255, 6);
    expect(mat.opacity).toBeCloseTo(0.5, 6);
  });

  it('隔离：color 落内容材质（烘进 RT），合成 quad 中性（不二次调制）', () => {
    const player = makePlayer();
    player.addBackground({
      origin: [500, 300, 0], size: [100, 50], scale: [1, 1, 1],
      color: [128, 64, 32], alpha: 0.5, brightness: 1, sceneW: 1000, sceneH: 600,
      isolate: { objectId: 13, rtWidth: 100, rtHeight: 50, worldW: 100, worldH: 50 },
    });
    const entry = player.isolatedObjects().find((e) => e.id === 13)!;
    const contentMat = (entry.localScene.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    expect(contentMat.color.r).toBeCloseTo(128 / 255, 6);
    expect(contentMat.color.g).toBeCloseTo(64 / 255, 6);
    expect(contentMat.color.b).toBeCloseTo(32 / 255, 6);
    expect(contentMat.opacity).toBeCloseTo(0.5, 6);
    // 合成 quad：内容 RT 已含 tint/alpha ⇒ 再乘一次会 a² / 双重变暗。
    const quadMat = entry.quad.material as THREE.MeshBasicMaterial;
    expect(quadMat.opacity).toBe(1);
    expect([quadMat.color.r, quadMat.color.g, quadMat.color.b]).toEqual([1, 1, 1]);
  });
});
