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
    /// general.clearcolor（WE 向量字符串 "r g b"，**0-1 量级**——最终审查修复：
    /// 原注释疑为 0-255，实测 fixture "0.7 0.7 0.7" 与 JS 版 `new THREE.Color(0.7, 0.7, 0.7)`
    /// 均为 0-1 语义；渲染侧直接存储不再归一化）
    pub clear_color: Option<[f32; 3]>,
    pub objects: Vec<SceneObject>,
}

/// WE 向量字符串 "a b c"（或标量）→ [f32;3]，多 token 取前三，缺省 0
pub fn vec3_str(s: &str) -> [f32; 3] {
    let mut it = s.trim().split_whitespace().map(|t| t.parse::<f32>().unwrap_or(0.0));
    [it.next().unwrap_or(0.0), it.next().unwrap_or(0.0), it.next().unwrap_or(0.0)]
}

#[derive(Deserialize)]
struct RawObject {
    // Task 9 实测修复：origin/scale/image/particle 用 Value 容错 —— 真实库个别对象
    // （2597392171 实测 line 419）字段类型是 map 而非 string，serde 严格 String 直接
    // 解析失败（panic "invalid type: map, expected a string"）。对齐 scene-json.ts 的
    // 容错语义（非 string → 缺省值/无引用）。
    origin: Option<serde_json::Value>,
    scale: Option<serde_json::Value>,
    size: Option<serde_json::Value>,
    image: Option<serde_json::Value>,
    particle: Option<serde_json::Value>,
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
    clearcolor: Option<serde_json::Value>,
}

#[derive(Deserialize, Clone, Copy)]
struct RawOrtho { width: f32, height: f32 }

pub fn parse_scene(json: &str) -> SceneDesc {
    let raw: RawScene = serde_json::from_str(json).expect("scene.json 必须可解析");
    // 先提取 general（避免后续移动借用冲突）：ortho 用值，clearcolor 用引用
    let ortho = raw.general.as_ref().and_then(|g| g.orthogonalprojection).unwrap_or(RawOrtho { width: 1920.0, height: 1080.0 });
    let clear_color = raw
        .general
        .as_ref()
        .and_then(|g| g.clearcolor.as_ref())
        .and_then(|v| v.as_str())
        .map(vec3_str);
    let objects = raw.objects.into_iter().map(|o| {
        // 容错提取（对齐 scene-json.ts）：非 string 字段按缺省处理
        let origin = o.origin.as_ref().and_then(|v| v.as_str()).map(vec3_str).unwrap_or([0.0; 3]);
        let scale = o.scale.as_ref().and_then(|v| v.as_str()).map(vec3_str).unwrap_or([1.0, 1.0, 1.0]);
        let image = o.image.as_ref().and_then(|v| v.as_str()).map(String::from);
        let particle = o.particle.as_ref().and_then(|v| v.as_str()).map(String::from);
        // kind 判定与 src/client/scene-json.ts 的 parseSceneJson 对齐：
        // 真实 WE scene.json 对象无 "type" 字段，按 particle/image 引用判定。
        let kind = if particle.as_deref().map_or(false, |s| !s.is_empty()) {
            ObjectKind::Particle
        } else if let Some(img) = image.as_deref() {
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
            origin,
            scale,
            size,
            image,
            particle,
            effects: o.effects.unwrap_or_default(),
        }
    }).collect();
    SceneDesc { orthogonal: (ortho.width, ortho.height), clear_color, objects }
}
