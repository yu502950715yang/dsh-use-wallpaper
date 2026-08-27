//! wgpu 渲染器。cargo test（native，无 render feature）覆盖 camera 数学与
//! particle_pass 纯函数（参数打包/分派）；wgpu 管线代码仅在 wasm 构建
//! （--features render）编译，渲染验证在浏览器（headless Edge + CDP）。

pub mod camera;
pub mod effect;
pub mod particle_pass;
#[cfg(feature = "render")]
pub mod effect_pass;
#[cfg(feature = "render")]
pub mod texture;

#[cfg(feature = "render")]
use crate::particle::ParticleSpec;
#[cfg(feature = "render")]
use crate::coords;

/// 相机沿 +z 放置的距离，使 shader 中 300/-mv.z = 1（点尺寸=像素尺寸，对齐 scene-renderer.ts 的 CAMERA_DISTANCE）
#[cfg(feature = "render")]
pub const CAMERA_DISTANCE: f32 = 300.0;

// Task3/M2：内置演示效果链的单 pass shader（vertex/fragment 分离，desktop GLSL 450）。
// 用途：跑通"效果链在 RT 上执行并输出"的工程验证（EffectChain 走 naga glsl_to_wgsl 编译）。
// 注意：naga 24 glsl frontend 尚不能编译 `sampler2D`（实证见报告疑虑），故本 MVP 演示 pass
// 用 g_Time + v_uv 生成**程序化**动画（非采样 g_Texture0），证明 ping-pong 执行器链路走通；
// 真实 WE 效果 shader 的纹理采样待 naga sampler2D 支持后接入后续任务。
#[cfg(feature = "render")]
const DEMO_EFFECT_VERT_GLSL: &str = r#"#version 450
layout(location=0) in vec2 a_Position;
layout(location=1) in vec2 a_TexCoord;
layout(location=0) out vec2 v_uv;
void main() {
    v_uv = a_TexCoord;
    gl_Position = vec4(a_Position, 0.0, 1.0);
}"#;

#[cfg(feature = "render")]
const DEMO_EFFECT_FRAG_GLSL: &str = r#"#version 450
layout(location=0) out vec4 o_Color;
layout(location=0) in vec2 v_uv;
layout(binding=0) uniform float g_Time;
void main() {
    float t = fract(g_Time * 0.25);
    float r = 0.5 + 0.5 * sin(v_uv.x * 6.28318 + t * 3.14159);
    float g = 0.5 + 0.5 * sin(v_uv.y * 6.28318 + t * 5.0);
    float b = 0.5 + 0.5 * cos((v_uv.x + v_uv.y) * 6.28318 + t * 7.0);
    o_Color = vec4(r, g, b, 1.0);
}"#;

/// 对象级效果链的 pass 描述（M3/Task5，task-8 编译链集成）。
/// `chain_desc` 现为**真实 WE 效果 pass 的 SPIR-V JSON 数组**（JS 侧 glsl-to-naga 产出）：
/// 每个元素一个 pass，含 `vert_spv`/`frag_spv`（SPIR-V bytes，入 `EffectChain` 经 spv_to_wgsl
/// 编译）、`uniforms`/`texture_slots`/`blend_mode`。解析成功且非空 → 用真实 pass；否则
/// **回退内置演示效果 pass**（g_Time 程序化，naga glsl-in 可编译——不采样 g_Texture0，因演示
/// shader 用纯程序化输出证明「对象 RT → 效果链 → 合成 quad → surface」链路走通），绝不白屏。
/// 注意：演示 shader 不采样内容纹理，故对象内容会被程序化动画**替代**（架构验证用；
/// 真实 shader 采样 g_Texture0 后内容保留）。
#[cfg(feature = "render")]
fn demo_object_effect_passes(chain_desc: &str) -> Vec<effect::EffectPassDesc> {
    if !chain_desc.is_empty() {
        if let Ok(descs) = serde_json::from_str::<Vec<effect::EffectPassDesc>>(chain_desc) {
            if !descs.is_empty() {
                // 解析成功且含 pass：return 真实效果 pass（spv 路径；空 spv 的 desc 由
                // EffectChain 经 compile_pass_wgsl 走 glsl 兜底）
                return descs;
            }
        }
        web_sys::console::log_1(&wasm_bindgen::JsValue::from_str(&format!(
            "[wasm] 效果链 chain_desc 解析失败/无 pass，回退内置演示 pass"
        )));
    }
    vec![effect::EffectPassDesc {
        vert_spv: vec![],
        frag_spv: vec![],
        vert_glsl: DEMO_EFFECT_VERT_GLSL.to_string(),
        frag_glsl: DEMO_EFFECT_FRAG_GLSL.to_string(),
        uniforms: vec![],
        texture_slots: vec![],
        blend_mode: "normal".to_string(),
    }]
}

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

/// 图片对象的动态状态（每帧可更新；与 wgpu 解耦，native 可测）。
/// 用于约束「update_image 一次更新应改哪些 SceneImage 字段」，便于 native 单测。
#[derive(Debug, Clone, PartialEq)]
pub struct ObjectState {
    pub origin: [f32; 3],
    pub scale: [f32; 3],
    pub tint_alpha: Option<f32>,
    pub tint_brightness: Option<f32>,
}

/// 对象内容 quad 渲染到**对象 RT** 的 NDC uniform（M3/Task5，native 可测）。
///
/// 对象级路径里，对象内容（图片/内容 mesh）在局部空间**中心原点**（对象中心 = 局部原点），
/// 局部正交相机范围 = 对象 RT 分辨率（rt 尺寸，1:1 像素）。故：
/// - NDC center = (0,0)（内容中心即局部原点，非场景 origin——场景 origin 在合成 quad 定位用）；
/// - NDC half = world/rt（**带符号**：负 scale 的镜像由内容 RT 承载，task-4.4「相机范围与
///   quad 帧用幅值、镜像活在 mesh/RT 内容」的职责分离——内容 half 保留符号产生镜像，合成
///   quad 帧用幅值）；
/// - tint = image_tint（对象 color/alpha/brightness 调制在**源内容**施加，合成 quad 不再二次调制）。
/// 与 `coords::image_half_ndc` 不同：这里 view 用对象 RT 尺寸（局部相机范围内），而非 surface 相机范围。
pub fn content_ndc(world_size: [f32; 2], rt_w: f32, rt_h: f32, tint: [f32; 4]) -> ImageUniform {
    ImageUniform {
        center_x: 0.0,
        center_y: 0.0,
        half_w: world_size[0] / rt_w,
        half_h: world_size[1] / rt_h,
        tint_r: tint[0],
        tint_g: tint[1],
        tint_b: tint[2],
        tint_a: tint[3],
    }
}

/// 把一次动态更新应用到对象状态（None = 保持现状）。
/// Renderer::update_image 对每个匹配的 SceneImage 做同样字段更新。
/// 拆成纯函数以便 native 测试（SceneImage 含 wgpu 类型，native 不可构造）。
pub fn apply_image_update(
    state: &mut ObjectState,
    origin: Option<[f32; 3]>,
    scale: Option<[f32; 3]>,
    alpha: Option<f32>,
    brightness: Option<f32>,
) {
    if let Some(o) = origin { state.origin = o; }
    if let Some(s) = scale { state.scale = s; }
    if let Some(a) = alpha { state.tint_alpha = Some(a); }
    if let Some(b) = brightness { state.tint_brightness = Some(b); }
}

/// 相机模式：前景 contain（完整显示、留白透明）/ 背景 cover（铺满、裁剪）——
/// 对齐 scene-renderer.ts 的 containRange/coverRange 与 background-layer 双 canvas 语义。
#[cfg(feature = "render")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CameraMode { Contain, Cover }

/// 对象级效果链的合成 quad GPU 资源（M3/Task5）。pipeline/layout 由 Renderer 共享
/// （`composite_pipeline`/`composite_layout`），本结构只存每对象各异的
/// uniform buffer（每帧更新 NDC/UV 窗口）+ 绑定了 out_view 的 bind group。
#[cfg(feature = "render")]
pub struct CompositeQuad {
    pub uniform_buffer: wgpu::Buffer,
    pub bind_group: wgpu::BindGroup,
}

/// 对象级效果链条目（M3/Task5）：每带效果对象一个。流水线：
/// 内容 → 对象 RT（content_view）→ 效果链 ping-pong（effect_chain，写 out_view）→
/// 合成 quad（composite，采样 out_view）→ surface。
/// 绝不白屏：效果链创建失败（effect_chain = None）时，`render_object_effects` 把内容
/// blit 到 out_view，合成 quad 采样原始内容（对象正常显示、无效果）。
#[cfg(feature = "render")]
pub struct ObjectEffectEntry {
    pub obj_id: u32,
    /// 对象内容（图片：纹理 + bind group + uniform buffer + 变换/tint），内容渲染进 RT 用。
    pub image: SceneImage,
    /// 对象内容 RT（image_pipeline 渲染内容的目标；效果链首 pass 的输入）。内容 RT 需
    /// COPY_SRC 供无链时 blit 到 out。
    pub content_tex: wgpu::Texture,
    pub content_view: wgpu::TextureView,
    /// 效果输出 RT（效果链末 pass 写 / 无链时 blit 内容；合成 quad 采样它）。out 需
    /// COPY_DST 供 blit + RENDER_ATTACHMENT 供效果链末 pass 写 + TEXTURE_BINDING 供合成 quad 采样。
    pub out_tex: wgpu::Texture,
    pub out_view: wgpu::TextureView,
    /// 局部正交相机范围 = 对象 RT 分辨率（1:1 像素，中心原点）；内容渲染 half 的分母（rt 尺寸）。
    pub camera_range: (f32, f32),
    /// 世界尺寸（size×scale，带符号——镜像由内容 RT 承载）。
    pub world_size: [f32; 2],
    /// 对象中心（WE 坐标，已 applyAlignment 换算中心；合成 quad NDC 定位用，不翻转 y）。
    pub origin: [f32; 3],
    /// 效果链 ping-pong 执行器（对象 RT 尺寸上；None = 创建失败 → 合成 quad 采样内容）。
    pub effect_chain: Option<effect::EffectChain>,
    /// 合成 quad（uniform buffer + bind group；pipeline/layout 共享）。
    pub composite: CompositeQuad,
}

/// M4/Task6：粒子对象的对象级效果链条目。与 `ObjectEffectEntry`（图片内容）机制一致：
/// 内容 → 对象 RT → 效果链 ping-pong → 合成 quad 贴回 surface。粒子内容不是静态纹理，
/// 而是 GPU 模拟管线（`ParticlePass`）每帧渲染到对象 RT；粒子的 compute 模拟（step）由
/// `Renderer::step` 驱动（与共享粒子系统同）。
/// 复用 Task5 的对象 RT/效果链/合成 quad 机制（非重复实现）；RT 尺寸用 `particle_object_range`
/// （无 distanceMax → 默认 64），合成 quad 世界尺寸用 `particle_world_size`（未钳制）。
/// 绝不白屏：效果链创建失败（effect_chain = None）时内容 blit 到 out_view，合成 quad 采样原始粒子内容。
#[cfg(feature = "render")]
pub struct ParticleObjectEffect {
    pub obj_id: u32,
    /// 粒子 GPU 模拟 + 渲染管线（set_particle_object_effect 建；step 驱动模拟，render 渲染到 content RT）。
    pub particle: particle_pass::ParticlePass,
    /// 粒子内容 RT（particle.render 渲染目标；效果链首 pass 输入；无链时 blit 到 out）。
    pub content_tex: wgpu::Texture,
    pub content_view: wgpu::TextureView,
    /// 效果输出 RT（效果链末 pass 写 / 无链时 blit 内容；合成 quad 采样）。
    pub out_tex: wgpu::Texture,
    pub out_view: wgpu::TextureView,
    /// 局部正交相机范围 = 对象 RT 分辨率（1:1 像素，中心原点）。
    pub camera_range: (f32, f32),
    /// 世界尺寸（distance_max × scale，带符号——镜像由 RT 内容/quad 半宽承担）。
    pub world_size: [f32; 2],
    /// 对象中心（WE 坐标，已 applyAlignment 换算中心；合成 quad NDC 定位，不翻转 y）。
    pub origin: [f32; 3],
    /// 效果链 ping-pong 执行器（对象 RT 尺寸上；None = 创建失败 → 合成 quad 采样内容）。
    pub effect_chain: Option<effect::EffectChain>,
    /// 合成 quad（uniform buffer + bind group；pipeline/layout 共享）。
    pub composite: CompositeQuad,
}

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
    /// 效果链全屏 quad 管线基线（Task2）。当前 0..1 个透传测试 pass（对象级效果链基线的
    /// 可渲染工程验证）；Task3+ 扩展为对象级效果链（EffectChain/ping-pong/uniform）。
    effect_passes: Vec<effect_pass::EffectPass>,
    /// `@group(0)` 的 bind group layout（binding 0 = texture_2d, binding 1 = sampler），
    /// 效果链各层复用。调用方（render_frame）按当前输入纹理创建 bind group 后传入 render。
    effect_layout: wgpu::BindGroupLayout,
    /// 离屏"自采"纹理：场景先渲染到离屏，透传 pass 采样并输出到 surface（读自采渲染，
    /// 验证 wasm 工程串通、不黑屏）。尺寸/格式与 surface 一致，避免 surface 当帧自依赖。
    /// **仅当 effect_passes 非空（effect pass 创建成功）时才分配**——Task2 修复：
    /// 原实现无条件分配，effect 失败时这些资源闲置浪费。Option 表达「可能未分配」。
    offscreen_tex: Option<wgpu::Texture>,
    offscreen_view: Option<wgpu::TextureView>,
    offscreen_sampler: Option<wgpu::Sampler>,
    /// 对象级效果链条目（M3/Task5）：每带效果对象一个。`set_object_effect` 登记，
    /// `render_object_effects` 每帧驱动（内容→对象RT→效果链），`render_frame` 合成 quad 贴 surface。
    object_effects: Vec<ObjectEffectEntry>,
    /// 粒子对象级效果链条目（M4/Task6）：每带效果粒子对象一个。`set_particle_object_effect`
    /// 登记（粒子内容经对象 RT + 效果链 + 合成 quad），`render_object_effects` 每帧驱动，
    /// `render_frame` 合成 quad 贴 surface。复用 Task5 对象级管线机制（RT/效果链/合成 quad）。
    particle_object_effects: Vec<ParticleObjectEffect>,
    /// 对象合成 quad 管线（wasm 内置 WGSL composite.wgsl；pipeline/layout 共享，
    /// uniform/bind group 每对象各存于 ObjectEffectEntry.composite）。
    composite_pipeline: wgpu::RenderPipeline,
    composite_layout: wgpu::BindGroupLayout,
    /// 帧时间（秒，从 0 起；step(dt) 累计），供效果链 g_Time 每帧更新。
    time: f32,
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
        // == 对象合成 quad 管线（M3/Task5，wasm 内置 WGSL composite.wgsl）==
        // bind group layout：binding 0 = CompositeUniform（vertex 读 NDC 中心/半宽 + UV 窗口），
        // binding 1 = texture_2d（采样对象 RT/效果输出），binding 2 = sampler（fragment）。
        // vs 用 vertex_index 推导角点（无顶点缓冲，同 image.wgsl 模式）；alpha 混合（透明边缘
        // 露背景层，对齐 image 管线）。pipeline/layout 共享，uniform/bind group 每对象各存。
        let composite_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("composite-bgl"),
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
        let composite_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("composite-pl"),
            bind_group_layouts: &[&composite_bgl],
            push_constant_ranges: &[],
        });
        let composite_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("composite.wgsl"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/composite.wgsl").into()),
        });
        let composite_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("composite-render"),
            layout: Some(&composite_pl),
            vertex: wgpu::VertexState {
                module: &composite_shader,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &composite_shader,
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
        // == 效果链全屏 quad 管线基线（Task2）==
        // `@group(0)` bind group layout：binding 0 = texture_2d, binding 1 = sampler
        // （对齐 effect_passthrough.wgsl 的 @group(0) @binding(0/1)；效果链各层复用）。
        let effect_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("effect-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        // 透传测试 pass：创建失败 => EffectPass::new 返回 Err => effect_passes 留空，
        // render_frame 跳过该 pass 走兜底（直接渲染 surface），绝不黑屏。
        let mut effect_passes = Vec::new();
        let effect_wgsl = include_str!("../shaders/effect_passthrough.wgsl");
        match effect_pass::EffectPass::new(&device, effect_wgsl, format, effect_layout.clone()).await {
            Ok(p) => {
                web_sys::console::log_1(&wasm_bindgen::JsValue::from_str("[wasm] effect pass 创建成功"));
                effect_passes.push(p);
            }
            Err(e) => web_sys::console::log_1(&wasm_bindgen::JsValue::from_str(&format!(
                "[wasm] effect pass 创建失败，跳过（兜底直接渲染 surface）：{e}"
            ))),
        }
        // == 全局 demo 效果链（Task3/M2 遗留，Critical #1 已移除）==
        // 原实现在此无条件用内置**程序化**单 pass（g_Time 驱动、不采样 g_Texture0）建一个
        // 全局全屏 effect_chain，并在 render_frame 第一分支 `if self.effect_chain.is_some()`
        // 恒优先把它覆盖到所有走 wasm 的场景上——导致**无 effects 的纯图片/粒子壁纸**
        // 也被程序化动画覆盖（内容丢失回归，比白屏更隐蔽）。
        // 对象级效果链（set_object_effect / set_particle_object_effect 的对象 RT+效果链+
        // 合成 quad）已独立落地，由 render_object_effects + draw_scene_into 的合成 quad
        // 直接驱动，与此全局链无关（其 effect_chain 存于各 ObjectEffectEntry /
        // ParticleObjectEffect 条目内）。故彻底移除该全局 effect_chain 字段与创建点：
        // 无 effects 场景不再被覆盖，保留场景/图片/粒子内容；对象级链条目继续正常工作。
        // 效果链执行器"在 RT 上执行"的架构证明保留在对象级链上（见 ObjectEffectEntry /
        // ParticleObjectEffect），本全局链不再参与正常场景渲染。
        // 离屏"自采"纹理（尺寸/格式与 surface 一致）：场景先渲染到离屏，再由透传 pass
        // 采样输出到 surface——读自采渲染验证 wasm 工程串通，避免 surface 当帧自依赖。
        // Fix：仅当效果链透传 pass 创建成功（effect_passes 非空）才分配；无 effects 场景
        // 走透传/直接渲染 surface（保留内容）。全局 demo effect_chain（Critical #1）已移除，
        // 不再作为离屏分配的前置条件。
        let (offscreen_tex, offscreen_view, offscreen_sampler) =
            if !effect_passes.is_empty() {
            let tex = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("effect-offscreen"),
                size: wgpu::Extent3d { width: config.width, height: config.height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
            let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("effect-offscreen-sampler"),
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            });
            (Some(tex), Some(view), Some(sampler))
        } else {
            (None, None, None)
        };
        Ok(Renderer {
            device, queue, config, surface, width, height,
            particle_passes: Vec::new(),
            scene_w: width as f32,
            scene_h: height as f32,
            mode: CameraMode::Contain,
            clear_color: None,
            images: Vec::new(),
            image_pipeline,
            effect_passes,
            effect_layout,
            offscreen_tex,
            offscreen_view,
            offscreen_sampler,
            object_effects: Vec::new(),
            particle_object_effects: Vec::new(),
            composite_pipeline,
            composite_layout: composite_bgl,
            time: 0.0,
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
        // 重建离屏自采纹理（尺寸与 surface 一致；Task2 效果管线输入需要，防旧尺寸失配）。
        // Fix：仅当 effect pass 存在（effect_passes 非空）才重建，否则保持 None（不闲置）。
        // offscreen_sampler 不依赖尺寸，无需重建。
        if !self.effect_passes.is_empty() {
            self.offscreen_tex = Some(self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("effect-offscreen"),
                size: wgpu::Extent3d { width: self.width, height: self.height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: self.config.format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            }));
            self.offscreen_view = self.offscreen_tex
                .as_ref()
                .map(|t| t.create_view(&wgpu::TextureViewDescriptor::default()));
        }
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

    /// 每帧更新一个图片对象的状态（origin/scale/alpha/brightness）。
    /// None = 保持现状；asset_id 找不到 → no-op（防御对象未注册/已卸载）。
    /// 字段更新语义与 apply_image_update 完全一致（后者是 native 可测的纯函数版本）。
    pub fn update_image(
        &mut self,
        asset_id: u32,
        origin: Option<[f32; 3]>,
        scale: Option<[f32; 3]>,
        alpha: Option<f32>,
        brightness: Option<f32>,
    ) {
        if let Some(img) = self.images.iter_mut().find(|im| im.asset_id == asset_id) {
            if let Some(o) = origin { img.origin = o; }
            if let Some(s) = scale { img.scale = s; }
            if let Some(a) = alpha { img.tint_alpha = Some(a); }
            if let Some(b) = brightness { img.tint_brightness = Some(b); }
        }
        // 对象级效果链条目（M3/Task5）：带效果对象的内容已从 images 移到 object_effects，
        // 脚本灌回（T5）需同步更新其 SceneImage——否则对象效果路径的对象不动画。
        if let Some(entry) = self.object_effects.iter_mut().find(|e| e.obj_id == asset_id) {
            let img = &mut entry.image;
            if let Some(o) = origin { img.origin = o; }
            if let Some(s) = scale { img.scale = s; }
            if let Some(a) = alpha { img.tint_alpha = Some(a); }
            if let Some(b) = brightness { img.tint_brightness = Some(b); }
        }
    }

    /// 登记一个对象级效果链条目（M3/Task5）。被登记对象走「内容 → 对象 RT → 效果链 → 合成 quad」。
    ///
    /// 对象内容（图片）需**先**经 `set_image`（load_image）上传——本方法据 `obj_id` 找到对应
    /// `SceneImage`，从共享 `images` 列表移除（不再直接渲染 surface），并建立对象内容 RT /
    /// 效果输出 RT / 效果链（演示 pass）/ 合成 quad。
    ///
    /// - `origin`：对象中心（WE 坐标，已 applyAlignment 换算中心；合成 quad NDC 定位，不翻转 y）。
    /// - `world_size`：`size×scale`（带符号——镜像由内容 RT 承载）。
    /// - `rt_size`：`object_camera_range` 钳制后分辨率（局部正交相机范围 = RT 尺寸，1:1 像素）。
    /// - `chain_desc`：效果链 pass 描述（JSON，真实 WE shader 的 SPIR-V 数组）。task-8 编译链
    ///   已集成：JS 侧 glsl-to-naga 产出 SPIR-V bytes 传入，本方法经 `demo_object_effect_passes`
    ///   解析为 `Vec<EffectPassDesc>`（spv 路径）；解析失败/为空 → 回退内置演示 pass，绝不白屏。
    ///
    /// 绝不白屏：找不到对象内容 / 效果链创建失败 → 不崩溃（对象回退共享路径 / 合成 quad
    /// 采样内容纹理），本方法返回 `Ok`（零副作用），调用方继续渲染。
    pub async fn set_object_effect(
        &mut self,
        obj_id: u32,
        origin: Vec<f32>,
        world_size: Vec<f32>,
        rt_size: Vec<f32>,
        chain_desc: &str,
    ) -> Result<(), String> {
        // ① 找已上传的对象内容（SceneImage）。找不到 → 回退共享路径（零副作用，绝不白屏）。
        let Some(idx) = self.images.iter().position(|im| im.asset_id == obj_id) else {
            web_sys::console::log_1(&wasm_bindgen::JsValue::from_str(&format!(
                "[wasm] set_object_effect {obj_id}: 无已上传内容（SceneImage 缺失），回退共享路径"
            )));
            return Ok(());
        };
        let image = self.images.remove(idx);
        // ② 世界尺寸（带符号）与对象 RT 尺寸：JS 传参优先；不完整则从对象内容推导
        //   （size 优先、缺省纹理宽高 × scale，对齐 set_image 的 world 尺寸语义——无 size
        //   对象（如粒子）不退化到 1px，与 objectCameraRange 的下钳制 1 区分：RT 钳 1 是保护，
        //   world 尺寸仍按内容算）。rt_size 缺省 → object_camera_range（钳制到 OBJECT_RT_MAX）。
        let (sw, sh) = image.size
            .map(|s| (s[0], s[1]))
            .unwrap_or((image.tex_width as f32, image.tex_height as f32));
        let wsize = if world_size.len() >= 2 {
            [world_size[0], world_size[1]]
        } else {
            [sw * image.scale[0], sh * image.scale[1]]
        };
        let rt_size_eff = if rt_size.len() >= 2 {
            [rt_size[0], rt_size[1]]
        } else {
            effect::object_camera_range([sw, sh], [image.scale[0], image.scale[1]])
        };
        let rt_w = (rt_size_eff[0].max(0.0).round() as u32).clamp(1, effect::OBJECT_RT_MAX as u32);
        let rt_h = (rt_size_eff[1].max(0.0).round() as u32).clamp(1, effect::OBJECT_RT_MAX as u32);
        let origin3 = [
            origin.first().copied().unwrap_or_else(|| image.origin[0]),
            origin.get(1).copied().unwrap_or_else(|| image.origin[1]),
            origin.get(2).copied().unwrap_or_else(|| image.origin[2]),
        ];
        // ③ 内容 RT（COPY_SRC 供无链时 blit）+ 输出 RT（COPY_DST 供 blit、RENDER_ATTACHMENT
        //    供效果链末 pass 写、TEXTURE_BINDING 供合成 quad 采样）。
        let content_tex = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("object-content"),
            size: wgpu::Extent3d { width: rt_w, height: rt_h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.config.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let content_view = content_tex.create_view(&wgpu::TextureViewDescriptor::default());
        let out_tex = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("object-out"),
            size: wgpu::Extent3d { width: rt_w, height: rt_h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.config.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let out_view = out_tex.create_view(&wgpu::TextureViewDescriptor::default());
        // ④ 效果链（内置演示 pass 兜底；创建失败 → None → 合成 quad 采样内容，绝不白屏）。
        let chain_passes = demo_object_effect_passes(chain_desc);
        let effect_chain = match effect::EffectChain::new(
            &self.device, &self.queue, chain_passes, self.config.format, rt_w, rt_h,
        ).await {
            Ok(c) => {
                web_sys::console::log_1(&wasm_bindgen::JsValue::from_str(&format!(
                    "[wasm] set_object_effect {obj_id}: 对象效果链创建成功（rt {rt_w}x{rt_h}）"
                )));
                Some(c)
            }
            Err(e) => {
                web_sys::console::log_1(&wasm_bindgen::JsValue::from_str(&format!(
                    "[wasm] set_object_effect {obj_id}: 对象效果链创建失败（{e}），合成 quad 采样内容兜底"
                )));
                None
            }
        };
        // ⑤ 合成 quad：sampler + uniform buffer + bind group（复用 shared composite_layout）。
        let sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("object-composite-sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            // UV 窗口外侧超出 [0,1] 夹到边（对齐 JS 默认 ClampToEdgeWrapping，见 composite.wgsl）
            ..Default::default()
        });
        let uniform_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("object-composite-uniform"),
            size: std::mem::size_of::<effect::CompositeUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("object-composite-bg"),
            layout: &self.composite_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&out_view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&sampler) },
            ],
        });
        let entry = ObjectEffectEntry {
            obj_id,
            image,
            content_tex,
            content_view,
            out_tex,
            out_view,
            camera_range: (rt_w as f32, rt_h as f32),
            world_size: wsize,
            origin: origin3,
            effect_chain,
            composite: CompositeQuad { uniform_buffer, bind_group },
        };
        // 同 obj_id 替换（重设），保持对象顺序稳定（合成 quad z 层按登记顺序）
        self.object_effects.retain(|e| e.obj_id != obj_id);
        self.object_effects.push(entry);
        Ok(())
    }

    /// 登记一个粒子对象的对象级效果链条目（M4/Task6）。带 `effects` 的粒子对象走
    /// 「粒子内容 → 对象 RT → 效果链 ping-pong → 合成 quad」——与 `set_object_effect`
    /// （图片对象）共用 Task5 的对象级管线机制（对象 RT/效果链/合成 quad），只是内容源
    /// 是 GPU 粒子模拟（`ParticlePass`）而非静态纹理。粒子不再直接渲染到 surface，
    /// 改渲染进对象 RT。
    ///
    /// - `origin`：粒子对象中心（WE 坐标，已 applyAlignment 换算中心；合成 quad NDC 定位）。
    /// - `world_size`：粒子对象合成 quad 世界尺寸（**未钳制** distance_max × scale）；缺省 →
    ///   `particle_world_size`（distanceMax 缺省 64）。
    /// - `rt_size`：对象 RT 分辨率（`particle_object_range` 钳制后）；缺省 →
    ///   `particle_object_range`（无 distanceMax 默认 64，钳 1..2048）。
    /// - `chain_desc`：效果链 pass 描述（JSON，真实 WE shader 的 SPIR-V 数组）。task-8 编译链
    ///   已集成：JS 侧产出 SPIR-V 传入（同 `set_object_effect`），本方法经 `demo_object_effect_passes`
    ///   解析；失败/为空 → 回退内置演示 pass，绝不白屏。
    /// - 粒子模拟（compute）由 `step` 驱动；内容渲染进对象 RT 在 `render_object_effects`。
    ///
    /// 绝不白屏：效果链创建失败 → 合成 quad 采样原始粒子内容（对象正常显示、无效果）。
    pub async fn set_particle_object_effect(
        &mut self,
        obj_id: u32,
        spec: &ParticleSpec,
        origin: [f32; 3],
        scale: [f32; 3],
        tex: Option<wgpu::Texture>,
        world_size: Vec<f32>,
        rt_size: Vec<f32>,
        chain_desc: &str,
    ) -> Result<(), String> {
        // ① 世界尺寸（未钳制）与对象 RT 尺寸：JS 传参优先；缺省用 particle 纯函数推导
        //   （distanceMax 缺省 64）。world 用 particle_world_size（带符号未钳制），
        //   rt 用 particle_object_range（幅值钳制）——钳制只发生在 RT 范围。
        let wsize = if world_size.len() >= 2 {
            [world_size[0], world_size[1]]
        } else {
            effect::particle_world_size(Some(spec.emitter.distance_max), [scale[0], scale[1]])
        };
        let eff_rt = if rt_size.len() >= 2 {
            [rt_size[0], rt_size[1]]
        } else {
            effect::particle_object_range(Some(spec.emitter.distance_max), [scale[0], scale[1]])
        };
        let rt_w = (eff_rt[0].max(0.0).round() as u32).clamp(1, effect::OBJECT_RT_MAX as u32);
        let rt_h = (eff_rt[1].max(0.0).round() as u32).clamp(1, effect::OBJECT_RT_MAX as u32);
        // ② 粒子内容 RT（COPY_SRC 供无链时 blit）+ 输出 RT（COPY_DST 供 blit、
        //    RENDER_ATTACHMENT 供效果链末 pass 写、TEXTURE_BINDING 供合成 quad 采样）。
        let content_tex = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("particle-object-content"),
            size: wgpu::Extent3d { width: rt_w, height: rt_h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.config.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let content_view = content_tex.create_view(&wgpu::TextureViewDescriptor::default());
        let out_tex = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("particle-object-out"),
            size: wgpu::Extent3d { width: rt_w, height: rt_h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.config.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let out_view = out_tex.create_view(&wgpu::TextureViewDescriptor::default());
        // ③ 效果链（内置演示 pass 兜底；创建失败 → None → 合成 quad 采样内容，绝不白屏）。
        let chain_passes = demo_object_effect_passes(chain_desc);
        let effect_chain = match effect::EffectChain::new(
            &self.device, &self.queue, chain_passes, self.config.format, rt_w, rt_h,
        ).await {
            Ok(c) => {
                web_sys::console::log_1(&wasm_bindgen::JsValue::from_str(&format!(
                    "[wasm] set_particle_object_effect {obj_id}: 粒子对象效果链创建成功（rt {rt_w}x{rt_h}）"
                )));
                Some(c)
            }
            Err(e) => {
                web_sys::console::log_1(&wasm_bindgen::JsValue::from_str(&format!(
                    "[wasm] set_particle_object_effect {obj_id}: 粒子对象效果链创建失败（{e}），合成 quad 采样内容兜底"
                )));
                None
            }
        };
        // ④ 合成 quad：sampler + uniform buffer + bind group（复用 shared composite_layout）。
        let sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("particle-object-composite-sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let uniform_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("particle-object-composite-uniform"),
            size: std::mem::size_of::<effect::CompositeUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("particle-object-composite-bg"),
            layout: &self.composite_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&out_view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&sampler) },
            ],
        });
        // ⑤ 粒子 GPU 模拟 + 渲染管线（build 渲染到对象 RT）。投影用**对象局部相机**——
        //    局部坐标中心原点（对象中心）、view = 对象 RT 尺寸（1:1 像素，对齐 image
        //    对象级管线的局部正交相机 `content_ndc`），而**非**场景相机范围 + scene_w/h
        //    （final whole-branch review I3：原实现造成粒子内容在对象 RT 内「投影双重
        //    映射」近似错位）。原点在局部空间为 (0,0,0)——粒子发射器即对象中心。
        let max_particles = particle_pass::estimate_max_particles(spec);
        let params = particle_pass::EmitterParams::from_spec_local(
            spec, scale, rt_w as f32, rt_h as f32, max_particles,
        );
        let particle = particle_pass::ParticlePass::new(
            &self.device, &self.queue, &params, max_particles, self.config.format, tex,
        );
        let origin3 = [origin[0], origin[1], origin[2]];
        let entry = ParticleObjectEffect {
            obj_id,
            particle,
            content_tex,
            content_view,
            out_tex,
            out_view,
            camera_range: (rt_w as f32, rt_h as f32),
            world_size: wsize,
            origin: origin3,
            effect_chain,
            composite: CompositeQuad { uniform_buffer, bind_group },
        };
        // 同 obj_id 替换（重设），保持对象顺序稳定（合成 quad z 层按登记顺序）。
        self.particle_object_effects.retain(|e| e.obj_id != obj_id);
        self.particle_object_effects.push(entry);
        Ok(())
    }

    /// 每帧驱动所有对象级效果链条目（M3/Task5）。对每个条目：
    /// ① 更新内容 uniform（center=(0,0)，half=world/rt，tint）→ 写到 image.uniform_buffer；
    /// ② 渲染对象内容到内容 RT（image_pipeline，局部相机中心原点）；
    /// ③ 效果链 ping-pong（读内容 RT 写输出 RT）；链失败 → blit 内容到输出 RT。
    /// 合成 quad 贴 surface 由 `render_frame`（每帧先调本方法，再画场景+合成 quad）。
    /// 本方法的产物 = 每条目的输出 RT（out_view）已含对象内容/效果输出，供合成 quad 采样。
    ///
    /// JS 侧每帧顺序：`scene.step(dt); scene.render();`（render 内部先调本方法）。
    pub fn render_object_effects(&mut self) {
        if self.object_effects.is_empty() && self.particle_object_effects.is_empty() {
            return;
        }
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        let time = self.time;
        for i in 0..self.object_effects.len() {
            // ① 更新内容 uniform（只读借用 image 字段 + queue 字段）
            {
                let (wsize, cam) = (self.object_effects[i].world_size, self.object_effects[i].camera_range);
                let img = &self.object_effects[i].image;
                let tint = image_tint(img.tint_color, img.tint_alpha, img.tint_brightness);
                let u = content_ndc(wsize, cam.0, cam.1, tint);
                self.queue.write_buffer(&img.uniform_buffer, 0, bytemuck::bytes_of(&u));
            }
            // ② 渲染对象内容到内容 RT（局部相机中心原点，uniform 已提前更新）
            {
                let img = &self.object_effects[i].image;
                let cv = self.object_effects[i].content_view.clone();
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("object-content"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &cv,
                        resolve_target: None,
                        ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
                pass.set_pipeline(&self.image_pipeline);
                pass.set_bind_group(0, &img.bind_group, &[]);
                pass.draw(0..4, 0..1);
            }
            // ③ 效果链 ping-pong（读内容 RT 写输出 RT）；链失败 → blit 内容到输出 RT
            {
                let cv = self.object_effects[i].content_view.clone();
                let ov = self.object_effects[i].out_view.clone();
                if let Some(chain) = &mut self.object_effects[i].effect_chain {
                    chain.render(&mut encoder, &cv, &ov, time);
                } else {
                    let (rw, rh) = self.object_effects[i].camera_range;
                    encoder.copy_texture_to_texture(
                        wgpu::TexelCopyTextureInfo {
                            texture: &self.object_effects[i].content_tex,
                            mip_level: 0,
                            origin: wgpu::Origin3d::ZERO,
                            aspect: wgpu::TextureAspect::All,
                        },
                        wgpu::TexelCopyTextureInfo {
                            texture: &self.object_effects[i].out_tex,
                            mip_level: 0,
                            origin: wgpu::Origin3d::ZERO,
                            aspect: wgpu::TextureAspect::All,
                        },
                        wgpu::Extent3d { width: rw as u32, height: rh as u32, depth_or_array_layers: 1 },
                    );
                }
            }
        }
        // M4/Task6：粒子对象级效果链（内容渲染进对象 RT + 效果链）。粒子内容不是静态纹理，
        // 而是 GPU 模拟管线每帧渲染——渲染前先把内容 RT 清透明（粒子 render 是加法叠加），
        // 再调 ParticlePass::render 到 content_view，随后效果链 ping-pong / blit 到输出 RT。
        // 合成 quad 贴回 surface 由 draw_scene_into（render_frame）完成。
        for i in 0..self.particle_object_effects.len() {
            let cv = self.particle_object_effects[i].content_view.clone();
            let ov = self.particle_object_effects[i].out_view.clone();
            // ① 清空内容 RT（局部相机中心原点，透明底）。_pass 仅用于在块尾 drop 提交 clear；
            // 下划线前缀避免 unused 告警（pipeline/bind_group 均未设置，纯 clear）。
            {
                let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("particle-object-clear"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &cv,
                        resolve_target: None,
                        ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
            }
            // ② 粒子渲染到内容 RT（加法叠加；内容 RT 已提前清空）
            self.particle_object_effects[i].particle.render(&mut encoder, &cv);
            // ③ 效果链 ping-pong（读内容 RT 写输出 RT）；链失败 → blit 内容到输出 RT
            if let Some(chain) = &mut self.particle_object_effects[i].effect_chain {
                chain.render(&mut encoder, &cv, &ov, time);
            } else {
                let (rw, rh) = self.particle_object_effects[i].camera_range;
                encoder.copy_texture_to_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &self.particle_object_effects[i].content_tex,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::TexelCopyTextureInfo {
                        texture: &self.particle_object_effects[i].out_tex,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::Extent3d { width: rw as u32, height: rh as u32, depth_or_array_layers: 1 },
                );
            }
        }
        self.queue.submit([encoder.finish()]);
    }

    /// GPU 粒子模拟一帧（更新 uniform dt + dispatch compute）。
    pub fn step(&mut self, dt: f32) {
        // 累计帧时间（供效果链 g_Time 每帧更新；JS 每帧固定调用 step(1/60)）
        self.time += dt;
        let queue = &self.queue;
        for pass in &self.particle_passes {
            pass.step(queue, dt);
        }
        // M4/Task6：粒子对象级效果链条目的粒子模拟（compute dispatch）也要每帧驱动，
        // 与共享粒子系统同步（step 独立提交 compute）。两个不可变借用（queue + 条目）可并存。
        for entry in &self.particle_object_effects {
            entry.particle.step(queue, dt);
        }
    }

    /// 渲染场景到 canvas。Task 9 修复：清屏后先绘制图片平面（contain 正交相机语义，
    /// 对齐 scene-renderer.ts），再叠加粒子点渲染层（加法混合）。
    /// Task2 效果链：若 effect_passes 非空，把场景渲染到离屏"自采"纹理，再由透传 pass
    /// 采样输出到 surface（读自采渲染，验证 wasm 工程串通、不黑屏）；若 effect pass
    /// 创建失败（effect_passes 空），兜底直接渲染场景到 surface（绝不黑屏）。
    /// M3/Task5：开头先驱动对象级效果链（`render_object_effects`：每个带效果对象
    /// 内容→对象RT→效果链→输出RT），随后场景绘制时合成 quad 采样各输出RT贴回 surface。
    pub fn render_frame(&mut self) {
        // 对象级效果链：先算好各对象输出 RT（独立 encoder submit），合成 quad 才能采样最新结果。
        self.render_object_effects();
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
        // 对象合成 quad uniform（M3/Task5 + M4/Task6）：NDC 中心/半宽（surface 相机范围）+
        // UV 窗口展开。每帧更新（相机范围/场景尺寸依赖视口），uniform buffer 内容变，bind group 复用。
        // 图片对象条目与粒子对象条目共用 `composite_ndc_uniform`（world_size/rt_size/origin 均属各自条目）。
        if !self.object_effects.is_empty() || !self.particle_object_effects.is_empty() {
            let (fw, fh) = self.camera_range();
            let mut i = 0;
            while i < self.object_effects.len() {
                let entry = &self.object_effects[i];
                let u = effect::composite_ndc_uniform(
                    entry.origin,
                    entry.world_size,
                    [entry.camera_range.0, entry.camera_range.1],
                    self.scene_w, self.scene_h, fw, fh,
                );
                self.queue.write_buffer(&entry.composite.uniform_buffer, 0, bytemuck::bytes_of(&u));
                i += 1;
            }
            let mut j = 0;
            while j < self.particle_object_effects.len() {
                let entry = &self.particle_object_effects[j];
                let u = effect::composite_ndc_uniform(
                    entry.origin,
                    entry.world_size,
                    [entry.camera_range.0, entry.camera_range.1],
                    self.scene_w, self.scene_h, fw, fh,
                );
                self.queue.write_buffer(&entry.composite.uniform_buffer, 0, bytemuck::bytes_of(&u));
                j += 1;
            }
        }
        // 清屏色：contain（前景）透明（透明区域露出背景 blur 层）；cover（背景）用场景
        // clearcolor（缺省 0x111114 深灰，对齐 JS 版 bgRenderer.setClearColor），避免背景暗黑
        let clear = match (self.mode, self.clear_color) {
            (CameraMode::Contain, _) => wgpu::Color::TRANSPARENT,
            (CameraMode::Cover, Some([r, g, b])) => wgpu::Color { r: r as f64, g: g as f64, b: b as f64, a: 1.0 },
            (CameraMode::Cover, None) => wgpu::Color { r: 0.067, g: 0.067, b: 0.078, a: 1.0 },
        };

        if !self.effect_passes.is_empty() {
            // 效果链透传（Task2 基线）：场景渲染到离屏自采，再透传输出到 surface。
            // effect_passes 非空 => 离屏资源已在 new 时分配，unwrap 安全。
            // 注（Critical #1）：原本此处的第一分支是全局 demo effect_chain（单 pass
            // 程序化动画、不采样 g_Texture0、normal blend+alpha=1 全覆盖）——恒优先覆盖
            // 所有走 wasm 的场景（含无 effects 的纯图片/粒子壁纸），造成内容丢失回归。
            // 已移除全局链：无 effects 场景现在只走本透传分支（透传 preserve 输入内容）
            // 或下方"直接渲染 surface"兜底，均保留场景内容；对象级链（object_effects /
            // particle_object_effects）由 render_object_effects + draw_scene_into 合成 quad
            // 独立驱动，不受影响。
            let offscreen_view = self.offscreen_view.as_ref().expect("effect pass 存在时离屏纹理已分配");
            let offscreen_sampler = self.offscreen_sampler.as_ref().expect("effect pass 存在时离屏采样器已分配");
            let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("effect-input-bg"),
                layout: &self.effect_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(offscreen_view) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(offscreen_sampler) },
                ],
            });
            // 渲染场景到离屏（读自采渲染）
            self.draw_scene_into(&mut encoder, offscreen_view, clear);
            // 透传离屏 → surface
            let pass = &mut self.effect_passes[0];
            pass.render(&mut encoder, offscreen_view, &view, &bg);
        } else {
            // 兜底：无 effect pass（创建失败），直接渲染场景到 surface（不黑屏）
            self.draw_scene_into(&mut encoder, &view, clear);
        }
        self.queue.submit([encoder.finish()]);
        frame.present();
    }

    /// 把场景（图片平面 + 粒子层）渲染到 `target` 视图。Task2 抽出供效果链透传的离屏自采
    /// 与兜底直接 surface 渲染复用。`clear` 为 scene pass 的清屏色（contain 透明 / cover 底色）。
    /// 只读借用（图片/粒子渲染不改内部状态；图片 uniform 已在 render_frame 提前更新）。
    #[cfg(feature = "render")]
    fn draw_scene_into(&self, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, clear: wgpu::Color) {
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("scene"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
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
            // 对象级效果链合成 quad（M3/Task5 + M4/Task6）：采样各对象输出 RT，贴回 target。
            // 与共享图片同 pass、在共享图片之后叠加——z 层近似（对象按登记顺序后画，粒子层仍在最后）。
            // 图片对象条目与粒子对象条目共用 `composite_pipeline`，按登记顺序叠加渲染。
            // 合成 quad 的 NDC 位置/UV 窗口已由 render_frame 每帧写入其 uniform buffer。
            if !self.object_effects.is_empty() || !self.particle_object_effects.is_empty() {
                pass.set_pipeline(&self.composite_pipeline);
                for entry in &self.object_effects {
                    pass.set_bind_group(0, &entry.composite.bind_group, &[]);
                    pass.draw(0..4, 0..1);
                }
                for entry in &self.particle_object_effects {
                    pass.set_bind_group(0, &entry.composite.bind_group, &[]);
                    pass.draw(0..4, 0..1);
                }
            }
            // pass 在块尾 drop，随后粒子渲染开启新的 render pass（不可嵌套）
        }
        // 粒子层（加法混合叠加在图片上；多粒子系统逐个渲染）
        for p in &self.particle_passes {
            p.render(encoder, target);
        }
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
