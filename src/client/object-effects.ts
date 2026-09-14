// src/client/object-effects.ts
// three 主路径的对象级效果链编排。
//
// 分工（见 spec §3）：
//   - 本模块：效果链的**编排**（分类、尺寸预算、每对象一个 EffectRunner、串行推进、降级）。
//   - threejs-player.ts：对象的**隔离渲染**（内容进 localScene / 主场景放合成 quad / 帧序）。
//   - effect-runner.ts：pass 执行（本特性不改它一行）。
//
// 本模块不构造 three 场景、不持有 canvas；player 通过结构化接口（ObjectEffectStage）
// 被注入，因此本模块不 import threejs-player.ts（避免循环依赖）。
import type * as THREE from 'three';
import { OBJECT_RT_MAX } from './object-range.js';
import type { CompiledEffectPass } from './shader/effect-chain.js';

// player 消费的钩子接口（结构化匹配，player 不 import 本模块）。
// 隔离内容的渲染（setRenderTarget + render(localScene, localCamera)）由 player 自己完成，
// 因为它拥有 scene/camera；stage 只负责下面两件事。
export interface ObjectEffectStage {
  /** 主场景渲染之前：把每个隔离对象的合成 quad 绑到效果输出（或回退对象 RT 原图）。 */
  bindOutputs(): void;
  /** 主场景渲染之后：串行推进 runner.update（异步，不阻塞本帧）。 */
  advance(time: number): void;
}

// 线性可执行判定（spec §5.1）：链中每个 pass 都不写具名 RT，且 bind 与 EffectRunner 的
// **固定绑定**完全一致——`g_Texture0` = 上一 pass 输出（readTex），`g_Texture(j+1)` =
// textureSlots[j]（见 effect-runner.ts 的纹理绑定段）。故判据是「`target` 非空 **或** 存在
// 引用了非 `previous`/非空名的 bind」（bind.name 语义见 shader/effect-chain.ts）：
//   - 无 target、bind 为空（如 refraction 的 2 pass）：由 ping-pong 正确实现；
//   - `bind: [{ name: 'previous', index: 0 }]`：与执行器默认行为同义，线性可执行；
//   - 其它任何 bind 都需要 RT 图语义，执行器无法表达：具名 RT（`_rt_*`）无法绑定；空名
//     （sampler2D 槽）无法表达「某个 g_TextureN 来自纹理槽而非上 pass」的任意映射；
//     `previous` 绑到 index≠0 表示「g_Texture1 = 上一 pass 输出」，而执行器把该槽留给纹理槽；
//   - `fbos` 只对具名 RT 有意义：链内没有 target 时它没有消费者，不构成降级理由。
// 具名 RT 图链（blur / blurprecise / godrays / bloom / shine / localcontrast / bokeh_blur）
// 需要 RT 图执行器（P2），当前整条跳过——产品是错画面，不得硬跑。
export function isLinearEffectChain(passes: CompiledEffectPass[]): boolean {
  if (passes.length === 0) return false;
  // 与 EffectRunner 的固定绑定一致者才算线性：`g_Texture0` = 上一 pass 输出。
  // 任何其它 bind（具名 RT、空名 sampler 槽、把 previous 绑到 index ≠ 0）都需要 RT 图语义，
  // 由下游整条跳过 + 告警（P2 再做 RT 图执行器）。
  return passes.every(
    (p) => !p.target && p.bind.every((b) => b.name === 'previous' && b.index === 0),
  );
}

// 对象 RT 像素尺寸（spec §5.2）：
//   世界尺寸（场景像素，已含 objectCameraRange 的 4096 钳制与幅值语义）× dpr，
//   再**等比**收口到 min(4096, 画布缓冲预算)。
// 等比而非逐轴独立 clamp：独立 clamp 会把 8192×4608 压成 4096×4096，破坏依赖 aspect 的
// 效果（竞品 perf-audit 2026-08-29 记录的真实事故）。
export function resolveObjectRtSize(
  worldW: number,
  worldH: number,
  dpr: number,
  budgetW: number,
  budgetH: number,
): { width: number; height: number } {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const rawW = Math.max(0, Math.abs(worldW)) * scale;
  const rawH = Math.max(0, Math.abs(worldH)) * scale;
  const capW = Math.max(1, Math.min(OBJECT_RT_MAX, Math.floor(budgetW) || OBJECT_RT_MAX));
  const capH = Math.max(1, Math.min(OBJECT_RT_MAX, Math.floor(budgetH) || OBJECT_RT_MAX));
  // 两轴共用同一比例（等比）；rawW/rawH 为 0 时该轴的比例不参与（避免除零与 0×0）
  const ratios: number[] = [1];
  if (rawW > 0) ratios.push(capW / rawW);
  if (rawH > 0) ratios.push(capH / rawH);
  const s = Math.min(...ratios);
  const width = Math.max(1, Math.round(rawW * s));
  const height = Math.max(1, Math.round(rawH * s));
  return { width, height };
}

// 占位：本任务不实现（Task 4 落地）。保留类型引用避免未使用告警。
export type EffectTexture = THREE.Texture;
