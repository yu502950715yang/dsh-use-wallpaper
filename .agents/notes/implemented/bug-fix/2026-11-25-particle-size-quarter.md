# Agent Note: 粒子 sizerandom 口径按对象分两档（/2 与 /4）

Status: implemented

## Problem

`3819637149`「Somewhere In Nowhere」的星点（`Big Stars 1/2`，`sizerandom` 125..180 / 110..160）在桌面
WE 里只有 14~16 px 星斑（1920 视口、scale 0.48，UI 掩膜后 blob 统计），本插件同口径 25~31 px；
drift 修复（`2026-11-25-oscillate-size-drift`）只让老星变小，**新生成的星仍然 35~48 px**
（直接读 sim 的 `sizes`：quad 宽 73~99 场景 px）。

先把全局口径从 `/2` 改成 `/4`（`19da5a0`）：星点对上桌面，但 `3825702259`「Where the World Falls
Asleep」的鸟群被用户反馈「过小」——鸟群是 `/2` 时对得上桌面的。

## Decision

`SceneParticleSim::size_divisor_for(&operators)` 按算子判定除数，spawn 时用：

- 带 **衰减型** `oscillatesize`（区间均值 < 1，如 `0.6..1.2`）⇒ `值/4`；
- 其余（含均值 = 1 的振荡，如 `0.9..1.1`）⇒ `值/2`。

依据是两张 1:1 桌面截图：星斑 14~16 px ≈ `值/4`；鸟群在 `值/4` 下明显偏小、`值/2` 正常。
均值 = 1 的振荡不漂移（见 drift 笔记），行为与普通粒子一致，故仍按 `/2`。

## Consequences

- `3819637149`：星点 quad 由 55~96 场景 px 降到 28~48（屏幕 13~23 px），对上桌面 14~16 px；
  sim 实测 med 19~25 / max 33~40 场景 px。
- `3825702259`：鸟群回到 `值/2`（spec 50..60 × 0.79 ⇒ 20~24 场景 px，sim 实测 med 22.3 / max 23.7）。
- 全库其余粒子不受本次影响（仍是 `/2`）。带衰减型 `oscillatesize` 的对象全库只有
  `3819637149` 的两枚 Big Stars（`3811798465` 萤火虫是 `0.9..1.1`，均值 1 ⇒ `/2`）。

## Alternatives considered

- **全局 `/4`**：星点对、鸟群错（用户实测）。
- **按 `sizerandom` 量级分档（如 >60 用 /4）**：与实测不符——鸟群 50..60 与星点 110..180 的
  差别不是「大小」，而是「有没有衰减型振荡」。
- **只加强 drift**：新星尺寸不变，无效。
