use we_scene_wasm::render::effect;

#[test]
fn compiles_we_dialect_glsl_to_wgsl() {
    // 一个 WE 方言 fragment（fade 语义，已由 JS 转成 desktop 450 的样子）。
    let glsl = "#version 450\nlayout(location=0) out vec4 o_Color;\nlayout(binding=0) uniform vec3 color;\nvoid main(){ o_Color = vec4(color*0.7, 1.0); }";
    let wgsl = effect::glsl_to_wgsl(glsl, effect::Stage::Fragment);
    assert!(wgsl.is_ok());
}

#[test]
fn validates_wgsl() {
    let wgsl = "struct O { @location(0) c: vec4<f32>, };\n@fragment fn main() -> O { return O(vec4f(0.0)); }";
    assert!(effect::validate_wgsl(wgsl));
}

/// Milestone 2 / Task3：ping-pong 写端选择（纯逻辑，native 可测）。
/// 上一写端为 None（首 pass 读输入纹理）→ 写 rt_a(0)；上一写端为 rt_a(0) → 写 rt_b(1)；
/// 上一写端为 rt_b(1) → 写 rt_a(0)。与 JS EffectRunner::pickWriteTarget 语义一致。
#[test]
fn pick_write_target_pings_pong() {
    assert_eq!(effect::pick_write_target(None), 0);
    assert_eq!(effect::pick_write_target(Some(0)), 1);
    assert_eq!(effect::pick_write_target(Some(1)), 0);
}

/// Milestone 2 / Task3：blendMode 字符串 → BlendKey（native 可测，DRY——render 层
/// 用 blend_key_to_wgpu 从 key 映射，不再从 str 重复解析）。
#[test]
fn blend_mode_mapping() {
    assert_eq!(effect::blend_mode_key("normal"), effect::BlendKey::Normal);
    assert_eq!(effect::blend_mode_key("add"), effect::BlendKey::Add);
    assert_eq!(effect::blend_mode_key("multiply"), effect::BlendKey::Multiply);
    assert_eq!(effect::blend_mode_key("subtract"), effect::BlendKey::Subtract);
    // 未知/缺省回退 Normal（对齐 JS blendModeToThree 的 default）
    assert_eq!(effect::blend_mode_key(""), effect::BlendKey::Normal);
    assert_eq!(effect::blend_mode_key("some_unknown"), effect::BlendKey::Normal);
}

/// Milestone 2 / Task3：内置演示效果链的 vert/frag GLSL 必须能被 naga 编译（现仅运行时创建
/// EffectChain 才调用 glsl_to_wgsl，无法在 native 编译期验证——此测试在 native 恒定校验
/// 这两个 shader 可编译，防止集成演示 shader 出错导致链静默创建失败）。
#[test]
fn demo_chain_shaders_compile() {
    let vert = r#"#version 450
layout(location=0) in vec2 a_Position;
layout(location=1) in vec2 a_TexCoord;
layout(location=0) out vec2 v_uv;
void main() {
    v_uv = a_TexCoord;
    gl_Position = vec4(a_Position, 0.0, 1.0);
}"#;
    let frag = r#"#version 450
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
    assert!(effect::glsl_to_wgsl(vert, effect::Stage::Vertex).is_ok(), "demo vert 应可编译");
    assert!(effect::glsl_to_wgsl(frag, effect::Stage::Fragment).is_ok(), "demo frag 应可编译");
}

/// Milestone 3 / Task4：对象 RT 尺寸钳制（native 纯函数，非 render 门控）。
/// 每个轴 = |size * scale|，并 clamp 到 [1, OBJECT_RT_MAX=2048]。
#[test]
fn object_camera_range_clamps_to_2048() {
    let r = effect::object_camera_range([4000.0, 2000.0], [2.0, 1.0]);
    assert_eq!(r[0], 2048.0);
    assert_eq!(r[1], 2000.0);
}

/// Milestone 3 / Task4：uv 窗口映射（native 纯函数，非 render 门控）。
/// clamped >= unclamped（未钳制即满幅）→ 全窗 (0,1)；否则按 (unclamped-clamped)/2 居中开窗。
#[test]
fn uv_window_unclamped_axis_full() {
    assert_eq!(effect::uv_window(100.0, 100.0), (0.0, 1.0));
    let (s, e) = effect::uv_window(100.0, 64.0);
    assert!((s - 0.18).abs() < 1e-6);
    assert!((e - 0.82).abs() < 1e-6);
}

/// Milestone 3 / Task5：对象合成 quad 的 NDC/UV 窗口 uniform（native 纯函数）。
/// 未钳制对象（world == rt，场景居中）→ 中心 (0,0)、半宽 = world/view、UV 全窗。
#[test]
fn composite_ndc_uniform_centered_unclamped() {
    let u = effect::composite_ndc_uniform(
        [50.0, 50.0, 0.0], [100.0, 100.0], [100.0, 100.0],
        100.0, 100.0, 100.0, 100.0,
    );
    assert!((u.center_x).abs() < 1e-6);
    assert!((u.center_y).abs() < 1e-6);
    assert!((u.half_w - 1.0).abs() < 1e-6);
    assert!((u.half_h - 1.0).abs() < 1e-6);
    assert!((u.uv_w0 - 0.0).abs() < 1e-6);
    assert!((u.uv_w1 - 1.0).abs() < 1e-6);
    assert!((u.uv_h0 - 0.0).abs() < 1e-6);
    assert!((u.uv_h1 - 1.0).abs() < 1e-6);
}

/// Milestone 3 / Task5：钳制轴（world > rt）开启 UV 窗口（居中开窗），
/// 但 quad 帧尺寸仍取未钳制幅值（half = world/view）。
#[test]
fn composite_ndc_uniform_clamped_opens_uv_window() {
    let u = effect::composite_ndc_uniform(
        [50.0, 50.0, 0.0], [100.0, 100.0], [64.0, 64.0],
        100.0, 100.0, 100.0, 100.0,
    );
    assert!((u.uv_w0 - 0.18).abs() < 1e-6);
    assert!((u.uv_w1 - 0.82).abs() < 1e-6);
    assert!((u.uv_h0 - 0.18).abs() < 1e-6);
    assert!((u.uv_h1 - 0.82).abs() < 1e-6);
    assert!((u.half_w - 1.0).abs() < 1e-6);
    assert!((u.half_h - 1.0).abs() < 1e-6);
}

/// Milestone 3 / Task5：坐标不翻转 y——对象中心在场景上部 → client_y 为正
/// （对齐 `(oy - vh/2)` 映射，y 向上，不做镜像）。
#[test]
fn composite_ndc_uniform_no_y_flip() {
    let u = effect::composite_ndc_uniform(
        [50.0, 75.0, 0.0], [10.0, 10.0], [10.0, 10.0],
        100.0, 100.0, 100.0, 100.0,
    );
    assert!((u.center_y - 0.5).abs() < 1e-6);
}

/// Milestone 4 / Task6：particle 对象 RT 尺寸用「有效发射距离 × scale」（复用
/// object_camera_range 的幅值钳制）。有 distanceMax → 128×2=256（不钳制）。
/// （brief 指定的核心测试。）
#[test]
fn particle_object_range_uses_effective_distance() {
    // 无 distanceMax → 默认 64；有 → |dist×scale| 钳制
    let r = effect::particle_object_range(Some(128.0), [2.0, 2.0]);
    assert_eq!(r[0], 256.0);
}

/// Milestone 4 / Task6：粒子发射距离有效值——无/非正 distanceMax 回退默认 64，
/// 正 distanceMax 原样使用。
#[test]
fn particle_effective_distance_defaults_to_64() {
    assert_eq!(effect::particle_effective_distance(None), 64.0);
    assert_eq!(effect::particle_effective_distance(Some(0.0)), 64.0);
    assert_eq!(effect::particle_effective_distance(Some(-10.0)), 64.0);
    assert_eq!(effect::particle_effective_distance(Some(128.0)), 128.0);
}

/// Milestone 4 / Task6：粒子 RT 尺寸——无 distanceMax → 默认 64×scale；钳制到 OBJECT_RT_MAX。
#[test]
fn particle_object_range_defaults_and_clamps() {
    let d = effect::particle_object_range(None, [1.0, 1.0]);
    assert_eq!(d, [64.0, 64.0]);
    // 负 scale → 幅值（对齐 object_camera_range，负值钳成 1px 会让 RT 退化，故取幅值）
    let neg = effect::particle_object_range(Some(100.0), [-2.0, 2.0]);
    assert_eq!(neg, [200.0, 200.0]);
    // 超出 OBJECT_RT_MAX → 钳到 2048
    let big = effect::particle_object_range(Some(9000.0), [1.0, 1.0]);
    assert_eq!(big[0], 2048.0);
}

/// Milestone 4 / Task6：粒子合成 quad 世界尺寸——未钳制 distanceMax × scale（带符号，
/// 与 particle_object_range 的幅值钳制分工：钳制只发生在 RT 范围，quad 世界尺寸未钳制）。
#[test]
fn particle_world_size_is_unclamped_signed() {
    let w = effect::particle_world_size(Some(128.0), [2.0, -1.5]);
    assert_eq!(w, [256.0, -192.0]);
    let d = effect::particle_world_size(None, [2.0, 2.0]);
    assert_eq!(d, [128.0, 128.0]);
    // 无 distanceMax → 默认 64
    let def = effect::particle_world_size(None, [1.0, 1.0]);
    assert_eq!(def, [64.0, 64.0]);
}

/// Task10：std140 布局与打包（native 纯函数；偏移与 glslang 实测一致，见 dump_std140.cjs）。
/// float+vec3+vec4 → offset 0/16/32，block 48。
#[test]
fn std140_type_info_and_layout_known_cases() {
    assert_eq!(effect::std140_type_info("float"), Some((4, 4, 1)));
    assert_eq!(effect::std140_type_info("vec2"), Some((8, 8, 2)));
    assert_eq!(effect::std140_type_info("vec3"), Some((16, 12, 3)));
    assert_eq!(effect::std140_type_info("vec4"), Some((16, 16, 4)));
    assert_eq!(effect::std140_type_info("mat4"), Some((16, 64, 16)));
    assert_eq!(effect::std140_type_info("mat3"), Some((16, 48, 9)));
    assert_eq!(effect::std140_type_info("mat2"), Some((16, 32, 4)));
    // float[4]：元素 stride 16 → size 64
    assert_eq!(effect::std140_type_info("float[4]"), Some((16, 64, 4)));
}

/// std140_block_size：roundup(max(offset+size), 16)。
#[test]
fn std140_block_size_rounds_to_16() {
    assert_eq!(effect::std140_block_size(&[(0, 4), (16, 12), (32, 16)]), 48);
    assert_eq!(effect::std140_block_size(&[(0, 64)]), 64);
    assert_eq!(effect::std140_block_size(&[(0, 4)]), 16);
}

/// std140 打包：float(0.5)@0 + vec3(0.25,0.5,0.75)@16 + vec4(1..4)@32 → 铺位正确（vec3 占 12B、对齐 16）。
#[test]
fn std140_pack_float_vec3_vec4() {
    let fields = [
        effect::Std140Field { ty: "float".into(), byte_offset: 0, value: vec![0.5] },
        effect::Std140Field { ty: "vec3".into(), byte_offset: 16, value: vec![0.25, 0.5, 0.75] },
        effect::Std140Field { ty: "vec4".into(), byte_offset: 32, value: vec![1.0, 2.0, 3.0, 4.0] },
    ];
    let block = effect::pack_std140_block(48, &fields);
    assert_eq!(block, vec![0.5, 0.0, 0.0, 0.0, 0.25, 0.5, 0.75, 0.0, 1.0, 2.0, 3.0, 4.0]);
}

/// std140 打包 mat4：块 64 字节（16 float），列 pitch 恒 16 字节 → 连续铺 0..15。
#[test]
fn std140_pack_mat4_contiguous() {
    let fields = [effect::Std140Field { ty: "mat4".into(), byte_offset: 0, value: (1..=16).map(|v| v as f32).collect() }];
    let block = effect::pack_std140_block(64, &fields);
    assert_eq!(block, (1..=16).map(|v| v as f32).collect::<Vec<_>>());
}

/// std140 打包 mat3：列 pitch 16 字节（每列 3 float + 1 float padding）。
/// value 列主序 [col0(3) + col1(3) + col2(3)] → 铺到 float idx 0,1,2, 4,5,6, 8,9,10。
#[test]
fn std140_pack_mat3_column_pitch_is_16() {
    // 9 个逻辑 float，列主序：v[c*3+r]。
    let val: Vec<f32> = (1..=9).map(|v| v as f32).collect();
    let fields = [effect::Std140Field { ty: "mat3".into(), byte_offset: 0, value: val }];
    let block = effect::pack_std140_block(48, &fields);
    // block(12 float)：col0@0-2, pad@3, col1@4-6, pad@7, col2@8-10, pad@11
    assert_eq!(
        block,
        vec![1.0, 2.0, 3.0, 0.0, 4.0, 5.0, 6.0, 0.0, 7.0, 8.0, 9.0, 0.0]
    );
}

/// std140 打包 float[4] 数组：元素 stride 16 字节（每元素占 4 float 槽，仅首槽写入）。
#[test]
fn std140_pack_float_array_element_stride_16() {
    let fields = [effect::Std140Field { ty: "float[4]".into(), byte_offset: 0, value: vec![1.0, 2.0, 3.0, 4.0] }];
    let block = effect::pack_std140_block(64, &fields);
    assert_eq!(block, vec![1.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 3.0, 0.0, 0.0, 0.0, 4.0, 0.0, 0.0, 0.0]);
}

/// std140 打包：fade 语义（real shader）——g_Alpha float@0 + color vec3@16。
/// 模拟 wasm render 从 wire 组装（JS glsl-to-naga 产出 offset）。
#[test]
fn std140_pack_fade_semantics_matches_js_offsets() {
    // JS std140Layout([float, vec3]) → offsets [0,16], blockSize 32。
    let fields = [
        effect::Std140Field { ty: "float".into(), byte_offset: 0, value: vec![1.0] },
        effect::Std140Field { ty: "vec3".into(), byte_offset: 16, value: vec![0.315, 0.135, 0.1125] },
    ];
    let block = effect::pack_std140_block(32, &fields);
    assert_eq!(block, vec![1.0, 0.0, 0.0, 0.0, 0.315, 0.135, 0.1125, 0.0]);
}
