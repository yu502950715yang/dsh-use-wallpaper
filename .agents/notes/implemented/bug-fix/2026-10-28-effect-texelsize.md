# Agent Note: 效果链补绑 WE 内置 `g_TexelSize`

Status: implemented

## Problem

与 WebWallGL 对照扫描全库效果链 shader（266 个」effects/` 下 shader/effect.json）后发现：`blur_gaussian.vert/.frag`、`dot_matrix_mobile_fix.vert/.frag` 等 3 个 shader 使用**无 material 注解**的 `uniform vec2 g_TexelSize`。dsh 的 binder 对无注解、无 default 的 uniform 只给维度正确的零值 `[0,0]`；效果执行器从未绑过它 ⇒

- `blur_gaussian.frag` 的 `const vec2 multiplier = g_TexelSize * u_radius;` 得 0 ⇒ 采样偏移恒 0，模糊退化为取原像素（效果静默失效）；
- `dot_matrix` 的描点步进同样恒 0。

本机命中 3 张壁纸（2911105183 / 3743126786 / 3780477933）。webwallgl 在 `bindSystemUniforms` 里绑 `g_TexelSize = 1/projW, 1/projH`（`renderer.js:1836`），是 WE 引擎内置量。

顺带核对：效果链里「素材使用但 dsh 未绑」的其它内置 uniform 中，音频族（g_AudioFrequency*/Power/Bounds/Multiply）、g_UserAlpha、g_Perspective* 均带 `material` + `default` 注解，由 binder 正常绑定；`g_EffectModelViewProjectionMatrix` 只在 COPYBG 分支使用（copybackground 未实现，已知缺口）；仍缺的是 depthparallax 族的 `g_EffectTextureProjectionMatrix(+Inverse)` / `g_Screen`（2 张，记 P1，未修）。

## Decision

`src/client/effect-runner.ts` 的 `update()`：在每 pass 的输出目标（ping-pong 或具名 RT）确定之后、渲染之前，若材质声明了 `g_TexelSize`（数组、长度 2），写 `[1/w, 1/h]`。用输出目标尺寸而非对象 RT 尺寸，保证 `fboScale` 降采样的 pass 也正确。

测试：`tests/effect-runner.test.ts` 新增用例，单 pass 写 32×16 ping-pong RT 后断言 `g_TexelSize = [1/32, 1/16]`。

## Affected repositories

- `dsh-use-wallpaper` 不涉及

## Alternatives considered

**绑对象 RT 尺寸（`this.width/this.height`）。** 不用它：效果链的 pass 可能写 `fbos.scale` 降采样后的 RT（`resolveTargetSize`），此时 TexelSize 必须按该 pass 的实际输出尺寸算，否则模糊半径按错的像素密度缩放。

**同时补 `g_TexelSizeHalf` 与 depthparallax 族矩阵。** 本次未做：前者素材 0 使用（YAGNI）；后者只有 2 张 depthparallax 效果，且需要按 pass 投影矩阵构造，单独任务。

## Consequences

**收益：** 3 个模糊/描点类效果恢复正确采样步进；现有效果链零回归（89 个 effect-runner 测试全过）。

**边界：** 只在材质已有 `g_TexelSize` uniform 时写入；若 shader 未声明则无操作（不新增 uniform 表项）。


