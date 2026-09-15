// src/client/rt-render.ts
// 「渲染到 RenderTarget」的统一入口 —— 关键点是**清屏 alpha 必须为 0（透明黑）**。
//
// ── 根因（2026-09-15 定位：2911105183 Subway Station 整片纯黑）────────────────────
// three 的清屏 alpha 由 `WebGLRenderer` 构造参数 `alpha` 决定（`WebGLBackground`：
// `let clearAlpha = alpha === true ? 0 : 1`），而 `new THREE.WebGLRenderer({ canvas, antialias })`
// 的 `alpha` 缺省 **false** ⇒ renderer 的清屏 alpha = **1**。这份状态是 renderer 级的，
// `renderer.render()` 渲染到**任何 RenderTarget** 时也照用 ⇒ 每个 RT 都被清成**不透明黑 (0,0,0,1)**：
//   · **对象 RT**（隔离对象的内容）：对象内容本身透明的地方（WE 图层普遍带 mask / alpha）
//     留成不透明黑；
//   · **效果链 ping-pong RT**：WE 效果把 alpha 降下去的地方（`opacity`、各类 `*mask`），
//     片元 alpha 参与 rgb 混合（normal 混合的 rgb 因子是 `SrcAlpha`）⇒ rgb 被乘成 0；
//     而 alpha 通道的 blendFunc 是 `(ONE, ONE_MINUS_SRC_ALPHA)` ⇒ **alpha 只增不减、恒为 1**
//     ⇒ 输出是**不透明黑**（不是「透明的黑」）。
//   合成 quad（`MeshBasicMaterial` + 普通 alpha 混合）采到的就是这层不透明黑 ⇒ 直接盖在主场景上
//   ⇒ 用户看到的「很多地方都是黑色的」。实测（headless Edge + 生产代码，1280×720）：
//   2911105183 全画面 **31.1%** 像素纯黑，其中 obj 130（全屏背景 + 带 mask 的 `opacity` 效果）
//   一个对象就贡献 **26.3 个百分点**；把 renderer 清屏 alpha 改成 0 后整画面黑像素降到 **0.7%**
//   （与「剥掉全部 effects」的 0.7% 一致 ⇒ 黑块 100% 来自这条路径）。
//
// ── 修法 ──────────────────────────────────────────────────────────────────────
// 渲染进 RT 前把 renderer 清屏 alpha 置 0，渲染完**恢复原值**。
// 刻意**不**改 renderer 自身的 `alpha` 参数：`alpha: true` 会让画布在未绘制处变成透明，
// 改变可见行为（画布背后是 DSH 页面），风险波及所有壁纸；此处只修「渲染到 RT」这条路径，
// 主场景 → 画布的清屏 alpha 保持原状（逐字不变）。
import type * as THREE from 'three';

/** renderer 的清屏 alpha 相关方法（mock renderer / 旧 three 可能没有，防御式跳过）。 */
interface ClearAlphaCapable {
  getClearAlpha?: () => number;
  setClearAlpha?: (alpha: number) => void;
}

/**
 * 把 `scene` 渲染进 `target`：渲染前把清屏 alpha 置 0（透明黑），渲染后恢复。
 *
 * 退出时渲染目标被复位为 null（与既有调用点一致：调用方随后都渲染主场景 → 画布）。
 * 返回值为渲染前的清屏 alpha（供诊断/测试断言；renderer 不支持时为 null）。
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
