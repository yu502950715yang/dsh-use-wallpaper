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
    /** 屏幕密度（设备像素 / 世界单位）：对象 RT 尺寸的唯一基准，随视口变化（onViewportResize）。 */
    private screenScale;
    private disposed;
    private busy;
    private queue;
    /** 去重告警集合（`warnSkip` 之外的通用去重，按 key 只打印一次，防每帧刷屏）。 */
    private warned;
    constructor(host: ObjectEffectHost, opts: {
        wallpaperId: string;
        screenScale: number;
    });
    /** 当前屏幕密度（设备像素 / 世界单位）；同源下发契约见类头。 */
    private scale;
    /** 世界尺寸（场景像素）：resize 时按新预算重算 RT 像素尺寸的唯一来源。
     *  调用顺序契约：three-renderer 先 setWorldSize 再 setObjectChains（后者不覆盖前者）。 */
    setWorldSize(objId: number, worldW: number, worldH: number): void;
    /** 挂载某对象的效果链。调用顺序契约：player 先在 loadSceneToThree 内建好隔离条目，
     *  stage 再挂链（Task 5 的接线顺序：setWorldSize → setObjectChains）；找不到隔离条目
     *  说明契约被破坏 → 明确告警一次，绝不静默丢弃，也绝不猜尺寸。 */
    setObjectChains(objId: number, chains: CompiledEffectPass[][]): void;
    /** 视口变化：按新的**屏幕密度**重算每个对象的 RT 像素尺寸，并用同一份链重挂（runner 内部 RT 跟随）。
     *  ⚠️ 参数是「设备像素 / 世界单位」这一个标量（object-range.screenScalePx 的返回值），**不是**
     *  视口宽高预算：旧实现传 `视口 × dpr` 当预算，成了「第二处独立预算」——挂载期与 resize 期
     *  各算一遍、输入不同源时任何一次 resize 都会把 RT 打回旧口径（3fd6b00「挂载期 RT 正确、
     *  resize 后被覆盖」这一漏检类的同源地雷）。密度必须由调用方从**主相机同一套 cover 语义**
     *  取得（three-renderer 用 player.screenScalePx()，见其 resize 回调）。
     *  ⚠️ 遍历 `this.entries` 的**所有**条目（不按有无 runner 过滤）：链全被跳过、因而没有 runner
     *  的隔离对象（如具名 RT 图链）同样要随视口重设 RT，否则视口放大后它一直用旧的小 RT（偏糊）、
     *  视口缩小时又一直占着旧的大 RT（超额显存）。 */
    onViewportResize(screenScale: number): void;
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
