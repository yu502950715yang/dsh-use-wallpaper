//! Task 5：校验 particle_billboard.wgsl（CPU 模拟粒子 billboard 渲染 shader）naga 解析通过，
//! 并断言 17 浮点角点顶点流（pos3 + uv_rot_size4 + color4 + vel_lifetime4 + rot_x_y2，stride 68B）
//! 与 uniform（32B）的常量正确。wgpu 管线（`ParticleRenderPass::new`/`draw`）仅 render feature 编译，
//! native `cargo test --no-default-features` 只测解析 + 布局常量，渲染正确性由集成/截图验证。

use we_scene_wasm::render::effect::validate_wgsl;
use we_scene_wasm::render::particle_render;

const WGSL: &str = include_str!("../src/shaders/particle_billboard.wgsl");

#[test]
fn particle_billboard_wgsl_valid() {
    assert!(validate_wgsl(WGSL), "particle_billboard.wgsl naga 校验失败");
}

#[test]
fn particle_vertex_element_is_17_f32_68_bytes() {
    // 17 浮点角点顶点 = pos3 + uv_rot_size4 + color4 + vel_lifetime4 + rot_x_y2；stride 68B（17×4）。
    assert_eq!(std::mem::size_of::<[f32; 17]>(), 68);
    assert_eq!(particle_render::SPRITE_FLOATS_PER_VERTEX, 17);
    assert_eq!(particle_render::PARTICLE_VERTEX_STRIDE, 68);
}

#[test]
fn particle_billboard_uniform_size_is_32() {
    // uniform 补齐到 32B（8×f32，16 对齐）——buffer ≥ shader binding size 恒成立。
    assert_eq!(std::mem::size_of::<particle_render::ParticleRenderUniform>(), 32);
}

#[test]
fn blend_mode_maps_to_two_variants() {
    // 混合模式按材质门控（Additive / Translucent），不硬编码；至少能枚举出两种且互异。
    let a = particle_render::BlendMode::Additive;
    let t = particle_render::BlendMode::Translucent;
    assert_ne!(a, t);
}

#[test]
fn build_sprite_indices_isolates_each_particle_into_two_triangles() {
    // 根因回归：若直接用 TriangleStrip draw(0..4N)，一根 strip 会从粒子 0 的 quad 连续连到
    // 粒子 1 的 quad（跨 quad 的"桥接"三角 = 线框/三角网格）。修复用 TriangleList + 索引缓冲，
    // 每 quad 显式列出 2 个三角形 [b, b+1, b+2, b+2, b+3, b+0]（b = i*4，lwe renderSprites）。
    // 这里验证索引序列。

    // 0 粒子 → 空。
    assert!(particle_render::build_sprite_indices(0).is_empty());

    // 1 粒子 → 一个 quad 的 2 个三角形（顶点缓冲索引 0,1,2,3）。
    assert_eq!(
        particle_render::build_sprite_indices(1),
        vec![0, 1, 2, 2, 3, 0],
        "单粒子的两个三角形应铺满 4 角点 quad（左下 + 右上，仅共享对角线）"
    );

    // 2 粒子 → 8 顶点，索引基址按粒子步进 4（粒子 1 使用顶点 4..7）。相邻 quad 之间无共享索引。
    assert_eq!(
        particle_render::build_sprite_indices(2),
        vec![0, 1, 2, 2, 3, 0, 4, 5, 6, 6, 7, 4]
    );

    // 每个 quad 的 2 个三角共 6 个索引，且任意两 quad 的索引集合不相交（各自只用自己 4 个角点）。
    let idx3 = particle_render::build_sprite_indices(3);
    assert_eq!(idx3.len(), 3 * particle_render::INDICES_PER_PARTICLE as usize);
    for (q, part) in idx3.chunks(particle_render::INDICES_PER_PARTICLE as usize).enumerate() {
        let base = (q as u32) * particle_render::VERTICES_PER_PARTICLE;
        assert!(part.iter().all(|&ix| ix >= base && ix < base + particle_render::VERTICES_PER_PARTICLE),
            "quad {q} 的索引只能引用自己的 4 个角点 [{}..{})，不能跨粒子", base, base + particle_render::VERTICES_PER_PARTICLE);
    }
}
