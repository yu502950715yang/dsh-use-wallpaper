//! Task 2：emitters 完整对齐 lwe——`createBoxEmitter` / `createSphereEmitter`（boxrandom / sphererandom
//! + 精确发射）测试。
//!
//! 对照 `research/.lwe/src/WallpaperEngine/Render/Objects/CParticle.cpp`：
//! - **boxrandom**（`createBoxEmitter`）：均匀盒体，各轴**独立**在 `[dist_min, dist_max]` 取 `dist`，
//!   随机 ± 翻（lwe 的 50/50 翻），再乘 `flippedDirections`（`flippedDirections.y = -directions.y`），
//!   得 `local[axis] = ±dist × |dir[axis]|`（半盒：|local[axis]| ≤ dist_max × |dir[axis]|）。
//! - **sphererandom**（`createSphereEmitter`）：3D 球壳——`cosθ` uniform[-1,1]、`unit=(sinθcosφ, sinθsinφ, cosθ)`、
//!   半径 `r = cbrt(dist_min³ + (dist_max³ - dist_min³)·rand)`（**体积均匀**）、`local = unit·r·directions`。
//! - **精确发射**：`emissionTimer += dt·rate`；`toEmit = (u32)emissionTimer`；`emissionTimer -= toEmit`；
//!   发射 `min(toEmit, maxcount - alive)`（`maxcount` 封顶；lwe 池满也清零计时器整数部分）。
//!
//! 该文件全程 native 可测（纯 Rust 数学，无 wgpu / wasm）。RNG 为进程级 Xorshift32（确定性、共享），
//! 测试断言均为**分布界/均值**（非逐值），并行执行亦稳健。

use we_scene_wasm::particle::{ParticleEmitterSpec, ParticleInitSpec, SceneParticleSim};

/// scene 默认正交尺寸（黑神话 scene.pkg，非 view cover）。
const SCENE_W: f32 = 3840.0;
const SCENE_H: f32 = 2160.0;

/// 中性 init：vel=[0,0,0]（粒子停留在发射点，位置断言确定）、寿命足够大（多次 update 仍存活）、
/// 尺寸/颜色/alpha 中性，使结论只与 emitter 相关。
fn neutral_init() -> ParticleInitSpec {
    ParticleInitSpec {
        lifetime_min: 100.0,
        lifetime_max: 1000.0,
        size_min: 16.0,
        size_max: 16.0,
        size_exponent: 1.0,
        velocity_min: [0.0; 3],
        velocity_max: [0.0; 3],
        color_min: [1.0, 1.0, 1.0],
        color_max: [1.0, 1.0, 1.0],
        alpha_min: 1.0,
        alpha_max: 1.0,
        rotation_min: [0.0; 3],
        rotation_max: [0.0; 3],
        angular_vel_min: [0.0; 3],
        angular_vel_max: [0.0; 3],
        turbulent: None,
    }
}

fn mk_emitter(rate: f32, directions: [f32; 3], dist_min: f32, dist_max: f32, is_sphere: bool) -> ParticleEmitterSpec {
    ParticleEmitterSpec {
        rate,
        origin: [0.0; 3],
        directions,
        dist_min,
        dist_max,
        is_sphere,
    }
}

/// 构造一个**发射点=0** 的模拟器：`emitter.origin=[0,0,0]` 且 `obj_origin` 取 scene 中心，
/// 使 `we_to_three(obj_origin) = [0,0,0]`，故 `pos = 发射点 + local = local`（可直接断言分布）。
fn mk_sim(emitter: ParticleEmitterSpec, maxcount: u32) -> SceneParticleSim {
    SceneParticleSim::new(
        emitter,
        maxcount,
        [SCENE_W / 2.0, SCENE_H / 2.0, 0.0], // we_to_three → [0,0,0]
        SCENE_W,
        SCENE_H,
        neutral_init(),
    )
}

// ---------------------------------------------------------------------------
// boxrandom（createBoxEmitter）：均匀盒体，各轴 `±dist × |dir|` 半盒。
// ---------------------------------------------------------------------------

#[test]
fn box_emitter_local_is_within_half_box() {
    let dir = [2.0, 3.0, 4.0];
    let dist_min = 10.0;
    let dist_max = 50.0;
    let sim = mk_sim(mk_emitter(0.0, dir, dist_min, dist_max, false), 50);

    for _ in 0..2000 {
        let local = sim.emitter_local();
        for axis in 0..3 {
            let bound = dist_max * dir[axis].abs();
            assert!(
                local[axis].abs() <= bound + 1e-3,
                "box: |local[{}]|={} 应 ≤ dist_max×|dir[{}]|={}",
                axis,
                local[axis].abs(),
                axis,
                bound
            );
            // += 翻后 magnitude 仍在 [dist_min×|dir|, dist_max×|dir|]（lwe 每轴 dist∈[min,max]）。
            let lo = dist_min * dir[axis].abs();
            assert!(
                local[axis].abs() >= lo - 1e-3,
                "box: |local[{}]|={} 应 ≥ dist_min×|dir[{}]|={}",
                axis,
                local[axis].abs(),
                axis,
                lo
            );
        }
    }
}

#[test]
fn box_spawned_position_within_box_around_emission_point() {
    // 端到端（update→spawn）：发射点=0（origin=0、obj_origin=scene 中心），大量粒子每个 pos 都
    // 落在盒体半尺寸内，证明散射局部**不被对象 scale 放大**（全局约束）且盒体正确。
    let dir = [2.0, 3.0, 4.0];
    let dist_max = 40.0;
    let mut sim = mk_sim(mk_emitter(500.0, dir, 0.0, dist_max, false), 500);
    sim.update(1.0); // rate=500, dt=1 → 恰好发射 min(500, 500)=500 个（寿命 100..1000 不死亡）。
    assert_eq!(sim.particles.len(), 500, "应精确发射 500 个（maxcount=500）");

    for p in &sim.particles {
        for axis in 0..3 {
            let bound = dist_max * dir[axis].abs();
            assert!(
                p.pos[axis].abs() <= bound + 1e-3,
                "spawn 后 pos[{}]={} 应 ≤ 盒半宽 {}（发射点=0，散射不乘 scale）",
                axis,
                p.pos[axis],
                bound
            );
        }
    }
}

// ---------------------------------------------------------------------------
// sphererandom（createSphereEmitter）：3D 球壳，r∈[dist_min,dist_max] 且 cbrt 体积均匀。
// ---------------------------------------------------------------------------

#[test]
fn sphere_emitter_local_is_shell_with_cbrt_radius() {
    let dir = [1.0, 1.0, 1.0]; // 使 |local| = r（unit·r·dir，|unit|=1，dir 各轴 1）。
    let dist_min = 10.0;
    let dist_max = 50.0;
    let sim = mk_sim(mk_emitter(0.0, dir, dist_min, dist_max, true), 50);

    let samples = 2000;
    let mut sum_r3 = 0.0;
    for _ in 0..samples {
        let local = sim.emitter_local();
        let r = (local[0] * local[0] + local[1] * local[1] + local[2] * local[2]).sqrt();
        assert!(r >= dist_min - 1e-3, "球壳 r={} 应 ≥ dist_min={}", r, dist_min);
        assert!(r <= dist_max + 1e-3, "球壳 r={} 应 ≤ dist_max={}", r, dist_max);
        sum_r3 += r * r * r;
    }
    // cbrt 体积均匀 → r³ = uniform(dist_min³, dist_max³)，均值 ≈ 中点（±5%）。
    let mean_r3 = sum_r3 / samples as f32;
    let mid = (dist_min.powi(3) + dist_max.powi(3)) / 2.0;
    let tol = (dist_max.powi(3) - dist_min.powi(3)) * 0.05;
    assert!(
        (mean_r3 - mid).abs() < tol,
        "r³ 均值 {} 应 ≈ {}（{} ± {}，cbrt 均匀）",
        mean_r3,
        mid,
        mid,
        tol
    );
}

// ---------------------------------------------------------------------------
// is_sphere 分支：box 与 sphere 明显不同（固定 dist_min=dist_max=D 时）。
// ---------------------------------------------------------------------------

#[test]
fn is_sphere_branches_box_vs_shell() {
    let d = 30.0;
    let box_sim = mk_sim(mk_emitter(0.0, [1.0, 1.0, 1.0], d, d, false), 50);
    let sphere_sim = mk_sim(mk_emitter(0.0, [1.0, 1.0, 1.0], d, d, true), 50);

    for _ in 0..1000 {
        // box：dist_min=dist_max=D → 各轴 ±D → |local| = D√3（盒角）。
        let l = box_sim.emitter_local();
        let r = (l[0] * l[0] + l[1] * l[1] + l[2] * l[2]).sqrt();
        assert!((r - d * 3.0f32.sqrt()).abs() < 1e-3, "box 固定半径 D → |local| 应=D√3，got {}", r);
        // sphere：r = cbrt(D³) = D → |local| = D（壳体）。
        let l = sphere_sim.emitter_local();
        let r = (l[0] * l[0] + l[1] * l[1] + l[2] * l[2]).sqrt();
        assert!((r - d).abs() < 1e-3, "sphere 固定半径 D → |local| 应=D，got {}", r);
    }
    // 两分支应明显不同（盒 vs 壳）。
    assert!((d * 3.0f32.sqrt() - d).abs() > 1.0, "box(≈D√3) 与 sphere(=D) 应不同");
}

// ---------------------------------------------------------------------------
// 精确发射：emissionTimer 累积 + rate 数目 + maxcount 封顶。
// ---------------------------------------------------------------------------

#[test]
fn emission_timer_accumulates_and_emits_per_rate() {
    // rate=2, dt=1, 5 帧 → 每帧 toEmit=2、timer 无残差 → 精确 10 个（寿命 100..1000，未死亡）。
    let mut sim = mk_sim(mk_emitter(2.0, [0.0, 0.0, 0.0], 0.0, 1.0, true), 200);
    for _ in 0..5 {
        sim.update(1.0);
    }
    assert_eq!(sim.particles.len(), 10, "rate=2, dt=1, 5 帧应精确发射 10 个");
    // emission_timer 应为 0（无残差）。
    assert!((sim.emission_timer - 0.0).abs() < 1e-6, "emission_timer 无残差，got {}", sim.emission_timer);
}

#[test]
fn emission_timer_keeps_fractional_residual() {
    // rate=2.5, dt=1：帧1 timer=2.5→toEmit=2、残差0.5；帧2 timer=0.5+2.5=3.0→toEmit=3、残差0。
    let mut sim = mk_sim(mk_emitter(2.5, [0.0, 0.0, 0.0], 0.0, 1.0, true), 200);
    sim.update(1.0);
    assert_eq!(sim.particles.len(), 2, "帧1: rate=2.5 → 发射 2 个（残差 0.5）");
    assert!((sim.emission_timer - 0.5).abs() < 1e-4, "帧1 后残差应 0.5，got {}", sim.emission_timer);
    sim.update(1.0);
    assert_eq!(sim.particles.len(), 5, "帧2: 残差 0.5+2.5=3.0 → 再 3 个，共 5");
}

#[test]
fn emission_capped_by_maxcount() {
    // rate=5, dt=1, maxcount=3：帧1 发射 min(5,3)=3，emission_timer 清零；后续帧不增（池满）。
    let mut sim = mk_sim(mk_emitter(5.0, [0.0, 0.0, 0.0], 0.0, 1.0, true), 3);
    for _ in 0..3 {
        sim.update(1.0);
    }
    assert_eq!(sim.particles.len(), 3, "maxcount=3 应封顶 3 个粒子，不因 rate 再增加");
    // 池满时 lwe 仍清零计时器整数部分（不无限累加）。
    assert!(sim.emission_timer < 1.0, "池满后 emission_timer 应为小数残差，got {}", sim.emission_timer);
}
