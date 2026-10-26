# Agent Note: 自定义 visualizer 家族（pixel-bars）适配

Status: implemented

## Problem

`3118949804`（Anime Girl With Purple Eyes）桌面上左侧有一列 64 条音频可视化条（脚本家族 `3007895627` 的 `audio-visualizer`），DSH 中完全不可见。根因是两层叠加：

1. 本仓 visualizer 代建只适配 Simple Visualizer 的 `barWidth` / `originX` / `scaleY` 参数；该脚本用 `visualizerResolution`（条数）/ `barSpacing`（用户属性）/ `minBarHeight` / `visualizerBarPath`，且布局依赖对象自身 `scale`（1800×500）与 `angles`（z=-90°）。
2. 代建条高度只由包内 sound 的 analyser 频谱驱动；该壁纸 **无 sound 对象**（`project.json` `supportsaudioprocessing: true`，桌面走系统音频），无音频时高度 0；而桌面脚本用 `Math.max(minBarHeight, …)` 保证静音仍有静态条。

## Decision

- `detectVisualizerFamily` 区分 `simple` / `pixel-bars`（props 含 `visualizerResolution` / `visualizerBarPath` / `minBarHeight` 即后者）。
- `computePixelBarLayout` 按脚本公式：条数 clamp 2..64、世界条宽 `scale.x / count × (1 − barSpacing)`、`minBarHeight`、条纹理路径。
- `ThreeScenePlayer.setPixelVisualizerBars` 按对象 `scale/angles` 旋转布局（脚本的局部 x 分布 + 对象 origin），用 `addBackground` 承载 angles/alignment；静音高度倍率 = `minBarHeight`，有音频时 `max(minBarHeight, freq × scale.y × 0.25)`。
- 条纹理走 `resolveImageAssets(id, { image: barPath })`（`full-pixel.tex` 为 1×2：世界宽≈14.06、静音高≈10px）。

## Alternatives considered

**只接系统音频、不改布局。** 桌面静音时也有静态条，仅接音频仍不可见；且系统音频需要捕获权限/桌面壳通道，成本远超本 bug。否决。

**继续复用 Simple Visualizer 参数。** 条数/宽度/间距/旋转全错，观感不可接受。否决。

**执行完整 SceneScript VM（真正跑 createLayer）。** 与本仓「启发式代建、不跑完整脚本」的既有口径冲突，成本过高。否决。

## Consequences

- 静音下左侧条纹可见（与桌面结构一致）；播放时不跳动——`supportsaudioprocessing` 仍是独立缺口。
- 只适配该家族字段；其它自定义 visualizer 脚本仍按 simple 缺省参数代建。
- 订正：`2937346640` 并非无包内音频——pkg 内有 `sounds/yutaka hirasaka - acro.flac`（此前审计只搜 mp3/ogg/wav 漏了 flac）。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `94efb44`
