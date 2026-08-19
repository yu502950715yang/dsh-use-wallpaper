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
    // 仅验证真实 fixture 解析结果均为有限值：
    // Ashes emitter 无 distancemax 字段 → 走缺省分支 256.0（不经过 token 解析）；
    // velocityrandom.max = "50 0 0" 三个 token 均可解析（vec3 正常路径）。
    // 防 NaN 的 token 解析路径由 scalar_string_parses_first_token /
    // unparsable_token_falls_back_to_zero 两个内联测试专门覆盖。
    let spec = parse_particle_spec(ASHES_JSON);
    assert!(spec.emitter.distance_max.is_finite());
    assert!(spec.init.velocity_max.iter().all(|v| v.is_finite()));
}

#[test]
fn scalar_string_parses_first_token() {
    // 标量字段为多 token 字符串 → 取第一 token（防把 "50 256 0" 整串解析成 NaN）
    let spec = parse_particle_spec(r#"{"emitter":[{"rate":"50 256 0"}]}"#);
    assert_eq!(spec.emitter.rate, 50.0);
}

#[test]
fn unparsable_token_falls_back_to_zero() {
    // token 无法解析为数字 → 回退 0.0，不得 panic / NaN
    let spec = parse_particle_spec(r#"{"initializer":[{"name":"velocityrandom","max":"abc def"}]}"#);
    assert_eq!(spec.init.velocity_max, [0.0, 0.0, 0.0]);
}

#[test]
fn detects_movement_operator() {
    let spec = parse_particle_spec(ASHES_JSON);
    assert!(spec.operators.iter().any(|op| op.kind == OperatorKind::Movement));
}
