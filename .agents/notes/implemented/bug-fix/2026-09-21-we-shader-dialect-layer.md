# Agent Note: WE shader 方言缺口一律在翻译层补齐

Status: implemented

## Problem

WE 效果链的 shader 是 **HLSL 方言**，本仓库靠自己的翻译层把它变成 GLSL3 再编译：`shader/we-headers.ts`（重载与别名）+ `shader/shader-preprocessor.ts`（规则改写）+ `effect-chain.ts`（combo 合并）。

问题出在**失败形态**上：全库扫描发现 8 条编译失败**全部落在单 pass 链**上 ⇒ **一次编译失败 = 一整条效果链完全没有输出**，不是"链内某个 pass 退化但画面还在"。而其中 `2832263418` 的 `chromatic_aberration` 挂在**普通 image 对象**上 —— 也就是说，这个缺陷在 util 渲染尚未实现时就已让真实壁纸失效。

关键判断是**这些失败该修在哪一层**：扫描逐条核对后，8 条的根因**全部落在我们自己的方言层**（header 重载不全、宏定义冲突、预处理规则缺陷），**没有一条是"引擎语义缺失"**（那类问题是编译通过但输出为空，例如 `_rt_imageLayerComposite_*`，是另一件事）。若按"引擎能力不足"处理，就会把可修的缺陷误判成遗留。

## Decision

**方言缺口只在翻译层修，不在业务代码里按壁纸/shader 特判。** 本轮补齐七类根因（F1–F7），代表性三条：

- **F1 `mul` 重载表不全**（只有 `vec4×mat4` / `vec3×mat3`）：在 `we-headers.ts` 补齐 HLSL 的 `vecN×matN`、`matN×vecN`、`matN×matN` 全表，行/列主序以既有的 `m * v`（`we-headers.ts`）为准。
- **F4/F5 宏语义冲突**：`DEG2RAD`/`DEG2PCT` 是**我们多写的**宏（WE 真实 `assets/shaders/common.h` 只有 `M_PI` 系列），删掉；更要紧的是 GLSL 预处理把"不同的宏体重定义"当 **ERROR**，而 HLSL 只 warning ⇒ 对"header 已定义的宏名"，把 shader 侧的 `#define` 改写成 `#undef X` + `#define X …`，保留 HLSL 的"后者胜"语义。
- **F6/F7 `floatifyIntVarUses` 的两个边界**：① 缺赋值左值保护（`index = abs(index)` 会被改成 `float(index) = …`）；② 跨互斥 `#if` 分支同名不同类型（`int bar` / `float bar`）会串味 —— 取最保守的"整名跳过"，退化为改动前行为。

**明确不做**（避免范围蔓延）：G1–G4 语义层修复（浮点取模、写只读 frag 输入、隐式窄化、浮点数组下标）需要类型推断与数据流分析，属**独立一轮**；`text` 对象的 effects 链、`_rt_imageLayerComposite_*` 运行时语义、util 对象渲染都不在本轮。

因此本轮**不承诺"8 条全修好"**：验收口径是 **A 档失败数 2 → 1**，残余失败逐条给出根因归属。

## 涉及仓库

- `dsh-use-wallpaper` 分支 `master` commits `a33e7aa` `8189dc9`

## Alternatives considered

**按壁纸 / shader 逐个特判。** 理由：命中即修、见效最快，且不必担心"改 header 影响全部链"。不用它是因为方言层是**共享**的 —— 已有的 169 条链共用同一份 header 与预处理规则，特判等于每遇到一张新壁纸就再来一次，判据与测试也无法复用；而真正的判据（零新增失败）本来就要求共享层整体不被改坏。

**直接改 shader 源码让它符合 GLSL 语义。** 理由：一劳永逸，不用维护翻译层。不用它是因为这些 shader 不是我们的代码 —— 壁纸目录是用户作品（**只读**），引擎 shader 是 WE 的第三方素材，两者都不得修改；翻译层正是为了"不改素材也能跑"而存在。

**继续沿 `glsl-to-naga` 的 WebGPU 路线翻译。** 理由：naga 能做严格的类型检查，方言问题会暴露得更彻底。不用它是因为该路径已随"three.js 是唯一渲染路径"整体删除（见 [three.js 是 scene 的唯一渲染路径](../architecture/2026-09-08-threejs-single-render-path.md)），主路径的效果链走 three 的 GLSL 路径。

**连 G1–G4 一起修，把失败数打到 0。** 理由：一次做完比留尾巴好。不用它是因为 G2/G3 需要数据流分析与类型推断，风险与工作量都在另一个量级，混进"补 header 重载"这一轮会让"零新增失败"这个硬门禁失去意义。

## Consequences

**收益：** 修完 F1–F7 后，`3780477933` 的 `dot_matrix_mobile_fix` 恢复（链 `lastOutput` 由 false 变 true，单 shader 探针证明点阵**真的画了出来**）；失败根因有了归属，残余失败能说清是"我们没做"而不是"不知道为什么不亮"。

**代价：** 改 header 与预处理器**影响全部效果链**（这是本轮最大风险），缓解办法是每修一条只做一次全库复扫、与基线失败集合逐条对比，**零新增失败是硬门禁**；另外"整名跳过"这类保守选择会留下"int 字面量未补 `.0`"的潜在新错，需要复扫验证。残余失败（`2832263418` 的 `chromatic_aberration`）全是明确排除的语义层问题，**要归零必须另开一轮做 G2 + G3**，如实记在 `AGENT.md` §7。

设计与逐条根因见 [效果链 shader 方言兼容性修复（F1–F7）设计](../../../../docs/superpowers/specs/2026-09-21-shader-dialect-compat-design.md)。
