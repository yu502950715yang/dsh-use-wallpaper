# Agent Note: puppet 对象效果链的 v 约定错位（波动出现在错误部位 / 部分人物效果静默失效）

Status: implemented

## Problem

用户反馈「波动的效果不正确」：黑武者的水波出现在不该动的部位、方向与桌面 WE 不一致；进一步反馈「上面（红）人物的衣服也没有动」。

实证（`3828798871`，e2e + 运行时探针）：

- 红人物（renwu 2，object 35）的效果链执行无报错、4 条链 4 个 pass 材质都编译、mask 1920×1080 已加载且数据非空，但把链输出 RT 与内容 RT 逐像素比较：**完全相同（mean/max diff = 0）** —— 效果等于没生效。把 waterwaves 参数拉到极端（strength=1、scale=300）画面与 RT 仍无任何变化。
- 把 waterwaves 片元输出临时改成 `vec3(mask)` 后截图：**mask 采样在整个红人物上恒为 0**（人物被渲染成纯黑）；把 mask 改为 bottomUp（显示约定）加载后同一实验变成整块 1 —— 证明 mask 的 v 方向与链内容相反。
- 黑武者的波动存在，但 mask 覆盖区与授权区错位（v 镜像）：所以「落在错误部位」。
- 根因：puppet 隔离内容 quad 建时多调了一次 `flipGeometryUvY`。y 镜像局部相机 + 标准 three uv + 显示约定贴图本来就会得到 **WE 约定 RT**（v=0=图像顶部，与图片对象一致）；再翻一次就把内容 RT 变成显示约定，而效果纹理槽按 `rowOrder:'topDown'`（WE 约定）加载 ⇒ mask 在 v 上整体镜像。黑武者 atlas 几乎铺满贴图，镜像后仍有部分重叠（表现为波动位置错）；红人物 atlas 只在贴图上部的窄条，镜像后 mask 采样全 0（效果静默失效）。

## Decision

- puppet 效果链内容 quad **不再** `flipGeometryUvY`（`threejs-player.addPuppet`）：内容 RT = WE v 约定，与图片对象和 topDown 加载的 mask 同一套坐标；
- 链输出同为 WE 约定，而 puppet 网格 uv 是显示约定（`puppet.ts` 的 `flipGeometryUvY` 用于直接采样原始贴图）⇒ 在**最终采样处**补一次垂直翻转：`setObjectOutput` 给链输出纹理设置 `repeat.y=-1 / offset.y=1`（幂等，仅 puppet 分支）；
- 直接渲染（无效果链）路径零改动：贴图仍是显示约定、网格 uv 仍是显示约定，逐像素对比确认无差异。

## Alternatives considered

**只把 mask 改成 bottomUp（显示约定）加载**：能让 mask 与内容对齐，但整条链的 v 语义仍是显示约定（v=0=底部），而 WE 效果 shader 把 v 当图像空间纵坐标 ⇒ 带符号方向/滚动类效果的纵轴方向与 WE 相反（`AGENT.md` §5.20 已记录该坑），且与图片对象的加载口径分叉。弃用。

**把整个 puppet 管线迁到 WE v 约定**（贴图 topDown 加载 + 网格 uv 不翻）：语义最干净，但会动到直接渲染路径与已验收画面（贴图被多处共享、翻转成本高），风险大于收益。弃用。

**在内容 RT 与输出 RT 各翻一次互相抵消**：等于当前 bug 的变体，mask 仍错位。弃用。

## Risks

- 效果链 v 约定与直接渲染 v 约定不同，是**刻意的**：不要「统一」成一边，否则要么 mask 错位、要么直接画面上下颠倒（`tests/threejs-player.test.ts` 新增断言：内容 geometry uv 必须与标准 PlaneGeometry 一致；`setObjectOutput(puppet)` 必须设置 `repeat=[1,-1]/offset=[0,1]`）。
- 该翻转只对 puppet 分支生效；图片对象的合成 quad 仍走 `flipGeometryUvY`（几何侧），两者不要互换。
- 多动画层模型（如 leon `3812518176` 的 4 层）仍只应用第一条可见层，属既有 v1 边界，与本修复无关。

## Consequences

**收益：** 两个人物（黑武者 / 红人物）的 puppet 效果链输出均非恒等，波动回到 mask 授权部位、方向与 WE 语义一致；红人物 4 条效果链不再静默失效。

**代价：** 无运行时性能变化（每纹理一次 uvTransform 设置）；测试需同步纠正（内容 uv、输出 uvTransform 的断言），真实素材 e2e 对比值随之变化。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `267afaa`
