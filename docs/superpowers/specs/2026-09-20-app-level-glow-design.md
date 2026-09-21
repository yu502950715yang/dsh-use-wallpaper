# 应用级 Glow（全屏后处理）— 设计文档

- 日期：2026-09-20
- 状态：**设计已确认，待写实施计划**（**2026-09-20 订正：已实现并默认开启**，实测见 `AGENT.md` §7.1 的「应用级后处理 ⇒ 已实现」子条；本文 §3.2 / §3.4 / §3.5 / §5 各有追加式订正。**2026-09-21 再订正：默认参数由 A 档 `0.65/1.0` 改为 `0.75/0.4`** —— 用户实测旧默认在亮部多的壁纸上过曝，网格重标定的完整数据见 `AGENT.md` §7.1 同名订正子条）
- 项目根：`E:\code\dsh-use-wallpaper`
- 关联：
  - `AGENT.md` §7.1 的「**应用级后处理（WE 的「后处理 / Glow」）未实现**」条 —— 本文要弥合的就是它（含 2026-09-16 的离线可行性实验与 A 档参数、2026-09-20 的真机 GPU 验收订正）
  - `AGENT.md` §5.11（帧内禁止编译 / 建 RT）、§5.22（渲染进 RT 必须透明清屏）、§5.27（GTR 与桌面的量化对照）、§7.5（`EffectRunner` 纹理槽所有权）
  - `docs/technical-notes.md` §4（性能与显存现状）
  - `2026-09-15-three-rt-graph-executor-design.md`（对象级 RT 图执行器；**本设计刻意不复用它**，理由见 §3.3）
  - 参考实现：`research/glow-post.mjs`、`research/glow-compare.mjs`（离线实验脚本，gitignored）

## 1. 概述

`AGENT.md` §5.27 在把 GTR `3743126786` 与桌面 WE 逐区域对照后得到：**云层本身已与桌面一致（均值差 1~2/255）**，差异集中在**亮部发光** —— 云区 p99 **199 / 桌面 225**、城市灯均值 **58.3 / 桌面 63.4（差约 +5.1）**，且桌面在发丝、路灯上有明显 bloom 光晕。

成因已用四条证据锁定：那不是任何壁纸的 effect 链，而是 WE 的**应用级后处理**（`config.json` 里 `general.user.postprocessing = "enabled"` 的整帧发光）：它不在 `scene.json` 里，插件既读不到、作者也无法关闭。**影响面：所有壁纸的亮部。**

本文实现它：一个作用在**最终合成帧**上的全屏 Glow（bright-pass → 多级降采样模糊 → 加法回叠），做成**插件设置项**（应用级语义，对齐 WE 的 `general.user.postprocessing`，**不是**壁纸字段）。

**本轮范围（已与用户确认）**：
- **只覆盖 scene 壁纸**（WebGL 内后处理）；video / image / web 壁纸维持现状（不预造跨类型抽象）。
- **默认开启**，参数取离线实验的 **A 档**（`threshold = 0.65`、`strength = 1.0`）。**⚠️ 2026-09-21 订正：默认参数已改为 `0.75 / 0.4`**（旧 A 档在亮部多的壁纸上过曝，原文保留作历史记录；网格数据见 `AGENT.md` §7.1）。
- 设置面板**只加一个「光晕」开关**；阈值 / 强度走 profile `config`（与 `overlayOpacity` / `blurEnabled` / `blurRadius` / `kenBurns` 四个字段同待遇 —— README 已如实标注那四个字段没有面板控件，此处保持一致，不特殊化 Glow）。

> **2026-09-21 订正（默认参数；本文件所有 `0.65 / 1.0` 的「缺省」含义均已作废）**：**当前缺省值 = `0.65` / `0.35`（用户在真机面板上最终定档）**；其间曾按 6 张壁纸（含亮部最多的 `3789452668` 与历史基准 GTR）的 16 格参数网格取过一版保守档 `0.75 / 0.4`，那属该网格阶段的历史记录 —— 判据始终是「亮部不过曝 + 光晕仍可感」，**不是**与桌面逐像素对齐的结果（无桌面截图，`AGENT.md` §7.1 已如实标注）。改动落在 `src/client/settings.ts` 的 `DEFAULTS`、`src/host/settings.ts` 的 schema、`src/client/glow-stage.ts` 的 `GLOW_DEFAULTS` 三处。另：本稿原先写「面板只加开关」，`a854fc6` 起面板已有阈值/强度滑杆（即时生效）。

## 2. 事实基础

### 2.1 WE 侧：它是应用级设置

- 本机 `config.json`：`general.user.postprocessing = "enabled"`。（`AGENT.md` §7.1 的记录）
- 因此它**不随壁纸分发**、也不出现在 `scene.json` 中；壁纸级 `general.bloom`（`bloomstrength`/`bloomthreshold`/`bloomtint` + HDR 分支）是**另一个**东西，全库仅 3 张壁纸开启（`2454403969` / `2937346640` / `3790775478`），**不在本文范围**。
- 证据链（为何不是对象级 `bloom` 链）：① 主图 `2222222222.tex` 解出的像素里没有那道光锥；② 壁纸级 `general.bloom = false`；③ 对象级 `workshop/2822917890/bloom` 链的 `apply_mask`（R8）只有 3.17% 像素非零、位置在画面中右纵向 25–58%（跑车尾灯 / 右侧建筑），**不覆盖路灯**；④ 该链参数逐项验证正确。详见 `AGENT.md` §5.27 的 2026-09-16 订正。

### 2.2 离线可行性实验（`research/glow-post.mjs`）

算法（CPU、0–255 `sRGB` 字节域）：

1. **bright-pass**：`k = max(0, luma/255 − t) / (1 − t)`（`luma` = Rec.601 加权），按**原色相**缩放后回写到 0–255 域；
2. **1/2、1/4、1/8 三级**降采样，每级两次 box blur（半径约 4 / 6 / 8）；
3. 各级**双线性上采样等权累加**（`1/levels.length`）；
4. `out = clamp(base + glow × strength)`。

在 GTR 本机真实渲染截图（1280×720）上的三档实测（区域口径同 `AGENT.md` §5.27）：

| 档 | t / strength | 云区 p99（桌面 **225**） | 城市灯均值（桌面 **+5.1**） | 亮部 luma>200 占比 |
|---|---|---|---|---|
| **A** | **0.65 / 1.0** | 199 → **221**（达成 85%） | 57.5 → **+8.0** | 2.44% → 3.07% |
| B | 0.65 / 1.5 | → 231（123%） | → +11.7 | → 3.41% |
| C | 0.50 / 2.0 | → 251（200%） | → +18.1 | → 4.06% |

⇒ **A 档最贴桌面**（云区 p99 命中最好）；**C 档会让白底招牌整块糊成纯白**，不作默认。

⚠️ **未验证**：只测了 GTR 一张壁纸（而 WE 的 postprocessing 是全局开关）；**未与桌面逐像素对照**（桌面记录基于 1280×693 重叠区，实验用 1280×720，底部 27px 未对齐）；"各级等权"是推测，**WE 真实权重未知**（灯区偏高可能源于此）。

### 2.3 我们的帧序与层结构（插入点）

帧体（`threejs-player.ts` 的 `setAnimationLoop`，与其无 dt 的等价帧序）：

```
隔离内容 renderIsolatedContents() → stage.bindOutputs() → renderer.render(scene, camera) → stage.advance(t)
                                                                    ↑ 唯一输出到 canvas 的一步
```

⇒ **Glow 必须插在最后这一步**：把「渲染到 canvas」改成「渲染到 base RT → Glow 链 → composite 回 canvas」。

层结构（CSS 叠层，见 `background-layer.ts`）：`.wp-bg-fill`（含 canvas）→ `.wp-scene-blur`（可选模糊）→ overlay（`overlayOpacity`）→ DSH 的 DOM UI。**Glow 在 WebGL 内完成 ⇒ 天然位于 overlay 之下**，不需要改动任何层序，也不会碰到 DSH 界面。

## 3. 设计

### 3.1 架构与数据流

```
帧体：隔离内容 → bindOutputs → ┌ 未装配 glowStage：renderer.render(scene, camera)          ← 与今天逐字相同
                              └ 已装配：glowStage.apply(renderer, scene, camera)
                                                │
                          render(scene) → base RT（视口尺寸）
                                                │
                          bright-pass + ↓1/2 → L1 ─ boxH/boxV → L1
                                                │ ↓1/2 → L2 ─ boxH/boxV → L2
                                                │           ↓1/2 → L3 ─ boxH/boxV → L3
                                                │
                          上采样(L3→L2→L1→全屏)等权累加 → glow
                                                │
                          composite：clamp(base + glow × strength) → canvas
```

新增模块 `src/client/glow-stage.ts`；`threejs-player` 只加一个可选 hook；`three-renderer` 按设置装配 —— 与既有 `ObjectEffectStage` 的注入方式**完全同构**。

### 3.2 `src/client/glow-stage.ts` 接口

```ts
export interface GlowOptions {
  threshold?: number;   // 缺省 0.65；clamp 到 [0, 1)
  strength?: number;    // 缺省 1.0；clamp 到 [0, 4]
}

export interface GlowStage {
  /** 渲染 scene 到内部 base RT，跑 Glow 链，最后 composite 到当前 canvas。 */
  apply(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void;
  /** 视口 / resize：按画布缓冲尺寸重建 base 与各级 RT。 */
  resize(width: number, height: number): void;
  /** 运行期改参数（clamp 后即时生效，不重建 RT / 不重编译 shader）。 */
  setOptions(opts: GlowOptions): void;
  dispose(): void;
}

/** 建不起来（shader 编译失败 / 无法建 RT）→ 返回 null，调用方回退为无 Glow（不白屏）。 */
export function createGlowStage(renderer: THREE.WebGLRenderer, opts?: GlowOptions): GlowStage | null;

/** 纯函数（node 可测）：三级降采样 RT 的尺寸计划（L1 = 1/2、L2 = 1/4、L3 = 1/8，逐级不小于 1px）。
 *  base RT 的尺寸即调用方传入的 (width, height)，不在此返回。 */
export function glowLevelSizes(width: number, height: number): Array<{ w: number; h: number }>;
/** 纯函数（node 可测）：参数 clamp。 */
export function normalizeGlowOptions(opts?: GlowOptions): Required<GlowOptions>;
```

> **2026-09-20 订正（实现与上面的接口有两处偏离，原文保留）**：
> 1. **`createGlowStage` 的签名改为 `createGlowStage(width: number, height: number, opts?: GlowOptions)`** —— RT 与材质都是**纯 JS 对象、不需要 GL 上下文**，`renderer` 只在 `apply(renderer, …)` 时使用。创建期**只对非法尺寸**返回 `null`。
> 2. **「shader 编译失败 ⇒ 返回 null」不成立**：shader 编译 / 链接失败改为**运行期首次 `apply` 捕获并永久降级**（此后帧序回退为无 Glow），并额外挂 `renderer.debug.onShaderError` —— 因为 three 在 `LINK_STATUS === false` 时**只 `console.error`、不抛异常**，单靠 `try/catch` 抓不到。实现见 `src/client/glow-stage.ts`。

player 侧只加：

```ts
setGlowStage(stage: GlowStage | null): void;
```

帧体分支：

```ts
if (this.glowStage) this.glowStage.apply(this.renderer, this.scene, this.camera);
else this.renderer.render(this.scene, this.camera);   // 零回归路径
```

### 3.3 为什么不复用 `EffectRunner`（否掉方案 C）

`EffectRunner` 是**对象级**语义：它有对象 RT 的概念、`g_Texture0` = 对象内容、`textures[i] → g_Texture(i)`、以及 9 个 WE 内置头文件的方言层。Glow 是**应用级**（整帧），既不来自 `effect.json`，也不需要具名 RT 池 / `bind` 覆盖 / `buildEffectPlan`。硬套要引入一个"全屏假对象"的概念，并且把「应用级后处理」和「壁纸对象效果链」两套生命周期混在一个执行器里 —— 语义扭曲的代价大于多写一个模块。

**也不内联进 `threejs-player`**（方案 A 被否）：该文件已 1500+ 行（场景图 / 相机 / 粒子 / 隔离对象 / 效果链挂接），后处理的 shader 与 RT 池生命周期与帧循环不是一个层次；独立 stage 还能让纯逻辑（尺寸计划、参数 clamp）在 node 下测。

### 3.4 pass 链、颜色空间对齐与参数

**pass 清单**（只有第 1 步与第 10 步是全屏；每级用 ping-pong 两张，避免同 RT 读写）：

| # | pass | 输入 → 输出 | 尺寸 |
|---|---|---|---|
| 1 | bright-pass（含降采样） | base → L1a | 1/2 |
| 2 | boxH（半径 4） | L1a → L1b | 1/2 |
| 3 | boxV（半径 4） | L1b → L1a | 1/2 |
| 4 | 降采样 | L1a → L2a | 1/4 |
| 5 | boxH（半径 6） | L2a → L2b | 1/4 |
| 6 | boxV（半径 6） | L2b → L2a | 1/4 |
| 7 | 降采样 | L2a → L3a | 1/8 |
| 8 | boxH（半径 8） | L3a → L3b | 1/8 |
| 9 | boxV（半径 8） | L3b → L3a | 1/8 |
| 10 | **composite**（全屏 quad 一次采 4 张纹理：`base` + `L1a` + `L2a` + `L3a`，三级**等权 1/3** 由硬件双线性上采样后累加，再与 `base` 相加） | → canvas | 全屏 |

⇒ 资源 = 1 张 base RT + **6 张**小 RT（三级各一对 ping-pong），无额外累加缓冲。

尺寸规则：逐级取半、**最小 1px**（沿用 `object-range` 的收口风格），由 `glowLevelSizes` 决定并在 node 侧单测。

**⚠️ 颜色空间对齐（本设计最容易踩的一步，必须做对否则 A 档参数失效）**：

离线实验的 `0.65` 是在 **sRGB 字节域**（PNG 像素）标定的，而我们的主场景渲染进 RT 时材质输出的是**线性**值（`outputColorSpace` 只作用于渲染到 canvas 那一步）。因此 Glow shader 内必须显式对齐：

- 采样 base RT（线性）→ **手工转 sRGB** → 在该域算 `luma` / 做 bright-pass / 各级模糊与累加 → 输出前**转回线性**，与 base 相加得最终线性值；
- composite 输出到 canvas 时由 `renderer.outputColorSpace = SRGBColorSpace` 自动编码 ⇒ 与今天的显示链路一致。

> **2026-09-20 订正（颜色空间：上面这段的前提在本仓库不成立，原文保留）**：原文的前提是 `renderer.outputColorSpace = SRGBColorSpace`。但本仓库 `threejs-player.ts` **强制 `LinearSRGBColorSpace`**（three 的 `linearToOutputTexel` 恒等）、且全库纹理**未标 `colorSpace`**（采样不转换）⇒ 全链路**字节域恒等**，此时再插一次 `toSrgb(base)` 是**二次编码**（threshold 等效约 0.38 域、发光范围远超 A 档）。**实现改为链内不做任何颜色转换**（composite 直接渲到 canvas）。实测印证：云区 p99 关 **200** → 开 **224**，与离线 A 档 **221** / 桌面 **225** 吻合；关闭档的 **200** 与离线在 8bit PNG 字节域标定的 **200** 完全一致 ⇒ `0.65` 两边含义相同。教训与自查手段见 `AGENT.md` §5.32。

**RT 类型**：优先 `HalfFloatType`（bright-pass 后累加精度更稳，WebGL2 均可支持），不可用时回退 `UnsignedByteType`。**不走 `renderIntoRenderTarget()` 以外的清屏路径**（§5.22 的透明清屏语义；Glow 链内每个 pass 都是全屏覆盖写，但入口必须一致）。

**参数**：`normalizeGlowOptions` 统一 clamp（`threshold ∈ [0, 1)`、`strength ∈ [0, 4]`），缺省 ~~`0.65 / 1.0`~~ **`0.75 / 0.4`（2026-09-21 订正，见 §1）**。参数变更只更新 uniform，**不重建 RT、不重编译 shader**（§5.11）。

### 3.5 设置与装配

| 位置 | 改动 |
|---|---|
| `src/client/types.ts` | `ClientSettings` 加 `glowEnabled: boolean`、`glowThreshold: number`、`glowStrength: number` |
| `src/client/settings.ts` | `DEFAULTS` 加 `glowEnabled: true` / `glowThreshold` / `glowStrength`（**2026-09-21 起缺省值为 `0.75` / `0.4`**，原稿写的是 A 档 `0.65` / `1.0`） |
| `src/host/settings.ts` | schema 同步三个字段（缺省值一致），使 profile `config` 可覆盖 |
| `src/client/settings-section.tsx` | 只加一个「光晕」开关（写入 `glowEnabled`） |
| `src/client/three-renderer.ts` | 按 `glowEnabled` 装配：`glowEnabled ? createGlowStage(player.renderer, {threshold, strength}) : null`，随后 `player.setGlowStage(stage)`；`teardown()` 里 `stage?.dispose()`；`resize` 路径同步 `stage.resize(...)` |

**即时生效**：设置变更 → 重建或更新 stage（开关：`setGlowStage(newStage | null)`；阈值/强度：`stage.setOptions(...)`），不重启 `dsh web`。

> **2026-09-20 订正（原文保留）**：实际是「**下次 render（切壁纸）后生效**」，**不是**即时 —— `three-renderer` 的装配在**每次 `render`（加载 / 切换壁纸）时**读一次设置（`src/client/three-renderer.ts` 的 `render(id, fg)` 路径内 `await readClientSettings()` 后 `createGlowStage(...)` / `setGlowStage(...)`；调用方是 `src/client/wallpaper-controller.ts` 的每次 `select(id)`，而 `readClientSettings()` 每次现拉远端、**无缓存**），设置变更后没有「变更 → 更新 stage」的通路；真正即时要在 `index.ts` 加这条通路，超出本轮文件清单。**如实标注**：面板拨动「光晕」开关后需切换一次壁纸（或重启 `dsh web`）才看到变化，阈值 / 强度同理。同页自证用的 `__fxSetGlow` 也是靠「注入 ctx 后重渲染同一张壁纸」才生效（`research/verify-object-effects.mjs`）。
> **另注：本节上面的表格为原稿** —— 其中的旧签名 `createGlowStage(player.renderer, {threshold, strength})` 与旧失败语义「shader 编译失败 / renderer 不可用 ⇒ 返回 null」**均已作废**：**接口签名与失败语义以 §3.2 的订正为准**。

### 3.6 错误处理与零回归

- `createGlowStage` 返回 `null`（shader 编译失败 / RT 建不起来）⇒ **静默降级为无 Glow** + 一条可辨识 `console.warn`；不白屏、不中断壁纸、不触发壁纸级 preview 回退（沿用既有"效果失败一律跳过"语义）。**以 §3.2 的订正为准**（创建期只对非法尺寸返回 `null`；shader 失败在运行期首次 `apply` 捕获并永久降级）。
- `glowEnabled = false` ⇒ **不建任何 RT / shader**，帧体走 `renderer.render(...)` 那条分支 ⇒ **逐像素零回归、零额外 GPU 开销**。
- 帧内**不做**编译 / 建 RT / 建 shader（§5.11）：全部发生在装配期与 resize 期。
- RT 尺寸随画布缓冲（含 `devicePixelRatio`），与主相机 cover 口径一致；resize 时同步重建。
- 显存：base RT（视口尺寸 = 画布缓冲）+ 6 张小 RT（三级各一对 ping-pong，合计约 **0.66 × base 面积**）≈ **33 MB @3440×1440@dpr1**（RGBA8；HalfFloat 则 ×2），仅在开启时占用。

> **2026-09-20 订正（「帧内不做编译」是不实标注；上面原文保留，本条为准）**：RT 与材质对象确实在**装配期**创建，但 **three 是惰性编译** ⇒ 我们 4 个 program 实际在**首个 `apply` 帧内**编译（每次切壁纸 / 开 Glow 一次；`ObjectEffectStage` 也有同类已知停顿，见 `src/client/object-effects.ts:79`）——**编译不在装配期**。属一次性首帧停顿；验收只报中位数 / p95（见下面的 2026-09-20 订正第 2 条），**该首帧尖峰未测量**。另：首帧若 composite 链接失败，这一帧可能一次性闪黑（下一帧起永久降级为直渲），同样**未测量**。**不为它加 `prewarm`**（本轮非目标）。

## 4. 非目标

- **不做** video / image / web 壁纸的 Glow（类型不同、机制不同，未预造抽象）。
- **不做**壁纸级 `general.bloom`（`bloomstrength` / `bloomthreshold` / `bloomtint` / HDR 分支；全库 3 张），语义与本文的应用级 Glow 不同。
- **不做** HDR / 色调映射 / 色彩分级；不做 `glowTint`。
- **不做**设置面板的阈值 / 强度滑块（走 `config`）。
- **不改** `wasm` / `scene-renderer` 备用路径。
- **不做**显存 cap 与自适应降级（若实测显存压力大，另开一题）。

## 5. 测试与验收

**单测（node，`tests/glow-stage.test.ts`）**
- `glowLevelSizes`：常规视口、极窄/极矮视口（逐级不小于 1px）、非 2 的幂尺寸。
- `normalizeGlowOptions`：缺省、越界 clamp（`threshold = 1` / 负值、`strength` 上限）、非法值（`NaN`）回退缺省。
- `createGlowStage` 在 renderer/shader 不可用时返回 `null`（mock 编译失败）。
- `glowEnabled = false` 时**不创建**任何 RT（以 mock renderer 计数断言）。

**端到端（真 GPU，复用本轮建好的 `--gpu` 档与 `lumaStats`）**
- GTR `3743126786`：开 / 关两帧的**云区 p99** 与**亮部占比**；判据 = 开启后云区 p99 由 ~199 升至 **≥215**（对齐离线 A 档的 221，桌面 225）。

> **2026-09-20 订正（判据口径与注入方式，原文保留）**：
> 1. 判据的 p99 是**云区**口径（区域 **`[0,0,576,242]`**，见 `AGENT.md` §5.27），**不是全屏 p99** —— 本机复算 GTR **全屏** p99 关 245 → 开 255（Δ=10，**会误判为未达标**）；全屏 p99 在 Glow 开启后整体钉在 255、**失去鉴别力**（既有 `[5]` 判据因此由 1 PASS + 2 FAIL 变 3 FAIL；**不是 bloom 失效**）。
> 2. 开 / 关对照**不能**靠页内开关跨 `runPage`：**导航会重置模块态** ⇒ 注入的 ctx 丢失、两次都退回 `DEFAULTS.glowEnabled = true`（两次都变成同一档）。必须在**创建 renderer 之前**经 **URL 参数注入 `setSettingsCtx`**。
> 3. 实测结果（真机 RTX 3060 / ANGLE D3D11，壁纸只测 GTR 一张）：云区 p99 **关 200 → 开 224（Δ = +24）**，四次独立测量零差异；离线 A 档 221 / 桌面 225。**未与桌面 WE 逐像素对照**（无同机同刻桌面截图）。
> 4. **「199」与「200」的关系（勿误读为矛盾）**：本节判据里的 `~199`（§1 引用的 §5.27 桌面对照那轮）与本条实测的「关 **200**」是**两次不同时间的「改动前」采集** —— 口径 / 时点不同，**并非矛盾**；`AGENT.md` §5.27 与 §7.1 同此说明。
- **零回归**：`glowEnabled = false` 时与改动前的同相位帧**逐像素一致**（差分仅剩时间相位与噪点口径）。
- **性能**：开 / 关的每帧 `renderer.render` 提交耗时与帧间隔对比（RTX 3060 @3440×1440、1080p；`AGENT.md` §7.1 的代理判据口径），确认退化可忽略。
- `lib/` + `dist/` 重建后跑；既有 15 项失败**逐项不变**。

> **2026-09-20 订正（上面这几条验收的实际口径，原文保留；§3.6 与下面「验收门槛」第 2 条的「逐像素零回归」同此口径）**：
> 1. **「逐像素一致」测不到**：GTR 是时间驱动壁纸（云滚动 / 发丝 sway / 粒子），拿不到「同相位帧」；改用可操作口径 —— 与改动前真机截图的差 **1.6~6.1% / maxΔ 11~23**，**远小于同一运行内的帧间噪声地板**（16.2~16.4% / maxΔ 126~140）。**逐项零回归**则成立：GL 纹理 / 程序数 **28/17**、每帧 `render` 调用 **38.0** 与改动前逐项相同。**勿**把它引用为「逐像素一致」。
> 2. **性能只在 1280×720 测过**（每帧 CPU 侧 `renderer.render` 提交 **+0.1~+0.4 ms** = 16.7ms 帧预算的 **0.6~2.4%**），**未在 3440×1440 / 1080p 复测**，且**不含 GPU 时间**（真 GPU 光栅化异步）。
> 3. 上面「既有 15 项失败逐项不变」本轮复核：已跑的第二组 14 项（`scene-renderer` **6** / `wasm-renderer` **7** / `dom/bootstrap.dom` **1**）**逐项相同**；`verify-real-library` 的 1 项因太慢未跑。受影响模块的 5 个文件 **213 项全绿**。

**验收门槛**
1. 开启后亮部提升方向与幅度符合离线 A 档（云区 p99 ≥ 215）。
2. 关闭后逐像素零回归。
3. 每帧 GPU 开销可忽略（提交耗时仍在预算 33.3ms 的个位数百分比内）。
4. 画面不出现 C 档那种"白底招牌糊成纯白"。

## 6. 风险与遗留

- **参数未与桌面逐像素对照**：离线实验只对齐了区域统计（云区 p99 / 灯区均值），且"各级等权"是推测、WE 真实权重未知 ⇒ **落地后需用桌面截图再校准一次**（需要用户提供桌面 WE 截图）。
- **A 档的灯区偏亮**（+8.0 vs 桌面 +5.1）：高光密集画面可能比桌面更亮；若实际观感偏亮，先调 `strength`（config 可改，无需改码）。**⚠️ 该风险已实际发生（2026-09-21 用户实测）**：旧 A 档在亮部多的壁纸上 `luma>200` 占比 ×1.5、纯白占比 41× ⇒ 默认已下调为 `0.75 / 0.4`（§1 订正）。
- **颜色空间对齐是正确性关键**（§3.4）：若实现时域搞错，`threshold` 的语义会整体偏移（线性域的 0.65 ≈ sRGB 域的 0.83），表现为"几乎不发光"。端到端 p99 判据就是用来抓这个的。
- **高 dpr / 大视口的显存**：base RT 随画布缓冲（= CSS 尺寸 × dpr）线性增长 —— 3440×1440@dpr1 约 20 MB、@dpr1.5 约 45 MB、3840×2160@dpr1 约 33 MB（RGBA8；HalfFloat 翻倍），另加约 0.66×base 的小 RT。开启后需实测；必要时按 `object-range` 的收口方式设定上限。
- **跨类型语义缺口（如实标注）**：WE 的 postprocessing 对 video 壁纸同样生效，我们本轮只做 scene ⇒ **video / image / web 壁纸的亮部仍与桌面有差**。这是本轮**有意接受**的范围裁剪，不是遗漏。
