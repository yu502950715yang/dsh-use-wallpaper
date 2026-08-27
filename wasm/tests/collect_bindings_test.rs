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

    // 精确 layout 向量：多纹理（g_Texture0/g_Texture1）+ 多 sampler + 2 个 std140 block。
    // transform 拆组合采样器后 binding 0/2 = texture、1/3 = sampler、4/5 = uniform（升序唯一）——
    // 这是旧字符串嗅探的薄弱点（多纹理/多 uniform block）、也是 reviewer Important#1 多 sampler 场景。
    assert_eq!(
        b,
        vec![
            (0, effect::BindKind::Texture),
            (1, effect::BindKind::Sampler),
            (2, effect::BindKind::Texture),
            (3, effect::BindKind::Sampler),
            (4, effect::BindKind::Uniform),
            (5, effect::BindKind::Uniform),
        ],
        "multi_texture_frag 的结构化 bindings 应为升序 6 项（2 纹理 + 2 sampler + 2 uniform block）"
    );

    // 排序去重应等于原列表（module_bindings 已保证有序唯一）。
    let mut dedup = b.clone();
    dedup.sort();
    dedup.dedup();
    assert_eq!(b, dedup, "module_bindings 应返回升序且唯一");
}

/// **reviewer Important #1 防护**：多 sampler shader 的 sampler 绑定应**全部**收集（非仅第一个）。
/// `build_bind_group_layout` 把 `collect_bindings` 中所有 sampler 建为 layout entry；若 bind group 只绑
/// 第一个 sampler，则其余 sampler（此处 binding 3）缺 entry → 每帧 `create_bind_group` 抛
/// 「binding 3 unbound」校验错误（渲染失效）。本测试在 native 校验：sampler/texture/uniform 三类
/// binding 均被收集，其并集**覆盖** collect_bindings 全部绑定（即 entries 数 == layout entry 数）。
/// （render 门控 `build_bind_group` 依赖 wgpu Device，native 无法构造等价物，故以收集/覆盖性
/// 直接验证其前提——`EffectPassInstance.sampler_bindings`/`texture_bindings`/`uniform_instances`
/// 应对 layout 每个绑定提供资源。）
#[test]
fn multi_sampler_bindings_collect_all() {
    let raw = include_bytes!("fixtures/multi_texture_frag.spv");
    let wgsl = effect::spv_to_wgsl(raw, effect::Stage::Fragment).expect("应编译出合法 WGSL");
    let b = effect::wgsl_bindings(&wgsl).expect("WGSL 应解析");

    let samplers: Vec<u32> = b.iter().filter(|(_, k)| *k == effect::BindKind::Sampler).map(|(bb, _)| *bb).collect();
    let textures: Vec<u32> = b.iter().filter(|(_, k)| *k == effect::BindKind::Texture).map(|(bb, _)| *bb).collect();
    let uniforms: Vec<u32> = b.iter().filter(|(_, k)| *k == effect::BindKind::Uniform).map(|(bb, _)| *bb).collect();

    // 多 sampler：应收集【全部】sampler binding（1 与 3），而非仅第一个（1）。
    assert_eq!(samplers, vec![1, 3], "多 sampler shader 应收集全部 sampler binding（binding 1 与 3）");
    assert_eq!(textures, vec![0, 2], "多纹理应收集第 0、2 两处 texture");
    assert_eq!(uniforms, vec![4, 5], "多 uniform block 应收集 binding 4、5");

    // 覆盖性：三类 binding 的并集 == collect_bindings 全部 binding（bind group entries 数 == layout entry 数，
    // 不因多 sampler/多纹理/多 uniform 缺 entry）。
    let mut covered: Vec<u32> = samplers.iter().chain(&textures).chain(&uniforms).copied().collect();
    covered.sort();
    covered.dedup();
    let all_bindings: Vec<u32> = b.iter().map(|(bb, _)| *bb).collect();
    assert_eq!(covered, all_bindings, "uniform/texture/sampler 三类应覆盖 collect_bindings 全部绑定");
}

/// 畸形 WGSL → `Err`；空 WGSL 是合法空模块 → `Ok(空)`；绝不 panic。
#[test]
fn wgsl_bindings_rejects_malformed() {
    assert!(effect::wgsl_bindings("not valid wgsl {{{").is_err(), "畸形 WGSL 应 Err");
    assert_eq!(effect::wgsl_bindings("").unwrap(), Vec::new(), "空 WGSL 应为合法的空绑定列表");
}
