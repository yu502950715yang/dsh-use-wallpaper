# DSH Wallpaper Engine 效果链（effects）渲染 — 设计文档

- 日期：2026-08-18（Task 7 收尾修订：回写实现偏差，标记里程碑达成）
- 状态：已实施（M1/M2/M3 达成，见 §8）
- 项目根：`E:\code\dsh-use-wallpaper`
- 关联：`2026-08-17-dsh-wallpaper-engine-design.md`（总设计，本文为其中"二期效果链渲染"的细化）

## 1. 概述

为 `dsh-wallpaper-engine` 的 Three.js SceneRenderer 增加 **Wallpaper Engine 效果链（effects）渲染**：**所有对象**（image/particle/util/none 均可携带）的 `effects` 数组——着色器后处理效果链（水波、模糊、抖动、光晕等）——不再跳过，而是通过通用 shader 解释器在浏览器中渲染，**全屏后处理**逐效果链执行。

**Ruling 5（范围扩展，Task 6 确定）**：效果链收集范围从"util 对象专属"扩展为**所有对象**。全库实测 122 条效果中 **105 条挂在 image 对象上**（`scan-effects-owners.mjs`：util×9、image×105、none×8），仅按 util 收集会漏掉绝大多数主视觉效果。实现按 `scene.json` objects **数组顺序**展平所有对象的 effects，逐效果链全屏执行（对象顺序语义：该对象位置处画面 = 其前方所有对象内容，效果结果供后续对象叠加）。

一期已将对象归类并保留 `effects` 字段（见 `src/shared/types.ts`，image/particle 对象均保留 effects），本文实现其消费端。

## 2. 事实基础（全库实测）

### 2.1 效果使用统计

全库 24 个壁纸中 **15 个带效果链**（`scan-effects.mjs` 实测；初版 spec 记 17 系早期口径），共 **30 种效果**，引用 122 次。高频：`waterwaves`×24（4 壁纸）、`shake`×18（7 壁纸）、`opacity`×8、`waterripple`×7、`pulse`/`perspective`/`blurprecise`×5、`waterflow`/`clouds`/`scroll`/`foliagesway`×4；音频效果 `Simple_Audio_Bars`×3（2 壁纸）。

带效果壁纸清单（15 个）：`1429403119`、`1968789468`、`2011060960`、`2132420420`、`2454403969`、`2460786246`、`2597392171`、`2683211654`、`2832263418`、`2897292240`、`2911105183`、`2937346640`、`3303428996`、`3743126786`、`3765967112`。

### 2.2 数据格式

- **effect.json**（如 `effects/waterwaves/effect.json`）：`passes[]`（每 pass 引用 `material`）、`dependencies`（material + shader 文件清单）；
- **材质 json**（如 `materials/effects/waterwaves.json`）：`passes[0]` = `{ shader: "effects/waterwaves", blending: "normal", depthtest/depthwrite/cullmode }`，shader 名相对 `shaders/` 目录（`shaders/effects/waterwaves.{vert,frag}`）；
- **scene.json 覆写**：对象 `effects[i].passes[j]` 按**索引**对应 effect.json 的 `passes[j]`，合并 `combos`（宏开关）、`constantshadervalues`（uniform 值）、`textures`（纹理槽，数组元素可为 `null`）；`material` 引用不变。
- **内置 util 材质**（`materials/util/*`，如 `effectcomposebackground.json`）：引擎内置合成 pass，**pkg 内无文件**，解析时跳过该 pass（§5）。

### 2.3 Shader 方言（WE 自定义 GLSL）

全库 shader 扫描确认（`research/scan-shader-dialect.mjs`）：

| 方言特性 | 证据 |
|---|---|
| `#include` 内置头文件 | `common.h`×48、`common_blending.h`×21、`common_perspective.h`×6、`common_blur.h`×4、`common_composite.h`×3、`common_fragment.h`×3、`common_vertex.h`×1（**均不在 pkg 内**，需自实现） |
| combo 宏 | `#if MASK` / `#if PERSPECTIVE == 1` 等 24 个宏；取值如 `BLENDMODE∈{0,9,12,30,31}`、`SHADING∈{0,1,7}`、`REPEAT/NOISE/GREYSCALE∈{0,1}` |
| 内置函数 | `texSample2D`×89、`mul`×66、`rotateVec2`×20、`squareToQuad`×6、`inverse`×6、`texSample2DLod`×3、`mod2`×2、`CAST2/3/4`、`DecompressNormal`、`frac`/`saturate`、`DEG2RAD`/`M_PI*` 常量 |
| 内置 uniform | `g_Time`、`g_Texture0..3` + `g_TextureNResolution`、`g_ModelViewProjectionMatrix`、`a_Position`/`a_TexCoord` |
| 参数 uniform | 注释标注 `// {"material":"speed"}` 映射 material 参数名（全库映射表已收集，如 `g_Speed→speed/speeduv/rayspeed`）；无标注用注释 `default` |
| 音频 uniform | `g_AudioSpectrum{N}Left/Right[N]` 数组（Simple_Audio_Bars；8 壁纸引用） |
| 输出 | `gl_FragColor`、`attribute`/`varying`（GLSL ES 1.0 风格） |

## 3. 架构设计

### 3.1 数据流（改造现有 SceneRenderer）

```
场景对象（image/particle/clearcolor）     ← 现状：直接渲染到 canvas
        │ 改造：渲染到离屏 RenderTarget（sceneRT）
        ▼
所有对象效果链（按 scene.json objects 顺序展平，遇有效果的对象执行其链）
   chain1 → chain2 → ...（rtA ↔ rtB ping-pong，跨链共享同一对 RT）
   每个 pass：g_Texture0 = 上一 pass 输出，结果写回另一 RT
        ▼
最终贴屏（全屏 quad → 前景 canvas；contain 语义、bgCanvas 模糊层逻辑保留）
```

- `createSceneRenderer` 改造点：
  - 场景渲染目标从 canvas 改为 `sceneRT`（尺寸 = 视口尺寸，`renderer.setSize(vw, vh, false)` + `sceneRT.setSize(vw, vh)`）；
  - 帧循环：`render(scene, sceneRT)` → 效果链（异步，见下）→ `render(fullscreenQuad, canvas)`（独立 NDC 正交相机 + `PlaneGeometry(2,2)` 全屏 quad，采样 sceneRT / 效果输出）；
  - **贴屏 quad 必须 `transparent: true`**：contain 留白区（场景未覆盖处）alpha 为 0，否则 three 的 OPAQUE 强制 alpha=1 → 黑边并完全遮挡 bg 模糊层（浏览器集成实测确认）；
  - **效果链收集**：`renderScene` 中 `desc.objects.flatMap(o => o.effects)` 按对象顺序展平（Ruling 5），逐效果 `resolveEffectChain` 异步解析（失败链 → null 过滤 + console.warn，加载中画面保持原样）；
  - 背景 canvas（模糊层）：**默认只对前景应用效果链**（避免模糊层双重处理）。
- 效果链执行（`effect-runner.ts`）：
  - 多 pass 资源管理：ping-pong RT 对复用；`WebGLRenderer` 显式 `setRenderTarget` 切换；
  - **update 串行化**：帧循环每帧调用 `update`，但内部有异步纹理槽加载（await），并发 update 会交错使用同一 renderer 的 RT/绑定状态 → 画面黑屏/闪烁。`updateInFlight` 标记未完成时本帧直接返回 input，帧循环用 `lastOutput()` 贴屏（last 保持最近完成输出，无帧间闪烁）；换壁纸后纹理缓存已清空 → 首帧加载完成前输出 input（场景 RT），不黑屏；
  - **纹理槽集中 await**：update 开头统一预解析所有 pass 的纹理槽（fetch 完成前不触碰 renderer），绑定阶段无 await；
  - `setChains` 时纹理槽**预加载**（异步发起）并**清空纹理缓存**（旧壁纸纹理槽 URL 失效）。

### 3.2 渲染状态映射

材质 json 的 `blending`（`normal`/`add`/`multiply`）→ three.js `Blending` 枚举映射表（`blendModeToThree`：add→AdditiveBlending、multiply→MultiplyBlending、subtract→SubtractiveBlending、未知→normal）；后处理 pass 一律 `depthTest: false, depthWrite: false`；`cullmode` 后处理场景无关（全屏 quad 正面朝相机）。

## 4. Shader 方言兼容层（核心）

### 4.1 模块划分（新增 `src/client/shader/`）

| 模块 | 职责 |
|---|---|
| `we-headers.ts` | 7 个内置头文件等价物（字符串常量，函数/常量定义） |
| `shader-preprocessor.ts` | include 展开（内置头 + 相对引用）、combo `#define` 注入、GLSL3 兼容转换、注释剥离（保留 uniform 标注用于绑定） |
| `uniform-binder.ts` | 解析 uniform 声明与标注 → 绑定策略：内置/参数（material 映射 + default）/音频（静音数组）/纹理槽 |
| `combo-schema.ts` | combo 宏白名单（校验 scene.json 传入值合法） |
| `effect-chain.ts` | 效果链解析：effect.json → material → shader → `CompiledEffectPass[]` |
| `effect-runner.ts` | 执行器：RT ping-pong、材质缓存、pass 编译回退、动态写端 |

### 4.2 方言函数等价物（common.h 等）

```
texSample2D(t, uv) = texture2D(t, uv)
texSample2DLod(t, uv, lod) = textureLod(t, uv, lod)   // GLSL3 无 texture2DLod
mul(v, M) = M * v（行主序约定：gl_Position = mul(vec4(a_Position,1), g_ModelViewProjectionMatrix)）
rotateVec2(v, angle)、squareToQuad(p0..p3)、mod2(x,y)、CAST2/3/4(x)、DecompressNormal(texel)
frac(x) = fract(x)、saturate(x) = clamp(x, 0, 1)
常量：M_PI / M_PI_2 / DEG2RAD / DEG2PCT 等；common_blending.h：ApplyBlending（返回 vec3）
```

**浏览器集成验证修正（we-headers.ts）**：

- `inverse` **不定义**——GLSL ES 3.00 内置 `inverse(mat2/3/4)`，重复定义报 `Name of a built-in function cannot be redeclared as function`（实测）；`squareToQuad` 保留；
- `mod2` **不在 common.h 提供**——`Simple_Audio_Bars.frag` 自实现 `float mod2(...)`，提供会导致重复定义冲突；
- `texSample2DLod` 内部改用 `textureLod`（GLSL3 无 `texture2DLod`，three 前缀只映射 `texture2DLodEXT`）；
- 新增 `CAST2/3/4`（WE 标量→vec 构造，全库 CAST2×8/CAST3×32/CAST4×67：scroll/refract/gaussian/clouds/shake/blur 等）与 `DecompressNormal`（法线贴图解包，refract.frag 使用）；
- `ApplyBlending` 返回类型 **vec4 → vec3**——全库 5 处调用均赋给 vec3/.rgb（tint/Simple_Audio_Bars/chromatic_aberration/apply/gaussian），WE 引擎语义是仅 rgb 参与混合；`BLENDMODE∈{0,9,12,30,31}`（0=normal、9=add、12=multiply、30/31 暂按 mix 处理）。

实现完备性保障：**全库扫描脚本**（`research/scan-shader-dialect.mjs`）断言——所有 shader 中出现的 include 文件（⊆ `WE_HEADERS` keys）、非标准函数调用、`M_*` 常量均被内置层覆盖；新壁纸入库后可重跑。

### 4.3 GLSL3 兼容转换（shader-preprocessor.ts，9 类）

three r170 WebGL2 自动把 GLSL1 语法（`gl_FragColor`、`varying`、`attribute`、`texture2D`）映射到 GLSL3，但 WE 方言在严格 GLSL ES 3.00 下仍有 9 类编译失败，预处理逐类修正（全库实测）：

| # | 转换 | 说明 / 证据 |
|---|---|---|
| 1 | `#if` 裸标识符兜底注入 | GLSL3 预处理器不允许 `#if` 出现未定义标识符（报 `unexpected token after conditional expression`）；scene.json 未提供的 combo 宏注入 `#define X 0`（跳过 defined() 参数、`#ifdef/#ifndef` 引用的宏、已 `#define` 的） |
| 2 | `[COMBO]` default 注入 | `// [COMBO] {"combo":"BLENDMODE","default":0}` 注释声明的宏按 default 注入（BLENDMODE 只在 ApplyBlending 调用中出现、不在 `#if` 内，须从注释兜底） |
| 3 | `attribute` 声明删除 | WE 的 `attribute vec3 a_Position;` 声明行**删除**（保留会在 GLSL 中与 three 前缀重复定义 position/uv → redefinition 编译错误），函数体内引用改写 `a_Position → position`、`a_TexCoord → uv` |
| 4 | 隐式 common.h 前置注入 | WE 引擎对所有效果 shader 隐式提供基础函数头：全库实测 114/182 个 shader 无任何 include 却直接调用 mul/texSample2D/frac，未显式 include common.h 的 shader 前置注入（guard 宏防重复） |
| 5 | sampler 声明前置 | 先声明后使用：common_blur.h 的 blur13a 等引用 `g_Texture0`，而 WE 源码中 sampler 声明在 include 之后 → 不前置报 `undeclared identifier`；sampler 声明提取到 combo 宏之后、shader 主体之前 |
| 6 | int 字面量浮点化 | GLSL1 允许 int 隐式参与浮点运算/赋值/重载，GLSL3 报 `cannot convert from 'const int' to 'highp float'` 等。先保护明确 int 上下文（预处理指令行、for 循环头、数组下标/大小、int/ivec 声明与构造、比较运算中的整数字面量如 `mode == 9`），再给剩余裸 int 字面量补 `.0`，最后还原保护段 |
| 7 | const 非常量初始化降级 | `const float threshold = pow(u_t, u_g);`（GLSL1 允许运行时表达式，GLSL3 只允许编译期常量）→ 去 const 降级为普通变量；纯字面量保持 const |
| 8 | 全局非常量初始化移入 main | GLSL3 全局初始化器必须编译期常量：把 main() 前的 `type name = <非常量>;` 拆为声明 + main 开头赋值（仅真正全局作用域；函数内局部初始化合法不动） |
| 9 | 保留字改写 | `sample`（GLSL3 保留字，light_map 等 12 shader）、`pointer`（chromatic_aberration 2 shader）作变量名 → 改写 `sample_`/`pointer_`（`\b` 边界保证 texSample2D/noiseSample 不受影响） |

### 4.4 uniform 绑定规则

| uniform | 绑定来源 |
|---|---|
| `g_Time` | 帧时间（秒，从 0 起） |
| `g_Texture0` | 上一 pass 输出 RT（首 pass = 当前合成画面） |
| `g_Texture1..3` | pass 的 `textures[]` 槽位，映射 `textures[i] → g_Texture(i+1)`（实测：`[null, "masks/xxx"]` → g_Texture1=遮罩、g_Texture2 缺省；元素 `null` 跳过）；`.tex` 经现有 `tex-loader` 加载 |
| `g_TextureNResolution` | 对应纹理尺寸（vec4: w,h,1/w,1/h，WE 语义）；执行器预建默认 Vector4（视口尺寸），绑定纹理槽后按实际纹理覆盖 |
| `g_ModelViewProjectionMatrix` | 单位矩阵（全屏 quad 正交投影；执行器预建 `THREE.Matrix4`） |
| 参数 uniform | 注释 `{"material":"X"}` → `constantshadervalues.X`（支持 `{user,value}` 包装取 `value`）；无值 → 注释 `default`；均缺 → 0/单位值 |
| 音频数组 | 全零数组（静音；长度按 combo `RESOLUTION`，如 16/32/64） |

**执行器侧 uniform 预建（effect-runner.getMaterial）**：

- 预建 `g_TextureNResolution`（Vector4）与各 matN 单位矩阵（mat2=4/mat3=9/mat4=16 元素，从 shader 源码 `uniform matN name` 提取维度）——binder 对无值 mat 给 0（number），three 探针渲染时 `uniformMatrixNfv` 转换失败会误判编译失败；
- 预建纹理槽 uniform（binder 跳过 sampler，纹理绑定是执行器职责）。

### 4.5 编译与回退

- 预处理输出 → `THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms })`；three r170 在 WebGL2 下自动处理 GLSL1 语法（`gl_FragColor`、`varying`、`attribute`），集成时以浏览器实测为准；
- **离屏探针编译检测**：three 惰性编译且 `onShaderError` 只在首次实际渲染触发，因此在 1×1 探针 RT 上渲染一次强制触发编译；失败时 three 跳过绘制不抛异常，由 `onShaderError` 置位 → 跳过该 pass（console.warn 记录原因）；
- **pass 级跳过**：编译失败的 pass 跳过、`read` 不变，下一 pass 写端仍为 read 反端（无自读自写）；效果链全失败 → 画面保持效果链前状态（不触发壁纸级回退——画面本身已有效）；
- 任一 pass 编译失败/资源缺失 → 跳过该效果（整条链继续下一效果），console.warn 记录原因。

## 5. Pass 合并与效果链执行

纯函数 `resolveEffectChain(sceneEffect, effectJson, files)`（`shader/effect-chain.ts`）：

1. 读 `effect.json`（`effects[i].file`）→ 逐 pass 取 `material` 引用（scene.json pass 显式指定时优先）；
2. 读材质 json → `shader` 名、渲染状态；
3. **内置 util 材质跳过**（`materials/util/*`，如 `effectcomposebackground.json`）：pkg 内无文件，是引擎内置合成 pass（compose），`continue` 跳过该 pass 继续解析后续真实效果 pass（Task 6 实测暴露：2911105183 refraction 链，全库仅 1 处）；**全部 pass 均为内置 → 返回 null**（与 passes 为空语义一致）；
4. 按索引合并 scene.json 覆写：`combos` → combo 宏、`constantshadervalues` → 参数 uniform 值表、`textures` → 纹理槽；
5. 产出 `EffectPass[]`：`{ vertSrc, fragSrc, uniforms: 静态值表, textures, blendMode }`（shader 源码与静态值在效果加载时解析一次并缓存，帧循环只更新 `g_Time`）。

## 6. 错误处理与性能

| 场景 | 行为 |
|---|---|
| effect.json / material / shader 缺失或 JSON 非法 | 跳过该效果，console.warn（`[wallpaper-engine] 效果链解析失败，跳过:`） |
| shader 编译失败 | 跳过该 pass（离屏探针检测；`[wallpaper-engine] 效果 pass 编译失败，跳过:`） |
| 纹理槽加载失败 | 跳过该纹理槽（`[wallpaper-engine] 纹理槽加载失败，跳过:`），采样返回 null → three 默认纹理 |
| uniform 类型不匹配（如 float 收到字符串） | 数值化失败用默认值，不中断 |
| 性能 | 效果链 RT 尺寸 = 视口尺寸；多 pass 效果（blurprecise 等）可后续加降采样；一期不做自动降级（FPS 监测框架已有，二期可接） |

### 6.1 遗留问题记录（已知，Task 7 确认）

- **2911105183 场景黑屏为基线问题**（非效果链引入）：该壁纸 42MB scene.pkg 场景对象加载/渲染在效果链实现前即黑屏（Task 6 基线验证记录），效果链验证时同样不渲染；单独跟踪，不在本计划范围。
- **chromatic_aberration.frag 原始类型缺陷**：shader 源码 `vec2 赋 float`（`g_Texture1Resolution.xy = g_Chromatic` 类），GLSL1/3 均编译失败，按 §4.5 跳过该 pass（2832263418 壁纸）；为壁纸原生 shader 缺陷，非转换层问题。
- **内置纹理槽资源 pkg 缺失**：部分效果引用的纹理槽（`masks/*`、`util/white` 等）不在 scene.pkg 内（引擎内置资源），加载失败按 §4.5 跳过该槽；效果仍以缺槽状态执行（全库 15 壁纸均不阻断）。

## 7. 测试策略

- **单元测试（vitest，node 环境，TDD）**：
  - `shader-preprocessor`：include 展开、combo 注入、GLSL3 9 类转换、注释标注提取（用全库真实 shader 做 fixture 断言）；
  - `uniform-binder`：material 映射 / default 回退 / `{user,value}` 包装 / 音频数组尺寸；
  - `resolveEffectChain`：真实壁纸数据（2911105183 的 waterwaves 链、Simple_Audio_Bars 链）断言 pass 结构、纹理槽、combo；内置 util 材质 pass 跳过；
  - `we-headers`：内置函数/常量定义快照（含 inverse/mod2 不定义、ApplyBlending vec3）；
  - 方言完备性：全库 shader 扫描断言所有 include/内置函数/常量均被 `we-headers.ts` 覆盖。
- **集成验证（手动，浏览器）**：GUI 切换含效果壁纸（2911105183、1429403119、2832263418、3743126786 等），确认水波/模糊/抖动/光晕/音频条可见、无 console 报错；性能面板确认 FPS ≥ 30。
- **全库回归**：`tests/verify-real-library.test.ts` —— 所有对象效果链可完整解析（effect/material/shader/纹理槽齐全）+ 效果数量断言（122 条）。

## 8. 里程碑与验收（已达成）

1. **M1 方言层** ✓：预处理器（含 GLSL3 9 类转换）+ 头文件等价物 + 绑定器，单测全绿；
2. **M2 管线接通** ✓：RT ping-pong + 全屏贴屏（transparent），水波在 GUI 可见动态水波；
3. **M3 泛化** ✓：全库 15 个效果壁纸逐个浏览器验证（`research/task7-browser-verify.mjs`），效果可见或优雅跳过（console.warn，不黑屏）；
4. **验收** ✓：全库效果链解析 100%（回归测试硬断言）；GUI 手动验证效果壁纸画面明显改善；FPS ≥ 30。

## 9. 非目标（维持不变）

- 壁纸内音频播放（§2.2 总设计）——音频效果喂静音数据；
- 对象级局部 RT（效果全屏执行，已确认）；
- 鼠标/键盘交互（视差等）；
- TEX→PNG 导出工具。
