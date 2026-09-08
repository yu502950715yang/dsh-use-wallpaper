//! Task 1：坐标/矩阵对齐 WE——粒子发射点坐标与对象变换、mvp 语义测试。
//!
//! 上游裁决（spec §3）：对象中心用 `we_to_three(origin, scene_w, scene_h)`——scene 尺寸、y **不翻**、
//! 与背景/图层同坐标系（**不再用 Y 翻转的 obj_transform**）。emitter 局部偏移含对象 scale 经对象
//! model 矩阵变换到场景空间；黑神话发射点因此落在屏幕**顶部偏左**、NDC≈0.97（**屏内**，匹配
//! 用户实测 Windows「顶部偏左」），非离屏。
//!
//! 三个测试契约：
//! 1. 对象中心 = `we_to_three(origin, scene_w, scene_h)`（与背景/图层一致）；黑神话对象中心 y=-660.23。
//! 2. 黑神话发射点经对象 scale（`BLACKMYTH_OBJ_SCALE`）落在屏幕**顶部偏左**（pos.x<0，
//!    NDC y≈0.97 → 屏内 0<pos.y<view_h/2 且 >0.9×view_h/2）。
//! 3. `emitter.origin="0 0 0"` 的壁纸（EVA/DK 等）乘对象 scale 仍 0 → 发射点=对象中心（we_to_three），不受影响。
//!
//! 全程 native 可测（纯 Rust 数学，无 wgpu / wasm）。

use we_scene_wasm::coords::we_to_three;
use we_scene_wasm::particle::sim::BLACKMYTH_OBJ_SCALE;
use we_scene_wasm::particle::{ParticleEmitterSpec, ParticleInitSpec, SceneParticleSim};

/// 黑神话场景默认正交尺寸（scene.pkg，非 view cover）。
const SCENE_W: f32 = 3840.0;
const SCENE_H: f32 = 2160.0;
/// 黑神话「Sakura」粒子对象 origin（scene.pkg）。
const OBJ_ORIGIN: [f32; 3] = [2306.34, 419.77, 0.0];
/// cover 相机尺寸参考：scene 3840×2160 按窗口宽高比裁剪（particle_render.rs 注释「如 3840/1906」）。
const VIEW_W: f32 = 3840.0;
const VIEW_H: f32 = 1906.0;

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
        turbulent: None,
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
fn object_center_is_we_to_three_consistent_with_background() {
    // spec §3：对象中心用 we_to_three（scene 尺寸、y 不翻、与背景/图层一致），不用 Y 翻转的 obj_transform。
    // 黑神话对象 (2306.34, 419.77) → (2306.34-1920, 419.77-1080) = (386.34, -660.23)（对象在 scene 中心下方）。
    let (x, y) = we_to_three(OBJ_ORIGIN[0], OBJ_ORIGIN[1], SCENE_W, SCENE_H);
    assert!((x - 386.34).abs() < 1e-3, "we_to_three.x 应为 386.34，got {}", x);
    assert!((y - (-660.23)).abs() < 1e-3, "we_to_three.y 应为 -660.23（y 不翻，与背景一致），got {}", y);
}

#[test]
fn blackmyth_emits_on_screen_top_left() {
    // 发射点 = we_to_three(obj_origin) + emitter.origin × obj_scale（仅发射点中心乘 scale）。
    // 黑神话 emitter.origin=(350,750,0)，obj_scale=(-2.05166, 2.11670, 1) →
    //   偏移 = (350×-2.05166, 750×2.11670) = (-718.08, 1587.53)；
    //   pos = (386.34-718.08, -660.23+1587.53) = (-331.741, 927.30)。
    // NDC（view 半高=1906/2=953）= (x=-331.741/1920, y=927.30/953) ≈ (-0.17, 0.973) → 屏内顶部偏左。
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
    assert!(p.pos[1] > 0.0, "黑神话发射点 y 应为正（y>0，上方），got {}", p.pos[1]);
    // 屏内顶部（非离屏）：0 < pos.y < view_h/2（NDC y<1），且近顶（NDC y>0.9）。
    assert!(p.pos[1] < VIEW_H / 2.0,
        "黑神话发射点应屏内（pos.y<view_h/2 非离屏），pos.y={} vs {}",
        p.pos[1], VIEW_H / 2.0);
    assert!(p.pos[1] > VIEW_H / 2.0 * 0.9,
        "黑神话发射点应近顶（NDC y>0.9），pos.y={} vs {}",
        p.pos[1], VIEW_H / 2.0 * 0.9);

    // 精确位置（we_to_three 中心 + 发射点中心乘对象 scale）。
    assert!((p.pos[0] - (-331.741)).abs() < 1e-2, "pos.x 应为 -331.741，got {}", p.pos[0]);
    assert!((p.pos[1] - 927.295).abs() < 1e-2, "pos.y 应为 927.30（NDC≈0.97 屏内顶部偏左），got {}", p.pos[1]);
}

#[test]
fn zero_emitter_origin_is_object_center_consistent_with_background() {
    // EVA/DK 等 emitter.origin="0 0 0"：× 对象 scale 仍 0 → 发射点 = 对象中心（we_to_three 结果）。
    // we_to_three(2306.34,419.77, 3840,2160) = (386.34, -660.23)，与背景/图层同坐标系（y 不翻）。
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

    // emitter.origin=(0,0,0) → pos = 对象中心 (386.34, -660.23)，不受对象 scale 影响。
    assert!((p.pos[0] - 386.34).abs() < 1e-2, "pos.x 应为对象中心 386.34，got {}", p.pos[0]);
    assert!((p.pos[1] - (-660.23)).abs() < 1e-2, "pos.y 应为对象中心 -660.23（we_to_three，与背景一致），got {}", p.pos[1]);
}

#[test]
fn blackmyth_obj_scale_constant_matches_scene_pkg() {
    // 常量应与 scene.pkg `-2.05166 2.11670 1.00000` 一致（Task 1 先作常量；Task 6 再泛化每对象）。
    assert_eq!(BLACKMYTH_OBJ_SCALE, [-2.05166, 2.11670, 1.0]);
}
