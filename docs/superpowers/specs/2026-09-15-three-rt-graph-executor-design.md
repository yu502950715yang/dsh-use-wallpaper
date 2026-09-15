# three.js 主路径「具名 RT 图执行器」（P2）— 设计文档

- 日期：2026-09-15
- 状态：**设计已确认，待写实施计划**
- 项目根：`E:\code\dsh-use-wallpaper`
- 关联：
  - `2026-09-14-three-object-effects-pipeline-design.md`（对象级效果链 P1；本文补它显式留给 P2 的「具名 RT 图链」）
  - `2026-08-25-wasm-object-effect-chains-design.md`（wasm 侧的 RT 图实现；**本文不移植其绑定语义**，理由见 §2.3）
  - `AGENT.md` §2.1（渲染路径）、§5.6/§5.11/§5.16/§5.17/§5.19/§5.22（混合、加载期编译、槽编号、分辨率 uniform、RT wrap、透明清屏）、§5.27（GTR 云与桌面 bloom 的量化对照）、§7.1（本文要消除的能力差）

## 1. 概述

three 主路径 P1 已接通对象级效果链，但 `effect.json` 里带**具名 RT**（`passes[i].target` / `passes[i].bind` / 顶层 `fbos` 降采样）的链被**整条跳过 + 去重告警**（`object-effects.isLinearEffectChain`、`rtGraphSkips()`），因为 P1 的执行器只做 `pickWriteTarget` 的线性 ping-pong，无法表达"写到指定中间缓冲 / 从指定缓冲采样"。

全库 24 条这类链（`blurprecise×13、blur×3、localcontrast×2、godrays×2、bloom×2、shine×1、bokeh_blur×1`）对应 README 里"模糊、泛光、光轴、局部对比度暂不支持"，也是 `AGENT.md` §5.27 记录的"GTR 云与桌面 WE 唯一的可见差异（亮部 bloom 光晕）"的根因。

本文把 `EffectRunner` 升级为**通用 RT 图执行器**：线性链成为它的特例（逐位等价，零回归），具名 RT 链按 WE/lwe 的真实语义执行。

**非目标**：不改 wasm 路径；不做 text 对象渲染（4+3 条链挂在 text 上，管线支持但看不见）；不做音频；不做 `_rt_FullFrameBuffer`（全帧缓冲）的完整语义；不做显存 cap 收口。

## 2. 事实基础

### 2.1 全库 24 条链 = 7 类模板（2026-09-15 实测）

扫描脚本：`research/scan-rt-graph-full.mjs`（输出 `research/rt-graph-scan.log`）。总账：**RT 图链 24 条 / 线性链 106 条 / 解析失败 0 条**。

| 模板 | 条数 | pass 数 | 具名 RT | scale |
|---|---|---|---|---|
| blurprecise | 13 | 2 | `_rt_FullCompoBuffer1` | 1 |
| blur | 3 | 4 | `_rt_QuarterCompoBuffer1/2` | 4 |
| localcontrast | 2 | 4 | `_rt_QuarterCompoBuffer1/2` | 4 |
| godrays | 2 | 5 | `_rt_HalfCompoBuffer1/2` | 2 |
| shine | 1 | 5 | `_rt_HalfCompoBuffer1/2` | 2 |
| bloom | 1 | 4 | `_rt_buffer1/2` | 4 |
| bokeh_blur | 1 | 5 | `_rt_downscaled1/2`、`_rt_coc` | 4 |
| bloom（GTR 变体） | 1 | **16** | `blur_start_2/4/8/16`、`blur_end_2/4/8/16`（**fbos 声明 scale=2/4/8/16 且 `unique:true`**；名字**不带 `_rt_` 前缀**） | 2 / 4 / 8 / 16 |

合计 13 + 3 + 2 + 2 + 1 + 1 + 1 + 1 = **24**（bloom 共 2 条：一条 `_rt_buffer` 型、一条 GTR `blur_*` 型）。

模板形态（`effect.json` 原文，`bind` 为 `[{index, name}]`）：

- blurprecise：`p0 target=_rt_FullCompoBuffer1 bind=[]`；`p1 target=∅ bind=[0:_rt_FullCompoBuffer1, 1:previous]`
- blur / localcontrast / bloom：`p0 target=Q1 bind=[0:previous]`；`p1 target=Q2 bind=[0:Q1]`；`p2 target=Q1 bind=[0:Q2]`；`p3 target=∅ bind=[0:Q1, 2:previous]`
- godrays / shine：同上但多一个中间 pass，末 pass `bind=[0:RT, 1:previous]`
- bokeh_blur：5 pass / 3 张 RT，`bind` 同时出现 `index 1`（`_rt_coc`）与 `index 2`（`_rt_coc`）
- GTR bloom：16 pass 交替写 `blur_start_*`/`blur_end_*`，末 pass `bind=[0:blur_start_2, 2:previous]`

其它事实：

- `fbo.format` 全库只有 `rgba8888` 与 `rgba_backbuffer`；`fbos[].unique` 与 `passes[].command` 全库 **0 处**；
- **具名 RT 清单按 `target` 建立、`fbos` 只提供 `scale`**（不按 `fbos` 建）：`fbos` 可能是**超集**（声明了却没有任何 pass 使用的条目不该建 RT），而 `target` 才是「谁会被写」的权威。（**实现期订正 2026-09-15**：本节早先写「GTR 的 bloom 声明了 `_rt_buffer1/2` 却把 target 改成 `blur_start_*`、两者不一致」——那是本计划扫描脚本的误读；实测原文是该链 `fbos` 就声明了 `blur_start_2/end_2(scale 2)`、`_4(4)`、`_8(8)`、`_16(16)`（`format: rgba_backbuffer`、`unique: true`），与 16 个 pass 的 target 完全一致。另：`_rt_buffer1/2` 这个命名**确实存在于本库**（`2911105183` obj58 的 bloom 链，挂 util 对象，与 GTR 那条无关）——本行早先写的「全库 0 命中」是对诊断报告的误读。规则本身不变。）
- `textures[0]` 非空的 pass **0 处**；`bind` 与 `textures` 同 index 冲突 **6 处**（全在 RT 图链上，例：`shine` p4 的 `textures[1]="_rt_imageLayerComposite_13_b"` 被 `bind[1]=previous` 覆写）；`bind.index >= textures.length` **77 处**（靠 shader 声明的槽位补齐，`effectSlotCount` 已实现）；
- `textures[]` 里的 `_rt_*` 引用：`_rt_imageLayerComposite_<id>_a/_b` **6 处全部被 `bind` 覆写**（无需处理）；`_rt_FullFrameBuffer` **1 处未被覆写**（`2597392171 obj50` godrays p4 slot2）⇒ 进入降级清单（§6）。线性链里 `_rt_*` 槽引用 **0 处** ⇒ P1 线性路径无同类既有缺陷；
- scene.json 覆写 `bind` / `target` 全库 **0 处** ⇒ `resolveEffectChain` 现解析出的 `target`/`bind` 可直接消费，无需扩解析；
- effect 级 `visible === false` 全库 **1 条**（`2597392171 obj50` 的 `effects/shake`）；
- 挂多条链的对象 24 个（2 / 3 / 4 / 6 / 8 / 10 / 11 条），最多 11 条。

### 2.2 权威语义（lwe C++，逐条证据）

| # | 语义 | 证据 |
|---|---|---|
| 1 | **`bind` 的 `index` 就是纹理单元号 = `g_Texture<index>`** | `CPass::bindTextureOverrides`（`CPass.cpp:288-326`）按 `m_textures` 的 `index` 调 `bindTextureUnit(index, …)`；`setupTextureUniforms`（`:824-831`）把 `g_Texture0..7` 依次绑到单元 0..7。另有 `EffectParser::parseBinds`（`EffectParser.cpp:82-97`）保留 `index`。模板 B 的 `bind[2]=previous` 只有在"index = g_Texture2"下才与 shader 声明对得上 |
| 2 | **`bind` 优先于 `textures`** | `CImage` 初始化段：`m_override.usertextures` 先填 `m_textures[index]`（`CImage.cpp:791-807`），`m_binds` 其后填同一 map（`:809-819`，注释 *binds are set last as they're the most important to be set*） |
| 3 | **`name === "previous"` → `m_previousInput ?: (previous ?: expected)`** | `CPass::resolveTexture`（`CPass.cpp:86-109`）：先按 index 找 `m_fbos`，再按 index 查 `m_binds`；`"previous"` 返回 `m_previousInput`，缺失则回落到 `previous`（调用方传入的当前读端） |
| 4 | **`m_previousInput` = 进入 target 序列前的输入**（不是"上一 pass 输出"） | `CImage::setupPasses`（`CImage.cpp:784-852`）：`configurePassTarget`（`:863-890`）在**首次遇到带 target 的 pass**时记 `effectInput = asInput`；每个 pass `setPreviousInput(inTargetEffectSequence ? effectInput : nullptr)`（`:834`）；序列收尾（遇到无 target 的 pass）时 `inTargetEffectSequence = false; effectInput = nullptr`（`:848-849`） |
| 5 | **序列内写 target 后，当前内容提供者切换为该具名 RT** | `CImage.cpp:842-844`：`if (writesToTarget) { asInput = drawTo; drawTo = prevDrawTo; }` |
| 6 | **具名 RT 尺寸 = 对象尺寸 ÷ `scale`**；缺省 scale = 1 | `FBOProvider::create`（`FBOProvider.cpp:9-16`）：`size.x / base.scale`；`EffectParser::parseFBOs`（`:99-118`）`.scale = cur.optional("scale", 1.0f)` |
| 7 | **FBO 池的作用域 = 单条 effect 链** | `CImage::setupPasses`（`CImage.cpp:649-654`）：每条 effect 新建 `FBOProvider` 并为该 effect 的 `fbos` 建 RT；`configurePassTarget` 用 `pass->getFBOProvider()->find(target)`（`:872`） |
| 8 | **具名 RT 创建时清成透明黑** | `CFBO` 构造（`CFBO.cpp:61-63`）：`glClearColor(0,0,0,0); glClear` |
| 9 | **`format` 字符串被忽略**（硬编码 ARGB8888） | `FBOProvider::create`（`FBOProvider.cpp:11-13`）带 `// TODO: PROPERLY DETERMINE FBO FORMAT BASED ON THE STRING`，实参恒 `TextureFormat_ARGB8888` |
| 10 | **不可见 effect 整条跳过** | `CImage.cpp:643-647`：`if (!cur->visible->value->getBool()) continue;` |
| 11 | **`blending: normal` = 覆盖（`ONE/ZERO`）** | `CPass::setupRenderFramebuffer`（`CPass.cpp:138-141`）；与我方 §5.25 已对齐 |

### 2.3 与 wasm 备用路径的差异（刻意不移植）

`wasm/src/render/effect.rs` 已有一版 RT 图执行器（`named_rt` 池 + 按 `fbo_scale` 降采样，`effect.rs:1074-1090`），但它的**绑定语义与 lwe 不符**：

- `resolve_pass_read`（`effect.rs:1286-1303`）**只取 `bind[0]`** 决定唯一读端，其余槽按 `texture_slots` 绑白色占位（`:1312-1350`）；
- 注释把它记作 "bind[i] 与 shader 的 `g_Texture(i+1)` 槽对齐"（`effect.rs:877-879`）——按 §2.2 #1，权威语义是 `g_Texture<index>`。

⇒ 本文**只参考其"具名 RT 池 + 尺寸除以 scale"的骨架**，绑定与序列语义一律按 lwe 实现。wasm 路径未接入运行时，本次不改动它，其偏差记入 `AGENT.md` §7（备用路径条目）。

### 2.4 可见性事实（影响验收预期）

24 条链按挂载对象类型：**7 条挂在 `text` 对象上**（`3765967112` 的 obj 71/79/89/117 各 1 条 blurprecise、`3789452668` 的 obj 80/87/95 各 1 条）、**3 条挂在 `util` 对象上**（`2597392171` obj54 的 blur、`2911105183` obj58 的 bloom 与 bokeh_blur），而这两类对象在 P1 就不参与渲染（`object-range.groupEffectsByObject` 跳过 text；util 无几何）⇒ **画面变化只在其余 14 条上可见**：

`2011060960`(=blur+localcontrast)、`2132420420`(=localcontrast)、`2897292240`(=blur)、`1968789468`(=shine)、`2937346640`(=godrays)、`2597392171 obj50`(=godrays)、`2911105183`(5×blurprecise)、`3789452668 obj17`(=blurprecise)、`3743126786`(=GTR bloom)。

## 3. 架构与模块划分

```
resolveEffectChain（解析，不改）
   └─► buildEffectPlan(chains, {baseWidth, baseHeight})    ← 新增纯函数；**加载期算一次**
          └─► EffectRunner.setPlan(plan, {width, height})   ← 加载期建具名 RT + 材质 + 探针编译
                 └─► 每帧 update(time, input)：查表绑槽 / 选写端 / 提交 pass
```

帧内**只查表 + 写 uniform + 提交 pass**：不新建材质、不建 RT、不做分配（`AGENT.md` §5.11 硬约束）。

**新增 `src/client/effect-graph.ts`（纯函数，node 可测）**

```ts
export type RtSource =
  | { type: 'previous' }             // 序列起点输入（lwe effectInput）；不在序列中时回落到该槽默认
  | { type: 'named'; key: string };  // 链内具名 RT（key 含链序号）

export type RtWrite =
  | { type: 'named'; key: string }
  | { type: 'pingpong' }
  | { type: 'final' };

export interface PlannedPass {
  chainIndex: number;
  passIndex: number;                 // 链内下标；执行器用 chains[chainIndex][passIndex] 取材质信息
  bindings: Array<{ slot: number; source: RtSource }>;  // **只含 bind 覆盖项**：slot = g_Texture<slot>
  write: RtWrite;
  blendMode: string;
  /** 该 pass 的 target 名（诊断用） */
  target?: string;
  /** bind 引用了链内不存在的 RT（降级：保持默认来源 + 告警） */
  unresolvedBinds?: string[];
}

export interface EffectPlan {
  /** 具名 RT 清单（key 已带链序号），尺寸 = base ÷ scale */
  namedTargets: Array<{ key: string; name: string; width: number; height: number }>;
  passes: PlannedPass[];
  /** 因超限而整体放弃的链序号（诊断 + 告警） */
  droppedChains: number[];
}

export function buildEffectPlan(
  chains: CompiledEffectPass[][],
  opts: { baseWidth: number; baseHeight: number },
): EffectPlan;
```

> 接口口径：`bindings` **只承载 `bind` 的覆盖项**；未被覆盖的槽由执行器按既有默认语义处理（slot 0 = 当前内容提供者、slot j≥1 = `textures[j]` / 空槽兜底），因此不需要"默认来源"类型。`passIndex` 让执行器按 `chains[chainIndex][passIndex]` 取回 `CompiledEffectPass`（`droppedChains` 会使 `plan.passes` 与 `chains.flat()` 下标错位，故不能用平坦下标对齐）。

**`src/client/effect-runner.ts`（改）**：新增 `setPlan(plan, opts)`；`update` 按 `plan.passes` 执行；持有 `namedRt: Map<key, WebGLRenderTarget>`。旧 `setChains(chains, id, opts)` 保留（未接入的 `scene-renderer.ts` 仍在用），内部委托为"无具名 RT 的退化计划"，线性行为逐位不变。

**`src/client/object-effects.ts`（改）**：删除 `isLinearEffectChain` 的整链跳过与 `rtGraphSkips()`；所有可见链都挂载；挂载前过滤 `visible === false` 的 effect（窄谓词，不动 `types.ts` 的 `unknown[]`）。

**`src/client/three-renderer.ts`（改）**：删除 `rtGraphOnly` 分支及其"链全为具名 RT 图链时不再隔离"的优化；isolate 准入由「至少有一条线性链」改为「至少有一条**可见**链」。原先因全为具名 RT 链而不隔离的对象（样本 `2132420420` obj13）会重新进入隔离路径，付出对象 RT 显存与每帧一次额外渲染，换来效果生效。

### 3.1 三个关键决策

1. **具名 RT 的命名空间 = 单条链**（key = `${chainIndex}:${name}`），依据 §2.2 #7。同一对象的两条链用同名 RT（如 `2011060960 obj634` 的 blur 与 localcontrast 都用 `_rt_QuarterCompoBuffer1`）时各持一份；跨对象更不共享。
2. **`previous` = 进入 target 序列前的输入**，依据 §2.2 #4。**不是**"上一 pass 输出"：模板末 pass 的 `bind[1|2]=previous` 拿的是**原始对象内容**，若按"上一 pass 输出"实现，合成基底会变成自己的模糊结果。
3. **`bind.index` = `g_Texture<index>`**，依据 §2.2 #1。

## 4. 执行语义

### 4.1 槽位优先级

**`bind[index]` > `textures[index]` > 默认来源**（依据 §2.2 #2）。

- `index = 0` 默认 = 当前内容提供者（链首 = 对象 RT 原图；链内 = 上一 pass 输出 / 上一个被写的具名 RT）；
- `index ≥ 1` 默认 = `textures[index]` 解析出的纹理；未提供时按既有 `resolveSlotFallback` 的空槽语义（`opacitymask`→黑、`flowmask`→中灰、无 mode→不预置）。

`textures[0]` 全库为空 ⇒ 该优先级与 P1 行为在 index 0 上一致。

### 4.2 计划构造规则

1. **具名 RT 清单**：逐链遍历 `passes[i].target`，去重建表。尺寸 = `max(1, round(baseWidth / scale))`（`baseWidth` = 对象 RT 像素宽），`scale` 取 `pass.fboScale[name]`，缺省 / ≤0 = 1（**实现期订正**：全库实测的 `target` 都在 `fbos` 里有声明；「声明了却没被任何 `target` 用到」的条目**不建 RT**，故清单以 `target` 为准）。对象 RT 已钳在 4096，除以 scale 只会更小，无需二次钳制。`format` / `unique` 不消费（§2.2 #9）。
2. **key 加链序号**：`${chainIndex}:${name}`。
3. **序列状态机**（逐链独立）：

```
inSeq = false; effectInput = null; current = 输入纹理
for each pass in chain:
  writesNamed = pass.target 非空 且 在具名 RT 表中
  if writesNamed && !inSeq: inSeq = true; effectInput = current          // §2.2 #4
  write = writesNamed ? named(key) : (是本条计划最后一个 pass ? final : pingpong)

  // 读端：未被 bind 覆盖的槽由执行器按既有默认语义处理（slot 0 = current、slot j = textures[j]/空槽兜底）
  bindings = []
  对每个 bind[{index, name}]:
     name === 'previous' → bindings.push({ slot: index, source: previous })   // §2.2 #3（运行时回落该槽默认）
     name 在具名 RT 表中   → bindings.push({ slot: index, source: named })     // §2.2 #1
     否则                 → 不 push（保持该槽默认）+ 记入 unresolvedBinds（§6 告警）

  current = writesNamed ? 该具名 RT 纹理 : 本 pass 输出纹理                 // §2.2 #5
  if (!writesNamed && inSeq): inSeq = false; effectInput = null             // §2.2 #4
```

4. **写端三态**：`named`（写具名 RT）/ `pingpong`（写 `rtA`/`rtB` 对端，沿用 `pickWriteTarget`）/ `final`（本计划最后一个 pass；对象隔离路径下同为 pingpong 写端，其纹理经 `lastOutput()` 交给合成 quad）。若最后一个 pass 写具名 RT，则 `lastOutput()` = 该具名 RT 纹理（全库无此形态，但语义需确定）。
5. **线性链退化**：无 `target`、`bind` 全空时（全库 106 条线性链皆如此），计划退化为"`bindings` 全空、写端全 `pingpong`（末 pass `final`）"——执行器因此走 P1 的默认读端与 ping-pong 路径，这是零回归的判据（§7.1 有对应断言）。
6. **RT 数量软上限**：单链具名 RT > 16 张 ⇒ 该链进 `droppedChains`（整链不挂，对象正常显示无效果）+ 一条告警。全库最多 8 张。

### 4.3 三类模板走查（base = 1000×600）

**blurprecise（2 pass，scale=1）** — `_rt_FullCompoBuffer1` = 1000×600

| pass | 读 | 写 | 序列 |
|---|---|---|---|
| p0 | `g_Texture0` = 对象RT（`bind=[]`） | named `_rt_FullCompoBuffer1` | 进序列，effectInput = 对象RT |
| p1 | `g_Texture0` = `_rt_FullCompoBuffer1`；`g_Texture1` = previous = **对象RT** | pingpong | 收尾 |

**blur / localcontrast（4 pass，scale=4）** — `_rt_QuarterCompoBuffer1/2` = 250×150

| pass | 读 | 写 | 序列 |
|---|---|---|---|
| p0 | `g_Texture0` = 对象RT（previous 兜底） | named Q1 | 进序列，effectInput = 对象RT |
| p1 | `g_Texture0` = Q1 | named Q2 | — |
| p2 | `g_Texture0` = Q2 | named Q1（覆盖写） | — |
| p3 | `g_Texture0` = Q1；`g_Texture2` = previous = **对象RT** | pingpong | 收尾 |

**GTR bloom（16 pass，8 张降采样 RT）** — 尺寸 = 1000×600 ÷ scale（2/4/8/16）

| pass | 读 | 写 | 序列 |
|---|---|---|---|
| p0 | `g_Texture0` = 对象RT（previous 兜底） | named `blur_start_2` | 进序列，effectInput = 对象RT |
| p1–p14 | 交替读上一张、写另一张（`blur_end_2 → blur_start_2 → blur_start_4 → …`） | named | — |
| p15 | `g_Texture0` = `blur_start_2`；`g_Texture2` = previous = **对象RT** | pingpong | 收尾 |

godrays / shine（5 pass，scale=2）与 bloom（4 pass，scale=4）分别同上述第二、三类的形态变体；bokeh_blur 是唯一 `bind` 同时含 `index 1`（具名 RT）与 `index 2`（具名 RT）的，规则已覆盖。

## 5. 资源与生命周期

| 时机 | 动作 |
|---|---|
| 加载期 `setPlan` | 按计划一次建齐 `namedRt`（尺寸 = `对象RT / scale`），随后照旧建材质与探针编译 |
| `onViewportResize` | 现有契约已对每个条目重调 `runner.setChains(...)`（对象 RT 尺寸变化）⇒ 具名 RT **等比重建**（先 dispose 旧的）。绝不逐帧重建 |
| 换壁纸 / `dispose()` | 释放全部具名 RT，与 `rtA`/`rtB` 同处收口 |

**尺寸基准只有一个**：对象 RT 像素尺寸（已是 `|world| × screenScale` 收口到 4096 的结果）。不引入第二套预算口径 —— §5.21 那次"挂载期对、resize 后被覆盖"的漏检正是"两处各算一份预算"造成的。

三个沿用既有约定的点：

1. **清屏**：写具名 RT 照旧走 `renderIntoRenderTarget`（透明清屏，§5.22）。与 lwe 的 `LoadOp::Load` 有差异，但模板里写具名 RT 的 pass 全是全屏覆盖写、blending 为 `normal`（`ONE/ZERO`）⇒ 清与不清结果相同；改成"保留"要动 renderer 级 `autoClear` 并波及线性路径，不做。实施时用计划里的 `blendMode` 复核全库"写具名 RT 的 pass"是否都在 `{normal, unknown}` 上，有例外则记入 `AGENT.md` §7。
2. **filter/wrap**：RT 默认 `LinearFilter` + `ClampToEdgeWrapping`，与 lwe 的 GL 默认一致，符合 §5.19「RT 纹理必须保持 CLAMP」。
3. **分辨率 uniform 自动正确**：具名 RT 作为读端时，`resolveTextureResolution4` 取 RT 纹理自带的 `image.{width,height}`，且因无 `userData.fxRes` 而按 lwe 约定视作 `(w, h, w, h)` ⇒ 降采样 RT 的 `g_TextureNResolution` 自动是降采样后的尺寸，无需额外接线。

### 5.1 显存账（1080p 满屏对象、RGBA8）

| 模板 | 具名 RT | 单链额外显存 |
|---|---|---|
| blurprecise（13 条，scale=1） | 1 张全尺寸 | 8.3 MB |
| godrays / shine（3 条，scale=2） | 2 张 ½ | 4.2 MB |
| blur / localcontrast / bloom（7 条，scale=4） | 2 张 ¼ | 1.0 MB |
| bokeh_blur（1 条，scale=4） | 3 张 ¼ | 1.6 MB |
| GTR bloom（1 条，scale=2/4/8/16 各 2 张） | 2 张 ½ + 2 张 ¼ + 2 张 ⅛ + 2 张 1/16 | **约 5.5 MB** |

⇒ **单张壁纸最大约 +8.3 MB（blurprecise 的全尺寸单张），典型 < 10 MB**（**实现期订正 2026-09-15**：早先按「GTR 的 8 张是全尺寸」估出 +66.4 MB，实测该链 `fbos` 声明了 scale=2/4/8/16 ⇒ 合计约 5.5 MB；1080p 满屏口径）。参照系：现有对象 RT 口径 1080p@dpr1 全库合计 530 MB、单壁纸最大 131.8 MB。

**本期不做显存 cap**（不做"超预算降 scale"）：全库只有一个大头，且收口会改变画面（模糊半径的像素尺度依赖 RT 分辨率），属"为省显存牺牲正确性"的取舍，应由使用者在看到真机数字后决定。落点已留在 `buildEffectPlan` 的尺寸计算处，将来要 cap 只改那一处 + 对应 oracle。本期义务是**测量并如实记录**：把 `research/q-rt-vram-sweep.mjs` 的估算口径扩上具名 RT，结果写进 `AGENT.md` §7。

### 5.2 所有权

- `namedRt` 归 `EffectRunner`（与 `rtA`/`rtB` 同层）；`setPlan` 重建前先释放旧的一批；
- 具名 RT 纹理可能被 `bindOutputs` 交给合成 quad（仅当末 pass 也写具名 RT），resize 重建后 quad 会持旧纹理 ⇒ 沿用 P1 处理：`onViewportResize` 重挂后显式 `setObjectOutput(id, view.rtTexture)` 回退到对象 RT。

## 6. 错误处理与降级

| 情形 | 处置 |
|---|---|
| `bind` 引用链内不存在的具名 RT（全库 1 处 `_rt_FullFrameBuffer`） | 该槽**回落到默认来源** + 去重告警一次（带壁纸 id / 对象 id / RT 名 / 槽位）。依据 §2.2 #3 的回落语义与 `resolveFBO` 只报错不崩 |
| **写具名 RT 的 pass** 编译失败 | **整条计划放弃**（含后续链：它们的输入已不可信），输出回退对象 RT 原图。P2 新引入的风险点 —— 派生读端会读到空 RT（透明黑），P1 那套"跳该 pass、读端不变"在 RT 图上不成立 |
| 普通（pingpong）pass 编译失败 | 沿用 P1：跳该 pass、读端不变（仍然安全） |
| 单链具名 RT > 16 张 | 该链进 `droppedChains`，不挂载（对象正常显示、无效果）+ 一条告警 |
| effect 级 `visible === false`（全库 1 条） | 该 effect 整条不挂链（§2.2 #10），**不打告警**（作者正常内容，不是降级） |
| 链解析失败 / 全部 pass 失败 | 沿用 P1：该效果不挂链，画面回对象 RT 原图 |

以上每条降级都不得静默：要么有可辨识告警（含壁纸 id / 对象 id / RT 名 / 槽位），要么是"作者意图内"的正常路径（不可见 effect）。

## 7. 测试策略与验收

### 7.1 纯函数（新增 `tests/effect-graph.test.ts`，node）

- **具名 RT 清单**：名字去重、`scale` 缺失 / 0 / 负 / 小数、`target` 出现但 `fbos` 未声明照建、取整与下限 1、key 带链序号、**两条链同名 RT 各持一份**；
- **序列状态机**：`effectInput` 在序列起点捕获、收尾清空、`previous` 在序列内 = effectInput 而序列外 = 该槽默认；
- **槽位优先级**：bind > textures > 默认；index 0/1/2；`bind.index >= textures.length`（77 处形态）；
- **写端三态**：`named` / `pingpong` / `final`；末 pass 带 target 的情形；
- **不可解析 bind** → 回落默认 + `unresolvedBinds`；
- **线性链退化（零回归判据）**：对 106 条线性链（其 `bind` 全为空，见 §2.1），计划必须满足"`bindings` 全为空、写端全为 `pingpong`（末 pass 为 `final`）"；
- fixture 用全库 7 类模板的真实 JSON 抽最小形态。

### 7.2 执行器（扩 `tests/effect-runner.test.ts`，jsdom + three mock）

- `setPlan` 建 / 重建 / 释放 `namedRt`（含 resize 与 dispose）；
- 按计划绑 `g_Texture<index>`（断言 uniform value 是期望的纹理对象）；
- "写具名 RT 的 pass 失败 ⇒ 整链放弃、`lastOutput()` 为 null"；
- §5.22 透明清屏不回归。

### 7.3 编排（`object-effects` / `three-renderer` 既有测试）

- `rtGraphSkips()` 与整链跳过逻辑删除后，所有**可见**链都挂载；`visible:false` 不挂；
- isolate 准入改为"有可见链"（含原先 `rtGraphOnly` 对象的用例）。

### 7.4 端到端（headless Edge + `lib/` 生产代码，扩 `research/verify-object-effects.mjs`）

样本与判据：

| 样本 | 覆盖 | 判据 |
|---|---|---|
| `2911105183` | 5×blurprecise | 黑像素不高于 0.7%（§5.22 基线）|
| `2011060960` | blur + localcontrast（**双链同名 RT**）| 两链互不污染；盒外零变化 |
| `2937346640` | godrays（scale=2）| 效果在对象盒内 |
| `1968789468` | shine | 同上 |
| `3743126786` | GTR bloom（16 pass，8 张降采样 RT）| **盒外变化 = 0**；**局部亮部增量**（更亮像素占比与平均亮度增量 > 0）—— 实测 28913px 更亮（3.14%）、maxΔ103、平均亮度 +0.507；云区均值不得回归（§5.27 基线 46.3）。**如实标注**：全屏 p99 **无**提升（Δ=0 —— 「只保留 bloom 链」与「只摘 bloom 链」两种归因对照均为 0，主判据表面的 +17 全部来自同对象其它链 pulse 等）；未与桌面 WE 逐像素对照 |

性能走既有 [4] 段（帧间隔中位数 / p95 + 隔离对象数 + **新增具名 RT 显存估算**），结论一律标注"SwiftShader ≠ 真机，FPS 门槛未验证"。

**桌面逐像素对齐**：`3743126786` 与桌面 WE 的对照需要用户提供桌面截图（同 §5.27 的做法）。若未提供，该样本验收口径降为"亮部 p99 相对直渲明显提升 + 盒外零变化"，并在 `AGENT.md` §7 如实标注"未与桌面逐像素对照"。

### 7.5 验收清单

1. 全库 24 条 RT 图链**零**"具名 RT 未实现"告警，`rtGraphSkips()` 及相关代码删除；
2. 全库解析回归（`tests/verify-real-library.test.ts`）+ 相关 vitest 全绿（除 §7 记录的 15 项既有失败）；
3. 新增单测覆盖 §7.1–§7.3，含线性链退化断言；
4. 端到端 5 样本 PASS，GTR 盒外零变化；
5. 显存与性能实测数字写入 `AGENT.md` §7（FPS 门槛仍标"真机未验证"）；
6. 文档更新：`AGENT.md` §2.1（能力差消除）、§5（新增本设计确认的语义条目）、§7（P2 达成 + 如实标注：10 条挂在 text/util 上不可见、1 处 `_rt_FullFrameBuffer` 降级、未做 cap、wasm 侧绑定语义偏差）；
7. **README 的「部分特效不会出现：模糊、泛光、光轴、局部对比度这类需要多趟渲染的特效暂不支持」必须改写**（用户向文档，否则与实际不符）。

## 8. 里程碑（供实施计划参考）

| 里程碑 | 内容 |
|---|---|
| M1 | `effect-graph.ts` 纯函数 + `tests/effect-graph.test.ts`（含线性退化对照），TDD |
| M2 | `EffectRunner.setPlan` 消费计划 + 具名 RT 池 + 序列与槽优先级 + `tests/effect-runner.test.ts` 扩展 |
| M3 | 编排接线：`object-effects` 去整链跳过 + visible 过滤、`three-renderer` 准入与 `rtGraphOnly` 清理、相关单测 |
| M4 | 端到端验证 5 样本 + 显存/性能测量（`research/` 脚本，gitignore） |
| M5 | 文档：`AGENT.md` §2.1/§5/§7 + README + `lib`/`dist` 产物重建提交 |

## 9. 非目标与后续

- **text / util 对象上的 10 条链**：管线支持但看不见（text 渲染是独立缺口；util 本来无几何）。文本渲染属于另一项工作。
- **`_rt_FullFrameBuffer`（全帧缓冲）完整语义**：对象隔离路径下无法提供"当前帧已完成内容"，本期回落默认 + 告警。
- **`_rt_imageLayerComposite_<id>_a/_b`**：全库 6 处全被 `bind` 覆写，本期无需映射到本对象的 ping-pong RT；若将来出现未覆写的用法再补。
- **显存 cap / RT 分辨率收口**：见 §5.1，留落点不做。
- **wasm 路径对齐**：不改；其 `bind` 索引语义偏差记入文档。
- **音频 uniform、effect 级 `visible` 之外的脚本可见性**：不在本期。

## 10. 遗留与风险（开工前如实记录）

1. **清屏语义与 lwe 的差异**（§5）：本期沿用透明清屏；若出现"写具名 RT 的 pass 用了 translucent/additive"的壁纸，结果会与桌面不同。实施时复核全库，有例外记入 §7。
2. **16 pass / 8 张降采样 RT（scale 2/4/8/16，约 5.5 MB）的性能与显存代价只在本机 headless（SwiftShader）测量**，真机 FPS 门槛仍未验证。
3. **线性链的"逐位等价"是断言层面**（计划形态一致），端到端仍有既有样本（`2911105183` 黑像素、GTR 云区均值）作为回归闸门。
4. **14 条可见 ≠ 14 处明显观感变化**：部分链本就作用在局部区域（如 `util/white` mask 的 localcontrast），验收以"效果在对象盒内生效 + 无回归"为准，不以"观感显著"为准。
5. **`fbos[].format` 未消费**：依据是 lwe 自身忽略该字段（§2.2 #9）。若将来出现 `rgba16161616f`（HDR）的链，需重新评估（全库当前 0 处）。
