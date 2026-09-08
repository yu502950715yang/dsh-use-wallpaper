//! CPU 模拟粒子（`particle::sim::SceneParticleSim`，Task 2 产出逐粒子状态）的 **GPU 渲染**
//! （Task 5：对齐 lwe `CParticle::renderSprites` 的 17 浮点顶点流与材质）。
//!
//! 职责边界（与 `particle_pass.rs` 的 GPU compute 路径互补）：
//! - `particle_pass::ParticlePass`：**全 GPU**（compute 模拟 + 每帧 dispatch）。本模块不做。
//! - 本模块 `ParticleRenderPass`：上游已把粒子模拟成 **17 浮点/角点顶点** 流（`sim.build_vertices`），
//!   每粒子 4 角点 + 6 索引（lwe `renderSprites` 的 billboard quad）。本 pass 负责用 wgpu 把它们画出来。
//!
//! 顶点布局（**每角点** 17 个 f32，stride 68B；对齐 lwe `renderSprites`/`fillVertices`）：
//! ```text
//! [0..3)   pos            : 粒子中心（CPU sim 已含对象变换 + 发射点）
//! [3..7)   uv_rot_size    : (uv.x, uv.y, rot.z, size)   // uv 为该角点的 0..1 帧内坐标
//! [7..11)  color          : (r, g, b, alpha)
//! [11..15) vel_lifetime   : (vel.x, vel.y, vel.z, lifetime)  // lifetime 编码粒子帧
//! [15..17) rot_x_y        : (rot.x, rot.y)
//! ```
//! 每粒子 4 角点顺序（lwe `addVertex`）：(0,1) 左下、(1,1) 右下、(1,0) 右上、(0,0) 左上；
//! 索引 `[b, b+1, b+2, b+2, b+3, b+0]`（lwe `renderSprites`，两个三角形铺满 quad）。
//!
//! mvp：`o.clip = mvp × pos`；`mvp = viewProjection × model`，`viewProjection = ortho(view_w, view_h)`
//! （centered，diag(2/view_w, 2/view_h, 1, 1)），model 取单位阵（CPU sim 已将对象变换 + emitter
//! 发射点烘焙进 pos，对齐 lwe 注释）。corner（±1，由 uv 推导 + rot.z 自旋）在**世界空间**加到粒子中心
//! （`pos + corner×size/2`），再经 ortho 到 NDC。
//!
//! 材质（Task 5）：`BlendMode`（Additive=SrcAlpha/One、Translucent=SrcAlpha/OneMinusSrcAlpha）按材质
//! 门控（`from_material`）；`overbright`（材质亮度乘数）乘到 rgb（uniform）。纹理 alpha 遮罩与
//! softness（边缘软化 + 无纹理软圆点兜底）在 `particle_billboard.wgsl` 内处理。
//!
//! 结构决策（native 测试可达性）：`BlendMode` / `ParticleRenderUniform` / 顶点流常量与纯函数
//! （`build_sprite_indices` / `sprite_frame_uv` / `project_pos`）为纯数据，放在非门控区；
//! `ParticleRenderPass`（wgpu 管线）位于 `#[cfg(feature = "render")]` 门控区，仅 wasm 构建编译
//! （native `cargo test` 只测解析/布局/纯函数）。

/// 粒子 quad 的混合模式（按材质门控，不硬编码）。
/// - `Additive`：SrcAlpha/One（辉光/光柱叠加，对齐 lwe overbright 材质与 Three.js AdditiveBlending）。
/// - `Translucent`：SrcAlpha/OneMinusSrcAlpha（普通透明叠加，透明边缘露出背景）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlendMode {
    Additive,
    Translucent,
}

impl BlendMode {
    /// 按材质名推导混合模式（lwe 粒子材质在 wasm 侧无解析源，只能按材质名启发式判断：
    /// lightshaft / glow / additive 为 additive 辉光，其余为 translucent 普通叠加）。
    pub fn from_material(name: Option<&str>) -> BlendMode {
        match name {
            Some(n) if n.contains("lightshaft") || n.contains("glow") || n.contains("additive") => {
                BlendMode::Additive
            }
            _ => BlendMode::Translucent,
        }
    }

    /// 材质 overbright（亮度乘数，lwe 读 material 的 `ui_editor_properties_overbright` 常量）。
    /// wasm 侧无材质源文件，缺省 1.0（不增亮）；Overbright >1 的语义已支持（uniform 乘到 rgb）。
    pub fn overbright(_name: Option<&str>) -> f32 {
        1.0
    }
}

/// 每角点顶点的浮点数量（lwe `SPRITE_FLOATS_PER_VERTEX`）。
pub const SPRITE_FLOATS_PER_VERTEX: u32 = 17;

/// 每粒子顶点字节数 = 17 个 f32 × 4 = 68。
pub const PARTICLE_VERTEX_STRIDE: u64 = 68;

/// 每粒子 billboard quad 的角点数（4 个：一个 quad 需要 4 个不同角点）。
pub const VERTICES_PER_PARTICLE: u32 = 4;

/// 每粒子 billboard quad 的索引数（TriangleList 的 2 个三角形 × 3 索引 = 6）。
pub const INDICES_PER_PARTICLE: u32 = 6;

/// 无纹理（白兜底）时的软圆盘 softness（整盘软 → 圆点）。
pub const SOFTNESS_UNMASKED: f32 = 1.0;

/// 有纹理（真实 alpha 遮罩）的 softness（masked 时 shape=texel.a，softness 不参与；仅保留薄软边余量）。
pub const SOFTNESS_MASKED: f32 = 0.15;

/// 投影 uniform（`view_w`, `view_h` + sprite sheet + 材质）。对齐 `particle_billboard.wgsl` 的
/// `struct P`（8×f32 = 32B）。Rust `repr(C)` 尺寸 32B（16 对齐）；wgpu/WGSL uniform binding
/// 的 shader 可见尺寸需 ≥ 32B（为规避各后端对 uniform struct 按 align16 上取整的差异，这里补到
/// 32B，buffer ≥ shader binding size 恒成立）。
#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct ParticleRenderUniform {
    pub view_w: f32,
    pub view_h: f32,
    /// sprite sheet 总帧数（rosepetals 512×128 → 4；单帧纹理 → 1）。
    pub spritesheet_frames: f32,
    /// sprite sheet 横向格数（横向条带 → frames）。
    pub spritesheet_cols: f32,
    /// sprite sheet 纵向格数（rosepetals → 1）。
    pub spritesheet_rows: f32,
    /// 材质亮度乘数（overbright）。
    pub overbright: f32,
    /// 边缘软化（无纹理兜底 → 1.0 整盘软；有纹理 → 0.15 薄软边）。
    pub softness: f32,
    /// 纹理 alpha 遮罩开关：1 = 真实纹理形状（alpha=texel.a×particle.alpha）；0 = 软圆盘兜底。
    pub mask_mode: f32,
}

/// 由纹理宽高推导 sprite sheet 横向帧数（每帧方形：帧数 = 宽/高；非 sheet → 1）。
pub fn frame_count_from_dims(w: u32, h: u32) -> u32 {
    (w.max(1) / h.max(1)).max(1)
}

/// 帧号 → 粒子 `lifetime` 字段的编码值（lwe `renderSprites`：randomframe → (frame+0.5)/frames，
/// 其余 → frame/frames；shader 用 `floor(frac(lifetime)×frames)` 还原帧号）。frames≤1 → 0（单帧）。
/// native 可测（纯数据）。
pub fn particle_lifetime_encode(frame: f32, frames: u32) -> f32 {
    if frames <= 1 {
        return 0.0;
    }
    let n = frames as f32;
    let idx = frame.floor().clamp(0.0, n - 1.0);
    (idx + 0.5) / n
}

/// 帧切片 UV 的**参考实现**（native 可测；`particle_billboard.wgsl` 的 `vs`/`fs` 按同一公式切片）。
/// 把角点 uv（0..1）映射到 sprite sheet 第 `frame` 帧的子区：`u=(col+u)/cols`、`v=(row+v)/rows`。
/// 单帧（frames≤1）→ 原 `corner`（整张采样）。
pub fn sprite_frame_uv(frame: f32, cols: u32, rows: u32, corner: [f32; 2]) -> [f32; 2] {
    let n = cols * rows;
    if n <= 1 {
        return corner;
    }
    let idx = frame.floor().clamp(0.0, n as f32 - 1.0) as u32;
    let c = (idx % cols.max(1)) as f32;
    let r = (idx / cols.max(1)) as f32;
    let fw = 1.0 / cols.max(1) as f32;
    let fh = 1.0 / rows.max(1) as f32;
    [(c + corner[0]) * fw, (r + corner[1]) * fh]
}

/// 世界坐标 → NDC（mvp：model=I，viewProjection = centered ortho(view_w, view_h)）。
/// 返回 NDC (x, y)（z 恒 0，clip.z=0，对齐 billboard 无深度缓冲）。native 可测。
pub fn project_pos(pos: [f32; 3], view_w: f32, view_h: f32) -> [f32; 2] {
    [2.0 * pos[0] / view_w.max(1.0), 2.0 * pos[1] / view_h.max(1.0)]
}

/// 为 `particle_count` 个粒子生成 billboard quad 的 TriangleList 索引（lwe `renderSprites`）。
/// 每 quad 显式列出 2 个三角形 `[b, b+1, b+2, b+2, b+3, b+0]`（b = 粒子在顶点缓冲中的基址 `i*4`），
/// 铺满 4 角点 quad 且**隔离**相邻粒子（TriangleList 无跨三角形连续语义，绝不桥接）。
pub fn build_sprite_indices(particle_count: usize) -> Vec<u32> {
    let mut out = Vec::with_capacity(particle_count * INDICES_PER_PARTICLE as usize);
    for i in 0..particle_count {
        let b = (i as u32) * VERTICES_PER_PARTICLE;
        out.extend_from_slice(&[b, b + 1, b + 2, b + 2, b + 3, b + 0]);
    }
    out
}

/// 初始顶点缓冲容量（4 粒子 × 4 角点 = 16 角点）。`draw` 会按需扩容。仅 render feature 使用。
#[cfg(feature = "render")]
const INITIAL_VERTEX_BYTES: u64 = 4 * VERTICES_PER_PARTICLE as u64 * PARTICLE_VERTEX_STRIDE;

/// 初始索引缓冲容量（4 粒子，每粒子 6 个 u32 索引）。`draw` 会按需扩容。
#[cfg(feature = "render")]
const INITIAL_INDEX_BYTES: u64 = 4 * INDICES_PER_PARTICLE as u64 * std::mem::size_of::<u32>() as u64;

/// 17 浮点角点顶点（pos3 + uv_rot_size4 + color4 + vel_lifetime4 + rot_x_y2）的 wgpu 顶点属性表
/// （5 个 location），与 `particle_billboard.wgsl` 的 `VsIn` 逐字段对齐。`static` 保证 `'static`
/// 生命周期，供管线创建时 `attributes: &VERTEX_ATTRIBUTES` 直接引用（无临时借用）。
#[cfg(feature = "render")]
static VERTEX_ATTRIBUTES: [wgpu::VertexAttribute; 5] = [
    wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 0, shader_location: 0 },
    wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x4, offset: 12, shader_location: 1 },
    wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x4, offset: 28, shader_location: 2 },
    wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x4, offset: 44, shader_location: 3 },
    wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x2, offset: 60, shader_location: 4 },
];

#[cfg(feature = "render")]
pub struct ParticleRenderPass {
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    vertex_buffer: wgpu::Buffer,
    index_buffer: wgpu::Buffer,
    uniform_buffer: wgpu::Buffer,
    /// 粒子纹理持有方（方案 A，同 ParticlePass）：bind group 引用 texture view，view 引用 texture——
    /// texture 必须存活，故由 pass 持有防释放；无纹理时为 1×1 白兜底。
    /// `_texture` 前缀下划线避免 unused 告警（仅用于延长 texture 生命周期）。
    _texture: wgpu::Texture,
}

#[cfg(feature = "render")]
impl ParticleRenderPass {
    /// 构建 billboard 渲染管线与全部 GPU 资源。
    /// `format` 为渲染目标格式（须与最终绘制 target 一致，如 surface/对象 RT 格式）。
    /// `tex` 为粒子纹理（无纹理 `None` → 1×1 白兜底，texel=(1,1,1,1)，mask_mode=0 → 软圆点）。
    /// `view_w`/`view_h` 为 cover 相机半视口（如 3840/1906），写入 uniform（mvp 的 ortho）。
    /// `blend` 决定混合模式（Additive / Translucent）；`overbright` 亮材质乘数（写 uniform）。
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        tex: Option<wgpu::Texture>,
        view_w: f32,
        view_h: f32,
        blend: BlendMode,
        overbright: f32,
    ) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("particle_billboard.wgsl"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/particle_billboard.wgsl").into()),
        });
        // sprite sheet 帧数（rosepetals 512×128 → 4）；单帧（方形/白兜底）→ 1。
        // 横向条带：cols=frames、rows=1。无纹理 → mask_mode=0（软圆盘）、softness=1.0（整盘软）；
        // 有纹理 → mask_mode=1（真实纹理 alpha 遮罩）、softness=0.15（薄软边，shape=texel.a）。
        let has_tex = tex.is_some();
        let (frames, cols, rows) = tex
            .as_ref()
            .map(|t| {
                let f = frame_count_from_dims(t.width(), t.height());
                (f as f32, f as f32, 1.0)
            })
            .unwrap_or((1.0, 1.0, 1.0));
        // bind group layout：binding 0 = uniform（view_w/view_h/材质，vertex 读），
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
        // 混合模式按材质门控（Additive / Translucent），不硬编码。
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
                // 不能用 TriangleStrip 直接 draw(0..4N)——会把相邻粒子 quad 连成"桥接"三角
                // （线框/三角网格的根因，见 `build_sprite_indices` 注释）。
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
        // uniform buffer：view_w/view_h + sprite sheet + 材质（写入一次，pass 内不变）。
        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("particle-billboard-uniform"),
            size: std::mem::size_of::<ParticleRenderUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(
            &uniform_buffer,
            0,
            bytemuck::bytes_of(&ParticleRenderUniform {
                view_w,
                view_h,
                spritesheet_frames: frames,
                spritesheet_cols: cols,
                spritesheet_rows: rows,
                overbright,
                softness: if has_tex { SOFTNESS_MASKED } else { SOFTNESS_UNMASKED },
                mask_mode: if has_tex { 1.0 } else { 0.0 },
            }),
        );
        // 粒子纹理：有 → 使用；无 → 1×1 白兜底（texel=(1,1,1,1) → soft 圆点兜底）。
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

    /// 把 `vertices`（**每角点** 17 浮点顶点流，来自 `SceneParticleSim::build_vertices`，每粒子 4 角点）
    /// 写入顶点缓冲（stride 68B），以 billboard quad（TriangleList + 索引缓冲，每粒子 2 个隔离三角形，
    /// 索引 `[b,b+1,b+2,b+2,b+3,b+0]`）渲染到 `out` 视图。shader 用角点的 uv（0..1）+ rot.z + size 推
    /// 世界空间 quad 角点（`pos + corner×size/2`），再经 mvp（ortho(view_w,view_h)）到 NDC。
    /// Load 不清除：粒子按混合模式叠加在 `out` 既有内容上。
    pub fn draw(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        vertices: &[[f32; 17]],
        out: &wgpu::TextureView,
    ) {
        // 顶点数 = 每角点 17 浮点流（vertices.len() 已含每粒子 4 角点）；超出当前缓冲则重新分配。
        let quad_vertex_count = vertices.len() as u32;
        let required = (quad_vertex_count as u64) * PARTICLE_VERTEX_STRIDE;
        if required > self.vertex_buffer.size() {
            self.vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("particle-billboard-vertex"),
                size: required.max(INITIAL_VERTEX_BYTES),
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
        }
        // 粒子数（vertices.len() 已是 4×粒子数；index 数 = 每粒子 6 个（2 三角形））。
        let particle_count = vertices.len() / VERTICES_PER_PARTICLE as usize;
        let index_count = (particle_count as u32) * INDICES_PER_PARTICLE;
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
            queue.write_buffer(&self.vertex_buffer, 0, bytemuck::cast_slice(vertices));
            // 索引：每 quad 显式列出 2 个三角形（TriangleList），隔离相邻粒子 quad。
            let indices = build_sprite_indices(particle_count);
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
