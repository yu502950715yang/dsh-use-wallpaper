# Agent Note: rope / ropetrail 粒子按 spritetrail 近似

Status: implemented

## Problem

`3819637149`「Somewhere In Nowhere [4K]」与 `3765967112`「Crimson Horizon」桌面上有流星（一条亮线划过天空），
本插件里完全看不到。查 spec：两个壁纸的流星对象 `renderer[0].name = "ropetrail"`（`length` 0.2 / 3），
而 `specRenderer` 只认 `sprite` 与 `spritetrail`，其余一律回退 sprite ⇒ 每颗流星被画成 1~2 px 的点
（`sizerandom` 2..5），在星空里等于不可见。

全库共 8 个 `rope*` 对象（`2859263090` Drops、`3743126786` Падающая звезда、`3765967112`×2、
`3819637149`×2、`3840341648`×2），全是 `ropetrail`，`length` ∈ {0.2, 0.5, 3}。

## Decision

- `specRenderer`：`rope` / `ropetrail` 归入 `spritetrail` 近似（`absolute: true`）。
  WE 的 rope 是沿粒子**历史位置**的带状曲线；流星/坠落物是直线运动，与「沿速度方向拉长的 billboard」
  在视觉上等价（shader 复用既有 TRAILRENDERER 分支）。
- 长度语义分开：`spritetrail` 的 `length` 是 WE `g_RenderVar0.x`（还要乘粒子 size）；
  `rope` 的 `length` 是**拖尾秒数**，视觉长度 = 速度 × length。shader 新增 `trailAbsolute`
  uniform：为 1 时沿速度轴不再乘 size、也不做 `texelRatio` 拉伸（rope 的纹理沿 v 铺满整条带）。
- 宽度仍用粒子尺寸（与 WE 的 ribbon 宽度同口径）。

## Consequences

- `3819637149`：流星恢复成 ~100 px 的斜向亮线（1920 视口、`length` 0.2 s、速度 ~110 px/s、
  纹理 `particle/drop` 的纹理比例让它比纯秒数略长）。
- `3765967112`：`length` 3 s、速度 100..250 px/s ⇒ 拖尾 300~750 px、`alpha` 0.15 ⇒ 长而淡的流星，
  与「twinkling」的命名一致。
- 既有的 `spritetrail` 壁纸（雨丝/风痕）行为不变（`trailAbsolute = 0` 分支逐字保留）。
- 边界：`rope`（非 trail 的连续绳）也是同一近似；本库没有纯 `rope` 样本。

## Alternatives considered

- **实现真正的 rope 几何**（历史位置缓冲 + 每帧重建 ribbon）：最忠实，但要给粒子层加一条
  「可变顶点数」的绘制路径与历史缓冲；对流星这种直线运动收益极小，先按近似落地。
- **保持 sprite 兜底**：即现状——流星不可见。
- **把 rope 的 `length` 直接塞进 spritetrail 公式**（最初一版）：由于 spritetrail 还会乘 size
  与 `texelRatio`，`3765967112` 的拖尾被拉到 3000 px 量级，明显失真 ⇒ 才拆出 `trailAbsolute`。
