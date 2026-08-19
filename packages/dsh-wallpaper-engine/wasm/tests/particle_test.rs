//! Task 3: 粒子规格解析（emitter/initializer/operator）——TDD 测试
//! 断言来自 brief；字段名以真实 fixture 为准（operator[].name、emitter.rate）。

use we_scene_wasm::particle::{parse_particle_spec, OperatorKind};

const ASHES_JSON: &str = include_str!("fixtures/eva/particles_Ashes.json");
const LIGHTSHAFTS_JSON: &str = include_str!("fixtures/eva/particles_presets_lightshafts.json");

#[test]
fn ashes_emitter_defaults() {
    // Ashes emitter 无 rate 字段 → 缺省 10
    let spec = parse_particle_spec(ASHES_JSON);
    assert_eq!(spec.emitter.rate, 10.0);
    assert_eq!(spec.emitter.distance_max, 256.0);
}

#[test]
fn lightshafts_low_rate() {
    let spec = parse_particle_spec(LIGHTSHAFTS_JSON);
    assert!(spec.emitter.rate < 1.0, "lightshafts rate 应很低: {}", spec.emitter.rate);
}

#[test]
fn vector_fields_do_not_nan() {
    // distancemax 向量 "50 256 0" → 取第一 token 50，不得 NaN
    let spec = parse_particle_spec(ASHES_JSON);
    assert!(spec.emitter.distance_max.is_finite());
    assert!(spec.init.velocity_max.iter().all(|v| v.is_finite()));
}

#[test]
fn detects_movement_operator() {
    let spec = parse_particle_spec(ASHES_JSON);
    assert!(spec.operators.iter().any(|op| op.kind == OperatorKind::Movement));
}
