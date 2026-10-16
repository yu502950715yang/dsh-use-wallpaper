# Agent Note: 视差是对象平移，滞后时钟按帧重置

Status: implemented

## Problem

WE 的鼠标视差（`general.cameraparallax*` + 对象 `parallaxDepth`）在本仓库长期完全没有实现 —— 本机 34 张 scene 壁纸里有 1 张开了总开关、16 个样本带 `parallaxDepth`，在 DSH 里全都静止。

实现它有两个容易写错的点，两个都不是"照抄参考实现"能避开的：

1. **视差作用在哪个矩阵上**。直觉解法是"相机跟着鼠标动"，但 WE/OWE 的语义是**对象 model 矩阵的 2D 平移，相机不动**（OWE `UniformSource.cpp`）。选错主体会与既有的对象 RT 局部相机、合成 quad 等不变量正面冲突。
2. **`cameraparallaxdelay` 的滞后时钟怎么累积**。OWE 每帧先 `SetPointerInput`（滞后时钟**减去**已流逝时间）再 `Advance`（**加回**同一个 `frame.delta`），两者同帧抵消 ⇒ 字面搬运"跨帧累积 elapsed"时，`elapsed` 会停在**历史最大帧长**上。本播放器的 `dt` 被 clamp 到 **0.1s**，而本机唯一开视差的壁纸 `3793620838` 的 `cameraparallaxdelay` 恰好就是 **0.1** ⇒ 一次长帧（例如切走标签页再切回）就会把它**永久**打成"完全跟手"，此后再无滞后感。

## Decision

`src/client/parallax.ts` 是**纯数学层**（与 three 解耦、可在 node 单测），应用点是 `threejs-player.tickPuppets` 旁的 `tickParallax`：

- **平移主体是对象**：`shift = depth ⊙ ((node − cam) + mouse) × amount`（cam 在 three 坐标下是原点），逐帧只写 `Object3D.position`。**相机不动、渲染帧序不动**。粒子不走 `position` 而是顶点 shader 的 `u_Parallax`；隔离对象的落点是它的**合成 quad**。
- **滞后时钟按本帧取，不跨帧累积**：`elapsed = min(dt, delay)`，`amount = delay > 0 ? elapsed / delay : 1` —— 等价于"每帧重置滞后时钟"，稳态比例与 OWE 一致且无历史残留。判据是 `tests/parallax.test.ts` 的「滞后时钟封顶到 delay」与「delay>0：每帧按 `min(dt,delay)/delay` 靠近」两条（变异实测会红）。
- **`parallaxDepth` 全 0（或缺省）或总开关关闭的对象不写 `position`**：每帧无条件写会**盖掉脚本对同一对象 `origin` 的写入**。缺省 `undefined` = OWE 的 `{0,0}` = 不参与视差。
- 配置解析对畸形值一律回落缺省（`cameraparallax=false` / 其余 0），**不误开视差**；`parallaxDepth` 缺省/畸形 ⇒ `undefined`。
- `parallaxDepth` 放在**对象 `base`** 上（所有 kind 通用），不是只给 image：真实库 227 处该字段里 47% 挂在粒子上，只做 image 会让粒子视差永远取到 `undefined`。

## 涉及仓库

- `dsh-use-wallpaper` 分支 `master` commits `3a49580`

## Alternatives considered

**照 OWE 字面实现滞后时钟（跨帧累积 `elapsed`，加满即完全跟随）。** 理由：与参考实现逐行对齐，最容易论证"语义一致"。不用它是因为它在 OWE 里成立**恰恰因为**同帧的减/加相抵 —— 把那个抵消拆掉后只剩"记录历史最大帧长"这一个副作用；在本播放器的 `dt` 上限与真实 `delay` 值下，这个副作用会立刻变成用户可见的永久失效，而 OWE 与 WE 桌面上都不会。

**让相机跟着鼠标动。** 理由：直觉上"视差 = 相机移动"更符合字面，且实现最简单（动一个 `camera.position`）。不用它是因为 WE 的语义是对象 model 矩阵平移、相机不动；改相机会同时改变背景与所有对象的相对关系，并与隔离对象的局部相机、对象 RT 尺寸口径这些既有不变量相互干扰。

**每帧无条件写 `position`（省掉"全 0 不写"的分支）。** 理由：代码更短，且能保证脏对象的位移被清零。不用它是因为它会**每帧盖掉脚本对同一对象 `origin` 的写入** —— 脚本驱动的位移动画会静默失效（`AGENT.md` §7.39 记录了这条影响面）。

**把 `parallaxDepth` 只解析给 image 对象。** 理由：最初计划如此（视差主要被当成背景层的效果）。不用它是因为控制方亲测真实壁纸库后推翻：227 处 `parallaxDepth` 里 106 处挂在粒子上，只做 image 会让粒子层与验收样本里的 5 个粒子对象永远拿到 `undefined`。改放对象 `base`，粒子/文本对象也补字段类型。

## Consequences

**收益：** 视差在本机唯一开总开关的壁纸 `3793620838` 上生效，且鼠标停下后有平滑收尾；33 张未开视差的壁纸**完全不动**（零回归）；纯数学层可在 node 里钉住数值语义，反直觉的那条（时钟封顶）有会变红的判据守着。

**代价：** ① **传播组未实现** —— 父链锚点与 `disablepropagation` 未复刻，按"每对象自算 `parallaxDepth`"近似 ⇒ 子对象**不继承**父层深度（扁平层级观感一致，容器/组继承待做）；② `parallaxDepth` 缺省时**不参与**视差，而 WE 对 composite 容器有 `{1,1}` 缺省 —— 本仓未实现，故缺该字段的容器在 WE 里会动、在这里不动；③ **开视差时脚本对同一对象 `origin` 的写入每帧被丢弃**（基准位取自创建期，`tickParallax` 每帧写 `position = 基准位 + shift`，而 OWE 是 shift 与脚本 model 平移叠加）；影响面是落点在 `position` 上的那几路（背景、隔离对象的合成 quad），非隔离粒子走 `u_Parallax` 不受影响；当前本机无实害（唯一开视差的壁纸 pkg 内无 `.js` 脚本），真遇到"脚本位移 + 视差"同对象的壁纸须先按叠加语义改 `tickParallax`。

机制推导与实测样本见 [scene 视差与 puppet 实施计划](../../../../docs/superpowers/plans/2026-10-13-scene-parallax-puppet.md)；上述边界也是 `AGENT.md` §5.47 / §7.39 的表述。
