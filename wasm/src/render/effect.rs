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
//! - vert/frag **分别编译**：每个 pass 分别 `glsl_to_wgsl(vert_glsl, Stage::Vertex)` 与
//!   `glsl_to_wgsl(frag_glsl, Stage::Fragment)` 得两个 WGSL → 各建一个 shader module →
//!   建 render pipeline（`entry_point: Some("vs_main")` / `Some("fs_main")`）。
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

/// 纹理槽引用（MVP）。`External(u32)` 索引到外部纹理表（由对象级/glsl-to-naga 层解析）。
/// M2 多数效果 pass 只使用 g_Texture0，纹理槽多为 None——MVP 先支持 g_Texture0 + 可选槽。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotId {
    External(u32),
}

/// 单个 uniform 绑定：`name` + 打包值（vec4/float/矩阵按长度打包为 `Vec<f32>`）。
#[derive(Debug, Clone)]
pub struct UniformBinding {
    pub name: String,
    pub value: Vec<f32>,
}

/// 效果链 pass 描述（编译输入）。binding 编号由 texture_slots + uniforms 的静态顺序决定
/// （JS 侧 glsl-to-naga 已分配 `layout(binding=N)`；wasm 按同一顺序整理 bind group layout）。
#[derive(Debug, Clone)]
pub struct EffectPassDesc {
    pub vert_glsl: String,
    pub frag_glsl: String,
    pub uniforms: Vec<UniformBinding>,
    pub texture_slots: Vec<Option<SlotId>>,
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
                let wgsl_vert = glsl_to_wgsl(&desc.vert_glsl, Stage::Vertex)
                    .map_err(|e| format!("pass {i} vert 编译失败：{e}"))?;
                let wgsl_frag = glsl_to_wgsl(&desc.frag_glsl, Stage::Fragment)
                    .map_err(|e| format!("pass {i} frag 编译失败：{e}"))?;
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
                        entry_point: Some("vs_main"),
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
                        entry_point: Some("fs_main"),
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
