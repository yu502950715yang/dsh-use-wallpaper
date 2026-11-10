//! 发布前 P1 修复的回归测试（2026-11-10）：
//! B5 `randomframe` 帧号必须用**实际精灵表帧数**（旧实现硬编码 DEFAULT_FRAME_COUNT=4）；
//! B6 `maxcount` 缺失/为 0 时必须按 rate×平均寿命估算容量（注释承诺的 estimate 回退此前不存在）。
use we_scene_wasm::particle::{
    emitter_spec_to_particle, parse_particle_spec, AnimationMode, MAX_PARTICLES,
};

#[test]
fn random_frame_uses_actual_spritesheet_frames() {
    let spec = parse_particle_spec(
        r#"{"maxcount":200,"emitter":[{"rate":200}],
            "initializer":[{"name":"lifetimerandom","min":10,"max":10}],
            "animationmode":"randomframe"}"#,
    );
    let mut sim = emitter_spec_to_particle(&spec, [0.0, 0.0, 0.0], 1920.0, 1080.0);
    // 真实精灵表 8 帧（旧实现按 4 帧随机 ⇒ 只会出现 0..3）
    sim.spritesheet_frames = 8;
    sim.animation_mode = AnimationMode::RandomFrame;
    sim.update(0.016);
    assert!(!sim.particles.is_empty(), "应有粒子被发射");
    assert!(
        sim.particles.iter().all(|p| p.frame >= 0.0 && p.frame < 8.0),
        "帧号必须落在实际帧数范围内"
    );
    assert!(
        sim.particles.iter().any(|p| p.frame >= 4.0),
        "8 帧精灵表应能随机到 4..8（旧实现硬编码 4 帧永远不会）"
    );
}

#[test]
fn missing_maxcount_falls_back_to_rate_times_lifetime_estimate() {
    // 无 maxcount 字段（WE 允许缺省）：旧实现 maxcount=0 ⇒ 永不发射
    let spec = parse_particle_spec(r#"{"emitter":[{"rate":20}]}"#);
    assert_eq!(spec.maxcount, 0, "缺省解析值仍为 0（回退在装配期）");
    let sim = emitter_spec_to_particle(&spec, [0.0, 0.0, 0.0], 1920.0, 1080.0);
    // 估算 = ceil(rate × 平均寿命) = ceil(20 × 1.0) = 20
    assert_eq!(sim.maxcount, 20, "缺省 maxcount 必须用 rate×平均寿命估算");
    assert!(sim.maxcount <= MAX_PARTICLES);
}

#[test]
fn explicit_maxcount_is_preserved() {
    let spec = parse_particle_spec(r#"{"maxcount":50,"emitter":[{"rate":20}]}"#);
    let sim = emitter_spec_to_particle(&spec, [0.0, 0.0, 0.0], 1920.0, 1080.0);
    assert_eq!(sim.maxcount, 50);
}
