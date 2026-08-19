//! 粒子规格解析（emitter[0] + initializer + operator；缺省值对齐现有 scene-assets.ts）
//! 标量字段：字符串取第一 token（防 NaN）；数字直用。缺省：rate=10、distancemax=256。

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum OperatorKind { Movement, AlphaFade, Other }

#[derive(Debug, Clone)]
pub struct Operator { pub kind: OperatorKind, pub params: serde_json::Value }

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
}

#[derive(Debug, Clone)]
pub struct ParticleSpec {
    pub emitter: EmitterSpec,
    pub init: InitSpec,
    pub operators: Vec<Operator>,
}

fn scalar(v: &serde_json::Value, default: f32) -> f32 {
    match v {
        serde_json::Value::Number(n) => n.as_f64().unwrap_or(default as f64) as f32,
        serde_json::Value::String(s) => s.trim().split_whitespace().next()
            .and_then(|t| t.parse::<f32>().ok())
            .unwrap_or(default),
        _ => default,
    }
}

fn vec3(v: &serde_json::Value) -> [f32; 3] {
    match v {
        serde_json::Value::String(s) => {
            let mut it = s.trim().split_whitespace().map(|t| t.parse::<f32>().unwrap_or(0.0));
            [it.next().unwrap_or(0.0), it.next().unwrap_or(0.0), it.next().unwrap_or(0.0)]
        }
        serde_json::Value::Array(a) => [
            a.first().and_then(|x| x.as_f64()).unwrap_or(0.0) as f32,
            a.get(1).and_then(|x| x.as_f64()).unwrap_or(0.0) as f32,
            a.get(2).and_then(|x| x.as_f64()).unwrap_or(0.0) as f32,
        ],
        _ => [0.0; 3],
    }
}

#[derive(Deserialize)]
struct RawInit {
    name: Option<String>,
    min: Option<serde_json::Value>,
    max: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct RawOperator { name: Option<String>, #[serde(flatten)] params: serde_json::Map<String, serde_json::Value> }

#[derive(Deserialize)]
struct RawParticle {
    emitter: Option<Vec<serde_json::Value>>,
    initializer: Option<Vec<RawInit>>,
    operator: Option<Vec<RawOperator>>,
}

pub fn parse_particle_spec(json: &str) -> ParticleSpec {
    let raw: RawParticle = serde_json::from_str(json).expect("粒子 json 必须可解析");
    let em = raw.emitter.as_ref().and_then(|e| e.first()).cloned().unwrap_or(serde_json::json!({}));
    let em = em.as_object().cloned().unwrap_or_default();
    let em = serde_json::Value::Object(em);

    let inits = raw.initializer.unwrap_or_default();
    let life = inits.iter().find(|i| i.name.as_deref() == Some("lifetimerandom"));
    let size = inits.iter().find(|i| i.name.as_deref() == Some("sizerandom"));
    let vel = inits.iter().find(|i| i.name.as_deref() == Some("velocityrandom"));
    let color = inits.iter().find(|i| i.name.as_deref() == Some("colorrandom"));

    let operators = raw.operator.unwrap_or_default().into_iter().map(|op| {
        let kind = match op.name.as_deref() {
            Some("movement") => OperatorKind::Movement,
            Some("alphafade") => OperatorKind::AlphaFade,
            _ => OperatorKind::Other,
        };
        Operator { kind, params: serde_json::Value::Object(op.params) }
    }).collect();

    ParticleSpec {
        emitter: EmitterSpec {
            rate: scalar(&em["rate"], 10.0),
            directions: vec3(&em["directions"]),
            distance_min: scalar(&em["distancemin"], 0.0),
            distance_max: scalar(&em["distancemax"], 256.0),
        },
        init: InitSpec {
            lifetime_min: life.and_then(|i| i.min.as_ref()).map(|v| scalar(v, 1.0)).unwrap_or(1.0),
            lifetime_max: life.and_then(|i| i.max.as_ref()).map(|v| scalar(v, 1.0)).unwrap_or(1.0),
            size_min: size.and_then(|i| i.min.as_ref()).map(|v| scalar(v, 16.0)).unwrap_or(16.0),
            size_max: size.and_then(|i| i.max.as_ref()).map(|v| scalar(v, 16.0)).unwrap_or(16.0),
            velocity_min: vel.and_then(|i| i.min.as_ref()).map(vec3).unwrap_or([0.0; 3]),
            velocity_max: vel.and_then(|i| i.max.as_ref()).map(vec3).unwrap_or([0.0; 3]),
            color_min: color.and_then(|i| i.min.as_ref()).map(vec3),
            color_max: color.and_then(|i| i.max.as_ref()).map(vec3),
        },
        operators,
    }
}
