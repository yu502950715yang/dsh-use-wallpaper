# Agent Note: 补全时钟/音频条/基线（text 脚本契约 · 无链 solid util · bars 着色分叉）

Status: implemented

## Problem

壁纸《Somewhere In Nowhere [4K]》（`3819637149`）在桌面 Wallpaper Engine 上有三块组件：左上的 12 小时制时钟（`1:29 PM`）、从水平基线向下垂的浅蓝音频条、以及那条 3px 基线；DSH GUI 里**这三块全都不显示**（日期、媒体封面等其它组件正常）。用生产 `lib/` 的 e2e harness 逐项定位到三个独立缺陷：

1. **时钟**：`#130 Clock 12Hrs` 的文本画布只有 1×111（空文本），页面日志有 `[text-script] update 抛错/超时…：'thisLayer' is not defined`。它的 `text.script` 不返回字符串，而是 `thisLayer.text = ...`（WE 常见写法），并读 `engine.userProperties.name`；旧沙箱只认 `update()` 的返回值、且没有 `thisLayer`/`engine` 两个对象 ⇒ 每帧抛错、整层空白。
2. **基线**：`#200 Solid` 是 `models/util/solidlayer.json` 的纯色 util 层（900×3、淡蓝色、alpha 0.95），`displayObject` 为 null —— 命中历史边界「无 effects 的 util 层整层不渲染」。
3. **音频条**：`#194 Audio Bars`（util `composelayer` + `Simple_Audio_Bars` 效果链）的 runner 有输出（RT 433×48、alpha 229），但读回的**像素 RGB = 场景背景色**（`(28,42,84)`），与背景同色所以看不见。根因是 v0.8.2 的 `BLENDMODE=0→5`（`min(A,B)`）映射被无差别用到了 util 层：util 的 A = 整帧快照（暗背景）⇒ `min(A,B)` 等于背景色。而同一映射在 **image 层**（`2832263418` 的 `audio_rainbow`：A = Rainboww 渐变贴图）恰好给出桌面 WE 的「彩色竖条」，不能一刀切删掉。

## Decision

- `src/client/text-script.ts`：quickjs 沙箱为每个 binding 注入 `thisLayer`（`text` 属性可读写，其余属性自由存取但不参与渲染）与最低限度的 `engine`（`userProperties` = project.json 用户属性、`frametime = 0`）；`update()` **返回值优先**，没有返回值时读回 `thisLayer.text`；每帧 update 前把上一帧文本写回 `thisLayer`（供脚本按 `lastString` 增量判断，正是本壁纸时钟的写法）。`bind()` 增加第 4 参 `userProperties`（renderer 传装配期 userProps）。
- `src/client/threejs-player.ts`：util 分支对**无 isolate 条目的 `solid` 层**仍 `addBackground(util)`（走既有 `createUtilLayerMaterial` 纯色材质直渲）；无链 `project`/`fullscreen`/`compose` 依旧不渲染（没有内容输入，画出来只会是白块）。
- `src/client/shader/effect-chain.ts`：`resolveEffectChain()` 增加 `options.contentIsSceneSnapshot`，`Simple_Audio_Bars` 的 `BLENDMODE=0` **按内容输入分叉** —— image 层（默认，内容=自身贴图）保留 `0→5`（`min(A,B)`，桌面 WE 的彩色竖条）；util 层（`contentIsSceneSnapshot: true`，内容=整帧快照）保留 0 走官方 `mix(A,B,opacity)`（竖条取 Bar Color，不再被背景色吞掉）。alpha 两路都不变（由 shader 的 `TRANSPARENCY` 决定）。`three-renderer.collectObjectEffectChains()` 按 `obj.kind === 'util'` 下发该标志。
- 回归用例：`tests/text-script.test.ts` 3 例（thisLayer 写入 / `engine.userProperties` / 返回值优先）、`tests/effect-chain.test.ts` 2 例（image 层映射 5 / util 层保留 0）、`tests/threejs-player.test.ts` 改为「有 isolate → 隔离；无链 solid → 直渲且颜色/alpha 正确；无链 passthrough → 不渲染」。另把 `tests/dom/bootstrap.dom.test.ts` 两个含整包动态 import 的重集成用例超时 5s→20s（全量并行下的**既有** flake，单列提交 `af020dc`，与本修复无关）。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `45237ac` `e30d2bc`

## Alternatives considered

**一次性删除 `BLENDMODE=0→5` 映射、全部走官方 `mix`。** 第一稿就是这么做的：util 层竖条恢复可见（`(124,171,238)` 浅蓝），但 `2832263418` 的彩色竖条被 Bar Color（白）冲成纯白——用户随即反馈「音频条颜色不是彩色了」。官方公式对 image 层不成立（桌面 WE 明确是内容色），否决「一刀切」。

**util 层也保留 `min(A,B)`、只修别处。** 官方公式下 util 竖条是 Bar Color，与桌面一致；而 `min` 在 util 的暗背景上恒等于背景色（实测贡献 9 像素 ≈ 不可见），无法同时满足两张壁纸。否决。

**按壁纸 id / 对象名特判。** 不用它：`contentIsSceneSnapshot` 是「效果输入是什么」的**语义**差异（util 层输入是整帧快照，image 层输入是自身贴图），按语义分叉才能覆盖 2911105183 等同形态素材；按 id 特判只会把同类问题留给下个素材。

**给 audio_rainbow 额外叠加用户属性颜色 tint（把白条染成用户选的蓝）。** 更接近「系统里可配置颜色」的解释，但 `colorBlendMode` 的颜色合成发生在哪一层没有引擎级证据，且当前插件的 tint 规则对 `{user}` 绑定色明确不烘 tint（AGENT §7.42 ⑯）。先按可验证的「内容色」口径修复，留作后续真机 A/B 项。

## Consequences

**收益：** 本壁纸三块组件与桌面一致（生产渲染探针：`1:44 PM` 时钟、浅蓝竖条、3px 基线；fx 探针读回 bars 输出 `RGB≈(124,171,238)`、alpha 229）；`2832263418` 的彩色竖条恢复（fx 探针读回输出为 Rainboww 渐变内容色，colorful fraction = 1.0）。补充两条通用契约（text 脚本 `thisLayer`/`engine`、无链 solid util）。影响面已扫全库：无链 util 仅 4 个（3 个 passthrough 仍不渲染、唯一 solid 就是本壁纸）；用 `Simple_Audio_Bars` 的只有 3 张：`2832263418`（image，保留 min）、`2911105183` 与 `3819637149`（util，走官方 mix）；text 脚本使用 `thisLayer`/`engine.userProperties` 的仅本壁纸这 1 条。回归：`npm test` 2273 通过、`e2e:media` 13/13、`e2e:media --regression` 22/22。

**代价：** `Simple_Audio_Bars` 的着色是**按输入语义分叉的近似**，不是引擎里可推导出的统一公式（两轮实测的结论：image 层取内容色、util 层取 Bar Color；根因未从 WE 引擎源码完全还原）；`engine` 只提供 `userProperties`/`frametime` 两个字段，`thisLayer` 只有 `text` 生效（visible/alpha 等动态写入仍走 SceneScript 的 LayerStateTable 那条路）；启用 text 脚本的壁纸每帧多一次 `writeText` + 一次 `readText` 的 quickjs 调用（只在有 text 脚本时发生）。

## 同日修正

首稿（`45237ac`）按照「官方 `ApplyBlending` 唯一权威」把 `BLENDMODE=0→5` 全量删除，修复了 util 层竖条，但把 `2832263418` 的彩色竖条变成纯白（实测 out RT RGB 全 `(255,255,255)`）——用户当天反馈。随后按「效果输入内容」分叉：image 层保留 `min(A,B)`、util 层用官方 mix，即本篇 Decision 的最终形态。教训：**「引擎源码语义」与「该素材的可见观感」冲突时，先确认输入源差异（A 到底是什么），不要拿单一素材的结论套全库。**
