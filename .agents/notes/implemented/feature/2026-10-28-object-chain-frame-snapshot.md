# Agent Note: 开启对象链的 `_rt_FullFrameBuffer` 消费（copybackground）

Status: implemented

## Problem

效果链对整帧快照（`_rt_FullFrameBuffer`）的消费点一直关闭（`ENABLE_CHAIN_FRAME_SNAPSHOT_CONSUMER = false`，AGENT.md §5.46/§7.31）。唯一真消费点是 `2597392171` 的 godrays：第 5 pass `COPYBG=1`，`textures[2] = "_rt_FullFrameBuffer"`，frag 用 `v_ScreenCoord`（由 `g_EffectModelViewProjectionMatrix` 把 pass quad 顶点换算）采样背景。关闭的原因是「对象窗口 UV ↔ 整画布快照」的映射未解决：对象链的 pass quad 只覆盖对象 RT，而快照是整画布。

## Decision

1. **映射**：新增 `object-range.effectScreenMatrix`（纯函数，`tests/object-range.test.ts` 5 个用例）：
   `M = S(2/cover.w, 2/cover.h) · T(quad 位置) · R(angles) · S(|w|/2, −|h|/2)`。
   - 主相机按 `coverRange` 中心原点 ⇒ 世界→画布 NDC 就是 `S(2/cover.w, 2/cover.h)`；
   - 对象 RT 的 v=0=图像顶部（`attachIsolated` 的 y 镜像局部相机）⇒ pass 顶点 `a_Position.y=+1` 对应对象图像**底**部，故局部缩放 y 取负；
   - `position` 传合成 quad 的场景中心化坐标（= origin − scene/2）；尺寸取幅值；非有限输入兜底为 0/1，不产出 NaN。
2. **接线**：`threejs-player.effectScreenMatrix(objectId)`（读 isolated 的 quad 位置/旋转 + worldW/H + scene/view）→ `ObjectEffectHost.effectScreenMatrix?` → `ObjectEffectStage.advance` 每帧 `runner.setEffectScreenMatrix(matrix)` → `EffectRunner.applyGlobalUniforms` 写 `g_EffectModelViewProjectionMatrix`（无 material 注解，`getMaterial` 预建单位阵）。状态会随脚本/视差移动对象，故每帧取一次。
3. **门控开启**：`ENABLE_CHAIN_FRAME_SNAPSHOT_CONSUMER = true`；`frameSnapshotBound = (门控常量 || allowFrameSnapshot) && referencesFrameSnapshot`，`frameTextureFor` 严格按它放行（未引用快照的链不受影响）；`registerFrameConsumer` 在 `setObjectChains` 时对引用快照的链调用（player 侧 `Set`，重复登记幂等）。

## Affected repositories

- `dsh-use-wallpaper` 不涉及

## Alternatives considered

**只绑矩阵、不开门控。** 不用它：槽仍留空，矩阵无从消费，等于没修。

**给快照纹理做 Y 翻转（或在 shader 里翻 UV）。** 不用它：快照是 `copyFramebufferToTexture` 的 three 纹理（v=0=屏幕底部），godrays frag 的 `*0.5+0.5` 正好把画布 NDC 转成该约定，翻一次反而全反。

**把快照按对象窗口裁剪后再绑。** 不用它：shader 要的是「整帧背景在屏幕坐标下的采样」，裁剪后 screenCoord 语义就错了。

**对所有无 material 注解的 mat4 统一预建单位阵。** 不用它：本任务只需要 `g_EffectModelViewProjectionMatrix`；其余（如 `g_Screen`、`g_EffectTextureProjectionMatrix*`）按各自语义单独处理/留待后续。

## Consequences

**收益：** 2597392171 的 godrays `COPYBG` 分支能拿到本帧背景；`g_EffectModelViewProjectionMatrix` 对引用快照的对象链路可用。

**成本 / 边界：** 引用快照的对象链启用后，该壁纸走**段渲染**（成本 O(段数×全场景)，§5.45）——只有真引用快照的链才登记，未引用壁纸零影响。**未做**：跨层 `_rt_imageLayerComposite_*` 合成仍无；对象链快照路径未做逐像素对照（需真机人眼验收）；`g_Screen`、godrays 之外的投影矩阵语义未覆盖。
