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
