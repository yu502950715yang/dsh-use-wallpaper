# SceneScript 运行时（模块脚本 + 图层状态桥）— 设计文档

- 日期：2026-09-22
- 状态：**设计已确认，待写实施计划**（用户 2026-09-22 确认：范围=通用 SceneScript 运行时；验收=画面级+零回归+可降级；架构=方案 B 数据驱动状态表）
- 项目根：`E:\code\dsh-use-wallpaper`
- 关联：
  - 上游动机：壁纸 `3798688689`「直到大地变成一颗酸橙(有切换特效喵)」**静止不动**（根因分析见 §1）
  - spike 产物（throwaway，均在 `research/`，未提交）：`_spike-l1-run.mjs`、`_spike-l1-scan.mjs`、`_spike-l2a.mjs`、`_spike-l2b-state.mjs`、`_spike-l2b-make-variant.mjs`、`_spike-verify.mjs`（生成）、`_scan-visible-script.mjs`
  - `src/client/text-script.ts`（模块脚本 VM 的先例：剥 export + IIFE + 异常隔离 + handle 生命周期）
  - `src/client/scene-script.ts`（class 风格旧运行时，**本设计不扩展它**，理由见 §9）
  - `src/client/three-renderer.ts`（装配点）、`src/client/threejs-player.ts`（帧序）
  - `research/verify-text/util-as-image-report.md`（2026-09-21 的 util-当-image 实验，解释"那 16 条链挂了也没用"）

## 1. 概述

壁纸 `3798688689` 在 three 生产路径下**几乎完全静止**：实测 g_Time 跨 40 秒只有 **0.53%** 像素变化（集中在角色发丝/衣物），而壁纸设计上的粒子、切换特效、浮动、音频响应、歌名字标切换**全都不发生**。

根因**不是**帧循环或效果链，而是：**这张壁纸的全部动画逻辑写在 17 个 WE SceneScript 里**（4 个控制器 + 10 个歌曲字标 + 2 个时钟 + 1 个切歌按钮），而本引擎

- 从不执行 `visible.script`（[visibility.ts:64-65](src/client/visibility.ts#L64-L65) 对 script 绑定直接返回 `value`；[three-renderer.ts:350-352](src/client/three-renderer.ts#L350-L352) 只对 text 调 `resolveVisibility`）；
- 且 4 个控制器**全部挂在 `models/util/*` 上**，而 util 对象不参与渲染（[scene-renderer.ts:715](src/client/scene-renderer.ts#L715)），因此即使实现了 `visible.script`，也只对"参与渲染的对象"生效的话依旧不会跑到它们。

本文实现一个**通用的 SceneScript 运行时**：执行模块风格脚本（`export function init/update/applyUserProperties/cursorClick`），把脚本对"图层"的写入变成**纯数据状态表**，由渲染侧应用器落到 three 对象上。

## 2. 事实基础（spike 实测，2026-09-22）

### 2.1 脚本能吃下（L1：quickjs + 记录型 stub）

| 脚本 | 体积 | eval | init | update/帧 |
|---|---|---|---|---|
| `94000` 场景控制器 | 348 KB | 37–130 ms | **61 ms ✓** | 4.10 ms\* |
| `92000` 粒子控制器 | 26 KB | 55 ms | **19 ms ✓** | 4.17 ms\* |
| `93000` 信封拖尾 | 24 KB | 6 ms | 0.08 ms ✓ | 0.04 ms\* |

\* 带 Proxy 记账的版本；**去掉记账后四个脚本合计 2.33 ms/帧**。

**必需的宿主内置类型**（缺任一个 init 直接 `ReferenceError`）：`Vec3`、`IModelData`（`POSITION/UV/COLOR` 顶点格式枚举）。其余宿主面收敛为：

- `thisScene.{getLayerByID, getLayer, createLayer, createModelData}`
- `layer.{alpha, visible, baseAlpha, origin, angles, scale, color, getAnimation, getEffect, setMaterialProperty}`
- `animation.{play, pause, stop, isPlaying, setFrame, getFrame}`
- `effect.{visible, setMaterialProperty}`
- `engine.{frametime, userProperties, registerAsset}`
- `shared.*`（脚本间通信）、`console.*`

### 2.2 脚本真的在驱动画面（L2a：同一 ctx、共享 `shared`）

四个脚本必须**同一 quickjs 上下文**、按 `objects` 顺序（`92000 → 93000 → 94001 → 94000`）执行，因为它们靠 `shared.we2dScene/we2dTransition/we2dFx/we2dManaged` 互通。实测：

- 80 个动画播放器、75 个在播；`getFrame()` 随帧正确推进（29 → 299 → 2699）；
- **5s → 45s**：50 个图层 opacity 变化（装饰线循环 alpha 0→1）；
- **模拟点击** `94001.cursorClick()` → `shared.we2dSwitchScene()` → `transitionName=act53side_trans_kv2tokv1`、`transitionTime` 0→0.117 连续推进，立刻翻转 **22 个 shown + 5 个 opacity + 9 个 state**；
- **fps 是逐动画的**：`loops[].fps=60` 而 `paperTimelines[].fps=1200`；spike stub 统一按 60 推进 ⇒ 过渡慢 20 倍（140 帧只走 0.1167 秒 = 140/1200）。详见 §6.2。

### 2.3 状态能变成像素（L2b：状态烘焙进 scene.json 后渲染）

把脚本对每个图层的最终写入映射到 `scene.json` 对象（映射 `id = 1000 + order`，**308/308 条与对象 name 校验一致**），再喂给生产 `lib/` 渲染：

| 对比（1280×720，阈 ≥8/255） | 变化像素 | 占比 |
|---|---|---|
| **脚本接管 vs 现状**（同为 g_Time=5s） | 908 512 / 921 600 | **98.58%** |
| **脚本状态下 5s → 45s** | 18 559 | **2.01%** |
| 现状 5s → 45s（对照） | 4 860 | 0.53% |

- 写入 566 个图层，其中 **508 / 527 个 scene.json 对象**可映射（余 58 个是 `92000` 运行时新建的粒子层，`scene.json` 里不存在）；
- 脚本接管后画面正确显示 **kv2「反重力」场景**（对比基线是加油站在地场景）——即修正了"kv1+kv2+trans 全图层叠加"的错误初始状态。

### 2.4 全库依赖面（决定通用性）

| 指标 | 数值 |
|---|---|
| 有 `visible.script` 的壁纸 | **4 / 29**（`3798688689` 15 个对象 / 406 KB；`2832263418` 3 个；`3789452668` 1 个；`2937346640` 1 个） |
| 有 `models/util/*` 对象的壁纸 | 7 / 29（34 个对象） |
| 有 `text.script` 的壁纸 | 8 / 29（已实现） |

⇒ 机制是通用的，但**重度用户只有 `3798688689`**；另外三张是同一语义的轻量脚本。

## 3. 范围

**做**：通用 SceneScript 运行时；模块脚本装载与异常隔离；图层状态表与应用器；动画播放器（含 fps 契约）；点击事件派发；`shared` 跨脚本共享；`util` 对象上的脚本也执行。

**不做（一期明确排除）**：

1. `thisScene.createModelData` / `createLayer` 的**真实**实现 —— `92000` 的粒子与 `93000` 的拖尾走的是"脚本自算粒子 + `Float32Array(420×36)` 顶点缓冲 + `createModelData`"路径（58 个动态层，`scene.json` 无对应对象），单独立项。
2. `models/util/*` 的**合成层渲染** —— `500/510` 的 `video`/`spin`/`opacity` 三条链属切换特效的视觉主体，依赖 util 合成层语义。
3. `layer.getEffect(name).visible` **生效**（`kv1_character_motion` 等分类开关）。
4. 音频频谱驱动（`g_AudioSpectrum*` / `kv1_audio_response`）。
5. `wasm-renderer.ts` 路径的接入（本期只接 three 生产路径；状态表本身与渲染解耦，为将来留口）。

## 4. 架构与模块

**方案 B：数据驱动状态表。** 运行时不持有 three 对象，只产出纯数据；渲染侧一个应用器每帧消费。

```
scene.json ──parseSceneJson──► SceneObject[]（含 util 的 visible.script / text.script）
                                     │
three-renderer.render(id, fg)
   ├─ 建 objectId → three 对象映射（background quad / isolated quad / text / particle）
   ├─ SceneScriptHost.load(scripts, engineUserProps)   ← 单 ctx，按 objects 顺序 init
   └─ player.setAnimationLoop(fn) 里插入一帧钩子：
        animRegistry.tick(dt)  →  各脚本 update()  →  LayerStateTable  →  applier.apply()
```

**新增**

| 文件 | 职责 |
|---|---|
| `src/client/scene-script-vm.ts` | 单 quickjs ctx；按 objects 顺序装载模块脚本（剥 `export` + IIFE）；注入宿主 API；逐脚本 try/catch 隔离；`dispose` 释放 handle（防 `gc_obj_list` 断言） |
| `src/client/scene-anim.ts` | 动画播放器注册表：`getAnimation(layerKey, name)` 返回**持久**对象；`play/pause/stop/isPlaying/setFrame/getFrame`；`name → fps` 表（来自脚本源码内嵌 config，§6.2）；每帧 `tick(dt)` 推进 `frame += fps × dt` |
| `src/client/layer-state.ts` | `LayerStateTable`（纯数据：`Map<objectId, {origin?, scale?, angles?, alpha?, visible?}>`）+ `applyLayerState(table, lookup)` 应用器 |
| `src/client/scene-script-host.ts` | 编排：装载 → 帧序 → 应用 → 降级 |

**改动**

| 文件 | 改动 |
|---|---|
| [three-renderer.ts](src/client/three-renderer.ts) | 收集脚本（**含 util / 非渲染对象**）；建 `objectId → three 对象` 映射；装配 `SceneScriptHost`；帧钩子；dispose 时释放 |
| [threejs-player.ts](src/client/threejs-player.ts) | 新增**按 scene 对象 id** 取背景/隔离条目 three 对象的只读访问器（现有 `backgroundEntries`/`particleLayers` 按**图层计数器 id** 索引，`isolate`/`ObjectEffectStage` 按 **scene 对象 id** 索引 —— 不能重蹈 [three-renderer.ts:517-522](src/client/three-renderer.ts#L517-L522) 记录过的那层脆弱翻译） |
| [scene-json.ts](src/client/scene-json.ts) | `util` 分支也产出 `script`/`scriptProperties`（现在只对 image 的 `visible.kind==='script'` 派生） |

## 5. 宿主 API 契约

| API | 一期语义 |
|---|---|
| `thisScene.getLayerByID(id)` | 返回图层句柄；`id = 1000 + config.nodes[].order`（实测 308/308 与 `scene.json` 对象 name 一致）。未匹配到渲染对象时返回**哑句柄**（写入仍进状态表，但不应用） |
| `thisScene.getLayer(name)` | 按名查（`221591` 用）；查不到同上 |
| `layer.{alpha, visible, baseAlpha, origin, angles, scale, color}` | 读改写落在**状态表**；`origin/angles/scale/color` 接受 `Vec3` 实例 |
| `layer.getAnimation(name)` | **持久、有状态**播放器。fps 取自装载期从脚本源码提取的 `name → fps` 表（§6.2），`getFrame()` 由引擎推进 |
| `layer.getEffect(name)` | stub：返回 `{visible, setMaterialProperty(){}, getMaterialProperty(){return 0}}`，不抛错 |
| `thisScene.createLayer(opts)` / `createModelData(opts)` | stub：返回哑对象（`applyData`/`setParent`/`setMaterialProperty` 空实现）。**保证脚本不崩**，粒子留二期 |
| `engine.registerAsset(path, bool)` | 记录并返回哑资产对象 |
| `engine.frametime` | 当前帧 dt（秒），与 player 同源 |
| `engine.userProperties` | `project.json` 的 `general.properties` 值表（**过滤掉内嵌 base64 长值** —— 否则注入源码会打爆快速解析栈，spike 实际踩到） |
| `Vec3` / `IModelData` | 内置类型与枚举 |
| `shared.*` | 单 ctx 内同一对象；脚本间通信靠它 |
| `console.{log,warn,error}` | 转发（可选：生产静音，调试开关打开） |

## 6. 关键语义

### 6.1 `visible` 折算（零回归决策）

脚本写 `layer.visible=false` → 应用器写 **`alpha=0`**，**不改**引擎现有的可见性过滤（现状对 image/particle 一律不过滤，全库 **121 个 `visible:false` 对象**照画，分布在多张壁纸）。理由：改动过滤会改变这些壁纸的既有画面，与"零回归"验收冲突；spike 用该折算拿到了 98.58% 的画面修正，等价性已被实测覆盖。目标是 `util` 时只跑脚本、不做任何渲染应用。

### 6.2 动画播放器 fps 契约（本设计最容易做错的一处）

脚本用 `animation.getFrame() / record.fps` 换算秒，所以播放器必须以**该动画自身的 fps** 推进。

**实测事实**（`94000` 的 config）：`loops[].fps = 60`（装饰线循环），`paperTimelines[].fps = 1200`（信封过渡，`duration = 2.1667` 秒），**同一张壁纸内相差 20 倍**。spike 的 stub 统一用 60 推进，结果 140 帧只走了 **0.1167 秒**（= 140 / 1200），过渡比真值慢 20 倍 —— 而画面"看起来仍然在动"，**不会报错**。这是最容易误判为"已完成"的缺陷。

**fps 数据源**：实测 `scene.pkg` 内**没有**动画数据（691 个条目：458 json / 176 tex / 26 frag / 26 vert / 5 flac，**0 个动画文件、0 处 `fps` 字样**；`models/layers/*.json` 只有 `autosize` + `material`）。`clips[].tracks[]` 也**不含** fps。

⇒ 唯一可得来源是**脚本源码内嵌的 config**（`loops[].{name,fps}`、`paperTimelines[].{name,fps}`、`clips[].{name,dur}`）。实现策略：

1. 装载期从脚本源码提取 `动画名 → fps` 表（config 是标准 JSON；按 `"name":…,"fps":N` 配对提取，比整体解析更稳）；
2. 提取不到的动画 → 兜底 60 并 `warn` 一次（避免又一轮静默 20 倍速差）；
3. **验收断言**：`clip.dur = 2.1667` 的过渡，其墙钟时长必须 ≈ 2.167 秒（而不是 43 秒）—— 这条断言是"fps 契约实现正确"的唯一可观测证据，必须进 e2e。

### 6.3 帧序

```
animRegistry.tick(dt)          // 先推进播放器（advanceFrame 的时间源）
→ 按 objects 顺序 各脚本 update()
→ LayerStateTable 脏项 → applier.apply()
→ 原有 player.update(dt) / render()
```

### 6.4 降级

- `eval` 失败 → 该脚本不装载；
- `init` / `update` / `cursorClick` 抛错 → 该脚本停用，`console.warn` 一次（不刷屏），**其余脚本继续**；
- 全部脚本不可用 → 状态表为空 → 画面等于现状（即"脚本没接上"）；
- 运行期脚本抛错**不得**中断 player 帧循环（沿用 [threejs-player.ts:601-622](src/client/threejs-player.ts#L601-L622) 的整帧 try/catch 语义）。

## 7. 测试与验收

**纯逻辑单测（node）**：VM 装载/异常隔离/`dispose` 无 handle 泄漏；播放器 fps 推进与持久性；状态表写入合并与脏判定；applier 的 id 映射与 `visible→alpha` 折算。

**集成单测（jsdom）**：装配期建立了 `objectId → three 对象` 映射；util 对象**被装载但不被应用**；`dispose` 后脚本不再被调用。

**e2e（headless Edge + 生产 `lib/`，复用 `research/verify-hidpi-object-rt.mjs`）**：

1. `3798688689` 画面从基线的"加油站在地"变为 **kv2 反重力场景**（对照基线 ≈98.6% 像素改变）；
2. 点击触发切换：`transitionName` 置位、`transitionTime` 推进、shown/opacity 翻转；
3. **`2832263418` / `3789452668` / `2937346640` 与改动前逐像素不变**（零回归的直接证据）；
4. `console error = 0`；
5. 单帧脚本开销 **< 3 ms**（spike 空 stub 实测 2.33 ms）。

## 8. 未验证 / 风险（如实）

1. **没有在真实帧循环里跑过脚本** —— spike 是"离线跑脚本 + 状态烘焙"，验证了"状态→像素"，**未**验证每帧桥接的实时开销（含真实属性写回、脏判定、Map 往返）。
2. **`92000` 的 58 个粒子层与 `93000` 的拖尾完全未验证**（一期明确不做）—— 这张壁纸的粒子/拖尾在二期前仍不会出现。
3. **10 个歌曲字标 + `221591` + `701/837` 的脚本一期未跑**（spike 只跑了 4 个控制器），故歌名字标仍会重影；实施时须一并纳入（它们各自是独立脚本）。
4. **`layer.getEffect().visible` 一期是 stub** → 角色动态开关不生效。
5. **fps 表的提取依赖脚本内部结构**（§6.2）：`loops[].fps` / `paperTimelines[].fps` 是这张壁纸的写法，其他壁纸的 config 结构可能不同；提取失败会退到兜底 60 ⇒ 过渡/循环速度可能偏差。这一点必须用"墙钟时长 == `clip.dur`"的断言兜住。
6. 性能数字 2.33 ms/帧是**空 stub**；真实实现大概率更高，3 ms 预算有超支风险。

## 9. 与既有设计的关系

- **不扩展 `src/client/scene-script.ts`**：它服务的是「每个对象一个 `class extends IThisPropertyObject` 实例 + 每帧读回 `this.image.alpha`」的旧 wasm 路径语义，与本壁纸的「单一全局控制器 + 模块导出函数 + `thisScene` API」形态不同；混在一起会让两类语义互相污染。它保持现状（wasm 路径继续用）。
- **与本设计并存**：[text-script.ts](src/client/text-script.ts) 的 text 脚本运行时保持不动；本期只把它**没覆盖**的 `visible.script` 与 util 对象纳入新运行时。两者共享同一个 quickjs 依赖，但不共享 ctx（text 路径是模块级单例，语义不同）。
- **不推翻任何既有裁定**：本文只补一个从未实现的 WE 语义（`visible.script` 执行）。
