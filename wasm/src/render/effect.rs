//! 效果链 shader 编译与校验（naga）+ 效果链 pass 描述 + 效果链 ping-pong 执行器。
//!
//! 结构决策（controller 裁决，见 task-3-brief.md）：
//! - **native 纯逻辑（非门控）**：`BlendKey`/`blend_mode_key`/`pick_write_target`/
//!   `EffectPassDesc`/`UniformBinding`/`SlotId`——不依赖 render feature / wgpu，native
//!   `cargo test`（无 render feature）可编译可测（同 Task1 的 `glsl_to_wgsl`/`validate_wgsl`）。
//! - **render 门控（`#[cfg(feature = "render")]`）**：`EffectChain`（管线/RT/bind group/
//!   uniform/`blend_key_to_wgpu`）——仅 wasm 构建编译（`--features render`）。
//!
//! 关键边界（M2，见 brief 裁决）：
//! - vert/frag **分别编译**：每个 pass 分别编译出 vert/frag 两个 WGSL → 各建一个 shader module →
//!   建 render pipeline（`entry_point: Some("main")`）。编译源按 pass 来源选择：真实 WE 效果
//!   shader（SPIR-V）走 `spv_to_wgsl`，演示/simple（GLSL）走 `glsl_to_wgsl`（见 `compile_pass_wgsl`）。
//! - blendMode 用 native `BlendKey` + `blend_key_to_wgpu(key)`（从 key 映射，DRY，不从 str 重复解析）。
//! - `EffectChain::new` 一次性编译/建管线/建 ping-pong RT/uniform buffer；`render` 逐 pass
//!   ping-pong，绑定 g_Texture0+纹理槽+`g_Time`，按 blendMode 混合；audio 频谱本任务置 0（v3）。
//! - 绝不白屏：`new` 失败返回 `Err`，调用方跳过该效果链（不硬崩）；`render` 不 panic。
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

/// 真实 WE 效果 shader：SPIR-V bytes → WGSL（编译链集成，非 render 门控，native 可测）。
///
/// 链路（task-8 brief / spike 结论）：`spirv-webgpu-transform`(`combimgsampsplitter`) 先拆组合
/// 采样器（@webgpu/glslang 产出的 `OpTypeSampledImage` 组合采样）为独立 texture + sampler
/// （注入 `OpSampledImage`），再 `naga::front::spv::parse_u8_slice`(spv-in) → `Validator` →
/// `wgsl-out`。对照：不 transform 直接 spv-in 会 `InvalidId`（sdk-1.3.268 的已知限制）。
///
/// `stage` 由 SPIR-V 的 `OpEntryPoint` 执行模型推导，本函数不依赖它（仅保留签名对称性
/// 与调用方一致性；spv 路径 entry_point 恒为 `main`）。失败返回错误字符串（绝不 panic）。
///
/// **防 panic（reviewer Important #1）**：`spirv-webgpu-transform` 的 `u8_slice_to_u32_vec` 对
/// 非 4 倍数长度 `assert`，`combimgsampsplitter` 对 SPIR-V 魔数 `assert` 并直接索引头 5 字
/// （空/畸形输入会 trap，比白屏更糟，违反「绝不白屏/绝不崩溃」）。故入口先做 SPIR-V 头部校验
/// （长度 ≥ 20 字节且为 4 倍数 + 魔数 `0x07230203` LE），不满足直接返回 `Err`，绝不进入 transform。
pub fn spv_to_wgsl(spv: &[u8], _stage: Stage) -> Result<String, String> {
    // ① 防 panic 头部校验：合法 SPIR-V 至少含 5 字头（20 字节）且 word 对齐；magic 0x07230203（LE）。
    if spv.len() < 20 || spv.len() % 4 != 0 {
        return Err(
            "invalid SPIR-V header: length must be >= 20 bytes (5 words) and a multiple of 4".into(),
        );
    }
    let magic = u32::from_le_bytes([spv[0], spv[1], spv[2], spv[3]]);
    if magic != 0x0723_0203 {
        return Err(format!("invalid SPIR-V header: bad magic 0x{magic:08x}"));
    }
    // ② spirv-webgpu-transform：拆组合采样器（sampler2D 的 OpTypeSampledImage → 独立 texture+sampler）
    let raw_u32 = spirv_webgpu_transform::u8_slice_to_u32_vec(spv);
    let mut correction_map = None;
    let transformed =
        spirv_webgpu_transform::combimgsampsplitter(&raw_u32, &mut correction_map)
            .map_err(|e| format!("spirv-webgpu-transform split: {e:?}"))?;
    let transformed_bytes = spirv_webgpu_transform::u32_slice_to_u8_vec(&transformed);
    // ③ naga spv-in 解析（SPIR-V → naga module）
    let module = naga::front::spv::parse_u8_slice(
        &transformed_bytes,
        &naga::front::spv::Options::default(),
    )
    .map_err(|e| format!("spv parse: {e:?}"))?;
    // ③ Validator（全量校验；spv-in 输出需 WGSL 写出前过校验）
    let info = Validator::new(ValidationFlags::all(), Capabilities::all())
        .validate(&module)
        .map_err(|e| format!("naga valid: {e:?}"))?;
    // ④ wgsl-out（显式类型写出，与 glsl_to_wgsl 一致）
    let mut w = Writer::new(String::new(), naga::back::wgsl::WriterFlags::EXPLICIT_TYPES);
    w.write(&module, &info)
        .map_err(|e| format!("wgsl write: {e:?}"))?;
    Ok(w.finish())
}

/// naga-valid 校验一段 WGSL 字符串（native 可测）。
pub fn validate_wgsl(wgsl: &str) -> bool {
    naga::front::wgsl::parse_str(wgsl).is_ok()
}

// =====================================================================
// native 纯逻辑（非 render 门控；native cargo test 可测）
// =====================================================================

/// blendMode 枚举（native 映射，DRY——render 层 `blend_key_to_wgpu` 从这里映射，不从 str 重复解析）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlendKey {
    Normal,
    Add,
    Multiply,
    Subtract,
}

/// WE 材质 json 的 `blending` 字符串 → `BlendKey`。`"add"/"additive"`→Add、
/// `"multiply"`→Multiply、`"subtract"/"subtractive"`→Subtract、其余（含缺省/未知）→Normal。
/// 对齐 JS `blendModeToThree` 的 default 回退（未知 → NormalBlending）。
pub fn blend_mode_key(mode: &str) -> BlendKey {
    match mode {
        "add" | "additive" => BlendKey::Add,
        "multiply" => BlendKey::Multiply,
        "subtract" | "subtractive" => BlendKey::Subtract,
        _ => BlendKey::Normal,
    }
}

/// ping-pong 写端选择：上一写端为 None（首 pass 读输入纹理，非 runner RT）→ 写 rt_a(0)；
/// 上一写端为 rt_a(0) → 写 rt_b(1)；上一写端为 rt_b(1) → 写 rt_a(0)。
/// 与 JS `EffectRunner::pickWriteTarget` 语义一致（read 恒为最近写端或输入纹理）。
pub fn pick_write_target(prev: Option<u8>) -> u8 {
    match prev {
        None => 0,
        Some(0) => 1,
        Some(_) => 0,
    }
}

/// 对象 RT 单轴尺寸上限（钳制到 2048，避免超大对象效果 RT 爆显存/超出 GPU 限制）。
pub const OBJECT_RT_MAX: f32 = 2048.0;

/// 对象相机 RT 尺寸：每个轴 = `|size * scale|`，并 clamp 到 `[1, OBJECT_RT_MAX]`。
/// 纯 native 尺寸数学（不依赖 NDC 渲染坐标），供对象级效果链确定效果 RT 宽高。
pub fn object_camera_range(size: [f32; 2], scale: [f32; 2]) -> [f32; 2] {
    [
        (size[0] * scale[0]).abs().clamp(1.0, OBJECT_RT_MAX),
        (size[1] * scale[1]).abs().clamp(1.0, OBJECT_RT_MAX),
    ]
}

/// uv 窗口映射：由「未钳制尺寸」与「钳制后尺寸」推导采样窗口 `(start, end)`。
/// 若 `unclamped <= 0` 或该轴未被钳制（`clamped >= unclamped`）→ 全窗 `(0, 1)`；
/// 否则在未钳制尺寸内居中开窗（start = (unclamped-clamped)/2/unclamped，end = 1-start）。
pub fn uv_window(unclamped: f32, clamped: f32) -> (f32, f32) {
    if unclamped <= 0.0 || clamped >= unclamped {
        return (0.0, 1.0);
    }
    let start = (unclamped - clamped) / 2.0 / unclamped;
    (start, 1.0 - start)
}

// =====================================================================
// Task6/M4：particle 对象效果链的 RT 尺寸与合成 quad 世界尺寸（native 纯函数，非 render 门控）
// =====================================================================

/// 粒子发射距离有效值：无/非正 `distance_max` → 默认 64。是粒子局部相机范围与合成 quad
/// 世界尺寸的共同基准，保证「钳制只发生在 RT 范围、quad 世界尺寸始终未钳制」两处一致。
/// 对齐 JS `effectiveParticleDistance`（scene-renderer.ts）。
pub fn particle_effective_distance(distance_max: Option<f32>) -> f32 {
    distance_max.filter(|d| *d > 0.0).unwrap_or(64.0)
}

/// particle 对象 RT 单轴尺寸（M4/Task6）：粒子动态发射（无静态 size 字段）用发射器世界
/// 包围盒估计 `|distance_max × scale|` 逐轴钳制 `[1, OBJECT_RT_MAX]`（与 `object_camera_range`
/// 同语义）。对齐 JS `particleObjectRange` = `effectiveParticleDistance` + 幅值钳制。
pub fn particle_object_range(distance_max: Option<f32>, scale: [f32; 2]) -> [f32; 2] {
    object_camera_range([particle_effective_distance(distance_max); 2], scale)
}

/// particle 对象合成 quad 世界尺寸（M4/Task6）：**未钳制** `distance_max × scale`（带符号，
/// 负 scale 的粒子布局由 RT 内容/quad 半宽承担——与 image 对象「未钳制 size×scale」语义一致）。
/// 钳制只发生在 `particle_object_range`（RT 范围），quad 世界尺寸始终未钳制，钳制轴由合成
/// quad 的 UV 窗口只采样可见段。对齐 JS `particleWorldSize`。
pub fn particle_world_size(distance_max: Option<f32>, scale: [f32; 2]) -> [f32; 2] {
    let d = particle_effective_distance(distance_max);
    [d * scale[0], d * scale[1]]
}

// =====================================================================
// Task5：对象合成 quad 的 NDC/UV 窗口 uniform（native 纯函数，非 render 门控）
// =====================================================================

/// 对象合成 quad 的 CPU 侧 uniform（`wasm/src/shaders/composite.wgsl` 的
/// CompositeUniform，32 字节 = 8×f32）。NDC 中心/半宽决定 quad 在 surface 上的
/// 位置与大小；UV 窗口（每轴 start/end）把采样从 RT [0,1] 展开到窗口外侧
/// （对齐 JS `applyUvWindow`：UV' = (uv - start) / (end - start)）。
/// 布局：4×f32（center/half）+ 4×f32（uv 窗口），WGSL 无额外对齐填充。
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct CompositeUniform {
    pub center_x: f32,
    pub center_y: f32,
    pub half_w: f32,
    pub half_h: f32,
    pub uv_w0: f32,
    pub uv_w1: f32,
    pub uv_h0: f32,
    pub uv_h1: f32,
}

/// 对象合成 quad 的 NDC/UV 窗口 uniform（Task5，CPU 算，native 可测）。
///
/// 对齐 JS 蓝本（scene-renderer.ts `createObjectEntry`/`createCompositeGeometry`）：
/// - quad 帧尺寸 = **未钳制幅值** `|world_size|`（镜像活在对象 RT 内容，quad 只显示
///   帧——task-4.4 报告的「相机范围与 quad 帧用幅值」职责分离）；半宽 NDC =
///   `|world|/view`（`(|world|/2)/(view/2)`）；
/// - 中心用 `coords::image_center_ndc`（对象中心 `(ox-vw/2, oy-vh/2)` 映射，**不翻转 y**）；
/// - UV 窗口 = `uv_window(未钳制|world|, 钳制 rt)`：未钳制轴 → `[0,1]`；钳制轴居中开窗。
///
/// `origin` 为对象中心（WE 坐标，已 applyAlignment 换算中心）；`world_size` 为
/// `size×scale`（合成 quad 内部取幅值）；`rt_size` 为钳制后对象 RT 分辨率（局部相机范围）。
pub fn composite_ndc_uniform(
    origin: [f32; 3],
    world_size: [f32; 2],
    rt_size: [f32; 2],
    scene_w: f32,
    scene_h: f32,
    view_w: f32,
    view_h: f32,
) -> CompositeUniform {
    let w_abs = world_size[0].abs();
    let h_abs = world_size[1].abs();
    let (cx, cy) = crate::coords::image_center_ndc(origin, scene_w, scene_h, view_w, view_h);
    let (uw0, uw1) = uv_window(w_abs, rt_size[0]);
    let (uh0, uh1) = uv_window(h_abs, rt_size[1]);
    CompositeUniform {
        center_x: cx,
        center_y: cy,
        half_w: w_abs / view_w,
        half_h: h_abs / view_h,
        uv_w0: uw0,
        uv_w1: uw1,
        uv_h0: uh0,
        uv_h1: uh1,
    }
}

/// 纹理槽引用（MVP）。`External(u32)` 索引到外部纹理表（由对象级/glsl-to-naga 层解析）。
/// M2 多数效果 pass 只使用 g_Texture0，纹理槽多为 None——MVP 先支持 g_Texture0 + 可选槽。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
pub enum SlotId {
    External(u32),
}

/// 单个 uniform 绑定：`name` + 打包值（vec4/float/矩阵按长度打包为 `Vec<f32>`）。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct UniformBinding {
    pub name: String,
    pub value: Vec<f32>,
}

/// 效果链 pass 描述（编译输入）。binding 编号由 texture_slots + uniforms 的静态顺序决定
/// （JS 侧 glsl-to-naga 已分配 `layout(binding=N)`；wasm 按同一顺序整理 bind group layout）。
///
/// `shader` 来源二选一（task-8 裁决：真实 WE shader 走 spv，演示/simple 走 glsl）：
/// - `vert_spv`/`frag_spv`：真实 WE 效果 shader 的 SPIR-V bytes（`spv_to_wgsl` 编译，entry_point `main`）。
/// - `vert_glsl`/`frag_glsl`：演示/简单路径的 desktop GLSL（`glsl_to_wgsl` 编译，entry_point `main`）。
///   `vert_spv`/`frag_spv` 非空时优先 spv 路径；否则回退 glsl（兼容 task5 演示 pass）。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct EffectPassDesc {
    #[serde(default)]
    pub vert_spv: Vec<u8>,
    #[serde(default)]
    pub frag_spv: Vec<u8>,
    #[serde(default)]
    pub vert_glsl: String,
    #[serde(default)]
    pub frag_glsl: String,
    #[serde(default)]
    pub uniforms: Vec<UniformBinding>,
    #[serde(default)]
    pub texture_slots: Vec<Option<SlotId>>,
    #[serde(default)]
    pub blend_mode: BlendMode,
}

/// blendMode 字符串别名（EffectPassDesc 字段类型）。
pub type BlendMode = String;

// =====================================================================
// render 门控（仅 wasm 构建；EffectChain 管线/RT/bind group/uniform）
// =====================================================================

#[cfg(feature = "render")]
mod imp {
    use super::*;

    /// naga 编译出的 WGSL 里，某个绑定资源的类型。
    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
    enum BindingKind {
        Uniform,
        Texture,
        Sampler,
    }

    /// 按 pass 来源编译 vert/frag 为 WGSL：真实 WE 效果 shader（`vert_spv` 非空）走
    /// `spv_to_wgsl`（SPIR-V→transform→spv-in→WGSL），演示/simple（`vert_spv` 空、`vert_glsl`
    /// 有值）走 `glsl_to_wgsl`。二者产出 WGSL 的 entry_point 均为 `main`（naga glsl-in /
    /// spv-in 默认入口；手写 WGSL 的 vs_main/fs_main 的是 effect_passthrough/composite 层）。
    ///
    /// **gating 一致性（reviewer Minor #3）**：`vert_spv`/`frag_spv` 必须同空或同非空（畸形 desc
    /// 一空一非空 → 直接 `Err`，交由调用方链级跳过/兜底，绝不走到错误的编译路径）。
    fn compile_pass_wgsl(desc: &EffectPassDesc) -> Result<(String, String), String> {
        if desc.vert_spv.is_empty() != desc.frag_spv.is_empty() {
            return Err(
                "EffectPassDesc vert_spv/frag_spv 不一致（一空一非空，应为同空/同非空）".into(),
            );
        }
        if !desc.vert_spv.is_empty() {
            Ok((
                spv_to_wgsl(&desc.vert_spv, Stage::Vertex)?,
                spv_to_wgsl(&desc.frag_spv, Stage::Fragment)?,
            ))
        } else {
            Ok((
                glsl_to_wgsl(&desc.vert_glsl, Stage::Vertex)?,
                glsl_to_wgsl(&desc.frag_glsl, Stage::Fragment)?,
            ))
        }
    }

    /// 扫描 vert+frag 两个 WGSL，收集 `@group(0) @binding(N)` 声明与资源类型。
    /// 用于**按 shader 实际声明**构建 bind group layout（保证 layout 与 shader 一致，绝不因
    /// 未使用的绑定导致管线校验失败）。排序 + 去重以便后续按 binding 编号生成 entries。
    fn collect_bindings(wgsl_vert: &str, wgsl_frag: &str) -> Vec<(u32, BindingKind)> {
        let mut out: Vec<(u32, BindingKind)> = Vec::new();
        for src in [wgsl_vert, wgsl_frag] {
            let mut from = 0usize;
            while let Some(rel) = src[from..].find("@group(0) @binding(") {
                let start = from + rel;
                let after = start + "@group(0) @binding(".len();
                let num_end = match src[after..].find(')') {
                    Some(i) => after + i,
                    None => break,
                };
                let n: u32 = src[after..num_end].trim().parse().unwrap_or(0);
                // 该绑定声明的 `var` 类型：向后看一小段（naga 在 @binding 后换行补 `var<...>`）。
                let seg = &src[num_end..(num_end + 300).min(src.len())];
                let kind = if seg.contains("var<uniform>") {
                    Some(BindingKind::Uniform)
                } else if seg.contains("texture_") {
                    Some(BindingKind::Texture)
                } else if seg.contains(": sampler") {
                    Some(BindingKind::Sampler)
                } else {
                    None // 无法归类的声明不加入 layout（避免类型错配导致管线校验失败）
                };
                if let Some(k) = kind {
                    out.push((n, k));
                }
                from = num_end;
            }
        }
        out.sort();
        out.dedup();
        out
    }

    /// 由 pass 描述构建 bind group layout（顶点/片元统一可见性，覆盖实际使用阶段，且允许
    /// 过宽可见性避免「Visibility flags don't include the shader stage」错误）。
    fn build_bind_group_layout(
        device: &wgpu::Device,
        wgsl_vert: &str,
        wgsl_frag: &str,
        label: &str,
    ) -> wgpu::BindGroupLayout {
        let bindings = collect_bindings(wgsl_vert, wgsl_frag);
        let entries: Vec<wgpu::BindGroupLayoutEntry> = bindings
            .iter()
            .map(|(binding, kind)| wgpu::BindGroupLayoutEntry {
                binding: *binding,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: match kind {
                    BindingKind::Uniform => wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    BindingKind::Texture => wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    BindingKind::Sampler => wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                },
                count: None,
            })
            .collect();
        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some(label),
            entries: &entries,
        })
    }

    /// 单个 pass 的 GPU 资源（管线 + layout + uniform buffer + 绑定编号）。
    #[derive(Debug)]
    pub(super) struct EffectPassInstance {
        pub pipeline: wgpu::RenderPipeline,
        pub bind_group_layout: wgpu::BindGroupLayout,
        /// g_Time + 静态值 uniform buffer（每帧写 g_Time）。MVP：绑定到 shader 的第一个 uniform bind。
        pub uniform_buffer: wgpu::Buffer,
        /// shader 声明的第一个 uniform 绑定编号（None = 无 uniform，不绑定）。
        pub uniform_binding: Option<u32>,
        /// 静态 uniform 值（不含 g_Time，g_Time 由执行器每帧写入偏移 0）。
        pub static_uniforms: Vec<f32>,
        /// shader 声明的第一个纹理绑定（g_Texture0 语义）→ 绑定当前输入 view。
        pub input_texture_binding: Option<u32>,
        /// shader 声明的 sampler 绑定 → 绑定共享 sampler。
        pub sampler_binding: Option<u32>,
    }

    /// 效果链 ping-pong 执行器（M2）：一组 WE 后处理 pass 依次在两张 ping-pong RT 上执行。
    #[derive(Debug)]
    pub struct EffectChain {
        device: wgpu::Device,
        queue: wgpu::Queue,
        passes: Vec<EffectPassInstance>,
        rt_a_view: wgpu::TextureView,
        rt_b_view: wgpu::TextureView,
        sampler: wgpu::Sampler,
        quad_vb: wgpu::Buffer,
    }

    impl EffectChain {
        /// 一次性（非每帧）编译每个 pass 的 WGSL + 建管线 + 建 bind group layout + uniform buffer，
        /// 建 ping-pong RT（尺寸 = target 宽高）与全屏 quad 顶点缓冲。
        ///
        /// `format`/`width`/`height` 由调用方传入（渲染目标格式/尺寸，与 surface/输入一致）。
        /// 任一 pass 的 GLSL 编译失败或 wgpu 校验失败 → 返回 `Err`，调用方跳过整条链（绝不白屏）。
        pub async fn new(
            device: &wgpu::Device,
            queue: &wgpu::Queue,
            passes: Vec<EffectPassDesc>,
            format: wgpu::TextureFormat,
            width: u32,
            height: u32,
        ) -> Result<EffectChain, String> {
            // Phase 1：纯 Rust 编译（先于 error scope——GLSL 编译失败即整体 Err，**不会**留下
            // 未闭合的 error scope）。naga 编译失败不应污染 wgpu 状态。
            let mut compiled: Vec<(String, String)> = Vec::with_capacity(passes.len());
            for (i, desc) in passes.iter().enumerate() {
                let (wgsl_vert, wgsl_frag) =
                    compile_pass_wgsl(desc).map_err(|e| format!("pass {i} 编译失败：{e}"))?;
                compiled.push((wgsl_vert, wgsl_frag));
            }
            // Phase 2：wgpu 资源创建（error scope 内，收敛 create_* 的异步校验错误）。
            device.push_error_scope(wgpu::ErrorFilter::Validation);
            let mut instances: Vec<EffectPassInstance> = Vec::with_capacity(passes.len());
            for (i, (desc, (wgsl_vert, wgsl_frag))) in passes.iter().zip(compiled).enumerate() {
                let label = format!("effect-chain-pass-{i}");
                // ① 分别编译出的 vert/frag WGSL → 各建一个 shader module（controller 裁决 #1）
                let vert_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some(&format!("{label}-vert")),
                    source: wgpu::ShaderSource::Wgsl(wgsl_vert.as_str().into()),
                });
                let frag_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some(&format!("{label}-frag")),
                    source: wgpu::ShaderSource::Wgsl(wgsl_frag.as_str().into()),
                });
                // ② bind group layout（按 shader 实际声明构建，保证一致）
                let bind_group_layout = build_bind_group_layout(device, &wgsl_vert, &wgsl_frag, &format!("{label}-bgl"));
                let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some(&format!("{label}-pl")),
                    bind_group_layouts: &[&bind_group_layout],
                    push_constant_ranges: &[],
                });
                // ③ 顶点缓冲布局：全屏 quad（pos.xy + uv.xy），A_Position/a_TexCoord 属性
                let vb_layout = wgpu::VertexBufferLayout {
                    array_stride: 16,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x2, offset: 0, shader_location: 0 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x2, offset: 8, shader_location: 1 },
                    ],
                };
                // ④ render pipeline（分离 vert/frag module）
                let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some(&format!("{label}-pipeline")),
                    layout: Some(&pipeline_layout),
                    vertex: wgpu::VertexState {
                        module: &vert_module,
                        entry_point: Some("main"),
                        compilation_options: wgpu::PipelineCompilationOptions::default(),
                        buffers: &[vb_layout],
                    },
                    primitive: wgpu::PrimitiveState {
                        topology: wgpu::PrimitiveTopology::TriangleStrip,
                        ..Default::default()
                    },
                    depth_stencil: None,
                    multisample: wgpu::MultisampleState::default(),
                    fragment: Some(wgpu::FragmentState {
                        module: &frag_module,
                        entry_point: Some("main"),
                        compilation_options: wgpu::PipelineCompilationOptions::default(),
                        targets: &[Some(wgpu::ColorTargetState {
                            format,
                            blend: Some(blend_key_to_wgpu(blend_mode_key(&desc.blend_mode))),
                            write_mask: wgpu::ColorWrites::ALL,
                        })],
                    }),
                    multiview: None,
                    cache: None,
                });
                // ⑤ uniform buffer：g_Time（偏移 0）+ 静态值打包，长度对齐 4 f32（16 字节）。
                let bindings = collect_bindings(&wgsl_vert, &wgsl_frag);
                let uniform_binding = bindings
                    .iter()
                    .find(|(_, k)| *k == BindingKind::Uniform)
                    .map(|(b, _)| *b);
                let mut static_uniforms: Vec<f32> = Vec::new();
                for u in &desc.uniforms {
                    static_uniforms.extend_from_slice(&u.value);
                }
                let mut data: Vec<f32> = Vec::with_capacity(1 + static_uniforms.len() + 3);
                data.push(0.0); // g_Time 槽（offset 0）
                data.extend_from_slice(&static_uniforms);
                while data.len() % 4 != 0 {
                    data.push(0.0);
                }
                let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(&format!("{label}-uniform")),
                    size: (data.len() * 4) as u64,
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
                queue.write_buffer(&uniform_buffer, 0, bytemuck::cast_slice(&data));
                let input_texture_binding = bindings.iter().find(|(_, k)| *k == BindingKind::Texture).map(|(b, _)| *b);
                let sampler_binding = bindings.iter().find(|(_, k)| *k == BindingKind::Sampler).map(|(b, _)| *b);
                instances.push(EffectPassInstance {
                    pipeline,
                    bind_group_layout,
                    uniform_buffer,
                    uniform_binding,
                    static_uniforms,
                    input_texture_binding,
                    sampler_binding,
                });
            }
            // ⑥ ping-pong RT（RENDER_ATTACHMENT | TEXTURE_BINDING）+ 采样器 + 全屏 quad 顶点缓冲
            let rt_a = create_rt(device, width.max(1), height.max(1), format, "effect-rt-a");
            let rt_b = create_rt(device, width.max(1), height.max(1), format, "effect-rt-b");
            let rt_a_view = rt_a.create_view(&wgpu::TextureViewDescriptor::default());
            let rt_b_view = rt_b.create_view(&wgpu::TextureViewDescriptor::default());
            let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("effect-sampler"),
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            });
            let quad_vb = create_quad_vb(device, queue);
            // ⑦ 收取 error scope：任一 wgpu 校验错误 → 整体失败（调用方跳过，不黑屏）。
            if let Some(err) = device.pop_error_scope().await {
                return Err(format!("EffectChain 资源创建校验失败：{err:?}"));
            }
            Ok(EffectChain {
                device: device.clone(),
                queue: queue.clone(),
                passes: instances,
                rt_a_view,
                rt_b_view,
                sampler,
                quad_vb,
            })
        }

        /// 逐 pass ping-pong 执行效果链。
        /// 首 pass 输入 = `input_view`；逐 pass 输出写到对端 RT（末 pass 直接写 `output_view`，
        /// 避免 surface 无法 COPY_DST 的 blit 依赖）；read=write.texture 作为下 pass 输入。
        /// 每 pass 绑定 `g_Texture0`（当前读视图）+ 纹理槽 + uniform（g_Time 每帧 host 更新）。
        /// 不 panic；pass 数 0 → no-op。
        ///
        /// **性能约束（一次性构建）**：本方法**不做** naga 编译 / shader module / render pipeline
        /// 创建——它们的构建与对象 RT / ping-pong RT / uniform buffer 均在 `new`（壁纸/对象加载时）
        /// 一次性完成。每帧仅：① 写 uniform buffer（g_Time 经 host 更新）；② 按当前输入 view
        /// 建 bind group；③ 提交 render pass。无每帧 shader 编译，理论上帧内零编译开销。
        pub fn render(
            &mut self,
            encoder: &mut wgpu::CommandEncoder,
            input_view: &wgpu::TextureView,
            output_view: &wgpu::TextureView,
            time: f32,
        ) {
            let n = self.passes.len();
            if n == 0 {
                return;
            }
            let mut read_view: &wgpu::TextureView = input_view;
            let mut prev_write: Option<u8> = None;
            for i in 0..n {
                let last = i == n - 1;
                // 写端：末 pass 写 output_view；否则 ping-pong 写对端 RT。
                let write_view: &wgpu::TextureView = if last {
                    output_view
                } else {
                    let idx = pick_write_target(prev_write);
                    prev_write = Some(idx);
                    if idx == 0 { &self.rt_a_view } else { &self.rt_b_view }
                };
                // 更新 g_Time（offset 0），静态值跟随。字段级借用（disjoint）：对
                // self.passes[i] 与 self.queue 的不可变借用互不重叠，编译器允许。
                let static_uniforms = &self.passes[i].static_uniforms;
                let uniform_buf = &self.passes[i].uniform_buffer;
                let mut data: Vec<f32> = Vec::with_capacity(1 + static_uniforms.len() + 3);
                data.push(time);
                data.extend_from_slice(static_uniforms);
                while data.len() % 4 != 0 {
                    data.push(0.0);
                }
                self.queue.write_buffer(uniform_buf, 0, bytemuck::cast_slice(&data));
                // bind group（按 shader 声明的绑定布置资源）
                let bind_group = self.build_bind_group(i, read_view);
                let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("effect-chain-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: write_view,
                        resolve_target: None,
                        ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
                rpass.set_pipeline(&self.passes[i].pipeline);
                rpass.set_vertex_buffer(0, self.quad_vb.slice(..));
                rpass.set_bind_group(0, &bind_group, &[]);
                rpass.draw(0..4, 0..1);
                drop(rpass);
                if !last {
                    read_view = write_view;
                }
            }
        }

        /// 按 shader 声明的绑定构建 bind group：uniform buffer + 输入纹理(g_Texture0) + sampler。
        fn build_bind_group(&self, pass_index: usize, read_view: &wgpu::TextureView) -> wgpu::BindGroup {
            let pass = &self.passes[pass_index];
            let mut entries: Vec<wgpu::BindGroupEntry> = Vec::new();
            if let Some(b) = pass.uniform_binding {
                entries.push(wgpu::BindGroupEntry {
                    binding: b,
                    resource: pass.uniform_buffer.as_entire_binding(),
                });
            }
            if let Some(b) = pass.input_texture_binding {
                entries.push(wgpu::BindGroupEntry {
                    binding: b,
                    resource: wgpu::BindingResource::TextureView(read_view),
                });
            }
            if let Some(b) = pass.sampler_binding {
                entries.push(wgpu::BindGroupEntry {
                    binding: b,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                });
            }
            self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("effect-chain-bg"),
                layout: &pass.bind_group_layout,
                entries: &entries,
            })
        }
    }

    /// 建一张 ping-pong 离屏 RT（RENDER_ATTACHMENT | TEXTURE_BINDING）。
    fn create_rt(
        device: &wgpu::Device,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
        label: &str,
    ) -> wgpu::Texture {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
    }

    /// 全屏 quad 顶点缓冲（triangle-strip，4 顶点；pos.xy NDC + uv.xy）。a_Position/a_TexCoord。
    const QUAD: [f32; 16] = [
        -1.0, -1.0, 0.0, 0.0,
         1.0, -1.0, 1.0, 0.0,
        -1.0,  1.0, 0.0, 1.0,
         1.0,  1.0, 1.0, 1.0,
    ];

    fn create_quad_vb(device: &wgpu::Device, queue: &wgpu::Queue) -> wgpu::Buffer {
        let vb = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("effect-quad-vb"),
            size: (QUAD.len() * 4) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&vb, 0, bytemuck::cast_slice(&QUAD));
        vb
    }
}

/// WE 材质 blending → wgpu BlendState（controller 裁决 #2：从 `BlendKey` 映射，DRY）。
#[cfg(feature = "render")]
pub fn blend_key_to_wgpu(key: BlendKey) -> wgpu::BlendState {
    let color = match key {
        BlendKey::Normal => wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::SrcAlpha,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Add,
        },
        BlendKey::Add => wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::SrcAlpha,
            dst_factor: wgpu::BlendFactor::One,
            operation: wgpu::BlendOperation::Add,
        },
        BlendKey::Multiply => wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::Dst,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Add,
        },
        BlendKey::Subtract => wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::SrcAlpha,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Subtract,
        },
    };
    let alpha = match key {
        BlendKey::Normal => wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::One,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Add,
        },
        BlendKey::Add => wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::SrcAlpha,
            dst_factor: wgpu::BlendFactor::One,
            operation: wgpu::BlendOperation::Add,
        },
        BlendKey::Multiply => wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::Zero,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Add,
        },
        BlendKey::Subtract => wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::Zero,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Subtract,
        },
    };
    wgpu::BlendState { color, alpha }
}

/// 重新导出 EffectChain（供 `mod.rs` 使用）。
#[cfg(feature = "render")]
pub use imp::EffectChain;
