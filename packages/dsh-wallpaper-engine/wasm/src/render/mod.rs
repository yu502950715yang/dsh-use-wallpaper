//! wgpu 渲染器。cargo test（native，无 render feature）覆盖 camera 数学与
//! particle_pass 纯函数（参数打包/分派）；wgpu 管线代码仅在 wasm 构建
//! （--features render）编译，渲染验证在浏览器（headless Edge + CDP）。

pub mod camera;
pub mod particle_pass;
#[cfg(feature = "render")]
pub mod texture;

#[cfg(feature = "render")]
use crate::particle::ParticleSpec;
#[cfg(feature = "render")]
use crate::coords;

/// 相机沿 +z 放置的距离，使 shader 中 300/-mv.z = 1（点尺寸=像素尺寸，对齐 scene-renderer.ts 的 CAMERA_DISTANCE）
#[cfg(feature = "render")]
pub const CAMERA_DISTANCE: f32 = 300.0;

/// 场景图片对象：纹理 + 变换 + GPU 资源（Task 9 实测修复：render_frame 原只渲染
/// 粒子、图片平面未绘制 → 全库画面偏暗；本结构承载图片 quad 渲染所需资源）。
#[cfg(feature = "render")]
pub struct SceneImage {
    pub asset_id: u32,
    pub tex: wgpu::Texture,
    pub bind_group: wgpu::BindGroup,
    pub uniform_buffer: wgpu::Buffer,
    pub origin: [f32; 3],
    pub scale: [f32; 3],
    pub size: Option<[f32; 2]>,
    pub tex_width: u32,
    pub tex_height: u32,
    // T4.3：对象调制输入（color 0-255 量级 / alpha 0-1 / brightness 乘法系数；
    // None = 缺省，image_tint 按白色 ×1.0 处理，无调制）
    pub tint_color: Option<[f32; 3]>,
    pub tint_alpha: Option<f32>,
    pub tint_brightness: Option<f32>,
}

/// 图片 quad uniform（NDC 中心 + 半宽高 + 调制系数 tint；对齐 shaders/image.wgsl 的
/// ImageUniform，32 字节 = 4×f32 + vec4f）。tint.rgb = color×brightness（0-1）、
/// tint.a = alpha（0-1），由 image_tint 纯函数计算（native 可测，见 tests/image_tint_test.rs）。
/// 布局：4 个 f32 后接 vec4f（WGSL vec4 对齐 16，偏移 16 恰好对齐、无隐式填充）。
/// 本结构不依赖 wgpu，放非门控区以便 native cargo test（无 render feature）校验布局。
#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct ImageUniform {
    pub center_x: f32,
    pub center_y: f32,
    pub half_w: f32,
    pub half_h: f32,
    pub tint_r: f32,
    pub tint_g: f32,
    pub tint_b: f32,
    pub tint_a: f32,
}

/// 图片调制系数（T4.3）：WE 对象 color/alpha/brightness → tint（vec4f，0-1）。
///   color：0-255 量级（对齐 JS optColor 归一化输出）→ /255 到 0-1；
///   brightness：乘法系数（缺省 1），乘入 color 后 clamp 0-1（超 1 饱和到纯色）；
///   alpha：0-1（解析器已按 NormalizeLayerAlpha 归一化），缺省 1，clamp 0-1 防御。
/// 输出 [r,g,b,a] 0-1；全缺省 → [1,1,1,1]（无调制，向后兼容旧行为）。
pub fn image_tint(
    color: Option<[f32; 3]>,
    alpha: Option<f32>,
    brightness: Option<f32>,
) -> [f32; 4] {
    // color 缺省 → 0-255 量级的白色 [255,255,255]（/255 后 = 1.0，无调制；
    // 不能默认 [1,1,1]——按 0-255 语义 /255 会得到近黑 1/255）
    let c = color.unwrap_or([255.0, 255.0, 255.0]);
    let b = brightness.unwrap_or(1.0);
    [
        (c[0] / 255.0 * b).clamp(0.0, 1.0),
        (c[1] / 255.0 * b).clamp(0.0, 1.0),
        (c[2] / 255.0 * b).clamp(0.0, 1.0),
        alpha.unwrap_or(1.0).clamp(0.0, 1.0),
    ]
}

/// 相机模式：前景 contain（完整显示、留白透明）/ 背景 cover（铺满、裁剪）——
/// 对齐 scene-renderer.ts 的 containRange/coverRange 与 background-layer 双 canvas 语义。
#[cfg(feature = "render")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CameraMode { Contain, Cover }

#[cfg(feature = "render")]
pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    surface: wgpu::Surface<'static>,
    width: u32,
    height: u32,
    /// GPU 粒子模拟 + 点渲染管线（**多系统**，set_particle 追加——Task 9 修复：
    /// EVA 等壁纸多粒子系统全部渲染，对齐 JS 版粒子密度）
    particle_passes: Vec<particle_pass::ParticlePass>,
    /// 场景正交尺寸（load_scene 设置；render_frame 的 contain 相机范围计算用）
    scene_w: f32,
    scene_h: f32,
    /// 相机模式（contain/cover，wasm-renderer 背景 canvas 用 cover）
    mode: CameraMode,
    /// 场景 clearcolor（0-255 量级，load_scene 设置；cover 背景模式清屏用，对齐 JS 版
    /// bgRenderer.setClearColor(clearColor ?? 0x111114)）
    clear_color: Option<[f32; 3]>,
    /// 图片平面（set_image 上传；render_frame 在粒子层之前绘制）
    images: Vec<SceneImage>,
    image_pipeline: wgpu::RenderPipeline,
}

#[cfg(feature = "render")]
impl Renderer {
    pub async fn new(canvas: &web_sys::HtmlCanvasElement, width: u32, height: u32) -> Result<Renderer, String> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            // wasm 目标必须显式 BROWSER_WEBGPU（1<<4）；from_bits(1<<2) 是 METAL，错误
            backends: wgpu::Backends::BROWSER_WEBGPU,
            ..Default::default()
        });
        let surface = instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
            .map_err(|e| format!("create_surface: {e}"))?;
        let adapter = instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        }).await.ok_or("no WebGPU adapter")?;
        // wgpu 24 API 适配：request_device 增补第 2 参数 trace_path（None = 不追踪）。
        // Task 9 修复：DXT(BC) 纹理需要 texture-compression-bc feature——adapter 支持时
        // 启用，否则 upload_texture 的 create_texture 会 panic（实测 3743126786/3765967112
        // 等含 DXT 纹理的壁纸 wasm 渲染 panic → 回退 JS）。
        let mut required_features = wgpu::Features::empty();
        if adapter.features().contains(wgpu::Features::TEXTURE_COMPRESSION_BC) {
            required_features |= wgpu::Features::TEXTURE_COMPRESSION_BC;
        }
        let (device, queue) = adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("we-scene"),
            required_features,
            required_limits: wgpu::Limits::default(),
            memory_hints: wgpu::MemoryHints::Performance,
        }, None).await.map_err(|e| format!("request_device: {e}"))?;
        let caps = surface.get_capabilities(&adapter);
        // Task 9 修复：直接取 formats[0]（headless Edge 实测首选非 sRGB 格式）。
        // 原实现优先 sRGB → 纹理(改后非 sRGB) 采样值经 sRGB surface 编码会偏亮，
        // 且旧组合（sRGB 纹理 + 非 sRGB surface）使画面暗约 50%。统一非 sRGB 管线：
        // 纹理 fragment 输出原始编码值，surface 直接显示。
        let format = caps.formats[0];
        // 调试（2026-08-21 色彩管线排查）：surface 格式决定 sRGB 处理——sRGB surface
        // 会把写入值当线性再编码显示（非 sRGB 纹理 + sRGB surface → 偏亮偏饱和）。
        // 用户 Firefox 与 headless Edge 的 formats[0] 可能不同（Task 9 基于 Edge 非 sRGB）。
        web_sys::console::log_1(&wasm_bindgen::JsValue::from_str(&format!(
            "[wasm] surface format: {:?} ({} formats)",
            format,
            caps.formats.len()
        )));
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: width.max(1),
            height: height.max(1),
            present_mode: wgpu::PresentMode::AutoVsync,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);
        // 图片 quad 管线：NDC 顶点（vertex_index 推导角点）+ 纹理采样。
        // 渲染目标格式与 surface 一致；alpha 混合（透明边缘露出背景模糊层，对齐 JS 版
        // MeshBasicMaterial transparent:true）。
        let image_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("image.wgsl"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/image.wgsl").into()),
        });
        let image_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("image-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    // T4.3 后 fs_main 用 img.tint（颜色调制）→ fragment 阶段也读 binding 0；
                    // 原 VERTEX only 在 WebGPU 严格校验下报 "Visibility flags don't include
                    // the shader stage"（强制 wasm 后所有壁纸走 wasm 立即暴露，实测）
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
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
        let image_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("image-pl"),
            bind_group_layouts: &[&image_bgl],
            push_constant_ranges: &[],
        });
        let image_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("image-render"),
            layout: Some(&image_layout),
            vertex: wgpu::VertexState {
                module: &image_shader,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState {
                // 4 顶点 triangle-strip quad（vs 用 vertex_index 推导角点，同粒子渲染模式）
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &image_shader,
                entry_point: Some("fs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState {
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
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview: None,
            cache: None,
        });
        Ok(Renderer {
            device, queue, config, surface, width, height,
            particle_passes: Vec::new(),
            scene_w: width as f32,
            scene_h: height as f32,
            mode: CameraMode::Contain,
            clear_color: None,
            images: Vec::new(),
            image_pipeline,
        })
    }

    /// 背景模式（cover）：铺满视口、超出裁剪——wasm-renderer 的背景 canvas 用。
    pub fn set_cover(&mut self) {
        self.mode = CameraMode::Cover;
    }

    /// 场景 clearcolor（**0-1 量级**——WE 颜色字段（ambientcolor/skylightcolor 同段）为
    /// 0-1，对齐 JS 版 `new THREE.Color(cc[0], cc[1], cc[2])`；cover 背景模式清屏用。
    /// 最终审查修复：原实现错误除 255（假设 0-255），EVA "0.7 0.7 0.7" 被压成 ≈0.0027 近黑。
    pub fn set_clear_color(&mut self, c: Option<[f32; 3]>) {
        self.clear_color = c;
    }

    /// 场景正交尺寸（load_scene 调用；render_frame 的 contain 相机范围计算用）。
    pub fn set_scene_size(&mut self, w: f32, h: f32) {
        self.scene_w = w.max(1.0);
        self.scene_h = h.max(1.0);
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        self.width = width.max(1);
        self.height = height.max(1);
        self.config.width = self.width;
        self.config.height = self.height;
        self.surface.configure(&self.device, &self.config);
    }

    /// 装载粒子规格并构建 GPU 粒子管线（**追加**而非覆盖——Task 9 修复：
    /// 原实现单系统覆盖，EVA 等壁纸 5 个粒子系统只有最后一个渲染，粒子密度远低于
    /// JS 版 → 画面偏暗）。origin 映射用场景尺寸（scene_w/scene_h），投影用相机
    /// 范围（camera_range）——对齐 scene-renderer.ts 语义。
    /// Task 9 审查修复：粒子池上限按 emitter rate×寿命动态估算（原固定 2048，
    /// 多粒子壁纸 GPU 负载爆炸 → headless FPS < 30）。
    /// 2026-08-21 铺满全屏改造：背景模糊层移除（前景单层 cover 渲染）→ 不再减半
    /// （减半原为背景层低密度优化；cover_max_particles 已删除）。
    /// Round 2 审查修复：先算 max_particles，再传入 from_spec 写 uniform —— 与
    /// ParticlePass::new 的 buffer 槽位、dispatch 分派**三处一致**
    /// （原 uniform 硬编码 2048 → 估算槽位下 shader 边界检查恒不触发 → 越界读写 UB）。
    pub fn set_particle(
        &mut self,
        spec: &ParticleSpec,
        origin: [f32; 3],
        scale: [f32; 3],
        tex: Option<wgpu::Texture>,
    ) {
        let (fw, fh) = self.camera_range();
        let max_particles = particle_pass::estimate_max_particles(spec);
        let params = particle_pass::EmitterParams::from_spec(
            spec, origin, scale, self.scene_w, self.scene_h, fw, fh, max_particles,
        );
        self.particle_passes.push(particle_pass::ParticlePass::new(
            &self.device,
            &self.queue,
            &params,
            max_particles,
            self.config.format,
            tex,
        ));
    }

    /// 解码后的纹理解码上传：创建 GPU 纹理（mip0，单层）并写入数据。
    /// 支持 RGBA8888 / DXT1/3/5（BC1/2/3）/ R8 / RG88；Unsupported 返回 None。
    ///
    /// 布局（`tex::copy_layout`，native 可测）：
    /// - bytes_per_row 显式 256 对齐（wgpu `COPY_BYTES_PER_ROW_ALIGNMENT`），
    ///   已对齐宽度直接借用 mip0（零拷贝），非对齐宽度按行补 padding 重打包；
    /// - rows_per_image 按格式区分：块压缩 = 块行数 ceil(h/4)，非压缩 = 高。
    pub fn upload_texture(&mut self, img: &crate::tex::TexImage) -> Option<wgpu::Texture> {
        // R8 灰度粒子纹理（fog1 等，2026-08-21 方案 A 修复）：对齐 WE ConvertTexture0Format
        // FORMAT_R8 语义（rgb 恒白 + alpha=灰度），上传前展开为 RGBA8(255,255,255,r)——
        // shader 统一 texel=(1,1,1,灰度)：颜色不调制、alpha 由纹理灰度调制（雾形状柔和）。
        // 直接采样 R8（WGSL 返回 (r,0,0,1)）→ rgb 变红且 alpha 无纹理调制（雾均匀偏浓）。
        let (format, r8_converted, layout) = if img.format == crate::tex::TexFormat::R8 {
            let rgba = crate::tex::r8_to_rgba_white_alpha(&img.mip0);
            let img8 = crate::tex::TexImage {
                width: img.width,
                height: img.height,
                format: crate::tex::TexFormat::Rgba8888,
                mip0: rgba,
            };
            let l = crate::tex::copy_layout(&img8)?;
            (texture::tex_format_to_wgpu(crate::tex::TexFormat::Rgba8888)?, Some(img8.mip0), l)
        } else {
            let f = texture::tex_format_to_wgpu(img.format)?;
            (f, None, crate::tex::copy_layout(img)?)
        };
        // Task 9 修复（防 panic）：BC(DXT) 格式需 texture-compression-bc feature；
        // adapter 不支持时跳过该纹理（返回 None，图片缺失但不中断 wasm 渲染）
        if matches!(img.format, crate::tex::TexFormat::Dxt1 | crate::tex::TexFormat::Dxt3 | crate::tex::TexFormat::Dxt5)
            && !self.device.features().contains(wgpu::Features::TEXTURE_COMPRESSION_BC)
        {
            web_sys::console::log_1(&wasm_bindgen::JsValue::from_str("[wasm] upload_texture: BC 纹理跳过（无 texture-compression-bc feature）"));
            return None;
        }
        let usage = wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST;
        let tex = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("we-tex"),
            size: wgpu::Extent3d {
                width: img.width.max(1),
                height: img.height.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: &[],
        });
        // 行字节 256 对齐：已对齐（needs_padding=false）直接借用源数据；
        // 否则每行拷贝 raw_row 字节并补 (bytes_per_row - raw_row) 零 padding。
        // 源数据：R8 转换后的 RGBA8（r8_converted）或原始 mip0。
        let src: &[u8] = r8_converted.as_deref().unwrap_or(&img.mip0);
        let mut padded: Vec<u8> = Vec::new();
        let data: &[u8] = if layout.needs_padding() {
            padded.reserve(layout.bytes_per_row as usize * layout.rows as usize);
            let len = src.len();
            for row in 0..layout.rows {
                let start = (row as usize * layout.raw_row as usize).min(len);
                let end = (start + layout.raw_row as usize).min(len);
                padded.extend_from_slice(&src[start..end]);
                padded.resize(padded.len() + (layout.bytes_per_row - layout.raw_row) as usize, 0);
            }
            &padded
        } else {
            src
        };
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(layout.bytes_per_row),
                rows_per_image: Some(layout.rows),
            },
            wgpu::Extent3d {
                width: img.width.max(1),
                height: img.height.max(1),
                depth_or_array_layers: 1,
            },
        );
        Some(tex)
    }

    /// 登记一张图片平面：创建 bind group（纹理+采样器）与 uniform buffer，
    /// 相同 asset_id 替换旧图（对齐 JS 版 scene-renderer setImageObject 的语义：
    /// 平面尺寸 = obj.size 优先、缺省回退纹理宽高；scale 直接缩放；origin 为场景中心点）。
    /// T4.3：tint_color/alpha/brightness 为对象调制输入（None = 缺省 → 无调制），
    /// 每帧 image_ndc 打包进 ImageUniform.tint（见 image_tint）。
    pub fn set_image(
        &mut self,
        asset_id: u32,
        tex: wgpu::Texture,
        origin: [f32; 3],
        scale: [f32; 3],
        size: Option<[f32; 2]>,
        tex_width: u32,
        tex_height: u32,
        tint_color: Option<[f32; 3]>,
        tint_alpha: Option<f32>,
        tint_brightness: Option<f32>,
    ) {
        self.images.retain(|im| im.asset_id != asset_id);
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
        let sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("image-sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        // uniform（binding 0）在 render_frame 每帧更新，这里先建 buffer 再并入 bind group
        let uniform_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("image-uniform"),
            size: std::mem::size_of::<ImageUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("image-bg"),
            layout: &self.image_pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });
        self.images.push(SceneImage {
            asset_id,
            tex,
            bind_group,
            uniform_buffer,
            origin,
            scale,
            size,
            tex_width,
            tex_height,
            tint_color,
            tint_alpha,
            tint_brightness,
        });
    }

    /// GPU 粒子模拟一帧（更新 uniform dt + dispatch compute）。
    pub fn step(&mut self, dt: f32) {
        for pass in &self.particle_passes {
            pass.step(&self.queue, dt);
        }
    }

    /// 渲染场景到 canvas。Task 9 修复：清屏后先绘制图片平面（contain 正交相机语义，
    /// 对齐 scene-renderer.ts），再叠加粒子点渲染层（加法混合）。
    pub fn render_frame(&mut self) {
        let frame = match self.surface.get_current_texture() {
            Ok(f) => f,
            Err(_) => return,
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        // 图片 uniform 先统一更新（避免 render pass 内同时可变借用 self.queue 与 self.images）
        if !self.images.is_empty() {
            let (fw, fh) = self.camera_range();
            let uniforms: Vec<ImageUniform> = self
                .images
                .iter()
                .map(|img| image_ndc(img, self.scene_w, self.scene_h, fw, fh))
                .collect();
            for (img, u) in self.images.iter().zip(&uniforms) {
                self.queue.write_buffer(&img.uniform_buffer, 0, bytemuck::bytes_of(u));
            }
        }
        // 清屏色：contain（前景）透明（透明区域露出背景 blur 层）；cover（背景）用场景
        // clearcolor（缺省 0x111114 深灰，对齐 JS 版 bgRenderer.setClearColor），避免背景暗黑
        let clear = match (self.mode, self.clear_color) {
            (CameraMode::Contain, _) => wgpu::Color::TRANSPARENT,
            (CameraMode::Cover, Some([r, g, b])) => wgpu::Color { r: r as f64, g: g as f64, b: b as f64, a: 1.0 },
            (CameraMode::Cover, None) => wgpu::Color { r: 0.067, g: 0.067, b: 0.078, a: 1.0 },
        };
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("scene"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(clear), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            // 图片平面：NDC 直接输出（中心/半宽由 CPU 按 contain 相机范围归一化，见 image_ndc）
            for img in &self.images {
                pass.set_pipeline(&self.image_pipeline);
                pass.set_bind_group(0, &img.bind_group, &[]);
                pass.draw(0..4, 0..1);
            }
            // pass 在块尾 drop，随后粒子渲染开启新的 render pass（不可嵌套）
        }
        // 粒子层（加法混合叠加在图片上；多粒子系统逐个渲染）
        for p in &self.particle_passes {
            p.render(&mut encoder, &view);
        }
        self.queue.submit([encoder.finish()]);
        frame.present();
    }

    /// contain/cover 相机范围（场景完整可见或铺满）——对齐 camera::contain_range/cover_range。
    #[cfg(feature = "render")]
    fn camera_range(&self) -> (f32, f32) {
        let aspect = self.width as f32 / self.height.max(1) as f32;
        match self.mode {
            CameraMode::Contain => camera::contain_range(self.scene_w, self.scene_h, aspect),
            CameraMode::Cover => camera::cover_range(self.scene_w, self.scene_h, aspect),
        }
    }
}

/// 图片 quad 的 NDC uniform。2026-08-20 方向修正：center 复用 coords::image_center_ndc
/// （内含 we_to_three——WE 左下原点、y 向上与渲染系同向，不做翻转；旧实现
/// `(oy - sh/2)` 符号相反、后又被误改为 `(sh/2 - oy)`，两者都把非居中对象上下镜像，
/// NERV logo 官方在右下角被渲染到右上角、Orange 部件被渲染到少女头顶；EVA 主图
/// oy=sh/2 恰为 0 故验收漏过）；half 复用 coords::image_half_ndc（尺寸 = obj.size
/// 优先、缺省回退纹理宽高；scale.y 不取负，对齐 scene-renderer.ts）。
/// T4.3：tint = image_tint(img.tint_color, img.tint_alpha, img.tint_brightness)
/// （color×brightness /255 → 0-1，alpha clamp 0-1；全缺省 → (1,1,1,1) 无调制）。
#[cfg(feature = "render")]
fn image_ndc(img: &SceneImage, sw: f32, sh: f32, fw: f32, fh: f32) -> ImageUniform {
    let (cx, cy) = coords::image_center_ndc(img.origin, sw, sh, fw, fh);
    let (hw, hh) = coords::image_half_ndc(img.size, img.scale, img.tex_width, img.tex_height, fw, fh);
    let tint = image_tint(img.tint_color, img.tint_alpha, img.tint_brightness);
    ImageUniform {
        center_x: cx,
        center_y: cy,
        half_w: hw,
        half_h: hh,
        tint_r: tint[0],
        tint_g: tint[1],
        tint_b: tint[2],
        tint_a: tint[3],
    }
}
