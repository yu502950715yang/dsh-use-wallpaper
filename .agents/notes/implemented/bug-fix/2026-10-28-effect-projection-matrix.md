# Agent Note: 效果链内置投影矩阵（depthparallax 的 `g_EffectTextureProjectionMatrixInverse`）

Status: implemented

## Problem

`depthparallax`（深度视差）效果被 2 张壁纸真实引用（`effects/depthparallax/effect.json`）。它的 `vert` 使用：

```glsl
uniform mat4 g_EffectTextureProjectionMatrix;
uniform mat4 g_EffectTextureProjectionMatrixInverse;
...
mat3 rot = CAST3X3(g_EffectTextureProjectionMatrixInverse);
vec2 projectedDirX = normalize(mul(vec3(1,0,0), rot).xy);
```

这两个矩阵在素材里**没有 material 注解**，而 `EffectRunner.getMaterial` 只把 `pass.uniforms`（注解产物）与少数内置名（`g_TextureN` / `g_TextureNResolution` / `g_ModelViewProjectionMatrix`）预建进 `ShaderMaterial.uniforms`。没有表项的 uniform，three 不上传 ⇒ GL 取默认 **全 0 矩阵** ⇒ `CAST3X3(0)` 得零矩阵 ⇒ `normalize(0)` 为 **NaN** ⇒ `v_ParallaxOffset` / 整个片元的 UV 变 NaN，该层输出异常。

webwallgl 的对照：对效果 pass 明确绑 `g_EffectTextureProjectionMatrixInverse = IDENT_M4`（`renderer.js:1900-1909`，注释「图层 pass 没有这个概念时退回单位矩阵」）。dsh 的效果 pass 是全屏 NDC quad（顶点即画布坐标），单位阵在语义上等价，因此不需要真实的投影矩阵。

## Decision

`getMaterial` 在构造 `ShaderMaterial` 前，扫描 `vertSrc + fragSrc` 中 `uniform mat4 g_EffectTextureProjectionMatrix(?:Inverse)?;` 的声明；声明存在且 `uniforms` 尚无该项（无注解）时预建 `THREE.Matrix4()`（单位阵）。已有表项（带注解/由 binder 给值）不覆盖。

测试（`tests/effect-runner.test.ts`）：① 声明两者 → 两个 uniform 都是单位阵；② 未声明 → 不凭空创建表项（避免给无关 shader 加 uniform）。

## Affected repositories

- `dsh-use-wallpaper` 不涉及

## Alternatives considered

**对所有「无注解 mat4」统一预建单位阵。** 不用它：全库效果 shader 里无注解 mat4 还有 `g_EffectModelViewProjectionMatrix`（godrays 的 COPYBG 分支），那条路径属于未实现的 copybackground（§7.31），在半实现路径上提前给它注入矩阵会把「已知坏」变成「另一种未知坏」，无法验收。

**在 update 阶段按 pass 真实投影矩阵构造。** 不用它：dsh 的 quad 顶点已是 NDC、输出 RT 与纹理 UV 1:1，没有「层空间 → pass 纹理空间」的缩放，真实投影矩阵在这里就是单位阵；等以后做容器/裁剪类 pass 需要非 1:1 投影时再补。

**同时补 `g_Screen`（vec3）。** 不用它：depthparallax.vert 声明了但全文未使用，补值是死代码。

## Consequences

**收益：** depthparallax 的 2 张壁纸不再输出 NaN，视差方向与桌面一致（单位阵 → 方向轴对齐）。

**边界 / 未验证：** 未做逐像素对照（e2e 无该效果 fixture），需真机人眼验收；`g_EffectModelViewProjectionMatrix`（COPYBG）仍缺，归 copybackground 任务。
