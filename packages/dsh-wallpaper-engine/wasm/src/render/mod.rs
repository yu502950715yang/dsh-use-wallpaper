//! wgpu 渲染器。cargo test（native，无 render feature）覆盖 camera 数学与
//! particle_pass 纯函数（参数打包/分派）；wgpu 管线代码仅在 wasm 构建
//! （--features render）编译，渲染验证在浏览器（headless Edge + CDP）。

pub mod camera;
pub mod particle_pass;
#[cfg(feature = "render")]
pub mod texture;

#[cfg(feature = "render")]
use crate::particle::ParticleSpec;

/// 相机沿 +z 放置的距离，使 shader 中 300/-mv.z = 1（点尺寸=像素尺寸，对齐 scene-renderer.ts 的 CAMERA_DISTANCE）
#[cfg(feature = "render")]
pub const CAMERA_DISTANCE: f32 = 300.0;

/// 场景图片对象：纹理 + 变换（纹理上传入口见 Task 7）
#[cfg(feature = "render")]
pub struct SceneImage {
    pub tex: wgpu::Texture,
    pub origin: [f32; 3],
    pub scale: [f32; 3],
    pub size: Option<[f32; 2]>,
}

#[cfg(feature = "render")]
pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    surface: wgpu::Surface<'static>,
    width: u32,
    height: u32,
    /// GPU 粒子模拟 + 点渲染管线（set_particle 后启用）
    particle_pass: Option<particle_pass::ParticlePass>,
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
        // wgpu 24 API 适配：request_device 增补第 2 参数 trace_path（None = 不追踪）
        let (device, queue) = adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("we-scene"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            memory_hints: wgpu::MemoryHints::Performance,
        }, None).await.map_err(|e| format!("request_device: {e}"))?;
        let caps = surface.get_capabilities(&adapter);
        let format = caps.formats.iter().copied().find(|f| f.is_srgb())
            .unwrap_or(caps.formats[0]);
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
        Ok(Renderer { device, queue, config, surface, width, height, particle_pass: None })
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        self.width = width.max(1);
        self.height = height.max(1);
        self.config.width = self.width;
        self.config.height = self.height;
        self.surface.configure(&self.device, &self.config);
    }

    /// 装载粒子规格并构建 GPU 粒子管线（坐标在 CPU 侧映射后打包进 uniform）。
    pub fn set_particle(&mut self, spec: &ParticleSpec, origin: [f32; 3], scale: [f32; 3], vw: f32, vh: f32) {
        let params = particle_pass::EmitterParams::from_spec(spec, origin, scale, vw, vh);
        self.particle_pass = Some(particle_pass::ParticlePass::new(
            &self.device,
            &self.queue,
            &params,
            2048,
            self.config.format,
        ));
    }

    /// 解码后的纹理解码上传：创建 GPU 纹理（mip0，单层）并写入数据。
    /// 支持 RGBA8888 / DXT1/3/5（BC1/2/3）/ R8 / RG88；Unsupported 返回 None。
    ///
    /// 布局计算（WebGPU texel-block 语义）：
    /// - 块压缩格式（BC1/2/3）每块 4x4 像素：bytes_per_row = 块列数 × 块字节数，
    ///   rows_per_image = 块行数 = ceil(h/4)；
    /// - 非压缩格式块为 1x1 像素：bytes_per_row = 宽 × 每像素字节数，
    ///   rows_per_image = 高（不能复用块行数——wgpu-core 校验
    ///   `rows_per_image >= height_in_blocks`，非压缩格式 height_in_blocks = h）。
    pub fn upload_texture(&mut self, img: &crate::tex::TexImage) -> Option<wgpu::Texture> {
        let format = texture::tex_format_to_wgpu(img.format)?;
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
        // 块压缩格式需按块对齐字节数（block_size: BC1=8、BC2/BC3=16、RGBA=4、RG88=2、R8=1）
        let block_size = match img.format {
            crate::tex::TexFormat::Dxt1 => 8u32,
            crate::tex::TexFormat::Dxt3 | crate::tex::TexFormat::Dxt5 => 16u32,
            crate::tex::TexFormat::Rgba8888 => 4u32,
            crate::tex::TexFormat::Rg88 => 2u32,
            crate::tex::TexFormat::R8 => 1u32,
            crate::tex::TexFormat::Unsupported(_) => return None,
        };
        let (block_w, block_h) = ((img.width.max(1) + 3) / 4, (img.height.max(1) + 3) / 4);
        let (bytes_per_row, rows_per_image) = match img.format {
            crate::tex::TexFormat::Dxt1
            | crate::tex::TexFormat::Dxt3
            | crate::tex::TexFormat::Dxt5 => (block_w * block_size, block_h.max(1)),
            _ => (img.width.max(1) * block_size, img.height.max(1)),
        };
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &img.mip0,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bytes_per_row),
                rows_per_image: Some(rows_per_image),
            },
            wgpu::Extent3d {
                width: img.width.max(1),
                height: img.height.max(1),
                depth_or_array_layers: 1,
            },
        );
        Some(tex)
    }

    /// GPU 粒子模拟一帧（更新 uniform dt + dispatch compute）。
    pub fn step(&mut self, dt: f32) {
        if let Some(pass) = &self.particle_pass {
            pass.step(&self.queue, dt);
        }
    }

    /// 渲染场景到 canvas。v1：清屏 + 粒子点渲染层（加法混合叠加）。
    pub fn render_frame(&mut self) {
        let frame = match self.surface.get_current_texture() {
            Ok(f) => f,
            Err(_) => return,
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("clear"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
        }
        if let Some(pass) = &self.particle_pass {
            pass.render(&mut encoder, &view);
        }
        self.queue.submit([encoder.finish()]);
        frame.present();
    }
}
