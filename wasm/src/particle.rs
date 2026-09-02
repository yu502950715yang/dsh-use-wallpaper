//! 粒子规格解析（emitter[0] + initializer + operator + renderer；缺省值对齐现有 scene-assets.ts）
//! 标量字段：字符串取第一 token（防 NaN）；数字直用。缺省：rate=10、distancemax=256。
//!
//! 2026-08-31 扩容（算子内核补全，治本"3 张 STATIC 壁纸"根因）：
//! 此前只识别 Movement/AlphaFade 两种 operator，其余归 Other 且丢弃参数 → 依赖
//! turbulentvelocityrandom / oscillateposition / angular(velocity/rotation) 的粒子
//! "出生即匀速直线下落"（无噪声扰动/无摆动/无翻滚），两帧间几乎无像素差 → STATIC。
//! 本次为这 3 个算子 + movement 的 gravity/drag + renderer 类型补齐解析与参数，
//! 供 compute shader（运动类）与 render shader（sprite 旋转 / spritetrail 拉伸）消费。
//!
//! 实现注意：initializer/operator/renderer 数组元素是任意 JSON 对象，除 name/min/max 外还有
//! 平铺字段（turbulent 的 scale/speedmin、movement 的 gravity/drag 等）。故这些数组统一以
//! serde_json::Value 处理（丢弃强类型 RawInit/RawOperator 限制字段的丢字段问题了）。

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum OperatorKind {
    Movement,
    AlphaFade,
    /// 随时间对位置施加噪声扰动（湍流）的 operator。参数 speed/speedmax/scale/timescale/mask。
    Turbulence,
    /// 沿 mask 轴做正弦摆动（oscillateposition）。参数 freq/scale/phase/mask。
    OscillatePosition,
    /// 角速度积分（旋转随寿命演化）。参数 drag（AngularMovement 算子）。
    AngularMovement,
    Other,
}

#[derive(Debug, Clone)]
pub struct Operator { pub kind: OperatorKind, pub params: Value }

#[derive(Debug, Clone)]
pub struct EmitterSpec {
    pub rate: f32,
    pub directions: [f32; 3],
    pub distance_min: f32,
    pub distance_max: f32,
}

#[derive(Debug, Clone)]
pub struct InitSpec {
    pub lifetime_min: f32,
    pub lifetime_max: f32,
    pub size_min: f32,
    pub size_max: f32,
    pub velocity_min: [f32; 3],
    pub velocity_max: [f32; 3],
    pub color_min: Option<[f32; 3]>,
    pub color_max: Option<[f32; 3]>,
    /// alpharandom 初始 alpha 范围（缺省 1.0，对齐 JS 版 alphaAt 语义）。
    /// 控制器裁定 P0-1：alpha 为 spawn 时生成的初始值，compute 不衰减，
    /// 显示 alpha 由渲染侧按寿命比例计算。
    pub alpha_min: f32,
    pub alpha_max: f32,
    /// rotationrandom：初始旋转角（弧度的欧拉角，逐分量随机 [min,max]）。缺省 None = 0。
    /// 仅 sprite renderer 有效。官方语义：VectorRandomProgram::Target::Rotation。
    pub rotation_min: Option<[f32; 3]>,
    pub rotation_max: Option<[f32; 3]>,
    /// angularvelocityrandom：初始角速度（弧/秒，逐分量 [min,max]）。缺省 None = 0。
    /// 需 AngularMovement 算子配套。官方语义：VectorRandomProgram::Target::AngularVelocity。
    pub angular_vel_min: Option<[f32; 3]>,
    pub angular_vel_max: Option<[f32; 3]>,
    /// turbulentvelocityrandom：spawn 时叠加的湍流初速。缺省 None = 不叠加。
    pub turbulent: Option<TurbulentInit>,
}

/// turbulentvelocityrandom 的 spawn 初速参数（官方 TurbulentRandom）：
/// speed 在 [speedmin, speedmax] 随机；scale（方向偏转幅度）；normal/forward 正交基。
#[derive(Debug, Clone)]
pub struct TurbulentInit {
    pub scale: f32,
    pub speed_min: f32,
    pub speed_max: f32,
    pub normal: [f32; 3],
    pub forward: [f32; 3],
}

#[derive(Debug, Clone)]
pub struct ParticleSpec {
    pub emitter: EmitterSpec,
    pub init: InitSpec,
    pub operators: Vec<Operator>,
    /// WE 粒子系统的最大粒子数（spec 的 maxcount 字段，权威上限）。
    /// 桌面版 WE 按它作为粒子池容量与生成上限；0 = 未指定（旧格式），
    /// estimate_max_particles 回退 rate×寿命+64 估算。
    pub maxcount: u32,
    /// renderer：sprite（点 billboard）或 spritetrail（沿速度方向拉伸）。缺省 sprite。
    pub renderer: Renderer,
}

/// 粒子渲染器类型（官方 renderer[]）。当前只消费 sprite / spritetrail。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Renderer {
    Sprite,
    SpriteTrail { length: f32, max_length: f32, min_length: f32 },
    Rope,
    RopeTrail,
}

/// turbulentvelocityrandom 缺省参数（官方 TurbulentRandom 默认值）。
/// speedmin=100 speedmax=250 scale=1。normal 缺省 +Z，forward 缺省 +Y（2D 常用）。
fn default_turbulent() -> TurbulentInit {
    TurbulentInit {
        scale: 1.0,
        speed_min: 100.0,
        speed_max: 250.0,
        normal: [0.0, 0.0, 1.0],
        forward: [0.0, 1.0, 0.0],
    }
}

fn scalar(v: &Value, default: f32) -> f32 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(default as f64) as f32,
        Value::String(s) => s.trim().split_whitespace().next()
            .and_then(|t| t.parse::<f32>().ok())
            .unwrap_or(default),
        Value::Null => default,
        _ => default,
    }
}

fn vec3(v: &Value) -> [f32; 3] {
    match v {
        Value::String(s) => {
            let mut it = s.trim().split_whitespace().map(|t| t.parse::<f32>().unwrap_or(0.0));
            [it.next().unwrap_or(0.0), it.next().unwrap_or(0.0), it.next().unwrap_or(0.0)]
        }
        Value::Array(a) => [
            a.first().and_then(|x| x.as_f64()).unwrap_or(0.0) as f32,
            a.get(1).and_then(|x| x.as_f64()).unwrap_or(0.0) as f32,
            a.get(2).and_then(|x| x.as_f64()).unwrap_or(0.0) as f32,
        ],
        _ => [0.0; 3],
    }
}

/// 归一化向量；零向量返回原值（调用方兜底语义）。
fn normalize3(v: [f32; 3]) -> [f32; 3] {
    let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if n > 1e-8 { [v[0] / n, v[1] / n, v[2] / n] } else { v }
}

/// 从对象里取字段的 name（用于判断 init/operator/renderer 类型）。
fn obj_name(o: &Value) -> &str {
    o.get("name").and_then(|v| v.as_str()).unwrap_or("")
}

pub fn parse_particle_spec(json: &str) -> ParticleSpec {
    let raw: Value = serde_json::from_str(json).expect("粒子 json 必须可解析");
    let em = raw.get("emitter")
        .and_then(|e| e.as_array())
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let em = em.as_object().cloned().unwrap_or_default();
    let em = Value::Object(em);

    let inits = raw.get("initializer").and_then(|i| i.as_array()).cloned().unwrap_or_default();
    let find_init = |name: &str| inits.iter().find(|i| obj_name(i) == name);

    let life = find_init("lifetimerandom");
    let size = find_init("sizerandom");
    let vel = find_init("velocityrandom");
    let color = find_init("colorrandom");
    let alpha = find_init("alpharandom");
    let rot = find_init("rotationrandom");
    let ang = find_init("angularvelocityrandom");
    let turb = find_init("turbulentvelocityrandom");

    let operators = raw.get("operator").and_then(|o| o.as_array()).cloned().unwrap_or_default()
        .into_iter().map(|op| {
            let kind = match obj_name(&op) {
                "movement" => OperatorKind::Movement,
                "alphafade" => OperatorKind::AlphaFade,
                "turbulence" => OperatorKind::Turbulence,
                "oscillateposition" => OperatorKind::OscillatePosition,
                "angularmovement" => OperatorKind::AngularMovement,
                _ => OperatorKind::Other,
            };
            Operator { kind, params: op.clone() }
        }).collect();

    // renderer[]：第一个有效项决定类型。sprite 无参数；spritetrail 取
    // length/maxlength/minlength；rope/ropetrail 当前交由 sprite 兜底（不白屏）。
    let renderer = raw.get("renderer").and_then(|r| r.as_array()).and_then(|a| a.first())
        .map(|r| {
            let name = obj_name(r);
            let g = |k: &str, d: f32| r.get(k).map(|v| scalar(v, d)).unwrap_or(d);
            match name {
                "spritetrail" => Renderer::SpriteTrail {
                    length: g("length", 1.0),
                    max_length: g("maxlength", 1.0),
                    min_length: g("minlength", 0.0),
                },
                "rope" => Renderer::Rope,
                "ropetrail" => Renderer::RopeTrail,
                _ => Renderer::Sprite,
            }
        }).unwrap_or(Renderer::Sprite);

    // WE maxcount：粒子系统最大数量（数字）。缺省/非正 → 0（未指定，estimate 回退）。
    let maxcount = scalar(&raw.get("maxcount").cloned().unwrap_or(Value::Null), 0.0).max(0.0) as u32;

    ParticleSpec {
        emitter: EmitterSpec {
            rate: scalar(&em["rate"], 10.0),
            directions: vec3(&em["directions"]),
            distance_min: scalar(&em["distancemin"], 0.0),
            distance_max: scalar(&em["distancemax"], 256.0),
        },
        init: InitSpec {
            lifetime_min: life.map(|i| scalar(&i["min"], 1.0)).unwrap_or(1.0),
            lifetime_max: life.map(|i| scalar(&i["max"], 1.0)).unwrap_or(1.0),
            size_min: size.map(|i| scalar(&i["min"], 16.0)).unwrap_or(16.0),
            size_max: size.map(|i| scalar(&i["max"], 16.0)).unwrap_or(16.0),
            velocity_min: vel.map(|i| vec3(&i["min"])).unwrap_or([0.0; 3]),
            velocity_max: vel.map(|i| vec3(&i["max"])).unwrap_or([0.0; 3]),
            // WE colorrandom 是 0-255 量级（fog1 等 "255 255 255"）→ 归一化 /255 到 0-1
            color_min: color.map(|i| { let c = vec3(&i["min"]); [c[0]/255.0, c[1]/255.0, c[2]/255.0] }),
            color_max: color.map(|i| { let c = vec3(&i["max"]); [c[0]/255.0, c[1]/255.0, c[2]/255.0] }),
            alpha_min: alpha.map(|i| scalar(&i["min"], 1.0)).unwrap_or(1.0),
            alpha_max: alpha.map(|i| scalar(&i["max"], 1.0)).unwrap_or(1.0),
            rotation_min: rot.map(|i| vec3(&i["min"])),
            rotation_max: rot.map(|i| vec3(&i["max"])),
            angular_vel_min: ang.map(|i| vec3(&i["min"])),
            angular_vel_max: ang.map(|i| vec3(&i["max"])),
            turbulent: turb.map(|i| parse_turbulent(&i)),
        },
        operators,
        maxcount,
        renderer,
    }
}

/// 解析 turbulentvelocityrandom 的平铺字段（scale/speedmin/speedmax/normal/forward/offset）。
/// 缺省用官方默认；normal/forward 正交归一。
fn parse_turbulent(i: &Value) -> TurbulentInit {
    let mut tu = default_turbulent();
    let g = |k: &str, d: f32| i.get(k).map(|v| scalar(v, d)).unwrap_or(d);
    tu.scale = g("scale", 1.0);
    tu.speed_min = g("speedmin", 100.0);
    tu.speed_max = g("speedmax", 250.0);
    // normal/forward 是 vec3 字符串（如 "0 0 1"）；缺省 +Z / +Y。
    if i.get("normal").is_some() { tu.normal = vec3(&i["normal"]); }
    if i.get("forward").is_some() { tu.forward = vec3(&i["forward"]); }
    // 官方：normal 为零则 +Z；forward 向 normal 投影去除、零则正交补。
    let normal = normalize3(if tu.normal.iter().all(|&c| c.abs() < 1e-8) { [0.0, 0.0, 1.0] } else { tu.normal });
    let mut forward = tu.forward;
    let dot = forward[0]*normal[0] + forward[1]*normal[1] + forward[2]*normal[2];
    forward = [forward[0]-normal[0]*dot, forward[1]-normal[1]*dot, forward[2]-normal[2]*dot];
    let forward = normalize3(if forward.iter().all(|&c| c.abs() < 1e-8) { orthogonal(normal) } else { forward });
    tu.normal = normal;
    tu.forward = forward;
    tu
}

/// 与 v 正交的单位向量（官方 unitOrthogonal 语义）。
fn orthogonal(v: [f32; 3]) -> [f32; 3] {
    if v[2].abs() > 0.5 {
        normalize3([v[1], -v[0], 0.0])
    } else {
        normalize3([0.0, v[2], -v[1]])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turbulent_parses_scale_speed_and_orthonormalizes() {
        let json = r#"{"emitter":[{"rate":1}],"initializer":[
            {"name":"turbulentvelocityrandom","scale":0.5,"speedmin":35,"speedmax":100,
             "normal":"0 0 1","forward":"0 1 0"}]}"#;
        let spec = parse_particle_spec(json);
        let t = spec.init.turbulent.expect("turbulent 应解析");
        assert!((t.scale - 0.5).abs() < 1e-6);
        assert!((t.speed_min - 35.0).abs() < 1e-6);
        assert!((t.speed_max - 100.0).abs() < 1e-6);
        assert_eq!(t.normal, [0.0, 0.0, 1.0]);
        assert!((t.forward[1] - 1.0).abs() < 1e-6, "forward 应正交归一为 +Y");
    }

    #[test]
    fn rotation_and_angular_velocity_parse() {
        let json = r#"{"emitter":[{"rate":1}],"initializer":[
            {"name":"rotationrandom","min":"-5 -5 -5","max":"5 5 5"},
            {"name":"angularvelocityrandom","min":"-1 -1 -1","max":"1 1 1"}]}"#;
        let spec = parse_particle_spec(json);
        let rm = spec.init.rotation_min.expect("rotation min");
        assert_eq!(rm, [-5.0, -5.0, -5.0]);
        assert_eq!(spec.init.angular_vel_max.expect("ang max"), [1.0, 1.0, 1.0]);
    }

    #[test]
    fn renderer_spritetrail_parses() {
        let json = r#"{"emitter":[{"rate":1}],"renderer":[{"name":"spritetrail","length":0.01,"maxlength":2,"minlength":0.5}]}"#;
        let spec = parse_particle_spec(json);
        match spec.renderer {
            Renderer::SpriteTrail { length, max_length, min_length } => {
                assert!((length - 0.01).abs() < 1e-6);
                assert!((max_length - 2.0).abs() < 1e-6);
                assert!((min_length - 0.5).abs() < 1e-6);
            }
            _ => panic!("应为 spritetrail"),
        }
    }

    #[test]
    fn movement_gravity_drag_retained_in_params() {
        let json = r#"{"emitter":[{"rate":1}],"operator":[
            {"name":"movement","gravity":"0 100 0","drag":0.2}]}"#;
        let spec = parse_particle_spec(json);
        let mov = spec.operators.iter().find(|o| o.kind == OperatorKind::Movement).expect("movement");
        assert_eq!(mov.params["gravity"].as_str().unwrap(), "0 100 0");
        assert!((mov.params["drag"].as_f64().unwrap() - 0.2).abs() < 1e-6);
    }
}
