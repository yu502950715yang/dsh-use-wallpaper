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

// 线性可执行判定（spec §5.1）：无具名 RT 写出、也无具名 RT 采样。
//   - WE 效果链的默认读取源是 `previous`（上一 pass 输出），单 pass 与纯多 pass 都由
//     EffectRunner 的 ping-pong 正确实现（如 refraction 的 2 pass）；
//   - `fbos` 只对具名 RT 有意义：链内没有 target 时它没有消费者，不构成降级理由。
// 具名 RT 图链（blur / blurprecise / godrays / bloom / shine / localcontrast / bokeh_blur）
// 需要 RT 图执行器（P2），当前整条跳过——产品是错画面，不得硬跑。
export function isLinearEffectChain(passes: CompiledEffectPass[]): boolean {
  if (passes.length === 0) return false;
  return passes.every((p) => !p.target && p.bind.length === 0);
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
