//! scene.json 解析（结构字段与现有 src/client/scene-json.ts 对齐）

use serde::Deserialize;

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum ObjectKind { Image, Particle, Util }

#[derive(Debug, Clone)]
pub struct SceneObject {
    pub kind: ObjectKind,
    pub origin: [f32; 3],
    pub scale: [f32; 3],
    pub size: Option<[f32; 2]>,
    pub image: Option<String>,
    pub particle: Option<String>,
    pub effects: Vec<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct SceneDesc {
    pub orthogonal: (f32, f32),
    pub objects: Vec<SceneObject>,
}

/// WE 向量字符串 "a b c"（或标量）→ [f32;3]，多 token 取前三，缺省 0
pub fn vec3_str(s: &str) -> [f32; 3] {
    let mut it = s.trim().split_whitespace().map(|t| t.parse::<f32>().unwrap_or(0.0));
    [it.next().unwrap_or(0.0), it.next().unwrap_or(0.0), it.next().unwrap_or(0.0)]
}

#[derive(Deserialize)]
struct RawObject {
    origin: Option<String>,
    scale: Option<String>,
    size: Option<serde_json::Value>,
    image: Option<String>,
    particle: Option<String>,
    #[serde(default)]
    effects: Option<Vec<serde_json::Value>>,
}

#[derive(Deserialize)]
struct RawScene {
    general: Option<RawGeneral>,
    objects: Vec<RawObject>,
}

#[derive(Deserialize)]
struct RawGeneral {
    orthogonalprojection: Option<RawOrtho>,
}

#[derive(Deserialize)]
struct RawOrtho { width: f32, height: f32 }

pub fn parse_scene(json: &str) -> SceneDesc {
    let raw: RawScene = serde_json::from_str(json).expect("scene.json 必须可解析");
    let ortho = raw.general.and_then(|g| g.orthogonalprojection).unwrap_or(RawOrtho { width: 1920.0, height: 1080.0 });
    let objects = raw.objects.into_iter().map(|o| {
        // kind 判定与 src/client/scene-json.ts 的 parseSceneJson 对齐：
        // 真实 WE scene.json 对象无 "type" 字段，按 particle/image 引用判定。
        let kind = if o.particle.as_deref().map_or(false, |s| !s.is_empty()) {
            ObjectKind::Particle
        } else if let Some(img) = o.image.as_deref() {
            // 对齐 TS parseSceneJson（scene-json.ts:38 `o.image && ...` falsy 语义）：
            // image 空串与无 image 等价 → 无引用对象按空粒子处理（不渲染）
            if img.is_empty() {
                ObjectKind::Particle
            } else if img.starts_with("models/util/") {
                // WE 内置合成层/全屏层/项目层（models/util/*.json）：效果链容器，归类 util
                ObjectKind::Util
            } else {
                ObjectKind::Image
            }
        } else {
            // 无引用对象按空粒子处理（不渲染）
            ObjectKind::Particle
        };
        let size = match o.size {
            Some(serde_json::Value::String(s)) => {
                let v = vec3_str(&s);
                Some([v[0], v[1]])
            }
            Some(serde_json::Value::Array(a)) => Some([a[0].as_f64().unwrap_or(0.0) as f32, a[1].as_f64().unwrap_or(0.0) as f32]),
            _ => None,
        };
        SceneObject {
            kind,
            origin: o.origin.as_deref().map(vec3_str).unwrap_or([0.0; 3]),
            scale: o.scale.as_deref().map(vec3_str).unwrap_or([1.0, 1.0, 1.0]),
            size,
            image: o.image,
            particle: o.particle,
            effects: o.effects.unwrap_or_default(),
        }
    }).collect();
    SceneDesc { orthogonal: (ortho.width, ortho.height), objects }
}
