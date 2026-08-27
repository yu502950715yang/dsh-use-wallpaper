//! Task13：`collect_bindings` 结构化扫描（naga IR 遍历，替代字符串嗅探）验证。
//!
//! 覆盖：① 手工 WGSL（多纹理 + 多 uniform block + sampler）→ `wgsl_bindings` 正确收集；
//! ② 真实 WE shader SPIR-V（fade_sampler：单纹理 + uniform block）→ `spv_to_wgsl` → `wgsl_bindings`；
//! ③ 真实**多纹理** shader SPIR-V（`g_Texture0` + `g_Texture1` + 2 个 uniform block，见
//!    fixtures/multi_texture_frag.spv）→ `spv_to_wgsl` → `wgsl_bindings` 识别多纹理/多 block
//!   （旧字符串嗅探的薄弱点——多纹理/多 uniform block 时其布局可能与 shader 声明不一致）。

use we_scene_wasm::render::effect;

/// 手工 WGSL（fade_sampler.spv 经 spv_to_wgsl 的形态）：多纹理 + sampler + 多 uniform block。
#[test]
fn manual_wgsl_multi_texture_and_blocks() {
    let wgsl = r#"
struct U0 { a: f32, b: vec4<f32> }
struct U1 { mat: mat4x4<f32> }
@group(0) @binding(0) var t0: texture_2d<f32>;
@group(0) @binding(1) var s0: sampler;
@group(0) @binding(2) var<uniform> u0: U0;
@group(0) @binding(3) var t1: texture_2d<f32>;
@group(0) @binding(4) var<uniform> u1: U1;
@fragment fn main() {}
"#;
    let b = effect::wgsl_bindings(wgsl).expect("WGSL 应解析");
    // 期望按 binding 升序：0=Texture, 1=Sampler, 2=Uniform, 3=Texture, 4=Uniform。
    assert_eq!(
        b,
        vec![
            (0, effect::BindKind::Texture),
            (1, effect::BindKind::Sampler),
            (2, effect::BindKind::Uniform),
            (3, effect::BindKind::Texture),
            (4, effect::BindKind::Uniform),
        ]
    );
    assert_eq!(
        b.iter().filter(|(_, k)| *k == effect::BindKind::Texture).count(),
        2,
        "多纹理应为 2 张 texture"
    );
    assert_eq!(
        b.iter().filter(|(_, k)| *k == effect::BindKind::Uniform).count(),
        2,
        "多 uniform block 应为 2 个"
    );
}

/// 真实 WE shader SPIR-V（fade_sampler：单纹理 + uniform block）：链路 spv→wgsl→bindings。
#[test]
fn fade_sampler_spv_bindings() {
    let raw = include_bytes!("fixtures/fade_sampler.spv");
    let wgsl = effect::spv_to_wgsl(raw, effect::Stage::Fragment).expect("应编译出合法 WGSL");
    let b = effect::wgsl_bindings(&wgsl).expect("WGSL 应解析");
    println!("[fade_sampler] bindings={b:?}");
    assert!(b.iter().any(|(_, k)| *k == effect::BindKind::Texture), "应含 texture（g_Texture0）");
    assert!(b.iter().any(|(_, k)| *k == effect::BindKind::Sampler), "应含 sampler");
    assert!(b.iter().any(|(_, k)| *k == effect::BindKind::Uniform), "应含 uniform block（cb）");
}

/// 真实**多纹理** shader SPIR-V（g_Texture0 + g_Texture1 + 2 个 std140 uniform block）。
/// 这是旧字符串嗅探的脆弱点——结构化扫描应正确识别多纹理 + 多 block，且按 binding 升序唯一。
/// 多纹理直接编译（验证 layout 与 shader 一致），不依赖外部纹理表。
#[test]
fn multi_texture_frag_spv_bindings() {
    let raw = include_bytes!("fixtures/multi_texture_frag.spv");
    let wgsl = effect::spv_to_wgsl(raw, effect::Stage::Fragment).expect("应编译出合法 WGSL");
    let b = effect::wgsl_bindings(&wgsl).expect("WGSL 应解析");
    println!("[multi_texture_frag] WGSL:\n{wgsl}\nbindings={b:?}");

    let n_tex = b.iter().filter(|(_, k)| *k == effect::BindKind::Texture).count();
    let n_unif = b.iter().filter(|(_, k)| *k == effect::BindKind::Uniform).count();
    let n_samp = b.iter().filter(|(_, k)| *k == effect::BindKind::Sampler).count();
    // 多纹理 shader：识别 ≥ 2 张 texture；多 uniform block：识别 ≥ 2 个 uniform。
    assert!(n_tex >= 2, "多纹理 shader 应识别 ≥2 张 texture，got {n_tex}");
    assert!(n_unif >= 2, "多 uniform block shader 应识别 ≥2 个 uniform，got {n_unif}");
    assert!(n_samp >= 1, "组合采样器经拆分后应含 sampler，got {n_samp}");

    // 排序去重应等于原列表（module_bindings 已保证有序唯一）。
    let mut dedup = b.clone();
    dedup.sort();
    dedup.dedup();
    assert_eq!(b, dedup, "module_bindings 应返回升序且唯一");

    // 所有绑定都应是 group0（module_bindings 只收集 group0）。
    assert!(b.iter().all(|(binding, _)| *binding < 16), "绑定编号应为合理小值");
}

/// 畸形 WGSL → `Err`；空 WGSL 是合法空模块 → `Ok(空)`；绝不 panic。
#[test]
fn wgsl_bindings_rejects_malformed() {
    assert!(effect::wgsl_bindings("not valid wgsl {{{").is_err(), "畸形 WGSL 应 Err");
    assert_eq!(effect::wgsl_bindings("").unwrap(), Vec::new(), "空 WGSL 应为合法的空绑定列表");
}
