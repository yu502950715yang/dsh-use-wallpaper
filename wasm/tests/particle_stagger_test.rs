//! 修复「所有花瓣同时往下落」的回归测试（2026-09-10）。
//!
//! 根因（实测，非推测）：粒子**发射**本是按 `rate` 累积的（不是一次性 spawn 满），每片花瓣的
//! lifetime/velocity/size/frame/rotation 也都是随机的——但**从空池冷启动**时，所有粒子都处于
//! **同一寿命相位**（首帧 `lifetimePos` 标准差 ≈ 0.002），加上发射器纵向散射很小
//! （黑神话 `directions.y=0.1 × distancemax=750` → 出生 y 仅 ±75，scene 高 2160）与「一个寿命内
//! 只下落 3%~23% 屏高」，整批花瓣就在一条窄横带里**同相位平行下落** → 观感「所有花瓣同时下落 /
//! 一批一起落、一起消失」（Windows 桌面版是稳态：各花瓣处于不同相位）。
//!
//! 修复：`SceneParticleSim::prewarm()`（`CpuParticleSim::new` 已调用）——首帧铺「已经运行了约一个
//! 平均寿命」的**稳态**：`min(maxcount, ceil(rate × 平均寿命))` 个粒子，每个带**均匀随机**的出生
//! 相位 `age = age_frac × lifetime`（位置/旋转按该 age 前滚、`life` 扣减），使每片花瓣在不同相位
//! 开始下落。逐帧发射/算子语义**未改动**（本文件同时断言这一点）。

use we_scene_wasm::particle::{emitter_spec_to_particle, parse_particle_spec, SceneParticleSim};

/// 真实黑神话 Sakura 粒子规格（scene 2851992662，`particles/presets/leaves5.json`）。
const BLACK_MYTH_SPEC: &str =
    include_str!("../../research/2851992662-particles-presets-leaves5.json");

/// 受控规格：无散射（distancemax=0）、固定速度（-40 px/s）、无湍流、仅 movement 算子 →
/// 位置可精确解析（`pos.y = 发射点 y + vel.y × age`），用于断言相位前滚正确。
const CONTROLLED_SPEC: &str = r#"{
    "emitter": [{"name": "sphererandom", "rate": 20, "directions": "1 0.1 1",
                 "distancemin": 0, "distancemax": 0, "origin": "350 750 0"}],
    "initializer": [
        {"name": "lifetimerandom", "min": 4, "max": 8},
        {"name": "velocityrandom", "min": "0 -40 0", "max": "0 -40 0"},
        {"name": "sizerandom", "min": 30, "max": 50, "exponent": 2}
    ],
    "operator": [{"name": "movement"}],
    "maxcount": 50
}"#;

fn black_myth_sim() -> SceneParticleSim {
    let spec = parse_particle_spec(BLACK_MYTH_SPEC);
    emitter_spec_to_particle(&spec, [2306.34, 419.77, 0.0], 3840.0, 2160.0)
}

fn controlled_sim() -> SceneParticleSim {
    let spec = parse_particle_spec(CONTROLLED_SPEC);
    emitter_spec_to_particle(&spec, [2306.34, 419.77, 0.0], 3840.0, 2160.0)
}

/// 单粒子寿命相位 `lifetimePos = age/lifetime ∈ [0,1]`。
fn life_pos(p: &we_scene_wasm::particle::SimParticle) -> f32 {
    if p.max_life > 0.0 {
        (p.max_life - p.life) / p.max_life
    } else {
        1.0
    }
}

fn mean(v: &[f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.iter().sum::<f32>() / v.len() as f32
}

fn std_dev(v: &[f32]) -> f32 {
    if v.len() < 2 {
        return 0.0;
    }
    let m = mean(v);
    (v.iter().map(|x| (x - m) * (x - m)).sum::<f32>() / v.len() as f32).sqrt()
}

/// 缺陷对照：**冷启动**（不 prewarm）首帧全部粒子同寿命相位、纵向挤在窄带里
/// （这正是「所有花瓣同时下落」的量化形态）。
#[test]
fn cold_start_is_phase_locked_control_group() {
    let mut sim = black_myth_sim();
    sim.update(1.0 / 60.0); // 60fps 一帧 → rate=20 → 0 个（emission_timer=0.33）；再补几帧
    for _ in 0..2 {
        sim.update(1.0 / 60.0);
    }
    assert!(!sim.particles.is_empty(), "冷启动若干帧后应有粒子");

    let lp: Vec<f32> = sim.particles.iter().map(life_pos).collect();
    let ys: Vec<f32> = sim.particles.iter().map(|p| p.pos[1]).collect();
    // 同相位：所有粒子 age≈0（同一寿命阶段）→ 相位标准差 ≈ 0。
    assert!(
        std_dev(&lp) < 0.05,
        "冷启动对照组应为「同相位」（std<0.05），got {}（若已错开则说明修复改变了冷启动路径）",
        std_dev(&lp)
    );
    // 窄横带：y 散布远小于 scene 高（2160）→ 一整排花瓣同起同落。
    assert!(
        std_dev(&ys) < 60.0,
        "冷启动对照组应为窄横带（std<60），got {}",
        std_dev(&ys)
    );
}

/// 修复生效：`prewarm()` 后**首帧**即稳态——粒子数 = min(maxcount, ceil(rate×平均寿命))，
/// 寿命相位与纵向位置都显著错开（不再是一批同相位花瓣）。
#[test]
fn prewarm_seeds_staggered_steady_state_on_first_frame() {
    let mut sim = black_myth_sim();
    assert_eq!(sim.particles.len(), 0, "prewarm 前应为空池（未 update）");
    sim.prewarm();

    // rate=20、平均寿命 7.5 → 稳态存活 150 → 受 maxcount=50 封顶。
    assert_eq!(sim.particles.len(), 50, "prewarm 应铺满稳态（min(maxcount, rate×mean_life)）");

    let lp: Vec<f32> = sim.particles.iter().map(life_pos).collect();
    let ys: Vec<f32> = sim.particles.iter().map(|p| p.pos[1]).collect();
    let lp_min = lp.iter().cloned().fold(f32::INFINITY, f32::min);
    let lp_max = lp.iter().cloned().fold(f32::NEG_INFINITY, f32::max);

    // 相位错开：寿命相位散布大、且覆盖「刚出生」到「快淡出」两端。
    assert!(
        std_dev(&lp) > 0.15,
        "prewarm 后寿命相位应显著错开（std>0.15），got {}",
        std_dev(&lp)
    );
    assert!(lp_min < 0.10, "应有刚出生（相位<0.1）的花瓣，got min {}", lp_min);
    assert!(lp_max > 0.70, "应有接近淡出（相位>0.7）的花瓣，got max {}", lp_max);

    // 纵向错开：y 散布 ≫ 冷启动窄横带（>150，对比对照组 <60），即花瓣分布在不同下落阶段。
    assert!(
        std_dev(&ys) > 150.0,
        "prewarm 后纵向应显著错开（y std>150），got {}",
        std_dev(&ys)
    );
}

/// 相位前滚正确：受控规格（无散射、固定速度、仅 movement）下，每片花瓣的位置 = 发射点 + vel×age。
#[test]
fn prewarm_advances_each_particle_by_its_own_age() {
    let mut sim = controlled_sim();
    sim.prewarm();
    assert_eq!(sim.particles.len(), 50, "受控规格同样铺满 maxcount=50");

    // 发射点 y = we_to_three(419.77, scene 2160).y + origin.y(750)×obj_scale.y(2.11670)
    // = (419.77 - 1080) + 1587.525 = -660.23 + 1587.525 = 927.295（与既有坐标测试一致）。
    let emitter_y = -660.23 + 750.0 * 2.11670;

    for p in &sim.particles {
        let age = p.max_life - p.life;
        assert!(age >= 0.0 && age < p.max_life, "age 应落在 [0, lifetime)");
        // 无重力/无阻力 movement：pos += vel×age；fixed vel.y = -40。
        let expect_y = emitter_y + p.vel[1] * age;
        assert!(
            (p.pos[1] - expect_y).abs() < 5e-2,
            "位置应按各自 age 前滚：expect {} got {}（age={}, vel.y={}）",
            expect_y,
            p.pos[1],
            age,
            p.vel[1]
        );
        assert!((p.vel[1] - (-40.0)).abs() < 1e-3, "速度不应被前滚改变，got {}", p.vel[1]);
    }
    // 不同粒子处于不同下落高度（相位错开的直接体现）。
    let ys: Vec<f32> = sim.particles.iter().map(|p| p.pos[1]).collect();
    assert!(std_dev(&ys) > 50.0, "受控规格下位置也应错开（40px/s × 4~8s 寿命），got {}", std_dev(&ys));
}

/// 逐帧发射语义未被改动：常规 `update()` 仍按 `rate` 精确累积发射（`emission_timer` 残差），
/// 新粒子仍是 age=0（`life == max_life`），池满封顶。
#[test]
fn rate_emission_semantics_unchanged_after_prewarm() {
    let mut sim = black_myth_sim();
    // 不 prewarm：空池冷启动 + 3 帧（emission_timer = 3×20/60 = 1.0）→ 恰好 1 个粒子。
    for _ in 0..3 {
        sim.update(1.0 / 60.0);
    }
    assert_eq!(sim.particles.len(), 1, "rate=20 × 3 帧(0.05s) → 1 个粒子（照 lwe 精确累积）");
    assert!(
        sim.particles.iter().all(|p| p.max_life - p.life < 0.02),
        "常规发射的新粒子 age≈0（无相位偏移），不受 prewarm 影响"
    );
    // 累计 1s → 20 个粒子（rate=20）。
    for _ in 0..57 {
        sim.update(1.0 / 60.0);
    }
    assert_eq!(sim.particles.len(), 20, "rate=20 × 1s → 20 个粒子");
    assert!(
        sim.particles.iter().all(|p| p.max_life - p.life <= 1.0 + 1e-3),
        "常规发射粒子的 age 不应超过实际经过的模拟时间（无预滚相位）"
    );

    // prewarm 后继续 update：粒子数不超 maxcount，且死亡腾位后仍有新粒子补充（持续飘落）。
    let mut sim = black_myth_sim();
    sim.prewarm();
    let mut saw_young = false;
    for _ in 0..(60 * 30) {
        sim.update(1.0 / 60.0);
        assert!(sim.particles.len() <= 50, "恒不超 maxcount");
        if sim.particles.iter().any(|p| p.max_life - p.life < 0.2) {
            saw_young = true;
        }
    }
    assert!(saw_young, "稳态下应持续有刚出生的花瓣（持续飘落，不是一批齐落齐消）");
    assert!(sim.particles.len() >= 40, "30s 后仍应维持满池附近的稳态，got {}", sim.particles.len());
    // 错开不被重新对齐：稳态相位散布仍大。
    let lp: Vec<f32> = sim.particles.iter().map(life_pos).collect();
    assert!(std_dev(&lp) > 0.15, "稳态相位散布应保持（std>0.15），got {}", std_dev(&lp));
}

/// 幂等 / 封顶：重复 `prewarm()` 不超 `maxcount`。
#[test]
fn prewarm_is_idempotent_and_capped() {
    let mut sim = black_myth_sim();
    sim.prewarm();
    let n1 = sim.particles.len();
    sim.prewarm();
    sim.prewarm();
    assert_eq!(sim.particles.len(), n1, "重复 prewarm 不应再增粒子（已在稳态上限）");
    assert!(sim.particles.len() as u32 <= sim.maxcount, "不超 maxcount");
}

/// 无发射能力的规格（rate=0 / maxcount=0）→ prewarm 为 no-op（不 panic、不产粒子）。
#[test]
fn prewarm_noop_when_no_emission() {
    let json = r#"{"emitter":[{"rate":0,"directions":"1 1 1"}],
        "initializer":[{"name":"lifetimerandom","min":5,"max":10}],"maxcount":50}"#;
    let spec = parse_particle_spec(json);
    let mut sim = emitter_spec_to_particle(&spec, [0.0; 3], 3840.0, 2160.0);
    sim.prewarm();
    assert_eq!(sim.particles.len(), 0, "rate=0 → prewarm 不产粒子");

    let json = r#"{"emitter":[{"rate":20,"directions":"1 1 1"}],
        "initializer":[{"name":"lifetimerandom","min":5,"max":10}],"maxcount":0}"#;
    let spec = parse_particle_spec(json);
    let mut sim = emitter_spec_to_particle(&spec, [0.0; 3], 3840.0, 2160.0);
    sim.prewarm();
    assert_eq!(sim.particles.len(), 0, "maxcount=0 → prewarm 不产粒子");
}
