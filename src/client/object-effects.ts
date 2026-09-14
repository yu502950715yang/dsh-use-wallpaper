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
import { EffectRunner } from './effect-runner.js';
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

// ══ 编排器（Task 4）═══════════════════════════════════════════════════════════
// 按对象挂效果链、每对象一个 EffectRunner、串行推进、降级跳过、resize 重算尺寸。
//
// 三条硬约束（spec §5.3 / §5.4）：
//   1. 每对象一个 runner，RT 尺寸 = 该对象 RT 尺寸：对象级效果**不得**全屏展平
//      （全屏展平会让效果漫到对象包围盒之外，是本特性的核心回归点）；
//   2. 加载期一次性建：EffectRunner 的创建与 setChains（含材质/探针编译）只发生在挂链与
//      resize；bindOutputs / advance 里**不得**创建材质或建管线；
//   3. 串行推进：同一时刻只允许一个 runner 触碰 renderer 的 RT/绑定状态——并发交错会让
//      ping-pong 写端与输入纹理错配 → 黑屏/闪烁。EffectRunner 自己的 updateInFlight 只挡得住
//      同一个 runner，挡不住多个 runner 之间，故串行化必须由本编排器承担。

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
}

// 单个隔离对象的链状态。
interface ObjectChainEntry {
  runner: EffectRunner | null;
  /** 原始链定义：resize 时用同一份链 + 新尺寸重新 setChains（EffectRunner 只在尺寸变化时重建 RT）。 */
  chains: CompiledEffectPass[][];
  /** 世界尺寸（场景像素，未乘 dpr）——resize 时用它按新预算重算 RT 像素尺寸。 */
  worldW: number;
  worldH: number;
}

export class ObjectEffectStage implements ObjectEffectStage {
  private entries = new Map<number, ObjectChainEntry>();
  private skips = new Set<string>();
  private readonly wallpaperId: string;
  private readonly dpr: number;
  private budgetWidth: number;
  private budgetHeight: number;
  private disposed = false;
  // 串行链（约束 3）：busy = 有 runner 正在 update，queue = 等待中的 update 任务。
  // 空闲时**同步**发起第一项（本帧立即开始推进，不推迟一个微任务——与场景级
  // `void runner.update(...)` 的行为一致；player 的帧序是 render 之后才 advance，
  // 因此此刻切换 RT 不会打扰本帧主场景渲染）；忙时排队，等前一项 settle 后再发起。
  private busy = false;
  private queue: Array<() => unknown> = [];
  /** 去重告警集合（`warnSkip` 之外的通用去重，按 key 只打印一次，防每帧刷屏）。 */
  private warned = new Set<string>();

  constructor(
    private readonly host: ObjectEffectHost,
    opts: { wavelengthId: string; dpr: number; budgetWidth: number; budgetHeight: number },
  ) {
    this.wallpaperId = opts.wavelengthId;
    this.dpr = opts.dpr > 0 ? opts.dpr : 1;
    this.budgetWidth = opts.budgetWidth;
    this.budgetHeight = opts.budgetHeight;
  }

  /** 世界尺寸（场景像素）：resize 时按新预算重算 RT 像素尺寸的唯一来源。
   *  调用顺序契约：three-renderer 先 setWorldSize 再 setObjectChains（后者不覆盖前者）。 */
  setWorldSize(objId: number, worldW: number, worldH: number): void {
    if (this.disposed) return;
    const entry = this.entries.get(objId);
    if (entry) {
      entry.worldW = worldW;
      entry.worldH = worldH;
      return;
    }
    this.entries.set(objId, { runner: null, chains: [], worldW, worldH });
  }

  /** 挂载某对象的效果链。调用顺序契约：player 先在 loadSceneToThree 内建好隔离条目，
   *  stage 再挂链（Task 5 的接线顺序：setWorldSize → setObjectChains）；找不到隔离条目
   *  说明契约被破坏 → 明确告警一次，绝不静默丢弃，也绝不猜尺寸。 */
  setObjectChains(objId: number, chains: CompiledEffectPass[][]): void {
    if (this.disposed) return;
    // 逐条链分类：保留线性链，跳过具名 RT 图链（整链，不硬跑——产物是错画面）。
    const usable: CompiledEffectPass[][] = [];
    for (const one of chains) {
      if (isLinearEffectChain(one)) {
        usable.push(one);
      } else {
        const label = one.find((p) => p.target)?.target ?? one.find((p) => p.bind.length > 0)?.bind[0]?.name ?? '(具名 RT)';
        this.warnSkip(label);
      }
    }
    if (usable.length === 0) return;
    const view = this.host.isolatedObjects().find((o) => o.id === objId);
    if (!view) {
      // 调用顺序契约：player 先在 loadSceneToThree 内建好隔离对象，stage 再挂链
      // （Task 5 的接线顺序：setWorldSize → setObjectChains）。走到这里说明契约被破坏——
      // 明确告警一次，绝不静默丢弃，也绝不猜尺寸。
      this.warnOnce(`no-isolated:${objId}`, `对象 ${objId} 尚无隔离条目，效果链未挂载（调用顺序错误）`);
      return;
    }
    this.mount(objId, usable, view.rtWidth, view.rtHeight);
  }

  /** 视口/预算变化：按新预算重算每个对象的 RT 像素尺寸，并用同一份链重挂（runner 内部 RT 跟随）。
   *  ⚠️ 遍历 `this.entries` 的**所有**条目（不按有无 runner 过滤）：链全被跳过、因而没有 runner
   *  的隔离对象（如具名 RT 图链）同样要随视口重设 RT，否则视口放大后它一直用旧的小 RT（偏糊）、
   *  视口缩小时又一直占着旧的大 RT（超额显存）。 */
  onViewportResize(budgetWidth: number, budgetHeight: number): void {
    if (this.disposed) return;
    this.budgetWidth = budgetWidth;
    this.budgetHeight = budgetHeight;
    for (const [id, entry] of this.entries) {
      // 世界尺寸只由 setWorldSize 确定（唯一来源）。**不要**用 view.rtWidth / dpr 反推：
      // player 的 resizeObjectRT 会回写 rtWidth/rtHeight，反推等于把「已被预算收口的 RT」
      // 当世界尺寸，是不可逆的缩小（第一轮收口后永远回不到原尺寸）。
      const size = resolveObjectRtSize(entry.worldW, entry.worldH, this.dpr, budgetWidth, budgetHeight);
      const view = this.host.isolatedObjects().find((o) => o.id === id);
      if (!view) continue;
      if (view.rtWidth === size.width && view.rtHeight === size.height) continue;
      this.host.resizeObjectRT(id, size.width, size.height);
      // 无 runner（链全被跳过，如具名 RT 图链）→ 只重设 RT，不重挂链、不回退输出。
      if (!entry.runner) continue;
      entry.runner.setChains(entry.chains, this.wallpaperId, { width: size.width, height: size.height });
      // 重挂后 runner 的 last 被清空、旧 ping-pong RT 已被 dispose，而 quad 仍绑着那张
      // 已释放的纹理（配合 bindOutputs 的「链未就绪不动输出」契约，会在整个纹理槽重载窗口内
      // 采样已 dispose 的纹理 → 静默画错）。显式回退到对象 RT 原图。
      // （view.rtTexture 在 resizeObjectRT 之后仍有效：player 用 rt.setSize 复用同一个
      //  WebGLRenderTarget，其 .texture 不变。）
      this.host.setObjectOutput(id, view.rtTexture);
    }
  }

  /** 主场景渲染之前：链有输出才切合成 quad 的采样源；没有输出（首帧未就绪 / 该对象无 runner）
   *  则**不动输出**——quad 保持采样对象 RT 原图，不黑屏（降级可见，不静默画错）。 */
  bindOutputs(): void {
    for (const view of this.host.isolatedObjects()) {
      const out = this.entries.get(view.id)?.runner?.lastOutput() ?? null;
      if (out) this.host.setObjectOutput(view.id, out);
    }
  }

  /** 主场景渲染之后：串行推进各 runner 的 update（异步，不阻塞本帧；见类头约束 3）。 */
  advance(time: number): void {
    if (this.disposed) return;
    for (const view of this.host.isolatedObjects()) {
      const runner = this.entries.get(view.id)?.runner;
      if (!runner) continue;
      runner.setAudioSpectrumSource(null); // three 主路径无音频源（spec §5.4），保持全零
      this.enqueue(() => runner.update(time, view.rtTexture));
    }
  }

  /** 被跳过的具名 RT 图链标识（按标识去重），供诊断与测试查询。 */
  rtGraphSkips(): string[] {
    return [...this.skips];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // 丢弃尚未发起的排队任务：runner 即将被释放，再跑 update 只会碰已释放的 RT/材质。
    this.queue.length = 0;
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
    this.entries.set(id, {
      runner,
      chains: [],
      worldW: view ? view.rtWidth / this.dpr : 1,
      worldH: view ? view.rtHeight / this.dpr : 1,
    });
  }

  /** 具名 RT 图链降级告警：按标识去重（同一效果被多个对象引用时只告警一次，不刷屏）。 */
  private warnSkip(label: string): void {
    if (this.skips.has(label)) return;
    this.skips.add(label);
    console.warn(
      `[wallpaper-engine] 效果需要具名 RT（P2 未实现），跳过: ${label}`,
    );
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
    // 同步抛出的错误与 rejected promise 一样只告警不中断：单个对象的效果失败
    // 不得拖垮整条串行链（其它对象与后续帧仍要继续推进）。
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

  private mount(objId: number, chains: CompiledEffectPass[][], rtW: number, rtH: number): void {
    let entry = this.entries.get(objId);
    if (!entry) {
      entry = { runner: null, chains, worldW: rtW / this.dpr, worldH: rtH / this.dpr };
      this.entries.set(objId, entry);
    }
    // setWorldSize 可能已先建条目（three-renderer 的顺序是 setWorldSize → setObjectChains），
    // 此时保留其世界尺寸，不被 RT 尺寸/dpr 反推覆盖。
    entry.chains = chains;
    if (!entry.runner) {
      entry.runner = new EffectRunner(this.host.renderer, rtW, rtH);
    }
    entry.runner.setChains(chains, this.wallpaperId, { width: rtW, height: rtH });
  }
}
