//! Task 4.5：`spec.operators` → `sim.operators` 接线测试。
//!
//! 验证 `spec_to_emitter::spec_operators_to_sim`（纯函数，native 可测）把 spec 解析出的
//! `Vec<Operator>` 映射为 `Vec<ParticleOperator>`，并确证 `emitter_spec_to_particle` 把它
//! 接线进 `SceneParticleSim.operators`（`update()` 逐帧对每个粒子跑）。
//!
//! 关键回归（Task 6 依赖）：
//! - **黑神话** operator：movement（无 gravity/drag）+ alphafade（0.1/0.9）+ angularmovement（无 force/drag）。
//! - **EVA（Ashes）** operator：movement（gravity "1 0 0"）+ alphafade（0.5/0.5）。
//! - **无 operators** → 缺省一个无重力/无阻力的 `Movement`（保既有行为）。
//!
//! 源码/字段对齐结论（见 `spec_operators_to_sim` 注释）：
//! - movement：`gravity`（vec3，缺省 0）、`drag`（标量，缺省 0）。
//! - alphafade：`fadeintime`/`fadeouttime`（缺省 0.5/0.5 照 lwe）。
//! - angularmovement：`force`（vec3，缺省 0）、`drag`（标量，缺省 0）；
//!   其 `angular_vel` 由 `angularvelocityrandom` initializer 在 spawn 时提供（Task 3）。
//! - turbulence：`scale`/`timescale`/`speedmin`/`speedmax`/`phasemin`/`phasemax` + `mask`。
//! - oscillateposition：`frequencymin`/`frequencymax`/`scalemin`/`scalemax`/`phasemin`/`phasemax` + `mask`。

use we_scene_wasm::particle::sim::ParticleOperator;
use we_scene_wasm::particle::{emitter_spec_to_particle, parse_particle_spec, spec_operators_to_sim};

/// 黑神话「Sakura」花瓣粒子系统（`research/2851992662-particles-presets-leaves5.json` 的 operator 段）。
const BLACK_MYTH_JSON: &str = r#"{
    "emitter": [{"name":"sphererandom","rate":20,"directions":"1 0.1 1","distancemin":0,"distancemax":750,"origin":"350 750 0"}],
    "initializer": [
        {"name":"lifetimerandom","min":5,"max":10},
        {"name":"sizerandom","min":30,"max":50,"exponent":2},
        {"name":"velocityrandom","min":"-50 -50 0","max":"0 -15 0"},
        {"name":"angularvelocityrandom","min":"-5 -5 -5","max":"5 5 5"}
    ],
    "operator": [
        {"name":"movement"},
        {"name":"alphafade","fadeintime":0.1,"fadeouttime":0.9},
        {"name":"angularmovement"}
    ],
    "maxcount": 50
}"#;

/// EVA 灰烬粒子系统（`wasm/tests/fixtures/eva/particles_Ashes.json` 的 operator 段）。
const EVA_ASHES_JSON: &str = r#"{
    "emitter": [{"name":"boxrandom","directions":"1 1 1","origin":"0 0 0"}],
    "initializer": [
        {"name":"lifetimerandom","min":3,"max":5},
        {"name":"sizerandom","min":20,"max":50},
        {"name":"velocityrandom","min":"-50 -50 0","max":"50 0 0"}
    ],
    "operator": [
        {"name":"movement","gravity":"1 0 0"},
        {"name":"alphafade","fadeintime":0.5,"fadeouttime":0.5}
    ],
    "maxcount": 500
}"#;

/// 断言该算子为 `Movement{gravity, drag}`（近似比较 drag；gravity 精确）。
fn assert_movement(op: &ParticleOperator, exp_gravity: [f32; 3], exp_drag: f32) {
    match op {
        ParticleOperator::Movement { gravity, drag } => {
            assert_eq!(*gravity, exp_gravity, "movement.gravity 应为 {exp_gravity:?}");
            assert!((*drag - exp_drag).abs() < 1e-6, "movement.drag 应为 {exp_drag}, got {}", drag);
        }
        _ => panic!("应含 Movement 算子, got {op:?}"),
    }
}

/// 断言该算子为 `AlphaFade{fade_in, fade_out}`。
fn assert_alpha_fade(op: &ParticleOperator, exp_fi: f32, exp_fo: f32) {
    match op {
        ParticleOperator::AlphaFade { fade_in, fade_out } => {
            assert!((*fade_in - exp_fi).abs() < 1e-6, "fade_in 应为 {exp_fi}, got {}", fade_in);
            assert!((*fade_out - exp_fo).abs() < 1e-6, "fade_out 应为 {exp_fo}, got {}", fade_out);
        }
        _ => panic!("应含 AlphaFade 算子, got {op:?}"),
    }
}

/// 断言该算子为 `AngularMovement{force, drag}`。
fn assert_angular_movement(op: &ParticleOperator, exp_force: [f32; 3], exp_drag: f32) {
    match op {
        ParticleOperator::AngularMovement { force, drag } => {
            assert_eq!(*force, exp_force, "angularmovement.force 应为 {exp_force:?}");
            assert!((*drag - exp_drag).abs() < 1e-6, "angularmovement.drag 应为 {exp_drag}, got {}", drag);
        }
        _ => panic!("应含 AngularMovement 算子, got {op:?}"),
    }
}

/// 黑神话：movement（无 gravity/drag → 0）+ alphafade（0.1/0.9）+ angularmovement（无 force/drag → 0）。
/// 顺序（照 spec）：[Movement, AlphaFade, AngularMovement]。
#[test]
fn black_myth_spec_maps_movement_alpha_fade_angular_movement() {
    let spec = parse_particle_spec(BLACK_MYTH_JSON);

    // 纯函数（native 可测）。
    let ops = spec_operators_to_sim(&spec);
    assert_eq!(ops.len(), 3, "黑话 operator 顺序: movement/alphafade/angularmovement");
    assert_movement(&ops[0], [0.0, 0.0, 0.0], 0.0); // 黑话 movement 无 gravity/drag
    assert_alpha_fade(&ops[1], 0.1, 0.9); // 黑话 alphafade 0.1/0.9
    assert_angular_movement(&ops[2], [0.0, 0.0, 0.0], 0.0); // 黑话 angularmovement 无 force/drag

    // 接线：emitter_spec_to_particle → sim.operators。
    let sim = emitter_spec_to_particle(&spec, [2306.34, 419.77, 0.0], 3840.0, 2160.0);
    let sim_ops = &sim.operators;
    assert_eq!(sim_ops.len(), 3, "接线后 sim.operators 应含 3 个算子");
    assert_movement(&sim_ops[0], [0.0, 0.0, 0.0], 0.0);
    assert_alpha_fade(&sim_ops[1], 0.1, 0.9);
    assert_angular_movement(&sim_ops[2], [0.0, 0.0, 0.0], 0.0);
}

/// EVA（Ashes）：movement（gravity "1 0 0"）+ alphafade（0.5/0.5）。顺序：[Movement, AlphaFade]。
#[test]
fn eva_spec_maps_movement_gravity_and_alpha_fade() {
    let spec = parse_particle_spec(EVA_ASHES_JSON);

    let ops = spec_operators_to_sim(&spec);
    assert_eq!(ops.len(), 2, "EVA operator 顺序: movement/alphafade");
    assert_movement(&ops[0], [1.0, 0.0, 0.0], 0.0); // EVA gravity "1 0 0"
    assert_alpha_fade(&ops[1], 0.5, 0.5); // EVA alphafade 0.5/0.5

    let sim = emitter_spec_to_particle(&spec, [0.0; 3], 3840.0, 2160.0);
    let sim_ops = &sim.operators;
    assert_eq!(sim_ops.len(), 2);
    assert_movement(&sim_ops[0], [1.0, 0.0, 0.0], 0.0);
    assert_alpha_fade(&sim_ops[1], 0.5, 0.5);
}

/// 无 operators → 缺省一个无重力/无阻力的 `Movement`（保既有匀速直线/静止行为）。
#[test]
fn no_operators_defaults_to_movement() {
    let spec = parse_particle_spec(r#"{"emitter":[{"rate":10}]}"#);
    assert!(spec.operators.is_empty(), "无 operator → spec.operators 应为空");

    let ops = spec_operators_to_sim(&spec);
    assert_eq!(ops.len(), 1, "无 operators → 缺省 1 个 movement");
    assert_movement(&ops[0], [0.0, 0.0, 0.0], 0.0);

    let sim = emitter_spec_to_particle(&spec, [0.0; 3], 3840.0, 2160.0);
    assert_eq!(sim.operators.len(), 1, "接线后仍缺省 1 个 movement");
    assert_movement(&sim.operators[0], [0.0, 0.0, 0.0], 0.0);
}

/// turbulence / oscillateposition 全字段映射（核对 `spec_operators_to_sim` 的 Turbulence 与
/// OscillatePosition 分支：scale/timescale/speed/phase/mask、frequency/scale/phase/mask）。
#[test]
fn turbulence_and_oscillate_position_map() {
    let json = r#"{
        "emitter":[{"rate":10}],
        "operator":[
            {"name":"turbulence","scale":0.5,"timescale":10,"speedmin":50,"speedmax":100,"phasemin":0,"phasemax":1,"mask":"1 0 0"},
            {"name":"oscillateposition","frequencymin":1,"frequencymax":2,"scalemin":0.1,"scalemax":0.9,"phasemin":0,"phasemax":3.14,"mask":"1 1 0"}
        ]
    }"#;
    let spec = parse_particle_spec(json);
    let ops = spec_operators_to_sim(&spec);
    assert_eq!(ops.len(), 2, "turbulence + oscillateposition");

    match &ops[0] {
        ParticleOperator::Turbulence { scale, time_scale, mask, .. } => {
            assert!((*scale - 0.5).abs() < 1e-6, "turbulence.scale 应为 0.5");
            assert!((*time_scale - 10.0).abs() < 1e-6, "turbulence.timescale 应为 10");
            assert_eq!(*mask, [1.0, 0.0, 0.0], "turbulence.mask 应为 [1,0,0]");
        }
        _ => panic!("应含 Turbulence 算子, got {:?}", ops[0]),
    }

    match &ops[1] {
        ParticleOperator::OscillatePosition { freq_min, freq_max, scale_min, scale_max, mask, .. } => {
            assert!((*freq_min - 1.0).abs() < 1e-6, "frequencymin 应为 1");
            assert!((*freq_max - 2.0).abs() < 1e-6, "frequencymax 应为 2");
            assert!((*scale_min - 0.1).abs() < 1e-6, "scalemin 应为 0.1");
            assert!((*scale_max - 0.9).abs() < 1e-6, "scalemax 应为 0.9");
            assert_eq!(*mask, [1.0, 1.0, 0.0], "oscillateposition.mask 应为 [1,1,0]");
        }
        _ => panic!("应含 OscillatePosition 算子, got {:?}", ops[1]),
    }
}
