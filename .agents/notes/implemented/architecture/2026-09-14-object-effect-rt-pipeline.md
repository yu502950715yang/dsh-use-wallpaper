# Agent Note: 对象级 effects 走隔离 RT + 具名 RT 图执行器

Status: implemented

## Problem

WE 的对象级 `effects` 是对**该对象**做的后处理链：可能多 pass、可能互相回读、可能写具名 RT（`_rt_*`）再采样。它不能当成一次全屏后处理来实现 —— 那样会同时错掉四件事：像素尺度与 `g_TextureNResolution` 语义、效果所在的空间（对象可能被旋转/缩放）、对象自身的 alpha 与多层叠加、以及对象之间的先后依赖（后一个对象的模糊会吃到前一个的输出）。

另一处风险在语义来源：WE 的 RT 图有一套具体的绑定语义（`bind`、`previous`、`fbos.scale`），靠自己猜实现会**产出错画面而不报错** —— 而错画面比不画更难发现。

## Decision

**隔离路径 + 加载期编译的具名 RT 图执行器。**

- **隔离**：带 `effects` 的对象不走直渲，而是「内容 → 对象 RT → 效果链 → 合成 quad → 屏幕」。局部正交相机的 left/right/top/bottom 是**完整世界尺寸**（不得按 4096 钳制，否则大对象出现边缘拉伸带；也不得拿 RT 像素当范围，否则 HiDPI 下对象缩小 + 边缘 clamp 拉伸）。隔离的键是 `scene.json` 的**对象 id**（不是图层计数器）：`isolatedObjects()` / `setObjectOutput()` / `resizeObjectRT()` 共用同一把键。
- **RT 尺寸**：`RT 像素 ≥ 屏占位`，屏占位 = |未钳制世界尺寸| × 屏幕密度（密度必须与主相机 cover 同源，挂载期与 resize 期调同一套语义）；单一等比收口 4096，**只升不降**。
- **具名 RT 图**：加载期由 `buildEffectPlan` 编译成**静态计划**、`EffectRunner.setPlan` 建具名 RT 池；帧内只查表绑槽 + 提交 pass。语义照 lwe：`bind.index` 就是 `g_Texture<index>` 且 **`bind` 优先于 `textures`**；`previous` = 进入 target 序列**之前**的输入（不是上一 pass 输出）；具名 RT = 对象 RT ÷ `fbos.scale`；**池作用域 = 单条链**。
- **一切编译/建管线只在加载期完成**（预建 uniform + 1×1 探针），帧内不得编译或建管线 —— 每帧只写 uniform、建 bind group、提交 pass。
- **降级必须显式，绝不静默画错**：写具名 RT 的 pass 编译失败 ⇒ **整条计划放弃**（回退对象 RT 原图）；引用链内不存在的 `_rt_*` 保持默认、不绑白纹 + 按槽去重告警；单链具名 RT > 16 张 ⇒ 该链不挂；effect 级 `visible === false` 整条不挂链（那是作者正常内容，不打降级告警）。
- **混合语义落在合成 quad 上**：`colorBlendMode ∈ {6,7,31}` 的语义是 `mix(A, Blend(A,B), opacity)`，而这三个模式的颜色因子都不看 alpha ⇒ 必须把图层 alpha **预乘进 rgb**（否则全强度盖住画面，GTR「云挡住人物」），内容侧改回普通 alpha 写入。合成 quad 还必须**透明清屏**（`rt-render.ts` 是唯一入口）。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `076ad36` `ecfcc10` `6bb3d71`

## Alternatives considered

**全屏展平：把对象效果按对象顺序渲到整屏再展平。** 理由：实现最省 —— 一套整屏后处理管线就能复用，不必维护每个对象一张 RT。不用它是因为有四条结构性反证：像素尺度与 resolution uniform 全错、旋转缩放的几何空间错、对象 alpha 与多层叠加被抹掉、对象间接力错（后一对象的模糊吃到前一对象输出）；文档因此明确**不以全屏展平为过渡方案**。

**移植 wasm 侧已有的绑定语义（只取 `bind[0]`、按 `g_Texture(i+1)` 对齐槽号）。** 理由：代码已经写过一遍，直接搬省事。不用它是因为它与 lwe 不符 —— 正确口径是 `textures[i] → g_Texture(i)`（`AGENT.md` §5.16），照旧口径搬会让**所有效果的纹理槽整体错位**。

**用线性执行器硬跑 RT 图链。** 理由：不必新写执行器，改动面小。不用它是因为产物是**错画面**：RT 图里 `previous` 与 target 序列的语义在线性执行下不成立。

**保守判据：任何出现 `bind` 的 pass 都当 RT 图链处理。** 理由：宁可多挂链也不漏 —— 坏了至少有降级。不用它是因为它会把与默认行为同义的 `previous@0` 整条**永久跳过**，结果是"安全但错"：链不生效。改用精确判据。

**逐轴独立 clamp 到 4096。** 理由：显存更省，长边不再独占预算。不用它是因为**破坏 aspect ratio**，会让效果的空间关系错位（同类产品有真实事故记录）；4096 必须等比收口。

**为对象级效果引入一张 sceneRT。** 理由：统一成"先渲场景再处理"。不用它是因为对象级效果的**输入就是对象自己**，引入 sceneRT 既不必要又与隔离语义冲突。

## Consequences

**收益：** 对象效果真的生效且与 WE 同空间、同尺度；隔离路径的键与尺寸口径统一到一把尺子（这条口径后来也支撑了隔离 RT 分辨率特性，见 [隔离对象 RT 尺寸锚在屏占位、上限取源纹理](../bug-fix/2026-10-12-isolated-rt-source-texture-sizing.md)）；降级路径全部显式可查（告警 / 整链放弃），不会静默画出错画面。

**代价：** ① 隔离路径要为每个对象额外付一张 RT 与 ping-pong（显存是这条路径的主要成本）；② **不是所有对象都能挂链** —— `text` 对象的 effects 在收链阶段就被跳过（连 warn 都没有），`util` / 无媒体字段的对象拿不到隔离条目（`AGENT.md` §7.1）；③ 具名 RT 池作用域是**单条链**，跨链共享不被支持；④ `_rt_*` 里只实现了 `_rt_FullFrameBuffer` 一条语义（且效果链消费点仍门控关闭，见 [段渲染 + 帧内快照实现 `_rt_FullFrameBuffer`](2026-10-13-frame-snapshot-segmented-render.md)）；⑤ 单链具名 RT 超 16 张、写具名 RT 的 pass 编译失败等情形一律**不挂链**，行为是"效果不生效"而非"近似生效"。

设计与逐条语义见 [对象级效果链设计](../../../../docs/superpowers/specs/2026-09-14-three-object-effects-pipeline-design.md) 与 [RT 图执行器设计](../../../../docs/superpowers/specs/2026-09-15-three-rt-graph-executor-design.md)。
