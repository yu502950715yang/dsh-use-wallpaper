# Agent Note: SceneScript 音频可视化（visualizer）由 player 代建 bars

Status: implemented

## Problem

锦木千束（2937346640）桌面 WE 左下角有一排白色频谱条，DSH 里完全没有。解包发现它不是效果 shader，而是 **Simple Visualizer 场景脚本**：`engine.registerAudioBuffers(64)` 注册频谱、`thisScene.createLayer('models/bar.json')` 在 init 里动态创建 63 个 bar 图层（加自身共 64 条）、update 每帧按 `audioData.average[i]` 设置每条的高度/位置。我们的渲染路径只实现了 clock 类脚本样式，visualizer 分支只有 `detectScriptPattern` 识别、没有任何渲染实现，因此只画出那个 4×4 的占位层。

## Decision

在 three 渲染路径按 visualizer 语义**代建** bars，不走脚本 VM（`AGENT.md` §7.42 ⑰）：

- `three-renderer` 在 image 装配循环里识别 `detectScriptPattern(script) === 'visualizer'`，收集对象 origin、image 纹理、`scriptProperties`（barWidth/scaleY/originX/barAlignmentdir）；
- `player.setVisualizerBars` 用 `addBackground` 创建 64 条（宽 = barWidth × 图宽、底部对齐 origin.y、贴图 = 对象自身白色 4×4 纹理、初始高度 0）；
- `onFrame` 用音频分析器的 64 bin 频谱逐帧更新每条高度（无音频 → 高度 0、不可见，与桌面一致）。

相关渲染口径见 [v0.8.2 可见修复包](2026-10-22-v082-visible-fixes-rendering.md)。v0.9 已扩展到自定义家族（`pixel-bars`），见 [自定义 visualizer 家族适配](../bug-fix/2026-10-26-pixel-bars-visualizer.md)。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `c6343ba`

## Alternatives considered

**实现完整 SceneScript VM（createLayer / registerAudioBuffers / 层状态写入）。** 理由：脚本语义最通用，能覆盖所有 visualizer 变体。不用它是因为成本大（VM 层 + 音频缓冲 + 动态层全链路），而本机唯一的 visualizer 样本语义简单（参数已在 `scriptProperties` 里），代建 64 条即可交付用户可见结果。

**只渲染占位层（保持现状）。** 理由：零改动。不用它是因为用户看到的是「桌面有 bars、DSH 没有」的明确缺失，占位层 4×4 像素不可见。

**用 ObjectEffectStage 的频谱驱动（`stage.setAudioSpectrum`）而不是 player 自己的更新。** 理由：复用效果链已有的频谱注入点。不用它是因为 visualizer bars 不是效果链、没有隔离对象/RT，直接在 player 内更新网格更短路径，且避免与 effect 门控耦合。

## Consequences

**收益：** 锦木千束 64 条白色频谱条随音乐跳动（e2e 注入频谱截图验证）；参数取自脚本 `scriptProperties`，脚本属性解析链路仍生效。

**代价：** 按 `Simple Visualizer` 结构硬适配（bar 计数/对齐/纹理语义固定为 64 条 bottom 对齐）；其它 visualizer 脚本结构不同需另适配；无音频时不可见是刻意行为（与桌面相同），排查时容易误判为「没渲染」。
