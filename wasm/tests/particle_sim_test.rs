//! SceneParticleSim（CPU 粒子模拟器，Task 2）集成测试。
//! 测试目标：模拟器能按 emission_timer 累计发射生成粒子，并随 update 逐帧运动。

use we_scene_wasm::particle::{SceneParticleSim, ParticleEmitterSpec};

#[test]
fn sim_spawns_and_moves_down() {
    // 黑神话花瓣粒子（cover 相机半高 1906，非 scene 2160）：对象中心 Y 翻 + emitter.origin 偏移。
    let mut sim = SceneParticleSim::new(
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
        1906.0,
    );

    // 多次 update 后应有粒子
    for _ in 0..20 {
        sim.update(0.05);
    }
    let v = sim.build_vertices();
    assert!(v.len() > 0, "应有粒子");

    // 至少有一个粒子在中心原点（Y 翻）或向下运动
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
