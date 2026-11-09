# Agent Note: puppet 效果链 RT 被隔离预算降采样（人物没桌面清晰）

Status: implemented

## Problem

用户反馈：「人物骨架没有桌面上的清晰」。

量化（`3828798871`，e2e 同相位帧 vs WE 真机帧，黑武者区域 Laplacian 方差）：

| 渲染路径 | Laplacian | gradX |
|---|---|---|
| 直接贴图（关掉效果链） | 8.72 | 3.10 |
| 效果链路径（修复前） | **5.60** | 2.43 |
| WE 真机同相位 | 7.16 | 2.62 |

→ 直接采样源纹理时比 WE 还清晰；走 puppet 效果链后明显变糊。

根因：puppet 的链输出是**贴图**（人物网格按 atlas UV 采样），但隔离 RT 的尺寸走统一策略 `isolatedRtSize(world, screenScale, source, budgetScale)`，而 `budgetScale` 来自全场景隔离对象的显存预算（本壁纸 5 个隔离对象，预算算得 0.704）⇒ 人物源纹理 3840×2160 的链 RT 被降到 2704×1521，人物贴图先经历一次 0.7× 双线性降采样、再被采样到屏幕上，肉眼即「不清晰」。

## Decision

1. **puppet 的隔离 RT 不参与全局隔离预算**：`fitIsolatedBudget` 的输入集合排除 puppet；puppet 的 RT 用 `isolatedRtSize` 不带 `budgetScale`（按源纹理分辨率，仍受 `OBJECT_RT_MAX = 4096` 收口）。
2. resize 期同口径：puppet 不登记为 `budgeted`（`ObjectEffectStage.onViewportResize` 的预算集合因此也不含 puppet），避免 resize 后又被压回去。
3. **puppet 内容 RT 关闭 MSAA**（`attachIsolated`：`kind === 'puppet'` 与满屏 background 一样视为 flat content）：内容 = 铺满 RT 的贴图平面、无几何轮廓边，MSAA 结构性无效；源分辨率下 `samples:4` 的显存代价不可接受。

## Alternatives considered

**只把预算调大（例如 384MB → 768MB）**：会连带放大所有背景云/雾层 RT 的显存，且预算仍是「全局一个数」——puppet 和 3D 背景抢预算的问题不解决；拒绝。

**puppet RT 上限降到 2048/3072 省显存**：3072 时锐度介于 5.60 与 7.32 之间（未实测），但与 WE 语义（按对象/层尺寸跑效果链）不一致；按源纹理（≤4096）才与桌面一致，故采用源分辨率并把仅有的两个特例（不参与预算 / 内容关 MSAA）写清楚。

**给 puppet 单独再设一套预算**：多一层参数、当前样本（1~3 个 puppet/场景）用不上；先按「数量少、单对象源分辨率」的简单规则，出现极端样本再补。

## Risks

- 显存：puppet RT = 内容 + 2 个 ping-pong（内容关 MSAA 后约 3× 源纹理 RGBA8）。`3828798871` 两个 3840×2160 puppet ≈ 200MB；`3812518176`（1920×1080）≈ 25MB。WE 桌面同样按对象尺寸跑链，属可接受成本；若未来出现 4K×多个 puppet 的壁纸，需回头看预算策略。
- 隔离 RT 锐度 e2e 门禁（`e2e:isolated-rt`）的输入集合现在不含 puppet：该门禁本身只覆盖 image，无回归。
- 依赖「puppet 内容 = 平铺贴图、无几何边」：若将来支持 puppet 的 3D 网格/多 mesh 内容，MSAA 关闭需重新评估。

## Consequences

**收益：** 人物区 Laplacian **5.60 → 7.32**（WE 真机同相位 **7.16**），gradX 2.43 → 2.76（WE 2.62）——人物清晰度追平桌面；背景/人物效果链行为不变（puppet 效果屏幕贡献仍 6~17% 像素变化）。

**代价：** puppet 隔离显存增大（由内容 MSAA 关闭部分抵消）；`tests/three-renderer.test.ts` 的 puppet 预算用例改为「puppet 按源分辨率、不参与预算」口径。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `41d2fe1`
