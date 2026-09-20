# 场景树层级变换（parent）— 设计文档

- 日期：2026-09-20
- 状态：**设计待用户确认**（用户报 `3798688689` 画面只有左侧一块后立项）
- 项目根：`E:\code\dsh-use-wallpaper`
- 关联：
  - `AGENT.md` §5.14（坐标与对象变换约定：WE 场景系左下原点、y 向上、model matrix = T·R·S、angles 是弧度、R = Rz·Ry·Rx）—— 本文的累积规则必须与该约定一致
  - `AGENT.md` §5.15/§5.21（对象 RT 尺寸口径：**世界尺寸**是唯一基准）—— 世界尺寸因此也必须含父链 scale
  - `docs/technical-notes.md` §1.1（three 主路径装配）
  - 参考实现：`research/open-wallpaper-engine/src/Scene/Pkg/Parse/Particle/SceneParticleObjectParser.cpp:365-367`（`parent's world scale times this node's local scale`）、`.../Scene/SceneToRenderGraph.cpp:583,601,633`（`node->GetChildren()` 场景图遍历）、`research/audit-wasm-parallax-extension.md`（`disablepropagation` 属视差传播，非本文范围）
  - 受影响样本：`3798688689`（用户报障）、`3765967112`、`3789452668`

## 1. 概述

WE 的 `scene.json` 是**树形场景**：对象可带 `parent`（父对象 id），子对象的变换相对父节点，最终世界变换 = 父链累积 × 自身局部变换。

**我们一直按扁平处理** —— 每个对象直接用自身的 `origin`/`scale`/`angles`。对绝大多数壁纸（对象扁平）无影响，但 `3798688689` 是**重度层级化**的：

| 项 | 实测 |
|---|---|
| 对象总数 | 527（`none` 319 个容器 / `image` 182 / `util` 24 / `text` 2） |
| 带 `parent` 的对象 | **505 / 527** |
| 可渲染对象（image/util/text/particle） | 208，其中 **195 个带 parent** |
| 子对象 `origin` 为 `undefined` 的比例 | 大量（位置完全由父链决定） |
| 层级深度 | 最深 11 层（`1 → 1000 → 1001 → 1003 → …`） |

⇒ 渲染结果：195 个对象各用自身（缺失→0）的 `origin` 与不含父级的 `scale` ⇒ 全堆在场景原点附近 ⇒ **画面只剩左下一块，其余空白**（与用户截图一致）。

本文实现层级变换的解析与累积。

## 2. 事实基础

### 2.1 反算验证（决定性证据）

用 `3798688689` 的真实数据沿父链累积（`scale` 逐分量相乘、`origin` 按父 scale 偏移），三个背景层的世界宽度**精确等于场景宽 2560**：

| 对象 | 自身 `size` | 父链累积 scale | 累积后世界尺寸 | 场景 `orthogonalprojection` |
|---|---|---|---|---|
| `id=10030` `[003] matte_back · 纯色`（`models/util/solidlayer.json`） | 100×100 | **(25.6001, 15.7539)** | **2560**×1575 | 2560×1440 |
| `id=10070` `[007] bg_kv2_blur.png` | 512×512 | **(5.0000, 3.7180)** | **2560**×1904 | 同上 |
| `id=10080` `[008] bg_kv2$0.png` | 4680×2880 | **(0.5470, 0.5470)** | **2560**×1575 | 同上 |

三个互相独立的层都精确落在 2560 ⇒ 语义（**父的 world scale 逐分量乘子节点 local scale**）被数据独立证实。（这三层的父链 `angles` 均为 0，故反算可忽略旋转；父链含旋转的对象不在本基准内，见 §3.2 与 §5。）

补充实测（同一张壁纸）：带 `parent` 的 505 个对象中 `origin` 缺失 **158** 个、`scale` 缺失 **278** 个 ⇒ 这些对象的变换**完全**依赖父链；`angles` 非零 12 个。

### 2.2 参考实现语义（逐字）

```cpp
// SceneParticleObjectParser.cpp:365-367
// Effective world scale at this SceneNode: parent's world scale times
// this node's local scale. Propagated to child particle nodes.
Eigen::Vector3f node_world_scale = child_ptr.world_scale.cwiseProduct(spNode->Scale());
```

- 父链的 `world_scale` 向下传播（`cwiseProduct` = 逐分量乘积）；
- `SceneToRenderGraph` 用 `node->GetChildren()` 递归遍历场景图（`:583,601,633`）；
- `SceneImageObjectParser.cpp:601` 注明「camera follows the layer through any parent-container world」—— 变换是**贯穿父容器**的完整链。

### 2.3 影响面（全库 29 张实测）

| 壁纸 | 可渲染且带 parent 的对象数 |
|---|---|
| `3798688689` | **195** |
| `3765967112`（Crimson Horizon） | 4 |
| `3789452668`（Knight in a red cloak） | 3 |
| 其余 26 张 | 0（零影响） |

### 2.4 现状（扁平处理的位置）

- `src/client/scene-json.ts`：**完全没解析 `parent`**（`SceneObject` 无该字段）；`none` 容器对象落入「空粒子兜底」被丢弃，其变换信息也一并丢失。
- `src/client/three-renderer.ts`：组装时直接用 `obj.origin` / `obj.scale` / `obj.angles` 建 quad、算隔离对象世界尺寸（`objectRtSize(world.w, world.h, screenScale)`）。
- `src/client/threejs-player.ts`：`addBackground` / `addParticle` 用传入的 origin/scale/angles 建 mesh 与粒子对象变换。

## 3. 设计

### 3.1 新模块 `src/client/scene-graph.ts`（纯逻辑，node 可测）

```ts
export interface WorldTransform {
  origin: [number, number, number];   // 世界空间（WE 场景系）平移
  scale: [number, number, number];    // 世界空间累积缩放（逐分量）
  angles: [number, number, number];   // 世界空间累积欧拉角（弧度）
}
/** 解析每个对象的**世界变换**（父链累积）；无 parent 的对象原样返回。 */
export function resolveWorldTransforms(
  objects: Array<{ id: number; parent?: number; origin: [number, number, number]; scale: [number, number, number]; angles?: [number, number, number] }>,
): Map<number, WorldTransform>;
```

内部：一次性建 `id → object` 索引与 `id → children`，自根向下递归累积（带深度上限与环检测，防御畸形数据）。

### 3.2 累积规则（与 AGENT.md §5.14 的 T·R·S 约定一致）

局部矩阵 `L = T(origin) · R(angles) · S(scale)`；世界矩阵 `W = W_parent · L`。

下游只需要 `origin/scale/angles` 三个量（既有渲染路径就是这样建 quad 的），因此按矩阵提取：

- **scale**：`W_scale = W_parent.scale ⊙ local.scale`（逐分量，与 OME 一致）；
- **origin**：`W_origin = W_parent.origin + W_parent.R · (W_parent.scale ⊙ local.origin)`（父的旋转作用在子的偏移上）；
- **angles**：`W_angles = W_parent.angles + local.angles`（本样本 505 个带 parent 对象中 **12 个 `angles` 非零**、256 个容器中 **7 个带旋转** ⇒ **父链确实存在旋转**，不能假设为零）。逐分量相加在父链同轴旋转时精确、多轴时是近似；因此实现上用**矩阵累积** `W = W_parent · L` 并分解三个量（`origin` = 平移列、`scale` = 基向量模长、`angles` = 由旋转部分提取），保证 `origin`/`scale` 精确（§2.1 的验收只看这两个量）。角度在本文**如实标注为近似**：本库没有「多轴旋转父链」的样本可验证，将来遇到需专项对拍。

**退化保证**：无 `parent` 的对象必须**逐字保持**原有字段（不引入任何数值变化）⇒ 26 张扁平壁纸零回归。

### 3.3 接入点（最小侵入）

在 `three-renderer.ts` 的组装**最前面**算一次世界变换表，随后所有消费者改用世界值：

| 消费者 | 现在用 | 改为 |
|---|---|---|
| `addBackground`（image/text） | `obj.origin/scale/angles` | 世界值 |
| `addParticle`（粒子对象变换、emitter 原点） | 同上 | 世界值 |
| 隔离对象世界尺寸 `world = |size × scale|` | 局部 scale | **世界 scale** |
| `particleWorldSize(spec, scale)` | 局部 scale | 世界 scale |

`scene-json.ts` 增加 `parent?: number` 字段解析（`SceneObject` 各变体 + `none` 对象也保留该字段，因为容器要参与祖先链计算 —— 容器本身仍不渲染）。

### 3.4 与既有约定的关系

- **对象 RT 尺寸口径不变**（`世界尺寸 × 屏幕密度`，AGENT.md §5.15）：只是「世界尺寸」现在含父链 scale ⇒ 修好后这类壁纸的隔离 RT 才与屏占位一致；
- **y 约定不变**（场景系左下原点、y 不翻）：累积在 WE 场景系内完成，映射到 three 仍走既有 `we_to_three`；
- **`disablepropagation` / `parallaxDepth`**：属视差传播，不在本文范围（视差本身也未实现）。

### 3.5 性能

每次壁纸装载做一次 O(n) 遍历（本样本 527 个对象）⇒ 可忽略。变换表随壁纸装载重建，不常驻。

## 4. 非目标

- **util 对象渲染**（`3798688689` 的 24 个 `solidlayer`/`composelayer`、16 条效果链）—— 独立一块，本文不做；因此该壁纸修完后**仍不完整**（见 §6）；
- 音频响应效果（`Simple_Audio_Bars` 需要频谱输入）；
- 视差传播（`disablepropagation`）、`parallaxDepth`；
- 3D `model` 对象、骨骼（MDMP）；
- 粒子父子子系统（OME `ParticleSubSystem::SpawnChild`）。

## 5. 验收标准

1. **单测（纯函数）**：用 `3798688689` 的真实数据断言三个背景层（`10030`/`10070`/`10080`）累积后的世界尺寸分别为 **2560×1575 / 2560×1904 / 2560×1575**（= §2.1 反算基准）；多级链、缺失字段继承、`angles=0` 退化路径。
2. **零回归单测**：无 `parent` 的对象世界变换与其局部值**逐字段相等**（26 张扁平壁纸不受影响）。
2b. **健壮性单测**：父链含旋转（本样本 7 个容器带 `angles`、12 个子对象非零）时结果**有限且非 NaN**；环状 parent 链退化处理且不挂死；深度上限生效。
3. **集成单测**：`three-renderer` 组装时传给 `loadSceneToThree` 的 origin/scale 是世界值（用 `3798688689` 数据断言）。
4. **端到端**：`3798688689` 经 harness 渲染后画面**铺满**（不再是左下一块）；`console error = 0`；挂载期 RT 断言 PASS。
5. **回归**：`3743126786`（GTR）、`2980088441`（CodeTime）画面与本次改动前一致。
6. `tsc` exit 0；`lib/`、`dist/` 一并提交。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 变换顺序/符号写错（历史上坐标事故多次，AGENT.md §5.14） | 以 §2.1 的**反算基准**做单测（三个独立层都必须精确落在 2560）；退化路径单测保证扁平壁纸逐字段不变 |
| 旋转父节点使 `origin` 累积不满足简单公式 | 用矩阵累积（`W_parent.R` 作用在子偏移上），不用逐分量相加近似 |
| 环状/畸形 parent 链 | 深度上限 + 访问标记，遇环则退化为局部值并 warnOnce |
| 容器对象（`none`）仍不渲染 ⇒ 用户仍觉得"不对" | §4/§6 明确：util/容器渲染是下一块；本次交付的验收口径是**画面结构铺满 + 三个背景层世界尺寸正确**，不是"这张壁纸完全还原" |
| 隔离对象世界尺寸变化 ⇒ RT 尺寸变化 | 属预期修正（AGENT.md §5.15 口径不变，只是输入更正确）；`3743126786` 等无 parent 壁纸作为零回归对照 |

## 7. 测试计划

- 纯函数单测（`tests/scene-graph.test.ts`，node）：反算基准 3 例、多级链、缺失字段、角度非零、环检测、扁平退化；
- `tests/scene-json.test.ts`：`parent` 字段解析（对象各形态 + 容器）；
- `tests/three-renderer.test.ts`：组装用世界值（含隔离对象世界尺寸）；
- e2e（harness）：`3798688689` 铺满 + `3743126786`/`2980088441` 回归。

## 8. 与既有裁定的关系

不是推翻裁定，而是**补一个从未实现的 WE 语义**。此前它没被发现，是因为 26/29 张壁纸的对象是扁平的；`3798688689` 是用户库中新出现的重度层级化样本。
