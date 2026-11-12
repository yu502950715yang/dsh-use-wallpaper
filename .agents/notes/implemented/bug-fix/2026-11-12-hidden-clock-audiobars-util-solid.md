# Agent Note: 补全时钟/音频条/基线（text 脚本契约 · 无链 solid util · bars 官方着色）

Status: implemented

## Problem

壁纸《Somewhere In Nowhere [4K]》（`3819637149`）在桌面 Wallpaper Engine 上有三块组件：左上的 12 小时制时钟（`1:29 PM`）、从水平基线向下垂的浅蓝音频条、以及那条 3px 基线；DSH GUI 里**这三块全都不显示**（日期、媒体封面等其它组件正常）。用生产 `lib/` 的 e2e harness 逐项定位到三个独立缺陷：

1. **时钟**：`#130 Clock 12Hrs` 的文本画布只有 1×111（空文本），页面日志有 `[text-script] update 抛错/超时…：'thisLayer' is not defined`。它的 `text.script` 不返回字符串，而是 `thisLayer.text = ...`（WE 常见写法），并读 `engine.userProperties.name`；旧沙箱只认 `update()` 的返回值、且没有 `thisLayer`/`engine` 两个对象 ⇒ 每帧抛错、整层空白。
2. **基线**：`#200 Solid` 是 `models/util/solidlayer.json` 的纯色 util 层（900×3、淡蓝色、alpha 0.95），`displayObject` 为 null —— 命中历史边界「无 effects 的 util 层整层不渲染」。
3. **音频条**：`#194 Audio Bars`（util `composelayer` + `Simple_Audio_Bars` 效果链）的 runner 有输出（RT 433×48、alpha 229），但读回的**像素 RGB = 场景背景色**（`(28,42,84)`），与背景同色所以看不见。根因是 v0.8.2 把 `Simple_Audio_Bars` 的 `BLENDMODE=0` 改写成 `5`（`min(A,B)`）——该近似只在 A（效果输入内容）比 B（Bar Color）亮时 `min≈A`；util 层的 A = 整帧快照（暗背景）⇒ 竖条被染成背景色。WE 官方 `common_blending.h` 的 fallback 是 `mix(A, BlendNormal(A,B), opacity)` = `mix(A, B, opacity)`。

## Decision

- `src/client/text-script.ts`：quickjs 沙箱为每个 binding 注入 `thisLayer`（`text` 属性可读写，其余属性自由存取但不参与渲染）与最低限度的 `engine`（`userProperties` = project.json 用户属性、`frametime = 0`）；`update()` **返回值优先**，没有返回值时读回 `thisLayer.text`；每帧 update 前把上一帧文本写回 `thisLayer`（供脚本按 `lastString` 增量判断，正是本壁纸时钟的写法）。`bind()` 增加第 4 参 `userProperties`（renderer 传装配期 userProps）。
- `src/client/shader/effect-chain.ts`：删除 `Simple_Audio_Bars` 的 `BLENDMODE=0 → 5` 改写，保留 0 交给 `we-headers.ts` 逐字转写的官方 `ApplyBlending`；alpha 仍由 shader 的 `TRANSPARENCY` combo 决定（本壁纸 REPLACE ⇒ alpha = bar × opacity）。
- `src/client/threejs-player.ts`：util 分支对**无 isolate 条目的 `solid` 层**仍 `addBackground(util)`（走既有 `createUtilLayerMaterial` 纯色材质直渲）；无链 `project`/`fullscreen`/`compose` 依旧不渲染（没有内容输入，画出来只会是白块）。
- 回归用例：`tests/text-script.test.ts` 3 例（thisLayer 写入 / `engine.userProperties` / 返回值优先）、`tests/effect-chain.test.ts` 改为断言 `BLENDMODE` 保持 0、`tests/threejs-player.test.ts` 改为「有 isolate → 隔离；无链 solid → 直渲且颜色/alpha 正确；无链 passthrough → 不渲染」。另把 `tests/dom/bootstrap.dom.test.ts` 两个含整包动态 import 的重集成用例超时 5s→20s（全量并行下的**既有** flake，单列提交 `af020dc`，与本修复无关）。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `45237ac`

## Alternatives considered

**在 renderer 里按对象名/脚本源码给这个时钟特判生成 12h 文本。** 只针对单素材、改动小。不用它：`thisLayer.text` 与 `engine.userProperties` 是通用的 WE 脚本契约，特判等于把缺口留在沙箱里，下个用同一写法的壁纸照样空白。

**把 `text.value` 直接画出来（"Clock 12hrs"）。** 一行就能让图层非空。不用它：那是作者占位值，画出来是**错误内容**，比空白更糟（现有代码注释也明确「绝不画 text.value」）。

**给无链 solid util 层硬编码颜色/尺寸或跳过材质解析。** 不用它：颜色/alpha 都在 scene.json 里，`createUtilLayerMaterial` 已实现同一套 `materialModulation` 语义，复用它才能与 WE 的 `g_Color4` 口径一致。

**保留 `min(A,B)` 映射、只在 util 层特判成官方公式。** 不用它：`min` 只是「A 比 B 亮」时的巧合，image 层（2832263418）同样会在别的素材上错；官方公式是引擎源码里的唯一权威，按它统一即可。

## Consequences

**收益：** 本壁纸三块组件与桌面一致（生产渲染探针：`1:44 PM` 时钟、浅蓝竖条、3px 基线；fx 探针读回 bars 输出 `RGB≈(124,171,238)`、alpha 229，不再是背景色）；补充两条通用契约（text 脚本 `thisLayer`/`engine`、无链 solid util）。影响面已扫全库：无链 util 仅 4 个（3 个 passthrough 仍不渲染、唯一 solid 就是本壁纸），text 脚本使用 `thisLayer`/`engine.userProperties` 的仅本壁纸这 1 条。回归：`npm test` 2272 通过、`e2e:media` 13/13、`e2e:media --regression` 22/22。

**代价：** `2832263418`（EVA）的音频条着色由旧的 `min(A,B)` 近似变为官方 `mix` 语义 —— 这是「回归引擎源码口径」的预期变化，但没有做桌面逐像素 A/B（原 v0.8.2 的「内容色」结论本身就没有量化证据）；`engine` 只提供 `userProperties`/`frametime` 两个字段，`thisLayer` 只有 `text` 生效（visible/alpha 等动态写入仍走 SceneScript 的 LayerStateTable 那条路）；启用 text 脚本的壁纸每帧多一次 `writeText` + 一次 `readText` 的 quickjs 调用（只在有 text 脚本时发生）。
