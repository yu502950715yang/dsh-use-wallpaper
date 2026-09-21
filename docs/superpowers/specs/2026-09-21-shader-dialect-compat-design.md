# 效果链 shader 方言兼容性修复（F1–F7）— 设计文档

- 日期：2026-09-21
- 状态：**设计待用户确认**
- 项目根：`E:\code\dsh-use-wallpaper`
- 关联：
  - 扫描报告：`research/verify-text/pass-compile-scan-report.md`（gitignored，本设计的全部事实来源；29 张库 × A/B 两档 = 58 次页面加载，跑两遍逐条一致）
  - 代码：`src/client/shader/we-headers.ts`（HLSL 方言 header）、`src/client/shader/shader-preprocessor.ts`（预处理规则）、`src/client/effect-runner.ts`（失败缓存与告警）
  - `AGENT.md` §7.1（`3789452668` 的 `color_grading` 条 —— **本次一并订正：它已被 `4a8ab67` 修好，不再失败**）
  - 上游动机：`3798688689` 动画缺失排查（`research/verify-text/util-as-image-report.md`）发现 5 条链因编译失败根本没执行

## 1. 概述

效果链的 shader 是 **HLSL 方言**，靠我们的 `we-headers.ts`（重载/别名）+ `shader-preprocessor.ts`（规则改写）翻译成 GLSL3 再编译。全库扫描发现：

| 档 | 尝试编译 pass | **编译失败** | 受影响壁纸 |
|---|---|---|---|
| **A · 原样**（生产今天真正编译的） | 185 | **2（1.08%）** | **2 / 29**：`2832263418`、`3780477933` |
| **B · util 当 image** | 221 | **8（3.62%）** | **4 / 29** |

**关键性质**：8 条失败**全部落在单 pass 链**上 ⇒ **每个失败 = 一整条效果链完全不生效**（不存在"链内某 pass 退化但仍有输出"）。其中：

- `3780477933` 的失败链是它**唯一的效果**；
- `2832263418` 的 `chromatic_aberration` 挂在**普通 image 对象**上 —— **不修 util 渲染、今天就在失效**。

**根因全部落在我们自己的方言层**（header 重载不全 / 宏定义冲突 / 预处理规则缺陷），**没有一条是"引擎语义缺失"**（那类问题是"编译通过但输出空"，如 `_rt_imageLayerComposite_*`，不在本文范围）。

## 2. 事实基础：8 条失败与根因

失败清单（`壁纸 + 对象 + effect`，错误原文见扫描报告 §2.4）：

| # | 壁纸 | 对象 | effect | 档 |
|---|---|---|---|---|
| 1 | 2832263418 | 250 `audio_rainbow` | `chromatic_aberration` | A/B |
| 2 | 3780477933 | 17 | `dot_matrix_mobile_fix` | A/B |
| 3 | 3789452668 | 327 | `audioline` | B |
| 4–5 | 3798688689 | 500 / 510 | `video` ×2 | B |
| 6–8 | 3798688689 | 221706 / 707 / 708 | `Simple_Audio_Bars` ×3 | B |

根因 → 修法映射（F 编号沿用扫描报告 §6.1）：

| # | 根因 | 失败 pass | 修法 | 风险 |
|---|---|---|---|---|
| **F1** | `mul` 重载表不全（只有 `vec4×mat4` / `vec3×mat3`） | 3（含 **A 档 2 张**） | 在 `we-headers.ts` 补齐 HLSL `mul` 全表：`vec2/3/4 × mat2/3/4`、`matN × vecN`、`matN × matN`；行/列主序与既有 `m * v`（`we-headers.ts:86`）保持一致 | 低 |
| **F2** | `texSample2D` 只有 `(sampler2D, vec2)` | 1（**A 档**） | 补 `(sampler2D, vec3)` / `(sampler2D, vec4)`，内部取 `.xy`（WE 内置按前两分量取 uv） | 低 |
| **F3** | `fmod` / `lerp` 未提供（HLSL 名） | 1 / 3 | header 加别名：`fmod`→`mod`、`lerp`→`mix` | 低 |
| **F4** | `DEG2RAD`/`DEG2PCT` 是我们**多写的**宏（WE 真实 `assets/shaders/common.h` 全文只有 `M_PI/M_PI_HALF/M_PI_2/SQRT_2/SQRT_3`） | 3 | 删掉这两个 `#define`。**反证**：`2911105183` 里另一份 `Simple_Audio_Bars` 自己定义了**逐字相同**的 `DEG2RAD` ⇒ 相同宏体重定义合法所以它能编译；`3798688689` 那份宏体不同才报错 | 低 |
| **F5** | `M_PI` 等与 shader 自行 `#define` 冲突（GLSL 预处理把"不同的宏体重定义"当 **ERROR**，HLSL 只 warning） | 1（**A 档**） | 预处理时把 shader 侧对"header 已有宏"的 `#define` 改写成 `#undef X` + `#define X …`，保留 HLSL"后者胜"语义 | 低-中（要列全受保护宏名） |
| **F6** | **`floatifyIntVarUses` 缺赋值左值保护**：`index = abs(index);` → `float(index) = abs(float(index));` | 1 | 在 `shader-preprocessor.ts` 的保护清单加赋值左值规则（覆盖 `=`/`+=`/`-=`…，且不与 `==`/`>=`/`<=` 冲突） | 低-中（正则边界） |
| **F7** | **`floatifyIntVarUses` 跨互斥 `#if` 分支同名不同类型**：`int bar`（`#else`）与 `float bar`（`#if`）⇒ 收集到 int，把另一支改成 `float float(bar)` | 3 | 二选一：① 同名跨分支类型不一致时**整名跳过**（最保守，退化为现状）；② 按 `#if/#else/#endif` 分支分别收集 | 中 |

## 3. 本轮范围

**做：F1、F2、F3、F4、F5、F6、F7**（顺序即扫描报告 §6.3 的优先级：F1-F3 → F4-F5 → F6-F7）。

**不做（明确排除，避免范围蔓延）：**
- **F8**：`#define` 宏体的 int 字面量不补 `.0`（要区分"`#if` 用的常量宏"与"表达式宏"，风险中等，且只在 video 上暴露）；
- **G1–G4**（语义层需要类型推断）：HLSL 浮点取模 / `uint` 隐式转换、frag 内改写 `varying`、隐式窄化、浮点数组下标；
- `text` 对象的 11 条链 / 18 个 pass（`groupEffectsByObject` 跳过 text，两档都未覆盖 —— **扫描口径的已知盲区**，本轮不扩）；
- `_rt_imageLayerComposite_*` 等运行时 RT 语义（"编译通过但输出空"，另一件事）；
- util 对象渲染（另一件事）。

**因此本轮不承诺"8 条全修好"**：
- 修 F1-F7 后，`video`（#4/#5）**仍可能失败**，因为 `video.frag` 另有作者自身的写法问题（浮点数组下标 `volumNum(float barID)`、`mix(vec3, vec4, float)` 维度不匹配）属 G4 类，且**这些在 WE 里能过只是因为 HLSL 更宽松**；
- `Simple_Audio_Bars`（#6-#8）修掉 F4/F7/R4 后可能**暴露 G1**（浮点取模）——是否也失败以复扫结果为准。

## 4. 验收标准

1. **A 档失败数 2 → 0**（用 `research/scan-pass-compile-failures.mjs --tiers=A` 复扫）：`2832263418` 的 `chromatic_aberration`、`3780477933` 的 `dot_matrix_mobile_fix`（唯一效果）必须恢复编译；两张壁纸的链进入 `lastOutput` 非空。
2. **B 档失败数 8 → ≤5**（复扫）：`audioline`（F6）必须恢复；`Simple_Audio_Bars`（F4/F7）至少其第一层错误消失。**剩余失败逐条给出根因归属**（预期落在 G1/G4），不得含糊。
3. **零新增失败**：比 A/B 两档的完整失败集合（本次基线的 8 条 + A 档 2 条）—— **不允许出现任何新的失败 pass**；这是硬约束（改 header 会影响全部 169 条链）。
4. **单测**：每条修复都有对应单测（`tests/shader-headers.test.ts` / `tests/shader-preprocessor.test.ts`），覆盖：`mul` 各重载签名、`texSample2D` vec3/vec4、`fmod`/`lerp` 别名、宏重定义的 `#undef` 改写、赋值左值保护（含 `==`/`>=` 不误伤）、跨 `#if` 分支同名类型冲突。
5. **既有测试零回归**：`tests/shader-preprocessor.test.ts`、`tests/shader-headers.test.ts`、`tests/shader/effect-chain.test.ts`、`tests/effect-runner.test.ts` 全绿（注意：`tests/shader/glsl-to-naga.test.ts` 与 `godrays-chain.test.ts` 在本机会挂起，不在门禁内）。
6. `npm run build` + `npm run build:client` 通过；`lib/`、`dist/` 一并提交。

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| **改 header / 预处理器影响全部 169 条链**（最大风险） | 每修一条**只复扫一次**，与基线失败集合逐条对比；§4.3 的"零新增失败"是硬门禁 |
| `mul` 行/列主序写反 ⇒ 画面几何/方向错（不报错但结果错） | 以既有 `m * v` 约定为准（`we-headers.ts:86`）；对 `3780477933` 做端到端渲染对比（该链是它唯一效果，修好后画面应出现点阵效果） |
| F5 的 `#undef` 改写把"shader 有意覆盖我们默认值"的情况改坏 | 只对**我们 header 里已定义的宏名**做改写；宏体差异在 1e-10 量级（实测），视觉无影响；单测覆盖 |
| F7 选①（整名跳过）会让该名不再补 `.0` ⇒ 可能出现新的"int 字面量未补 `.0`"错误 | 复扫验证：若 `Simple_Audio_Bars` 出现新错误，改用②（按分支收集）；两条路都写进实施计划 |
| 扫描是 headless + SwiftShader + ANGLE GLSL 前端 | 失败都是**源码级**的（与驱动无关）；但真机 GPU 未复跑，如实标注 |

## 6. 测试计划

- **单测**：`tests/shader-headers.test.ts`（F1/F2/F3）、`tests/shader-preprocessor.test.ts`（F4/F5/F6/F7）；
- **全库复扫**（集成验收）：A/B 两档，对比基线失败集合；
- **端到端**（两处，各一张）：`3780477933`（A 档、唯一效果）与 `2832263418` 的 `chromatic_aberration` —— 用 harness 渲染 + `read_image` 目检 + 链 `lastOutput` 非空；
- **回归**：`3798688689`（B 档）复扫对比，确认没有把原本能跑的链改坏。

## 7. 与既有记录的关系

- **订正一条过期记录**：`AGENT.md` §7.1 的「`3789452668` 的 `effects/color_grading` 仍未修（varying 类型不匹配）」—— 扫描证实它**已被 `4a8ab67`（2026-09-16 的 `reconcileVaryingDeclarations`）修好**，本轮一并订正；
- 本文**不推翻**任何既有裁定：效果链执行器、隔离语义都不动，只在方言翻译层补齐能力。
