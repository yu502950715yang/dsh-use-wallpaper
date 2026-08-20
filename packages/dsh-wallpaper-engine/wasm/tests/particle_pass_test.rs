//! Task 6: compute shader 粒子系统——纯函数（参数打包 + 分派）native 测试。
//! wgpu 管线部分（ParticlePass）feature 门控，仅 wasm 构建编译，浏览器验证。

use we_scene_wasm::particle::parse_particle_spec;
use we_scene_wasm::render::particle_pass::{dispatch_dims, EmitterParams};

const ASHES_JSON: &str = include_str!("fixtures/eva/particles_Ashes.json");

#[test]
fn dispatch_dims_rounds_up() {
    assert_eq!(dispatch_dims(0, 64), (1, 1, 1)); // 空也分派 1 组（安全）
    assert_eq!(dispatch_dims(64, 64), (1, 1, 1));
    assert_eq!(dispatch_dims(65, 64), (2, 1, 1));
}

#[test]
fn emitter_params_applies_coords_and_flips_scale_y() {
    let spec = parse_particle_spec(ASHES_JSON);
    // EVA Ashes 原点 (1200,777.5)、场景 2400x1555、scale (1,1,1)；
    // Task 9 修复后签名：origin 映射用场景尺寸，view_w/view_h 为 contain 投影范围（如 3133x1555）
    let p = EmitterParams::from_spec(&spec, [1200.0, 777.5, 0.0], [1.0, 1.0, 1.0], 2400.0, 1555.0, 3133.0, 1555.0);
    assert!(p.origin_x.abs() < 1e-3 && p.origin_y.abs() < 1e-3, "原点应映射到场景中心: ({},{})", p.origin_x, p.origin_y);
    assert_eq!(p.scale_y, -1.0);
    assert_eq!(p.rate, 10.0);
    // 审查修复：投影/时间演化字段打包正确（view = contain 范围，非场景尺寸）
    assert_eq!(p.view_w, 3133.0);
    assert_eq!(p.view_h, 1555.0);
    assert_eq!(p.elapsed, 0.0);
}

#[test]
fn emitter_params_layout_matches_wgsl_std140() {
    // uniform 结构体布局与 src/shaders/particle.wgsl 的 EmitterParams（std140）
    // 严格对齐（经 naga 24 校验：span=160，下列成员偏移一致）。
    // 160 = 16 的倍数，满足 uniform buffer 绑定对齐；repr(C) 无隐式填充差异。
    // 审查修复后：_pad0/_pad1/_pad2 槽改名为 view_w/view_h/elapsed（偏移不变）。
    assert_eq!(std::mem::size_of::<EmitterParams>(), 160);
    assert_eq!(std::mem::offset_of!(EmitterParams, origin_x), 0);
    assert_eq!(std::mem::offset_of!(EmitterParams, view_w), 12);
    assert_eq!(std::mem::offset_of!(EmitterParams, scale_y), 20);
    assert_eq!(std::mem::offset_of!(EmitterParams, view_h), 28);
    assert_eq!(std::mem::offset_of!(EmitterParams, rate), 32);
    assert_eq!(std::mem::offset_of!(EmitterParams, elapsed), 44);
    assert_eq!(std::mem::offset_of!(EmitterParams, directions_x), 48);
    assert_eq!(std::mem::offset_of!(EmitterParams, life_min), 64);
    assert_eq!(std::mem::offset_of!(EmitterParams, vel_min_x), 80);
    assert_eq!(std::mem::offset_of!(EmitterParams, color_min_r), 112);
    assert_eq!(std::mem::offset_of!(EmitterParams, dt), 144);
    assert_eq!(std::mem::offset_of!(EmitterParams, max_particles), 148);
}
