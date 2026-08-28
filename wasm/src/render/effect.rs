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
//! - vert/frag **分别编译**：每个 pass 分别编译出 vert/frag 两个 WGSL → 各建一个 shader module →
//!   建 render pipeline（`entry_point: Some("main")`）。编译源按 pass 来源选择：真实 WE 效果
//!   shader（SPIR-V）走 `spv_to_wgsl`，演示/simple（GLSL）走 `glsl_to_wgsl`（见 `compile_pass_wgsl`）。
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

/// 真实 WE 效果 shader：SPIR-V bytes → WGSL（编译链集成，非 render 门控，native 可测）。
///
/// 链路（task-8 brief / spike 结论）：`spirv-webgpu-transform`(`combimgsampsplitter`) 先拆组合
/// 采样器（@webgpu/glslang 产出的 `OpTypeSampledImage` 组合采样）为独立 texture + sampler
/// （注入 `OpSampledImage`），再 `naga::front::spv::parse_u8_slice`(spv-in) → `Validator` →
/// `wgsl-out`。对照：不 transform 直接 spv-in 会 `InvalidId`（sdk-1.3.268 的已知限制）。
///
/// `stage` 由 SPIR-V 的 `OpEntryPoint` 执行模型推导，本函数不依赖它（仅保留签名对称性
/// 与调用方一致性；spv 路径 entry_point 恒为 `main`）。失败返回错误字符串（绝不 panic）。
///
/// **防 panic（reviewer Important #1）**：`spirv-webgpu-transform` 的 `u8_slice_to_u32_vec` 对
/// 非 4 倍数长度 `assert`，`combimgsampsplitter` 对 SPIR-V 魔数 `assert` 并直接索引头 5 字
/// （空/畸形输入会 trap，比白屏更糟，违反「绝不白屏/绝不崩溃」）。故入口先做 SPIR-V 头部校验
/// （长度 ≥ 20 字节且为 4 倍数 + 魔数 `0x07230203` LE），不满足直接返回 `Err`，绝不进入 transform。
pub fn spv_to_wgsl(spv: &[u8], _stage: Stage) -> Result<String, String> {
    // ① 防 panic 头部校验：合法 SPIR-V 至少含 5 字头（20 字节）且 word 对齐；magic 0x07230203（LE）。
    if spv.len() < 20 || spv.len() % 4 != 0 {
        return Err(
            "invalid SPIR-V header: length must be >= 20 bytes (5 words) and a multiple of 4".into(),
        );
    }
    let magic = u32::from_le_bytes([spv[0], spv[1], spv[2], spv[3]]);
    if magic != 0x0723_0203 {
        return Err(format!("invalid SPIR-V header: bad magic 0x{magic:08x}"));
    }
    // ② spirv-webgpu-transform：拆组合采样器（sampler2D 的 OpTypeSampledImage → 独立 texture+sampler）
    let raw_u32 = spirv_webgpu_transform::u8_slice_to_u32_vec(spv);
    let mut correction_map = None;
    let transformed =
        spirv_webgpu_transform::combimgsampsplitter(&raw_u32, &mut correction_map)
            .map_err(|e| format!("spirv-webgpu-transform split: {e:?}"))?;
    let transformed_bytes = spirv_webgpu_transform::u32_slice_to_u8_vec(&transformed);
    // ③ naga spv-in 解析（SPIR-V → naga module）
    let module = naga::front::spv::parse_u8_slice(
        &transformed_bytes,
        &naga::front::spv::Options::default(),
    )
    .map_err(|e| format!("spv parse: {e:?}"))?;
    // ③ Validator（全量校验；spv-in 输出需 WGSL 写出前过校验）
    let info = Validator::new(ValidationFlags::all(), Capabilities::all())
        .validate(&module)
        .map_err(|e| format!("naga valid: {e:?}"))?;
    // ④ wgsl-out（显式类型写出，与 glsl_to_wgsl 一致）
    let mut w = Writer::new(String::new(), naga::back::wgsl::WriterFlags::EXPLICIT_TYPES);
    w.write(&module, &info)
        .map_err(|e| format!("wgsl write: {e:?}"))?;
    Ok(w.finish())
}

/// naga-valid 校验一段 WGSL 字符串（native 可测）。
pub fn validate_wgsl(wgsl: &str) -> bool {
    naga::front::wgsl::parse_str(wgsl).is_ok()
}

// =====================================================================
// 结构化绑定收集（native 纯逻辑，非 render 门控；naga IR 遍历，替代字符串嗅探）
// =====================================================================

/// 绑定资源类型（native 纯枚举）。render 层映射到 wgpu `BindingType`
/// （`Uniform`=uniform buffer、`Texture`=filterable texture_2d、`Sampler`=filtering sampler）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum BindKind {
    Uniform,
    Texture,
    Sampler,
}

/// 解析一个全局变量的类型 → 绑定类型（texture / sampler）。
///
/// 只识别**采样图像**（`texture_2d<f32>` 的 `ImageClass::Sampled`）——storage/depth 图像与
/// 过滤采样 texture 的 wgpu 绑定类型不匹配，本任务范围仅 WE 效果 shader 的普通 `texture_2d`，
/// 其它返回 `None`（不加入 layout：宁可少一个绑定让管线校验失败走链级回退，也不制造类型错配）。
/// `BindingArray`（`sampler2D[]`/`texture2D[]`）**仅作 kind 归类**（取其 base 类型判定为
/// Texture/Sampler），**不展开为多绑定/多 view**——`build_bind_group_layout` 恒 `count: None`、
/// `build_bind_group` 恒绑单 view，与任务边界「不做 sampler2D 数组」一致（此类 shader 由
/// 链级回退兜底，见 task-13 报告）。
fn bind_kind_of(module: &naga::Module, ty: naga::Handle<naga::Type>) -> Option<BindKind> {
    use naga::TypeInner;
    match &module.types[ty].inner {
        TypeInner::Image { class, .. } => match class {
            naga::ImageClass::Sampled { .. } => Some(BindKind::Texture),
            _ => None,
        },
        TypeInner::Sampler { .. } => Some(BindKind::Sampler),
        TypeInner::BindingArray { base, .. } => bind_kind_of(module, *base),
        _ => None,
    }
}

/// 结构化扫描 naga `Module` 的 `global_variables`，收集 `@group(0)` 绑定的资源类型。
///
/// **替代旧字符串嗅探**（`find("@group(0) @binding(")` + 向后看字符串判型 + `.parse().unwrap_or(0)`）：
/// 旧实现对**多纹理/多 uniform block** 脆弱（布局可能与 shader 声明不一致），且 `.unwrap_or(0)`
/// 把解析失败静默归 0。本函数遍历 naga IR 的 `global_variables`：`AddressSpace::Uniform` →
/// uniform block（buffer）、`AddressSpace::Handle` → 由类型判 texture/sampler，得到与 shader
/// 声明**完全一致**的 `(binding, kind)` 升序去重。非 group0 / 无绑定 / 未识别类型的全局变量忽略。
pub fn module_bindings(module: &naga::Module) -> Vec<(u32, BindKind)> {
    use naga::AddressSpace;
    let mut out: Vec<(u32, BindKind)> = Vec::new();
    for (_h, var) in module.global_variables.iter() {
        let Some(res) = var.binding.as_ref() else { continue };
        if res.group != 0 {
            continue;
        }
        let kind = match var.space {
            AddressSpace::Uniform => Some(BindKind::Uniform),
            AddressSpace::Handle => bind_kind_of(module, var.ty),
            _ => None,
        };
        if let Some(k) = kind {
            out.push((res.binding, k));
        }
    }
    out.sort();
    out.dedup();
    out
}

/// 解析一段 WGSL 字符串 → 结构化绑定列表（`module_bindings`）。native 可测。
/// 失败返回错误字符串（绝不 panic，与 `spv_to_wgsl`/`glsl_to_wgsl` 契约一致）。
pub fn wgsl_bindings(wgsl: &str) -> Result<Vec<(u32, BindKind)>, String> {
    let module = naga::front::wgsl::parse_str(wgsl).map_err(|e| format!("wgsl 解析失败：{e}"))?;
    Ok(module_bindings(&module))
}

/// 解析一段 WGSL 字符串 → 每个 `@group(0) var<uniform>` block 的 `(binding, 成员名列表)`。
/// native 可测。
///
/// task-16（binding 索引重复根因）：`spirv-webgpu-transform` 拆组合采样器会**重排/重编号**
/// binding——JS 侧 `UniformBindingDesc.binding` 是拆之前的编号（如某 std140 block 在 binding=2），
/// 而 transform 后同一 block 在 WGSL 里的 binding 变了（如变成 4）。若 wasm 直接用 JS 的 binding
/// 建 uniform buffer，其 binding 会与 WGSL 的 texture/sampler binding 撞号 → `create_bind_group`
/// 报 `binding index (M) was specified by a previous entry`。本函数按**成员名**从 WGSL 取每个
/// uniform block 的真实 binding，供 `build_uniform_instances` 把 JS 提供的 block 值匹配到正确 binding。
pub fn wgsl_uniform_members(wgsl: &str) -> Result<Vec<(u32, Vec<String>)>, String> {
    let module = naga::front::wgsl::parse_str(wgsl).map_err(|e| format!("wgsl 解析失败：{e}"))?;
    let mut out: Vec<(u32, Vec<String>)> = Vec::new();
    for (_h, var) in module.global_variables.iter() {
        let Some(res) = var.binding.as_ref() else { continue };
        if res.group != 0 || var.space != naga::AddressSpace::Uniform {
            continue;
        }
        let names = match &module.types[var.ty].inner {
            naga::TypeInner::Struct { members, .. } => {
                members.iter().filter_map(|m| m.name.clone()).collect()
            }
            _ => Vec::new(),
        };
        out.push((res.binding, names));
    }
    out.sort_by_key(|(b, _)| *b);
    Ok(out)
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

// =====================================================================
// Task6/M4：particle 对象效果链的 RT 尺寸与合成 quad 世界尺寸（native 纯函数，非 render 门控）
// =====================================================================

/// 粒子发射距离有效值：无/非正 `distance_max` → 默认 64。是粒子局部相机范围与合成 quad
/// 世界尺寸的共同基准，保证「钳制只发生在 RT 范围、quad 世界尺寸始终未钳制」两处一致。
/// 对齐 JS `effectiveParticleDistance`（scene-renderer.ts）。
pub fn particle_effective_distance(distance_max: Option<f32>) -> f32 {
    distance_max.filter(|d| *d > 0.0).unwrap_or(64.0)
}

/// particle 对象 RT 单轴尺寸（M4/Task6）：粒子动态发射（无静态 size 字段）用发射器世界
/// 包围盒估计 `|distance_max × scale|` 逐轴钳制 `[1, OBJECT_RT_MAX]`（与 `object_camera_range`
/// 同语义）。对齐 JS `particleObjectRange` = `effectiveParticleDistance` + 幅值钳制。
pub fn particle_object_range(distance_max: Option<f32>, scale: [f32; 2]) -> [f32; 2] {
    object_camera_range([particle_effective_distance(distance_max); 2], scale)
}

/// particle 对象合成 quad 世界尺寸（M4/Task6）：**未钳制** `distance_max × scale`（带符号，
/// 负 scale 的粒子布局由 RT 内容/quad 半宽承担——与 image 对象「未钳制 size×scale」语义一致）。
/// 钳制只发生在 `particle_object_range`（RT 范围），quad 世界尺寸始终未钳制，钳制轴由合成
/// quad 的 UV 窗口只采样可见段。对齐 JS `particleWorldSize`。
pub fn particle_world_size(distance_max: Option<f32>, scale: [f32; 2]) -> [f32; 2] {
    let d = particle_effective_distance(distance_max);
    [d * scale[0], d * scale[1]]
}

// =====================================================================
// Task5：对象合成 quad 的 NDC/UV 窗口 uniform（native 纯函数，非 render 门控）
// =====================================================================

/// 对象合成 quad 的 CPU 侧 uniform（`wasm/src/shaders/composite.wgsl` 的
/// CompositeUniform，32 字节 = 8×f32）。NDC 中心/半宽决定 quad 在 surface 上的
/// 位置与大小；UV 窗口（每轴 start/end）把采样从 RT [0,1] 展开到窗口外侧
/// （对齐 JS `applyUvWindow`：UV' = (uv - start) / (end - start)）。
/// 布局：4×f32（center/half）+ 4×f32（uv 窗口），WGSL 无额外对齐填充。
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct CompositeUniform {
    pub center_x: f32,
    pub center_y: f32,
    pub half_w: f32,
    pub half_h: f32,
    pub uv_w0: f32,
    pub uv_w1: f32,
    pub uv_h0: f32,
    pub uv_h1: f32,
}

/// 对象合成 quad 的 NDC/UV 窗口 uniform（Task5，CPU 算，native 可测）。
///
/// 对齐 JS 蓝本（scene-renderer.ts `createObjectEntry`/`createCompositeGeometry`）：
/// - quad 帧尺寸 = **未钳制幅值** `|world_size|`（镜像活在对象 RT 内容，quad 只显示
///   帧——task-4.4 报告的「相机范围与 quad 帧用幅值」职责分离）；半宽 NDC =
///   `|world|/view`（`(|world|/2)/(view/2)`）；
/// - 中心用 `coords::image_center_ndc`（对象中心 `(ox-vw/2, oy-vh/2)` 映射，**不翻转 y**）；
/// - UV 窗口 = `uv_window(未钳制|world|, 钳制 rt)`：未钳制轴 → `[0,1]`；钳制轴居中开窗。
///
/// `origin` 为对象中心（WE 坐标，已 applyAlignment 换算中心）；`world_size` 为
/// `size×scale`（合成 quad 内部取幅值）；`rt_size` 为钳制后对象 RT 分辨率（局部相机范围）。
pub fn composite_ndc_uniform(
    origin: [f32; 3],
    world_size: [f32; 2],
    rt_size: [f32; 2],
    scene_w: f32,
    scene_h: f32,
    view_w: f32,
    view_h: f32,
) -> CompositeUniform {
    let w_abs = world_size[0].abs();
    let h_abs = world_size[1].abs();
    let (cx, cy) = crate::coords::image_center_ndc(origin, scene_w, scene_h, view_w, view_h);
    let (uw0, uw1) = uv_window(w_abs, rt_size[0]);
    let (uh0, uh1) = uv_window(h_abs, rt_size[1]);
    CompositeUniform {
        center_x: cx,
        center_y: cy,
        half_w: w_abs / view_w,
        half_h: h_abs / view_h,
        uv_w0: uw0,
        uv_w1: uw1,
        uv_h0: uh0,
        uv_h1: uh1,
    }
}

/// 纹理槽引用（MVP）。`External(u32)` 索引到外部纹理表（由对象级/glsl-to-naga 层解析）。
/// M2 多数效果 pass 只使用 g_Texture0，纹理槽多为 None——MVP 先支持 g_Texture0 + 可选槽。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
pub enum SlotId {
    External(u32),
}

/// 单个非不透明 uniform 绑定（std140 block 成员）：`name` + 打包值（Vec<f32>）+ 布局描述。
///
/// JS 侧 glsl-to-naga 已按 block 成员顺序计算 std140 布局（offset/size 为字节，offset 与 glslang
/// 实测一致，见 research/glslang-spike/dump_std140.cjs）；`binding` 为所属 std140 block 的
/// layout(binding=B)（非不透明 uniform 全体共用同一 B；sampler 不在本列表，由 collect_bindings 绑定）。
/// `ty` 为 GLSL 类型（float/vec2/vec3/vec4/matN/float[N]），wasm 据此把 value 铺进 block 的
/// 正确字节位（见 pack_std140_block）。serde 字段名对齐 JS wire：type → ty（Rust 保留字规避）。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct UniformBinding {
    pub name: String,
    pub value: Vec<f32>,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub size: u32,
    #[serde(rename = "type", default)]
    pub ty: String,
    #[serde(default)]
    pub binding: u32,
}

// =====================================================================
// std140 布局与打包（native 纯函数，非 render 门控；cargo test 可测）。
// 规则与 glslang（Vulkan 目标）std140 一致，见 research/glslang-spike/dump_std140.cjs 实测：
//   float/int/bool: align 4, size 4, count 1
//   vec2: align 8, size 8, count 2；vec3: align 16, size 12, count 3；vec4: align 16, size 16, count 4
//   matN（列主序）: align 16, size N*16（列 pitch 恒 16 字节）, count N*N
//   float[N]/vecN[N]: 元素 stride = roundup(align(元素),16) ⇒ align 16, size N*16, count N*elemCount
//   block 总 size = roundup(max(offset+size),16)（std140 block size 恒为 16 倍数）
// =====================================================================

/// std140 字段类型信息：`(align 字节, size 字节, count 逻辑 float 数)`。未知类型返回 None。
/// 数组元素 stride = `roundup(elem_size,16) = max(elem_size,16)`——**必须用 elem_size 而非 elem_align**：
/// 对标量/向量 elem_size ≤ 16，二者等价；但对矩阵（mat2=32B/mat3=48B/mat4=64B）only elem_size 生效，
/// 否则 `mat4[2]` 会被算成 2*16=32B（正确应为 2*64=128B），后续成员 offset 塌陷（reviewer Important #1）。
pub fn std140_type_info(ty: &str) -> Option<(u32, u32, u32)> {
    if let Some(idx) = ty.find('[') {
        let base = &ty[..idx];
        let n: u32 = ty[idx + 1..ty.len() - 1].parse().ok()?;
        let (_, elem_size, elem_count) = std140_type_info(base)?;
        let elem_stride = elem_size.max(16); // 数组元素 stride = roundup(elem_size,16)
        return Some((16, n * elem_stride, n * elem_count));
    }
    match ty {
        "float" | "int" | "uint" | "bool" => Some((4, 4, 1)),
        "vec2" => Some((8, 8, 2)),
        "vec3" => Some((16, 12, 3)),
        "vec4" => Some((16, 16, 4)),
        "mat2" => Some((16, 32, 4)),
        "mat3" => Some((16, 48, 9)),
        "mat4" => Some((16, 64, 16)),
        _ => None,
    }
}

/// std140 block 总字节 size：`roundup(max(offset+size), 16)`。
pub fn std140_block_size(offsets_sizes: &[(u32, u32)]) -> u32 {
    let max_end = offsets_sizes.iter().map(|(o, s)| o + s).max().unwrap_or(0);
    (max_end + 15) & !15
}

/// std140 字段写入计划：把 value（扁平 float）铺到 block 的字节位。返回 `[(valueIdx, floatIdx)]`，
/// floatIdx 为 block 内 float 下标（block 已预零，padding 不写）。处理 vec/mat/数组。
/// 数组：按元素 stride（=max(elem_size,16)）逐元素递归（元素内部保留矩阵列 pitch / vec 连续布局），
/// 元素 e 相对本字段的 float 偏移 = `e * elem_stride/4`（矩阵元素为 64/48/32 而非 4，reviewer Important #1）。
pub fn std140_write_plan(ty: &str, byte_offset: u32) -> Vec<(u32, u32)> {
    let base = byte_offset / 4; // float 下标基准
    let mut out = Vec::new();
    if let Some(idx) = ty.find('[') {
        let base_ty = &ty[..idx];
        let n: u32 = ty[idx + 1..ty.len() - 1].parse().unwrap_or(0);
        let (_, elem_size, elem_count) = std140_type_info(base_ty).unwrap_or((16, 16, 4));
        let elem_stride = elem_size.max(16); // 字节
        let elem_plan = std140_write_plan(base_ty, 0); // 元素内局部计划（相对元素起始）
        for e in 0..n {
            let shift = e * elem_stride / 4; // 元素 e 相对本字段的 float 偏移
            for (v, fp) in &elem_plan {
                out.push((e * elem_count + v, base + shift + fp));
            }
        }
        return out;
    }
    if let Some(n) = ty.strip_prefix("mat").and_then(|s| s.parse::<u32>().ok()) {
        // 列主序：列 c 的 pitch = 4 float（16 字节），行 r 连续。
        for c in 0..n {
            for r in 0..n {
                out.push((c * n + r, base + c * 4 + r));
            }
        }
        return out;
    }
    let count = std140_type_info(ty).map(|(_, _, c)| c).unwrap_or(1);
    for i in 0..count {
        out.push((i, base + i));
    }
    out
}

/// 待打包的 std140 block 字段（含 type/offset/value）。
#[derive(Debug, Clone)]
pub struct Std140Field {
    pub ty: String,
    pub byte_offset: u32,
    pub value: Vec<f32>,
}

/// 打包一个 std140 block：fields 各含 ty/offset/value，返回完整 block 的 f32 数组
/// （长度 = ceil(block_size/4)，未写的 padding 为 0）。
pub fn pack_std140_block(block_size: u32, fields: &[Std140Field]) -> Vec<f32> {
    let mut block = vec![0.0f32; ((block_size as usize) + 3) / 4];
    for f in fields {
        for (value_idx, float_idx) in std140_write_plan(&f.ty, f.byte_offset) {
            if (float_idx as usize) < block.len() {
                if let Some(&v) = f.value.get(value_idx as usize) {
                    block[float_idx as usize] = v;
                }
            }
        }
    }
    block
}

/// 效果链 pass 描述（编译输入）。binding 编号由 texture_slots + uniforms 的静态顺序决定
/// （JS 侧 glsl-to-naga 已分配 `layout(binding=N)`；wasm 按同一顺序整理 bind group layout）。
///
/// `shader` 来源二选一（task-8 裁决：真实 WE shader 走 spv，演示/simple 走 glsl）：
/// - `vert_spv`/`frag_spv`：真实 WE 效果 shader 的 SPIR-V bytes（`spv_to_wgsl` 编译，entry_point `main`）。
/// - `vert_glsl`/`frag_glsl`：演示/简单路径的 desktop GLSL（`glsl_to_wgsl` 编译，entry_point `main`）。
///   `vert_spv`/`frag_spv` 非空时优先 spv 路径；否则回退 glsl（兼容 task5 演示 pass）。
///
/// ⚠️ **MVM 边界**：WE 效果链 vertex shader（如 composelayer.vert）的 `g_ModelViewProjectionMatrix`
/// 是引擎内建 uniform，scene.json/material json 不给值 → JS 侧缺省 → `UniformBinding` 未带该成员
/// → `pack_std140_block` 把 block 里该 mat4 留在 0（缺省全 0）。**执行器需按对象/场景提供正确的
/// MVM 投影矩阵**（对象级=对象局部正交投影+中心 origin；场景级=场景正交投影）。当前库内依赖 MVM
/// 的效果（如 godrays 的 composelayer 层）为 frag 效果 + vert passthrough（gl_Position 由
/// a_TexCoord 推导、不乘 MVM），故不受影响；仅 vert 阶段真正乘 MVM 的效果链受影响（已知边界）。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct EffectPassDesc {
    #[serde(default)]
    pub vert_spv: Vec<u8>,
    #[serde(default)]
    pub frag_spv: Vec<u8>,
    #[serde(default)]
    pub vert_glsl: String,
    #[serde(default)]
    pub frag_glsl: String,
    #[serde(default)]
    pub uniforms: Vec<UniformBinding>,
    #[serde(default)]
    pub texture_slots: Vec<Option<SlotId>>,
    #[serde(default)]
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

    /// 按 pass 来源编译 vert/frag 为 WGSL：真实 WE 效果 shader（`vert_spv` 非空）走
    /// `spv_to_wgsl`（SPIR-V→transform→spv-in→WGSL），演示/simple（`vert_spv` 空、`vert_glsl`
    /// 有值）走 `glsl_to_wgsl`。二者产出 WGSL 的 entry_point 均为 `main`（naga glsl-in /
    /// spv-in 默认入口；手写 WGSL 的 vs_main/fs_main 的是 effect_passthrough/composite 层）。
    ///
    /// **gating 一致性（reviewer Minor #3）**：`vert_spv`/`frag_spv` 必须同空或同非空（畸形 desc
    /// 一空一非空 → 直接 `Err`，交由调用方链级跳过/兜底，绝不走到错误的编译路径）。
    fn compile_pass_wgsl(desc: &EffectPassDesc) -> Result<(String, String), String> {
        if desc.vert_spv.is_empty() != desc.frag_spv.is_empty() {
            return Err(
                "EffectPassDesc vert_spv/frag_spv 不一致（一空一非空，应为同空/同非空）".into(),
            );
        }
        if !desc.vert_spv.is_empty() {
            Ok((
                spv_to_wgsl(&desc.vert_spv, Stage::Vertex)?,
                spv_to_wgsl(&desc.frag_spv, Stage::Fragment)?,
            ))
        } else {
            Ok((
                glsl_to_wgsl(&desc.vert_glsl, Stage::Vertex)?,
                glsl_to_wgsl(&desc.frag_glsl, Stage::Fragment)?,
            ))
        }
    }

    /// 结构化扫描 vert+frag 两个 WGSL，收集 `@group(0)` 绑定声明与资源类型（naga IR 遍历，
    /// 替代旧字符串嗅探；见 super::module_bindings/wgsl_bindings）。合并两段绑定的
    /// `(binding, 类型)` 排序 + 去重，用于**按 shader 实际声明**构建 bind group layout
    /// （保证 layout 与 shader 一致，绝不因未使用/错配绑定导致管线校验失败）。
    /// 任一 WGSL 解析失败 → 忽略该来源（对应 pass 由 error scope 捕获布局/管线校验错误，
    /// 链级回退，不硬崩）。
    fn collect_bindings(wgsl_vert: &str, wgsl_frag: &str) -> Vec<(u32, BindKind)> {
        let mut out: Vec<(u32, BindKind)> = Vec::new();
        for src in [wgsl_vert, wgsl_frag] {
            if let Ok(mut b) = wgsl_bindings(src) {
                out.append(&mut b);
            }
        }
        out.sort();
        out.dedup();
        out
    }

    /// 收集 vert+frag 两个 WGSL 里每个 `var<uniform>` block 的 `(binding, 成员名列表)`，按 binding 升序、
    /// 跨 stage 同 binding 合并成员名。task-16：供 `build_uniform_instances` 按成员名把 JS 提供的
    /// std140 block 值还原到 transform 后的**真实** binding（避免与 texture/sampler 撞号）。
    fn collect_uniform_members(wgsl_vert: &str, wgsl_frag: &str) -> Vec<(u32, Vec<String>)> {
        let mut out: Vec<(u32, Vec<String>)> = Vec::new();
        for src in [wgsl_vert, wgsl_frag] {
            if let Ok(b) = wgsl_uniform_members(src) {
                for (bb, names) in b {
                    if let Some((_, existing)) = out.iter_mut().find(|(e, _)| *e == bb) {
                        for n in names {
                            if !existing.contains(&n) {
                                existing.push(n);
                            }
                        }
                    } else {
                        out.push((bb, names));
                    }
                }
            }
        }
        out.sort_by_key(|(b, _)| *b);
        out
    }

    /// 由绑定列表构建 bind group layout（顶点/片元统一可见性，覆盖实际使用阶段，且允许
    /// 过宽可见性避免「Visibility flags don't include the shader stage」错误）。
    /// `bindings` 来自 `collect_bindings`（结构化 naga IR 扫描），保证 layout 与 shader
    /// 声明的绑定（含多纹理/多 uniform block）完全一致。
    fn build_bind_group_layout(
        device: &wgpu::Device,
        bindings: &[(u32, BindKind)],
        label: &str,
    ) -> wgpu::BindGroupLayout {
        let entries: Vec<wgpu::BindGroupLayoutEntry> = bindings
            .iter()
            .map(|(binding, kind)| wgpu::BindGroupLayoutEntry {
                binding: *binding,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: match kind {
                    BindKind::Uniform => wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    BindKind::Texture => wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    BindKind::Sampler => wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                },
                count: None,
            })
            .collect();
        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some(label),
            entries: &entries,
        })
    }

    /// 按 binding 分组非不透明 uniform（std140 block 成员），每组建一个 uniform buffer + block 数据。
    /// 返回 `EffectUniformInstance` 列表（按 binding 升序，同 binding 成员保持原顺序）。
    ///
    /// **task-16（binding 索引重复）**：`spirv-webgpu-transform` 拆组合采样器会重排/重编号 binding，
    /// 故 JS 侧 `UniformBinding.binding`（拆前编号）与 WGSL 真实 binding（拆后）**不一致**——
    /// 若 uniform buffer 仍用 JS 的 binding，会与 WGSL 的 texture/sampler binding 撞号，导致
    /// `create_bind_group` 报 `binding index (M) was specified by a previous entry`。这里改为：
    /// ① 仍按 JS 的 binding 把成员**分组**成 block（成员归属正确，无实例名 block 成员全局可见）；
    /// ② 用 `uniform_members`（WGSL，含每个 `var<uniform>` 的**成员名**）按成员名映射出该 block
    ///    变换后的**真实 binding**（命中即用 WGSL binding；找不到时回退 JS binding，不崩）；③ 补齐
    ///    WGSL 声明为 Uniform 但 `uniforms` 未覆盖的 binding → 全 0 空 buffer（16 字节），保证
    ///    bind group 恒为 layout 每个 Uniform 绑定提供资源（不因缺 entry 触发校验错误，不崩不白屏）。
    fn build_uniform_instances(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        uniforms: &[UniformBinding],
        uniform_members: &[(u32, Vec<String>)],
        label: &str,
    ) -> Vec<EffectUniformInstance> {
        // ① 按 JS binding 分组 std140 成员（成员名保持不变，用于下方成员名→真实 binding 匹配）。
        let mut entries: Vec<(u32, &UniformBinding)> = uniforms.iter().map(|u| (u.binding, u)).collect();
        entries.sort_by_key(|(b, _)| *b);
        // ② 成员名 → WGSL 真实 binding（首个命中）。同一 block 成员共享同 binding，故用任一成员名
        //    即可还原该 block 在 transform 后的 binding。
        let mut member_to_binding: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
        for (b, names) in uniform_members {
            for n in names {
                member_to_binding.entry(n.as_str()).or_insert(*b);
            }
        }
        let mut out: Vec<EffectUniformInstance> = Vec::new();
        let mut i = 0;
        while i < entries.len() {
            let js_binding = entries[i].0;
            let mut group: Vec<&UniformBinding> = Vec::new();
            while i < entries.len() && entries[i].0 == js_binding {
                group.push(entries[i].1);
                i += 1;
            }
            // 用成员名还原 WGSL 真实 binding（本 block 全体成员共享同一 binding；找不到回退 JS binding）。
            let binding = group
                .iter()
                .find_map(|u| member_to_binding.get(u.name.as_str()).copied())
                .unwrap_or(js_binding);
            // block_size = std140 总 size（offset+size 的最大端，向上取 16 倍数）。
            let block_size = std140_block_size(&group.iter().map(|u| (u.offset, u.size)).collect::<Vec<_>>());
            let fields: Vec<Std140Field> = group
                .iter()
                .map(|u| Std140Field { ty: u.ty.clone(), byte_offset: u.offset, value: u.value.clone() })
                .collect();
            let block_data = pack_std140_block(block_size, &fields);
            let g_time_offset = group.iter().find(|u| u.name == "g_Time").map(|u| u.offset);
            let buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(&format!("{label}-{binding}")),
                size: (block_size as u64).max(16),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            queue.write_buffer(&buffer, 0, bytemuck::cast_slice(&block_data));
            out.push(EffectUniformInstance { binding, buffer, block_data, g_time_offset });
        }
        // ③ 补齐：WGSL 声明为 Uniform（`uniform_members`）但 `uniforms` 未覆盖/未匹配到的 binding
        //    → 全 0 空 buffer（16 字节，min_uniform_buffer 16B 对齐）。
        for (b, _names) in uniform_members {
            if out.iter().any(|u| u.binding == *b) {
                continue;
            }
            let empty: Vec<f32> = vec![0.0; 4];
            let buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(&format!("{label}-empty-{b}")),
                size: (empty.len() * 4) as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            queue.write_buffer(&buffer, 0, bytemuck::cast_slice(&empty));
            out.push(EffectUniformInstance { binding: *b, buffer, block_data: empty, g_time_offset: None });
        }
        out.sort_by_key(|u| u.binding);
        out
    }

    /// 单个 std140 uniform block 的 GPU 资源（一个 block 对应一个 `var<uniform>` 绑定）。
    #[derive(Debug)]
    pub(super) struct EffectUniformInstance {
        pub binding: u32,
        pub buffer: wgpu::Buffer,
        /// block 完整数据（g_Time 槽已置 0 的静态部分，含 padding 0）。render 时仅把 g_Time
        /// 写进对应槽再整块 write_buffer（每帧仅重写含 g_Time 的 block，其余保持静态）。
        pub block_data: Vec<f32>,
        /// 本 block 中 g_Time 字段的字节 offset（无 g_Time → None，静态不每帧写）。
        pub g_time_offset: Option<u32>,
    }

    /// 单个 pass 的 GPU 资源（管线 + layout + uniform block 列表 + 绑定编号）。
    #[derive(Debug)]
    pub(super) struct EffectPassInstance {
        pub pipeline: wgpu::RenderPipeline,
        pub bind_group_layout: wgpu::BindGroupLayout,
        /// 按 binding 编号分组后的 std140 uniform block（非不透明 uniform 合并进 block；
        /// 一个 pass 通常 1 个 block（frag/vert 各有其 block 时可能 2 个）。
        pub uniform_instances: Vec<EffectUniformInstance>,
        /// shader 声明的**全部**纹理绑定编号（升序；多纹理 = 多个）。第一个（通常 = g_Texture0
        /// 语义）绑当前输入 view；其余多纹理在无额外纹理视图时复用输入 view 保底（不崩，见
        /// `build_bind_group`）。替代旧的单 `input_texture_binding`。
        pub texture_bindings: Vec<u32>,
        /// shader 声明的**全部** sampler 绑定编号（升序；多 sampler = 多个）。全部绑共享
        /// `self.sampler`——若只绑第一个，多 sampler（如 multi_texture_frag 的 binding 1 与 3）
        /// 会让其余 sampler 缺 entry，每帧 `create_bind_group` 抛「binding N unbound」校验错误
        /// (reviewer Important #1)。与 `texture_bindings` 对称。
        pub sampler_bindings: Vec<u32>,
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
                let (wgsl_vert, wgsl_frag) =
                    compile_pass_wgsl(desc).map_err(|e| format!("pass {i} 编译失败：{e}"))?;
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
                // ② bind group layout（按 shader 实际声明构建，保证一致）。先结构化扫描
                //   （naga IR 遍历，替代字符串嗅探）得绑定列表，再以此建 layout（避免重复解析）。
                let bindings = collect_bindings(&wgsl_vert, &wgsl_frag);
                let bind_group_layout = build_bind_group_layout(device, &bindings, &format!("{label}-bgl"));
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
                        entry_point: Some("main"),
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
                        entry_point: Some("main"),
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
                // ⑤ std140 uniform block：非不透明 uniform 合并进 block（JS 侧 glsl-to-naga 已按
                //  block 成员计算 offset/size/binding，见 UniformBinding）。按 binding 分组，每组：
                //  block_size = std140_block_size(offset+size)；pack_std140_block 铺值（含 padding 0）；
                //  buffer 大小 = block_size 字节；g_Time 槽（name=="g_Time"）为每帧动态写。
                //  task-16：transform 重排 binding 后，block 在 GPU 上的真实 binding 以 WGSL
                //  `collect_uniform_members`（按成员名）为准，避免与 texture/sampler 撞号导致
                //  `create_bind_group` 报 「binding index 被前一 entry 指定」。
                let uniform_members = collect_uniform_members(&wgsl_vert, &wgsl_frag);
                let uniform_instances =
                    build_uniform_instances(device, queue, &desc.uniforms, &uniform_members, &format!("{label}-uniform"));
                let texture_bindings: Vec<u32> =
                    bindings.iter().filter(|(_, k)| *k == BindKind::Texture).map(|(b, _)| *b).collect();
                // 全部 sampler 绑定（不取第一个）——与 texture_bindings 对称，多 sampler 不因缺 entry
                // 导致每帧 create_bind_group 校验错误 (reviewer Important #1)。
                let sampler_bindings: Vec<u32> =
                    bindings.iter().filter(|(_, k)| *k == BindKind::Sampler).map(|(b, _)| *b).collect();
                instances.push(EffectPassInstance {
                    pipeline,
                    bind_group_layout,
                    uniform_instances,
                    texture_bindings,
                    sampler_bindings,
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
        ///
        /// **性能约束（一次性构建）**：本方法**不做** naga 编译 / shader module / render pipeline
        /// 创建——它们的构建与对象 RT / ping-pong RT / uniform buffer 均在 `new`（壁纸/对象加载时）
        /// 一次性完成。每帧仅：① 写 uniform buffer（g_Time 经 host 更新）；② 按当前输入 view
        /// 建 bind group；③ 提交 render pass。无每帧 shader 编译，理论上帧内零编译开销。
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
                // 更新 g_Time：仅对含 g_Time 字段的 block 每帧重写（g_Time 位于其 std140 offset，
                // 而非固定偏移 0）。无 g_Time 的 block 保持静态（new 已写好）。字段级借用（disjoint）：
                // 对 self.passes[i] 与 self.queue 的不可变借用互不重叠，编译器允许。
                for uins in &self.passes[i].uniform_instances {
                    if let Some(off) = uins.g_time_offset {
                        let mut data = uins.block_data.clone();
                        if let Some(slot) = data.get_mut((off / 4) as usize) {
                            *slot = time;
                        }
                        self.queue.write_buffer(&uins.buffer, 0, bytemuck::cast_slice(&data));
                    }
                }
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

        /// 按 shader 声明的绑定构建 bind group：std140 uniform block（各 binding）+ 纹理绑定 + sampler。
        ///
        /// **错误防护（缺 entry 不崩）**：wgpu 24 的 `create_bind_group` 校验错误默认不 panic（走
        /// uncaptured error handler），且此处**保证 entries 与 layout 每个绑定一致**：uniform 绑定
        /// 恒有 buffer（`build_uniform_instances` 对缺失 binding 已补空 buffer）、全部纹理绑定恒有
        /// 视图（多纹理无额外资源时复用当前输入 `read_view` 保底）、sampler 恒有共享 sampler——
        /// 故 bind group 不会因缺 entry 触发校验错误。真正的资源创建错误在 `new` 的 error scope
        /// 内收敛（`EffectChain::new` 返回 `Err` → 调用方跳链回退，绝不白屏/不崩）。
        ///
        /// **多纹理**：`texture_bindings` 为 shader 声明的全部纹理绑定（升序）。第一个（通常
        /// g_Texture0 语义）绑当前输入 view；其余多纹理槽在**无外部纹理视图表**时复用输入 view
        /// 保底（当前 `texture_slots` 在 JS wiring 为空，外部纹理表未接通，见 task-13 报告疑虑）。
        fn build_bind_group(&self, pass_index: usize, read_view: &wgpu::TextureView) -> wgpu::BindGroup {
            let pass = &self.passes[pass_index];
            let mut entries: Vec<wgpu::BindGroupEntry> = Vec::new();
            for uins in &pass.uniform_instances {
                entries.push(wgpu::BindGroupEntry {
                    binding: uins.binding,
                    resource: uins.buffer.as_entire_binding(),
                });
            }
            for &b in &pass.texture_bindings {
                entries.push(wgpu::BindGroupEntry {
                    binding: b,
                    resource: wgpu::BindingResource::TextureView(read_view),
                });
            }
            for &b in &pass.sampler_bindings {
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
