import type { CompiledEffectPass } from './shader/effect-chain.js';
/** bind 覆盖项：指向序列起点输入，或链内具名 RT。 */
export type RtSource = {
    type: 'previous';
} | {
    type: 'named';
    key: string;
};
/** 写端：具名 RT / ping-pong 对端 / 本条计划最后一个 pass 的输出。 */
export type RtWrite = {
    type: 'named';
    key: string;
} | {
    type: 'pingpong';
} | {
    type: 'final';
};
export interface PlannedPass {
    chainIndex: number;
    /** 链内下标：执行器用 chains[chainIndex][passIndex] 取材质信息（droppedChains 会让平坦下标错位）。 */
    passIndex: number;
    /** 只含 bind 覆盖项；未覆盖的槽由执行器按既有默认语义处理。 */
    bindings: Array<{
        slot: number;
        source: RtSource;
    }>;
    write: RtWrite;
    blendMode: string;
    target?: string;
    unresolvedBinds?: string[];
}
export interface EffectPlan {
    namedTargets: Array<{
        key: string;
        name: string;
        width: number;
        height: number;
    }>;
    passes: PlannedPass[];
    /** 具名 RT 超上限而整体放弃的链序号。 */
    droppedChains: number[];
}
/** 单链具名 RT 软上限（全库实测最多 8 张；阈值高于实测，以免误杀库外正常链）。 */
export declare const NAMED_RT_LIMIT = 16;
export declare function namedRtKey(chainIndex: number, name: string): string;
/** fbos 未声明 / 非正数 / 非有限值 → 1（全尺寸）。 */
export declare function namedRtScale(fboScale: Record<string, number> | undefined, name: string): number;
/** scale / base 非法（非有限 / ≤0）→ 按 1：导出 API 自身设防，不依赖调用方先归一。 */
export declare function namedRtSize(baseWidth: number, baseHeight: number, scale: number): {
    width: number;
    height: number;
};
export declare function buildEffectPlan(chains: CompiledEffectPass[][], opts: {
    baseWidth: number;
    baseHeight: number;
}): EffectPlan;
