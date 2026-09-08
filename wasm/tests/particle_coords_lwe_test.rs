//! Task 1：坐标/矩阵对齐 lwe/WE（方案 A）——粒子发射点坐标与对象变换、mvp 语义测试。
//!
//! 权威基准：`research/.lwe/.../CParticle.cpp` 的 `setup()`（约 102-170 行）把 particle 的
//! screen space origin 转 **centered space**：`origin.x -= scene_w/2; origin.y = scene_h/2 - origin.y;`
//! ——对象中心用 lwe 中心化（`obj_transform`，y 向上为正）；emitter 局部偏移经**对象 model 矩阵**
//! （含对象 scale）变换到场景空间，发射点因此落在屏幕**顶部偏左**（黑神话）。
//!
//! 三个测试契约：
//! 1. `obj_transform(origin, scene_w, scene_h) == [x - scene_w/2, scene_h/2 - y, z]`（lwe 中心化）。
//! 2. 黑神话发射点经对象 scale（`BLACKMYTH_OBJ_SCALE`）落在屏幕**顶部偏左**（pos.y>0 且 >view_h/2，
//!    pos.x<0）。
//! 3. `emitter.origin="0 0 0"` 的壁纸（EVA/DK 等）乘对象 scale 仍为 0 → 发射点=对象中心，不受影响。
//!
//! 全程 native 可测（纯 Rust 数学，无 wgpu / wasm）。

use we_scene_wasm::particle::sim::{obj_transform, BLACKMYTH_OBJ_SCALE};
use we_scene_wasm::particle::{ParticleEmitterSpec, ParticleInitSpec, SceneParticleSim};

/// 黑神话场景默认正交尺寸（scene.pkg，非 view cover）。
const SCENE_W: f32 = 3840.0;
const SCENE_H: f32 = 2160.0;
/// 黑神话「Sakura」粒子对象 origin（scene.pkg）。
const OBJ_ORIGIN: [f32; 3] = [2306.34, 419.77, 0.0];

/// 中性 init：vel=[0,0,0]（使 update 后 pos 保持发射点，位置断言不依赖 init 随机值）、
/// life 5..10（一次 dt=1 update 后仍存活）、size/color/alpha 中性。
fn neutral_init() -> ParticleInitSpec {
    ParticleInitSpec {
        lifetime_min: 5.0,
        lifetime_max: 10.0,
        size_min: 30.0,
        size_max: 50.0,
        size_exponent: 2.0,
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
    }
}

fn neutered_emitter(origin: [f32; 3]) -> ParticleEmitterSpec {
    ParticleEmitterSpec {
        rate: 1.0,
        origin,
        directions: [0.0; 3], // 局部球壳偏移=0 → 发射点=对象中心+emitter.origin×scale（确定）
        dist_min: 0.0,
        dist_max: 0.0,
        is_sphere: false,
    }
}

#[test]
fn obj_transform_is_lwe_centering() {
    // lwe `setup()`：x -= scene_w/2；y = scene_h/2 - y。
    // 黑神话对象 (2306.34, 419.77) → (2306.34-1920, 1080-419.77) = (386.34, 660.23)（对象在中心上方）。
    let c = obj_transform(OBJ_ORIGIN, SCENE_W, SCENE_H);
    assert!((c[0] - 386.34).abs() < 1e-3, "obj_transform.x 应为 386.34（lwe 中心化），got {}", c[0]);
    assert!((c[1] - 660.23).abs() < 1e-3, "obj_transform.y 应为 660.23（scene_h/2 - origin.y，y 向上），got {}", c[1]);
    assert_eq!(c[2], 0.0, "obj_transform.z 应保持 origin.z");
}

#[test]
fn blackmyth_emits_top_left_after_obj_transform() {
    // 发射点 = obj_transform(origin) + emitter.origin × obj_scale（仅发射点中心乘 scale）。
    // 黑神话 emitter.origin=(350,750,0)，obj_scale=(-2.05166, 2.11670, 1) →
    //   偏移 = (350×-2.05166, 750×2.11670) = (-718.08, 1587.53)；
    //   pos = (386.34-718.08, 660.23+1587.53) = (-331.741, 2247.755)（屏幕顶部偏左）。
    let mut sim = SceneParticleSim::new(
        neutered_emitter([350.0, 750.0, 0.0]),
        8,
        OBJ_ORIGIN,
        SCENE_W,
        SCENE_H,
        neutral_init(),
    );
    // rate=1.0, dt=1.0 → emission_timer=1.0 → 恰好发射 1 个粒子（life 5..10-1 仍存活）。
    sim.update(1.0);
    assert_eq!(sim.particles.len(), 1, "rate=1, dt=1 应恰好发射 1 个粒子");
    let p = &sim.particles[0];

    assert!(p.pos[0] < 0.0, "黑神话应偏左（x<0），got {}", p.pos[0]);
    assert!(p.pos[1] > 0.0, "黑神话发射点 y 应为正（y>0），got {}", p.pos[1]);
    // view ortho 用 scene 高（2160）作 view_h：pos.y 应 > view_h/2（1080）→ 屏幕顶部。
    let view_h = SCENE_H;
    assert!(p.pos[1] > view_h / 2.0, "黑神话发射点应 > view_h/2（顶部），pos.y={} vs {}",
        p.pos[1], view_h / 2.0);

    // 精确位置（lwe 中心化 + 发射点中心乘对象 scale）。
    assert!((p.pos[0] - (-331.741)).abs() < 1e-2, "pos.x 应为 -331.741，got {}", p.pos[0]);
    assert!((p.pos[1] - 2247.755).abs() < 1e-2, "pos.y 应为 2247.755，got {}", p.pos[1]);
}

#[test]
fn zero_emitter_origin_unaffected_by_obj_scale() {
    // EVA/DK 等 emitter.origin="0 0 0"：× 对象 scale 仍 0 → 发射点 = 对象中心（obj_transform 结果）。
    // obj_transform(2306.34,419.77, 3840,2160) = (386.34, 660.23)。对象 scale 对 origin=0 不产生偏移。
    let mut sim = SceneParticleSim::new(
        neutered_emitter([0.0; 3]),
        8,
        OBJ_ORIGIN,
        SCENE_W,
        SCENE_H,
        neutral_init(),
    );
    sim.update(1.0);
    assert!(sim.particles.len() >= 1, "应发射粒子");
    let p = &sim.particles[0];

    // emitter.origin=(0,0,0) → pos = 对象中心 (386.34, 660.23)，不受对象 scale 影响。
    assert!((p.pos[0] - 386.34).abs() < 1e-2, "pos.x 应为对象中心 386.34，got {}", p.pos[0]);
    assert!((p.pos[1] - 660.23).abs() < 1e-2, "pos.y 应为对象中心 660.23（不受 scale 影响），got {}", p.pos[1]);
}

#[test]
fn blackmyth_obj_scale_constant_matches_scene_pkg() {
    // 常量应与 scene.pkg `-2.05166 2.11670 1.00000` 一致（Task 1 先作常量；Task 6 再泛化每对象）。
    assert_eq!(BLACKMYTH_OBJ_SCALE, [-2.05166, 2.11670, 1.0]);
}
