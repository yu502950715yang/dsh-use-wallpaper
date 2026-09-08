//! `ParticleSpec`（Task 1 解析结果）→ `SceneParticleSim`（Task 2 CPU 模拟器）的纯映射（Task 4）。
//!
//! 本模块只做「规格 → 模拟器」的组装，不依赖 wgpu，native `cargo test`（无 render feature）
//! 直接测试。职责：把 `parse_particle_spec` 解析出的 emitter（rate/directions/distance_min/max）
//! + `spec.maxcount` 组装成 `ParticleEmitterSpec`，连同对象中心（obj_origin）与 cover 相机范围
//! （view_w/view_h）调用 `SceneParticleSim::new`。
//!
//! 坐标/缩放约定（全局约束，见 sim.rs）：
//! - view_h 用 cover 相机半高（如 1906），**非** scene 正交高度（2160）；
//! - 粒子**不乘对象 scale**（`SceneParticleSim` 内部按对象中心 + emitter 局部偏移发射）。
//!
//! 注：`EmitterSpec`（particle/mod.rs）实际只有 rate/directions/distance_min/distance_max，
//! 无独立 `origin`/`is_sphere` 字段（任务描述与此不符，已作为关注点上报）。故 `ParticleEmitterSpec.origin`
//! 固定为局部偏移 [0,0,0]（发射点即对象中心，与 GPU compute 路径 origin_to_center 语义一致）；
//! `is_sphere` 固定 true（sim.rs spawn 统一按 3D 球壳/球体处理）。

use super::{ParticleEmitterSpec, ParticleSpec, SceneParticleSim};

/// 把 `spec` 映射为 CPU 粒子模拟器。
/// `obj_origin` 为对象中心（WE 坐标，精灵按中心原点 Y 翻），`view_w`/`view_h` 为 cover 相机范围。
pub fn emitter_spec_to_particle(
    spec: &ParticleSpec,
    obj_origin: [f32; 3],
    view_w: f32,
    view_h: f32,
) -> SceneParticleSim {
    SceneParticleSim::new(
        ParticleEmitterSpec {
            rate: spec.emitter.rate,
            // WE emitter 无独立 origin 字段（任务描述与实际不符）→ 局部偏移缺省 0，对象中心即发射点。
            origin: [0.0; 3],
            directions: spec.emitter.directions,
            dist_min: spec.emitter.distance_min,
            dist_max: spec.emitter.distance_max,
            // sim.rs spawn 统一按 3D 球壳/球体（见 sim.rs spawn 注释），is_sphere 固定 true。
            is_sphere: true,
        },
        spec.maxcount,
        obj_origin,
        view_w,
        view_h,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::particle::parse_particle_spec;

    #[test]
    fn maps_rate_maxcount_and_directions() {
        // 黑神话花瓣规格的 emitter 核心字段（rate/directions/distancemin/distancemax + maxcount）。
        let json = r#"{
            "emitter": [{"rate": 20, "directions": "1 0.1 1", "distancemin": 0, "distancemax": 750}],
            "maxcount": 50
        }"#;
        let spec = parse_particle_spec(json);
        let sim = emitter_spec_to_particle(&spec, [2306.34, 419.77, 0.0], 3840.0, 1906.0);

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
        // view（cover）被带入
        assert_eq!(sim.view_w, 3840.0);
        assert_eq!(sim.view_h, 1906.0, "view_h 应为 cover 尺寸（非 scene 2160）");
    }

    #[test]
    fn default_maxcount_zero_when_absent() {
        // 无 maxcount（旧格式）→ spec.maxcount = 0；emitter_spec_to_particle 原样带入（不 clamp）。
        let json = r#"{"emitter":[{"rate":10,"directions":"0 1 0","distancemin":0,"distancemax":256}]}"#;
        let spec = parse_particle_spec(json);
        let sim = emitter_spec_to_particle(&spec, [0.0, 0.0, 0.0], 3840.0, 1906.0);
        assert_eq!(spec.maxcount, 0);
        assert_eq!(sim.maxcount, 0, "maxcount 缺省 0 应原样带入");
    }

    #[test]
    fn emitter_origin_defaults_to_zero_local_offset() {
        // ParticleEmitterSpec.origin 为局部偏移（缺省 0）：spawn 时发射点 = 对象中心 + emitter.origin。
        let json = r#"{"emitter":[{"rate":10,"directions":"0 1 0","distancemin":0,"distancemax":256}]}"#;
        let spec = parse_particle_spec(json);
        let sim = emitter_spec_to_particle(&spec, [100.0, 200.0, 0.0], 3840.0, 1906.0);
        assert_eq!(sim.emitter.origin, [0.0; 3], "emitter 无 origin 字段 → 局部偏移缺省 0");
        assert!(sim.emitter.is_sphere, "is_sphere 缺省 true（spawn 统一球壳/球体）");
    }
}
