# DSH Wallpaper Engine 效果链（effects）渲染 — 设计文档

- 日期：2026-08-18
- 状态：待审阅
- 项目根：`E:\code\dsh-use-wallpaper`
- 关联：`2026-08-17-dsh-wallpaper-engine-design.md`（总设计，本文为其中"二期效果链渲染"的细化）

## 1. 概述

为 `dsh-wallpaper-engine` 的 Three.js SceneRenderer 增加 **Wallpaper Engine 效果链（effects）渲染**：util 对象（`models/util/*`，composelayer/fullscreenlayer/projectlayer）携带的 `effects` 数组——着色器后处理效果链（水波、模糊、抖动、光晕等）——不再跳过，而是通过通用 shader 解释器在浏览器中渲染。

一期已将 util 对象归类为 `SceneUtilObject` 并保留 `effects` 字段（见 `src/shared/types.ts`），本文实现其消费端。

## 2. 事实基础（全库实测）

### 2.1 效果使用统计

全库 24 个壁纸中 **17 个使用效果链**，共 **30 种效果**，引用 157 次。高频：`waterwaves`×24（4 壁纸）、`shake`×18（7 壁纸）、`opacity`×8、`waterripple`×7、`pulse`/`perspective`/`blurprecise`×5、`waterflow`/`clouds`/`scroll`/`foliagesway`×4；音频效果 `Simple_Audio_Bars`×3（2 壁纸）。

### 2.2 数据格式

- **effect.json**（如 `effects/waterwaves/effect.json`）：`passes[]`（每 pass 引用 `material`）、`dependencies`（material + shader 文件清单）；
- **材质 json**（如 `materials/effects/waterwaves.json`）：`passes[0]` = `{ shader: "effects/waterwaves", blending: "normal", depthtest/depthwrite/cullmode }`，shader 名相对 `shaders/` 目录（`shaders/effects/waterwaves.{vert,frag}`）；
- **scene.json 覆写**：util 对象 `effects[i].passes[j]` 按**索引**对应 effect.json 的 `passes[j]`，合并 `combos`（宏开关）、`constantshadervalues`（uniform 值）、`textures`（纹理槽，数组元素可为 `null`）；`material` 引用不变。

### 2.3 Shader 方言（WE 自定义 GLSL）

全库 36 个 shader 扫描确认：

| 方言特性 | 证据 |
|---|---|
| `#include` 内置头文件 | `common.h`×48、`common_blending.h`×21、`common_perspective.h`×6、`common_blur.h`×4、`common_composite.h`×3、`common_fragment.h`×3、`common_vertex.h`×1（**均不在 pkg 内**，需自实现） |
| combo 宏 | `#if MASK` / `#if PERSPECTIVE == 1` 等 24 个宏；取值如 `BLENDMODE∈{0,9,12,30,31}`、`SHADING∈{0,1,7}`、`REPEAT/NOISE/GREYSCALE∈{0,1}` |
| 内置函数 | `texSample2D`、`mul(v,M)`（行主序 向量×矩阵）、`rotateVec2`、`squareToQuad`/`inverse`（透视）、`mod2`、`DEG2RAD`/`M_PI*` 常量 |
| 内置 uniform | `g_Time`、`g_Texture0..3` + `g_TextureNResolution`、`g_ModelViewProjectionMatrix`、`a_Position`/`a_TexCoord` |
| 参数 uniform | 注释标注 `// {"material":"speed"}` 映射 material 参数名（全库映射表已收集，如 `g_Speed→speed/speeduv/rayspeed`）；无标注用注释 `default` |
| 音频 uniform | `g_AudioSpectrum{N}Left/Right[N]` 数组（Simple_Audio_Bars） |
| 输出 | `gl_FragColor`、`attribute`/`varying`（GLSL ES 1.0 风格） |

## 3. 架构设计

### 3.1 数据流（改造现有 SceneRenderer）

```
场景对象（image/particle/clearcolor）     ← 现状：直接渲染到 canvas
        │ 改造：渲染到离屏 RenderTarget（rtA）
        ▼
util 对象效果链（遇到 util 对象时，按 scene.json objects 数组顺序执行）
   pass1 → pass2 → ...（rtA ↔ rtB ping-pong）
   每个 pass：g_Texture0 = 上一 pass 输出，结果写回另一 RT
        ▼
最终贴屏（全屏 quad → 前景 canvas；contain 语义、bgCanvas 模糊层逻辑保留）
```

- `createSceneRenderer` 改造点：
  - 场景渲染目标从 canvas 改为 `rtA`（尺寸 = 正交视口尺寸，`renderer.setSize(vw, vh, false)`）；
  - 帧循环：`render(scene, rtA)` → 执行效果链 → `render(fullscreenQuad, canvas)`（正交相机 + `MapUV` 全屏 quad，采样 rtA）；
  - 效果链为每 util 对象独立执行（对象顺序语义：该对象位置处画面 = 其前方所有对象内容，效果结果供后续对象叠加）——因 image/particle 直接渲染同一场景 RT，实现上等价于"按对象顺序遇到 util 时对当前 RT 执行其效果链"；
  - 背景 canvas（模糊层）：**默认只对前景应用效果链**（避免模糊层双重处理；验证期若发现壁纸依赖背景层效果再调整）。
- 多 pass 资源管理：ping-pong RT 对复用；`WebGLRenderer` 需 `preserveDrawingBuffer: false` + 显式 `setRenderTarget` 切换。

### 3.2 渲染状态映射

材质 json 的 `blending`（`normal`/`add`/`multiply` 等）→ three.js `Blending` 枚举映射表；后处理 pass 一律 `depthTest: false, depthWrite: false`；`cullmode` 后处理场景无关（全屏 quad 正面朝相机）。

## 4. Shader 方言兼容层（核心）

### 4.1 模块划分（新增 `src/client/shader/`）

| 模块 | 职责 |
|---|---|
| `we-headers.ts` | 7 个内置头文件等价物（字符串常量，函数/常量定义） |
| `shader-preprocessor.ts` | include 展开（内置头 + 相对引用）、combo `#define` 注入、注释剥离（保留 uniform 标注用于绑定） |
| `uniform-binder.ts` | 解析 uniform 声明与标注 → 绑定策略：内置/参数（material 映射 + default）/音频（静音数组）/纹理槽 |
| `combo-schema.ts` | 全库 24 个 combo 宏白名单（校验 scene.json 传入值合法） |

### 4.2 方言函数等价物（common.h 等）

```
texSample2D(t, uv) = texture2D(t, uv)
mul(v, M) = M * v（行主序约定：gl_Position = mul(vec4(a_Position,1), g_ModelViewProjectionMatrix)）
rotateVec2(v, angle)、squareToQuad(p0..p3)、inverse(m3)、mod2(x,y)
常量：M_PI / M_PI_2 / DEG2RAD 等；common_blending.h：blend 相关辅助函数
```

实现完备性保障：**全库扫描脚本**（`research/scan-shader-dialect.mjs` 扩展）断言——所有 shader 中出现的 include 文件、非标准函数调用、`M_*` 常量均被内置层覆盖；新壁纸入库后可重跑。

### 4.3 uniform 绑定规则

| uniform | 绑定来源 |
|---|---|
| `g_Time` | 帧时间（秒，从 0 起） |
| `g_Texture0` | 上一 pass 输出 RT（首 pass = 当前合成画面） |
| `g_Texture1..3` | pass 的 `textures[]` 槽位，映射 `textures[i] → g_Texture(i+1)`（实测：`[null, "masks/xxx"]` → g_Texture1=遮罩、g_Texture2 缺省；元素 `null` 跳过）；`.tex` 经现有 `tex-loader` 加载 |
| `g_TextureNResolution` | 对应纹理尺寸（vec4: w,h,1/w,1/h，WE 语义） |
| `g_ModelViewProjectionMatrix` | 单位矩阵（全屏 quad 正交投影） |
| 参数 uniform | 注释 `{"material":"X"}` → `constantshadervalues.X`（支持 `{user,value}` 包装取 `value`）；无值 → 注释 `default`；均缺 → 0/单位值 |
| 音频数组 | 全零数组（静音；长度按 combo `RESOLUTION`，如 16/32/64） |

### 4.4 编译与回退

- 预处理输出 → `THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms })`；three r170 在 WebGL2 下自动处理 GLSL1 语法（`gl_FragColor`、`varying`、`attribute`），集成时以浏览器实测为准，必要时预处理自动改写（如 `texture2D`→`texture`）；
- 任一 pass 编译失败/资源缺失 → 跳过该效果（整条链继续下一效果），console.warn 记录原因；效果链全失败 → 画面保持效果链前状态（不触发壁纸级回退——画面本身已有效）。

## 5. Pass 合并与效果链执行

纯函数 `resolveEffectChain(sceneEffect, effectJson, files)`：

1. 读 `effect.json`（`effects[i].file`）→ 逐 pass 取 `material` 引用；
2. 读材质 json → `shader` 名、渲染状态；
3. 按索引合并 scene.json 覆写：`combos` → combo 宏、`constantshadervalues` → 参数 uniform 值表、`textures` → 纹理槽；
4. 产出 `EffectPass[]`：`{ vertSrc, fragSrc, uniforms: 静态值表, textures, blendMode, 音频标志 }`（shader 源码与静态值在效果加载时解析一次并缓存，帧循环只更新 `g_Time`）。

## 6. 错误处理与性能

| 场景 | 行为 |
|---|---|
| effect.json / material / shader 缺失或 JSON 非法 | 跳过该效果，console.warn |
| shader 编译失败 | 跳过该效果（编译错误信息进 console.warn 便于排查） |
| uniform 类型不匹配（如 float 收到字符串） | 数值化失败用默认值，不中断 |
| 性能 | 效果链 RT 尺寸 = 视口尺寸；多 pass 效果（blurprecise 等）可后续加降采样；一期不做自动降级（FPS 监测框架已有，二期可接） |

## 7. 测试策略

- **单元测试（vitest，node 环境，TDD）**：
  - `shader-preprocessor`：include 展开、combo 注入、注释标注提取（用全库真实 shader 做 fixture 断言）；
  - `uniform-binder`：material 映射 / default 回退 / `{user,value}` 包装 / 音频数组尺寸；
  - `resolveEffectChain`：真实壁纸数据（2911105183 的 waterwaves 链、Simple_Audio_Bars 链）断言 pass 结构、纹理槽、combo；
  - 方言完备性：全库 shader 扫描断言所有 include/内置函数/常量均被 `we-headers.ts` 覆盖。
- **集成验证（手动，浏览器）**：GUI 切换含效果壁纸（2911105183、1429403119、2832263418、3743126786 等），确认水波/模糊/抖动/光晕/音频条可见、无 console 报错；性能面板确认 FPS ≥ 30。
- **全库回归**：扩展 `tests/verify-real-library.test.ts` —— 所有 util 对象效果链可完整解析（effect/material/shader/纹理槽齐全）。

## 8. 里程碑与验收

1. **M1 方言层**：预处理器 + 头文件等价物 + 绑定器，单测全绿；
2. **M2 管线接通**：RT ping-pong + 全屏贴屏，单效果（waterwaves）在 GUI 可见动态水波；
3. **M3 泛化**：全库 17 个效果壁纸逐个验证，效果可见或优雅跳过（无 console 报错、不黑屏）；
4. **验收**：全库壁纸中 util 效果链解析 100%（回归测试硬断言）；GUI 手动验证 ≥10 个效果壁纸画面明显改善；FPS ≥ 30。

## 9. 非目标（维持不变）

- 壁纸内音频播放（§2.2 总设计）——音频效果喂静音数据；
- 对象级局部 RT（效果全屏执行，已确认）；
- 鼠标/键盘交互（视差等）；
- TEX→PNG 导出工具。
