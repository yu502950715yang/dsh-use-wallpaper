//! Task 0.3: wasm 粒子 alpha（alpharandom 解析 + EmitterParams 176B 布局）——TDD 测试。
//! 断言来自 task-0.3-brief.md；控制器裁定 P0-1：Particle.alpha 存 spawn 时生成的
//! 初始 alpha，compute 不衰减（避免累积误差），渲染侧计算显示 alpha
//! `v_life_alpha = clamp(life/max_life, 0, 1) * alpha`（对齐 JS 版 alphaAt 语义）。

use we_scene_wasm::particle::parse_particle_spec;
use we_scene_wasm::render::particle_pass::EmitterParams;

#[test]
fn parse_alpha_random() {
    // alpharandom {min:0.15, max:0.2} → init.alpha_min ≈ 0.15 / alpha_max ≈ 0.2
    let json = r#"{"emitter":[{"rate":1.5}],"initializer":[
        {"name":"alpharandom","min":0.15,"max":0.2}]}"#;
    let spec = parse_particle_spec(json);
    assert!((spec.init.alpha_min - 0.15).abs() < 1e-6);
    assert!((spec.init.alpha_max - 0.2).abs() < 1e-6);
}

#[test]
fn alpha_defaults_to_one() {
    // 无 alpharandom initializer → alpha_min/alpha_max 缺省 1.0（对齐 JS 语义）
    let spec = parse_particle_spec(r#"{"emitter":[{"rate":1.5}]}"#);
    assert_eq!(spec.init.alpha_min, 1.0);
    assert_eq!(spec.init.alpha_max, 1.0);
}

#[test]
fn emitter_params_layout_176() {
    // EmitterParams 新布局：11 × vec4 = 176B（dt/max_particles 后追加
    // alpha_min/alpha_max，尾补 pad 保持 16 字节对齐，满足 uniform 绑定对齐）。
    // 2026-08-31 算子内核扩容：尾部 pad 复用 + 追加 4 行 vec4 → 现在 15 × vec4 = 240B。
    assert_eq!(std::mem::size_of::<EmitterParams>(), 240);
}
