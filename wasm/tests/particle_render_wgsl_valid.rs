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

#[test]
fn expand_to_quad_vertices_repeats_each_particle_four_times() {
    // draw 粒度修正：每粒子展开成 4 个顶点（同属性重复 4 次），供 TriangleList + 索引缓冲
    // 画隔离 quad（n 粒子 → 4n 顶点；quad 的 2 个三角形由 build_quad_indices 显式列出）。
    // 空输入 → 空输出。
    let v = [1.0f32, 2.0, 3.0, 40.0, 0.5, 0.5, 0.8, 0.4, 0.2, 0.9];
    let expanded = particle_render::expand_to_quad_vertices(&[v]);
    assert_eq!(expanded.len(), 4);
    assert!(expanded.iter().all(|e| *e == v), "每个粒子应重复 4 次同一属性");

    // 两粒子 → 8 顶点，保持顺序（粒子 0 的 4 个在前、粒子 1 的 4 个在后）。
    let a = [0.1f32; 10];
    let b = [0.9f32; 10];
    let expanded2 = particle_render::expand_to_quad_vertices(&[a, b]);
    assert_eq!(expanded2, [a, a, a, a, b, b, b, b]);

    assert!(particle_render::expand_to_quad_vertices(&[]).is_empty());
}

#[test]
fn build_quad_indices_isolates_each_particle_into_two_triangles() {
    // 根因回归：若直接用 TriangleStrip draw(0..4N)，一根 strip 会从粒子 0 的 quad 连续连到
    // 粒子 1 的 quad（跨 quad 的"桥接"三角 = 线框/三角网格）。修复用 TriangleList + 索引缓冲，
    // 每 quad 显式列出 2 个三角形 [b, b+1, b+2, b+1, b+2, b+3]（b = i*4）。这里验证索引序列。

    // 0 粒子 → 空。
    assert!(particle_render::build_quad_indices(0).is_empty());

    // 1 粒子 → 一个 quad 的 2 个三角形（顶点缓冲索引 0,1,2,3）。
    assert_eq!(
        particle_render::build_quad_indices(1),
        vec![0, 1, 2, 1, 2, 3],
        "单粒子的两个三角形应铺满 4 角点 quad（左下 + 右上，仅共享对角线）"
    );

    // 2 粒子 → 8 顶点，索引基址按粒子步进 4（粒子 1 使用顶点 4..7）。相邻 quad 之间无共享索引，
    // 不产生跨粒子"桥接"三角。
    assert_eq!(
        particle_render::build_quad_indices(2),
        vec![0, 1, 2, 1, 2, 3, 4, 5, 6, 5, 6, 7]
    );

    // 每个 quad 的 2 个三角共 6 个索引，且任意两 quad 的索引集合不相交（各自只用自己 4 个顶点）。
    let idx3 = particle_render::build_quad_indices(3);
    assert_eq!(idx3.len(), 3 * particle_render::INDICES_PER_PARTICLE as usize);
    for (q, part) in idx3.chunks(particle_render::INDICES_PER_PARTICLE as usize).enumerate() {
        let base = (q as u32) * particle_render::VERTICES_PER_PARTICLE;
        assert!(part.iter().all(|&ix| ix >= base && ix < base + particle_render::VERTICES_PER_PARTICLE),
            "quad {q} 的索引只能引用自己的 4 个顶点 [{}..{})，不能跨粒子", base, base + particle_render::VERTICES_PER_PARTICLE);
    }
}
