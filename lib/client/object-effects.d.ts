import type * as THREE from 'three';
import type { SourcePixels } from './object-range.js';
import { EffectRunner } from './effect-runner.js';
import type { EffectGlobalUniforms, EffectTexLoader } from './effect-runner.js';
import type { CompiledEffectPass } from './shader/effect-chain.js';
import { type EffectPlan } from './effect-graph.js';
export declare const ENABLE_CHAIN_FRAME_SNAPSHOT_CONSUMER = false;
export declare function weVRowOrderLoader(load?: EffectTexLoader): EffectTexLoader;
export interface ObjectEffectStage {
    /** 主场景渲染之前：把每个隔离对象的合成 quad 绑到效果输出（或回退对象 RT 原图）。 */
    bindOutputs(): void;
    /** 主场景渲染之后：串行推进 runner.update（异步，不阻塞本帧）。 */
    advance(time: number): void;
    /** 段边界（消费者被绘制**之前**）同步通知：该对象的链本帧用这张整帧快照（AGENT.md §5.46）。
     *  未携带纹理时向宿主拉取（`ObjectEffectHost.captureFullFrame()`）。
     *  `snapshotVersion` = 捕获当刻的 `FrameCapture.snapshotVersion`：排队的 update 在**执行当刻**
     *  与宿主提供的实时代号比较，不一致即按「无快照」走（resize/dispose 会重建快照，旧引用已 dispose）。 */
    onSegmentBoundary(objectId: number, frameTexture?: THREE.Texture | null, snapshotVersion?: number): void;
    /** 画布缓冲/视口变化：作废**尚未被 advance 消费**的本帧快照（`FrameCapture.resize()` 会 dispose
     *  旧快照并重建）。已被 advance 带进闭包的那份由执行当刻的实时代号比较兜底。 */
    notifyViewportResize(): void;
}
/** 该对象是否引用整帧快照（任一链的任一 pass 真的会采样它）⇒ 它**本应**是段边界消费者。
 *  ⚠️ 本轮该结论**不接线**（门控 `ENABLE_CHAIN_FRAME_SNAPSHOT_CONSUMER = false`）：只保留判定能力
 *  与单测，供 UV 口径验证后开启。
 *  判定走**执行计划**（`plan.passes` + `pp.bindings`）—— 与 `EffectRunner.update` 的槽绑定同源；
 *  不得改读原始 `pass.bind`：未解析名字的 bind 会被计划丢弃，那种形态下 update 实际绑的是
 *  `textureSlots[j]`（两套口径会对同一 pass 给出相反结论）。 */
export declare function referencesFrameSnapshot(chains: CompiledEffectPass[][], plan?: EffectPlan): boolean;
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
    /** 段边界快照的拉取入口：拍一张「到此刻为止已绘制内容」；无 FrameCapture / 未激活 → null。 */
    captureFullFrame(): THREE.Texture | null;
    /** 快照代号的**实时**读取入口（= `FrameCapture.snapshotVersion`）：排队的 update 在**执行当刻**
     *  读它，与捕获当刻记录的代号比较，不一致即按「无快照」走。无 FrameCapture 时返回 -1。
     *  未实现 ⇒ 无从比较（退回「不因版本作废」，与接线前同语义）。 */
    frameSnapshotVersion?(): number;
    /** 把该对象登记为段边界消费者（player 的既有公开方法）：登记后 frameCapture 才会 active
     *  ⇒ 段渲染与其段边界快照才会发生（不登记 ⇒ 本对象的链永远拿不到快照）。 */
    registerFrameConsumer(objectId: number): void;
}
export declare class ObjectEffectStage implements ObjectEffectStage {
    private readonly host;
    private entries;
    private readonly wallpaperId;
    /** 屏幕密度（设备像素 / 世界单位）：对象 RT 尺寸的唯一基准，随视口变化（onViewportResize）。 */
    private screenScale;
    private disposed;
    private busy;
    private queue;
    /** 去重告警集合（按 key 只打印一次，防每帧刷屏）。 */
    private warned;
    /** 本帧各对象在段边界拿到的整帧快照 + **捕获当刻**的快照代号（advance 消费后清空，快照逐帧覆盖）。 */
    private boundarySnapshots;
    /** 最近一次段边界快照（player 同步）：`allowFrameSnapshot` 放行的链在无本帧边界通知时用它兜底。 */
    private frameSnapshot;
    /** util 专用 `_rt_FullFrameBuffer` 槽门控：缺省 undefined = 旧语义（边界快照照常交给链）。 */
    private readonly allowFrameSnapshot?;
    /** 音频频谱源：每帧同一缓冲引用；null = 全零静音（无音频/音效关闭）。 */
    private audioSpectrum;
    /** 效果 shader 全局 uniform（指针/视差）：每帧由渲染器下发，advance 随 update 交给各 runner。 */
    private globalUniforms;
    constructor(host: ObjectEffectHost, opts: {
        wallpaperId: string;
        screenScale: number;
        /** util 内容层的快照槽门控（渲染器按 util 内容 id 下发）；只有它放行 **且** 链真的引用
         *  `_rt_FullFrameBuffer` 时，快照才作为纹理槽绑进链（对象链门控保持关闭）。 */
        allowFrameSnapshot?: (objectId: number) => boolean;
    });
    /** 当前屏幕密度（设备像素 / 世界单位）；同源下发契约见类头。 */
    private scale;
    /** 世界尺寸 + 源纹理尺寸（场景像素）：resize 时按新预算重算 RT 像素尺寸的唯一来源。
     *  调用顺序契约：three-renderer 先 setWorldSize 再 setObjectChains（后者不覆盖前者）。
     *  `budgeted` = 该对象是否计入 resize 期显存预算（挂载期 isolateItems 的集合 = image；缺省 false）。 */
    setWorldSize(objId: number, worldW: number, worldH: number, source?: SourcePixels | null, budgeted?: boolean): void;
    /** 挂载某对象的效果链（线性链与具名 RT 图链一视同仁，计划交执行器执行）。调用顺序契约：
     *  player 先在 loadSceneToThree 内建好隔离条目，stage 再挂链（setWorldSize → setObjectChains）；
     *  找不到隔离条目说明契约被破坏 → 明确告警一次，绝不静默丢弃，也绝不猜尺寸。 */
    setObjectChains(objId: number, chains: CompiledEffectPass[][]): void;
    /** 视口变化：按新的**屏幕密度**重算每个对象的 RT 像素尺寸，并用同一份链重挂（runner 内部 RT 跟随）。
     *  尺寸口径与挂载期**同源**：同一纯函数 isolatedRtSize + 同一口径（预算输入集合的差异见 AGENT.md §7.36）
     *  ——若这里另写一套屏占位算术，任何一次 resize 都会把 RT 打回屏占位（违反只升不降）。
     *  ⚠️ 参数是「设备像素 / 世界单位」这一个标量（object-range.screenScalePx 的返回值），**不是**
     *  视口宽高预算：传 `视口 × dpr` 会成了「第二处独立预算」，输入不同源时任何一次 resize 都会把
     *  RT 打回旧口径。密度必须由调用方从**主相机同一套 cover 语义**取得（three-renderer 用
     *  player.screenScalePx()）。
     *  ⚠️ 遍历 `this.entries` 的**所有**条目（不按有无 runner 过滤）：只 setWorldSize 过、链尚未挂载
     *  的隔离对象同样要随视口重设 RT，否则视口放大后一直用旧的小 RT（偏糊）、缩小时又占着旧的大 RT。 */
    onViewportResize(screenScale: number): void;
    /** 注入音频频谱源（由 three-renderer 每帧刷新后转入）：效果链的音频 uniform 由它驱动；
     *  null = 全零静音（无 sound / 音效开关关闭）。 */
    setAudioSpectrum(source: Uint8Array | null): void;
    /** 注入效果 shader 全局 uniform（指针/视差）：每帧调用，advance 时下发给各 runner。 */
    setGlobalUniforms(uniforms: EffectGlobalUniforms): void;
    /** 执行当刻判「快照已换代」：实时代号 ≠ 捕获当刻代号 ⇒ 快照纹理已被 resize/dispose 换掉。
     *  `-1`（宿主未提供代号）不作废 —— 无从比较时按既有语义照常使用。 */
    private snapshotStale;
    /** 段边界快照同步（由 player 在每个段边界调用）：`allowFrameSnapshot` 放行的链在没有本帧
     *  边界通知时用它兜底绑 `_rt_FullFrameBuffer` 槽。 */
    setFrameSnapshot(frameTexture: THREE.Texture | null): void;
    /** 测试/诊断：该对象的链是否真的会绑整帧快照（放行 + 链显式引用 `_rt_FullFrameBuffer`）。 */
    frameSnapshotBound(objectId: number): boolean;
    /** 交给 runner 的快照纹理（执行当刻求值）：
     *  - 缺省 `allowFrameSnapshot`：旧语义 = 本帧段边界快照（对象链门控仍由全局常量负责）；
     *  - 有门控：未放行/未引用 ⇒ null（绝不把快照漏给对象链）；放行 ⇒ 边界快照优先、全局快照兜底。 */
    private frameTextureFor;
    dispose(): void;
    debugRunners(): Map<number, EffectRunner>;
    debugInjectRunner(id: number, runner: EffectRunner): void;
    /** 去重告警（同一 key 只打印一次，防每帧刷屏）。 */
    private warnOnce;
    /** 串行队列入队（约束 3 / 2：只调用既有的 update，不在此建材质）。 */
    private enqueue;
    private runTask;
    private finishTask;
    /** `plan` 由调用方传入（`setObjectChains` 已按同一尺寸算过一份，且用它判定过消费者）：
     *  再算一遍会让「判定用的计划」与「执行用的计划」可能分叉。 */
    private mount;
}
