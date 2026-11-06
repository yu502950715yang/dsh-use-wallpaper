# Agent Note: puppet 对象级效果链（贴图空间合成，披风/衣摆动画）

Status: implemented

## Problem

壁纸「影之刃零1」（`3828798871`）在桌面 Wallpaper Engine 里两个人物除了骨骼动画还有**披风/衣摆/刀鞘飘带的布料波动**，dsh 里没有。素材侧事实：两个 puppet 对象的 `scene.json` 都带 `effects`（renwu 1：6× `waterwaves` + 1× `shimmer`，其中一条水波名「呼吸」；renwu 2：4× `waterwaves` + 1× `shimmer`），但 `three-renderer` 对带链的 puppet 对象走的是「直渲 + `puppet 对象不支持对象级效果链` 告警」的跳过分支（旧口径：对象隔离只覆盖 image/particle/util/text，理由是「对象 RT 隔离未覆盖蒙皮网格」）。

根因不在于「蒙皮网格不能进 RT」，而在于**效果链该跑在哪个空间**：WE 的 puppet 效果在**贴图空间**合成（webwallgl `renderer.js` 的 `drawPuppetDirect(… overrideTex)` 即此语义），输出结果直接作为网格贴图被 UV 采样；若按 image 对象那样「把对象内容渲进对象 RT、再在主场景贴合成 quad」，蒙皮/形变会先被烘进 RT，效果作用在**形变后的画面**上，反而不是 WE 行为。

## Decision

`threejs-player.ts` / `three-renderer.ts` 给 puppet 增加「贴图空间效果链」路径：

- `three-renderer` 把带链的 puppet 对象也放进 isolate 表（值带 `puppet: true` 派生于 `puppetMeshes.has`）；源纹理尺寸、`isolatedRtSize` 预算与 image 同口径。
- player 新增隔离条目 `kind: 'puppet'`：内容 = **对象贴图的平面**（`PlaneGeometry` + `flipGeometryUvY`，尺寸取对象世界尺寸，aspect 与贴图一致），**不往主场景放合成 quad**（`quadAttached=false`；quad 对象仍保留，只承载世界位置给 `effectScreenMatrix` 与释放）。人物网格照旧由主场景 `SkinnedMesh` 按骨骼绘制。
- `setObjectOutput(id, texture)` 对 puppet 条目把链输出写回 puppet 材质 `map`（`material.needsUpdate`）。⚠️ **不得再叠 `texture.repeat/offset` 做 v 翻转**：puppet 几何 UV 与合成 quad 一样已翻成 GL 约定、链输出沿用对象 RT 的 WE 约定，两边口径一致；再翻一次就是双翻，图集会散架、人物消失（本轮实测踩过）。
- 颜色/亮度调制仍烘在 puppet 材质上，不受影响。

测试：`tests/threejs-player.test.ts` 新增「puppet 隔离条目形状（kind/无合成 quad/内容=贴图平面）」「`setObjectOutput` 写回 map 且不改 uvTransform」「dispose 释放 RT」；`tests/three-renderer.test.ts` 把旧「跳过 + 专属告警」用例改成「进 isolate 表 + 挂链 + 建 stage」，预算用例改成 puppet 与 image 同口径收口。

## Alternatives considered

**走 image 对象的旧隔离路径（蒙皮结果渲进对象 RT，再叠合成 quad）。** 不用：这就是 webwallgl 注释里说的「旧实现」——效果作用在形变后的画面，而 WE 的 waterwaves/shimmer 资源（含 mask）是按静止姿势的贴图/层矩形空间设计的，必须先在贴图上合成、再由网格整体形变。

**不建隔离条目，直接把效果链输出贴到 puppet 上（不做内容 RT）。** 效果链需要 `g_Texture0` = 内容输入（对象自身图像）；没有内容 RT 就得自己造一张同尺寸输入纹理，等于把隔离条目手工重写一遍。复用现有 stage/runner（含快照、mask、segment 语义）风险最小。

**在 puppet 材质上叠 uvTransform 把采样翻回来。** 已证伪：链输出与合成 quad 同采样口径，直接采样即正立；叠了就是双翻 ⇒ 图集散架（本轮第一次实现的症状）。

## Risks

- **shimmer 未生效**：两条 shimmer 链的 pass 编译失败（`vec4 → vec3` 维度不匹配，纹理槽 = `masks/shimmer_mask_*`），按现有降级跳过 pass；waterwaves 全部生效。修法是 shader 方言层的单独任务，不在本次范围。
- **效果参数/混合的细节**：各 waterwaves 的 `g_Speed/g_Scale/g_Strength` 等 material 参数经现有 binder 绑定，但 WE 的 `colorBlendMode`、对象 alpha 与链输出的顺序语义仍按现有对象链口径近似。
- **性能**：puppet 对象 RT 尺寸与 image 同口径进预算（本张 3840×2160 源纹理、目标长边 4096 收口），7 条链合并成一个 graph plan 每帧推进；比直渲贵，但与本机其它带链 image 对象同量级。
- **隔离条目的世界位置/旋转**只用于 `effectScreenMatrix`（本库链不消费整帧快照），如后续出现依赖屏幕空间的 puppet 效果需重新核对。

## Consequences

**收益：** 本机「影之刃零1」的披风/衣摆恢复与桌面同形的布料波动：披风区跨帧 `meanAbsDiff` 3.33（仅骨骼）→ **9.64**（WE 真机基准 8.25）、changed% 19.0%（WE 19.8%），A/B 静止对照比 14.2；Console 不再出现 `puppet 对象不支持对象级效果链`。效果链编排、mask、segment、预算等全部复用既有对象链机制。

**代价：** puppet 隔离条目多一张对象 RT 与一条 graph plan（显存/每帧成本上升）；player 的 `IsolatedObject.quad` 变为「可不在主场景」的语义（`quadAttached` + `puppet` 字段），后续改隔离管线时要区分三种 kind。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `fed5a08`
