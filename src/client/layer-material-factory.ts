// 图层材质工厂：从 ThreeScenePlayer 拆出的阶段 2c 子系统（审查 P0-9）。
// 纯函数/无状态：WE colorBlendMode 的 CustomBlending 复刻、util 占位材质、合成 quad 材质、
// 对象 RT 的采样策略。渲染行为与拆分前逐字一致（注释保留原始根因）。
import * as THREE from 'three';
import { materialModulation } from './object-range.js';
import type { UtilMaterialSpec } from './util-material.js';

// 无纹理（opts.tex 缺省）时的 1×1 白色兜底（同 scene-renderer.createWhiteDataTexture 语义）：
// 纯色粒子不依赖纹理内容，颜色/透明度由 vParticleColor/vParticleAlpha 给定。
export function createWhiteTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

// ── WE 图像颜色混合模式（`colorBlendMode` → shader combo `BLENDMODE`）────────────────────────
//
// image 对象带 `colorBlendMode != 0` 时 WE 会**额外追加一遍混合 pass**（材质
// `materials/util/effectpassthrough.json`，shader = `genericimage3`；lwe `CImage.cpp:751-767`），片元逻辑：
//   rgb = ApplyBlending(BLENDMODE, screen.rgb, gl_FragColor.rgb, gl_FragColor.a);  a = screen.a
// `ApplyBlending`（`shaders/common_blending.h`）= `mix(A, F(A,B), op)`，A=背景、B=对象颜色、op=对象
// alpha ⇒ three 侧用 `CustomBlending` + **预乘片元**（rgb × alpha）复刻，使
// `result = src·srcFactor + dst·dstFactor` 与 `mix(A, F(A,B), op)` 等价。已实现的三个模式
// （= 全库仅有的三个非零值）：7 Screen（src=op·B, srcFactor=ONE_MINUS_DST_COLOR, dst=ONE —— B=0
// 时结果 = A ⇒ **黑底完全不改变背景**）、31 A+B·op（src=op·B, ONE/ONE）、6 Lighten（equation=MAX）。
// 其余模式（1..5/8..30/32）未实现 → 返回 null，调用方回退普通 alpha 混合（不静默画错）。
/** WE `colorBlendMode` → three `CustomBlending` 设置；未实现的模式返回 null。 */
export function colorBlendModeToThree(mode: number): {
  blendEquation: THREE.BlendingEquation;
  blendSrc: THREE.BlendingSrcFactor | THREE.BlendingDstFactor;
  blendDst: THREE.BlendingDstFactor;
} | null {
  switch (mode) {
    case 7: // Screen
      return { blendEquation: THREE.AddEquation, blendSrc: THREE.OneMinusDstColorFactor, blendDst: THREE.OneFactor };
    case 31: // A + B×opacity（加算）
      return { blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor };
    case 6: // Lighten（op≈1 时 = max(A,B)）
      return { blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor };
    default:
      return null;
  }
}

// 带 colorBlendMode 的背景片元 shader：与 MeshBasicMaterial 的贴图路径语义一致
// （纹理 × tint，alpha = texel.a × opacity），但**预乘输出** —— WE 公式里需要 `op·B`
// （op = 对象 alpha），不预乘就拿不到这个乘数（`ONE_MINUS_DST_COLOR` 等因子只看 dst）。
const COLOR_BLEND_FRAGMENT_SHADER = `
uniform sampler2D map;
uniform vec3 tint;
uniform float opacity;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(map, vUv);
  float a = c.a * opacity;
  gl_FragColor = vec4(c.rgb * tint * a, a);
}
`;

const COLOR_BLEND_VERTEX_SHADER = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// 隔离路径（forIsolation=true）：内容只把「自己的颜色与 alpha」写进**新清空的 RT**，WE 的
// colorBlendMode 混合语义由**合成 quad** 承担（见 createCompositeQuadMaterial）⇒ 这里
// **不套用** cb 的 CustomBlending，否则：① alpha 因子 Zero/One 在 RT 里没有背景可保持 ⇒
// RT alpha 恒 0 ⇒ 预乘片元被乘成 0 ⇒ 对象整体不可见；② 预乘写进 RT 后 quad 再预乘 ⇒ rgb × a²。
export function createLayerMaterial(
  texture: THREE.Texture | null,
  colorBlendMode: number,
  mod: { r: number; g: number; b: number; a: number },
  forIsolation = false,
): THREE.Material {
  const cb = forIsolation ? null : colorBlendModeToThree(colorBlendMode);
  if (cb) {
    return new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture ?? createWhiteTexture() },
        tint: { value: new THREE.Vector3(mod.r, mod.g, mod.b) },
        opacity: { value: mod.a },
      },
      vertexShader: COLOR_BLEND_VERTEX_SHADER,
      fragmentShader: COLOR_BLEND_FRAGMENT_SHADER,
      transparent: true,
      // 背景是透明图层，不写深度（避免干扰其他透明对象）。粒子 depthTest=false 不受影响。
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: cb.blendEquation,
      blendSrc: cb.blendSrc,
      blendDst: cb.blendDst,
      // WE：`gl_FragColor.a = screen.a` —— 结果 alpha 取**背景**的（自己的 alpha 只当混合权重）。
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
  }
  const basic = new THREE.MeshBasicMaterial({
    map: texture ?? null,
    transparent: true,
    depthWrite: false,
    // 隔离路径：WE 在对象有多个 pass 时把**首个 pass 强制成 BlendingMode_Normal（ONE/ZERO 覆盖）**
    // （lwe CImage.cpp：`(*first)->setBlendingMode(BlendingMode_Normal)`）⇒ 覆盖写，RT.rgb 保持
    // 非预乘、透明度只走 alpha（AGENT.md §5.25）。
    blending: forIsolation ? THREE.NoBlending : THREE.NormalBlending,
    // 隔离内容渲染进**y 镜像的局部相机**（对象 RT 取 WE 的 v 约定，见 attachIsolated）⇒ 屏幕空间
    // 绕序被翻转，正面朝外的 quad 会被背面剔除（对象整体消失）⇒ 隔离路径必须双面。
    side: forIsolation ? THREE.DoubleSide : THREE.FrontSide,
  });
  basic.color.setRGB(mod.r, mod.g, mod.b);
  basic.opacity = mod.a;
  return basic;
}

// util 层内容材质（v0.8.2 F2）：solid = 纯色（color×brightness、opacity=alpha）；直通 = 透明占位
//（真实内容由效果链/整帧快照覆盖，首帧无内容时不得白屏）。隔离混合约定与 createLayerMaterial 一致。
export function createUtilLayerMaterial(
  spec: UtilMaterialSpec,
  forIsolation: boolean,
  brightness?: number,
): THREE.Material {
  if (spec.kind === 'solid') {
    const mod = materialModulation(spec.color, spec.opacity, brightness);
    const solid = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: forIsolation ? THREE.NoBlending : THREE.NormalBlending,
      side: forIsolation ? THREE.DoubleSide : THREE.FrontSide,
    });
    solid.color.setRGB(mod.r, mod.g, mod.b);
    solid.opacity = mod.a;
    return solid;
  }
  return new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    // 透明占位：内容由 T3 的整帧快照/效果链输出提供。
    opacity: 0,
    depthWrite: false,
    blending: forIsolation ? THREE.NoBlending : THREE.NormalBlending,
    side: forIsolation ? THREE.DoubleSide : THREE.FrontSide,
  });
}

// 合成 quad 的材质：只负责「把对象 RT 的像素采样回主场景」。三点关键（都踩过）：
//   ① 必须独立构造，**不能 clone 内容材质**——粒子内容材质依赖逐实例属性，普通 PlaneGeometry 没有
//      这些属性会让 alpha 恒为 0（粒子完全不可见）；
//   ② **不再二次施加** alpha/brightness/color 调制（内容材质已把调制烘进 RT，再乘一次 alpha 变 a²）；
//   ③ 统一用 MeshBasicMaterial，只有 cb 分支额外开 `premultipliedAlpha`。
// WE 的 `ApplyBlending` 语义在**合成这一步**用 CustomBlending 因子复刻（alpha 取背景的 ⇒ Zero/One）；
// 带非零 angles 的对象由 quad 承载旋转，超过 90° 会翻转绕序 ⇒ 与内容材质一致用 DoubleSide。
export function createCompositeQuadMaterial(
  texture: THREE.Texture,
  colorBlendMode: number,
  opacity = 1,
): THREE.Material {
  const mat = new THREE.MeshBasicMaterial({
    map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    // 缺省 1 = 中性合成（image/particle 的 alpha 已烘进 RT，再乘一次是二次调制）；仅 util 层
    // 传入对象 alpha（内容占位/效果输出都不承载它）。
    opacity: Math.max(0, Math.min(1, opacity)),
  });
  const cb = colorBlendModeToThree(colorBlendMode);
  if (cb) {
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = cb.blendEquation;
    mat.blendSrc = cb.blendSrc;
    mat.blendDst = cb.blendDst;
    mat.blendSrcAlpha = THREE.ZeroFactor;
    mat.blendDstAlpha = THREE.OneFactor;
    // cb 的颜色因子不看 alpha，而 WE 语义是 `mix(A, blend(A,B), opacity)` ⇒ 图层 alpha
    // （opacity × mask）必须由片元预乘进 rgb，否则云层全强度盖住人物、mask 也失效（AGENT.md §5.26）。
    mat.premultipliedAlpha = true;
  }
  return mat;
}

// 合成采样决策：RT 大于屏占位（源纹理收口 4096 的结果）⇒ 合成 quad 那一步是**缩小采样**，
// 必须开 mipmap 防走样。三个调用点同式子、同一口径（screenScale = player.screenScalePx()）。
export function applyCompositeSampling(
  rt: THREE.WebGLRenderTarget,
  worldW: number,
  worldH: number,
  screenScale: number,
): void {
  const minifying = Math.max(rt.width, rt.height)
    > Math.max(Math.abs(worldW), Math.abs(worldH)) * screenScale + 0.5;
  const nextMin = minifying ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  const flipped = rt.texture.minFilter !== nextMin;
  rt.texture.generateMipmaps = minifying;
  rt.texture.minFilter = nextMin;
  // 判定翻转才 dispose 重建 RT：RT 纹理的采样参数只在 setupRenderTarget 下发（needsUpdate 无效，
  // 见 AGENT.md §5.44）⇒ 不 dispose 则 minFilter 到不了 GL；未翻转时 dispose 等于每帧重建。
  if (flipped) rt.dispose();
}
