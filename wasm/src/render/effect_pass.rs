//! 全屏 quad 效果 pass 管线（wasm 构建基线，Task2）。
//!
//! 结构决策（controller 裁决，见 task-2-brief.md）：
//! - **不存 `bind_group` 字段**：输入纹理每个 pass/每帧变化，bind group 由调用方在
//!   `render` 时按当前输入纹理创建并传入，pass 无法跨帧复用字段；
//! - **不引入 `queue` / `pass_desc` / `EffectChain` / ping-pong / uniform / `g_Time`**——
//!   那属 Task3+ 的效果链层；
//! - 透传基线：`ColorTargetState { format, blend: None, write_mask: ALL }`（不做混合）。
//!
//! 仅 render feature（wasm 构建）编译：native `cargo test`（无 render feature）不编译本模块，
//! 与 Task1 的纯逻辑（effect.rs，naga）分离。管线创建失败时 `new` 返回 `Err`，由调用方
//! （`Renderer::render_frame`）跳过该 pass 不硬崩（绝不黑屏兜底）。

/// 全屏 quad 效果 pass。`pipeline` 为 triangle-strip 全屏 quad 渲染管线（vs 用
/// `@builtin(vertex_index)` 推导角点，同 `shaders/image.wgsl` 模式）；`layout` 为
/// `@group(0)` 的 bind group layout（binding 0 = `texture_2d<f32>`，binding 1 = `sampler`）。
#[cfg(feature = "render")]
pub struct EffectPass {
    /// 全屏 quad 渲染管线（triangle-strip）。
    pub pipeline: wgpu::RenderPipeline,
    /// `@group(0)` 的 bind group layout（binding 0 = texture_2d, binding 1 = sampler）。
    pub layout: wgpu::BindGroupLayout,
}

#[cfg(feature = "render")]
impl EffectPass {
    /// 构建全屏 quad 效果管线。
    ///
    /// `wgsl` 为 effect shader 源码（string）；`format` 为渲染目标（surface）格式；
    /// `layout` 为 `@group(0)` 的 bind group layout（调用方按 shader 的 texture_2d + sampler
    /// 创建后传入，效果链每层可复用同一 layout）。
    ///
    /// 反例：只构建管线一次（不每帧编译 naga）。WGSL 校验（复用 Task1 的 `effect::validate_wgsl`）
    /// 失败或管线创建失败 → 返回 `Err`，调用方跳过该 pass（不黑屏兜底）。
    pub fn new(
        device: &wgpu::Device,
        wgsl: &str,
        format: wgpu::TextureFormat,
        layout: wgpu::BindGroupLayout,
    ) -> Result<Self, String> {
        // 复用 Task1 的 WGSL 校验（naga 解析），失败则整体拒绝（不黑屏兜底）。
        if !crate::render::effect::validate_wgsl(wgsl) {
            return Err(format!("effect WGSL 校验失败：非合法 WGSL"));
        }
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("effect_passthrough.wgsl"),
            source: wgpu::ShaderSource::Wgsl(wgsl.into()),
        });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("effect-pass-pl"),
            bind_group_layouts: &[&layout],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("effect-pass"),
            layout: Some(&pl),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState {
                // 4 顶点 triangle-strip 全屏 quad（vs 用 vertex_index 推导角点，同粒子渲染模式）
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    // 透传基线：不做混合（Task2 边界）
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview: None,
            cache: None,
        });
        Ok(EffectPass { pipeline, layout })
    }

    /// 渲染全屏 quad：把 `bind_group`（绑定输入纹理 view + sampler，由调用方创建并传入，
    /// 见结构体头部注释）透传采样到 `output_view`（render pass 的 color attachment）。
    ///
    /// `_input_view` 为当前输入纹理的视图——透传基线里输入纹理已由调用方绑定进
    /// `bind_group`，故此处不直接使用（保留以对齐 brief 签名；后续效果链层若需在 pass
    /// 内部创建 bind group 可再基于它）。
    pub fn render(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        _input_view: &wgpu::TextureView,
        output_view: &wgpu::TextureView,
        bind_group: &wgpu::BindGroup,
    ) {
        let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("effect-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: output_view,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        rpass.set_pipeline(&self.pipeline);
        rpass.set_bind_group(0, bind_group, &[]);
        // 全屏 quad：4 顶点（triangle-strip），单实例
        rpass.draw(0..4, 0..1);
    }
}
