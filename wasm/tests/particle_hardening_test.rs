//! 粒子解析/模拟的不可信输入加固（2026-11-10，1.0 Rust P0-1/2/3）。
//!
//! 来源：`docs/audit-2026-11-10/rust-wasm.md`
//!   P0-1 非法/超深 JSON 用 `expect` → wasm trap（页面崩/静默丢层）
//!   P0-2 `maxcount` 无上限 → 构造期 `prewarm` 无界分配（OOM）
//!   P0-3 角度 `while` 归一化 → `inf`/超大值不可中断死循环（整页卡死）
//!
//! 口径：解析层对**非有限数值**一律回退默认（WE 素材由第三方作者提供，字段不可信）；
//! `maxcount` 在解析层 clamp 到 `MAX_PARTICLES`；角度归一化用 `rem_euclid`（O(1)）。

use we_scene_wasm::particle::{
    emitter_spec_to_particle, parse_particle_spec, try_parse_particle_spec, MAX_PARTICLES,
};

#[test]
fn invalid_json_returns_err_instead_of_panic() {
    let err = try_parse_particle_spec("{ not json").unwrap_err();
    assert!(err.to_lowercase().contains("json"), "错误信息应说明 JSON 解析失败：{err}");
}

#[test]
fn legacy_parse_never_panics_on_invalid_json() {
    // 旧接口（测试/内部沿用）不得 panic：非法 JSON → 全默认 spec
    let spec = parse_particle_spec("{ not json");
    assert_eq!(spec.maxcount, 0);
    assert_eq!(spec.emitter.rate, 10.0, "缺省 rate 应为 10");
}

#[test]
fn maxcount_is_clamped_to_hard_cap() {
    let spec = parse_particle_spec(r#"{"maxcount": 1000000000, "emitter":[{"rate":20}]}"#);
    assert_eq!(spec.maxcount, MAX_PARTICLES, "超大 maxcount 必须 clamp 到硬上限");
}

#[test]
fn maxcount_negative_or_non_finite_is_zero() {
    assert_eq!(parse_particle_spec(r#"{"maxcount": -5}"#).maxcount, 0);
    // "1e39" 解析为 f32::INFINITY → 非有限值过滤 → 0（未指定，走 estimate 回退）
    assert_eq!(parse_particle_spec(r#"{"maxcount": "1e39"}"#).maxcount, 0);
}

#[test]
fn non_finite_initializer_values_are_filtered() {
    let spec = parse_particle_spec(
        r#"{"initializer":[
            {"name":"rotationrandom","min":"inf","max":"1e39"},
            {"name":"angularvelocityrandom","min":"-inf","max":"1e39"},
            {"name":"velocityrandom","min":"inf inf inf","max":"nan nan nan"},
            {"name":"lifetimerandom","min":"inf","max":"inf"},
            {"name":"sizerandom","min":"inf","max":"1e39"}
        ]}"#,
    );
    for opt in [spec.init.rotation_min, spec.init.rotation_max].into_iter().flatten() {
        for v in opt {
            assert!(v.is_finite(), "rotationrandom 非有限值未过滤：{v}");
        }
    }
    for opt in [spec.init.angular_vel_min, spec.init.angular_vel_max].into_iter().flatten() {
        for v in opt {
            assert!(v.is_finite(), "angularvelocityrandom 非有限值未过滤：{v}");
        }
    }
    for v in spec.init.velocity_min.iter().chain(spec.init.velocity_max.iter()) {
        assert!(v.is_finite(), "velocityrandom 非有限值未过滤：{v}");
    }
    assert!(spec.init.lifetime_min.is_finite() && spec.init.lifetime_max.is_finite());
    assert!(spec.init.size_min.is_finite() && spec.init.size_max.is_finite());
}

#[test]
fn huge_rotation_normalizes_to_signed_range() {
    // 修复前是 `while (rot > π) rot -= 2π`：超大值会循环 astronomically 多次（等效 hang）。
    // 修复后 rem_euclid → O(1)，结果落在 [-π, π]。
    let spec = parse_particle_spec(
        r#"{"maxcount":100,"emitter":[{"rate":100}],
            "initializer":[{"name":"lifetimerandom","min":10,"max":10},
                            {"name":"angularvelocityrandom","min":"1 1 1","max":"1 1 1"}],
            "operator":[{"name":"angularmovement"}]}"#,
    );
    let mut sim = emitter_spec_to_particle(&spec, [0.0, 0.0, 0.0], 1920.0, 1080.0);
    sim.update(0.016);
    assert!(!sim.particles.is_empty(), "应有粒子被发射");
    for p in &mut sim.particles {
        p.rot = [1e6, -1e6, 1e6];
    }
    sim.update(0.016);
    let pi = std::f32::consts::PI;
    for p in &sim.particles {
        for k in 0..3 {
            assert!(p.rot[k].is_finite(), "rot[{k}] 非有限：{}", p.rot[k]);
            assert!(
                p.rot[k] >= -pi - 1e-3 && p.rot[k] <= pi + 1e-3,
                "rot[{k}] 未归一化到 [-π, π]：{}",
                p.rot[k]
            );
        }
    }
}

#[test]
fn non_finite_dt_does_not_corrupt_sim() {
    let spec = parse_particle_spec(
        r#"{"maxcount":50,"emitter":[{"rate":10}],"initializer":[{"name":"lifetimerandom","min":5,"max":5}]}"#,
    );
    let mut sim = emitter_spec_to_particle(&spec, [0.0, 0.0, 0.0], 1920.0, 1080.0);
    sim.update(0.016);
    let before = sim.particles.len();
    sim.update(f32::NAN);
    sim.update(f32::INFINITY);
    assert!(sim.time.is_finite(), "time 被非有限 dt 污染：{}", sim.time);
    assert!(sim.emission_timer.is_finite(), "emission_timer 被非有限 dt 污染");
    assert!(
        sim.particles.iter().all(|p| p.pos.iter().all(|v| v.is_finite())),
        "粒子位置出现非有限值"
    );
    assert_eq!(sim.particles.len(), before, "非有限 dt 不得改变粒子数");
}
