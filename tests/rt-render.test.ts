// 回归测试：渲染进 RenderTarget 必须**透明清屏**（清屏 alpha=0）。
//
// 背景（2026-09-15 定位）：three 的清屏 alpha 由 `WebGLRenderer` 构造参数 `alpha` 决定
// （`alpha === true ? 0 : 1`），播放器用缺省（false）⇒ clearAlpha=1，而这份状态渲染到
// **RenderTarget** 时同样生效 ⇒ RT 被清成不透明黑 ⇒ 对象内容透明处 / 效果把 alpha 降下去处
// 变成不透明黑块，被合成 quad 贴回主场景（真机现象：2911105183 31.1% 画面纯黑）。
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { renderIntoRenderTarget } from '../src/client/rt-render.js';

/** 记录「每次 render 时的清屏 alpha」的 mock renderer。 */
function createClearAlphaRenderer(initial = 1) {
  let alpha = initial;
  const seen: Array<{ scene: unknown; alpha: number; target: unknown }> = [];
  const renderer = {
    getClearAlpha: vi.fn(() => alpha),
    setClearAlpha: vi.fn((v: number) => { alpha = v; }),
    setRenderTarget: vi.fn(),
    render: vi.fn((scene: unknown) => { seen.push({ scene, alpha, target: null }); }),
    _seen: seen,
    _alpha: () => alpha,
  };
  return renderer;
}

describe('renderIntoRenderTarget', () => {
  it('渲染前把清屏 alpha 置 0，渲染后恢复原值', () => {
    const renderer = createClearAlphaRenderer(1);
    const rt = new THREE.WebGLRenderTarget(4, 4);
    const scene = new THREE.Scene();
    const camera = new THREE.Camera();
    const prev = renderIntoRenderTarget(renderer as unknown as THREE.WebGLRenderer, rt, scene, camera);
    expect(prev).toBe(1);
    // 渲染那一刻的 alpha 必须是 0（否则 RT 被清成不透明黑）
    expect(renderer._seen).toHaveLength(1);
    expect(renderer._seen[0].alpha).toBe(0);
    expect(renderer.setClearAlpha).toHaveBeenNthCalledWith(1, 0);
    // 渲染后恢复原值 1（主场景 → 画布的清屏语义不变）
    expect(renderer._alpha()).toBe(1);
    // 渲染目标切到 RT 再复位为 null
    expect(renderer.setRenderTarget).toHaveBeenNthCalledWith(1, rt);
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(null);
  });

  it('清屏 alpha 已是 0 时不重复切换', () => {
    const renderer = createClearAlphaRenderer(0);
    renderIntoRenderTarget(renderer as unknown as THREE.WebGLRenderer, new THREE.WebGLRenderTarget(2, 2), new THREE.Scene(), new THREE.Camera());
    expect(renderer.setClearAlpha).not.toHaveBeenCalled();
    expect(renderer._alpha()).toBe(0);
  });

  it('mock renderer 无 get/setClearAlpha 时静默跳过（不抛、照常渲染）', () => {
    const renderer = { setRenderTarget: vi.fn(), render: vi.fn() };
    const rt = new THREE.WebGLRenderTarget(2, 2);
    const scene = new THREE.Scene();
    const camera = new THREE.Camera();
    expect(() => renderIntoRenderTarget(renderer as unknown as THREE.WebGLRenderer, rt, scene, camera)).not.toThrow();
    expect(renderer.render).toHaveBeenCalledWith(scene, camera);
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(null);
  });
});
