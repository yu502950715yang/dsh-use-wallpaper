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

/// 初始索引缓冲容量（4 粒子，每粒子 6 个 u32 索引）。`draw` 会按需扩容。
#[cfg(feature = "render")]
const INITIAL_INDEX_BYTES: u64 = 4 * INDICES_PER_PARTICLE as u64 * std::mem::size_of::<u32>() as u64;

/// 每粒子 billboard quad 的顶点数（4 个角点：一个 quad 需要 4 个不同角点）。
/// `draw` 内通过 `expand_to_quad_vertices` 把每个粒子 `[f32;10]` 重复 4 次写入顶点缓冲，
/// shader 再用 `@builtin(vertex_index)` 推角点（每 4 个连续顶点 = 同一粒子一个 quad 的 4 个角点）。
pub const VERTICES_PER_PARTICLE: u32 = 4;

/// 每粒子 billboard quad 的**索引数**（TriangleList 的 2 个三角形 × 3 索引 = 6）。
/// 见 `build_quad_indices` 的注释：为什么必须用索引 + TriangleList 把每个 quad 拆成 2 个
/// 独立三角形，而不能用一根 `TriangleStrip` 直接 `draw(0..4N)`（那是线框/长条的根因）。
pub const INDICES_PER_PARTICLE: u32 = 6;

/// 把逐粒子 `[f32;10]` 展开成每粒子 **4 个顶点**（同一粒子属性重复 4 次，供 billboard quad）。
/// native 可测（纯数据，无 wgpu）。空输入 → 空输出（防御，draw 直接跳过绘制）。
pub fn expand_to_quad_vertices(vertices: &[[f32; 10]]) -> Vec<[f32; 10]> {
    let mut out = Vec::with_capacity(vertices.len() * VERTICES_PER_PARTICLE as usize);
    for v in vertices {
        out.extend(std::iter::repeat(*v).take(VERTICES_PER_PARTICLE as usize));
    }
    out
}

/// 为 `particle_count` 个粒子生成 billboard quad 的 TriangleList 索引。
///
/// **为什么需要它（根因）**：若用 `TriangleStrip` 直接 `draw(0..4N)`，一根 strip 会从粒子 0 的
/// quad **连续**连到粒子 1 的 quad——三角带按 `(v0,v1,v2),(v1,v2,v3),(v2,v3,v4),…` 排布，
/// 相邻 quad 之间会生成横跨两粒子的"桥接"三角（例如 `(v2,v3,v4)` 同时用了粒子 0 与粒子 1 的角点），
/// 这些又长又细的三角横跨整个画面，视觉上就是"粉色线框/三角网格"，而非隔离的填充贴图 quad。
/// 修复：改用 `TriangleList` + 索引缓冲，每个 quad 明确列出它的 2 个三角形
/// `[b, b+1, b+2, b+1, b+2, b+3]`（b = 粒子在顶点缓冲中的基址 `i*4`）。`TriangleList` 没有
/// "跨三角形连续"的语义，每 3 个索引就是独立三角形，相邻 quad 绝不桥接。
///
/// 角点一致性：shader 的 `vertex_index`（这里取的是顶点缓冲索引，非索引缓冲下标）经
/// `vi&1`、`(vi>>1)&1` 推角点，四角依序为 `(-1,-1),(1,-1),(-1,1),(1,1)`。上面两个三角形
/// 恰好铺满 `[-1,1]²`（左下 + 右上，仅共享对角线，面积不重叠）。基址 b 恒为 4 的倍数，
/// 位运算对所有粒子一致成立。
pub fn build_quad_indices(particle_count: usize) -> Vec<u32> {
    let mut out = Vec::with_capacity(particle_count * INDICES_PER_PARTICLE as usize);
    for i in 0..particle_count {
        let b = (i as u32) * VERTICES_PER_PARTICLE;
        out.extend_from_slice(&[b, b + 1, b + 2, b + 1, b + 2, b + 3]);
    }
    out
}

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
    index_buffer: wgpu::Buffer,
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
                // billboard quad 隔离：TriangleList + 索引缓冲（每粒子 2 个独立三角形）。
                // 不能用 TriangleStrip 直接 draw(0..4N)——一根 strip 会把相邻粒子 quad 连成
                // 横跨画面的"桥接"三角（线框/三角网格的根因，见 `build_quad_indices` 注释）。
                // vs 仍用 vertex_index 推导角点；索引缓冲显式列出两个三角形（顶点缓冲基址=4 的倍数，
                // 位运算对每个粒子一致）。
                topology: wgpu::PrimitiveTopology::TriangleList,
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
        // 初始索引缓冲（TriangleList，`draw` 按需扩容）。
        let index_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("particle-billboard-index"),
            size: INITIAL_INDEX_BYTES,
            usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        ParticleRenderPass {
            pipeline,
            bind_group,
            vertex_buffer,
            index_buffer,
            uniform_buffer,
            _texture: texture_holder,
        }
    }

    /// 把 `vertices`（逐粒子 `[f32;10]`，来自 `SceneParticleSim::build_vertices`）**展开成每粒子
    /// 4 顶点**写入顶点缓冲（同一粒子属性重复 4 次），并以 billboard quad（TriangleList + 索引缓冲，
    /// 每粒子 2 个隔离三角形）渲染到 `out` 视图。shader 用 `@builtin(vertex_index)` 推 quad 角点
    /// （每 4 个连续顶点 = 同一粒子一个 quad；索引缓冲显式指定 quad 的两个三角形，避免
    /// TriangleStrip 把相邻 quad 连成"桥接"三角——线框/三角网格的根因）。Load 不清除：粒子按
    /// 混合模式叠加在 `out` 既有内容上。
    pub fn draw(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        vertices: &[[f32; 10]],
        out: &wgpu::TextureView,
    ) {
        // 展开后的顶点数 = 每粒子 4 个（quads）+ 所需字节数；超出当前缓冲则重新分配。
        let quad_vertex_count = (vertices.len() as u32) * VERTICES_PER_PARTICLE;
        let required = (quad_vertex_count as u64) * PARTICLE_VERTEX_STRIDE;
        if required > self.vertex_buffer.size() {
            self.vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("particle-billboard-vertex"),
                size: required.max(INITIAL_VERTEX_BYTES),
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
        }
        // 索引数 = 每粒子 6 个（2 三角形）；超出当前索引缓冲则重新分配。
        let index_count = (vertices.len() as u32) * INDICES_PER_PARTICLE;
        let required_index_bytes = (index_count as u64) * std::mem::size_of::<u32>() as u64;
        if required_index_bytes > self.index_buffer.size() {
            self.index_buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("particle-billboard-index"),
                size: required_index_bytes.max(INITIAL_INDEX_BYTES),
                usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
        }
        if !vertices.is_empty() {
            // 展开：每粒子重复 4 次（同一粒子 quad 的 4 个角点由 shader 的 vertex_index 推导）。
            let expanded = expand_to_quad_vertices(vertices);
            queue.write_buffer(&self.vertex_buffer, 0, bytemuck::cast_slice(&expanded));
            // 索引：每 quad 显式列出 2 个三角形（TriangleList），隔离相邻粒子 quad。
            let indices = build_quad_indices(vertices.len());
            queue.write_buffer(&self.index_buffer, 0, bytemuck::cast_slice(&indices));
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
            if index_count > 0 {
                rpass.set_index_buffer(self.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                rpass.draw_indexed(0..index_count, 0, 0..1);
            }
        }
        queue.submit([encoder.finish()]);
    }
}
