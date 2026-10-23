# Agent Note: 音频条颜色对齐桌面 WE（colorBlendMode 的 B 与 BLENDMODE=0 语义）

Status: implemented

## Problem

EVA 卡农（2832263418）的频谱竖条在桌面 WE 是**彩色渐变**（左侧紫→右侧红，即对象内容图 Rainboww 的颜色），DSH 里先是白色、去掉对象 color tint 后又是被蓝调的蓝绿色。两条线索互相矛盾：官方 `common_blending.h` 的 `ApplyBlending` 在 `BLENDMODE=0` 走 fallback 返回 BarColor（白），而桌面实测输出是内容色；同时 `colorBlendMode≠0` 的对象 color（蓝）被乘进了内容材质。

## Decision

两条修正都已落地（`AGENT.md` §7.42 ⑯）：

- **`colorBlendMode ≠ 0` 的对象不做 content color tint**：WE 追加混合 pass 的 B 参数是**内容原色**（对象 color 不参与），`threejs-player.ts` 的 `addBackground` 对 `colorBlendMode≠0` 传 `undefined` color 给 `materialModulation`，对象 color 只保留在 colorBlendMode 的混合语义里。
- **`Simple_Audio_Bars` 的 `BLENDMODE=0` 映射为 `min(A,B)`（内容色）**：按桌面截图实测（bars 颜色 = Rainboww 内容色）在 `shader/effect-chain.ts` 对该 shader 单独映射；其余 shader 的 `ApplyBlending` 语义不动。
- 前置修复：linked 参数默认值 `"0.0, 1.0"` 逗号分隔解析（`d91cb1f`，此前 `u_BarBounds` 回退 [0,0] 导致 bars 高度恒 0、完全不显示）。

影响面：全库 `colorBlendMode≠0` 对象仅 4 个（2 个 color 缺省白）+ `Simple_Audio_Bars` 1 个效果（2911105183 的 music bar 同效果受益）。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `d91cb1f` `10ff6d2`

## Alternatives considered

**全局把 `ApplyBlending` 的 `BLENDMODE=0` 改成返回 A。** 理由：一处改动即可让 bars 显示内容色，且与桌面实测一致。不用它是因为会影响全部 29 个 `ApplyBlending` pass（clouds/godrays/pulse 等）——这些效果的桌面行为是 B 语义，改了会整片消失/改变，风险不可控。

**用 `copybackground` 解释彩色 bars。** 理由：对象带 `copybackground: true`，疑似「内容 = 背景副本 + 自身图」导致 bars 取内容色。不用它是因为先按「内容替换成快照」实现后，1280029027 全屏图层直接把画面变成纯灰（错误）；正确语义是「背景底图 + 自身图叠加」，且它不改变 bars 颜色解析，与桌面彩色无关；该项留 v0.8.3。

**只修 `colorBlendMode` 的 tint、不动 BLENDMODE。** 理由：改动更小、更贴近官方头文件。不用它是因为 fixture 截图验证 bars 仍为白色，与桌面不一致（功能正确但观感不符），用户明确要求对齐桌面。

## Consequences

**收益：** EVA 卡农的 bars 与桌面 WE 颜色一致（彩虹渐变），并随音乐频谱变化；291 的 music bar 同效果一并受益；e2e 截图与单测固化。

**代价：** `Simple_Audio_Bars` 的 `min(A,B)` 映射是**与官方 `common_blending.h` 公式的刻意偏离**，依据仅是桌面截图实测——未来若升级/重写 shader 支持需复核；`copybackground` 的正确双层语义仍未实现。
