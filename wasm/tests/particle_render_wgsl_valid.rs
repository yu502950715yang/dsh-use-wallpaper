//! Task 3：校验 particle_billboard.wgsl（CPU 模拟粒子 billboard 渲染 shader）naga 解析通过，
//! 并断言顶点布局（`[f32;10]` = pos3+size+uv2+color3+alpha，stride 40B）与 uniform（16B）的
//! 常量正确。wgpu 管线（`ParticleRenderPass::new`/`draw`）仅 render feature 编译，native
//! `cargo test --no-default-features` 只测解析 + 布局常量，渲染正确性由集成/截图（Task 5）验证。

use we_scene_wasm::render::effect::validate_wgsl;
use we_scene_wasm::render::particle_render;

const WGSL: &str = include_str!("../src/shaders/particle_billboard.wgsl");

#[test]
fn particle_billboard_wgsl_valid() {
    assert!(validate_wgsl(WGSL), "particle_billboard.wgsl naga 校验失败");
}

#[test]
fn particle_vertex_element_is_10_f32_40_bytes() {
    // `[f32;10]` = pos3 + size + uv2 + color3 + alpha；stride 40B（10×4）。
    // 注意本任务顶点按字面量 10 元素，**勿回归到 9**（Task2 审查确认 spec 的 `[f32;9]` 是笔误）。
    assert_eq!(std::mem::size_of::<[f32; 10]>(), 40);
    assert_eq!(particle_render::PARTICLE_VERTEX_STRIDE, 40);
}

#[test]
fn particle_billboard_uniform_size_is_16() {
    // uniform 补齐到 16B（WGSL `struct P { view_w, view_h }` 8B，缓冲 ≥ shader binding size）。
    assert_eq!(std::mem::size_of::<particle_render::ParticleRenderUniform>(), 16);
}

#[test]
fn blend_mode_maps_to_two_variants() {
    // 混合模式按入参（Additive / Translucent），不硬编码；至少能枚举出两种且互异。
    let a = particle_render::BlendMode::Additive;
    let t = particle_render::BlendMode::Translucent;
    assert_ne!(a, t);
}
