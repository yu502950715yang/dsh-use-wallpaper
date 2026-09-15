// src/client/rt-render.ts
// 渲染进 RenderTarget 的统一入口：渲染前把清屏 alpha 置 0（透明黑），渲染后恢复原值。
//
// 为什么不能用缺省：three 的清屏 alpha 由 `WebGLRenderer` 的 `alpha` 参数决定（缺省 false ⇒ 1），
// 且渲染到 RT 时同样生效 ⇒ RT 被清成**不透明黑**，效果把 alpha 降下去处（opacity / *mask）会变成
// 黑块贴回主场景（2911105183 实测 31.1% 画面纯黑）。根因、实测数字与边界见 AGENT.md §5.22。
import type * as THREE from 'three';

/** 清屏 alpha 相关方法（mock renderer 可能没有，防御式跳过）。 */
interface ClearAlphaCapable {
  getClearAlpha?: () => number;
  setClearAlpha?: (alpha: number) => void;
}

/**
 * 把 `scene` 渲染进 `target`（透明清屏），退出时把渲染目标复位为 null。
 * 返回渲染前的清屏 alpha（供测试断言；renderer 不支持时为 null）。
 */
export function renderIntoRenderTarget(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
  scene: THREE.Scene,
  camera: THREE.Camera,
): number | null {
  const caps = renderer as unknown as ClearAlphaCapable;
  const canToggle = typeof caps.getClearAlpha === 'function' && typeof caps.setClearAlpha === 'function';
  const prevAlpha = canToggle ? caps.getClearAlpha!() : null;
  const needToggle = canToggle && prevAlpha !== 0;
  if (needToggle) caps.setClearAlpha!(0);
  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
  } finally {
    renderer.setRenderTarget(null);
    if (needToggle) caps.setClearAlpha!(prevAlpha as number);
  }
  return prevAlpha;
}
