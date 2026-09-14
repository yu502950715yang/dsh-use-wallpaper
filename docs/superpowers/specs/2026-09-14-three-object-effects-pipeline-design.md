# three.js 主路径对象级效果链（effects）管线 — 设计文档

- 日期：2026-09-14
- 状态：**已实施（P1 完成；P2 待做）**（2026-09-14 实施完成并逐任务通过审查；执行期间的偏差已回写，见本文各处 `实现偏差` 标注）
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

> **计数口径**：§2.1「高频效果」按**效果目录**计（不含 `effects/workshop/<id>/...` 变体）；§2.2「RT 图链」按 **effect.json 文件**计，同一效果的多变体会合并计数——`blurprecise` 有三个变体（`effects/blurprecise` 6 次 + `effects/workshop/3732231168/blurprecise` 4 次 + `effects/workshop/3424038533/blurprecise` 3 次 = **13 次**）。

### 2.2 pass 结构分类（决定 P1 / P2 分界）

按 `effect.json` 的 pass 结构分两类（`research/scan-effect-multipass.mjs` 实测）：

| 类别 | 判定 | 种 / 次数 | 现有 `EffectRunner` 是否正确 | 代表 |
|---|---|---|---|---|
| **线性链** | 无 `passes[i].target` 且无 `passes[i].bind` | 25 种 / **106 次（82%）** | ✅ 正确（ping-pong 即 WE 的 `previous` 语义） | waterwaves、shake、opacity、waterripple、waterflow、pulse、perspective、clouds、scroll、foliagesway、iris、skew、vhs、filmgrain、spin、tint、lightshafts、Simple_Audio_Bars、refraction（2 pass 纯线性） |
| **RT 图链** | 有具名 RT `_rt_*` target / `bind` / `fbos` 降采样 | 9 种 / **24 次（18%）** | ❌ 会画错（写错 RT / 读错源） | blurprecise×13、blur×3、localcontrast×2、godrays×2、bloom×2、shine×1、bokeh_blur×1 |

脚本原始输出按 `passes>1 || fbos || target || bind` 粗分类（LINEAR 24 种/105 次、RTGRAPH 10 种/25 次）；本表按**「是否消费具名 RT」**重判，因此 2 pass 但既无 `target` 也无 `bind` 的 `refraction`（1 次）计入线性链，RT 图链为 **9 种 / 24 次**。判定的可执行形式见 §5.1 的 `isLinearEffectChain`。

> **实现偏差（2026-09-14 回写）**：本节的**精确判据**是「`target` 非空 **或** 存在不满足 `name === 'previous' && index === 0` 的 `bind`」，**不是**初稿 §5.1 写的「无 target 且 bind 为空」。依据是 `EffectRunner` 的纹理绑定是**固定的**：`g_Texture0` = 上一 pass 输出、`g_Texture(j+1)` = `textureSlots[j]`（`effect-runner.ts:359-390`）。因此 `bind: [{name:'previous', index:0}]` 与执行器默认行为**同义**，属线性可执行；只有引用具名 RT、空名 sampler2D 槽、或把 `previous` 绑到 `index ≠ 0` 的 `bind` 才需要 RT 图语义。按初稿的字面判据会把 `previous@0` 这类链**整条永久跳过**（安全但错的保守失败）。结论不变：`refraction`（2 pass、无 target/bind）属**线性可执行**；全库分类数字 25/106/9/24 也不变（库内所有含 `bind` 的链都引用具名 RT，无实测差异）。`fbos` 只对具名 RT 有意义——链内没有 `target` 时它没有消费者，**不构成降级理由**。

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
| 链 / 条目竞态暂存 | `PendingChainStore:158` | 同上（**实现偏差**：编排器**未**沿用这条暂存路径 —— 它从未被真正消费（以字面 `false` 调 `applyIfReady`、全类无 `take`），已删除并改为「接线顺序契约 + 明确告警」，见 §5.3；`PendingChainStore` 仍由未接入的 `scene-renderer.ts` 使用） |
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
// 隔离内容的渲染（setRenderTarget + render(localScene, localCamera)）由 player 自己完成，
// 因为它拥有 scene/camera；stage 只负责「输出绑定」与「链推进」两件事。
export interface ObjectEffectStage {
  bindOutputs(): void;          // 主场景渲染之前：quad 采样效果输出或对象 RT
  advance(time: number): void;  // 主场景渲染之后：串行推进 runner.update（异步，不阻塞本帧）
}
```

## 4. player 对象隔离能力与帧序

### 4.1 隔离语义

`addBackground(opts)` 与 `addParticle(getter, opts)` 各增加一个可选参数：

```ts
isolate?: {
  objectId: number;              // scene.json 的对象 id —— 也是隔离条目的**键**（见下）
  rtWidth: number; rtHeight: number;  // 对象 RT 的**像素**尺寸（含 dpr 与预算收口），由调用方按 §5.2 算好
  worldW: number;  worldH: number;    // 合成 quad 的**世界**尺寸（场景像素，未钳制幅值）
};
```

> **实现偏差（2026-09-14 回写）**：初稿写作 `isolate?: { width, height }`，把**对象 RT 像素尺寸**与**世界尺寸**混为一谈。实际实现拆成两组字段：`rtWidth/rtHeight` 是对象 RT 的**像素**尺寸（= §5.2 的 `resolveObjectRtSize(...)` 结果，**含 dpr 与预算收口**），`worldW/worldH` 是**世界尺寸**（场景像素，图片 = `|size × scale|`、粒子 = `particleWorldSize`，**未钳制**）——两者是两回事，`createCompositeGeometry(worldW, worldH, rtW, rtH)` 用的是**后者**（几何的世界占位不能按 RT 像素摆，否则会被 dpr/预算二次缩放）。初稿的 `{width,height}` 形状在 `addBackground` 路径侥幸正确（世界尺寸由 player 内部 `|size×scale|` 兜底算出），但在 `addParticle` 路径会把 RT 像素当世界尺寸传给 `createCompositeGeometry`，且 player 本就算不出粒子 spec 的 `distanceMax` —— 故统一由调用方（`three-renderer`，它同时持有 `range` 与 `world`）提供两个尺寸。

> **实现偏差（2026-09-14 回写）**：隔离条目的**键 = `scene.json` 的对象 id**（`isolate.objectId`），**不是** player 的图层计数器 id。player 有两个各自从 0 起的图层计数器（背景 / 粒子），用它们作键会让**同一壁纸的隔离 image 与隔离 particle 互相覆盖**（后建覆盖先建 —— 背景的合成 quad 从此采样一张永不被渲染的 RT），且 stage 侧还要维护一层「对象 id → 图层计数器 id」的翻译（脆弱：复制 `loadSceneToThree` 的建层条件与顺序，对侧一改建层逻辑就静默全失效）。因此 `isolatedObjects()[].id` / `setObjectOutput(id, …)` / `resizeObjectRT(id, …)` **收的都是对象 id**，与 `isolate` 表、`ObjectEffectStage` 共用同一把键空间（仓外调用方若按旧的图层计数器 id 传参会静默 no-op）。

- **不传 `isolate`**：行为与今天**逐字相同**（内容直接进 `this.scene`）——零回归，既有 `threejs-player.test.ts` 全部保持。
- **传 `isolate`**：内容（`Mesh` / 粒子 `Mesh`）挂进新建的 `localScene` + 局部正交相机（范围 = `[-w/2, w/2] × [-h/2, h/2]`，`position.z = CAMERA_DISTANCE`，与主相机同 z 语义），内容自身保持 `(0,0,0)`（对象中心即局部原点）；主 scene 里放一张合成 quad（几何尺寸 = `createCompositeGeometry(worldW, worldH, rtWidth, rtHeight)`，即世界尺寸已含缩放，quad 自身 `scale` 恒为 1）：`position` = 对象中心（世界坐标；背景 = `origin − scene/2`，y 不翻）、`rotation` = 对象 angles（**粒子路径为 `[0,0,0]`，见 §4.4**）；而局部 `localScene` 里的**内容**只保留 `scale`（含负值镜像）、`position` 归零（**粒子为 `-objCenter`，见 §4.4**）、`rotation` 归零（**粒子的 `R(angles)` 由 shader 施加，见 §4.4**）—— 效果因此作用在对象**自身纹理空间**（spec §2.3 论据 b），旋转由合成 quad 施加。`renderOrder` 仍与对象原语义一致（背景 0 / 粒子 1）。

新增访问器（供 stage 使用）：

```ts
isolatedObjects(): Iterable<{ id: number; rtWidth: number; rtHeight: number; rtTexture: THREE.Texture; rt: THREE.WebGLRenderTarget; quad: THREE.Mesh; /* 只读视图 */ }>;
setObjectOutput(id: number, texture: THREE.Texture): void;  // 决定合成 quad 采样谁（id = 对象 id）
resizeObjectRT(id: number, width: number, height: number): void;  // 预算变化时重建 RT（id = 对象 id）
```

（`id` 一律是 `scene.json` 的对象 id，见上面的 `实现偏差`；`rtWidth/rtHeight/rtTexture` 是供编排器读取的扁平字段。）

**合成 quad 的材质必须承接对象原有的混合语义**：

- 对象 `colorBlendMode` ∈ {0, 未实现} → `MeshBasicMaterial({ map, transparent: true, depthWrite: false })`；
- 对象 `colorBlendMode` ∈ {6, 7, 31} → 复用 `colorBlendModeToThree`（`threejs-player.ts:279`）+ 预乘 `ShaderMaterial` + `CustomBlending`，`uniforms.map` = 效果输出纹理。

这样 AGENT.md §5.6 的 `ApplyBlending` 语义**落在合成这一步**（对象 RT 内部是干净的替换写，混合本就该发生在贴回画面时），全库 3 个非零对象（`3743126786` Clouds Back=7、`2832263418` audio_rainbow=6、`2460786246` Clock=31）行为不丢 —— 但这 3 个对象在 P1 里**不进隔离路径**（见下面的守卫），走的是原有非隔离渲染。

> **实现偏差（2026-09-14 回写）**：初稿写合成 quad 用 `opacity` = 对象 alpha、`color` = color×brightness（复用 `materialModulation`）。实际**不能**这样做 —— 内容材质**保留**原有调制（alpha/brightness 已烘进对象 RT），quad 若再乘一次就是**二次调制**（alpha=0.5 → 0.25）。实现的 `createCompositeQuadMaterial(texture, colorBlendMode)` 是**独立构造**的中性材质（`tint=(1,1,1)`、`opacity=1`、只承接混合语义），且**不得 clone 内容材质**：粒子内容材质是 `InstancedBufferGeometry` 专用的 billboard shader（依赖逐实例属性），普通 `PlaneGeometry` 的 quad 没有这些属性 → alpha 恒 0、UV 越界 → 隔离粒子完全不可见。另注：`colorBlendMode ∈ {6,7,31}` **且带 effects** 的对象根本不会进隔离路径（`BLEND_ISOLATION_UNSAFE` 守卫，见 §4.1 与 §9），而不带 effects 的对象本来就不隔离 —— 所以上面这条 `{6,7,31}` 分支在 P1 内**当前不可达**（保留为 P2 解除守卫后的既定接法），实际生效的是「`{0, 未实现模式}` → `MeshBasicMaterial`」与「粒子恒 0」。

### 4.2 帧序

`setAnimationLoop` 帧体（`threejs-player.ts:469-483`）与 `render()`（`:488`）**同步修改**，避免两条渲染入口语义分叉：

```
fn?.(dt)                        // 外部：for (sim of sims) sim.update(dt)
this.update(dt)                 // 内部：updateParticles(dt) 刷新实例缓冲
if (this.isolated.size > 0) this.renderIsolatedContents()  // ← 新增（player 私有方法，非 stage 方法）
stage?.bindOutputs()            // ← 新增
renderer.render(this.scene, this.camera)   // 主场景（含合成 quad）→ canvas
stage?.advance(this.elapsedSeconds())      // ← 新增（异步串行，不阻塞本帧）
```

`stage` 为 null（无任何带效果对象）**或没有隔离条目**时，帧体退化为今天的 `fn → update → render`，**调用序列不变**。

> **实现偏差（2026-09-14 回写）**：初稿伪码写 `stage?.renderContents()`，实际实现**没有这个方法**。隔离内容的渲染（`setRenderTarget(objRT)` + `render(localScene, localCamera)`）需要 **scene / camera**，二者归 player 所有，因此由 **player 自己的私有方法**完成（`renderIsolatedContents()`，且只在 `isolated.size > 0` 时才调用）；编排器只有 `bindOutputs()` 与 `advance(time)` 两个方法（`ObjectEffectStage` 接口在 `object-effects.ts` 与 `threejs-player.ts` 各定义一次、**结构化匹配**，player 不 import 编排器，避免循环依赖）。`render()`（手动渲染一帧的入口）采用**同一条帧序**，避免两个渲染入口语义分叉。

### 4.3 关键取舍：P1 不引入 sceneRT

旧 `scene-renderer.ts` 走「场景 → sceneRT → 效果链 → 贴屏」是因为它要为**全屏**链提供可读的整屏输入。对象级效果只作用于对象自身内容（输入即对象 RT），合成 quad 直接画进主场景即可：

- 省一张全屏 RT 每帧一次额外 blit 与一次 `setSize` 联动；
- 沿用 player 既有的 dpr / canvas 缓冲尺寸 / cover 相机逻辑（`threejs-player.ts:389-394, 412-421, 433-441`），不与旧路径的 `alpha:true` + 不设 pixelRatio（`scene-renderer.ts:326-360`）行为打架；
- 代价明确：P1 的效果**无法读取「对象背后的画面」**。需要读背景的效果（部分 `clouds` / `refraction` 变体）若出现异常，归入 P2 评估并如实记录，不假装支持。

### 4.4 粒子隔离的坐标修正

粒子世界位置在顶点 shader 中为 `worldPos = objCenter + R(angles) · (scale ⊙ (emitterOrigin + local))`（`threejs-player.ts:185`，AGENT.md §2.3 的既定约定）。

> **实现偏差（2026-09-14 回写）**：初稿的修正方向**写反了** —— 初稿说「`uObjectCenter` 在隔离模式下传 `[0,0,0]`」，实际实现是**保留** `objCenter` / `objAngles` 的**原值**，改用 `mesh.position = -objCenter` 承载「中心归零」。根因：顶点 shader 靠 `local = particlePosition - objCenter - bmOffset` **反解**局部坐标，而 `particlePosition` 本就含对象中心（sim 以对象中心为发射基准）；把 `objCenter` 置零会让反解错误（多减一次中心）→ 内容整体出画（局部相机只有对象 RT 那么大，不是「偏移一点」而是看不见）。正确等式：`worldPos(shader) = objCenter + R(angles)·(scale·(emitterOrigin+local))`，叠加 `mesh.position = -objCenter` 后，局部场景中的最终位置 = `R(angles)·(scale·(emitterOrigin+local))`，中心已归零 ✓；合成 quad 再放回 `objCenter`（世界坐标）即还原世界位置。

**连带的旋转分工（初稿未写，实现确认）**：粒子隔离的**合成 quad 不承载旋转** —— 其 RT 内容**已含** `R(angles)`（shader 施加），quad 再转一次就是双重旋转，故 `quadAngles` 传 `[0,0,0]`；**背景**对象的合成 quad **承载**旋转、而内容**不旋转**（`mesh.rotation` 归零）—— 效果因此作用在对象**自身纹理空间**（§2.3 论据 b），旋转由合成 quad 施加。两条路径的「局部原点语义」也不同（背景内容 `position = 0`、粒子内容 `position = -objCenter`），**不可「统一」**（`attachIsolated` 因此增加 `quadAngles` 参数）。

这是本设计最容易静默出错的一处（错了表现为「粒子整块偏移」或「整块出画」），必须有显式单测（§7）。

## 5. 执行语义、降级与性能预算

### 5.1 线性判定与降级

```ts
// 线性可执行 = 链中每个 pass 都不写具名 RT，且 bind 与 EffectRunner 的**固定绑定**完全一致：
//   g_Texture0 = 上一 pass 输出（readTex），g_Texture(j+1) = textureSlots[j]。
// 故判据是「target 非空 **或** 存在不满足 name==='previous' && index===0 的 bind」。
//   - 无 target、bind 为空（如 refraction 的 2 pass）：由 ping-pong 正确实现；
//   - bind: [{ name: 'previous', index: 0 }]：与执行器默认行为同义，线性可执行；
//   - 具名 RT（_rt_*）/ 空名（sampler2D 槽）/ previous 绑到 index≠0：需要 RT 图语义，执行器无法表达；
//   - fbos 只对具名 RT 有意义：链内没有 target 时它没有消费者，**不构成降级理由**。
export function isLinearEffectChain(passes: CompiledEffectPass[]): boolean {
  if (passes.length === 0) return false;
  return passes.every(
    (p) => !p.target && p.bind.every((b) => b.name === 'previous' && b.index === 0),
  );
}
```

> **实现偏差（2026-09-14 回写）**：初稿此处的实现是 `passes.every(p => !p.target && p.bind.length === 0)`（把**任何** bind 都当 RT 图链）。审查确认这是「安全但错」的保守失败：把与执行器默认行为同义的 `previous@0` 也整条跳过，会让那类效果**永久缺失**；且初稿的「bind 为空」与 §2.2 的「是否消费具名 RT」判据自相矛盾。全库实测零误发（所有含 `bind` 的链都引用具名 RT）—— 25/106/9/24 四钉数字**不受影响**，故按精确判据修正。

- **线性链** → 交给 `EffectRunner`（每对象一个实例，`setChains` 时传入对象 RT 尺寸）；
- **RT 图链** → **整条跳过**，该对象合成 quad 回退其对象 RT 原始纹理（对象正常显示、无效果、**不黑屏**），并 `console.warn('[wallpaper-engine] 效果需要具名 RT（P2 未实现），跳过: <标识>')`，**按标识去重**只告警一次（**实现偏差**：初稿写「按 effect 文件去重」，实际去重键是**具名 RT 目标名**（回落顺序 = `pass.target` → 首个 `bind.name` → `'(具名 RT)'`），去重作用域是**每个编排器实例 = 每张壁纸**——同一效果被多个对象引用时只打印一次，切壁纸后重新打印）。

不做「用线性执行器硬跑 RT 图链」的降级：产物是错画面（写错 RT / 读错源），而本仓库既有约定是「未实现就回退，绝不静默画错」（AGENT.md §5.6、`effect-chain.ts:2` 同旨）。

### 5.2 对象 RT 尺寸预算

```
range       = image: objectCameraRange(size, scale)  /  particle: particleObjectRange(spec, scale)
              （**场景像素**，已含 4096 钳制与幅值语义）
world       = image: |size × scale|  /  particle: particleWorldSize(spec, scale)
              （**世界尺寸**，合成 quad 的几何占位；**不钳制**，与 range 不可混用）
dpr         = window.devicePixelRatio（加载期取一次，随 stage 下发；与 player 缓冲一致，
              否则效果分辨率与贴屏不符）
budgetW/H   = 视口 × dpr（= min 的上限，即「贴屏缓冲」的像素尺寸）
finalW/H    = resolveObjectRtSize(range.w, range.h, dpr, budgetW, budgetH)
              = range × dpr 等比缩放至 min(4096, budgetW/H) 内，逐轴下限 1
```

> **实现偏差（2026-09-14 回写）**：实际调用签名是 **`resolveObjectRtSize(range.w, range.h, dpr, budgetW, budgetH)`**，第 3 参**必须是 dpr**。`range` 是**场景像素**，**要乘 dpr** 才能与「贴屏缓冲 = 视口 × dpr」同分辨率；`budgetW/budgetH` 是「视口 × dpr」的缓冲像素，作为上限（`three-renderer.ts` 侧算好用 `dpr` 构造 stage，resize 时由 `onViewportResize(budgetW, budgetH)` 更新）。计划文本曾在调用点写死第 3 参为 `1`（等于不乘 dpr）——那会让 dpr=2 的屏幕上对象 RT 只有一半分辨率（效果发糊）且与贴屏不一致，实施时按本节语义订正为 `dpr`。

**等比缩放而非逐轴独立 clamp**：逐轴独立会把 `8192×4608` 压成 `4096×4096`，破坏依赖 aspect 的效果（竞品 `docs/perf-audit-2026-08-29.md` 记录的真实事故 N-06）。

预算随视口变化（`resize` / `setSceneSize`）时，由 stage 重算并调用 `player.resizeObjectRT(id, w, h)`；`uvWindow` / `createCompositeGeometry` 负责把钳制轴映射回未钳制的世界尺寸（`blurprecise` 类大对象不会因钳制而「缩小摆放」）。

### 5.3 执行与生命周期约束

- **加载期一次性完成**（AGENT.md §5.11 硬约束）：链解析（`resolveEffectChain`，多次 `loadFile`）、`EffectRunner` 创建、`setChains` 与探针编译全部在加载阶段；帧内只写 uniform + 提交 pass，**不得**在 `bindOutputs` / `advance` 中做 naga/WGSL 编译或建管线。（**实现偏差**：初稿此处还列了 `renderContents`，实际实现**没有这个方法** —— 隔离内容的渲染由 player 的私有 `renderIsolatedContents()` 承担，见 §4.2。）
- **串行推进**：`advance` 用**显式串行队列**（`busy` + `queue`：空闲时同步发起本帧第一项，忙时排队、前一项 settle 后再发起；单项失败只 `console.warn`，不拖垮整条链）保证同一时刻只有一个 runner 触碰 renderer 的 RT 与绑定状态——并发交错会导致黑屏/闪烁（`scene-renderer.ts:489-500` 已踩过）。每 runner 内部 `updateInFlight` 只挡得住同一个 runner，**挡不住多个 runner 之间**，故串行化必须由编排器承担；未完成时本帧保留上一输出。
- **链 / 条目竞态**：初稿写「沿用 `PendingChainStore`」，**实际实现删除了这条暂存路径**（**实现偏差**）：两处调用都以字面 `false` 调用 `applyIfReady`、全类无 `take`，是「宣称处理了竞态、实际静默丢弃」的死状态机；现改为**加载期接线顺序契约**（`three-renderer` 先 `setWorldSize` 再 `setObjectChains`，且 player 在 `loadSceneToThree` 内已建好隔离条目）——找不到隔离条目就 `warnOnce` 明确告警一次，绝不静默。`PendingChainStore` 类本身仍是 `object-range.ts` 的共享导出，未接入的 `scene-renderer.ts` 的既有用法不受影响。
- **失败隔离**：单 pass 编译失败 → 跳该 pass（`EffectRunner` 探针已实现）；整链不可用 → 该对象回退原始内容；**任一对象失败都不影响其他对象与整张壁纸**（不触发壁纸级回退——画面本身已有效）。
- **颜色混合守卫**：`colorBlendMode ∈ {6,7,31}` 且带 effects 的对象**不走隔离路径**（RT alpha 语义冲突，见 §4.1 与 §9）：效果不生效但对象保持可见（与改动前一致）+ `warnOnce`，由 `three-renderer` 在算 `isolate` 时排除。
- **释放**：`dispose` 顺序 = stage.dispose()（runner/材质/纹理槽缓存）→ player.dispose()（RT/quad/geometry/localScene）。

### 5.4 音频与指针 uniform

`EffectRunner` 支持 `setAudioSpectrumSource`（`effect-runner.ts:171`）与音频数组 uniform 注入，但**three 主路径没有任何音频源**——`createAudioAnalyzer` / `playWallpaperSound` 只被未接入的 `scene-renderer.ts:12, 782-793` 引用。因此 `Simple_Audio_Bars`（2 壁纸）、`audioline` 等音频响应效果在 P1 是「**效果在、但不随频谱动**」（uniform 保持 binder 初始化的全零）。

- P1 **不接音频**（保持零变化、避免引入新失败面），但在 spec 与 AGENT.md §7 中**如实标注**；
- 指针 uniform（`g_PointerPosition` 等）同样不做，鼠标交互类效果按现有语义执行（静态位置）。

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| effect.json / material / shader 缺失或 JSON 非法 | `resolveEffectChain` 返回 null → 该对象不建链（原样显示），`console.warn` |
| 链含具名 RT / 非默认 `bind`（RT 图链） | **整链跳过** + 去重 `console.warn`（§5.1） |
| shader 编译失败 | 跳该 pass（1×1 探针 + `renderer.debug.onShaderError`）；全部 pass 失败 → 对象回退原始内容 |
| 纹理槽加载失败 | 跳该槽（`effect-runner.ts:330-333` 已有），采样回退 three 默认纹理 |
| 对象 RT 尺寸退化 | `objectCameraRange` 已保证 ≥1；预算计算再取 `Math.max(1, round())` |
| 视口 resize 期间 | stage 按新预算重算尺寸并 `resizeObjectRT`（含**链全被跳过、没有 runner** 的隔离对象），有 runner 的再重挂链（**实现偏差**：初稿写「继续采样旧纹理」——实际 `setChains` 会 dispose 旧 ping-pong RT，故重挂后**显式回退到对象 RT 原图**，避免整个纹理槽重载窗口内采样已释放纹理） |
| `colorBlendMode ∈ {6,7,31}` 且带 effects | 该对象**不进隔离路径**（RT alpha 语义冲突，§5.3/§9）：效果不生效、对象保持可见 + 一次 `warnOnce` |
| 效果挂在 util / 音频等不参与渲染的对象类型 | 解析但不挂链（无隔离条目），**每张壁纸一条汇总 `warn`**（`N 条效果挂在未参与渲染的对象类型上（util/音频），已跳过`） |
| 无 effects 的壁纸 | `stage` 为 null，帧序与今天完全一致（零回归路径） |

## 7. 测试策略与验收

### 7.1 单元测试（node 环境，TDD）

新增：

- `tests/object-range.test.ts`（**13 项**）：搬移后的纯函数**回归既有断言**（`objectCameraRange` 幅值/钳制、`particleObjectRange`、`particleWorldSize`、`uvWindow`、`createCompositeGeometry`、`groupEffectsByObject`、`materialModulation`、`coverRange`）；
- `tests/object-effects.test.ts`（**24 项**）：
  - `isLinearEffectChain`：全库 130 条链的分类断言（**25 种/106 次线性 / 9 种/24 次 RT 图**，钉住数字；含 `previous@0` 属线性的判据用例）；
  - `resolveObjectRtSize`：等比 clamp、dpr 参与、4096 与画布预算上限、退化下限 1；
  - `ObjectEffectStage` 编排（mock renderer + mock runner）：**挂链**、**降级跳过（具名 RT 图链整链跳过 + 按标识去重告警）**、**链未就绪回退（runner 无输出时不动输出、采样对象 RT）**、**串行推进**（跨 runner 不重入）、**resize 重算尺寸并重挂链/回退输出**、**`dispose` 释放全部 runner**。
- `tests/threejs-player.test.ts`（**65 项**）：隔离路径的 T·R·S / 合成 quad / 访问器 / 零回归（不传 `isolate` 时调用序列逐字一致）；
- `tests/three-renderer.test.ts`（**17 项**）：装配侧断言，含一条用 **`vi.importActual` 跑真实 `loadSceneToThree`** 的「对侧」接线用例（此前两侧都被同一条 mock 隔离，任一测改建层条件/顺序都会让新用例变红）。

> **实现偏差（2026-09-14 回写）**：初稿把编排器测试写成断言「`renderContents` → `bindOutputs` → `advance` 调用顺序」，实际无 `renderContents` —— 该项被替换为上面列出的编排器行为断言（挂链 / 降级去重 / 链未就绪回退 / 串行推进 / resize / dispose）。测试文件与项数也按实际产出补齐（13 / 24 / 65 / 17）。

回归：`tests/scene-renderer.test.ts`（搬移后 import 路径变更）、`tests/effect-runner.test.ts`、`tests/shader/effect-chain.test.ts`、`tests/verify-real-library.test.ts`（全库效果链解析零失败 + 数量断言）。

### 7.2 player 隔离模式（jsdom）

`tests/dom/threejs-player.dom.test.ts`（或并入既有 `tests/threejs-player.test.ts`）：

- 传 `isolate` → 内容进 `localScene`、主 scene 出现合成 quad、`isolatedObjects()` 可见（`id` = 对象 id）、quad 的 T·R·S 与对象一致（**背景**路径；粒子路径的 quad 不承载旋转，见 §4.4）；
- **不传 `isolate` → 帧调用序列与今天逐字一致**（零回归断言）；
- 粒子隔离时 `objCenter` / `objAngles` **保留原值**、`mesh.position = -objCenter`（§4.4 的显式单测；**实现偏差**：初稿写的是断言 `uObjectCenter` 为 `[0,0,0]`，方向相反）；
- `colorBlendMode` ∈ {6,7,31} 的合成 quad 使用 `CustomBlending` 且 premultiplied 着色器（**直接对 player 调 `addBackground({ isolate, colorBlendMode: 7 })` 断言** —— 生产接线里该组合被守卫排除，见 §4.1/§9，故此用例锁的是 P2 解除守卫后的既定接法，不是今天的实际渲染路径）。

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
- **`colorBlendMode ∈ {6,7,31}` 与对象级 RT 的 alpha 语义冲突**（**P1 用守卫排除，根本修法留 P2**；见 §4.1 / §5.3）：这三类模式的内容材质把结果 alpha 钉成「背景的 alpha」（`blendSrcAlpha=Zero / blendDstAlpha=One`），而对象 RT 是新清空的缓冲（alpha 0）⇒ RT alpha 恒 0 ⇒ 合成 quad 片元被乘成 0 ⇒ 对象会**整体不可见**。P1 让「该混合模式 **且** 带 effects」的对象**不走隔离路径**：**效果不生效、但对象保持可见**（与改动前一致）+ 一次 `warnOnce`；根本修法是重定隔离语境下的 alpha 语义（内容材质应正常写入自身 alpha）。全库仅 3 个对象命中：`3743126786` Clouds Back=7、`2832263418` audio_rainbow=6、`2460786246` Clock=31；
- 粒子 quad 自旋 `rot`（AGENT.md §7.3 既有遗留）。

**P2 方向（预留，不在本 spec 实现细节）**：把 `CompiledEffectPass` 已有的 `target` / `bind` / `fboScale` 消费起来——按 `fbos[].scale` 建具名 RT 池，pass 按 `target` 选写端、按 `bind` 选读端（`previous` = 上一 pass 输出），降采样 RT 尺寸 = 基础尺寸 / scale（下限 1）。three 是 WebGL，无需 wasm 侧的 GLSL→SPIR-V→WGSL 链，直接复用 `EffectRunner` 的材质/探针机制即可。

## 10. 遗留与风险（开工前如实记录）

1. **`EffectRunner` 类本体零单测覆盖**（node 无 WebGL），P1 的编排层可测，但**执行器本体的正确性依赖端到端验证**（§7.3）；
2. **对象 RT 显存**：全库最重壁纸 23 个对象，若每个对象 RT 都接近屏幕尺寸，显存与带宽会明显上升；§5.2 的等比预算只解决单对象上限，**多对象总预算**留作实测后按需补（先用 `1429403119` 压测）；
3. **headless Edge 的 WebGL 走 SwiftShader**（AGENT.md §7.10），性能数据需在真实 GPU 上复核；
4. **`refraction` 归类为线性链**（2 pass、无 target/bind）是按 `previous` 默认语义判定，需在 M4 用真实壁纸验证；若实测异常则移入 P2 并记录；
5. **文档与代码不一致的历史包袱**：AGENT.md §5.10 原记 `OBJECT_RT_MAX=2048`，代码实为 **4096**（`effect.rs:225`、`object-range.ts:15`）——本文档以代码为准。**2026-09-14 已订正** AGENT.md §5.10（并注明 wasm 侧与 three 侧同为 4096）。
