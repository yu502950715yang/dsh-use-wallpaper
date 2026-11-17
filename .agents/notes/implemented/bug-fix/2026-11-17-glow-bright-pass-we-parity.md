# Agent Note: 光晕与壁纸 bloom 的亮部口径对齐 WE

Status: implemented

## Problem

壁纸《Lake at sunset[无雨]》（workshop `3817739578`，太阳在左上）在 DSH 里左上「更刺眼」：左上 1/4 的纯白（luma>250）占 **21.4%**，同帧桌面 WE 只有 **10.1%**；全图 6.6% vs 2.4%。

根因有两层，都不在壁纸本身（底图渲染与源图逐像素一致，纯白 1.19% vs 1.18%）：

- **量级**：`glow-stage.ts` 的 bright-pass 是 `(luma − t) / (1 − t)`，而 WE `assets/shaders/downsample_quarter_bloom.frag` 是 `saturate(max(r,g,b) − t)` —— 差 `1/(1−t)` 倍，阈值越高差得越多（0.5 → 2×，0.65 → 2.86×）；WE 还用 **max 通道**判阈值，我们用 luma，饱和彩色高光因此几乎不发光。
- **叠加**：`threejs-player.ts` 的帧体是「主场景 → 壁纸 bloom → 应用级 Glow → 画布」，两张后处理各跑一遍 bright-pass + 三级模糊 + 加法回叠。实测单开任一级就已接近桌面 WE 的合计（全图纯白 3.34% / 2.84% vs 桌面 2.37%），两级相加翻倍。
- 合成是硬 `clamp(base + glow·strength, 0, 1)`，近白区域直接被截成纯白，没有肩部过渡。

## Decision

- 新增 `src/client/glow-math.ts`（纯函数，单测可跑）：`brightPassFactor` = `clamp(max(r,g,b) − t, 0, 1)`；`shoulderCurve` 在 0.9 以下恒等、之上 `knee + (1−knee)(1 − exp(−(x−knee)/(1−knee)))`；`softShoulder` = `max(base, shoulderCurve(base + added))`。
- `src/client/glow-stage.ts` 的 `BRIGHT_FRAG` / `COMPOSITE_FRAG` 逐式镜像上面三条（GLSL 无 `saturate`，写 `clamp`；`uKnee = SHOULDER_KNEE`）；两个 shader 源码导出，供「不得回退到 `1.0 - uThreshold` 除法」的契约测试。
- **bloom 的 strength/threshold 仍按 `scene.json` 原样下发**（WE 语义下这才正确，不乘补偿系数）；应用级 Glow 的默认值不动（`0.65 / 0.35`），因此同一组滑杆值比旧版淡 `1/(1−t)` 倍 —— 这是有意的行为变化，面板调到 ≈`1.0` 可复现旧观感。
- `max(base, …)` 是为了**不压暗本来纯白的底图**：软膝单独作用在总和上会把 255 压成 246。
- 顺带修 `e2e/harness/harness-object-effects-entry.mjs`：Glow 注入写死了 1.0 已移除的旧命名空间，`glow=off` 静默失效（`e2e:verify-v081` 自 1.0 起一直红）；改为从 `settings.ts` 导入 `SETTINGS_NS`。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `23efe7e`

## Alternatives considered

**保留旧公式，只把默认强度调到「不过曝」。** 改动面最小、观感可立即收敛。不选：bloom 的参数来自作者 `scene.json`（本机 5 张，阈值 0.5–0.93），偏差随阈值变化，一个全局强度旋钮补不了随参数漂移的公式错误；且滑杆一动，新旧壁纸又各自跑偏。

**有 `general.bloom` 的壁纸默认不叠应用级 Glow。** 直接消除双重叠加，比改公式更省事，观感也立刻接近桌面。不选：WE 确实同时有场景 bloom 与应用后处理，靠「少跑一级」得到的接近是策略性的，换个阈值就不再成立；且关掉后没有滑杆可回调。

**把三级等权模糊换成 WE 的 quarter + 13-tap 链。** 光晕形状最接近桌面（实测径向剖面在 150–400px 仍差 0–5 luma）。不选：要重标定模糊半径/RT 尺寸与性能，收益递减；形状差异已记在 `docs/fixes/threejs-path-fixes.md` 的边界里。

**软膝作用在总和上（`shoulder(base + glow)`）。** 实现更简单、与「指数压肩」的直觉一致。不选：已经到白的底图会被压到 0.96（255 → 246），等于给纯白区域加了一层灰；改用 `max(base, …)` 只压新增能量。

## Consequences

**收益：** 亮部与桌面同量级 —— `3817739578` 左上纯白 21.4% → 9.8%（桌面 10.1%）、全图 6.6% → 2.4%（桌面 2.4%）；作者 bloom 参数第一次按 WE 语义生效（`2937346640` 这类高阈值壁纸的峰值从 1.84 降到 0.13，旧口径下它几乎全亮部发光）；饱和彩色高光按 max 通道发光（纯蓝灯在阈值 0.5 下从 0 变 0.5），与桌面一致。

**代价：** 所有开光晕的 scene 壁纸整体变淡，存量用户需自行把强度调到 ≈`1.0` 才回到旧观感（本次不做自动迁移：无法区分「旧默认值」与「用户明确选的 0.35」）；两级串联的**结构**没改（有 bloom 的壁纸仍会叠 Glow）；三级模糊宽度仍与 WE 不同；山体/天空比桌面 WE 暗约 5 luma（WE 的后处理铺得更宽，本次不追）。改完需重载 DSH 窗口（插件加载 `dist/client.js`，不是 HMR）。

**既有问题（本次一并修掉）：** `implemented/feature/2026-11-16-chat-column-glass.md` 的 `## Affected repositories` 行不是门禁认可的锚点格式，`verify-note-anchors.ts` 一直红；本次按真实提交补成合法锚点。
