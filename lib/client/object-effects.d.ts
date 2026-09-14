import type * as THREE from 'three';
import { EffectRunner } from './effect-runner.js';
import type { EffectTexLoader } from './effect-runner.js';
import type { CompiledEffectPass } from './shader/effect-chain.js';
export declare function weVRowOrderLoader(load?: EffectTexLoader): EffectTexLoader;
export interface ObjectEffectStage {
    /** 主场景渲染之前：把每个隔离对象的合成 quad 绑到效果输出（或回退对象 RT 原图）。 */
    bindOutputs(): void;
    /** 主场景渲染之后：串行推进 runner.update（异步，不阻塞本帧）。 */
    advance(time: number): void;
}
export declare function isLinearEffectChain(passes: CompiledEffectPass[]): boolean;
export declare function resolveObjectRtSize(worldW: number, worldH: number, dpr: number, budgetW: number, budgetH: number): {
    width: number;
    height: number;
};
export interface IsolatedHostView {
    id: number;
    rtWidth: number;
    rtHeight: number;
    rtTexture: THREE.Texture;
}
export interface ObjectEffectHost {
    renderer: THREE.WebGLRenderer;
    isolatedObjects(): IsolatedHostView[];
    setObjectOutput(id: number, texture: THREE.Texture): void;
    resizeObjectRT(id: number, width: number, height: number): void;
}
export declare class ObjectEffectStage implements ObjectEffectStage {
    private readonly host;
    private entries;
    private skips;
    private readonly wallpaperId;
    private readonly dpr;
    private budgetWidth;
    private budgetHeight;
    private disposed;
    private busy;
    private queue;
    /** 去重告警集合（`warnSkip` 之外的通用去重，按 key 只打印一次，防每帧刷屏）。 */
    private warned;
    constructor(host: ObjectEffectHost, opts: {
        wallpaperId: string;
        dpr: number;
        budgetWidth: number;
        budgetHeight: number;
    });
    /** 世界尺寸（场景像素）：resize 时按新预算重算 RT 像素尺寸的唯一来源。
     *  调用顺序契约：three-renderer 先 setWorldSize 再 setObjectChains（后者不覆盖前者）。 */
    setWorldSize(objId: number, worldW: number, worldH: number): void;
    /** 挂载某对象的效果链。调用顺序契约：player 先在 loadSceneToThree 内建好隔离条目，
     *  stage 再挂链（Task 5 的接线顺序：setWorldSize → setObjectChains）；找不到隔离条目
     *  说明契约被破坏 → 明确告警一次，绝不静默丢弃，也绝不猜尺寸。 */
    setObjectChains(objId: number, chains: CompiledEffectPass[][]): void;
    /** 视口/预算变化：按新预算重算每个对象的 RT 像素尺寸，并用同一份链重挂（runner 内部 RT 跟随）。
     *  ⚠️ 遍历 `this.entries` 的**所有**条目（不按有无 runner 过滤）：链全被跳过、因而没有 runner
     *  的隔离对象（如具名 RT 图链）同样要随视口重设 RT，否则视口放大后它一直用旧的小 RT（偏糊）、
     *  视口缩小时又一直占着旧的大 RT（超额显存）。 */
    onViewportResize(budgetWidth: number, budgetHeight: number): void;
    /** 被跳过的具名 RT 图链标识（按标识去重），供诊断与测试查询。 */
    rtGraphSkips(): string[];
    dispose(): void;
    debugRunners(): Map<number, EffectRunner>;
    debugInjectRunner(id: number, runner: EffectRunner): void;
    /** 具名 RT 图链降级告警：按标识去重（同一效果被多个对象引用时只告警一次，不刷屏）。 */
    private warnSkip;
    /** 去重告警（同一 key 只打印一次，防每帧刷屏）。 */
    private warnOnce;
    /** 串行队列入队（约束 3 / 2：只调用既有的 update，不在此建材质）。 */
    private enqueue;
    private runTask;
    private finishTask;
    private mount;
}
