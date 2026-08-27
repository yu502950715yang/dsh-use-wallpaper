# DSH Wallpaper Engine Scene 渲染 — Wasm 对象级效果链（v2）

- 日期：2026-08-25
- 状态：**架构已实施；编译链（spirv-webgpu-transform）待联网集成，真实效果验证待补齐**。
  - 已实施：对象级效果链**渲染架构**（对象 RT / 局部相机 / 效果链 ping-pong / 合成 quad UV 窗口 / particle 对象 / SceneScript 并存）。**M5 阶段用内置演示 shader（g_Time 程序化，naga glsl-in 可编译）验证架构**，未接入真实 WE 效果 shader。
  - 未实施（需联网）：**真实 WE 效果 shader 的 GLSL→WGSL 编译链（spirv-webgpu-transform）**。naga 24/25 glsl frontend 无法编译含 `uniform sampler2D`（`g_Texture0`）的 WE shader（`NotImplemented("variable qualifier")`，见 `progress.md`）；编译链集成后真实效果壁纸的非 STATIC 目标才达成。
  - 用户已确认方向：**对象级效果链移植到 wasm**；技术路线原为**方案 A naga 编译**，因 naga sampler 卡点改为**编译链（`spirv-webgpu-transform`）待联网集成**；范围：**通用管线，音频频谱留 v3**。
- 项目根：`E:\code\dsh-use-wallpaper`
- 关联：
  - `docs/superpowers/specs/2026-08-19-we-scene-wasm-renderer-design.md`（wasm 渲染器 v1 设计，本 spec 为其 v2 延续）
  - `src/client/effect-runner.ts` / `src/client/shader/*`（JS 侧效果链蓝本）
  - `src/client/scene-renderer.ts`（对象级效果链 JS 蓝本：`groupEffectsByObject`/`objectCameraRange`/`uvWindow`/`createCompositeGeometry`/对象 RT/局部相机/合成 quad）
  - `research/open-wallpaper-engine`（桌面版 WE C++/Vulkan 参考实现；`_rt_imageLayerComposite_<id>` + `CompositeTarget()` 的对象级 Layer/CompositeTarget 语义来源）
  - `research/naga-spike/`（本 spec 的前置 spike：验证 naga 24 编译 WE 方言 shader → WGSL）

---

## 1. 背景与目标

现状：**wasm 渲染器（Rust/wgpu）是当前主渲染路径**（强制 wasm 无 JS 回退，`wasm-renderer.ts` 的 `createFallbackSceneRenderer` 已禁用 JS 渲染器）。它已能渲染静态图片平面 + GPU 粒子，覆盖 `image` 图片对象与 `particle` 粒子对象。

核心缺口：**对象级效果链执行器未接入 wasm**。带对象级 `effects`（waterwaves / shake / fade / godrays / foliagesway / iris 等后处理 shader）的壁纸，在 wasm 路径下**只渲染静态图片 + 粒子**（README 中俗称 STATIC），效果链动画缺失，与 WE 真机差距最大。

目标：把 JS 侧对象级效果链移植到 wasm（Rust/wgpu），让 wasm 主路径下效果链动画完整、逼近 WE 真机。**非新增重做**——JS 侧现有实现与单测作为移植蓝本（README Roadmap「优先：对象级效果链」）。

## 2. 现状分析

### 2.1 wasm 渲染器已具备什么

- `wasm/src/scene.rs`：解析 scene.json → `SceneObject`，**已含 `effects: Vec<serde_json::Value>` 字段**（无需扩展解析）。
- `wasm/src/render/mod.rs`：`Renderer`（device/queue/surface/config）、图片平面管线（`shaders/image.wgsl`）、GPU 粒子管线、`coords::image_center_ndc`/`image_half_ndc` 坐标映射、相机模式（contain/cover）、`CameraMode`。
- 渲染帧 `render_frame`：清屏 → 图片平面 → 粒子层（加法混合），直接输出到 surface。
- `wasm/src/lib.rs`：`WeScene` 导出 `create/resize/set_cover/load_scene/load_image/add_particle/step/render`。

### 2.2 关键缺口（要移植的对象级效果链）

wasm 渲染器**没有**：离屏 RT 管线、对象级对象 RT + 局部相机、效果链逐 pass 执行器、合成 quad（UV 窗口映射）、`naga` GLSL→WGSL 编译。这些是 v2 要补的。

### 2.3 JS 侧对象级效果链蓝本（语义对齐基准）

`src/client/scene-renderer.ts` 的对象级效果链实现（T1.3/T1.4/T4.x），逐点语义如下，wasm 侧按此对齐：

- **对象路径选择**：`shouldUseObjectPath(obj)` = `effects` 非空数组 → 走对象 RT 路径；image 与 particle 对象共用；text/visualizer 恒走共享场景路径。
- **对象分组**：`groupEffectsByObject(objects)` 按 objects 顺序提取带效果对象，每组保留该对象自己的 `effects`（不展平——每对象独立执行链）。
- **对象 RT 尺寸**：`objectCameraRange(objSize, scale)` / `particleObjectRange(spec, scale)` —— `|size×scale|`（或 `|distanceMax×scale|`）逐轴钳制到 `OBJECT_RT_MAX=2048`、下限 1；`createObjectRenderTarget` 取整为正整数像素。
- **局部相机**：正交，范围 = 对象 RT 分辨率（中心原点，RT 像素与场景像素 1:1），`position.z=CAMERA_DISTANCE(300)`。
- **局部场景**：只含该对象 mesh，内容世界坐标 `(0,0,0)`（对象中心即局部原点）。
- **合成 quad**：世界尺寸 = **未钳制** `size×scale`（幅值，取 `Math.abs`）；UV 逐轴经 `uvWindow`/`applyUvWindow`/`createCompositeGeometry` 展开映射，只采样对象 RT 可见段；位置 = 对象中心映射 `(ox - vw/2, oy - vh/2)`；初始 `map = rt.texture`。
- **UV 窗口**：`uvWindow(unclamped, clamped)`：`clamped>=unclamped`（未钳制轴）→ `[0,1]`；否则 `start=(unclamped-clamped)/2/unclamped`、`end=1-start`；`applyUvWindow` 把 quad UV 从 `[0,1]` 线性展开到窗口外侧（采样器 CLAMP 到边缘）。
- **帧循环**：① 每个带效果对象先渲染进各自对象 RT（局部相机）；② 共享场景渲染前，合成 quad 的 `map = runner.lastOutput() ?? rt.texture`（链未就绪回退对象原始内容）；③ 渲染共享场景到场景 RT；④ 每个 runner 异步串行执行效果链 `runner.update(time, rt.texture)`。
- **效果链执行（`EffectRunner`）**：逐 pass 在 ping-pong RT 上执行 WE 后处理 shader。首 pass `g_Texture0` = 输入纹理（对象 RT），`g_Texture(i+1)` = `textureSlots[i]`，`g_Time`、`g_TextureNResolution`、`g_AudioSpectrum*`；每 pass 一个全屏 quad（NDC 正交相机）+ `ShaderMaterial`，`blendMode` 映射（normal/add/multiply/subtract）。

### 2.4 spike 已验证的前提（`research/naga-spike/`）

用真实 WE 内置 shader（`fade.frag`）端到端验证：**naga 24 的 glsl frontend 能把「WE 方言 → desktop GLSL」编译为合法 WGSL（609 字节），并通过 naga-valid 校验**。关键输出：

- ⚠️ naga 前端**不接受 `#version 300 es`**，要求 desktop 版本（`#version 450`），且**每个 uniform 需 `layout(binding=N)`**、fragment `out` 需 `layout(location=0)`。
- ⚠️ naga 对**部分 WE 方言构造**报 `NotImplemented`（如 `composelayer.frag` 的某个 `限定符 + 标识符;` 声明）——需要逐类适配或降级跳过该 pass。
- 结论：方案 A 可行，但「WE 方言 → naga desktop GLSL」前置转换是重头。

---

## 3. 总体架构（分层 + Layer/CompositeTarget 模型）

```
                          浏览器（client，JS 胶水）
  ┌───────────────────────────────────────────────────────────┐
  │  effect-chain.ts 解析效果链(effect/material/shader)         │
  │   → pass 元数据(原始 .vert/.frag + combos + textures + ...) │
  │  glsl-to-naga.ts  新增：WE 方言 → naga desktop GLSL 450     │
  │   → pass 描述(GLS字符串 + uniform绑定/类型 + 纹理槽 + blend) │
  │  传给 wasm（wasm-bindgen API）                              │
  └───────────────┬───────────────────────────────────────────┘
                  │（GLSL + uniform 元数据 + 纹理槽 / 返回对象 RT 结果）
  ┌───────────────▼───────────────────────────────────────────┐
  │  wasm（Rust + wgpu + naga）                                 │
  │  effect.rs     用 naga 把 GLSL→WGSL，naga-valid 校验，建管线 │
  │  WeScene       对象 RT + 局部相机 + ping-pong 效果链 pass    │
  │                + 合成 quad(UV 窗口) + 坐标/尺寸复用 coords    │
  └───────────────────────────────────────────────────────────┘
```

**对象级 Layer/CompositeTarget 模型**（对齐 open-wallpaper-engine 与 JS 蓝本）：

```
带效果对象(image/particle, effects 非空)
   │  渲染进对象 RT（局部正交相机，范围=RT 分辨率，中心原点）
   ├─► 效果链逐 pass（ping-pong RT，全屏 quad，WE 后处理 shader）
   │    g_Texture0=输入 / g_TextureN=纹理槽 / g_Time / blendMode
   └─► 输出 → 合成 quad 贴回共享场景（世界尺寸=未钳制，UV 窗口采样对象 RT 可见段）
无效果对象 ──► 共享场景路径（现有图片/粒子管线，不经过对象 RT）
```

## 4. 详细设计

### 4.1 JS 侧：效果链解析 + WE 方言 → naga desktop GLSL

**解耦现有 `effect-chain.ts`**（现它内部调 `preprocessWeShader` 产出给 three 的 GLSL3）。改为产出「pass 元数据」，分别提供两条编译路径：

- `CompiledEffectPass` 增加/保留 `rawVert`、`rawFrag`（WE 原始 `.vert/.frag`）、`combos`、`textureSlots`、`blendMode`、uniform 注解。
- `compileForThree(pass)`：现有 `preprocessWeShader`（给 JS 渲染器，保持不变）。
- `compileForWasm(pass)`：新增 `glsl-to-naga.ts`，把 `rawVert/rawFrag` 转成 naga 可接受的 desktop GLSL 450。

**`glsl-to-naga.ts` 转换规则**（spike 已验证基调）：
1. 展开 WE 内置头 include（复用 `we-headers.ts` 的 `WE_HEADERS`，含 `common.h`/`common_blur.h`/`common_blending.h` 及嵌套 include，`#ifndef` guard 迭代展开至稳定）。
2. 注入 combo 宏（scene.json 覆写优先，`[COMBO]` 注释 default 兜底）。
3. `#if` 表达式中的裸标识符 → `#define X 0`（GLSL 要求 #if 宏已定义）。
4. 去掉 precision 限定符（`highp/mediump/lowp`）。
5. 重写属性/插值：`varying type name;`（fragment）→ `in type name;`，`attribute type name;`（vertex）→ `in type name;`（vertex 输出用 `out` 由 WASM 侧决定——vertex shader 的 `varying` 声明统一在 vertex→`out`、fragment→`in`）。
6. `gl_FragColor` → `layout(location=0) out vec4 o_Color;` + 引用替换。
7. **每个 uniforms 注入 `layout(binding=N)`**按声明顺序编号（sampler/标量/向量统一）。
8. WE 方言纹理函数 → 内建：`texSample2D(`→`texture(`、`texSample2DLod(`→`textureLod(`、`texture2D(`→`texture(`；`mul`、`saturate`、`frac` 等方言函数由 WE_HEADERS 注入。
9. 头部 `#version 450`。

输出 **pass 描述**：`{ vertGlsl, fragGlsl, uniforms: [{name, type, value, binding}], textureSlots, blendMode, audioUniforms }`。`binding=N` 与 naga 反射一致（JS 决定编号），传给 wasm 供 bind group 布置。

### 4.2 wasm 侧：naga GLSL→WGSL 编译 + 管线

新增 `wasm/src/render/effect.rs`：

- **编译**：`naga::front::glsl::Frontend::parse(&Options{stage, defines}, glsl)` → 得到 naga IR；`naga::valid::Validator` 校验；`naga::back::wgsl::Writer` 输出 WGSL 字符串。vertex（`stage=Vertex`）与 fragment（`stage=Fragment`）分别编译。
- **管线**：把两个 WGSL module 用 `device.create_shader_module` 建入 wgpu；`create_render_pipeline`（全屏 quad，`PrimitiveTopology::TriangleStrip`，`vertex_index` 推导角点——复用 `image.wgsl` 的 vs 模式；fragment 输出到 RT/surface）。blendMode 映射到 `BlendState`（normal=SrcAlpha/OneMinusSrcAlpha、add=Additive、multiply=Multiply、subtract=Subtract）。
- **bind group**：按 pass 描述建 bind group layout（binding=0 输入纹理 `g_Texture0`，binding=1..N 纹理槽 `g_TextureN`，及 uniform buffer binding）。
- **uniform buffer**：把 pass 的静态 uniform 值（vec/float/int/矩阵）打包到 wgpu buffer；`g_Time` 每帧从 host 更新时间；`g_TextureNResolution` 按当前输入纹理尺寸更新（音频频谱留 v3，`g_AudioSpectrum*` 置 0）。
- 依赖：`wasm/Cargo.toml` 增 `naga = { version = "24", features = ["glsl-in", "wgsl-out"] }`（与现有 wgpu 24 同代；spike 已验证该组合可编译 WE 方言）。

### 4.3 对象级效果链管线（对象 RT + 局部相机 + ping-pong pass + 合成 quad）

扩展 `WeScene` / `Renderer`：

- **对象 RT**：`device.create_texture`（`RENDER_ATTACHMENT|TEXTURE_BINDING`，尺寸 = 对象 RT 分辨率，`createObjectRenderTarget` 语义）+ 对应 render pass。
- **局部相机**：正交（范围 = 对象 RT 分辨率，中心原点）；裁剪矩阵/NDC 在 CPU 计算，内容 mesh 保持 `(0,0,0)`（对象中心即局部原点）。
- **效果链 pass**：ping-pong 使用两个对象 RT（`rtA/rtB`，同尺寸）。首 pass 输入 = 对象 RT 纹理，逐 pass 输出到对端；每 pass 一个全屏 quad + 该 pass 管线 + bind group。
- **合成 quad**：全屏 quad 渲染到共享场景/surface，世界尺寸 = 未钳制 `size×scale` 幅值，UV 经 `uvWindow`/`applyUvWindow` 映射（复用 `coords::image_center_ndc`/`image_half_ndc` 定位），只采样对象 RT 可见段；初始采样对象 RT（无效果时显示原始对象，不白屏）。
- **渲染帧 `render_frame` 重排**：① 无效果对象（图片/粒子）直接渲染到 surface 层；② 带效果对象渲染进各自对象 RT（局部相机）→ 效果链 ping-pong → 输出；③ 合成 quad 渲染到 surface（采样对象 RT/效果输出）；④ 粒子层。顺序需保证合成 quad 在正确 z 层。
- **对象 RT/管线缓存的时机**：壁纸加载后（`load_scene` + 对象/效果链传入后）一次性用 naga 编译全部 pass 的 WGSL + 建管线 + 建对象 RT/合成 quad 资源；**不在每帧编译**（naga 编译耗时）。

### 4.4 uniform/纹理槽/blendMode 绑定

- `g_Texture0`：当前效果链输入（对象 RT 纹理或上一 pass 输出）。
- `g_Texture1..N`：pass 的 `textureSlots[i]` 对应纹理（复用现有 `/wallpapers/scene/<id>/asset` 纹理字节 → 上传 wgpu 纹理；`util/*` 内置纹理复用 `resolveBuiltinTexture` 语义 → Rust 侧生成 1×1 白 / 256 噪声）。
- `g_Time`：每帧 host 传入（`clock.elapsedTime` 对应）。
- `g_TextureNResolution`：读端纹理尺寸（vec4: w,h,1/w,1/h）。
- `g_AudioSpectrum*`：v3（本 spec 留 0，静音）。
- `blendMode`：映射到管线 `BlendState`。

### 4.5 数据流

```
scene.json ──► 现有 parse(scene) 得 SceneObject(含 effects)
   ├─ 无效果对象 → 现有 image/particle 管线（surface 直接渲染）
   └─ 带效果对象(effects 非空) → effect-chain.ts 解析链
        → glsl-to-naga 生成 pass 描述 → wasm(load_effect/add_effect_pass)
        → naga 编译 WGSL + 建管线 + 对象 RT + 合成 quad
帧循环：带效果对象进对象RT → 效果链 ping-pong → 合成quad贴回 surface 层
        （无效果对象/粒子仍直接渲染 surface；对象级效果已在帧内同步完成）
```

### 4.6 错误处理与回退（绝不白屏）

- **pass 级 shader 编译失败**（naga 报错 / naga-valid 失败 / 管线创建失败）→ 跳过该 pass（效果链输出 = 输入纹理，对齐 JS 的 pass 级跳过 `continue`）；**不中断其余对象/帧**。
- **全对象效果链失败** → 该对象回退渲染其对象 RT 原始内容（效果链输出 = 对象 RT 纹理，对象正常显示、无效果）。
- **对象缺失/纹理缺失** → 跳过该对象（对齐现有 `rendered` 计数，不漏渲染）。
- **任何异常** → `render` 返回 false，走既有 preview 回退链；**绝不白屏**。

---

## 5. 范围（MVP 边界）

### 5.1 MVP（本 spec 交付）

- 通用效果链管线（GLSL→WGSL 覆盖全部 WE 后处理 shader；`glsl-to-naga` + naga 编译）。
- 对象级 Layer/CompositeTarget（对象 RT + 局部相机 + ping-pong 效果链 + 合成 quad + UV 窗口）。
- image 对象与 particle 对象（共用对象路径）。
- 效果链 pass 包含 `g_Texture0..N`、`g_Time`、`g_TextureNResolution`、uniform 值、blendMode。
- 错误处理：pass 编译失败跳过 / 对象级失败回退（不白屏）。

### 5.2 非目标（后续）

- **音频频谱**（`g_AudioSpectrum*`、`createAudioAnalyzer` 接入）——v3。
- **text 对象 + clock/visualizer 脚本**——`text`/`visualizer` 恒走共享场景路径（与 JS 一致），不进对象 RT/效果链。
- 用户属性/视觉脚本求值（wasm 侧恒默认值）——后续。
- 全屏/场景级效果链（非对象级）——不在本 v2（对象级为主）。

## 6. 测试与验证

- **Rust native（`cargo test`）**：
  - naga GLSL→WGSL 编译、`glsl-to-naga` 转换规则（若放 wasm native 可测部分或 JS 侧测试）——spike 已验证基调；扩展为针对真实 WE shader（fade/foliage 等 fixture）的编译测试。
  - 对象 RT 尺寸（`objectCameraRange`/`particleObjectRange` 钳制 2048/min 1）、`uvWindow` 数学、`createCompositeGeometry` UV 映射、blendMode 映射、坐标（复用 `coords`）。
- **浏览器验证**：`node research/verify-wasm-render.mjs` 增强——加载带效果壁纸，断言 wasm 路径下效果链**非 STATIC**（双帧 diff 检测动画/画面变化）；FPS ≥ 30。
- **全库回归**：`tests/verify-real-library.test.ts` 断言 24 个 scene 壁纸的 scene.json / 纹理 / 粒子 / 效果链解析零失败。
- **双验证**：改渲染/效果链逻辑后跑全量单测 + `verify-wasm-render.mjs` 双模式再提交（AGENT.md §7）。

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| naga 对部分 WE 方言构造 NotImplemented（spike 实证） | ① `glsl-to-naga` 逐步兼容，按真实壁纸 shader 迭代转换规则；② pass 级编译失败跳过（不白屏兜底）；③ 预留「仅支持常见效果」降级路径 |
| 预处理工作量 > 预期（naga 需 desktop 450 + binding/location） | 明确 `glsl-to-naga` 为 v2 主要成本，复用 WE_HEADERS/combo 宏逻辑；spike 已产出可复用转换基型 |
| wasm 体积增大（引入 naga） | 关注体积预算；必要时 feature 裁剪/`wasm-opt`；记录体积变化 |
| 性能：对象 RT + 多 pass + 粒子 | 对象 RT 尺寸钳制 2048；pass 编译/管线一次性建（非每帧）；监控 FPS |
| 对象级/场景级 uniform binding 编号协调 | JS 侧统一分配 `layout(binding=N)`，wasm 按 pass 描述布置 bind group |
| 超大对象效果裁剪 | 对象 RT 钳制 2048 + UV 窗口映射（对齐 JS 蓝本，已处理） |
| 顺序/状态管理（对象 RT ↔ surface） | `render_frame` 明确 pass 顺序；wgpu 命令编码单线程，无 JS 侧共享 renderer 竞态 |

## 8. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | wasm 引入 naga + GLSL→WGSL 编译管线（单 pass 全屏 quad 基线，编译一个已知 WE shader 并渲染成功） | 浏览器出现 wasm 渲染的可编译效果 pass |
| M2 | 效果链 pass 执行器（ping-pong RT + 纹理槽 + uniform + blendMode） | 单 pass 效果在 RT 上执行并输出 |
| M3 | 对象级（对象 RT + 局部相机 + 合成 quad + UV 窗口）串通一个带效果 image 对象 | 带效果 image 对象 wasm 下动画（双帧 diff） |
| M4 | particle 对象效果链 + 全库带效果壁纸回归 | 24 壁纸零失败；带效果壁纸非 STATIC |
| M5 | 性能调优 + 浏览器双帧验证 + 文档与 build 顺序（build:wasm→build:client） | FPS ≥ 30；文档/AGENT/README 更新 |

---

## 9. 关键实现注意（踩坑预防）

1. **naga 版本与 API**：naga 24 的 `Options` **无 `version` 字段**（从 shader `#version` 读取），字段为 `stage`/`defines`；`Frontend::parse(&opts, glsl)` 参数顺序；`Writer::new(输出, flags)` + 先 `Validator::validate` 得 `ModuleInfo` 再 `write`。spike 已用正确 API（见 `research/naga-spike/src/main.rs`）。
2. **naga 需要 desktop GLSL**：`#[version 450]`、每个 uniform `layout(binding=N)`、fragment `out` `layout(location=0)`——`glsl-to-naga` 必须注入。
3. **`--target web` 不变**：wasm 构建仍 `--target web`；naga 是 pure Rust，wasm 兼容，不影响加载方式。
4. **对象级效果链语义与 JS 逐点对齐**：对象路径选择、对象 RT 尺寸钳制、局部相机范围 = RT 分辨率、合成 quad 世界尺寸 = 未钳制幅值、UV 窗口映射、`(ox-vw/2, oy-vh/2)` 映射（**不翻转 y**，AGENT.md §2.3）。
5. **构建顺序**：改 `wasm/`（Rust）必先 `build:wasm` 再 `build:client`（AGENT.md §123）。

---

> 说明：本 spec 是「渲染内核补全」性质，非新增重做；JS 侧源码与测试（`effect-runner`/`scene-renderer`/`shader/*`）作为移植蓝本与语义基准。MVP 范围已与用户确认（通用管线、音频留 v3）。
