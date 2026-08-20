//! compute shader 粒子：CPU 侧只做参数打包与分派，模拟全在 GPU（WGSL）。
//!
//! 结构决策（native 测试可达性）：`EmitterParams` / `from_spec` / `dispatch_dims`
//! 是纯函数（不依赖 wgpu），放在本模块的非门控区；`render/mod.rs` 本身非门控
//! （camera 模块同此），因此 native `cargo test`（无 render feature）可直接测试。
//! `ParticlePass`（wgpu 管线）位于 `#[cfg(feature = "render")]` 门控区，仅 wasm 构建编译。

use crate::coords;
use crate::particle::ParticleSpec;

/// 发射器参数 uniform。repr(C) 布局与 `src/shaders/particle.wgsl` 的
/// `EmitterParams` 严格对齐（std140：vec3 后补 4 字节 pad，Rust 侧显式字段），
/// 尺寸 160 字节（16 的倍数，满足 uniform 绑定对齐）。
/// 原 _pad0/_pad1/_pad2 槽复用为 view_w/view_h/elapsed（审查修复：投影与时间演化），
/// 剩余 _pad3.._pad9 保持占位。
#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct EmitterParams {
    pub origin_x: f32, pub origin_y: f32, pub origin_z: f32, pub view_w: f32,
    pub scale_x: f32, pub scale_y: f32, pub scale_z: f32, pub view_h: f32,
    pub rate: f32, pub distance_min: f32, pub distance_max: f32, pub elapsed: f32,
    pub directions_x: f32, pub directions_y: f32, pub directions_z: f32, pub _pad3: f32,
    pub life_min: f32, pub life_max: f32, pub size_min: f32, pub size_max: f32,
    pub vel_min_x: f32, pub vel_min_y: f32, pub vel_min_z: f32, pub _pad4: f32,
    pub vel_max_x: f32, pub vel_max_y: f32, pub vel_max_z: f32, pub _pad5: f32,
    pub color_min_r: f32, pub color_min_g: f32, pub color_min_b: f32, pub _pad6: f32,
    pub color_max_r: f32, pub color_max_g: f32, pub color_max_b: f32, pub _pad7: f32,
    pub dt: f32,
    pub max_particles: u32,
    pub _pad8: u32,
    pub _pad9: u32,
}

impl EmitterParams {
    /// CPU 侧坐标映射（WE 左上原点 → 中心原点、y 向上；scale.y 取负）后打包 uniform。
    /// Task 9 修复：origin 是 WE 场景坐标（0..scene_w / 0..scene_h），中心映射必须用
    /// **场景尺寸** scene_w/scene_h（原实现与投影共用视口尺寸，create 改传视口后
    /// 粒子位置错位/移出视口）；view_w/view_h 为投影半视口（contain 相机范围，
    /// vs_main 的裁剪坐标映射用），elapsed 初始 0（step 累加）。
    /// Round 2 审查修复：max_particles 由调用方传入（估算值，含 cover 减半），
    /// 与 ParticlePass::new 的 buffer 槽位、dispatch 分派三处一致——原硬编码 2048
    /// 与估算 buffer 容量不同步 → compute shader 槽位边界检查（读 uniform 2048）
    /// 对估算槽位恒不触发 → dispatch 线程超出 buffer 容量时 storage 越界读写（UB）。
    pub fn from_spec(
        spec: &ParticleSpec,
        origin: [f32; 3],
        scale: [f32; 3],
        scene_w: f32,
        scene_h: f32,
        view_w: f32,
        view_h: f32,
        max_particles: u32,
    ) -> EmitterParams {
        let c = coords::origin_to_center(origin, scene_w, scene_h);
        let s = coords::particle_scale(scale);
        let i = &spec.init;
        EmitterParams {
            origin_x: c[0], origin_y: c[1], origin_z: c[2],
            scale_x: s[0], scale_y: s[1], scale_z: s[2],
            view_w, view_h, elapsed: 0.0,
            rate: spec.emitter.rate,
            distance_min: spec.emitter.distance_min,
            distance_max: spec.emitter.distance_max,
            directions_x: spec.emitter.directions[0],
            directions_y: spec.emitter.directions[1],
            directions_z: spec.emitter.directions[2],
            life_min: i.lifetime_min, life_max: i.lifetime_max,
            size_min: i.size_min, size_max: i.size_max,
            vel_min_x: i.velocity_min[0], vel_min_y: i.velocity_min[1], vel_min_z: i.velocity_min[2],
            vel_max_x: i.velocity_max[0], vel_max_y: i.velocity_max[1], vel_max_z: i.velocity_max[2],
            color_min_r: i.color_min.map(|c| c[0]).unwrap_or(1.0),
            color_min_g: i.color_min.map(|c| c[1]).unwrap_or(1.0),
            color_min_b: i.color_min.map(|c| c[2]).unwrap_or(1.0),
            color_max_r: i.color_max.map(|c| c[0]).unwrap_or(1.0),
            color_max_g: i.color_max.map(|c| c[1]).unwrap_or(1.0),
            color_max_b: i.color_max.map(|c| c[2]).unwrap_or(1.0),
            dt: 0.0, max_particles,
            _pad3: 0.0, _pad4: 0.0, _pad5: 0.0, _pad6: 0.0, _pad7: 0.0,
            _pad8: 0, _pad9: 0,
        }
    }
}

/// cover（背景）模式的粒子池上限：估算值减半、下限 32（模糊背景低密度无视觉影响）。
/// Round 2 审查修复：减半逻辑独立为纯函数，保证与 set_particle 的 buffer 槽位、
/// dispatch 分派、uniform max_particles 三处一致（原在 set_particle 内联计算）。
pub fn cover_max_particles(est: u32) -> u32 {
    (est / 2).max(32)
}

/// compute 分派尺寸：`(ceil(count/workgroup), 1, 1)`，空也分派 1 组（安全）。
pub fn dispatch_dims(count: u32, workgroup: u32) -> (u32, u32, u32) {
    let g = workgroup.max(1);
    (((count + g - 1) / g).max(1), 1, 1)
}

/// 按 emitter 实际需求估算粒子池上限（Task 9 审查修复：原固定 2048，多粒子壁纸
/// 2859263090 44 系统 × 2048 = 9 万粒子/帧 → headless FPS < 30）。
/// 稳态粒子数 ≈ rate × 最大寿命（出生率 × 最长存活时间），加 64 余量，夹在 [64, 2048]。
pub fn estimate_max_particles(spec: &ParticleSpec) -> u32 {
    let max_life = spec.init.lifetime_max.max(spec.init.lifetime_min).max(0.1);
    let est = (spec.emitter.rate * max_life).ceil() as u32 + 64;
    est.clamp(64, 2048)
}

/// WGSL `Particle` 结构体字节大小：pos 12 + vel 12 + life 4 + max_life 4 + size 4 + color 12 = 48。
/// 由 Rust 侧按 48 字节/粒子分配 storage buffer（与 shader 布局约定一致）。
pub const PARTICLE_BYTES: u64 = 48;

/// GPU 粒子模拟 + 点渲染管线（wgpu）。仅 render feature（wasm 构建）编译。
#[cfg(feature = "render")]
pub struct ParticlePass {
    device: wgpu::Device,
    compute_pipeline: wgpu::ComputePipeline,
    render_pipeline: wgpu::RenderPipeline,
    compute_bind_group: wgpu::BindGroup,
    render_bind_group: wgpu::BindGroup,
    param_buffer: wgpu::Buffer,
    params: std::cell::Cell<EmitterParams>,
    max_particles: u32,
    dispatch: (u32, u32, u32),
}

#[cfg(feature = "render")]
impl ParticlePass {
    /// 构建 compute（模拟）+ 点渲染管线与全部 GPU 资源，并初始化 buffer 内容。
    /// `format` 为渲染目标格式（surface 格式），必须与最终绘制 target 一致。
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        params: &EmitterParams,
        max_particles: u32,
        format: wgpu::TextureFormat,
    ) -> ParticlePass {
        let particle_bytes = (max_particles as usize) * PARTICLE_BYTES as usize;
        let particles_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("particles"),
            size: particle_bytes as u64,
            // COPY_DST 必需：queue.write_buffer 初始化（WebGPU writeBuffer 目标必须含 COPY_DST，
            // 否则 wgpu-core 校验失败 / webgpu 后端 panic——审查 Critical）
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let count_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("particle-count"),
            size: 4,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let param_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("particle-params"),
            size: std::mem::size_of::<EmitterParams>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&particles_buffer, 0, &vec![0u8; particle_bytes]);
        queue.write_buffer(&count_buffer, 0, &[0u8; 4]);
        queue.write_buffer(&param_buffer, 0, bytemuck::bytes_of(params));

        // compute/render 拆分为两个 shader module（Round 3 审查修复）：
        // WGSL 规范禁止 vertex 阶段静态访问 `var<storage, read_write>`（Dawn/Tint 强制实施），
        // 故 compute 用 read_write、render 用 read，各自绑定对应 module 与 bind group layout。
        let compute_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("particle_compute.wgsl"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/particle_compute.wgsl").into()),
        });
        let render_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("particle_render.wgsl"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/particle_render.wgsl").into()),
        });

        // compute 需要读写粒子 + 计数；render 只需读粒子（同一 storage buffer 双布局）
        let compute_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("particle-compute-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: false }, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: false }, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
            ],
        });
        let render_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("particle-render-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    // read_only: true 与 particle_render.wgsl 的 `var<storage, read>` 匹配：
                    // render module 与 compute module 拆分后，vertex 阶段只读 storage 合法
                    // （Round 3 审查修复；此前 read_only: false 虽过 wgpu-core 校验，
                    // 但 WGSL 规范禁止 vertex 静态访问 read_write storage，Dawn/Tint 会拒）
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
            ],
        });

        let compute_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("particle-compute-pl"),
            bind_group_layouts: &[&compute_bgl],
            push_constant_ranges: &[],
        });
        let render_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("particle-render-pl"),
            bind_group_layouts: &[&render_bgl],
            push_constant_ranges: &[],
        });

        let compute_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("particle-compute"),
            layout: Some(&compute_layout),
            module: &compute_shader,
            entry_point: Some("cs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });

        // 加法混合：SrcAlpha/One（对齐 Three.js AdditiveBlending）——fragment 的
        // v_life_alpha 参与混合，寿命淡出生效（审查 Finding 3 附带修复：原 One/One
        // 忽略 alpha，死亡粒子以全亮度残留为固定亮斑）。
        let additive = wgpu::BlendState {
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
        };
        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("particle-render"),
            layout: Some(&render_layout),
            vertex: wgpu::VertexState {
                module: &render_shader,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState {
                // billboard quad（vs 用 vertex_index 推导角点；PointList 的 point_size
                // builtin 在 naga 24.0.0/wgpu 24 不可用——见 particle_render.wgsl 头部注释）
                topology: wgpu::PrimitiveTopology::TriangleList,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &render_shader,
                entry_point: Some("fs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(additive),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview: None,
            cache: None,
        });

        let compute_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("particle-compute-bg"),
            layout: &compute_bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: param_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: particles_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: count_buffer.as_entire_binding() },
            ],
        });
        let render_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("particle-render-bg"),
            layout: &render_bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: param_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: particles_buffer.as_entire_binding() },
            ],
        });

        ParticlePass {
            device: device.clone(),
            compute_pipeline,
            render_pipeline,
            compute_bind_group,
            render_bind_group,
            param_buffer,
            params: std::cell::Cell::new(*params),
            max_particles,
            dispatch: dispatch_dims(max_particles, 64),
        }
    }

    /// GPU 模拟一帧：更新 uniform dt + 累计 elapsed → dispatch compute。
    pub fn step(&self, queue: &wgpu::Queue, dt: f32) {
        let mut params = self.params.get();
        params.dt = dt;
        params.elapsed += dt;
        self.params.set(params);
        queue.write_buffer(&self.param_buffer, 0, bytemuck::bytes_of(&params));
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("particle-step-encoder"),
        });
        {
            let mut cpass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("particle-compute-pass"),
                timestamp_writes: None,
            });
            cpass.set_pipeline(&self.compute_pipeline);
            cpass.set_bind_group(0, &self.compute_bind_group, &[]);
            cpass.dispatch_workgroups(self.dispatch.0, self.dispatch.1, self.dispatch.2);
        }
        queue.submit([encoder.finish()]);
    }

    /// billboard quad 渲染到目标视图（Load 不清除，叠加在既有内容上，加法混合）。
    pub fn render(&self, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView) {
        let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("particle-render-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        rpass.set_pipeline(&self.render_pipeline);
        rpass.set_bind_group(0, &self.render_bind_group, &[]);
        // 每粒子一个 billboard quad（4 顶点，vertex_index 0..3 推导角点）
        rpass.draw(0..4, 0..self.max_particles);
    }
}
