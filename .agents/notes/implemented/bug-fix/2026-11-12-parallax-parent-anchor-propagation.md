# Agent Note: 视差父链锚点传播（子层跟随父层）

Status: implemented

## Problem

[媒体封面默认图回退](./2026-11-12-media-cover-fallback-texture.md) 修好白块后，壁纸《Somewhere In Nowhere [4K]》（`3819637149`）右上角的专辑封面与蓝色封面框仍有错位：开启相机视差后，指针一动封面框就比封面多走约 7px（1920×1040 下实测中心差 `(-7.0, +3.5)`），关视差或指针回中则对齐（`(0.5, 0)`，余量为 215 vs 200 的取整）。生产 `lib/` 同视口重渲染复现同一数值。

根因：scene.json 里封面 `#171` 是封面框 `#429` 的子对象（`parent: 429`），**自身没有 `parallaxDepth`**；旧实现按「每对象自算视差」——父层 `depth 0.06` 有位移，子层无深度被判为不参与 ⇒ 两者相对位置漂移。WE 的语义是**传播组**：子层继承父链锚点的视差位移，父层 `disablepropagation: true` 才阻断（参考实现：本地研究目录 `.superpowers/we-layerd-src` 的 `WPNodeTransformResolver::ComputeParallaxOffset` 与 `parallax_propagation_test.cpp`，该目录未入库）。这正是 AGENT §7.39 早已记录的「传播组未实现」缺口——此前本机无命中（另一张开视差且 `amount ≠ 0` 的 `3793620838` 没有父子关系），本壁纸是第一个暴露它的素材。

## Decision

- 新增 `src/client/parallax-contract.ts` 的 `resolveParallaxContracts()`（纯函数，无 three 依赖）：按参考实现口径为每个对象解析 `{ depth, node, anchorId }`——
  - 子层未声明非零深度（缺省 / `|depth| ≤ 1e-4`）⇒ 继承父锚点；
  - 父层本身也继承、或父层深度为零 ⇒ 继续沿用祖先锚点（zero-depth parent 保留参考实现的旧父锚点行为）；
  - 父子都声明非零深度 ⇒ 子层各算各的；
  - 父层 `disablepropagation: true` ⇒ 阻断该父层向子层传播；
  - `node` 取**锚点对象的世界 origin**（使用 renderer 已算好的 `worldTransforms`），子层因此与父层拿到完全相同的 shift，而不是用自身 origin 重算。
- `src/client/scene-json.ts` 解析 `disablepropagation → disablePropagation`（仅显式 `true` 保留）；`src/shared/types.ts` 的 `SceneObjectBase` 加该字段。
- 图层条目新增「视差节点」：`BackgroundEntry.parallaxNodeOrigin`（WE 场景坐标）与 `ParticleLayer.parallaxNode`（three 世界坐标）；`threejs-player.loadSceneToThree` 对 image / text / util / puppet / particle 五种图层统一下发契约（粒子把锚点 origin 换成 three 坐标的 `parallaxNodeCenter`），`parallax-runtime.tick` 用锚点 node 算 shift、**基座位置仍用自身 origin**（子层不一定与父层同原点）。
- 回归用例：`tests/parallax-contract.test.ts`（8 例：继承/显式零深度/双方非零/disablepropagation/传递/零深度父/环/悬空父）、`tests/scene-json.test.ts` 解析用例、`tests/threejs-player.test.ts` 4 例（背景与粒子的锚点节点、父链继承集成、disablepropagation 集成）；`lib/` 与 `dist/client.js(+map)` 同步重建。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `21c848b`

## Alternatives considered

**把父层位移在 scene-graph 里直接累积进子层世界变换。** 看似最贴近「传播」。不用它：视差位移是指针的逐帧函数（还带 delay 插值），不属于装配期静态世界变换；塞进 `worldTransforms` 会把每帧状态耦合进静态解析，并被 resize / 时间线 `syncWorld` 覆盖。

**子层只复制父层的 `parallaxDepth`，node 仍用自身 origin。** 改动最小。不用它：父子 origin 不一定相同（本例相同只是作者省略了子层 origin），用自身 origin 重算 shift 仍会按差值漂移；参考实现明确「有锚点 ⇒ offset 直接取锚点 offset」。

**只在 renderer 的媒体封面分支特判（给封面对象套父层 depth）。** 能修这一张。不用它：不是一个可复用语义，下个带父子视差的素材会再犯；且修复点应落在通用装配层而不是媒体分支。

## Consequences

**收益：** 带父子视差的壁纸与桌面一致——本例封面与封面框在指针任意位置都保持同一 shift（实测 centerΔ `(0,0)`）；AGENT §7.39 的已知缺口①补齐；其它壁纸零回归（`npm test` 2269 通过；`e2e:media` 13/13、`e2e:media --regression` 22/22；`3797976859` 虽开视差但 `amount = 0`，子层契约深度为 null，行为不变）。

**代价：** 装配期多一次 O(N) 的父链契约解析（对象数 <300，开销可忽略）；语义仍为近似——effect 投影节点的独立视差契约、WE 对 composite 容器 `parallaxDepth` 的 `{1,1}` 缺省仍未实现（AGENT §7.39 ②），多轴父链旋转下锚点原点仍沿用 scene-graph 的近似口径，`disablepropagation` 按参考实现只对 image 类父层生效。
