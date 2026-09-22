//! wasm 粒子 alpha 解析（alpharandom）——TDD 测试。
//! 断言来自 task-0.3-brief.md；控制器裁定 P0-1：Particle.alpha 存 spawn 时生成的
//! 初始 alpha，compute 不衰减（避免累积误差），渲染侧计算显示 alpha
//! `v_life_alpha = clamp(life/max_life, 0, 1) * alpha`（对齐 JS 版 alphaAt 语义）。
//!
//! 2026-09-22：原第 3 个用例 `emitter_params_layout_176` 测的是 `render::particle_pass::EmitterParams`
//! （GPU 粒子 uniform 布局），随 WebGPU 渲染器一起移除。

use we_scene_wasm::particle::parse_particle_spec;

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

