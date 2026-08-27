//! 效果链编译链测试（task-8 集成）：验证生产 API `effect::spv_to_wgsl`。
//!
//! 链路：`@webgpu/glslang` 产出的 SPIR-V(组合采样) → `spirv-webgpu-transform::combimgsampsplitter`
//!   → `naga::front::spv::parse_u8_slice`(spv-in) → Validator → wgsl-out → 合法 WGSL。
//!
//! - composelayer.spv / fade_sampler.spv（来自 research/glslang-spike 的 @webgpu/glslang 编译产物，
//!   含 `uniform sampler2D` 组合采样；fade_sampler 额外含 std140 uniform block）应编译成功，
//!   WGSL 含独立 `texture_2d` + `sampler`（`textureSample`）。
//! - 对照：相同 SPIR-V **不**经 transform 直接进 naga spv-in 应失败（InvalidId）——证明
//!   transform 是绕开 naga 24 spv-in 对组合采样限制的关键。

use we_scene_wasm::render::effect;

/// composelayer.spv：`uniform sampler2D` 组合采样（frag），经 transform 后应变独立 texture+sampler。
#[test]
fn spv_to_wgsl_composelayer_produces_valid_wgsl() {
    let raw = include_bytes!("fixtures/composelayer.spv");
    let wgsl = effect::spv_to_wgsl(raw, effect::Stage::Fragment)
        .expect("【链路应通】composelayer.spv 经 spv_to_wgsl 应编译出合法 WGSL");
    println!("[composelayer] WGSL({} bytes)：\n{}", wgsl.len(), wgsl);
    // 独立 texture_2d + sampler 声明（transform 拆开组合采样后的 WGSL 形态）
    assert!(wgsl.contains("texture_2d"), "应含独立 texture_2d 声明");
    assert!(wgsl.contains("sampler"), "应含独立 sampler 声明");
    assert!(wgsl.contains("textureSample"), "应使用内建 textureSample 采样");
}

/// fade_sampler.spv：组合采样 + std140 uniform block（非不透明 uniform）。编译应成功且保留 uniform。
#[test]
fn spv_to_wgsl_fade_sampler_produces_valid_wgsl() {
    let raw = include_bytes!("fixtures/fade_sampler.spv");
    let wgsl = effect::spv_to_wgsl(raw, effect::Stage::Fragment)
        .expect("【链路应通】fade_sampler.spv 经 spv_to_wgsl 应编译出合法 WGSL");
    println!("[fade_sampler] WGSL({} bytes)：\n{}", wgsl.len(), wgsl);
    assert!(wgsl.contains("texture_2d"), "应含独立 texture_2d 声明");
    assert!(wgsl.contains("sampler"), "应含独立 sampler 声明");
    assert!(wgsl.contains("uniform"), "应含 uniform block 缓冲（std140 非不透明 uniform）");
}

/// 对照：不 transform 直接 naga spv-in —— 应失败（InvalidId），证明 transform 是关键。
#[test]
fn raw_spv_without_transform_fails_in_naga() {
    let raw = include_bytes!("fixtures/composelayer.spv");
    let result = naga::front::spv::parse_u8_slice(raw, &naga::front::spv::Options::default());
    println!("[对照] 未 transform 直接 spv-in 结果：{:?}", result);
    assert!(
        result.is_err(),
        "【对照】未拆组合采样的 glslang SPIR-V 进 naga spv-in 应失败（InvalidId）"
    );
}
