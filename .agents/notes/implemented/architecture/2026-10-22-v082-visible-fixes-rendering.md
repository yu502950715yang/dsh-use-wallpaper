# Agent Note: v0.8.2 可见修复包的渲染口径与快照内容输入

Status: implemented

## Problem

v0.8.1 之后仍有四类用户可见缺口：util 层（project/fullscreen/compose/solid）完全不渲染；text 的 `alpha`/`brightness`/`anchor`/`limitwidth`/`maxwidth` 字段被解析但未消费；image 的 `color`/`alignment` 同样解析未用；效果链缺全局指针/视差 uniform。更麻烦的是 util 层的效果链输入语义在 WE 里有两套候选（`_rt_FullFrameBuffer` 槽 / `bind: previous` 内容），照抄任一种都会在真实素材上渲染错。

## Decision

按「隔离渲染 + 帧内快照作为内容输入」实现（细节见 `AGENT.md` §7.42 ⑧–⑰、`docs/superpowers/specs/2026-10-22-v0.8.2-visible-fixes-design.md`）：

- **util 四类**：project/fullscreen 强制全屏（origin=场景中心、scale=1、size=场景）；compose/solid 用 size×|scale|；全屏 util 的 RT = 屏占位（world×屏幕密度等比，**不是**画布缓冲），快照按 cover 反解到内容几何 UV（不改共享快照纹理的 repeat/offset），避免竖构图拉伸 mask。
- **快照作为内容输入**：真实 util 链读 `bind: previous`，段边界把整帧快照写进该层内容并重渲其 RT；`_rt_FullFrameBuffer` 槽门控保留但对象链继续关闭；无 effects 的 util/solid 层不渲染（零回归）；绘制顺序按 scene 对象顺序穿插；resize 预算只让 budgeted(image) 参与。
- **text 字段**：alpha 落内容材质（与 image 同口径；合成 quad 中性，避免 a²），brightness 在 canvas 侧 LDR 近似，anchor 只决定 quad 原点（9 值、none 回退），limitwidth/maxwidth 按字体像素换行。
- **image color/alignment**：color 乘内容材质（`colorBlendMode≠0` 时的修正见 [音频条颜色对齐](../bug-fix/2026-10-23-audio-bars-desktop-parity.md)），alignment 同时决定直渲 mesh 与隔离合成 quad 的位置。
- **F18**：`g_PointerPosition` 归一化 [0,1]、y 向下；`g_ParallaxPosition` 按 0.5 中性/y 向上实现（`cameraparallax={user,value}` 形态现已被解析、`3118949804` 默认 `enabled=true` ⇒ 该样本可用于量化校准；目前只做过人眼验收，未标定）。
- **门禁**：新增 `e2e:verify-v082` 四组判据（见 [e2e 笔记](../testing/2026-09-22-e2e-verification-in-repo.md)）；真机验收清单 `TESTING.md` §2.15（V1–V11）。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `13b8eb5` `87f97a1`

## Alternatives considered

**只开 `_rt_FullFrameBuffer` 槽、不做快照内容输入。** 理由：槽语义最贴近 WE 官方 shader 变量名。不用它是因为真实素材的 util 链全部读 `bind: previous`（快照必须是内容），只开槽时链输入仍是透明占位 → 画面全黑/错位。

**全屏 util RT 按画布缓冲尺寸。** 理由：与主画面同分辨率、语义直观。不用它是因为 WE 的 util 层 RT 是屏占位（world×屏幕密度）等比，画布缓冲在竖构图会拉伸 mask/模糊半径，2597392171 的 cover 映射直接错。

**把 util 对象 alpha 落在隔离合成 quad 上。** 理由：对象 alpha 天然是「层输出」的收口点。不用它是因为 image 现行口径把 alpha 烘进内容材质，两者不一致会出现 a²（内容 × quad 各乘一次）；统一到内容材质后合成 quad 保持中性。

**对象链也打开 `_rt_FullFrameBuffer` 槽。** 理由：可让对象效果读整帧。不用它是因为同帧多消费者的槽语义未定（谁后写谁生效），本轮明确只放行 util 内容层，对象链保持关闭。

## Consequences

**收益：** 2911105183（全屏 bloom+bokeh）、2132420420（pulse）、2597392171（全屏 blur）、3789452668（solid 音频线）四类 util 层可见；text/image 字段与 F18 有单测 + 真实素材 e2e；`AGENT.md` §7.42 与 `TESTING.md` §2.15 可交接。

**代价：** 4K/屏占位 RT 内存较高（259 单层约 222.9MiB）、段渲染整帧无 MSAA（4 张 util 壁纸边缘锯齿需与 v0.8.1 对照）、F12/F18 的 anchor/limitwidth/parallax 语义仍待真机 A/B；`copybackground` 与 `chromatic_aberration` pass 是遗留项（见 [音频条笔记](../bug-fix/2026-10-23-audio-bars-desktop-parity.md)）。
