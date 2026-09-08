//! `ParticleSpec`（Task 1 解析结果）→ `SceneParticleSim`（Task 2 CPU 模拟器）的纯映射（Task 4）。
//!
//! 本模块只做「规格 → 模拟器」的组装，不依赖 wgpu，native `cargo test`（无 render feature）
//! 直接测试。职责：把 `parse_particle_spec` 解析出的 emitter
//! （rate/directions/distance_min/max + origin/is_sphere）+ `spec.maxcount` 组装成
//! `ParticleEmitterSpec`，连同对象中心（obj_origin）与 cover 相机范围（view_w/view_h）调用
//! `SceneParticleSim::new`。
//!
//! 坐标/缩放约定（全局约束，见 sim.rs）：
//! - 对象中心映射用 **scene 尺寸** scene_w/scene_h（黑神话 3840×2160；`we_to_three`，y 不翻）；
//! - 粒子**不乘对象 scale**（`SceneParticleSim` 内部按对象中心 + emitter 局部偏移发射）。
//!   view（cover 相机半宽/半高）由 `ParticleRenderPass` 单独用于 billboard 投影，不传到这里。
//!
//! `ParticleEmitterSpec.origin` = emitter **原始**局部偏移（黑神话花瓣 origin="350 750 0"，y 仅存
//! 局部语义，**不翻**；origin.y=0 的 EVA/DK 等不受影响）。spawn 时该局部偏移被
//! `sim.rs` 按对象 scale（`BLACKMYTH_EMITTER_SCALE`，读自 scene.pkg）做**确定性重定标**，使发射点
//! 对齐 Windows（黑神话 → 屏幕顶部偏左）；本模块原样透传 origin，不做重定标（保持字段与 spec 一致）。
//! `is_sphere` = emitter name=="sphererandom" 的结果。两者均
//! 由 `parse_particle_spec` 从 emitter JSON 读取，缺省 origin=[0,0,0]、is_sphere=false。

use super::{ParticleEmitterSpec, ParticleInitSpec, ParticleSpec, SceneParticleSim};

/// 把 `spec` 映射为 CPU 粒子模拟器。
/// `obj_origin` 为对象中心（WE 坐标），`scene_w`/`scene_h` 为 scene 正交尺寸（黑神话 3840×2160；
/// spawn 的对象中心用 `we_to_three(origin, scene_w, scene_h)`，y 不翻，与背景/图层一致）。
pub fn emitter_spec_to_particle(
    spec: &ParticleSpec,
    obj_origin: [f32; 3],
    scene_w: f32,
    scene_h: f32,
) -> SceneParticleSim {
    // Important I1：把 `spec.init`（velocityrandom/sizerandom/lifetimerandom/colorrandom/
    // alpharandom/rotationrandom/angularvelocityrandom）映射为 CPU `ParticleInitSpec`，
    // 让每个粒子对象用自己的初始参数，而非黑神话硬编码常量。
    let init = ParticleInitSpec {
        lifetime_min: spec.init.lifetime_min,
        lifetime_max: spec.init.lifetime_max,
        size_min: spec.init.size_min,
        size_max: spec.init.size_max,
        // sizerandom 的 exponent：`InitSpec`（mod.rs）未解析 sizerandom 的 exponent 字段，
        // 映射时统一定为 2.0（对齐黑神话 sizerandom exp2 → size∈[30,50]，行为保持）。
        size_exponent: 2.0,
        velocity_min: spec.init.velocity_min,
        velocity_max: spec.init.velocity_max,
        // WE colorrandom 已归一 0..1；缺省白 [1,1,1]。
        color_min: spec.init.color_min.unwrap_or([1.0, 1.0, 1.0]),
        color_max: spec.init.color_max.unwrap_or([1.0, 1.0, 1.0]),
        alpha_min: spec.init.alpha_min,
        alpha_max: spec.init.alpha_max,
        // rotation/angular_vel 缺省为 0（无该 initializer 时）。
        rotation_min: spec.init.rotation_min.unwrap_or([0.0; 3]),
        rotation_max: spec.init.rotation_max.unwrap_or([0.0; 3]),
        angular_vel_min: spec.init.angular_vel_min.unwrap_or([0.0; 3]),
        angular_vel_max: spec.init.angular_vel_max.unwrap_or([0.0; 3]),
        // turbulentvelocityrandom（normal/forward 基 + speed 幅度）：无该 initializer → None（不叠加）。
        turbulent: spec.init.turbulent.clone(),
    };
    SceneParticleSim::new(
        ParticleEmitterSpec {
            rate: spec.emitter.rate,
            // emitter 局部偏移（已由 parse_particle_spec 读取 em["origin"]，缺省 [0,0,0]）。
            origin: spec.emitter.origin,
            directions: spec.emitter.directions,
            dist_min: spec.emitter.distance_min,
            dist_max: spec.emitter.distance_max,
            // 球壳散射标记（已由 parse_particle_spec 读取 em["name"]=="sphererandom"）。
            is_sphere: spec.emitter.is_sphere,
        },
        spec.maxcount,
        obj_origin,
        scene_w,
        scene_h,
        init,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::particle::parse_particle_spec;

    #[test]
    fn maps_rate_maxcount_and_directions() {
        // 黑神话花瓣规格的 emitter 核心字段（name/origin/rate/directions/distancemin/distancemax + maxcount）。
        let json = r#"{
            "emitter": [{"name": "sphererandom", "rate": 20, "directions": "1 0.1 1", "distancemin": 0, "distancemax": 750, "origin": "350 750 0"}],
            "maxcount": 50
        }"#;
        let spec = parse_particle_spec(json);
        let sim = emitter_spec_to_particle(&spec, [2306.34, 419.77, 0.0], 3840.0, 2160.0);

        // maxcount 被带入
        assert_eq!(sim.maxcount, 50, "maxcount 应映射到 sim.maxcount");
        // rate 被带入
        assert_eq!(sim.emitter.rate, 20.0, "emitter.rate 应映射到 emitter.rate");
        // directions 被带入
        assert_eq!(sim.emitter.directions, [1.0, 0.1, 1.0], "directions 应映射");
        // distance min/max 被带入
        assert_eq!(sim.emitter.dist_min, 0.0);
        assert_eq!(sim.emitter.dist_max, 750.0);
        // 对象中心（obj_origin）被带入
        assert_eq!(sim.obj_origin, [2306.34, 419.77, 0.0], "obj_origin 应映射到 sim.obj_origin");
        // scene（黑神话 3840×2160）被带入（we_to_three 对象中心映射用）。
        assert_eq!(sim.scene_w, 3840.0);
        assert_eq!(sim.scene_h, 2160.0, "scene_h 应为 scene 正交高（非 cover 1906）");
        // emitter.origin / is_sphere 被带入（黑神话：origin 抬到上方、球壳散射）
        assert_eq!(sim.emitter.origin, [350.0, 750.0, 0.0], "emitter.origin 应被带入（上方发射）");
        assert!(sim.emitter.is_sphere, "name=sphererandom → is_sphere 应为 true");
    }

    #[test]
    fn default_maxcount_zero_when_absent() {
        // 无 maxcount（旧格式）→ spec.maxcount = 0；emitter_spec_to_particle 原样带入（不 clamp）。
        let json = r#"{"emitter":[{"rate":10,"directions":"0 1 0","distancemin":0,"distancemax":256}]}"#;
        let spec = parse_particle_spec(json);
        let sim = emitter_spec_to_particle(&spec, [0.0, 0.0, 0.0], 3840.0, 2160.0);
        assert_eq!(spec.maxcount, 0);
        assert_eq!(sim.maxcount, 0, "maxcount 缺省 0 应原样带入");
    }

    #[test]
    fn emitter_origin_and_sphere_default_when_absent() {
        // 无 origin / 无 name=sphererandom → emitter.origin 缺省 [0,0,0]、is_sphere 缺省 false。
        let json = r#"{"emitter":[{"rate":10,"directions":"0 1 0","distancemin":0,"distancemax":256}]}"#;
        let spec = parse_particle_spec(json);
        let sim = emitter_spec_to_particle(&spec, [100.0, 200.0, 0.0], 3840.0, 2160.0);
        assert_eq!(sim.emitter.origin, [0.0; 3], "emitter 无 origin 字段 → 局部偏移缺省 0");
        assert!(!sim.emitter.is_sphere, "emitter 无 name=sphererandom → is_sphere 缺省 false");
    }

    #[test]
    fn maps_init_to_particle_init_spec() {
        // Important I1：spec.init（velocityrandom/sizerandom/lifetimerandom/colorrandom/
        // alpharandom/rotationrandom）→ CPU `ParticleInitSpec`，用于每壁纸粒子初始化。
        let json = r#"{
            "emitter": [{"rate": 20, "origin": "350 750 0"}],
            "initializer": [
                {"name": "velocityrandom", "min": "-50 -50 0", "max": "0 -15 0"},
                {"name": "sizerandom", "min": 30, "max": 50},
                {"name": "lifetimerandom", "min": 5, "max": 10},
                {"name": "colorrandom", "min": "255 212 247", "max": "255 212 247"},
                {"name": "alpharandom", "min": 0.3, "max": 1.0},
                {"name": "rotationrandom", "min": "-0.5 -0.5 -0.5", "max": "0.5 0.5 0.5"}
            ],
            "maxcount": 50
        }"#;
        let spec = parse_particle_spec(json);
        let sim = emitter_spec_to_particle(&spec, [0.0; 3], 3840.0, 2160.0);
        let i = &sim.init;

        assert_eq!(i.velocity_min, [-50.0, -50.0, 0.0], "velocity_min 应从 spec.init 带入");
        assert_eq!(i.velocity_max, [0.0, -15.0, 0.0], "velocity_max 应从 spec.init 带入");
        assert_eq!(i.size_min, 30.0, "size_min 应从 spec.init 带入");
        assert_eq!(i.size_max, 50.0, "size_max 应从 spec.init 带入");
        assert_eq!(i.size_exponent, 2.0, "InitSpec 无 exponent → 映射缺省 2.0（对齐黑神话 exp2）");
        assert_eq!(i.lifetime_min, 5.0, "lifetime_min 应从 spec.init 带入");
        assert_eq!(i.lifetime_max, 10.0, "lifetime_max 应从 spec.init 带入");
        // colorrandom "255 212 247" → /255 = [1.0, 0.831, 0.969]（粉花瓣近似）。
        assert!((i.color_min[0] - 1.0).abs() < 1e-5, "color[0] 应 255/255 → 1.0");
        assert!((i.color_min[1] - 212.0 / 255.0).abs() < 1e-5, "color[1] 应 212/255");
        assert!((i.color_min[2] - 247.0 / 255.0).abs() < 1e-5, "color[2] 应 247/255");
        assert_eq!(i.color_max, i.color_min, "color_min/max 相同 → lerp 恒为该色");
        assert_eq!(i.alpha_min, 0.3, "alpha_min 应从 spec.init 带入");
        assert_eq!(i.alpha_max, 1.0, "alpha_max 应从 spec.init 带入");
        assert_eq!(i.rotation_min, [-0.5, -0.5, -0.5], "rotation_min 应从 spec.init 带入");
        assert_eq!(i.rotation_max, [0.5, 0.5, 0.5], "rotation_max 应从 spec.init 带入");
        assert_eq!(i.angular_vel_min, [0.0; 3], "无 angularvelocityrandom → 缺省 0");
        assert_eq!(i.angular_vel_max, [0.0; 3], "无 angularvelocityrandom → 缺省 0");
    }

    #[test]
    fn init_defaults_white_color_zero_rotation_when_absent() {
        // 无 colorrandom/rotationrandom/alpharandom → color 缺省 [1,1,1]、rotation 缺省 [0,0,0]、alpha 缺省 1.0。
        let json = r#"{"emitter":[{"rate":10}],"initializer":[{"name":"velocityrandom","min":"0 0 0","max":"0 0 0"}]}"#;
        let spec = parse_particle_spec(json);
        let sim = emitter_spec_to_particle(&spec, [0.0; 3], 3840.0, 2160.0);
        assert_eq!(sim.init.color_min, [1.0, 1.0, 1.0], "无 colorrandom → color_min 缺省白");
        assert_eq!(sim.init.color_max, [1.0, 1.0, 1.0], "无 colorrandom → color_max 缺省白");
        assert_eq!(sim.init.rotation_min, [0.0; 3], "无 rotationrandom → rotation_min 缺省 0");
        assert_eq!(sim.init.rotation_max, [0.0; 3], "无 rotationrandom → rotation_max 缺省 0");
        assert_eq!(sim.init.alpha_min, 1.0, "无 alpharandom → alpha_min 缺省 1.0");
        assert_eq!(sim.init.alpha_max, 1.0, "无 alpharandom → alpha_max 缺省 1.0");
    }
}
