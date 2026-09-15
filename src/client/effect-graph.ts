// src/client/effect-graph.ts
// RT 图效果链的**静态执行计划**（纯函数，node 可测）；语义依据 WE 参考实现 lwe 与 spec §2.2。
import type { CompiledEffectPass } from './shader/effect-chain.js';

/** bind 覆盖项：指向序列起点输入，或链内具名 RT。 */
export type RtSource = { type: 'previous' } | { type: 'named'; key: string };

/** 写端：具名 RT / ping-pong 对端 / 本条计划最后一个 pass 的输出。 */
export type RtWrite = { type: 'named'; key: string } | { type: 'pingpong' } | { type: 'final' };

export interface PlannedPass {
  chainIndex: number;
  /** 链内下标：执行器用 chains[chainIndex][passIndex] 取材质信息（droppedChains 会让平坦下标错位）。 */
  passIndex: number;
  /** 只含 bind 覆盖项；未覆盖的槽由执行器按既有默认语义处理。 */
  bindings: Array<{ slot: number; source: RtSource }>;
  write: RtWrite;
  blendMode: string;
  target?: string;
  unresolvedBinds?: string[];
}

export interface EffectPlan {
  namedTargets: Array<{ key: string; name: string; width: number; height: number }>;
  passes: PlannedPass[];
  /** 具名 RT 超上限而整体放弃的链序号。 */
  droppedChains: number[];
}

/** 单链具名 RT 软上限（全库实测最多 8 张；阈值高于实测，以免误杀库外正常链）。 */
export const NAMED_RT_LIMIT = 16;

export function namedRtKey(chainIndex: number, name: string): string {
  return `${chainIndex}:${name}`;
}

/** fbos 未声明 / 非正数 / 非有限值 → 1（全尺寸）。 */
export function namedRtScale(fboScale: Record<string, number> | undefined, name: string): number {
  const s = fboScale?.[name];
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1;
}

/** scale 非法 / 0 / 负 → 按 1：导出 API 自身设防，不依赖调用方先归一到 namedRtScale 的口径。 */
export function namedRtSize(baseWidth: number, baseHeight: number, scale: number): { width: number; height: number } {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    width: Math.max(1, Math.round(baseWidth / s)),
    height: Math.max(1, Math.round(baseHeight / s)),
  };
}

export function buildEffectPlan(
  chains: CompiledEffectPass[][],
  opts: { baseWidth: number; baseHeight: number },
): EffectPlan {
  const baseW = Number.isFinite(opts.baseWidth) && opts.baseWidth > 0 ? opts.baseWidth : 1;
  const baseH = Number.isFinite(opts.baseHeight) && opts.baseHeight > 0 ? opts.baseHeight : 1;
  const namedTargets: EffectPlan['namedTargets'] = [];
  const passes: PlannedPass[] = [];
  const droppedChains: number[] = [];

  chains.forEach((chain, chainIndex) => {
    // ① 具名 RT 清单：按 target 建（fbos 只用来查 scale —— GTR 的 fbos 声明与 target 实际不一致）
    const names: string[] = [];
    for (const p of chain) {
      if (p.target && !names.includes(p.target)) names.push(p.target);
    }
    if (names.length > NAMED_RT_LIMIT) {
      droppedChains.push(chainIndex);
      return;
    }
    for (const name of names) {
      const size = namedRtSize(baseW, baseH, namedRtScale(chain[0]?.fboScale, name));
      namedTargets.push({ key: namedRtKey(chainIndex, name), name, width: size.width, height: size.height });
    }
  });

  return { namedTargets, passes, droppedChains };
}
