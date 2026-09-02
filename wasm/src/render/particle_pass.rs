//! compute shader 粒子：CPU 侧只做参数打包与分派，模拟全在 GPU（WGSL）。
//!
//! 结构决策（native 测试可达性）：`EmitterParams` / `from_spec` / `dispatch_dims`
//! 是纯函数（不依赖 wgpu），放在本模块的非门控区；`render/mod.rs` 本身非门控
//! （camera 模块同此），因此 native `cargo test`（无 render feature）可直接测试。
//! `ParticlePass`（wgpu 管线）位于 `#[cfg(feature = "render")]` 门控区，仅 wasm 构建编译。

use crate::coords;
use crate::particle::{OperatorKind, ParticleSpec, Renderer};

/// 发射器参数 uniform。repr(C) 布局与 `src/shaders/particle_compute.wgsl` /
/// `particle_render.wgsl` 的 `EmitterParams` 严格对齐（std140：vec3 后补 4 字节 pad，
/// Rust 侧显式字段），尺寸 176 字节（11 × vec4，16 的倍数，满足 uniform 绑定对齐）。
/// 原 _pad0/_pad1/_pad2 槽复用为 view_w/view_h/elapsed（审查修复：投影与时间演化），
/// Task 0.3 追加 alpha_min/alpha_max（alpharandom 初始 alpha 范围，缺省 1.0）：
/// 原尾部 (dt, max_particles, _pad8, _pad9) 改为 (dt, max_particles, alpha_min, alpha_max)，
/// 再补 _pad8.._pad11 一整行 vec4 使 struct 达 176B（与 WGSL uniform 布局 field-for-field 一致；
/// WGSL 侧 uniform struct size 会按 align 16 上取整，Rust repr(C) align 4 不会，故显式补 pad）。
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
    pub alpha_min: f32,
    pub alpha_max: f32,
    // ==== 2026-08-31 算子内核扩容（补 3 张 STATIC 壁纸 root cause） ====
    // 原 _pad8.._pad11 一行 vec4 复用为「湍流」槽，再追加 4 行 vec4：
    //   @160 turb:     speed_min, speed_max, scale, active(0/1)
    //   @176 movement: gravity_x, gravity_y, gravity_z, drag
    //   @192 osc:      freq_min, freq_max, scale_min, scale_max
    //   @208 osc mask: mask_x, mask_y, osc_active(0/1), pad
    //   @224 rig:      rot_active(0/1), ang_drag, rot_min, rot_max
    // 共 240B（15 × vec4），满足 uniform 绑定对齐，语义清晰。
    pub turb_speed_min: f32,
    pub turb_speed_max: f32,
    pub turb_scale: f32,
    pub turb_active: f32,
    pub grav_x: f32, pub grav_y: f32, pub grav_z: f32, pub drag: f32,
    pub osc_freq_min: f32, pub osc_freq_max: f32, pub osc_scale_min: f32, pub osc_scale_max: f32,
    pub osc_mask_x: f32, pub osc_mask_y: f32, pub osc_active: f32, pub renderer_type: f32,
    pub rot_active: f32, pub ang_drag: f32, pub rot_min: f32, pub rot_max: f32,
}

impl EmitterParams {
    /// 把 emitter 字段打包进 uniform（共享逻辑；origin 已为中心语义、view 已为投影视口）。
    /// CPU 侧坐标映射（WE 左下原点、y 向上 → 中心原点、y 向上；scale.y 不取负——
    /// 2026-08-20 方向修正，见 coords::particle_scale），elapsed 初始 0（step 累加）。
    /// Round 2 审查修复：max_particles 由调用方传入（估算值，含 cover 减半），
    /// 与 ParticlePass::new 的 buffer 槽位、dispatch 分派三处一致——原硬编码 2048
    /// 与估算 buffer 容量不同步 → compute shader 槽位边界检查（读 uniform 2048）
    /// 对估算槽位恒不触发 → dispatch 线程超出 buffer 容量时 storage 越界读写（UB）。
    #[allow(clippy::too_many_arguments)]
    fn pack(
        spec: &ParticleSpec,
        origin_center: [f32; 3],
        scale: [f32; 3],
        view_w: f32,
        view_h: f32,
        max_particles: u32,
    ) -> EmitterParams {
        let s = coords::particle_scale(scale);
        let i = &spec.init;
        let (turb_speed_min, turb_speed_max, turb_scale, turb_active) = match &i.turbulent {
            Some(t) => (t.speed_min, t.speed_max, t.scale, 1.0),
            None => (0.0, 0.0, 0.0, 0.0),
        };
        let (grav_x, grav_y, grav_z, drag) = operator_movement(spec);
        let (osc_freq_min, osc_freq_max, osc_scale_min, osc_scale_max, osc_mask_x, osc_mask_y, osc_active) = operator_oscillate(spec);
        let (rot_active, ang_drag, rot_min, rot_max) = operator_angular(spec, i);
        EmitterParams {
            origin_x: origin_center[0], origin_y: origin_center[1], origin_z: origin_center[2],
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
            alpha_min: i.alpha_min, alpha_max: i.alpha_max,
            _pad3: 0.0, _pad4: 0.0, _pad5: 0.0, _pad6: 0.0, _pad7: 0.0,
            turb_speed_min, turb_speed_max, turb_scale, turb_active,
            grav_x, grav_y, grav_z, drag,
            osc_freq_min, osc_freq_max, osc_scale_min, osc_scale_max,
            osc_mask_x, osc_mask_y, osc_active, renderer_type: renderer_flag(spec.renderer),
            rot_active, ang_drag, rot_min, rot_max,
        }
    }

    /// **共享粒子路径**（add_particle，粒子直接渲染到 surface）：场景相机语义。
    /// Task 9 修复：origin 是 WE 场景坐标（0..scene_w / 0..scene_h），中心映射必须用
    /// **场景尺寸** scene_w/scene_h（原实现与投影共用视口尺寸，create 改传视口后
    /// 粒子位置错位/移出视口）；view_w/view_h 为投影半视口（contain 相机范围，
    /// vs_main 的裁剪坐标映射用）。
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
        Self::pack(spec, c, scale, view_w, view_h, max_particles)
    }

    /// **粒子对象级效果链**（set_particle_object_effect）：对象局部相机语义。
    /// 粒子内容渲染进对象 RT（rt_w × rt_h）：局部坐标**中心原点**（对象中心 = 局部原点，
    /// vs_main 的 `pos / view * 2` 在局部空间内映射），view 范围 = 对象 RT 尺寸（1:1 像素，
    /// 对齐 image 对象级管线的局部正交相机 `content_ndc` 的 world/rt）。
    /// 2026-08-25（final whole-branch review I3）：原实现复用共享 `from_spec` 的场景相机范围
    /// + scene_w/h —— 粒子内容在对象 RT 内「投影双重映射」近似错位；改为对象局部相机后
    /// 粒子按对象中心呈现、1 世界单位 = 1 像素，与 image 局部管线一致。
    pub fn from_spec_local(
        spec: &ParticleSpec,
        scale: [f32; 3],
        rt_w: f32,
        rt_h: f32,
        max_particles: u32,
    ) -> EmitterParams {
        Self::pack(spec, [0.0; 3], scale, rt_w, rt_h, max_particles)
    }
}

/// 从 movement operator 提取 gravity (vec3) + drag (标量)（官方 MovementOperator：
/// `acceleration = DragForce(vel, drag) + gravity`；DragForce(v, s) = -v·s）。
/// 缺省 gravity=0、drag=0。movement 缺失 → 全 0。
fn operator_movement(spec: &ParticleSpec) -> (f32, f32, f32, f32) {
    let Some(op) = spec.operators.iter().find(|o| o.kind == OperatorKind::Movement) else {
        return (0.0, 0.0, 0.0, 0.0);
    };
    let p = &op.params;
    let f = |k: &str, d: f32| p.get(k).and_then(|v| v.as_f64()).map(|x| x as f32).unwrap_or(d);
    let str_vec = |k: &str, d: [f32; 3]| {
        p.get(k).and_then(|v| v.as_str()).map(|s| {
            let mut it = s.split_whitespace().map(|t| t.parse::<f32>().unwrap_or(0.0));
            [it.next().unwrap_or(0.0), it.next().unwrap_or(0.0), it.next().unwrap_or(0.0)]
        }).unwrap_or(d)
    };
    let g = str_vec("gravity", [0.0; 3]);
    let drag = f("drag", 0.0);
    (g[0], g[1], g[2], drag)
}

/// 从 oscillateposition operator 提取 freq/scale 范围与 mask（官方 OscillatePositionOperator：
/// 每轴一个 FrequencyValue，mask[axis] 决定该轴是否摆动）。返回
/// (freq_min, freq_max, scale_min, scale_max, mask_x, mask_y, active)。
/// 缺省 freq=0..10、scale=0..1、mask=全 1（官方默认）。oscillate 缺失 → 全 0（关闭）。
fn operator_oscillate(spec: &ParticleSpec) -> (f32, f32, f32, f32, f32, f32, f32) {
    let Some(op) = spec.operators.iter().find(|o| o.kind == OperatorKind::OscillatePosition) else {
        return (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    };
    let p = &op.params;
    let f = |k: &str, d: f32| p.get(k).and_then(|v| v.as_f64()).map(|x| x as f32).unwrap_or(d);
    let freq_min = f("frequencymin", 0.0);
    let mut freq_max = f("frequencymax", 10.0);
    if freq_max == 0.0 { freq_max = freq_min; }
    let scale_min = f("scalemin", 0.0);
    let scale_max = f("scalemax", 1.0);
    // mask：字符串 "1 0.5 0" 逐轴。缺省全 1（2D 用 x/y）。
    let mut mask = [1.0, 1.0, 1.0];
    if let Some(m) = p.get("mask").and_then(|v| v.as_str()) {
        let mut it = m.split_whitespace().map(|t| t.parse::<f32>().unwrap_or(1.0));
        mask = [it.next().unwrap_or(1.0), it.next().unwrap_or(1.0), it.next().unwrap_or(1.0)];
    }
    let active = if freq_max > 0.0 { 1.0 } else { 0.0 };
    (freq_min, freq_max, scale_min, scale_max, mask[0], mask[1], active)
}

/// 从 angularmovement/angularvelocityrandom 提取旋转激活标记 + 角拖动 + 旋转范围标量。
/// 本实现为 2D 便利：只取 Z 轴旋转（sprite 平面最常用），min/max 为角度范围，用于按寿命积分。
/// rot_active = 1 当存在 angularmovement operator；ang_drag 取其 drag；rot_min/max 取
/// angularvelocityrandom 的 z 分量或 rotationrandom 的 z 分量。
fn operator_angular(spec: &ParticleSpec, i: &crate::particle::InitSpec) -> (f32, f32, f32, f32) {
    let has_ang_movement = spec.operators.iter().any(|o| o.kind == OperatorKind::AngularMovement);
    let ang_drag = spec.operators.iter()
        .find(|o| o.kind == OperatorKind::AngularMovement)
        .and_then(|o| o.params.get("drag").and_then(|v| v.as_f64()))
        .map(|x| x as f32)
        .unwrap_or(0.0);
    // 旋转范围（弧度）：优先 angularvelocityrandom 的 z，其次 rotationrandom 的 z。
    let rot_range = i.angular_vel_max
        .map(|m| (i.angular_vel_min.map(|n| n[2]).unwrap_or(0.0), m[2]))
        .or_else(|| i.rotation_max.map(|m| (i.rotation_min.map(|n| n[2]).unwrap_or(0.0), m[2])))
        .unwrap_or((0.0, 0.0));
    let active = if has_ang_movement && rot_range.1 != 0.0 { 1.0 } else { 0.0 };
    (active, ang_drag, rot_range.0, rot_range.1)
}

/// renderer 类型标志（0=sprite, 1=spritetrail）。render shader 据此做拉伸。
fn renderer_flag(r: Renderer) -> f32 {
    match r {
        Renderer::SpriteTrail { .. } => 1.0,
        _ => 0.0,
    }
}

/// compute 分派尺寸：`(ceil(count/workgroup), 1, 1)`，空也分派 1 组（安全）。
pub fn dispatch_dims(count: u32, workgroup: u32) -> (u32, u32, u32) {
    let g = workgroup.max(1);
    (((count + g - 1) / g).max(1), 1, 1)
}

/// 按 emitter 实际需求估算粒子池上限（Task 9 审查修复：原固定 2048，多粒子壁纸
/// 2859263090 44 系统 × 2048 = 9 万粒子/帧 → headless FPS < 30）。
/// 稳态粒子数 ≈ rate × 最大寿命（出生率 × 最长存活时间），加 64 余量，夹在 [64, 2048]。
/// 2026-08-25 修复：若 spec 显式给出 maxcount（WE 权威上限），优先用它作为粒子池容量
/// （对齐桌面版——桌面版即按 maxcount 生成；此前只用 rate×寿命+64 估算，对高 rate 短寿命
/// 系统明显偏大，如 Fireflies rate20×寿命3+64≈124 而 maxcount=20 → 绿色粒子比桌面端多）。
/// maxcount 需 clamp 到 [16, 2048]（避免过小粒子显示不出 / 过大撑爆 GPU buffer）。
pub fn estimate_max_particles(spec: &ParticleSpec) -> u32 {
    if spec.maxcount > 0 {
        return spec.maxcount.clamp(16, 2048);
    }
    let max_life = spec.init.lifetime_max.max(spec.init.lifetime_min).max(0.1);
    let est = (spec.emitter.rate * max_life).ceil() as u32 + 64;
    est.clamp(64, 2048)
}

/// WGSL `Particle` 结构体 stride（最终审查修复：原按 48B/粒子分配 storage buffer，
/// 但 WGSL `struct Particle { pos: vec3f, vel: vec3f, life, max_life, size, alpha, color: vec3f }`
/// 布局为 pos@0、vel@16、life@28、max_life@32、size@36、alpha@40（Task 0.3 追加，
/// 初始 alpha，compute 不衰减）、color@48（vec3 对齐 16）、span=60 → **stride=64**
/// （struct align 16）。按 48B 分配时高索引槽位
/// （i*64+60 ≥ 48*max，即 i ≥ 0.75*max）越界，被 WebGPU robustness 钳制（读 0 →
/// 粒子不可见）→ 实际粒子密度比估算低约 25%；compute/渲染读写均按 64 stride 自洽，
/// 掩盖了 buffer 分配错误。Rust 侧按 stride 64 分配 storage buffer。
pub const PARTICLE_BYTES: u64 = 64;

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
    /// 粒子纹理持有（2026-08-21 方案 A）：bind group 引用 texture view，view 引用
    /// texture——texture 必须存活，故由 pass 持有防释放；无纹理时为 1×1 白兜底。
    _texture: wgpu::Texture,
}

#[cfg(feature = "render")]
impl ParticlePass {
    /// 构建 compute（模拟）+ 点渲染管线与全部 GPU 资源，并初始化 buffer 内容。
    /// `format` 为渲染目标格式（surface 格式），必须与最终绘制 target 一致。
    /// `tex` 为粒子纹理（2026-08-21 方案 A：WE 内置 fog/halo 纹理；None → 1×1 白兜底，
    /// fs_main 采样 texel=(1,1,1,1) 等价纯色圆盘）。
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        params: &EmitterParams,
        max_particles: u32,
        format: wgpu::TextureFormat,
        tex: Option<wgpu::Texture>,
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
                // 粒子纹理（2026-08-21 方案 A）：fragment 采样，fog/halo 引擎内置纹理
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
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
        // 粒子纹理：有 → 使用粒子纹理；无 → 1×1 白兜底（texel=(1,1,1,1) → 纯色圆盘）
        let (texture_holder, texture_view) = if let Some(t) = tex {
            let view = t.create_view(&wgpu::TextureViewDescriptor::default());
            (t, view)
        } else {
            let t = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("particle-white"),
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
            label: Some("particle-sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let render_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("particle-render-bg"),
            layout: &render_bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: param_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: particles_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&texture_view) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&sampler) },
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
            _texture: texture_holder,
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
