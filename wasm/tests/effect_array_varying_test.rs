//! task-18 回归：数组 varying 效果 shader 的 SPIR-V 必须能过 `spv_to_wgsl`（naga spv-in → Validator）。
//!
//! 根因：naga 24 的 `TypeFlags::IO_SHAREABLE` 对数组顶层 IO 不成立，spv-in 为 `varying vec2
//! v_TexCoord[N]`（blur/localcontrast 的下采样/高斯采样偏移数组）产生的数组类型含固定数组 flag
//! （`DATA|SIZED|COPY|HOST_SHAREABLE|ARGUMENT|CONSTRUCTIBLE|CREATION_RESOLVED`，**不含**
//! `IO_SHAREABLE`），Validator 报 `NotIOShareableType`，导致效果链 pass 编译失败。
//! 修复在 glsl-to-naga（把数组 IO 展开为多个单变量 + 变量下标改 select 链），产出无数组 IO 的
//! SPIR-V；本测试锁定该 SPIR-V（`0-0-blur` = blur_downsample4，含 `v_TexCoord[4]` 数组 varying）
//! 在 wasm 侧 `spv_to_wgsl` 能编译出合法 WGSL（不再 `NotIOShareableType`）。
use we_scene_wasm::render::effect;

#[test]
fn spv_to_wgsl_array_varying_produces_valid_wgsl() {
    let vert = include_bytes!("fixtures/eva01/0-0-blur.vert.spv");
    let frag = include_bytes!("fixtures/eva01/0-0-blur.frag.spv");
    let v = effect::spv_to_wgsl(vert, effect::Stage::Vertex)
        .unwrap_or_else(|e| panic!("数组 varying vertex SPIR-V 经 spv_to_wgsl 应编译成功（曾报 NotIOShareableType），got {e:?}"));
    let f = effect::spv_to_wgsl(frag, effect::Stage::Fragment)
        .unwrap_or_else(|e| panic!("数组 varying fragment SPIR-V 经 spv_to_wgsl 应编译成功，got {e:?}"));
    println!("[array varying] vertex WGSL={}B fragment WGSL={}B", v.len(), f.len());
    assert!(v.contains("v_TexCoord_0"), "vertex 应含展开后的 v_TexCoord_0 输出");
    assert!(f.contains("v_TexCoord_0"), "fragment 应含展开后的 v_TexCoord_0 输入");
}
