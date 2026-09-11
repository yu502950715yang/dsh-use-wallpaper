//! `ParticleSpec`（Task 1 解析结果）→ `SceneParticleSim`（Task 2 CPU 模拟器）的纯映射（Task 4）。
//!
//! 本模块只做「规格 → 模拟器」的组装，不依赖 wgpu，native `cargo test`（无 render feature）
//! 直接测试。职责：把 `parse_particle_spec` 解析出的 emitter
//! （rate/directions/distance_min/max + origin/is_sphere）+ `spec.maxcount` 组装成
//! `ParticleEmitterSpec`，连同对象中心（obj_origin）与 cover 相机范围（view_w/view_h）调用
//! `SceneParticleSim::new`，并把 `spec.operators`（Task 4.5）映射为 `sim.operators`。
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

use super::{sim::ParticleOperator, OperatorKind, ParticleEmitterSpec, ParticleInitSpec, ParticleSpec, SceneParticleSim};
use serde_json::Value;

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
    let mut sim = SceneParticleSim::new(
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
    );
    // Task 4.5：把 `spec.operators` 映射为 CPU 算子列表并接线到 `sim.operators`，使黑神话
    // （movement/alphafade/angularmovement）与 EVA（movement gravity + alphafade）等算子**真正运行**
    // （`update()` 逐帧按 `self.operators` 对每个粒子 apply）。缺省（spec 无 operators）由
    // `spec_operators_to_sim` 兜底为一个无重力/无阻力的 movement，保持既有匀速直线/静止行为。
    sim.operators = spec_operators_to_sim(spec);
    sim
}

/// 把 `spec.operators`（Task 1 解析的 `Vec<Operator>`，`Operator.kind` 由 spec 的 `name` 判）映射为
/// CPU 模拟器算子列表 `Vec<ParticleOperator>`（对齐 lwe `CParticle::m_operators` 的 `OperatorFunc`
/// 语义——`update()` 逐帧按序对每个粒子跑）。
///
/// 逐一按 `OperatorKind` 映射：
/// - `Movement` → `Movement { gravity: spec.gravity (vec3，缺省 0), drag: spec.drag (标量，缺省 0) }`。
///   黑神话 movement **无 gravity/drag** → gravity=0、drag=0；EVA `"gravity":"1 0 0"` → gravity=[1,0,0]。
/// - `AlphaFade` → `AlphaFade { fade_in, fade_out }`（spec `fadeintime`/`fadeouttime`，缺省 0.5/0.5 照 lwe）。
///   黑神话 fadeintime 0.1/fadeouttime 0.9；EVA 0.5/0.5。
/// - `AngularMovement` → `AngularMovement { force, drag }`（`force`/`drag` 缺省 0）。黑神话无 force/drag → 全 0；
///   其 `angular_vel` 由 `angularvelocityrandom` initializer（spec.init）在 spawn 时提供（Task 3）。
/// - `Turbulence` → `ParticleOperator::turbulence(scale, timescale, mask, speedmin, speedmax, phasemin, phasemax)`
///   （缺省照 lwe `Turbulence`：scale=0.01、timescale=20、speedmin=500、speedmax=1000、mask=[1,1,0]）。
/// - `OscillatePosition` → `OscillatePosition { freq_min, freq_max, scale_min, scale_max, phase_min, phase_max, mask }`
///   （缺省照 lwe `FrequencyValue`：frequencymax=5、scalemax=1、phasemax=2π、mask=[1,1,0]）。
/// - `Other`（oscillatealpha/oscillatesize 等——Task 2 spec 解析未给具体 kind）→ 跳过。
///
/// 缺省：`spec.operators` 为空或全部不可识别时返回一个**无重力/无阻力**的 `Movement`（保持既有
/// 「匀速直线/静止」积分，`new()` 的缺省与既有测试行为一致），即本映射结果恒非空。
pub fn spec_operators_to_sim(spec: &ParticleSpec) -> Vec<ParticleOperator> {
    let mut ops: Vec<ParticleOperator> = Vec::new();
    for op in &spec.operators {
        let p = &op.params; // 该算子的完整 JSON 对象（含平铺字段 gravity/fadeintime/...）
        let f = |key: &str, default: f32| super::scalar(p.get(key).unwrap_or(&Value::Null), default);
        let g = |key: &str| super::vec3(p.get(key).unwrap_or(&Value::Null));
        match op.kind {
            OperatorKind::Movement => ops.push(ParticleOperator::Movement {
                gravity: g("gravity"),
                drag: f("drag", 0.0),
            }),
            OperatorKind::AlphaFade => ops.push(ParticleOperator::AlphaFade {
                fade_in: f("fadeintime", 0.5),
                fade_out: f("fadeouttime", 0.5),
            }),
            OperatorKind::AngularMovement => ops.push(ParticleOperator::AngularMovement {
                force: g("force"),
                drag: f("drag", 0.0),
            }),
            OperatorKind::Turbulence => {
                let mask = if p.get("mask").is_some() { g("mask") } else { [1.0, 1.0, 0.0] };
                ops.push(ParticleOperator::turbulence(
                    f("scale", 0.01),
                    f("timescale", 20.0),
                    mask,
                    f("speedmin", 500.0),
                    f("speedmax", 1000.0),
                    f("phasemin", 0.0),
                    f("phasemax", 0.0),
                ));
            }
            OperatorKind::OscillatePosition => {
                let mask = if p.get("mask").is_some() { g("mask") } else { [1.0, 1.0, 0.0] };
                ops.push(ParticleOperator::OscillatePosition {
                    freq_min: f("frequencymin", 0.0),
                    freq_max: f("frequencymax", 5.0),
                    scale_min: f("scalemin", 0.0),
                    scale_max: f("scalemax", 1.0),
                    phase_min: f("phasemin", 0.0),
                    phase_max: f("phasemax", std::f32::consts::TAU),
                    mask,
                });
            }
            OperatorKind::Other => {} // 不可识别算子（oscillatealpha/oscillatesize 等）跳过
        }
    }
    if ops.is_empty() {
        ops.push(ParticleOperator::Movement {
            gravity: [0.0; 3],
            drag: 0.0,
        });
    }
    ops
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

    /// lwe `ObjectParser::parseParticleEmitter`（ObjectParser.cpp:594）：
    /// `directions = parseVec3("directions", glm::vec3(1,1,0))` —— **缺省 (1,1,0)**，不是 0 向量。
    ///
    /// 回归背景（Crimson Horizon 3765967112「绿色光点集中」）：Crimson 的
    /// `particles/workshop/3355704177/new_particle_system.json`（Fireflies，绿色 0-255-0 + 0-128-0）
    /// 的 emitter **没有 `directions` 字段**，此前 `vec3()` 缺省 [0,0,0] → `local = unit·r·dir = 0`
    /// → 20 个粒子全部叠在发射点上（只有 ±20/s 的速度把它们推开几十像素）＝用户所见的
    /// 「绿色光点挤在画面下方一小片」。WE 里 directions 缺省 (1,1,0) → 球壳半径 32..512 全展开。
    #[test]
    fn directions_default_1_1_0_when_absent() {
        // Fireflies 原始 emitter（无 directions 字段；sphererandom，32..512，rate 20，maxcount 20）。
        let json = r#"{
            "emitter": [{"distancemax": 512, "distancemin": 32, "id": 6, "name": "sphererandom", "rate": 20}],
            "maxcount": 20
        }"#;
        let spec = parse_particle_spec(json);
        let sim = emitter_spec_to_particle(&spec, [784.10718, 431.18640, 0.0], 3840.0, 2160.0);
        assert_eq!(
            sim.emitter.directions,
            [1.0, 1.0, 0.0],
            "emitter 无 directions → 缺省 (1,1,0)（lwe ObjectParser）"
        );
        assert_eq!(sim.emitter.dist_min, 32.0);
        assert_eq!(sim.emitter.dist_max, 512.0);
        assert!(sim.emitter.is_sphere, "name=sphererandom → is_sphere");
    }

    /// directions 显式给出时**不被缺省覆盖**（含全零 "0 0 0" 这一显式语义）。
    #[test]
    fn explicit_directions_win_over_default() {
        let json = r#"{"emitter":[{"name":"sphererandom","rate":10,"directions":"0.5 0.25 0","distancemin":0,"distancemax":100}]}"#;
        let spec = parse_particle_spec(json);
        assert_eq!(spec.emitter.directions, [0.5, 0.25, 0.0]);
        let json0 = r#"{"emitter":[{"name":"sphererandom","rate":10,"directions":"0 0 0","distancemin":0,"distancemax":100}]}"#;
        let spec0 = parse_particle_spec(json0);
        assert_eq!(spec0.emitter.directions, [0.0; 3], "显式 \"0 0 0\" 应保持 0（不被缺省覆盖）");
    }

    /// 端到端：真实 Fireflies 规格 → 发射出的粒子在 XY 上**明显展开**（不是挤在一点）。
    /// 用 `emitter.origin=[0,0,0]` 的对象中心（scene 中心 → we_to_three = 0）隔离散射本身；
    /// 中性 init（速度 0、寿命长）使位置只由 emitter 散射决定。
    #[test]
    fn fireflies_particles_spread_over_emitter_disc() {
        let json = include_str!("../../tests/fixtures/crimson/fireflies.json");
        let spec = parse_particle_spec(json);
        let init = ParticleInitSpec {
            lifetime_min: 100.0,
            lifetime_max: 100.0,
            size_min: 16.0,
            size_max: 16.0,
            size_exponent: 1.0,
            velocity_min: [0.0; 3],
            velocity_max: [0.0; 3],
            color_min: [0.0, 0.5, 0.0],
            color_max: [0.0, 1.0, 0.0],
            alpha_min: 1.0,
            alpha_max: 1.0,
            rotation_min: [0.0; 3],
            rotation_max: [0.0; 3],
            angular_vel_min: [0.0; 3],
            angular_vel_max: [0.0; 3],
            turbulent: None,
        };
        let mut sim = SceneParticleSim::new(
            ParticleEmitterSpec {
                rate: spec.emitter.rate,
                origin: spec.emitter.origin,
                directions: spec.emitter.directions,
                dist_min: spec.emitter.distance_min,
                dist_max: spec.emitter.distance_max,
                is_sphere: spec.emitter.is_sphere,
            },
            spec.maxcount,
            [1920.0, 1080.0, 0.0], // we_to_three → [0,0,0]
            3840.0,
            2160.0,
            init,
        );
        sim.prewarm();
        for _ in 0..120 {
            sim.update(1.0 / 60.0);
        }
        assert_eq!(sim.particles.len(), 20, "maxcount=20 应铺满 20 个粒子");

        let (mut min_x, mut max_x, mut min_y, mut max_y) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
        for p in &sim.particles {
            min_x = min_x.min(p.pos[0]);
            max_x = max_x.max(p.pos[0]);
            min_y = min_y.min(p.pos[1]);
            max_y = max_y.max(p.pos[1]);
        }
        // 球壳半径 ∈ [32,512]（×directions=[1,1,0]）→ 20 个粒子的 XY 跨度应达数百像素；
        // 修复前 local≡0（全部同点）→ 跨度 ≈ 0。
        let span_x = max_x - min_x;
        let span_y = max_y - min_y;
        assert!(
            span_x > 400.0 && span_y > 400.0,
            "Fireflies 粒子应在 XY 上展开（get span_x={span_x}, span_y={span_y}）"
        );
        // 每个粒子的 XY 半径都在 [32,512] 内（球壳），且**不全为 0**。
        let nonzero = sim.particles.iter().filter(|p| (p.pos[0].hypot(p.pos[1])) > 1.0).count();
        assert!(nonzero >= 18, "绝大多数粒子的 XY 半径应非 0（实际 {nonzero}/20）");
    }

    /// Crimson 的 `Stars.json`（boxrandom，`distancemax:"1000 500 0"`，**无 directions**）
    /// 同属缺省分支：缺省 (1,1,0) 让星点铺开（此前 directions=[0,0,0] → 500 颗星全叠在对象中心）。
    ///
    /// 注：`dist_min/dist_max` 是**标量**（取 "1000 500 0" 的首 token = 1000），而 lwe
    /// `createBoxEmitter` 用 **vec3 逐轴**（x∈[0,1000]、y∈[0,500]）——已知偏差（见 `sim.rs`
    /// `emitter_local` 注释），本轮不改（会改变 DK Ice 的观感），故此处只断言「不再全为 0」。
    #[test]
    fn stars_box_emitter_scatters_with_default_directions() {
        let json = include_str!("../../tests/fixtures/crimson/stars.json");
        let spec = parse_particle_spec(json);
        assert_eq!(spec.emitter.directions, [1.0, 1.0, 0.0], "无 directions → 缺省 (1,1,0)");
        assert!(!spec.emitter.is_sphere, "name=boxrandom → 盒体分支");
        assert_eq!(spec.maxcount, 500);

        let sim = emitter_spec_to_particle(&spec, [1852.83, 2227.32, 0.0], 3840.0, 2160.0);
        let mut non_zero = 0;
        let mut max_abs = 0f32;
        for _ in 0..200 {
            let l = sim.emitter_local();
            if l[0].abs() > 1.0 || l[1].abs() > 1.0 {
                non_zero += 1;
            }
            max_abs = max_abs.max(l[0].abs()).max(l[1].abs());
        }
        assert_eq!(non_zero, 200, "box 散射不应为 0（directions 缺省为 (1,1,0)）");
        assert!(max_abs > 500.0, "散射幅度应达数百像素（实际 {max_abs}）");
        // z：directions.z = 0 → 盒体 z 散射恒 0（WE 正交粒子的 z 不参与成像）。
        assert_eq!(sim.emitter_local()[2], 0.0, "directions.z=0 → z 散射为 0");
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
