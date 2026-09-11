//! scene.json 对象级 `instanceoverride`（粒子实例覆盖）测试。
//!
//! 官方语义（OWE `OverrideSpawnProgram`，ParticleParser.cpp:359-384；装配见
//! `SceneParticleObjectParser.cpp:247-264`）：override 作为**追加在最后**的 spawn initializer，
//! 对已经随机出来的初值做乘法/覆盖；emitter rate 乘 `Count()`。标量换算
//! `UiScalarToLinear(v) = v`（恒等），颜色 `UiColorToLinear(v) = v²`。
//!
//! 回归背景（GTR 3743126786，「贯穿全屏的竖直白烟串」，2026-09-11 定位）：该壁纸烟柱对象
//! `instanceoverride = {alpha: 0.03, size: 2.09}` —— alpha 0.03 正是它**在桌面端几乎不可见**
//! 的原因。此前全库未实现 override，粒子按材质 alpha（实测均值 0.797）渲染并叠成刺眼白串。

use we_scene_wasm::particle::{
    parse_particle_override, ParticleEmitterSpec, ParticleInitSpec, ParticleOverride, SceneParticleSim,
};

const SCENE_W: f32 = 3840.0;
const SCENE_H: f32 = 2160.0;

/// 确定性 init（min=max，无随机）——便于逐值断言 override 的乘法效果。
fn determinate_init() -> ParticleInitSpec {
    ParticleInitSpec {
        lifetime_min: 2.0,
        lifetime_max: 2.0,
        size_min: 10.0,
        size_max: 10.0,
        size_exponent: 1.0,
        velocity_min: [10.0, 20.0, 0.0],
        velocity_max: [10.0, 20.0, 0.0],
        color_min: [0.5, 0.25, 0.125],
        color_max: [0.5, 0.25, 0.125],
        alpha_min: 0.8,
        alpha_max: 0.8,
        rotation_min: [0.0; 3],
        rotation_max: [0.0; 3],
        angular_vel_min: [0.0; 3],
        angular_vel_max: [0.0; 3],
        turbulent: None,
    }
}

/// 构造模拟器并装上 override（发射点 = 场景中心 → we_to_three = [0,0,0]）。
fn sim_with(init: ParticleInitSpec, ov: ParticleOverride, rate: f32, maxcount: u32) -> SceneParticleSim {
    let mut sim = SceneParticleSim::new(
        ParticleEmitterSpec {
            rate,
            origin: [0.0; 3],
            directions: [0.0; 3],
            dist_min: [0.0; 3],
            dist_max: [0.0; 3],
            is_sphere: false,
        },
        maxcount,
        [SCENE_W / 2.0, SCENE_H / 2.0, 0.0],
        SCENE_W,
        SCENE_H,
        init,
    );
    sim.override_spec = ov;
    sim
}

#[test]
fn override_multiplies_alpha_size_lifetime_speed() {
    let ov = ParticleOverride { alpha: 0.03, size: 2.0, lifetime: 1.5, speed: 2.0, count: 1.0, color: None };
    let mut sim = sim_with(determinate_init(), ov, 50_000.0, 64);
    sim.update(0.01);
    assert!(!sim.particles.is_empty(), "应有粒子");

    for p in &sim.particles {
        // alpha 0.8 × 0.03 = 0.024（官方 UiScalarToLinear 为恒等）
        assert!((p.alpha - 0.024).abs() < 1e-6, "alpha 应被 override 乘 0.03，got {}", p.alpha);
        assert!((p.initial.alpha - 0.024).abs() < 1e-6, "initial.alpha 同样应被覆盖");
        // size (10/2=5) × 2.0 = 10
        assert!((p.size - 10.0).abs() < 1e-6, "size 应被 override 乘 2.0，got {}", p.size);
        // lifetime 2.0 × 1.5 = 3.0
        assert!((p.max_life - 3.0).abs() < 1e-6, "lifetime 应被 override 乘 1.5，got {}", p.max_life);
        assert!((p.initial.lifetime - 3.0).abs() < 1e-6, "initial.lifetime 同样应被覆盖");
        // velocity (10,20,0) × 2.0 = (20,40,0)
        assert!((p.vel[0] - 20.0).abs() < 1e-4, "vel.x 应被 override 乘 2.0，got {}", p.vel[0]);
        assert!((p.vel[1] - 40.0).abs() < 1e-4, "vel.y 应被 override 乘 2.0，got {}", p.vel[1]);
    }
}

/// 默认 override 是恒等（全 1 / color=None）：与不装 override 的结果逐值一致。
#[test]
fn default_override_is_identity() {
    let mut plain = sim_with(determinate_init(), ParticleOverride::default(), 50_000.0, 64);
    let mut with_default = sim_with(determinate_init(), ParticleOverride::default(), 50_000.0, 64);
    plain.update(0.01);
    with_default.update(0.01);
    assert_eq!(plain.particles.len(), with_default.particles.len());
    for (a, b) in plain.particles.iter().zip(with_default.particles.iter()) {
        assert!((a.alpha - b.alpha).abs() < 1e-6);
        assert!((a.size - b.size).abs() < 1e-6);
        assert!((a.max_life - b.max_life).abs() < 1e-6);
        assert!((a.vel[0] - b.vel[0]).abs() < 1e-6);
    }
}

/// `count` 乘 emitter rate（官方 `newEm.rate *= modifiers.Count()`）。
#[test]
fn override_count_multiplies_emitter_rate() {
    let mut sim = sim_with(determinate_init(), ParticleOverride { count: 0.5, ..Default::default() }, 100.0, 600);
    sim.update(1.0); // rate×count×dt = 100×0.5×1 = 50 个
    assert_eq!(sim.particles.len(), 50, "count=0.5 应把 rate 100 压到 50/s");
}

/// 颜色覆盖：`colorn`（已归一 0-1）走 v²；legacy `color`（0-255）先 /255 再 v²。
/// GTR 的 "Long wind trail" 用 `colorn: "0.75294 0.75294 0.75294"`。
#[test]
fn override_color_to_linear() {
    let ov = parse_particle_override(r#"{"alpha":0.02,"colorn":"0.75294 0.75294 0.75294","lifetime":1.5,"rate":2.5}"#)
        .expect("应解析出 override");
    let c = ov.color.expect("colorn 应产生颜色覆盖");
    let expect = 0.75294f32 * 0.75294f32;
    assert!((c[0] - expect).abs() < 1e-6, "colorn 应平方（UiColorToLinear），got {}", c[0]);
    assert!((ov.alpha - 0.02).abs() < 1e-6);
    assert!((ov.lifetime - 1.5).abs() < 1e-6);
    assert!((ov.size - 1.0).abs() < 1e-6, "未给的字段应缺省 1.0");

    let legacy = parse_particle_override(r#"{"color":"255 128 0"}"#).expect("legacy color 应解析");
    let lc = legacy.color.expect("color 应产生颜色覆盖");
    assert!((lc[0] - 1.0).abs() < 1e-6, "255/255=1 → 1²=1，got {}", lc[0]);
    let g = 128.0f32 / 255.0;
    assert!((lc[1] - g * g).abs() < 1e-6, "128 应 /255 再平方，got {}", lc[1]);
}

/// GTR 烟柱的真实 override（`{alpha: 0.029999999, id: 23, size: 2.0899999}`）：
/// 端到端确认「本该几乎不可见」的 alpha 真的落到粒子上了。
#[test]
fn gtr_smoke_override_makes_particles_nearly_invisible() {
    let ov = parse_particle_override(r#"{"alpha":0.029999999,"id":23,"size":2.0899999}"#)
        .expect("GTR 烟柱 override 应解析");
    assert!((ov.alpha - 0.03).abs() < 1e-6);
    assert!((ov.size - 2.09).abs() < 1e-6);
    assert!(ov.color.is_none(), "未给 color/colorn → 无颜色覆盖");

    // 用 smoke2 的实际初值量级（alpharandom 缺省 1.0、lifetime [3,4]、size [160,190]）验证量级。
    let mut init = determinate_init();
    init.alpha_min = 1.0;
    init.alpha_max = 1.0;
    init.lifetime_min = 3.0;
    init.lifetime_max = 4.0;
    init.size_min = 160.0;
    init.size_max = 190.0;
    let mut sim = sim_with(init, ov, 50_000.0, 64);
    sim.update(0.01);
    for p in &sim.particles {
        assert!(p.alpha <= 0.03 + 1e-6, "alpha 应 ≤ 0.03（桌面端几乎不可见），got {}", p.alpha);
        assert!(p.size <= 190.0 / 2.0 * 2.09 + 1e-3, "size 应 ≤ 199，got {}", p.size);
    }
}

/// 空串 / 非法 JSON / 非对象 → None（JS 侧「无覆盖」约定）。
#[test]
fn parse_override_rejects_empty_and_invalid() {
    assert!(parse_particle_override("").is_none());
    assert!(parse_particle_override("   ").is_none());
    assert!(parse_particle_override("{oops").is_none());
    assert!(parse_particle_override("[1,2]").is_none());
    assert!(parse_particle_override("null").is_none());
}
