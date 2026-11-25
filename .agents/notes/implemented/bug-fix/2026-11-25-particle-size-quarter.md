# Agent Note: 粒子 sizerandom 口径由 /2 改为 /4

Status: implemented

## Problem

`3819637149`「Somewhere In Nowhere」的星点（`Big Stars 1/2`，`sizerandom` 125..180 / 110..160）在桌面
WE 里只有 14~16 px 星斑（1920 视口、scale 0.48，UI 掩膜后 blob 统计），而本插件同口径 25~31 px；
drift 修复（`2026-11-25-oscillate-size-drift`）只让老星变小，**新生成的星仍然 35~48 px**（直接读
sim 的 `sizes` 得到 quad 宽 73~99 场景 px），用户反复反馈「还是偏大」。

## Decision

`emitter → sim` 的 sizerandom 换算从 `值/2` 改为 `值/4`：

```rust
let size = (i.size_min + (i.size_max - i.size_min) * rand().powf(i.size_exponent))
    * 0.25
    * self.override_spec.size;
```

理由：桌面星斑 14~16 px ≈ 33 场景 px，而 spec 110..160 只在 `/4` 下落在 27~40 场景 px ✓；
`/2`（55~80）在任何相位都比桌面最大星斑大一倍。历史 `/1`（Crimson 绿点、黑神话花瓣）与 `/2`
都被反馈偏大，本次按桌面实测定位到 `/4`。

## Consequences

- 星点：quad 由 55~96 场景 px 降到 28~48，屏幕 13~23 px，与桌面 14~16 px 一致（保留振荡与 drift）。
- 全库所有粒子尺寸同步减半：鸟群（`3825702259` spec 50..60）、花瓣、雨雪、光斑都会变小。
  鸟群此前的「对得上桌面」是在不同缩放的两张裁图上目测的，不可靠；本次以星点的 1:1 实测为准。
- 若某些壁纸的粒子明显偏小，下一步把系数改为按 `sizerandom` 量级或按对象可配置，而不是继续全局微调。

## Alternatives considered

- **只对带 `oscillatesize` 的对象减半**：作用面最小，但 bokeh（无该算子）同样偏大，指标不一致。
- **只加强 drift**：新星尺寸不变（用户看到的正是新星），无效。
- **维持 /2**：与桌面 1:1 实测差一倍。
