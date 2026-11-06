# Agent Note: shimmer 效果的两条编译缺口（HLSL 隐式截断 + sampler 默认资产）

Status: implemented

## Problem

「影之刃零1」（`3828798871`）两个 puppet 各挂 1 条 `shimmer` 效果（效果链里第 4 条），dsh 侧 Console 持续报：

```
效果 pass 编译失败，跳过: pass 3:0 … 片元首行=#include "common.h"
fragment: ERROR: 0:473: '=' : dimension mismatch
```

两处真实缺口：

1. **HLSL 隐式向量截断**：WE 的 shader 是 HLSL 派生的，`shimmer.frag` 写 `vec3 shimmerColor = texSample2D(g_Texture3, …);`（`texSample2D` 返回 vec4）。HLSL 允许赋值时收窄，GLSL ES 3.0 不允许 ⇒ 整个 pass 编译失败被跳过。本机库 294 个 effect shader 里只有 shimmer 命中；但这是方言层的通用落差。
2. **sampler 的 `default` 注解未消费**：shimmer 的 `g_Texture3`（渐变图）注解是 `"default":"gradient/gradient_ferro_fluid"`、**没有 mode**；scene.json 的 `textures` 数组该槽是 null。既有实现只按 `mode` 绑空槽常量 ⇒ 槽永远是空/0 ⇒ 即使 shader 编译通过，`shimmerColor` 也恒 0、`mix` 权重 0，效果静默无效。本机库同类「无 mode 的路径型 default」槽共 29 处（clouds/pulse/vhs/filmgrain 等的 `util/clouds_256`、`util/noise`）。

## Decision

- `shader-preprocessor.ts` 新增 `fixHlslImplicitVectorTruncation`：只处理「初始化器**以已知定返回维度的函数调用开头**」的局部声明（`vec3 x = texSample2D(...)` / `vec2 x = texture2D(...)`），给整个初始化表达式补 swizzle（`(expr).rgb` / `.rg`）。函数返回维度表由 `WE_HEADERS` 的声明扫描得出，**只收全部重载同维度的函数**（`frac`/`mul`/`saturate` 等混维度的不猜）；已有显式 swizzle、同宽、更宽都跳过。放在 sampler 提取之后、include 展开之前执行，只改 shader 作者代码。
- `effect-chain.ts` 采集 `samplerDefaults`（sampler 注解里带 `/` 的路径型 `default`）；`effect-runner.ts` 新增 `slotDefaultPath`：`textures[j]` 为空、且该槽的 `mode` 常量兜底**不适用**时，把 default 路径当槽资源加载（预加载 + 每帧绑定同口径）。**mode 常量优先**，既有空槽语义与 29 处同类槽行为不变。加载走既有 `loadEffectTextureSlot` 路由（`util/*` 真身 → 程序化回退 → pkg `materials/<path>.tex` → WE 安装目录 assets 兜底）。

测试：`tests/shader-preprocessor.test.ts`（4 例：vec3/vec2 补 swizzle、表达式括号化、已 swizzle/同宽/混重载不动、多行与前置括号）、`tests/effect-runner.test.ts`（`slotDefaultPath` 门控 + 集成：空槽 default 预加载并绑到 `g_Texture3`）、`tests/shader/effect-chain.test.ts`（`samplerDefaults` 采集）。

## Alternatives considered

**在 `we-headers.ts` 里给 `texSample2D` 加多返回类型/宏。** GLSL 没有按返回类型重载，宏也改不了调用点的静态类型 ⇒ 不可行；必须在源码层补 swizzle。

**按类型推断给所有「宽→窄」赋值补 swizzle。** 需要完整表达式类型推断（shader 常量、函数返回、swizzle 链），风险远大于收益；本机库仅 1 例，而「已知定返回维度函数开头的初始化器」是安全且可验证的子集。

**把所有 default 注解（含颜色/向量默认值）都当资产加载。** 会误把 `"1 1 1"` 之类颜色值当路径；只收带 `/` 的字符串。**让 default 覆盖 mode 常量。** 会改掉 29 处既有空槽语义（例如 flowmask 的 `util/noflow` 中灰常量 → 真纹理），行为变化面大且与本次目标无关；mode 优先保持保守。

## Risks

- **强制输入验证的结论**：把 shimmer 的 mask/gradient 临时换成纯白后，pass 输出 RT 与输入差异巨大（changedPx≈66.7 万）⇒ 管线与 shader 正确；但真实素材下 shimmer 的最终画面贡献 **< 8bit**（渐变亮带仅 64 列中 x≈0.64–0.77，×稀疏 mask，量化后全画面 A/B `maxAbs=0`）。若桌面 WE 上确有可见闪点，还需按 WE 真机帧差查采样口径（渐变行列方向 / mask UV）。
- **29 处 default 槽开始加载真纹理**：对这些壁纸（clouds/pulse/vhs/filmgrain 等）是「从空槽变正确纹理」的语义修正，但本机 e2e 只覆盖其中一部分（colorblend 样本）；风险由既有像素判据兜底，未逐张人眼验收。
- **隐式截断补 swizzle 对表达式等价**：`(expr).rgb` 与 HLSL 截断同义；但若将来出现 `mat*vec` 混合导致 GLSL 维度报错变体，仍属方言层新问题（fix 只覆盖「函数调用开头」）。
- **e2e 环境坑（非代码问题）**：headless Edge 进程可能残留并复用同一 CDP 端口，导致多次运行混到旧页面（本轮排查被污染数次）。复跑 A/B 时必须先清残留 Edge 并每次换端口。

## Consequences

**收益：** shimmer 从「编译失败整条跳过」变为「编译通过、每帧执行、mask/gradient 正确绑定」；`fixHlslImplicitVectorTruncation` 与 `samplerDefaults` 是方言/资源层的通用缺口，本机库分别命中 1 / 29 处。全量 vitest 2181 通过、e2e 零编译失败、披风运动能量无回归（9.645）。

**代价：** 预处理多一趟基于源码扫描的改写（只在 shader 加载期一次）；效果槽加载多 29 处 default 资产请求（缓存、失败回退照旧）；`CompiledEffectPass.samplerDefaults` 是新增可选字段（旧 fixture 不受影响）。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `d0dfc8b`
