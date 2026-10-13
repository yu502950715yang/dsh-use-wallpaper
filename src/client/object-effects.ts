// three 主路径的对象级效果链编排。
//
// 分工（见 AGENT.md §2.1）：
//   - 本模块：效果链的**编排**（尺寸口径的消费、每对象一个 EffectRunner、串行推进、降级）。
//   - threejs-player.ts：对象的**隔离渲染**（内容进 localScene / 主场景放合成 quad / 帧序）。
//   - effect-runner.ts：pass 执行。
//
// 本模块不构造 three 场景、不持有 canvas；player 通过结构化接口（ObjectEffectStage）
// 被注入，因此本模块不 import threejs-player.ts（避免循环依赖）。
import type * as THREE from 'three';
import { fitIsolatedBudget, isolatedRtSize } from './object-range.js';
import type { SourcePixels } from './object-range.js';
import { EffectRunner, planSamplesFrameSnapshot } from './effect-runner.js';
import type { EffectTexLoader } from './effect-runner.js';
import { loadTexTexture } from './tex-loader.js';
import type { CompiledEffectPass } from './shader/effect-chain.js';
import { buildEffectPlan, type EffectPlan } from './effect-graph.js';

// 效果链的 `_rt_FullFrameBuffer` 消费者**本轮不启用**（见 AGENT.md §5.46）：对象链的贴屏 quad UV
// 只覆盖**对象窗口**，而快照是**整画布**（v 约定还反向一次）⇒ 直采会错位，且该路径从未真机验收；
// 启用前必须先解决「对象窗口 UV ↔ 整画布快照」的映射与 v 约定。
// 关闭时行为 = 改动前：该槽留空 + 每槽去重告警；帧序不因效果链改变（能力保留在执行器与纯函数里）。
export const ENABLE_CHAIN_FRAME_SNAPSHOT_CONSUMER = false;

// 效果纹理槽加载器（**必须与对象 RT 的 v 约定同一套**）：对象 RT 由
// `threejs-player.attachIsolated` 的 **y 镜像局部相机**渲染 ⇒ RT 的 v=0 = 图像**顶部**（= WE 约定：
// WE/lwe 直接上传 `.tex` 首行，v=0 也是图像顶部）。效果 shader 用 `v_TexCoord.y` 当图像空间坐标
// （flowmap 的带符号位移 / clouds 的旋转滚动 / foliagesway 的摆动方向），所以纹理槽也必须按 WE
// 约定（不翻行序）加载，否则「条带位置对、方向与斜度反」。
// ⚠️ **只翻一侧不解决问题**（两侧同底部约定时位置对而方向反；只翻 mask 会让位置也反），
// 必须两侧一起从「显示约定」迁到「WE 约定」（见 AGENT.md §5.20）。
// 抽成工厂（纯函数）便于 node 单测断言注入的 rowOrder 真的传到了加载器。
export function weVRowOrderLoader(load: EffectTexLoader = loadTexTexture): EffectTexLoader {
  return (url, opts) => load(url, { ...opts, rowOrder: 'topDown' });
}

// player 消费的钩子接口（结构化匹配，player 不 import 本模块）。隔离内容的渲染由 player 自己完成
// （它拥有 scene/camera），stage 只负责「绑输出」与「推进链」。
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

// 线性可执行判定：链中每个 pass 都不写具名 RT，且 bind 与 EffectRunner 的**固定绑定**完全一致
// ——`g_Texture0` = 上一 pass 输出（readTex），`g_Texture(j+1)` = textureSlots[j]（见
// effect-runner.ts 的纹理绑定段）。故判据是「`target` 非空 **或** 存在引用了非 `previous`/非空名的
// bind」（bind.name 语义见 shader/effect-chain.ts）：
//   - 无 target、bind 为空（如 refraction 的 2 pass）：由 ping-pong 正确实现；
//   - `bind: [{ name: 'previous', index: 0 }]`：与执行器默认行为同义，线性可执行；
//   - 其它任何 bind 都需要 RT 图语义，执行器无法表达：具名 RT（`_rt_*`）无法绑定；空名
//     （sampler2D 槽）无法表达「某个 g_TextureN 来自纹理槽而非上 pass」的任意映射；
//     `previous` 绑到 index≠0 表示「g_Texture1 = 上一 pass 输出」，而执行器把该槽留给纹理槽；
//   - `fbos` 只对具名 RT 有意义：链内没有 target 时它没有消费者，不构成降级理由。
// 具名 RT 图链（blur / godrays / bloom 等）由 effect-graph 的 RT 图计划执行；本判定只作分类/回归口径用。
/** 该对象是否引用整帧快照（任一链的任一 pass 真的会采样它）⇒ 它**本应**是段边界消费者。
 *  ⚠️ 本轮该结论**不接线**（门控 `ENABLE_CHAIN_FRAME_SNAPSHOT_CONSUMER = false`）：只保留判定能力
 *  与单测，供 UV 口径验证后开启。
 *  判定走**执行计划**（`plan.passes` + `pp.bindings`）—— 与 `EffectRunner.update` 的槽绑定同源；
 *  不得改读原始 `pass.bind`：未解析名字的 bind 会被计划丢弃，那种形态下 update 实际绑的是
 *  `textureSlots[j]`（两套口径会对同一 pass 给出相反结论）。 */
export function referencesFrameSnapshot(chains: CompiledEffectPass[][], plan?: EffectPlan): boolean {
  // 缺省自建一份计划（尺寸只用于具名 RT 的分配，与「哪个槽会被采样」无关）；调用方已有计划时应传入。
  return planSamplesFrameSnapshot(chains, plan ?? buildEffectPlan(chains, { baseWidth: 1, baseHeight: 1 }));
}

export function isLinearEffectChain(passes: CompiledEffectPass[]): boolean {
  if (passes.length === 0) return false;
  // 与 EffectRunner 的固定绑定一致者才算线性：`g_Texture0` = 上一 pass 输出；任何其它 bind
  // （具名 RT、空名 sampler 槽、把 previous 绑到 index ≠ 0）都属 RT 图链。
  return passes.every(
    (p) => !p.target && p.bind.every((b) => b.name === 'previous' && b.index === 0),
  );
}

// 对象 RT 像素尺寸的口径（实现在 object-range.isolatedRtSize，此处只做说明）：
//   屏占位 = |世界尺寸（场景像素，未钳制）| × 屏幕密度（1 世界单位 = 多少设备像素）；
//   RT 目标长边 = max(屏占位长边, min(源纹理长边, 4096)) 等比收口、按预算收窄 ⇒ **只升不降**。
// 屏占位即**对象在画布缓冲上的占位像素** —— 与合成 quad 在屏上的像素网格同一把尺子 ⇒ 采样比恒为
// 1.0；屏幕密度由 three-renderer 从**主相机同一套 cover 语义**算出并同源下发，挂载期与 resize 期
// 必须调同一个纯函数、同一份输入，否则 resize 会打回旧口径（见 AGENT.md §5.15/§5.21）。

// ══ 编排器 ═══════════════════════════════════════════════════════════════════
// 按对象挂效果链、每对象一个 EffectRunner、串行推进、resize 重算尺寸。
//
// 三条硬约束：
//   1. 每对象一个 runner，RT 尺寸 = 该对象 RT 尺寸：对象级效果**不得**全屏展平
//      （全屏展平会让效果漫到对象包围盒之外）；
//   2. 加载期一次建成具名 RT 池：EffectRunner 的创建与 setPlan 只发生在挂链与 resize；材质与 1×1
//      探针编译仍由首个 update 帧懒建，bindOutputs / advance 不建管线；
//   3. 串行推进：同一时刻只允许一个 runner 触碰 renderer 的 RT/绑定状态——并发交错会让 ping-pong
//      写端与输入纹理错配 → 黑屏/闪烁。EffectRunner 自己的 updateInFlight 只挡得住同一个 runner，
//      挡不住多个 runner 之间，故串行化必须由本编排器承担。

// 编排器看到的隔离对象视图（player 的 isolatedObjects() 结构性满足它）。
export interface IsolatedHostView {
  id: number;
  rtWidth: number;
  rtHeight: number;
  rtTexture: THREE.Texture;
}

// player 的最小宿主接口（player 不 import 本模块，结构化匹配即可）。
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

// 单个隔离对象的链状态。
interface ObjectChainEntry {
  runner: EffectRunner | null;
  /** 原始链定义：resize 时用同一份链 + 新尺寸重建计划（执行器只在尺寸变化时重建 RT）。 */
  chains: CompiledEffectPass[][];
  /** 本次挂载的计划（resize 重挂时按新尺寸重建）。 */
  plan: EffectPlan | null;
  /** 世界尺寸（场景像素，未钳制、未乘屏幕密度）——resize 时用它按新屏幕密度重算 RT 像素尺寸。 */
  worldW: number;
  worldH: number;
  /** 源纹理像素尺寸（隔离 RT 的升级上限来源）；未知（粒子对象 / 纹理未就绪）为 null ⇒ 回退屏占位。 */
  source: SourcePixels | null;
}

export class ObjectEffectStage implements ObjectEffectStage {
  private entries = new Map<number, ObjectChainEntry>();
  private readonly wallpaperId: string;
  /** 屏幕密度（设备像素 / 世界单位）：对象 RT 尺寸的唯一基准，随视口变化（onViewportResize）。 */
  private screenScale: number;
  private disposed = false;
  // 串行链（约束 3）：busy = 有 runner 正在 update，queue = 等待中的 update 任务。
  // 空闲时**同步**发起第一项（本帧立即开始推进，不推迟一个微任务；player 的帧序是 render 之后才
  // advance，故此刻切换 RT 不会打扰本帧主场景渲染）；忙时排队，等前一项 settle 后再发起。
  private busy = false;
  private queue: Array<() => unknown> = [];
  /** 去重告警集合（按 key 只打印一次，防每帧刷屏）。 */
  private warned = new Set<string>();
  /** 本帧各对象在段边界拿到的整帧快照 + **捕获当刻**的快照代号（advance 消费后清空，快照逐帧覆盖）。 */
  private boundarySnapshots = new Map<number, { texture: THREE.Texture; version: number }>();
  /** 音频频谱源：每帧同一缓冲引用；null = 全零静音（无音频/音效关闭）。 */
  private audioSpectrum: Uint8Array | null = null;

  constructor(
    private readonly host: ObjectEffectHost,
    opts: { wallpaperId: string; screenScale: number },
  ) {
    this.wallpaperId = opts.wallpaperId;
    this.screenScale = opts.screenScale;
  }

  /** 当前屏幕密度（设备像素 / 世界单位）；同源下发契约见类头。 */
  private scale(): number {
    const s = this.screenScale;
    return Number.isFinite(s) && s > 0 ? s : 1;
  }

  /** 世界尺寸 + 源纹理尺寸（场景像素）：resize 时按新预算重算 RT 像素尺寸的唯一来源。
   *  调用顺序契约：three-renderer 先 setWorldSize 再 setObjectChains（后者不覆盖前者）。 */
  setWorldSize(objId: number, worldW: number, worldH: number, source: SourcePixels | null = null): void {
    if (this.disposed) return;
    const entry = this.entries.get(objId);
    if (entry) {
      entry.worldW = worldW;
      entry.worldH = worldH;
      entry.source = source;
      return;
    }
    this.entries.set(objId, { runner: null, chains: [], plan: null, worldW, worldH, source });
  }

  /** 挂载某对象的效果链（线性链与具名 RT 图链一视同仁，计划交执行器执行）。调用顺序契约：
   *  player 先在 loadSceneToThree 内建好隔离条目，stage 再挂链（setWorldSize → setObjectChains）；
   *  找不到隔离条目说明契约被破坏 → 明确告警一次，绝不静默丢弃，也绝不猜尺寸。 */
  setObjectChains(objId: number, chains: CompiledEffectPass[][]): void {
    if (this.disposed) return;
    if (chains.length === 0) return;
    const view = this.host.isolatedObjects().find((o) => o.id === objId);
    if (!view) {
      // 调用顺序契约：player 先建好隔离对象，stage 再挂链（setWorldSize → setObjectChains）。
      // 走到这里说明契约被破坏——明确告警一次，绝不静默丢弃，也绝不猜尺寸。
      this.warnOnce(`no-isolated:${objId}`, `对象 ${objId} 尚无隔离条目，效果链未挂载（调用顺序错误）`);
      return;
    }
    // 引用整帧快照的链本应把该对象登记为段边界消费者（不登记 ⇒ frameCapture 不 active ⇒ 该链拿不到
    // 快照），但该消费路径**本轮门控关闭**（`ENABLE_CHAIN_FRAME_SNAPSHOT_CONSUMER`，理由见其定义）。
    // 判定与执行共用**同一份计划**（`pp.bindings` 为唯一来源，见 referencesFrameSnapshot）。
    const plan = buildEffectPlan(chains, { baseWidth: view.rtWidth, baseHeight: view.rtHeight });
    if (ENABLE_CHAIN_FRAME_SNAPSHOT_CONSUMER && referencesFrameSnapshot(chains, plan)) {
      this.host.registerFrameConsumer(objId);
    }
    this.mount(objId, chains, view.rtWidth, view.rtHeight, plan);
  }

  /** 视口变化：按新的**屏幕密度**重算每个对象的 RT 像素尺寸，并用同一份链重挂（runner 内部 RT 跟随）。
   *  尺寸口径与挂载期**同源**：同一纯函数 isolatedRtSize + 同一口径（预算输入集合的差异见 AGENT.md §7.36）
   *  ——若这里另写一套屏占位算术，任何一次 resize 都会把 RT 打回屏占位（违反只升不降）。
   *  ⚠️ 参数是「设备像素 / 世界单位」这一个标量（object-range.screenScalePx 的返回值），**不是**
   *  视口宽高预算：传 `视口 × dpr` 会成了「第二处独立预算」，输入不同源时任何一次 resize 都会把
   *  RT 打回旧口径。密度必须由调用方从**主相机同一套 cover 语义**取得（three-renderer 用
   *  player.screenScalePx()）。
   *  ⚠️ 遍历 `this.entries` 的**所有**条目（不按有无 runner 过滤）：只 setWorldSize 过、链尚未挂载
   *  的隔离对象同样要随视口重设 RT，否则视口放大后一直用旧的小 RT（偏糊）、缩小时又占着旧的大 RT。 */
  onViewportResize(screenScale: number): void {
    if (this.disposed) return;
    this.screenScale = screenScale;
    // 预算随视口重算（同一纯函数 + 同一口径；预算输入集合的差异见 AGENT.md §7.36）；按**全部**条目算。
    const budgetScale = fitIsolatedBudget(
      [...this.entries].map(([objId, e]) => ({ objId, worldW: e.worldW, worldH: e.worldH, source: e.source })),
      this.scale(),
    );
    for (const [id, entry] of this.entries) {
      // 世界尺寸只由 setWorldSize 确定（唯一来源）。**不要**用 view.rtWidth / 密度 反推：
      // player 的 resizeObjectRT 会回写 rtWidth/rtHeight，反推等于把「已被上限收口的 RT」
      // 当世界尺寸，是不可逆的缩小（第一轮收口后永远回不到原尺寸）。
      const size = isolatedRtSize(entry.worldW, entry.worldH, this.scale(), entry.source, { budgetScale });
      const view = this.host.isolatedObjects().find((o) => o.id === id);
      if (!view) continue;
      if (view.rtWidth === size.width && view.rtHeight === size.height) continue;
      this.host.resizeObjectRT(id, size.width, size.height);
      // 尚无 runner（只 setWorldSize、链还没挂）→ 只重设 RT，不重挂链、不回退输出。
      if (!entry.runner) continue;
      entry.plan = buildEffectPlan(entry.chains, { baseWidth: size.width, baseHeight: size.height });
      entry.runner.setPlan(entry.plan, entry.chains, this.wallpaperId, { width: size.width, height: size.height });
      // 重挂后 runner 的 last 被清空、旧 ping-pong RT 已被 dispose，而 quad 仍绑着那张已释放的纹理
      // （配合 bindOutputs 的「链未就绪不动输出」契约，会在整个纹理槽重载窗口内采到已 dispose 的
      // 纹理 → 静默画错）。显式回退到对象 RT 原图：`resizeObjectRT` 用 rt.setSize 复用同一个
      // WebGLRenderTarget，其 .texture 不变，故 view.rtTexture 仍有效。
      this.host.setObjectOutput(id, view.rtTexture);
    }
  }

  /** 主场景渲染之前：链有输出才切合成 quad 的采样源；没有输出（首帧未就绪 / 该对象无 runner）
   *  则**不动输出**——quad 保持采样对象 RT 原图，不黑屏（降级可见，不静默画错）。 */
  bindOutputs(): void {
    // 本方法 = 每帧主渲染前的第一个钩子：在此丢弃上一帧未消费的快照（异常帧可能跳过 advance），
    // 避免把过期（甚至已 dispose）的纹理带进下一帧。
    this.boundarySnapshots.clear();
    for (const view of this.host.isolatedObjects()) {
      const out = this.entries.get(view.id)?.runner?.lastOutput() ?? null;
      if (out) this.host.setObjectOutput(view.id, out);
    }
  }

  /** 注入音频频谱源（由 three-renderer 每帧刷新后转入）：效果链的音频 uniform 由它驱动；
   *  null = 全零静音（无 sound / 音效开关关闭）。 */
  setAudioSpectrum(source: Uint8Array | null): void {
    this.audioSpectrum = source;
  }

  /** 段边界（player 在消费者被绘制**之前**调用）：记下本帧快照，供**同一帧**的 advance 传进该对象的
   *  runner ⇒ 链内 `_rt_FullFrameBuffer` 拿到本帧内容（不是上一帧）。不在此发起 update：推进统一走
   *  advance 的串行锁（约束 3），每对象每帧恰好一次，g_Time 也沿用 advance 的时间。
   *  `snapshotVersion` = **捕获当刻**的代号；advance 把它连同纹理带进排队的闭包，闭包**执行当刻**读
   *  宿主的实时代号比对（`snapshotStale`）—— 不一致说明快照已被 resize/dispose 换成新实例（旧的已
   *  dispose），该对象的 update 按「无快照」（null）走。
   *  ⚠️ 未清零的窗口：换代若正好落在 `runner.update` 内部 `await resolveTextureSlot(...)` 期间，这次
   *  已经过校验的引用仍会被采样（极低频）。 */
  onSegmentBoundary(objectId: number, frameTexture?: THREE.Texture | null, snapshotVersion?: number): void {
    if (this.disposed) return;
    const frameTex = frameTexture ?? this.host.captureFullFrame(); // 未携带纹理 → 向宿主拉取
    if (!frameTex) return; // 无快照：该对象本帧的 frameTexture 保持 null（既有语义）
    // 代号：player 携带的最权威；未携带时读一次实时值；宿主也不提供 ⇒ -1（无从比较，不作废）。
    const version = snapshotVersion ?? this.host.frameSnapshotVersion?.() ?? -1;
    this.boundarySnapshots.set(objectId, { texture: frameTex, version });
  }

  /** 执行当刻判「快照已换代」：实时代号 ≠ 捕获当刻代号 ⇒ 快照纹理已被 resize/dispose 换掉。
   *  `-1`（宿主未提供代号）不作废 —— 无从比较时按既有语义照常使用。 */
  private snapshotStale(versionAtCapture: number): boolean {
    if (versionAtCapture < 0) return false;
    const live = this.host.frameSnapshotVersion?.();
    return live !== undefined && live !== versionAtCapture;
  }

  /** 主场景渲染之后：串行推进各 runner 的 update（异步，不阻塞本帧；见类头约束 3）。 */
  advance(time: number): void {
    if (this.disposed) return;
    for (const view of this.host.isolatedObjects()) {
      const runner = this.entries.get(view.id)?.runner;
      if (!runner) continue;
      runner.setAudioSpectrumSource(this.audioSpectrum); // 每帧注入同一引用（无音频时 null）
      // 本帧段边界拍下的快照（若有）随本次 update 交给链；无则 null（不引用快照的链逐字不变）。
      const item = this.boundarySnapshots.get(view.id) ?? null;
      // 快照可能在**入队之后**被 resize/dispose 作废：把捕获当刻的代号带进闭包，执行当刻读实时值
      // 再比一次 —— 不一致就按「无快照」（链退回 1×1 白）走，而不是采已释放的纹理（那会把该对象
      // 整块画黑）。判据只看**真的换代**（代号变），不随段边界/帧序自增 ⇒ 排到下一帧执行的 update
      // 不受影响。
      this.enqueue(() => runner.update(
        time,
        view.rtTexture,
        item !== null && !this.snapshotStale(item.version) ? item.texture : null,
      ));
    }
    // 快照内容逐帧覆盖 ⇒ 只能本帧用：清空后下一帧无边界通知时回到 null（不跨帧持有）。
    this.boundarySnapshots.clear();
  }

  /** 画布缓冲/视口变化：`FrameCapture.resize()` 会 dispose 旧快照并重建 ⇒ 作废**尚未被 advance 消费**
   *  的本帧快照（已被 advance 带进闭包的那份，由执行当刻的实时代号比较兜底，见 advance）。 */
  notifyViewportResize(): void {
    if (this.disposed) return;
    this.boundarySnapshots.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // 丢弃尚未发起的排队任务：runner 即将被释放，再跑 update 只会碰已释放的 RT/材质。
    this.queue.length = 0;
    this.boundarySnapshots.clear(); // 快照引用属本帧，dispose 后不得再被传进 runner
    for (const entry of this.entries.values()) entry.runner?.dispose();
    this.entries.clear();
  }

  // ── 测试/诊断钩子（不参与生产路径） ──
  debugRunners(): Map<number, EffectRunner> {
    const out = new Map<number, EffectRunner>();
    for (const [id, e] of this.entries) if (e.runner) out.set(id, e.runner);
    return out;
  }
  debugInjectRunner(id: number, runner: EffectRunner): void {
    const view = this.host.isolatedObjects().find((o) => o.id === id);
    // 反向从实测 RT 像素推世界尺寸：仅在测试/诊断（entries 里没有 setWorldSize 记录）时使用。
    this.entries.set(id, {
      runner,
      chains: [],
      plan: null,
      worldW: view ? view.rtWidth / this.scale() : 1,
      worldH: view ? view.rtHeight / this.scale() : 1,
      source: null,
    });
  }

  /** 去重告警（同一 key 只打印一次，防每帧刷屏）。 */
  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[wallpaper-engine] ${message}`);
  }

  /** 串行队列入队（约束 3 / 2：只调用既有的 update，不在此建材质）。 */
  private enqueue(task: () => unknown): void {
    if (this.busy) {
      this.queue.push(task);
      return;
    }
    this.busy = true;
    this.runTask(task);
  }

  private runTask(task: () => unknown): void {
    let result: unknown;
    try {
      result = task();
    } catch (e) {
      console.warn('[wallpaper-engine] 对象效果链更新失败:', e);
      this.finishTask();
      return;
    }
    // 同步抛出的错误与 rejected promise 一样只告警不中断：单个对象的效果失败不得拖垮整条串行链
    // （其它对象与后续帧仍要继续推进）。
    Promise.resolve(result)
      .catch((e) => { console.warn('[wallpaper-engine] 对象效果链更新失败:', e); })
      .then(() => { this.finishTask(); });
  }

  private finishTask(): void {
    const next = this.queue.shift();
    if (next) {
      this.runTask(next);
      return;
    }
    this.busy = false;
  }

  /** `plan` 由调用方传入（`setObjectChains` 已按同一尺寸算过一份，且用它判定过消费者）：
   *  再算一遍会让「判定用的计划」与「执行用的计划」可能分叉。 */
  private mount(objId: number, chains: CompiledEffectPass[][], rtW: number, rtH: number, plan: EffectPlan): void {
    let entry = this.entries.get(objId);
    if (!entry) {
      // 反向从实测 RT 像素推世界尺寸（仅在 setWorldSize 未先行时兜底）；源尺寸未知 ⇒ null（回退屏占位）。
      entry = { runner: null, chains, plan: null, worldW: rtW / this.scale(), worldH: rtH / this.scale(), source: null };
      this.entries.set(objId, entry);
    }
    // setWorldSize 可能已先建条目（three-renderer 的顺序是 setWorldSize → setObjectChains），此时
    // 保留其世界尺寸，不被 RT 尺寸/密度反推覆盖。
    entry.chains = chains;
    entry.plan = plan;
    if (!entry.runner) {
      // 纹理槽按 WE 约定加载（v=0=图像顶部，与对象 RT 的 v 约定同一套，见 weVRowOrderLoader）。
      entry.runner = new EffectRunner(this.host.renderer, rtW, rtH, { load: weVRowOrderLoader() });
    }
    entry.runner.setPlan(entry.plan, chains, this.wallpaperId, { width: rtW, height: rtH });
  }
}
