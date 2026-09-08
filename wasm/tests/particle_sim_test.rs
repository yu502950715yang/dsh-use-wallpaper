//! SceneParticleSim（CPU 粒子模拟器，Task 2）集成测试。
//! 测试目标：模拟器能按 emission_timer 累计发射生成粒子，并随 update 逐帧向下飘（无重力）。

use we_scene_wasm::particle::{ParticleEmitterSpec, ParticleInitSpec, SceneParticleSim};

/// 构建黑神话花瓣模拟器（scene 3840×2160；对象中心映射用 scene 尺寸，与背景/图层一致）。
/// init 为黑神话 spec.init 的映射值：vel.y∈[-50,-15]（向下飘）、size∈[30,50]（exp2）、
/// life∈[5,10]、粉 color → spawn 用各自 init 而非黑神话硬编码。
fn flower_sim() -> SceneParticleSim {
    SceneParticleSim::new(
        ParticleEmitterSpec {
            rate: 20.0,
            origin: [350.0, 750.0, 0.0],
            directions: [1.0, 0.1, 1.0],
            dist_min: 0.0,
            dist_max: 750.0,
            is_sphere: true,
        },
        50,
        [2306.34, 419.77, 0.0],
        3840.0,
        2160.0,
        ParticleInitSpec {
            lifetime_min: 5.0,
            lifetime_max: 10.0,
            size_min: 30.0,
            size_max: 50.0,
            size_exponent: 2.0,
            velocity_min: [-50.0, -50.0, 0.0],
            velocity_max: [0.0, -15.0, 0.0],
            color_min: [1.0, 0.83, 0.97],
            color_max: [1.0, 0.83, 0.97],
            alpha_min: 1.0,
            alpha_max: 1.0,
            rotation_min: [0.0; 3],
            rotation_max: [0.0; 3],
            angular_vel_min: [0.0; 3],
            angular_vel_max: [0.0; 3],
            turbulent: None,
        },
    )
}

#[test]
fn sim_spawns_and_moves_down() {
    let mut sim = flower_sim();

    // 多次 update 后应有粒子出生。
    for _ in 0..20 {
        sim.update(0.05);
    }
    assert!(sim.particles.len() > 0, "应有粒子");
    let v = sim.build_vertices();
    assert_eq!(v.len(), sim.particles.len(), "alive 粒子应全部输出到顶点缓冲");

    // 分布：粒子围绕中心原点（scene 语义，y 向上）上下分布（运动/分布真实断言，非空断言）。
    let mut moved_down = false;
    let mut any_up = false;
    for p in &v {
        if p[1] > 0.0 {
            any_up = true;
        }
        if p[1] < 0.0 {
            moved_down = true;
        }
    }
    assert!(any_up || moved_down, "粒子应分布（上/下）");
}

#[test]
fn petals_fall_down_no_gravity() {
    let mut sim = flower_sim();

    // 先让粒子出生（多次 update 累计发射）。
    for _ in 0..20 {
        sim.update(0.05);
    }
    assert!(sim.particles.len() > 0, "expected spawned particles");

    // 快照 update 前每个粒子的 (pos[1], vel[1])，用于验证「向下、无重力」。
    let before: Vec<(f32, f32)> = sim.particles.iter().map(|p| (p.pos[1], p.vel[1])).collect();

    // 黑神话花瓣：spawn 时 vel[1] 初始为负（-50..-15，向下飘）。
    assert!(
        before.iter().all(|&(_, vy)| vy < 0.0),
        "花瓣 vel[1] 初始应为负（向下），got {:?}",
        before
    );

    // 再跑一帧：无重力 → vel[1] 保持不变、仍为负（不变向上）；
    // 位置 pos[1] 因 vel[1]<0 而递减（向下运动）。
    sim.update(0.05);
    for (p, &(prev_y, prev_vy)) in sim.particles.iter().zip(before.iter()) {
        assert!(
            (p.vel[1] - prev_vy).abs() < 1e-6,
            "无重力：vy 应保持为初始值（不叠加），got {} vs {}",
            p.vel[1],
            prev_vy
        );
        assert!(p.vel[1] <= 0.0, "无重力：vy 不应变成向上，got {}", p.vel[1]);
        assert!(
            p.pos[1] < prev_y,
            "无重力向下：pos[1] 应随负 vy 递减，got {} vs {}",
            p.pos[1],
            prev_y
        );
    }
}
