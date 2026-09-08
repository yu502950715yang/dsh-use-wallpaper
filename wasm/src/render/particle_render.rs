//! CPU 模拟粒子（`particle::sim::SceneParticleSim`，Task 2 产出 `Vec<[f32;10]>` 顶点）
//! 的 **GPU billboard 渲染**（Task 3）。
//!
//! 职责边界（与 `particle_pass.rs` 的 GPU compute 路径互补）：
//! - `particle_pass::ParticlePass`：**全 GPU**（compute 模拟 + 每帧 dispatch）。本模块不做。
//! - 本模块 `ParticleRenderPass`：CPU 已把粒子模拟成**逐粒子** billboard 顶点
//!   `[pos3, size, uv2, color3, alpha]`（10 个 f32），本 pass 只负责用 wgpu 把它们画出来。
//!   顶点来源是 CPU 缓冲（`SceneParticleSim::build_vertices`），每帧由调用方传入 `vertices`。
//!
//! 顶点布局：`[f32;10]`（stride 40B）→ 5 个 location（0:pos3, 1:size, 2:uv2, 3:color3, 4:alpha），
//! 与 `particle_billboard.wgsl` 的 `VsIn` 逐字段对齐，**无隐式填充**（vec3 在顶点缓冲按 pack 排布）。
//!
//! 结构决策（native 测试可达性）：`BlendMode` / `ParticleRenderUniform` / `PARTICLE_VERTEX_STRIDE`
//! 为纯数据（不依赖 wgpu），放在非门控区；`ParticleRenderPass`（wgpu 管线）位于
//! `#[cfg(feature = "render")]` 门控区，仅 wasm 构建编译（native `cargo test` 只测解析/布局）。

/// 粒子 quad 的混合模式（按入参选择，不硬编码）。
/// - `Additive`：SrcAlpha/One（辉光/尘土叠加，对齐 Three.js AdditiveBlending）。
/// - `Translucent`：SrcAlpha/OneMinusSrcAlpha（普通透明叠加，对齐透明边缘露出背景）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlendMode {
    Additive,
    Translucent,
}

/// 投影 uniform（`view_w`, `view_h`）——NDC 半视口像素尺寸（cover 相机，如 3840/1906）。
/// 对齐 `particle_billboard.wgsl` 的 `struct P { view_w: f32, view_h: f32 }`。
/// Rust `repr(C)` 尺寸 8B；wgpu/WGSL uniform binding 的 shader 可见尺寸为 8B，
/// 但为规避各后端对 uniform struct 按 align16 上取整的差异，这里**补到 16B**
/// （buffer ≥ shader binding size 恒成立）。尾两槽 pad 不参与 shader 读取。
#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct ParticleRenderUniform {
    pub view_w: f32,
    pub view_h: f32,
    pub _pad0: f32,
    pub _pad1: f32,
}

/// 每粒子顶点字节数 = 10 个 f32 × 4 = 40。
pub const PARTICLE_VERTEX_STRIDE: u64 = 40;

/// 初始顶点缓冲容量（4 粒子）。`draw` 会按需扩容。仅 render feature 使用（native 无 wgpu）。
#[cfg(feature = "render")]
const INITIAL_VERTEX_BYTES: u64 = 4 * PARTICLE_VERTEX_STRIDE;

/// `[f32;10]`（pos3+size+uv2+color3+alpha）的 wgpu 顶点属性表（5 个 location），
/// 与 `particle_billboard.wgsl` 的 `VsIn` 逐字段对齐。`static` 保证 `'static` 生命周期，
/// 供管线创建时 `attributes: &VERTEX_ATTRIBUTES` 直接引用（无临时借用）。
#[cfg(feature = "render")]
static VERTEX_ATTRIBUTES: [wgpu::VertexAttribute; 5] = [
    wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 0, shader_location: 0 },
    wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32, offset: 12, shader_location: 1 },
    wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x2, offset: 16, shader_location: 2 },
    wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 24, shader_location: 3 },
    wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32, offset: 36, shader_location: 4 },
];

#[cfg(feature = "render")]
pub struct ParticleRenderPass {
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    vertex_buffer: wgpu::Buffer,
    uniform_buffer: wgpu::Buffer,
    /// 粒子纹理持有方（2026-08-21 方案 A，同 ParticlePass）：bind group 引用 texture view，
    /// view 引用 texture——texture 必须存活，故由 pass 持有防释放；无纹理时为 1×1 白兜底。
    /// `_texture` 前缀下划线避免 unused 告警（仅用于延长 texture 生命周期）。
    _texture: wgpu::Texture,
}

#[cfg(feature = "render")]
impl ParticleRenderPass {
    /// 构建 billboard 渲染管线与全部 GPU 资源。
    /// `format` 为渲染目标格式（须与最终绘制 target 一致，如 surface/对象 RT 格式）。
    /// `tex` 为粒子纹理（Task 2 无纹理时 `None` → 1×1 白兜底，texel=(1,1,1,1) 纯色 quad）。
    /// `view_w`/`view_h` 为 cover 相机半视口（如 3840/1906），写入 uniform buffer。
    /// `blend` 决定混合模式（Additive / Translucent）。
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        tex: Option<wgpu::Texture>,
        view_w: f32,
        view_h: f32,
        blend: BlendMode,
    ) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("particle_billboard.wgsl"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/particle_billboard.wgsl").into()),
        });
        // bind group layout：binding 0 = uniform（view_w/view_h，vertex 读），
        // binding 1 = texture_2d，binding 2 = sampler（fragment 采样）。
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("particle-billboard-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("particle-billboard-pl"),
            bind_group_layouts: &[&bgl],
            push_constant_ranges: &[],
        });
        // 混合模式按入参（Additive/Translucent），不硬编码。
        let blend_state = match blend {
            BlendMode::Additive => wgpu::BlendState {
                color: wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::SrcAlpha,
                    dst_factor: wgpu::BlendFactor::One,
                    operation: wgpu::BlendOperation::Add,
                },
                alpha: wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::SrcAlpha,
                    dst_factor: wgpu::BlendFactor::One,
                    operation: wgpu::BlendOperation::Add,
                },
            },
            BlendMode::Translucent => wgpu::BlendState {
                color: wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::SrcAlpha,
                    dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                    operation: wgpu::BlendOperation::Add,
                },
                alpha: wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::One,
                    dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                    operation: wgpu::BlendOperation::Add,
                },
            },
        };
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("particle-billboard-render"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: PARTICLE_VERTEX_STRIDE,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &VERTEX_ATTRIBUTES,
                }],
            },
            primitive: wgpu::PrimitiveState {
                // billboard quad：vs 用 vertex_index 推导角点（TriangleStrip，同粒子渲染模式）
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(blend_state),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview: None,
            cache: None,
        });
        // uniform buffer：view_w/view_h（写入一次，pass 内不变）。
        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("particle-billboard-uniform"),
            size: std::mem::size_of::<ParticleRenderUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&uniform_buffer, 0, bytemuck::bytes_of(&ParticleRenderUniform {
            view_w, view_h, _pad0: 0.0, _pad1: 0.0,
        }));
        // 粒子纹理：有 → 使用；无 → 1×1 白兜底（texel=(1,1,1,1) → 纯色 quad）。
        let (texture_holder, texture_view) = if let Some(t) = tex {
            let view = t.create_view(&wgpu::TextureViewDescriptor::default());
            (t, view)
        } else {
            let t = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("particle-billboard-white"),
                size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture: &t, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                &[255u8, 255, 255, 255],
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4), rows_per_image: Some(1) },
                wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            );
            let view = t.create_view(&wgpu::TextureViewDescriptor::default());
            (t, view)
        };
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("particle-billboard-sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("particle-billboard-bg"),
            layout: &bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&texture_view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&sampler) },
            ],
        });
        // 初始顶点缓冲（`draw` 按需扩容）。
        let vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("particle-billboard-vertex"),
            size: INITIAL_VERTEX_BYTES,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        ParticleRenderPass {
            pipeline,
            bind_group,
            vertex_buffer,
            uniform_buffer,
            _texture: texture_holder,
        }
    }

    /// 把 `vertices`（逐粒子 `[f32;10]`，来自 `SceneParticleSim::build_vertices`）写入顶点缓冲，
    /// 并以 billboard quad（TriangleStrip）渲染到 `out` 视图。Load 不清除：粒子按混合模式
    /// 叠加在 `out` 既有内容上（Additive 辉光尘土 / Translucent 透明）。
    pub fn draw(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        vertices: &[[f32; 10]],
        out: &wgpu::TextureView,
    ) {
        // 顶点数量超出当前缓冲 → 重新分配（wgpu buffer 创建后大小不可变）。
        let required = (vertices.len() as u64) * PARTICLE_VERTEX_STRIDE;
        if required > self.vertex_buffer.size() {
            self.vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("particle-billboard-vertex"),
                size: required.max(INITIAL_VERTEX_BYTES),
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
        }
        if !vertices.is_empty() {
            queue.write_buffer(&self.vertex_buffer, 0, bytemuck::cast_slice(vertices));
        }
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("particle-billboard-encoder"),
        });
        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("particle-billboard-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: out,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            rpass.set_pipeline(&self.pipeline);
            rpass.set_bind_group(0, &self.bind_group, &[]);
            rpass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
            let n = vertices.len() as u32;
            if n > 0 {
                rpass.draw(0..n, 0..1);
            }
        }
        queue.submit([encoder.finish()]);
    }
}
