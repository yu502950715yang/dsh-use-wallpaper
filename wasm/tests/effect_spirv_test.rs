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

/// 防 panic（reviewer Important #1）：畸形/空 SPIR-V 应返回 `Err` 而非 panic（trap）。
/// 覆盖：空字节、非 4 倍数长度、长度合法但魔数错误——三者均走 `Err`，绝不进入
/// spirv-webgpu-transform（其 u8_slice_to_u32_vec/combimgsampsplitter 会 assert/越界）。
#[test]
fn spv_to_wgsl_rejects_malformed_spirv_without_panic() {
    // 空字节（< 4 字节且非 4 倍数头）
    assert!(effect::spv_to_wgsl(&[], effect::Stage::Fragment).is_err(), "空输入应 Err");
    // 长度非 4 倍数（3 字节）
    assert!(effect::spv_to_wgsl(&[1u8, 2, 3], effect::Stage::Fragment).is_err(), "非 4 倍数长度应 Err");
    // 长度 ≥ 20 但非 4 倍数（21 字节）
    assert!(effect::spv_to_wgsl(&[0u8; 21], effect::Stage::Fragment).is_err(), "非 4 倍数长度应 Err");
    // 长度合法（32 字节，4 倍数，≥ 20）但魔数错误（前 4 字节=0，非 0x07230203）
    assert!(effect::spv_to_wgsl(&[0u8; 32], effect::Stage::Fragment).is_err(), "错误魔数应 Err");
    // 长度 < 20 但为 4 倍数（16 字节，不含 5 字头）→ 也应 Err（防止 combimgsampsplitter 越界）
    assert!(effect::spv_to_wgsl(&[0u8; 16], effect::Stage::Fragment).is_err(), "不足 5 字头应 Err");
}
