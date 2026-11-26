# WE puppet 模型（`.mdl`）格式规格

`src/client/mdl-parser.ts` 的解析依据。布局全部来自真实素材实测（`3828798871` 的两个人物、`3812518176` 的 leon）与参考实现 we-layerd 的 bounded section 口径。

> 归属：本文件是**格式契约**，改解析器时同步这里。AGENT.md §7.40 只留结论、边界与判据。

## 1. 段容器

| 字段 | 大小 | 说明 |
|---|---|---|
| stamp | 9B | `MDxx0000\0`（如 `MDLS0004`、`MDLA0006`） |
| 段尾绝对偏移 | u32 | **独占**；段尾之后的下一个段头可紧接 |

- 段间可夹其它段（leon 实测顺序 = MDLS → MDAT → MDLA → MDLE）。
- 解析只认合法段头：版本数字可识别 **且** 段尾落在 `(payload, fileLen]`；无效头继续向后扫描。
- 参考实现：we-layerd `parser/mdl/Section.cpp`（本地调研目录，未入库）。

## 2. MDLS（骨骼）

```
u16 骨数 + u16 填充
每骨：
  name        cstr（真实素材为空名）
  i32         临时值，恒 1 —— **不是骨 id**
  u32         父索引（0xFFFFFFFF = 根；父必须 < 当前下标，否则按根处理防成环）
  u32         绑矩阵字节数（= 64）
  f32[16]     绑矩阵（列主序）
  cstr        仿真 JSON
```

`MDLS > 1` 的扩展块（transform / metadata / skin pivot 等）**未解析**，只靠 bounded section 保证不越界。

## 3. MDLA（动画）

```
u32 动画数
每动画：
  id          读前跳过 0 值占位（读到非 0 为止）
  i32
  name        cstr（空名再读一次兜底；UTF-8，真实素材 = 中文「动画 1」）
  mode        cstr
  f32         fps
  i32         长度（帧数，可小于关键帧数：循环末帧 = 首帧，实测 361 帧关键帧对 360 帧长度）
  i32
  u32         轨数
  每轨：
    i32       真实素材恒 0 —— **不是骨 id** ⇒ 轨序即骨序
    u32       字节数
    关键帧 × N（每帧 36B）：pos f32[3] + 欧拉角 f32[3]（弧度）+ scale f32[3]
35B 全零尾块后才接下一个动画（见下）
```

- **36B 关键帧**：`pos + 欧拉角 + scale` 共 9 个 float。四元数模长判据不成立 —— 此前按 `pos + quat + scale.xy` 读是错的。
- **35B 全零尾块**：轨表之后固定存在（实测 6/6 动画全零）。**多动画必须整块跳过**：参考实现只读 1B，会让下一动画错位。内部结构未确证，只按长度跳过。
- `mdla < 3` 的旧版本改为读 metadata 表。

## 4. 动画帧语义

- 关键帧是**绝对局部变换**（轨 0 首帧 pos 与骨 0 的 MDLS bind 平移一致，误差 < 1e-2）；但帧 0 只是播放起点 / 混合基准，**不是蒙皮 bind**。
- 欧拉角组合顺序 **Rz·Ry·Rx**（= three `Euler` order `'ZYX'`，`puppet.ts` 的 `keyframeQuaternion`）。
- 全零 / 单位值的轨按 `authored = false` 处理 ⇒ 渲染侧保持绑定姿态，不把骨骼清成 0。

## 5. 蒙皮口径

- stride 80 顶点：`blendIndices`@40 是**骨表下标 0..n-1**（不是文件 id）；`weights`@56 四槽和 = 1（实测 1209 / 509 顶点全部 1.0000）。
- ⚠️ **旧实现**把 MDLS 每骨的临时值当 fileId 做「id 升序重排」⇒ 5 根骨映射到同一个 id、顶点引用的下标 2/4 被判「缺骨」⇒ 整份蒙皮退化为静态网格。该重排逻辑与 `MdlPuppet.boneIdMapping` 字段**已删除**：蒙皮槽与骨表同口径 = 记录顺序。越界下标仍会退化静态网格并告警一次。

## 6. 绑定姿势 = MDLS 局部矩阵链

- `boneDefs[].bind` 按父链累乘；`puppet.ts` 建骨时把 MDLS 矩阵分解成骨局部 TRS，`Skeleton.boneInverses` = 该链世界矩阵的逆。
- 与参考引擎 `WPPuppet::prepared()` 的 `local_bind` + `bind_parent` → `inv_bind` 同源；示例项目 webwallgl 同口径。
- **蒙皮矩阵恒为 `world(anim) · inv_bind`**，动画帧 0 不是基准 —— 参考引擎 `genFrame()` 只把 frame0 当「多条动画层混合的基准姿势」。
- 判据：与 webwallgl `computeSkinMatrices` 逐骨对比 Δ=0（2026-11-06 实测 t=0/0.3/1/2/4 全 0）。
- ⚠️ 曾误改成「bind = 主动画 frame0」（`74e4d4e`）：对 frame0 ≠ MDLS 的模型（`3828798871` 骨 3 欧拉角差 -0.424）会造成全部骨姿势系统性偏移、人物/波动出现在错误部位。2026-11-06 已回退，`tests/mdl-real-library.test.ts` 现在断言 `boneInverses` == MDLS 父链的逆。

## 7. 循环采样

`applyFrame` 按**关键帧区间数（`keys.length - 1`）**环绕：loop 首尾帧重合；mirror 正播→倒播；single clamp 末帧。与 WE `genInterpolationInfo` / webwallgl `frameIndices` 同口径。

## 8. 历史：`animations=[]` 的根因（已修）

`locateTracks` 曾假设「轨数之后有 35B 固定填充」，而真实素材的轨表紧接轨数 ⇒ 每轨字节数被判不自洽 ⇒ `mdla:'failed'`、`animations=[]` ⇒ `tickPuppets` 无动画可采样。新实现按 bounded section + 真实布局解析。
