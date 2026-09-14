# three.js 主路径对象级效果链（effects）管线 — 设计文档

- 日期：2026-09-14
- 状态：待实施（P1 待开发；P2 已规划，见 §9）
- 项目根：`E:\code\dsh-use-wallpaper`
- 关联：
  - `2026-08-18-dsh-wallpaper-engine-effects-design.md`（效果链方言层与 wasm/旧 JS 路径的一期设计，本文是它在 **three 主路径**上的补齐）
  - `2026-08-25-wasm-object-effect-chains-design.md`（对象级 RT 的 wasm 侧实现与语义裁决）
  - `AGENT.md` §2.1（scene 渲染路径）、§2.3（坐标与 T·R·S 约定）、§5.6 / §5.10 / §5.11（混合模式、效果链管线、加载期编译约束）、§7.1（本文要消除的最大能力差）

## 1. 概述

`scene.json` 每个对象的 `effects`（WE 效果链：水波、抖动、云滚动、模糊、光晕…）在 v0.3.0 起成为**唯一渲染路径**的 `threejs-player.ts` 里**完全未被消费**——`scene-json.ts:138` 解析并保留了该字段，`three-renderer.ts:133-161` 组装时直接丢弃。结果是全库 **130 条效果引用全部失效**（AGENT.md §7.1 记为「当前最大能力差」）。

本文为 three 主路径补上**对象级**效果链管线：

- **对象级局部 RT**（而非全屏展平）——依据 §2.3 的证据，这是 WE 的真实行为；
- 复用既有已验证资产：`EffectRunner`（执行器，`effect-runner.ts`）与 `resolveEffectChain`（链解析，`shader/effect-chain.ts`）**不改一行**，`scene-renderer.ts` 的纯函数提取为共享模块；
- 按「覆盖面优先 + 管线内置性能预算 + 逐效果降级」分期：**P1 覆盖 106/130（82%）**，无法正确执行的 RT 图链**显式跳过并告警**（不静默画错），留给 P2。

## 2. 事实基础

### 2.1 全库效果链规模（本机实测，2026-09-14）

`research/scan-effects.mjs` + 本文新增的 `research/scan-effect-multipass.mjs`（扫描 `D:/Steam/steamapps/workshop/content/431960` 下 28 个壁纸的 `scene.pkg`）：

| 指标 | 值 |
|---|---|
| 带 effects 的壁纸 | 17 / 28 |
| 效果引用总数 | 130 |
| 涉及效果种类 | 34（含 workshop 自带变体） |
| 高频效果 | waterwaves×24、shake×18、opacity×8、waterripple×7、blurprecise×6、waterflow/pulse/perspective×5、clouds/scroll/foliagesway×4 |
| 单壁纸最重 | `1429403119`：23 个对象 / 24 条效果链 |

### 2.2 pass 结构分类（决定 P1 / P2 分界）

按 `effect.json` 的 pass 结构分两类（`research/scan-effect-multipass.mjs` 实测）：

| 类别 | 判定 | 种 / 次数 | 现有 `EffectRunner` 是否正确 | 代表 |
|---|---|---|---|---|
| **线性链** | 无 `passes[i].target` 且无 `passes[i].bind` | 25 种 / **106 次（82%）** | ✅ 正确（ping-pong 即 WE 的 `previous` 语义） | waterwaves、shake、opacity、waterripple、waterflow、pulse、perspective、clouds、scroll、foliagesway、iris、skew、vhs、filmgrain、spin、tint、lightshafts、Simple_Audio_Bars、refraction（2 pass 纯线性） |
| **RT 图链** | 有具名 RT `_rt_*` target / `bind` / `fbos` 降采样 | 9 种 / **24 次（18%）** | ❌ 会画错（写错 RT / 读错源） | blurprecise×10、blur×3、localcontrast×2、godrays×2、bloom×2、shine×1、bokeh_blur×1 |

脚本原始输出按 `passes>1 || fbos || target || bind` 粗分类（LINEAR 24 种/105 次、RTGRAPH 10 种/25 次）；本表按**「是否消费具名 RT」**重判，因此 2 pass 但既无 `target` 也无 `bind` 的 `refraction`（1 次）计入线性链，RT 图链为 **9 种 / 24 次**。判定的可执行形式见 §5.1 的 `isLinearEffectChain`。

RT 图链的结构实例（`effect.json` 原文）：

- `blurprecise`：2 pass，`target=_rt_FullCompoBuffer1`，`bind=[{0:_rt_FullCompoBuffer1},{1:previous}]`，`fbos=[_rt_FullCompoBuffer1 scale=1]`；
- `blur`：4 pass，2 个 Quarter 尺寸 fbo，pass 间交替写读；
- `bokeh_blur`：5 pass，3 个 fbo（`_rt_downscaled1/_rt_coc/_rt_downscaled2`），出现 `bind` 一次绑多张。

**现有 `EffectRunner.update`（`effect-runner.ts:359-390`）只做 `pickWriteTarget(lastWrite, rtA, rtB)` 的线性 ping-pong，完全忽略 `pass.target` / `pass.bind` / `pass.fboScale`**——这些字段 `effect-chain.ts:94-97` 已经解析出来了（当初为 wasm 侧准备），three 侧没有消费者。

### 2.3 对象级局部 RT 才是 WE 真实行为

| 证据 | 内容 |
|---|---|
| OWE `SceneImageObjectParser.cpp:47-54` | `effect_target_size = obj.size`；**仅 `fullscreen` 对象**才用相机/屏幕尺寸 |
| OWE `SceneImageObjectParser.cpp:581-606, 643-661` | 为对象建**局部正交相机**（范围 = effect extent）并 `AttatchNode` 到对象节点；对象 RT（`_rt_imageLayerComposite_<id>`）尺寸 = effect extent |
| lwe `CImage.cpp:267-276, 1132-1138` | 每个对象两张 ping-pong `_rt_imageLayerComposite_<id>_a/_b`，尺寸 = **纹理真实尺寸**，不是屏幕 |
| lwe `WallpaperApplication.cpp:117-158` | 连「屏幕级泛光」也是以 **fullscreen image 对象 + 它自己的层 composite RT** 实现 ⇒ 全屏只是 fullscreen 对象的特例 |
| 本仓库实证 | `scene-renderer.ts:134-136` 注释记录了旧全屏 `flatMap` 展平的后果：foliagesway 这类对象级效果**整屏生效** |

**全屏展平会错在四处**：(a) 对象不铺满屏幕时像素尺度与 `g_TextureNResolution` 派生量全错；(b) 对象旋转/缩放时效果应作用在对象自身纹理空间，展平后变屏幕空间；(c) 对象 alpha 与多层叠加被抹掉；(d) 后一对象的模糊会吃到前一对象的输出。因此本文**不以全屏展平为过渡方案**。

### 2.4 可复用的既有实现

`scene-renderer.ts`（未接入的旧 JS 路径）**已经实现过完整的对象级效果链**，是本文的蓝本：

| 能力 | 位置 | 本文处置 |
|---|---|---|
| 对象局部相机范围（幅值、钳制 4096、下限 1） | `objectCameraRange` `scene-renderer.ts:82` | 提取到 `object-range.ts` |
| 粒子对象范围 / 世界尺寸（`distanceMax` 缺省 64） | `particleObjectRange:106`、`particleWorldSize:116` | 同上 |
| 对象 RT 创建 | `createObjectRenderTarget:123` | 同上 |
| UV 窗口（钳制轴只采样可见段） | `uvWindow:264`、`applyUvWindow:277` | 同上 |
| 合成 quad 几何（世界尺寸未钳制） | `createCompositeGeometry:294` | 同上 |
| 带效果对象分组 / 调度谓词 | `groupEffectsByObject:139`、`shouldUseObjectPath:130` | 同上 |
| 链 / 条目竞态暂存 | `PendingChainStore:158` | 同上 |
| 每对象一个 runner | `applyObjectChains:402` | 由 `object-effects.ts` 重建 |
| 帧序编排 | `frame():453-506` | 由 `object-effects.ts` 重建（去掉 sceneRT 层，见 §4.3） |
| 执行器本体 | `effect-runner.ts`（`EffectRunner`） | **原样复用** |
| 链解析 | `shader/effect-chain.ts`（`resolveEffectChain`） | **原样复用** |

`EffectRunner` 的既有性质（`effect-runner.ts`）：构造注入 `WebGLRenderer` + 尺寸；`setChains(chains, wallpaperId, {width,height})`；`update(time, input)` 为异步、`updateInFlight` 防重入、纹理槽在 update 开头集中 await（绑定段无 await）；pass 编译用 1×1 探针 + `renderer.debug.onShaderError` 检测，失败只跳该 pass；`lastOutput()` 同步读最近完成输出。`tests/effect-runner.test.ts` 覆盖 6 个纯函数，**`EffectRunner` 类本体零覆盖**（node 无 WebGL）。

## 3. 模块划分（方案 A）

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/client/object-range.ts` | 新增 | §2.4 表格中的纯函数，**从 `scene-renderer.ts` 原样搬移**；`scene-renderer.ts` 改为从此导入（同一份实现，杜绝漂移） |
| `src/client/object-effects.ts` | 新增 | `ObjectEffectStage`：effects 解析挂链、每对象 `EffectRunner`、RT 尺寸预算、线性/RT 图判定与降级、帧推进、dispose。**不构造 three 场景、不持有 canvas** |
| `src/client/threejs-player.ts` | 改 | 「对象隔离」能力（§4.1）+ 三个帧钩子（§4.2） |
| `src/client/three-renderer.ts` | 改 | 把现在被丢弃的 `effects` 解析为链 → 建 `ObjectEffectStage` → 装到 player；`teardown` 时释放 |

依赖方向：`three-renderer.ts` → `object-effects.ts` → { `object-range.ts`, `effect-runner.ts`, `shader/effect-chain.ts` }；`threejs-player.ts` **不 import** `object-effects.ts`（player 只认识下面这个小接口）。

```ts
// threejs-player.ts 内的接口（stage 由外部注入，player 不依赖其实现）
export interface ObjectEffectStage {
  renderContents(): void;   // 逐隔离对象：setRenderTarget(objRT) + render(localScene, localCamera)
  bindOutputs(): void;      // quad.map = 效果输出 ?? objRT.texture
  advance(time: number): void;  // 串行推进 runner.update（异步，不阻塞本帧）
  dispose(): void;
}
```

## 4. player 对象隔离能力与帧序

### 4.1 隔离语义

`addBackground(opts)` 与 `addParticle(getter, opts)` 各增加一个可选参数：

```ts
isolate?: { width: number; height: number };   // 对象 RT 的像素尺寸，由调用方按 §5.2 算好
```

- **不传 `isolate`**：行为与今天**逐字相同**（内容直接进 `this.scene`）——零回归，既有 `threejs-player.test.ts` 全部保持。
- **传 `isolate`**：内容（`Mesh` / 粒子 `Mesh`）挂进新建的 `localScene` + 局部正交相机（范围 = `[-w/2, w/2] × [-h/2, h/2]`，`position.z = CAMERA_DISTANCE`，与主相机同 z 语义），内容自身保持 `(0,0,0)`（对象中心即局部原点）；**主 scene 里放一张合成 `PlaneGeometry` quad**，其 `position` = 对象 origin 的 `we_to_three` 值（`origin - scene/2`，y 不翻）、`rotation` = 对象 angles、`scale` = 对象 scale，`renderOrder` 与对象原语义一致（背景 0 / 粒子 1）。

新增访问器（供 stage 使用）：

```ts
isolatedObjects(): Iterable<{ id: number; rt: THREE.WebGLRenderTarget; quad: THREE.Mesh; /* 只读视图 */ }>;
setObjectOutput(id: number, texture: THREE.Texture): void;  // 决定合成 quad 采样谁
resizeObjectRT(id: number, width: number, height: number): void;  // 预算变化时重建 RT
```

**合成 quad 的材质必须承接对象原有的混合语义**：

- 对象 `colorBlendMode` ∈ {0, 未实现} → `MeshBasicMaterial({ map, transparent: true, depthWrite: false })`，`opacity` = 对象 alpha、`color` = color×brightness（复用 `materialModulation`）；
- 对象 `colorBlendMode` ∈ {6, 7, 31} → 复用 `colorBlendModeToThree`（`threejs-player.ts:279`）+ 预乘 `ShaderMaterial` + `CustomBlending`，`uniforms.map` = 效果输出纹理。

这样 AGENT.md §5.6 的 `ApplyBlending` 语义**落在合成这一步**（对象 RT 内部是干净的替换写，混合本就该发生在贴回画面时），全库 3 个非零对象（`3743126786` Clouds Back=7、`2832263418` audio_rainbow=6、`2460786246` Clock=31）行为不丢。

### 4.2 帧序

`setAnimationLoop` 帧体（`threejs-player.ts:469-483`）与 `render()`（`:488`）**同步修改**，避免两条渲染入口语义分叉：

```
fn?.(dt)                        // 外部：for (sim of sims) sim.update(dt)
this.update(dt)                 // 内部：updateParticles(dt) 刷新实例缓冲
stage?.renderContents()         // ← 新增
stage?.bindOutputs()            // ← 新增
renderer.render(this.scene, this.camera)   // 主场景（含合成 quad）→ canvas
stage?.advance(this.elapsedTime)           // ← 新增（异步串行，不阻塞本帧）
```

`stage` 为 null（无任何带效果对象）时，帧体退化为今天的 `fn → update → render`，**调用序列不变**。

### 4.3 关键取舍：P1 不引入 sceneRT

旧 `scene-renderer.ts` 走「场景 → sceneRT → 效果链 → 贴屏」是因为它要为**全屏**链提供可读的整屏输入。对象级效果只作用于对象自身内容（输入即对象 RT），合成 quad 直接画进主场景即可：

- 省一张全屏 RT 每帧一次额外 blit 与一次 `setSize` 联动；
- 沿用 player 既有的 dpr / canvas 缓冲尺寸 / cover 相机逻辑（`threejs-player.ts:389-394, 412-421, 433-441`），不与旧路径的 `alpha:true` + 不设 pixelRatio（`scene-renderer.ts:326-360`）行为打架；
- 代价明确：P1 的效果**无法读取「对象背后的画面」**。需要读背景的效果（部分 `clouds` / `refraction` 变体）若出现异常，归入 P2 评估并如实记录，不假装支持。

### 4.4 粒子隔离的坐标修正

粒子世界位置在顶点 shader 中为 `worldPos = objCenter + R(angles) · (scale ⊙ (emitterOrigin + local))`（`threejs-player.ts:185`，AGENT.md §2.3 的既定约定）。对象进 localScene 后**对象中心即局部原点**，因此 `uObjectCenter` 在隔离模式下传 `[0,0,0]`，世界位移全部由合成 quad 的 `position` 承载。顺序/缩放/角度语义保持不变。

这是本设计最容易静默出错的一处（错了表现为「粒子整块偏移」），必须有显式单测（§7）。

## 5. 执行语义、降级与性能预算

### 5.1 线性判定与降级

```ts
// 线性可执行 = 无具名 RT 写出、无具名 RT 采样。
// 说明：fbos 只对具名 RT 有意义，链内无 target 时无消费者；纯多 pass（如 refraction 2 pass）
// 依然由 ping-pong 正确执行（WE 的默认读取源即 previous）。
export function isLinearEffectChain(passes: CompiledEffectPass[]): boolean {
  return passes.length > 0 && passes.every(p => !p.target && p.bind.length === 0);
}
```

- **线性链** → 交给 `EffectRunner`（每对象一个实例，`setChains` 时传入对象 RT 尺寸）；
- **RT 图链** → **整条跳过**，该对象合成 quad 回退其对象 RT 原始纹理（对象正常显示、无效果、**不黑屏**），并 `console.warn('[wallpaper-engine] 效果需要具名 RT（P2 未实现），跳过: <effect file>')`，**按 effect 文件去重**只告警一次（防刷屏）。

不做「用线性执行器硬跑 RT 图链」的降级：产物是错画面（写错 RT / 读错源），而本仓库既有约定是「未实现就回退，绝不静默画错」（AGENT.md §5.6、`effect-chain.ts:2` 同旨）。

### 5.2 对象 RT 尺寸预算

```
worldSize   = image: size × |scale|  /  particle: distanceMax(缺省 64) × |scale|
baseW/baseH = objectCameraRange / particleObjectRange（已含 4096 钳制与幅值语义）
dpr         = 构造时快照的 devicePixelRatio（与 player 缓冲一致，否则效果分辨率与贴屏不符）
finalW/H    = 等比缩放 baseW/H × dpr 至 min(4096, canvasBufferW/H) 预算内，逐轴下限 1
```

**等比缩放而非逐轴独立 clamp**：逐轴独立会把 `8192×4608` 压成 `4096×4096`，破坏依赖 aspect 的效果（竞品 `docs/perf-audit-2026-08-29.md` 记录的真实事故 N-06）。

预算随视口变化（`resize` / `setSceneSize`）时，由 stage 重算并调用 `player.resizeObjectRT(id, w, h)`；`uvWindow` / `createCompositeGeometry` 负责把钳制轴映射回未钳制的世界尺寸（`blurprecise` 类大对象不会因钳制而「缩小摆放」）。

### 5.3 执行与生命周期约束

- **加载期一次性完成**（AGENT.md §5.11 硬约束）：链解析（`resolveEffectChain`，多次 `loadFile`）、`EffectRunner` 创建、`setChains` 与探针编译全部在加载阶段；帧内只写 uniform + 提交 pass，**不得**在 `renderContents` / `bindOutputs` / `advance` 中做 naga/WGSL 编译或建管线。
- **串行推进**：`advance` 用 promise 链（`chain = chain.then(() => runner.update(t, rt.texture)).catch(warn)`）保证同一时刻只有一个 runner 触碰 renderer 的 RT 与绑定状态——并发交错会导致黑屏/闪烁（`scene-renderer.ts:489-500` 已踩过）。每 runner 内部 `updateInFlight` 防重入，未完成时本帧保留上一输出。
- **链 / 条目竞态**：沿用 `PendingChainStore`（链解析是异步的、条目创建也是异步的，链可能先就绪）。
- **失败隔离**：单 pass 编译失败 → 跳该 pass（`EffectRunner` 探针已实现）；整链不可用 → 该对象回退原始内容；**任一对象失败都不影响其他对象与整张壁纸**（不触发壁纸级回退——画面本身已有效）。
- **释放**：`dispose` 顺序 = stage.dispose()（runner/材质/纹理槽缓存）→ player.dispose()（RT/quad/geometry/localScene）。

### 5.4 音频与指针 uniform

`EffectRunner` 支持 `setAudioSpectrumSource`（`effect-runner.ts:171`）与音频数组 uniform 注入，但**three 主路径没有任何音频源**——`createAudioAnalyzer` / `playWallpaperSound` 只被未接入的 `scene-renderer.ts:12, 782-793` 引用。因此 `Simple_Audio_Bars`（2 壁纸）、`audioline` 等音频响应效果在 P1 是「**效果在、但不随频谱动**」（uniform 保持 binder 初始化的全零）。

- P1 **不接音频**（保持零变化、避免引入新失败面），但在 spec 与 AGENT.md §7 中**如实标注**；
- 指针 uniform（`g_PointerPosition` 等）同样不做，鼠标交互类效果按现有语义执行（静态位置）。

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| effect.json / material / shader 缺失或 JSON 非法 | `resolveEffectChain` 返回 null → 该对象不建链（原样显示），`console.warn` |
| 链含具名 RT / bind（RT 图链） | **整链跳过** + 去重 `console.warn`（§5.1） |
| shader 编译失败 | 跳该 pass（1×1 探针 + `renderer.debug.onShaderError`）；全部 pass 失败 → 对象回退原始内容 |
| 纹理槽加载失败 | 跳该槽（`effect-runner.ts:330-333` 已有），采样回退 three 默认纹理 |
| 对象 RT 尺寸退化 | `objectCameraRange` 已保证 ≥1；预算计算再取 `Math.max(1, round())` |
| 视口 resize 期间 | stage 重算尺寸重建 RT；重建完成前 quad 继续采样旧纹理（不闪黑） |
| 无 effects 的壁纸 | `stage` 为 null，帧序与今天完全一致（零回归路径） |

## 7. 测试策略与验收

### 7.1 单元测试（node 环境，TDD）

新增：

- `tests/object-range.test.ts`：搬移后的纯函数**回归既有断言**（`objectCameraRange` 幅值/钳制、`particleObjectRange`、`uvWindow`、`createCompositeGeometry`、`groupEffectsByObject`、`materialModulation`、`coverRange`）；
- `tests/object-effects.test.ts`：
  - `isLinearEffectChain`：全库 130 条链的分类断言（**106 线性 / 24 RT 图**，钉住数字）；
  - `resolveObjectRtSize`：等比 clamp、dpr 参与、4096 与画布预算上限、退化下限 1；
  - `ObjectEffectStage` 编排（mock renderer + mock runner）：`renderContents` → `bindOutputs` → `advance` 调用顺序、输出回退（runner 无输出时采样对象 RT）、串行推进（第二次 advance 未完成时不重入）、RT 图链跳过并只告警一次、`dispose` 释放全部 runner/材质；
  - 竞态：链先于条目就绪（`PendingChainStore` 补挂）。

回归：`tests/scene-renderer.test.ts`（搬移后 import 路径变更）、`tests/effect-runner.test.ts`、`tests/shader/effect-chain.test.ts`、`tests/verify-real-library.test.ts`（全库效果链解析零失败 + 数量断言）。

### 7.2 player 隔离模式（jsdom）

`tests/dom/threejs-player.dom.test.ts`（或并入既有 `tests/threejs-player.test.ts`）：

- 传 `isolate` → 内容进 `localScene`、主 scene 出现合成 quad、`isolatedObjects()` 可见、quad 的 T·R·S 与对象一致；
- **不传 `isolate` → 帧调用序列与今天逐字一致**（零回归断言）；
- 粒子隔离时 `uObjectCenter` 为 `[0,0,0]`（§4.4 的显式单测）；
- `colorBlendMode` ∈ {6,7,31} 的合成 quad 使用 `CustomBlending` 且 premultiplied 着色器。

### 7.3 端到端（headless Edge，跑生产代码）

沿用 `research/verify-colorblend.mjs` 的模式（自起 http server + headless Edge + esbuild harness + 加载 `lib/client/threejs-player.js`，**不依赖 DSH token**）：

1. **效果确实在动**：`2683211654`（单对象 waterwaves）连续帧差分非零；
2. **对象级判据（本特性的核心断言）**：选一张多对象 + 单对象效果的壁纸，断言效果对象**包围盒外的像素帧间不变**、盒内变化 —— 全屏展平会在这一条上失败；
3. **降级可见性**：带 `blurprecise` 的壁纸（如 `3765967112`）中，被跳过的链有明确 `console.warn`，画面无异常、无 console error。

### 7.4 性能

- `1429403119`（23 对象 / 24 条链，全库最重）1080p 实测 FPS 与对象 RT 总显存估算；
- **验收门槛：FPS ≥ 30 @1080p**（与一期 spec §7 的既有门槛一致）。

### 7.5 P1 验收清单

1. 全库**线性链 106 条**在 three 主路径**对象级**生效（对象外区域不受影响）；
2. RT 图链 24 条**显式跳过 + 告警**，无静默错画面；
3. 无白屏、无 console error；无 effects 壁纸零回归；
4. `npm test` 无**新增**失败（AGENT.md §7.11 记录的 15 项既有失败以 `git stash` 基线对比，不计入）；
5. 性能门槛达标（§7.4）；
6. AGENT.md §7.1 据实改写（P1 达成部分与 P2 遗留）。

## 8. 里程碑

| 阶段 | 内容 | 出口条件 |
|---|---|---|
| M1 纯函数与分类器 | `object-range.ts` 搬移 + `isLinearEffectChain` + RT 尺寸预算 | 单测绿；全库 130 条链分类数字钉住 |
| M2 player 隔离能力 | `isolate` 参数、合成 quad、帧钩子、访问器 | jsdom 零回归断言绿；不传 `isolate` 时调用序列不变 |
| M3 管线接通 | `object-effects.ts` 编排 + `three-renderer` 装配 | waterwaves 在 GUI 可见动态水波 |
| M4 泛化与验收 | 全库 17 张带效果壁纸逐个验证 | §7.5 六条全部满足 |

## 9. 非目标与后续（P2）

**P1 非目标**：

- **RT 图执行器**（具名 RT 池 + `fbos` 降采样 + `bind` 语义）——覆盖剩余 24 条 blur / blurprecise / godrays / bloom / shine / localcontrast / bokeh_blur；
- text 对象的 effects（`player` 本就不渲染 text，`SceneTextObject` 也无 effects 字段，属独立缺口）；
- 音频响应与指针交互 uniform 接入（§5.4）；
- 全屏/相机级后处理链（WE 中以 fullscreen 对象 + 其层 composite RT 实现，需独立链路）；
- 对象级 `colorBlendMode` 未实现模式（1..5/8..30/32）的补齐；
- 粒子 quad 自旋 `rot`（AGENT.md §7.3 既有遗留）。

**P2 方向（预留，不在本 spec 实现细节）**：把 `CompiledEffectPass` 已有的 `target` / `bind` / `fboScale` 消费起来——按 `fbos[].scale` 建具名 RT 池，pass 按 `target` 选写端、按 `bind` 选读端（`previous` = 上一 pass 输出），降采样 RT 尺寸 = 基础尺寸 / scale（下限 1）。three 是 WebGL，无需 wasm 侧的 GLSL→SPIR-V→WGSL 链，直接复用 `EffectRunner` 的材质/探针机制即可。

## 10. 遗留与风险（开工前如实记录）

1. **`EffectRunner` 类本体零单测覆盖**（node 无 WebGL），P1 的编排层可测，但**执行器本体的正确性依赖端到端验证**（§7.3）；
2. **对象 RT 显存**：全库最重壁纸 23 个对象，若每个对象 RT 都接近屏幕尺寸，显存与带宽会明显上升；§5.2 的等比预算只解决单对象上限，**多对象总预算**留作实测后按需补（先用 `1429403119` 压测）；
3. **headless Edge 的 WebGL 走 SwiftShader**（AGENT.md §7.10），性能数据需在真实 GPU 上复核；
4. **`refraction` 归类为线性链**（2 pass、无 target/bind）是按 `previous` 默认语义判定，需在 M4 用真实壁纸验证；若实测异常则移入 P2 并记录；
5. **文档与代码不一致的历史包袱**：AGENT.md §5.10 记 `OBJECT_RT_MAX=2048`，代码实为 **4096**（`effect.rs:225`、`scene-renderer.ts:53`）——本文档以代码为准，实现时一并订正 AGENT.md。
