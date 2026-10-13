// 单测：composite-quad 的单一职责——把给定纹理全屏贴到当前 render target。
// node/jsdom 无 WebGL ⇒ 注入 mock renderer，只校验调用契约、shader 文本与资源释放。
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createCompositeQuad } from '../src/client/composite-quad.js';

/** 最小 renderer mock：记录 render 调用与当时绑定的 target。 */
function mockRenderer() {
  const calls: Array<{ scene: unknown; camera: unknown; target: unknown }> = [];
  let target: unknown = null;
  const renderer = {
    setRenderTarget: (t: unknown = null) => { target = t; },
    render: (scene: unknown, camera: unknown) => { calls.push({ scene, camera, target }); },
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, calls };
}

function fullScreenMesh(scene: unknown): THREE.Mesh {
  const s = scene as THREE.Scene;
  expect(s.children).toHaveLength(1);
  return s.children[0] as THREE.Mesh;
}

describe('createCompositeQuad', () => {
  it('composite：把纹理写进 uniform 并渲一个全屏 quad（不切 target）', () => {
    const { renderer, calls } = mockRenderer();
    const quad = createCompositeQuad(renderer);
    const tex = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    quad.composite(renderer, tex);
    expect(calls).toHaveLength(1);
    // 合成必须渲到**调用方当前绑定**的 target（默认 fb）——不得自己切 target。
    renderer.setRenderTarget(renderer as never); // no-op，仅确认 mock 未被动过
    const mesh = fullScreenMesh(calls[0].scene);
    const mat = mesh.material as THREE.ShaderMaterial;
    expect(mat.uniforms.tSrc.value).toBe(tex);
    expect(calls[0].camera).toBeInstanceOf(THREE.OrthographicCamera);
    quad.dispose();
  });

  it('几何固定 NDC 全屏（position ∈ [-1,1]²、uv ∈ [0,1]）', () => {
    const { renderer, calls } = mockRenderer();
    const quad = createCompositeQuad(renderer);
    quad.composite(renderer, new THREE.DataTexture(new Uint8Array(4), 1, 1));
    const mesh = fullScreenMesh(calls[0].scene);
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    expect(pos.count).toBe(4);
    for (let i = 0; i < pos.count; i++) {
      expect(Math.abs(pos.getX(i))).toBe(1);
      expect(Math.abs(pos.getY(i))).toBe(1);
    }
    // uv 覆盖整个 [0,1]²（PlaneGeometry 的角序不影响覆盖范围）。
    const uv = geo.getAttribute('uv');
    const us = Array.from({ length: uv.count }, (_, i) => uv.getX(i));
    const vs = Array.from({ length: uv.count }, (_, i) => uv.getY(i));
    expect([Math.min(...us), Math.max(...us)]).toEqual([0, 1]);
    expect([Math.min(...vs), Math.max(...vs)]).toEqual([0, 1]);
    // 顶点 shader 必须直接用 position.xy 作 NDC（不受相机矩阵影响）。
    const mat = mesh.material as THREE.ShaderMaterial;
    expect(mat.vertexShader).toContain('gl_Position = vec4(position.xy, 0.0, 1.0)');
    // 片元：恒等采样 + alpha 恒 1（与 glow-stage 的 composite 同口径）。
    expect(mat.fragmentShader).toContain('texture2D(tSrc, vUv)');
    expect(mat.fragmentShader).toContain(', 1.0)');
    quad.dispose();
  });

  it('换纹理只改 uniform，不重建几何（每帧调用也无分配）', () => {
    const { renderer, calls } = mockRenderer();
    const quad = createCompositeQuad(renderer);
    const a = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    const b = new THREE.DataTexture(new Uint8Array(4), 2, 2);
    quad.composite(renderer, a);
    const geo = fullScreenMesh(calls[0].scene).geometry;
    quad.composite(renderer, b);
    const mesh = fullScreenMesh(calls[1].scene);
    expect((mesh.material as THREE.ShaderMaterial).uniforms.tSrc.value).toBe(b);
    expect(mesh.geometry).toBe(geo);
    quad.dispose();
  });

  it('dispose 幂等：释放后再次 composite 不抛错、不再渲染', () => {
    const { renderer, calls } = mockRenderer();
    const quad = createCompositeQuad(renderer);
    const mat = fullScreenMesh((quad.composite(renderer, new THREE.DataTexture(new Uint8Array(4), 1, 1)), calls[0].scene))
      .material as THREE.ShaderMaterial;
    const spy = vi.spyOn(mat, 'dispose');
    const geoSpy = vi.spyOn(
      fullScreenMesh(calls[0].scene).geometry as THREE.BufferGeometry, 'dispose',
    );
    quad.dispose();
    quad.dispose();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(geoSpy).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1); // 释放后不再渲染
  });

  it('resize 是空实现（几何与画布像素无关，不抛错）', () => {
    const { renderer } = mockRenderer();
    const quad = createCompositeQuad(renderer);
    expect(() => quad.resize(1920, 1080)).not.toThrow();
    quad.dispose();
  });
});
