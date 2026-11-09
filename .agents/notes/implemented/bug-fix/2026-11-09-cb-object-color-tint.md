# Agent Note: colorBlendMode≠0 的静态作者色 tint（云/雾比桌面亮白）

Status: implemented

## Problem

用户对比桌面 WE 与 DSH 截图：「桌面上看起来云比较淡，但 dsh 中云看起来不淡」。

排查（`3828798871`，e2e 同相位帧 vs WE 真机帧）：

- 前景雾带亮度 ours 55.3 / WE 48.8，`(r−g)` ours 17.0 / WE 21.7 —— DSH 的云更亮、更白。
- 云层对象 = `Clouds Front`（object 348/656）：`colorBlendMode: 7`（Screen），作者 `color` 分别为深红 `(0.365,0.141,0.141)` 与浅褐 `(0.588,0.412,0.349)`，各带 scroll/waterripple(/opacity) 效果链。
- 代码里 `addBackground` 在 `colorBlendMode ≠ 0` 时**跳过对象 color tint**（旧注释依据：2832263418 音频条在桌面显示 Rainboww 彩虹色而非对象 color 蓝调）。
- 参考引擎 `WPSceneParser`：image 内容材质的 `g_Color4`/`g_Color`/`g_Alpha`/`g_Brightness` **恒取作者值**（含 cb≠0）；cb 的追加混合 pass 的 B = **已带 tint 的内容**，最终合成面保持中性（`ConfigureEffectFinalComposite` 注释明确「源内容已烘 color/alpha/brightness」）。

旧归因错误：音频条的彩虹色来自效果 shader 的 `finalColor = u_BarColor` + 该壁纸 `BLENDMODE=0` 的 `min(A,B)` 映射，以及 u_BarColor 的**用户属性/脚本驱动**，与「内容是否 tint」无直接关系。因此「cb≠0 一律不 tint」这条规则缺少依据，并直接造成云/雾偏亮偏白。

## Decision

`threejs-player.addBackground` 的内容调制改为：

- `colorBlendMode ≠ 0` + **作者静态 color** → 照常烘 tint（参考引擎语义，修复云/雾）；
- `colorBlendMode ≠ 0` + **`{user,value}` 绑定 color** → 保留旧行为（不 tint）：WE 运行期由脚本/属性驱动该颜色，本实现只有静态默认值，tint 静态值反而不可信（2832263418 audio_rainbow 属此类，保持已验证观感）。

`scene-json` 的 image 对象新增 `colorUserBound` 标志（`o.color` 为 `{user|script,value}` 对象），渲染器透传 `addBackground`。

## Alternatives considered

**全部 cb≠0 对象都烘 tint（不做例外）**：参考语义上最干净，但 2832263418 的 audio_rainbow color 是用户属性绑定（默认蓝），WE 运行期由脚本动画驱动；我们 tint 静态蓝会让音频条颜色明显偏离已验证的桌面观感（该壁纸 P? 验收项）。保留例外、并在笔记/AGENT 标注为「待脚本 color 支持后移除」。

**全部 cb≠0 都不 tint（维持旧行为）**：云/雾继续偏亮偏白，用户当前反馈的问题不解决；且 3797976859 的 Album Cover Frame（cb7 + 用户绑定黑色）本应「黑 = 不改变背景」的语义在有 tint 时才成立。

**只对 Screen(7) 烘 tint**：把问题收窄到本壁纸，属于特判，拒绝。

## Risks

- 例外依赖「用户属性绑定的颜色 = 我们拿到的静态默认值不可信」这一判断；若某个绑定色在 WE 是静态默认（脚本从不改），我们的不 tint 会偏差。
- 本机 43 张 `scene.pkg` 扫描：cb≠0 且 color 非中性共 5 对象 / 4 壁纸（2 个绑定、3 个静态：本壁纸云 2 + 2460786246 Clock）。全库其余 cb≠0 对象的 color 为中性白，无影响。
- 音频条/封面框（2832263418、3797976859）的最终观感仍依赖「脚本 color 未实现」这一既有边界。

## Consequences

**收益：** 云层（Clouds Front）恢复作者 tint 后与桌面 WE 对齐（前景雾带亮度 55.3→45.4，WE 48.8；`(r−g)` 17.0→21.5，WE 21.7；左下雾 24.9→20.5，WE 20.3）；人物/直接渲染路径逐像素零变化（e2e A/B 确认）。新增单测钉住「静态色烘 tint / 绑定色不 tint」两条规则。

**代价：** image 解析产物多一个 `colorUserBound` 字段；一个带例外的 tint 规则需要在 AGENT 中长期记录（AGENT §7.40 ⑯/⑱）。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `910cf81`
