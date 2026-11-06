# Agent Note: 蒙皮绑定姿势回退为 MDLS 链（frame0-bind 误判导致动画/波动错位）

Status: implemented

## Problem

用户反馈「波动的效果不正确」——水波/布料波动出现在不该动的部位（盔甲、脸、刀等），或方向与桌面相反。

往回追：上一轮为修「人物运动还不对」，把 puppet 的蒙皮绑定姿势从 **MDLS 局部矩阵链** 改成了 **主动画（`animations[0]`）第 0 帧**（commit `74e4d4e`）。当时依据是 WE 独立预览窗口的同相位截图对比：黑武者的帽檐/长刀/弯刀整体偏 20°+，改成 frame0-bind 后"看起来一致"。

但这个对比方法本身不可靠：WE 预览窗口抓到的窗口矩形（1296×759）与真实内容区（1280×720）不一致、动画相位（内容起始时刻）也只是估计值；把窗口比例/相位差异误读成了绑定姿势差异。

参考实现的明确语义（用户提示的示例项目 `webwallgl` 与本仓 `.superpowers/we-layerd-src` 参考引擎一致）：

- `WPPuppet::prepared()`：`local_bind` ← MDLS 骨矩阵；`world_bind` 沿 **`bind_parent`** 链累乘；`inv_bind = world_bind.inverse()`。
- `WPPuppet::genFrame()`：动画帧 0 只是「多条动画层混合的基准姿势」（base），蒙皮矩阵恒为 `world(anim) · inv_bind`。
- 示例项目 `computeSkinMatrices` 同口径（base=bind，非 additive 层 blend=1 时用采样值覆盖 base）。

后果：本模型 `3828798871` 的 **骨 3 的 frame0 欧拉角与 MDLS 差 -0.424 rad**（其余骨基本相同）。用 frame0 当 bind 后，所有骨的蒙皮结果带上一个系统性旋转/位移，人物整体姿态错位；水波在贴图空间的位移再经这层错误骨架投射，就表现成「波动出现在错误部位/方向不对」。

## Decision

`src/client/puppet.ts` 回退：建骨时直接把 MDLS 骨矩阵分解成局部 TRS、按父链挂树后 `bind()`（`Skeleton.boneInverses` = MDLS 父链世界矩阵的逆）；**不再用动画 frame0 覆盖骨骼初值**。上一轮 `applyFrame` 的采样口径保留：loop 按区间数（`keys.length-1`）环绕、mirror 正播/倒播、single clamp，与参考引擎 `genInterpolationInfo` 同口径；欧拉角逐帧转四元数后 slerp 也不变。

真实素材回归（`tests/mdl-real-library.test.ts`）改为两条硬断言：

1. `skeleton.boneInverses[i]` == 由 `puppet.bones[].bind` 父链累乘后求逆（能抓住绑定姿势再次被改成别的基准）；
2. 本模型 `applyFrame(frame0)` 后骨 3 的蒙皮矩阵**不是单位阵**（因为 frame0 ≠ MDLS；取消上一轮「t=0 必须恒等」的错误判据）。

`tests/puppet.test.ts` 同步：bind 只来自 MDLS（frame0 平移 9 不能改写 bind 平移 5）、无作者姿态轨保持 bind、frame0 播放时蒙皮矩阵 = world(frame0) − bind。

## Alternatives considered

**保留 frame0-bind（不做回退）。** 与参考引擎/示例项目语义冲突，且对 frame0≠MDLS 的模型会让全部骨姿势系统性偏移——正是本轮用户报的现象；已证伪。

**按模型自动二选一（比较 frame0 与 MDLS 的差异大小再决定）。** WE 的语义是确定的（bind=MDLS、frame0 只作混合基准），不存在「自动择一」；猜测逻辑只会把个别模型的偏差固化。

**继续用 WE 独立窗口截图做判据。** 该对比需要先解决内容区尺寸与动画相位对齐（窗口矩形含非客户区、相位只能估计），本轮已证实会把比例差误读成姿势差；不把它作为唯一判据。

## Risks

- 少数模型 frame0 ≠ MDLS 时，WE 在动画起点本来就不是单位蒙皮（可能带固定偏移）——这是正确行为，不要再用「t=0 必须恒等」去"修"它。
- 本机 e2e 只能证明「动画在动 + 像素差显著」，不能证明与 WE 逐帧同姿势；参考引擎/示例项目的蒙皮矩阵对拍是当前最强判据。
- 动画层混合仍只应用第一条可见层（本壁纸单层无影响）；多条 additive/blend 层的完整语义见参考引擎 `m_layers`，不在本轮范围。

## Consequences

**收益：** 与示例项目 `webwallgl.computeSkinMatrices` 逐骨对拍 **Δ=0**（t=0/0.3/1/2/4），骨架加载语义与参考实现完全一致；人物/披风/水波位移回到正确部位，修复用户本轮反馈。真实素材回归能防止「绑定姿势被改成 frame0」再次回潮。

**代价：** 无运行时代价（少了一遍 frame0 覆盖）；只是把上一轮的错误改动回退并把判据改正确。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `0aa1145`
