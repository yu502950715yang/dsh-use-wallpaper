# Wasm 对象级效果链（v2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 JS 侧对象级效果链移植到 wasm（Rust/wgpu + naga），让 wasm 主路径下带 `effects` 的壁纸效果链动画完整、逼近 WE 真机。

**Architecture:** 分层。JS 侧新增 `glsl-to-naga.ts` 把 WE 的 GLSL 方言预转成 naga 可接受的 desktop GLSL 450（注入 `layout(binding=N)`/`layout(location=0)`）；wasm 侧新增 `render/effect.rs` 用 naga 把 GLSL 编译成 WGSL + 建 wgpu 管线，并组织对象级 Layer/CompositeTarget（对象 RT + 局部相机 + ping-pong 效果链 pass + 合成 quad + UV 窗口）。复用现有 `coords`/`image.wgsl` 模式与 `build:wasm→build:client` 顺序。

**Tech Stack:** Rust（wasm32-unknown-unknown）、wgpu 24、naga 24（`glsl-in`+`wgsl-out`）、wasm-bindgen、WebGPU；TS（esbuild）+ vitest（node+jsdom）。

**Spec:** `docs/superpowers/specs/2026-08-25-wasm-object-effect-chains-design.md` — 本计划逐任务从该 spec 论证；执行者同时读 spec 与 plan。

## Global Constraints

- wasm 构建必须 `--target web`；改 Rust 必先 `build:wasm` 再 `build:client`（AGENT.md §123）。
- 坐标：WE 场景系左下原点、y 向上；映射 `three.x = we.x - vw/2`、`three.y = we.y - vh/2`（**不做 y 翻转**，AGENT.md §2.3）。
- naga 24 API：`Options` 无 `version` 字段（`stage`/`defines`）；`Frontend::parse(&opts, glsl)`；`Writer::new(输出, flags)` + 先 `Validator::validate` 得 `ModuleInfo` 再 `write`（spike 已验证，见 `research/naga-spike/src/main.rs`）。
- naga 需 desktop GLSL `#version 450`、每个 uniform `layout(binding=N)`、fragment `out` `layout(location=0)`（`glsl-to-naga.js` 必须注入）。
- 对象 RT 尺寸：`|size×scale|` 逐轴钳制 `OBJECT_RT_MAX=2048`、下限 1；局部相机范围 = 对象 RT 分辨率（1:1 像素）。
- 带效果对象 = `effects` 非空数组（`shouldUseObjectPath`）；text/visualizer 恒走共享场景路径，不进对象 RT/效果链。
- 绝不白屏：任何 pass 效果链失败 → 跳过该 pass（输出输入纹理）/ 对象回退其原始内容 / 整体回退 preview。
- 音频频谱（`g_AudioSpectrum*`）**留 v3**，本计划 pass 内置 0。

---

## 文件结构（本计划涉及的创建/修改）

**JS 侧**
- `src/client/shader/effect-chain.ts` — **修改**：解耦出 pass 元数据（保留 raw .vert/.frag 源 + combos + textureSlots + blendMode + uniform 注解），供 JS 渲染器（`preprocessWeShader`）与 wasm（`glsl-to-naga`）双路径编译。
- `src/client/shader/glsl-to-naga.ts` — **新建**：WE 方言 → naga desktop GLSL 450 + pass 描述（uniform binding/类型/值、纹理槽、blendMode）。
- `src/client/wasm-renderer.ts` — **修改**：加载带效果对象 + 效果链 pass 描述，构造 wasm 调用（新增 wasm-bindgen API），把对象/效果链传入 `WeScene`。

**wasm 侧**
- `wasm/Cargo.toml` — **修改**：加 `naga = { version = "24", features = ["glsl-in", "wgsl-out"] }`。
- `wasm/src/render/effect.rs` — **新建**：GLSL→WGSL 编译（naga）+ 效果链 pass 管线（ping-pong RT + 合成 quad）+ 对象 RT/局部相机资源管理。
- `wasm/src/render/mod.rs` — **修改**：集成 effect 管线进 `render_frame`（对象 RT → 效果链 → 合成 quad → surface）。
- `wasm/src/render/shader.rs`（可选，或并入 effect.rs）— naga 编译 helper。
- `wasm/src/lib.rs` — **修改**：`WeScene` 增效果链 API（`add_effect` / `set_object` 效果元数据传入）。
- `wasm/src/shader/effect.wgsl`（新建，演示/透传用的全屏 quad WGSL，作为编译基线测试）。

**测试**
- `tests/shader/glsl-to-naga.test.ts`（JS）— 转换规则单测。
- `tests/shader/effect-chain.test.ts`（JS）— 解耦回归。
- `wasm/tests/effect_test.rs`（Rust native）— naga GLSL→WGSL 编译、`uvWindow`/`objectCameraRange`/blendMode 映射、对象 RT 尺寸。
- `research/verify-wasm-render.mjs` — **扩展**：带效果壁纸双帧 diff，断言非 STATIC。

---

## 前置（JS 侧，先行）：glsl-to-naga 转换层 + effect-chain 解耦

本阶段独立于 wasm，是 wasm 效果链的**输入来源**（产出 naga desktop GLSL + pass 描述），可先行完成并独立测试。

**接口（阶段产物）：**
- `glslToNagaPass(materialCompileInput: PassSource) -> { vertGlsl, fragGlsl, uniforms, textureSlots, blendMode }`
- `effect-chain.ts` 产出的 `CompiledEffectPass` 增加 `rawVert`/`rawFrag`/`combos`（供 `glsl-to-naga` 走原始 .vert/.frag）。

### Task A：effect-chain.ts 解耦，产出 pass 元数据（含原始 shader 源）

**Files:**
- Modify: `src/client/shader/effect-chain.ts`
- Test: `tests/shader/effect-chain.test.ts`

**Interfaces:**
- Produces: `CompiledEffectPass { vertSrc, fragSrc, rawVert, rawFrag, combos, textures, blendMode, uniforms }`（`rawVert`/`rawFrag`/`combos` 为新增）。

- [ ] **Step 1: 写失败测试**（`tests/shader/effect-chain.test.ts`：断言解析产物含 `rawVert`/`rawFrag` 原始源与 `combos`）。

- [ ] **Step 2: 运行确认失败**（`npx vitest run tests/shader/effect-chain.test.ts` → FAIL rawVert undefined）。

- [ ] **Step 3: 实现**：在 `resolveEffectChain` 里保留原始 `vertRaw`/`fragRaw`（在 `preprocessWeShader` 之前）与 `combos`，写入 `CompiledEffectPass`（现有 `preprocessWeShader` 路径不变，供 JS 渲染器）。

- [ ] **Step 4: 运行确认通过**（vitest → PASS）。

- [ ] **Step 5: 提交**：
```bash
git add src/client/shader/effect-chain.ts tests/shader/effect-chain.test.ts
git commit -m "feat(client): effect-chain 解耦出原始 shader 源与 combos 供 wasm 路径"
```

### Task B：实现 glsl-to-naga.ts（WE 方言 → naga desktop GLSL 450 + pass 描述）

**Files:**
- Create: `src/client/shader/glsl-to-naga.ts`
- Test: `tests/shader/glsl-to-naga.test.ts`

**Interfaces:**
- Consumes: `CompiledEffectPass`（含 rawVert/rawFrag/combos/textures/blendMode/uniforms）、`WE_HEADERS`。
- Produces: `glslToNagaPass(pass: CompiledEffectPass, combos: Record<string,number>) -> { vertGlsl, fragGlsl, uniforms: UniformBindingDesc[], textureSlots: (string|null)[], blendMode: string }`。

- [ ] **Step 1: 写失败测试**（对一个 WE 方言 .frag 断言：输出以 `#version 450` 开头、`uniform` 带 `layout(binding=N)`、`gl_FragColor`→`layout(location=0) out`、`varying`→`in`、`texSample2D`→`texture`、`#if` 未定义宏注入 `#define X 0`、`highp/mediump/lowp` 去除）。

- [ ] **Step 2: 运行确认失败**。

- [ ] **Step 3: 实现转换规则**（按 spec §4.1 ①-⑨：WE_HEADERS include 展开、combo 宏、#if 宏、precision 去除、varying/attribute 重写、gl_FragColor→out、uniform layout(binding)、texSample2D/texture2D→texture、`#version 450`；输出 UniformBindingDesc（name/type/value/binding，binding 按声明序编号）。**复用 `we-headers.ts` 的 `WE_HEADERS` 与 `preprocessWeShader` 的宏提取逻辑**（`extractIfIdentifiers`/`extractComboDefaults`）。

- [ ] **Step 4: 运行确认通过**（vitest → PASS）。

- [ ] **Step 5: 提交**：
```bash
git add src/client/shader/glsl-to-naga.ts tests/shader/glsl-to-naga.test.ts
git commit -m "feat(client): WE 方言→naga desktop GLSL 转换层(glsl-to-naga)"
```

---

## Milestone 1：wasm 引入 naga + GLSL→WGSL 编译管线

**接口（阶段产物）：**
- `effect::compile_glsl_to_wgsl(glsl: &str, stage: ShaderStage) -> Result<wgpu::ShaderModule, String>` — 把标准 desktop GLSL 编译为 wgpu shader module；失败返回错误信息。
- `effect::validate_wgsl(wgsl: &str) -> bool` — naga-valid 校验（native 可测）。

### Task 1：wasm Cargo.toml 加 naga + native 编译测试

**Files:**
- Modify: `wasm/Cargo.toml`
- Create: `wasm/tests/effect_test.rs`

**Interfaces:**
- Consumes: 无（独立基线）。
- Produces: `effect::compile_glsl_to_wgsl`、`effect::validate_wgsl`（后续任务复用）。

- [ ] **Step 1: 加 naga 依赖**

`wasm/Cargo.toml` 依赖区（dependencies）追加：
```toml
naga = { version = "24", features = ["glsl-in", "wgsl-out"] }
```

- [ ] **Step 2: 写失败的 native 测试**

`wasm/tests/effect_test.rs`:
```rust
use we_scene_wasm::render::effect;

#[test]
fn compiles_we_dialect_glsl_to_wgsl() {
    // 一个 WE 方言 fragment（fade 语义），先经 glsl-to-naga 转成 desktop 450 的样子。
    let glsl = "#version 450\nlayout(location=0) out vec4 o_Color;\nlayout(binding=0) uniform vec3 color;\nvoid main(){ o_Color = vec4(color*0.7, 1.0); }";
    let wgsl = effect::glsl_to_wgsl(glsl, effect::Stage::Fragment);
    assert!(wgsl.is_ok());
}

#[test]
fn validates_wgsl() {
    let wgsl = "struct O { @location(0) c: vec4<f32>, };\n@fragment fn main() -> O { return O(vec4f(0.0)); }";
    // naga-valid 校验必须通过
    assert!(effect::validate_wgsl(wgsl));
}
```
> 注：Step 2 的测试为了能在 `cargo test`（native，无 render feature）下编译，先采用**纯逻辑放非门控区**（同 `image_tint` 做法）。`compile_glsl_to_wgsl`/`validate_wgsl` 用 naga（无 wgpu 依赖，native 可跑）实现，不依赖 render feature。

- [ ] **Step 3: 运行确认失败**

Run: `cd wasm && cargo test --test effect_test`
Expected: FAIL — `effect` 模块不存在（`unresolved import`）。

- [ ] **Step 4: 实现 `effect.rs`（naga 编译 helper，native 可测）**

`wasm/src/render/effect.rs`（非 render feature 也可编译：只依赖 naga/字符串，不依赖 wgpu；`ShaderStage` 枚举 self 定义）：
```rust
//! 效果链 shader 编译与校验（naga）。本模块为纯 naga + 字符串，可在 native cargo test 编译。
use naga::back::wgsl::Writer;
use naga::front::glsl::{Frontend, Options};
use naga::valid::{Capabilities, ValidationFlags, Validator};

#[derive(Debug, Clone, Copy)]
pub enum Stage { Vertex, Fragment }

/// 标准 desktop GLSL（#version 450，uniform 带 layout(binding=N)，out 带 layout(location=0)）
/// → naga WGSL → 字符串。失败返回错误信息。
pub fn glsl_to_wgsl(glsl: &str, stage: Stage) -> Result<String, String> {
    use naga::ShaderStage;
    let opts = Options {
        stage: match stage { Stage::Vertex => ShaderStage::Vertex, Stage::Fragment => ShaderStage::Fragment },
        defines: std::collections::HashMap::default(),
    };
    let mut front = Frontend::default();
    let module = front.parse(&opts, glsl).map_err(|e| format!("glsl parse: {e:?}"))?;
    let info = Validator::new(ValidationFlags::all(), Capabilities::all())
        .validate(&module).map_err(|e| format!("naga valid: {e:?}"))?;
    let mut w = Writer::new(String::new(), naga::back::wgsl::WriterFlags::EXPLICIT_TYPES);
    w.write(&module, &info).map_err(|e| format!("wgsl write: {e:?}"))?;
    Ok(w.finish())
}

/// naga-valid 校验一段 WGSL 字符串。
pub fn validate_wgsl(wgsl: &str) -> bool {
    use naga::front::wgsl::parse_str;
    parse_str(wgsl).ok()
}
```
`wasm/src/render/mod.rs` 顶部加 `pub mod effect;`（无 render feature 门控，native 可测）。

- [ ] **Step 5: 运行确认通过**

Run: `cd wasm && cargo test --test effect_test`
Expected: PASS（2 个测试）。

- [ ] **Step 6: 提交**

```bash
git add wasm/Cargo.toml wasm/src/render/effect.rs wasm/src/render/mod.rs wasm/tests/effect_test.rs
git commit -m "feat(wasm): 引入 naga + GLSL→WGSL 编译与校验 helper（native 可测）"
```

### Task 2：wasm 构建下 wgpu shader module 编译 + 全屏 quad 基线管线

**Files:**
- Create: `wasm/src/render/effect_pass.rs`（render feature 门控，wgpu 管线）
- Create: `wasm/src/shader/effect_passthrough.wgsl`（透传全屏 quad，测试用）
- Modify: `wasm/src/render/mod.rs`
- Test: `research/verify-wasm-render.mjs`（扩展）

**Interfaces:**
- Consumes: `effect::glsl_to_wgsl`（Task 1）、现有 `Renderer`/`device`/`queue`。
- Produces: `effect_pass::EffectPass::new(device, queue, pass_desc) -> Result<EffectPass>`、`EffectPass::render(&mut self, encoder, input_view, output_view)`。

- [ ] **Step 1: 写透传全屏 quad WGSL**

`wasm/src/shader/effect_passthrough.wgsl`（vs 用 vertex_index 推导角点，fs 采样 `g_Texture0` 透传）：
```wgsl
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, };
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    var out: VSOut;
    let c = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u));
    out.pos = vec4<f32>(c * 2.0 - 1.0, 0.0, 1.0);
    out.uv = c;
    return out;
}
@fragment fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    return textureSample(tex, samp, in.uv);
}
```

- [ ] **Step 2: 实现 `effect_pass.rs`（render feature）**

`wasm/src/render/effect_pass.rs`（`cfg(feature="render")`）：
```rust
//! 效果链 pass：全屏 quad + WGSL shader module + 图像/采样器/uniform bind group。
pub struct EffectPass {
    pub bind_group: wgpu::BindGroup,
    pub pipeline: wgpu::RenderPipeline,
    pub layout: wgpu::BindGroupLayout,
}
impl EffectPass {
    pub fn new(device: &wgpu::Device, wgsl: &str, format: wgpu::TextureFormat, layout: wgpu::BindGroupLayout) -> Result<Self, String> {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("effect-pass"),
            source: wgpu::ShaderSource::Wgsl(wgsl.into()),
        });
        // 与 image.wgsl 同模式：TriangleStrip + NDC 全屏 quad
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("effect-pass-pipeline"),
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("effect-pass-pl"),
                bind_group_layouts: &[&layout],
                push_constant_ranges: &[],
            })),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_main"), compilation_options: wgpu::PipelineCompilationOptions::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleStrip, ..Default::default() },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_main"), compilation_options: wgpu::PipelineCompilationOptions::default(), targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })] }),
            multiview: None, cache: None,
        });
        Ok(Self { bind_group: placeholder, pipeline, layout })
    }
}
```
> 注：`bind_group` 由调用方在渲染时按当前输入/纹理槽创建（输入纹理每次 pass 变化），此处结构体只存 pipeline/layout；bind group 在 `render` 时经参数传入。

- [ ] **Step 3: 集成到 Renderer —— 预留 effect 管线字段 + 一个测试 pass 渲染到离屏 RT**

`wasm/src/render/mod.rs`：`Renderer` 增 `effect_passes: Vec<effect_pass::EffectPass>` 与 `effect_layout: wgpu::BindGroupLayout`；`render_frame` 末尾（粒子层后）渲染测试 pass（读 surface 自采渲染，验证 wasm 工程串通）。

- [ ] **Step 4: 浏览器验证（扩展 verify 脚本）**

`research/verify-wasm-render.mjs`：加载一个带效果的场景，断言 wasm 路径能创建 effect pass 且屏幕有内容（不黑屏）。跑 `node research/verify-wasm-render.mjs`。

- [ ] **Step 5: 构建 + 提交**

```bash
npm run build:wasm && npm run build:client
```
Expected: 无编译错误；verify 脚本 wasm 路径 OK。
```bash
git add wasm/src/render/effect_pass.rs wasm/src/shader/effect_passthrough.wgsl wasm/src/render/mod.rs research/verify-wasm-render.mjs
git commit -m "feat(wasm): 全屏 quad 效果 pass 管线（wasm 构建基线）"
```

---

## Milestone 2：效果链 pass 执行器（ping-pong RT + 纹理槽 + uniform + blendMode）

**接口（阶段产物）：**
- `effect::EffectChain::new(device, queue, passes: Vec<EffectPassDesc>) -> EffectChain`
- `EffectChain::render(&mut self, encoder, input_view, output_view, time)` — 逐 pass ping-pong，`g_Texture0`/`g_Texture(i+1)`/`g_Time` 绑定，blendMode 映射。

### Task 3：效果链 pass 描述 + ping-pong 执行器

**Files:**
- Modify: `wasm/src/render/effect.rs`（加 `EffectPassDesc`/`EffectChain`，native 可测的纯逻辑 + render 门控 wgpu 部分）
- Modify: `wasm/src/render/mod.rs`
- Test: `wasm/tests/effect_test.rs`（ping-pong 写端选择、blendMode 映射）

**Interfaces:**
- Consumes: `effect::glsl_to_wgsl`、`EffectPass`。
- Produces: `EffectPassDesc { vert_glsl, frag_glsl, uniforms: Vec<UniformBinding>, texture_slots: Vec<Option<SlotId>>, blend_mode: BlendMode }`；`effect::pick_write_target(prev: Option<u8>) -> u8`；`effect::blend_mode_to_wgpu(mode: &str) -> Option<wgpu::BlendState>`（native 部分返回枚举索引）。

- [ ] **Step 1: 写失败的 native 测试**

`wasm/tests/effect_test.rs` 追加：
```rust
#[test]
fn pick_write_target_pings_pong() {
    // 首 pass（无上一写端）→ 0；上一写端 0 → 1；上一写端 1 → 0
    assert_eq!(effect::pick_write_target(None), 0);
    assert_eq!(effect::pick_write_target(Some(0)), 1);
    assert_eq!(effect::pick_write_target(Some(1)), 0);
}

#[test]
fn blend_mode_mapping() {
    // 纯逻辑：模式 → 枚举索引（native 无 wgpu）
    assert_eq!(effect::blend_mode_key("normal"), BlendKey::Normal);
    assert_eq!(effect::blend_mode_key("add"), BlendKey::Add);
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd wasm && cargo test --test effect_test`
Expected: FAIL — `pick_write_target`/`blend_mode_key` 未定义。

- [ ] **Step 3: 实现 ping-pong 选择 + blendMode 键（native）**

`effect.rs` 追加（非门控）：
```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlendKey { Normal, Add, Multiply, Subtract }

pub fn blend_mode_key(mode: &str) -> BlendKey {
    match mode { "add" => BlendKey::Add, "multiply" => BlendKey::Multiply, "subtract" => BlendKey::Subtract, _ => BlendKey::Normal }
}

pub fn pick_write_target(previous: Option<u8>) -> u8 {
    match previous { Some(0) => 1, _ => 0 }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd wasm && cargo test --test effect_test`
Expected: PASS。

- [ ] **Step 5: 实现 render 门控的 ping-pong pass 渲染**

`effect.rs`：`EffectChain::render(&mut self, encoder, &mut bind_group_provider, time)` —— 依次渲染 `passes`：
- 首 pass 输入 = `input_view`；每 pass 输出写到对端 RT（两张 RT `rt_a/rt_b`，同机造）；`read = write.texture` 作为下一 pass 输入。
- 每 pass 绑定 `g_Texture0`（读纹理视图）+ `texture_slots[i]`（`g_Texture(i+1)`）+ uniform buffer（`g_Time`/静态值）。
- `blend_mode_key` → `BlendState`.

- [ ] **Step 6: 浏览器验证 + 提交**

```bash
npm run build:wasm && npm run build:client && node research/verify-wasm-render.mjs
```
Expected: 效果链 pass 在 RT 上执行且输出正确。
```bash
git add wasm/src/render/effect.rs wasm/src/render/mod.rs wasm/tests/effect_test.rs
git commit -m "feat(wasm): 效果链 ping-pong 执行器 + blendMode 映射"
```

---

## Milestone 3：对象级（对象 RT + 局部相机 + 合成 quad + UV 窗口）

**接口（阶段产物）：**
- `effect::ObjectEffectTarget { rt: RenderTarget, camera_range: (f32,f32), world_size: (f32,f32), uv_window: (f32,f32,f32,f32) }`
- `effect::object_camera_range(size, scale) -> (f32,f32)`、`effect::uv_window(unclamped, clamped) -> (f32,f32)`（native 可测）。
- `effect::composite_geometry`（生成 UV 展开的 NDC quad）。

### Task 4：对象 RT 尺寸/UV/合成 quad 数学（native 纯函数）

**Files:**
- Modify: `wasm/src/render/effect.rs`（纯函数）
- Modify: `wasm/src/coords.rs`（复用 image_center_ndc/half_ndc）
- Test: `wasm/tests/effect_test.rs`

**Interfaces:**
- Consumes: `coords`（现有）。
- Produces: `object_camera_range(size:[f32;2], scale:[f32;2]) -> [f32;2]`、`uv_window(unclamped:f32, clamped:f32) -> (f32,f32)`、`composite_ndc_uniform(...)`。

- [ ] **Step 1: 写失败的 native 测试**

```rust
#[test]
fn object_camera_range_clamps_to_2048() {
    // 超大对象钳制到 2048；常规对象按 size×scale 取幅值
    let r = effect::object_camera_range([4000.0, 2000.0], [2.0, 1.0]);
    assert_eq!(r[0], 2048.0);
    assert_eq!(r[1], 2000.0);
}

#[test]
fn uv_window_unclamped_axis_full() {
    // 未钳制轴（clamped>=unclamped）→ [0,1]
    assert_eq!(effect::uv_window(100.0, 100.0), (0.0, 1.0));
    // 钳制轴：start=((W-C)/2)/W, end=1-start
    let (s, e) = effect::uv_window(100.0, 64.0);
    assert!((s - 0.18).abs() < 1e-6);
    assert!((e - 0.82).abs() < 1e-6);
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd wasm && cargo test --test effect_test`
Expected: FAIL。

- [ ] **Step 3: 实现**

```rust
pub const OBJECT_RT_MAX: f32 = 2048.0;
pub fn object_camera_range(size: [f32; 2], scale: [f32; 2]) -> [f32; 2] {
    [
        (size[0] * scale[0]).abs().clamp(1.0, OBJECT_RT_MAX),
        (size[1] * scale[1]).abs().clamp(1.0, OBJECT_RT_MAX),
    ]
}
pub fn uv_window(unclamped: f32, clamped: f32) -> (f32, f32) {
    if unclamped <= 0.0 || clamped >= unclamped { return (0.0, 1.0); }
    let start = (unclamped - clamped) / 2.0 / unclamped;
    (start, 1.0 - start)
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd wasm && cargo test --test effect_test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add wasm/src/render/effect.rs wasm/tests/effect_test.rs
git commit -m "feat(wasm): 对象 RT 尺寸钳制 + uvWindow 数学（native 纯函数）"
```

### Task 5：对象级效果链管线（对象 RT + 局部相机 + 效果链 + 合成 quad）

**Files:**
- Modify: `wasm/src/render/effect.rs` / `wasm/src/render/effect_pass.rs`（render 门控对象级）
- Modify: `wasm/src/render/mod.rs`（`render_frame` 重排：对象 → 对象RT → 效果链 → 合成quad → surface）
- Modify: `wasm/src/lib.rs`（WeScene 增对象效果 API）
- Modify: `src/client/wasm-renderer.ts`（配置对象效果链，调用 wasm API）

**Interfaces:**
- Consumes: `EffectChain`、`object_camera_range`、`uv_window`、`coords`。
- Produces: `WeScene::set_object_effect(obj_id, origin, world_size, rt_size, chain_desc)`、`WeScene::render_object_effects()`。

- [ ] **Step 1: JS 侧 wasm-renderer 构造对象效果链描述**

`src/client/wasm-renderer.ts`：`render()` 循环里，对每个 `effects` 非空对象：
- 复用 `groupEffectsByObject`/`shouldUseObjectPath`（从 scene-renderer import）区分。
- 调用 `glsl-to-naga` 生成 pass 描述，`scene.set_object_effect(objId, origin, worldSize, rtSize, passDesc)`。
- 无效果对象走现有 `load_image`/`add_particle`。

- [ ] **Step 2: wasm WeScene 增对象效果 API**

`wasm/src/lib.rs`：`set_object_effect`（记录对象 + 效果链描述 + 对象 RT/合成 quad 资源，`render_frame` 前建好）；`render_object_effects()`（帧内调用）。

- [ ] **Step 3: `render_frame` 重排（对象 RT → 效果链 → 合成 quad → surface）**

`wasm/src/render/mod.rs`：
```
1. 无效果图片/粒子 → 直接渲染到 surface（现有）
2. 对每个带效果对象：
   a. 渲染其内容到对象 RT（局部相机：中心原点，范围=rt 尺寸）
   b. 效果链 ping-pong 在对象 RT 上执行
   c. 合成 quad（全屏，NDC，UV 窗口映射）渲染到 surface（采样效果输出/对象 RT）
3. 粒子层
```
> 合成 quad 用 `uv_window` 展开 UV，位置用 `coords::image_center_ndc` 定位，采样对象 RT。未钳制轴窗口 `[0,1]`。

- [ ] **Step 4: 浏览器 + 回归**

```bash
npm run build:wasm && npm run build:client && npm test
node research/verify-wasm-render.mjs
```
Expected: 带效果 image 对象 wasm 下**动画**（双帧 diff 非 STATIC）；全库单测通过。

- [ ] **Step 5: 提交**

```bash
git add src/client/wasm-renderer.ts src/client/shader/glsl-to-naga.ts wasm/src/render/*.rs wasm/src/lib.rs
git commit -m "feat(wasm): 对象级效果链管线（对象RT+局部相机+效果链+合成quad）"
```

---

## Milestone 4：particle 对象效果链 + 全库回归

### Task 6：particle 对象效果链 + 全库带效果壁纸回归

**Files:**
- Modify: `wasm/src/render/effect.rs`（particle 对象范围 `particle_object_range` + `particle_world_size`）
- Modify: `wasm/src/lib.rs` / `wasm/src/render/mod.rs`（particle 对象挂效果链）
- Test: `wasm/tests/effect_test.rs`、`tests/verify-real-library.test.ts`
- Modify: `research/verify-wasm-render.mjs`

- [ ] **Step 1: 加 particle 对象范围纯函数（native 测试）**

```rust
#[test]
fn particle_object_range_uses_effective_distance() {
    // 无 distanceMax → 默认 64；有 → |dist×scale| 钳制
    let r = effect::particle_object_range(Some(128.0), [2.0, 2.0]);
    assert_eq!(r[0], 256.0);
}
pub fn particle_object_range(distance_max: Option<f32>, scale: [f32;2]) -> [f32;2] {
    let dist = distance_max.filter(|d| *d > 0.0).unwrap_or(64.0);
    object_camera_range([dist, dist], scale)
}
```

- [ ] **Step 2: 实现 + 集成 particle 对象效果链**

particle 对象（`add_particle`）若带 `effects` → 走对象 RT + 效果链（`particle_object_range` 算 RT 尺寸，`particle_world_size` 算合成 quad 世界尺寸）。复用 Task 5 的对象级管线。

- [ ] **Step 3: 全库回归**

```bash
npm test
```
Run: `node research/verify-wasm-render.mjs`（24 壁纸 + 带效果壁纸非 STATIC）.
Expected: 全库 24 壁纸零失败、0 黑屏。

- [ ] **Step 4: 提交**

```bash
git add wasm/src/render/*.rs wasm/src/lib.rs wasm/tests/effect_test.rs tests research/verify-wasm-render.mjs
git commit -m "feat(wasm): particle 对象效果链 + 全库回归"
```

---

## Milestone 5：性能、验证与文档

### Task 7：性能调优 + 浏览器双帧验证 + 文档

**Files:**
- Modify: `wasm/src/render/effect.rs`（对象 RT 钳制、pass 一次性编译）
- Modify: `docs/superpowers/specs/2026-08-25-wasm-object-effect-chains-design.md`、`README.md`、`AGENT.md`
- Test: `research/verify-wasm-render.mjs`（双帧 diff、FPS）

- [ ] **Step 1: 确认 pass 编译/管线一次性（壁纸加载时，非每帧）**

检查 `set_object_effect`/效果链构建在 `load_scene` 时做 naga 编译 + 建管线；`render_frame` 只做渲染。若在帧内编译，移至加载时。

- [ ] **Step 2: 浏览器双帧 diff + FPS**

`research/verify-wasm-render.mjs` 扩展：对带效果壁纸采样两帧（隔 ~500ms），diff 非零（效果动画）；记录 FPS ≥ 30。

- [ ] **Step 3: 更新文档**

README「接下来（wasm 渲染 Roadmap）」：把「对象级效果链」标为已接入 wasm；更新回退链描述。AGENT.md §2.1/踩坑记录补充 naga/对象级效果链要点。spec 状态改「已实施」。

- [ ] **Step 4: 运行全量验证 + 提交**

```bash
npm test
npm run build && npm run build:wasm && npm run build:client
node research/verify-wasm-render.mjs
node research/verify-wasm-render.mjs --no-webgpu
git add README.md AGENT.md docs research/verify-wasm-render.mjs
git commit -m "docs(wasm): 效果链接入 wasm 的文档更新与验证"
```

---

## Self-Review

**Spec 覆盖检查：**
- §4.1 JS 预处理（`glsl-to-naga` + effect-chain 解耦）→ **Task A/B**。
- §4.2 naga 编译 + 管线 → Task 1/2。
- §4.3 对象级管线 → Task 4（数学）+ Task 5（管线）。
- §4.4 uniform/纹理槽/blendMode → Task 2/3。
- §4.5 数据流 → Task 5 `render_frame` 重排。
- §4.6 错误处理 → Task 1（编译失败返回 Result）+ Task 5（pass 失败跳过兜底，实施时在 `render_frame` 补 try/catch 语义）。
- §6 测试 → Task A/B（JS）+ Task 1-7（native/浏览器/全库回归）。
- 风险（naga 部分 NotImplemented、性能、体积）→ Task 7 Step 1/2 + spec §7（实施时按真实 shader 迭代 `glsl-to-naga`）。

**Type 一致性：** `effect::glsl_to_wgsl`（Task 1）→ Task 2/3 复用；`pick_write_target`/`blend_mode_key`（Task 3）命名在 Task 3-5 一致；`object_camera_range`/`uv_window`（Task 4）在 Task 5/6 复用，签名 `[f32;2]`/`(f32,f32)` 一致。

**占位符/歧义：** 无 TBD/TODO；wasm 侧的 wgpu 具体调用（bind group 构造、`BlendState` 字段）在 Task 2/3 给骨架，实现时按现有 `image.wgsl`/`mod.rs` 模式补全。**注：** Task 1 Step 2 的占位 `compile_glsl_to_wgsl(..., "frag")` 签名与 Step 4 实现 `glsl_to_wgsl(glsl, stage)` 不一致——实施时应统一为 `glsl_to_wgsl(glsl: &str, stage: Stage)`，测试里据此调用（native 不依赖 wgpu）。

---

## Execution Handoff

计划已保存，提供两种执行方式供选择。
