//! 临时：校验扩容后的 particle compute/render WGSL 能通过 naga wgsl-in。
use we_scene_wasm::render::effect::validate_wgsl;

const COMPUTE: &str = include_str!("../src/shaders/particle_compute.wgsl");
const RENDER: &str = include_str!("../src/shaders/particle_render.wgsl");

#[test]
fn particle_compute_wgsl_valid() {
    assert!(validate_wgsl(COMPUTE), "particle_compute.wgsl naga 校验失败");
}

#[test]
fn particle_render_wgsl_valid() {
    assert!(validate_wgsl(RENDER), "particle_render.wgsl naga 校验失败");
}

#[test]
fn particle_struct_stride_matches() {
    // Particle 结构体 stride 必须 = PARTICLE_BYTES（64）——compute/render 双读一致。
    // 校验 WGSL struct 布局：pos vec3(0-12)+pad(12-16), vel vec3(16-28), life(28), max_life(32),
    // size(36), alpha(40), pad(44), color vec3(48-60), span 60 -> align16 -> 64。
    assert_eq!(we_scene_wasm::render::particle_pass::PARTICLE_BYTES, 64);
}
