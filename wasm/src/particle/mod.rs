//! 粒子模块：CPU 模拟器（sim，Task 2）+ 规格解析（parse_particle_spec，Task 1/既有）。
//! 本文件为「particle」模块根的目录式布局（原 particle.rs 内容移入 + 新增 `pub mod sim;`）；
//! 由于 Rust 禁止 `particle.rs` 与 `particle/mod.rs` 同时存在（E0761），转为目录式模块，
//! 原有 `particle::*` 对外路径不变（lib.rs `pub mod particle;` 对两种布局均适用）。
//!
//! 粒子规格解析（emitter[0] + initializer + operator + renderer；缺省值对齐现有 scene-assets.ts）
//! 标量字段：字符串取第一 token（防 NaN）；数字直用。缺省：rate=10、distancemax=(256,256,0)。
//! **vec3 字段**（directions/distancemin/distancemax/origin/mask/…）：字符串按空格逐轴、数组按分量、
//! **数字展开为三轴同值**（lwe `parseVec3` 语义）——distancemin/max 是**逐轴**半径（Crimson Stars
//! `"1000 500 0"` → x∈[0,1000]、y∈[0,500]），只有 sphererandom 才退化为仅用 `.x`。
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

pub mod sim;
pub mod spec_to_emitter;

/// 重导出 CPU 模拟器接口到 `particle` 模块根（供 Task 3/4 以 `particle::SceneParticleSim` 引用，
/// 与需求接口块/测试 import 一致）。
pub use sim::{ParticleEmitterSpec, ParticleInitSpec, SceneParticleSim, SimParticle};
/// 重导出 spec→模拟器映射（Task 4 纯函数，供 render/接线以 `particle::emitter_spec_to_particle` 引用）。
pub use spec_to_emitter::{emitter_spec_to_particle, spec_operators_to_sim};

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
    /// 按寿命正弦调制 alpha（oscillatealpha，星点闪烁）。参数 frequency/scalemin/scalemax/phase。
    OscillateAlpha,
    /// 按寿命正弦调制 size（oscillatesize）。参数同 oscillatealpha（缺省 0.8..1.2）。
    OscillateSize,
    /// 按寿命线性插值调制 size（sizechange）。参数 starttime/endtime/startvalue/endvalue。
    SizeChange,
    /// 按寿命线性插值调制 alpha（alphachange）。参数同 sizechange。
    AlphaChange,
    /// 按寿命线性插值调制 color（colorchange）。参数同上 + startvalue/endvalue 为 vec3。
    ColorChange,
    Other,
}

#[derive(Debug, Clone)]
pub struct Operator { pub kind: OperatorKind, pub params: Value }

#[derive(Debug, Clone)]
pub struct EmitterSpec {
    pub rate: f32,
    pub directions: [f32; 3],
    /// 发射散射半径下界（WE/lwe 为 **vec3 逐轴**；lwe `ObjectParser::parseParticleEmitter`
    /// `parseVec3("distancemin", (0,0,0))` —— 字符串 "x y z" 逐轴、数字则三轴同值）。
    /// boxrandom 逐轴使用；sphererandom 只用 `.x`（lwe `createSphereEmitter`）。
    pub distance_min: [f32; 3],
    /// 发射散射半径上界（逐轴）。缺省 `(256, 256, 0)`（对齐 lwe ObjectParser 缺省）。
    pub distance_max: [f32; 3],
    /// 发射器局部偏移（we "x y z"；缺省 [0,0,0]）。CPU 模拟用它把发射点抬离对象中心
    /// （黑神话花瓣 origin="350 750 0" → 从**上方**发射），y 在 spawn 时**不翻**（+y 抬到中心上方；
    /// origin.y=0 的壁纸 EVA/DK 等不受影响）。
    pub origin: [f32; 3],
    /// 是否球壳散射（emitter name=="sphererandom" → true；缺省 false）。
    /// CPU 模拟器 sim.rs 的 spawn 现统一按 3D 球壳/球体处理，字段为未来语义扩展保留。
    pub is_sphere: bool,
}

#[derive(Debug, Clone)]
pub struct InitSpec {
    pub lifetime_min: f32,
    pub lifetime_max: f32,
    pub size_min: f32,
    pub size_max: f32,
    /// sizerandom 的 `exponent`（WE/lwe 缺省 **1.0**：`ObjectParser` `it.user("exponent", 1.0f)`）。
    /// 黑神话花瓣显式 `"exponent": 2` → 解析后仍为 2（该对象行为不变）。
    pub size_exponent: f32,
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
/// speed 在 [speedmin, speedmax] 随机；scale（绕 normal 的旋转角缩放）；offset（旋转角常量项，
/// 弧度）；timescale（curl 噪声行走的时间缩放）；phasemin/phasemax（每粒子随机相位）；
/// normal/forward 正交基。
#[derive(Debug, Clone)]
pub struct TurbulentInit {
    pub scale: f32,
    pub speed_min: f32,
    pub speed_max: f32,
    pub normal: [f32; 3],
    pub forward: [f32; 3],
    /// offset：叠加在旋转角上的常量项（官方 `theta = angle*scale + offset`，弧度）。
    /// ember.json 用 -0.5（5 张壁纸）。
    pub offset: f32,
    /// timescale：curl 噪声行走的时间缩放（官方 `position += result*0.005*timescale`）。
    pub timescale: f32,
    /// phasemin/phasemax：每粒子随机相位，参与 curl 噪声采样点（官方 `position + normal*phase`）。
    pub phase_min: f32,
    pub phase_max: f32,
}

/// WE scene.json 对象级 `instanceoverride`（粒子实例覆盖）。
///
/// 官方 `wpscene::ParticleInstanceoverride`（OWE `ParticleObject.cppm:156-186`）+ 应用语义
/// `OverrideSpawnProgram`（`ParticleParser.cpp:359-384`）：它被**追加在所有 initializer 之后**
/// （`SceneParticleObjectParser.cpp:247-249`），对已经随机出来的初值做乘法/覆盖；
/// 同时 emitter rate 乘 `Count()`（`SceneParticleObjectParser.cpp:264`
/// `newEm.rate *= modifiers.Count()`）。颜色走 `UiColorToLinear(v) = v*v`，
/// 标量走 `UiScalarToLinear(v) = v`（恒等，见 `ParticleParser.cpp:184-186`）。
///
/// 缺省全 1 / color=None 即「不做任何改变」；scene 对象没有该字段时用 `Default`。
///
/// 回归背景（GTR 3743126786）：该壁纸的烟柱 `instanceoverride.alpha = 0.03`
/// 是它在桌面端几乎不可见的原因；此前全库未实现 override → 粒子按材质 alpha（实测均值 0.797）
/// 渲染，叠成一条刺眼的白色烟串。
#[derive(Debug, Clone)]
pub struct ParticleOverride {
    /// 透明度乘数（官方 `UiScalarToLinear(alpha)`，实为恒等）。
    pub alpha: f32,
    /// 尺寸乘数。
    pub size: f32,
    /// 寿命乘数。
    pub lifetime: f32,
    /// 速度乘数（作用于 spawn 初速，**含 turbulentvelocityrandom 叠加的部分**——override 是
    /// 最后一个 initializer，官方在它之后才乘 Speed()）。
    pub speed: f32,
    /// emitter.rate 乘数（官方 `Count()`）。
    pub count: f32,
    /// 颜色覆盖（已转线性 0-1）：`color`（legacy 0-255 → /255 再平方）优先，
    /// 否则 `colorn`（0-1 直接平方）。
    pub color: Option<[f32; 3]>,
}

impl Default for ParticleOverride {
    fn default() -> Self {
        Self { alpha: 1.0, size: 1.0, lifetime: 1.0, speed: 1.0, count: 1.0, color: None }
    }
}

/// 解析 scene.json 对象的 `instanceoverride` 字段。
///
/// 空串（JS 侧「无覆盖」的约定）/ 非法 JSON / 非对象 → `None`（调用方落 `Default`，即不改变）。
/// 字段解析用 `scalar`（字符串取首 token、数字直用），与粒子 spec 的解析同一套启发。
pub fn parse_particle_override(json: &str) -> Option<ParticleOverride> {
    if json.trim().is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(json).ok()?;
    if !v.is_object() {
        return None;
    }
    let num = |k: &str| v.get(k).map(|x| scalar(x, 1.0)).unwrap_or(1.0);
    // 官方 `OverrideSpawnProgram`：`color`（legacy，0-255）先 /255 再 `UiColorToLinear`(=v²)；
    // `colorn`（已归一）直接 v²。二者只取其一（`color` 优先，与 OWE FromJosn 的 if/else if 一致）。
    let color = if let Some(c) = v.get("color") {
        let n = vec3(c);
        Some([(n[0] / 255.0).powi(2), (n[1] / 255.0).powi(2), (n[2] / 255.0).powi(2)])
    } else {
        v.get("colorn").map(|c| {
            let n = vec3(c);
            [n[0] * n[0], n[1] * n[1], n[2] * n[2]]
        })
    };
    Some(ParticleOverride {
        alpha: num("alpha"),
        size: num("size"),
        lifetime: num("lifetime"),
        speed: num("speed"),
        count: num("count"),
        color,
    })
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
    /// WE 粒子材质名（spec 的 `material` 字段，如 `materials/presets/lightshaft.json`）。
    /// 渲染侧据此推导混合模式（additive/alpha）与 overbright（读取 lwe material 的
    /// `ui_editor_properties_overbright` 常量）。缺失 → `None`（Translucent 兜底）。
    pub material: Option<String>,
}

/// 粒子渲染器类型（官方 renderer[]）。当前只消费 sprite / spritetrail。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Renderer {
    Sprite,
    SpriteTrail { length: f32, max_length: f32, min_length: f32 },
    Rope,
    RopeTrail,
}

/// turbulentvelocityrandom 缺省参数（官方 TurbulentRandom 默认值，OWE `ParticleParser.cpp:211-221`）。
/// speedmin=100 speedmax=250 scale=1 offset=0 timescale=1 phasemin=0 phasemax=0.1；
/// normal 缺省 +Z，forward 缺省 +Y（2D 常用）。
fn default_turbulent() -> TurbulentInit {
    TurbulentInit {
        scale: 1.0,
        speed_min: 100.0,
        speed_max: 250.0,
        normal: [0.0, 0.0, 1.0],
        forward: [0.0, 1.0, 0.0],
        offset: 0.0,
        timescale: 1.0,
        phase_min: 0.0,
        phase_max: 0.1,
    }
}

/// lwe `ObjectParser::parseParticleEmitter` 的 `directions` 缺省值 **(1,1,0)**
/// （`ObjectParser.cpp:594`：`parseVec3("directions", glm::vec3(1.0f, 1.0f, 0.0f))`）。
/// ⚠️ 不是零向量：`emitter_local()` 把散射偏移乘 directions，缺省取 0 会让粒子全部叠在发射点
/// （Crimson Horizon 的绿色萤火虫就这么被挤成一小片，见 spec_to_emitter 的回归测试）。
/// 缺省 z=0 表示「正交粒子的散射只在 XY 平面」（WE 正交粒子即 2D disk + z 无关）。
pub const LWE_DEFAULT_DIRECTIONS: [f32; 3] = [1.0, 1.0, 0.0];

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
        // JSON 数字：照 lwe `ObjectParser::parseVec3` 的 `is_number()` → **三轴同值**
        //（与 `vec3_field` 同一语义）。**不是** [v,0,0] —— 那会让 `rotationrandom: -0.4`
        // 变成 rot=0（CPU 取 z 分量），自旋静默失效；`direction` 类字段同理。
        // 回归：1280029027/1429403119/2011060960/2911105183 的 light_shafts 用数字写法。
        Value::Number(n) => {
            let x = n.as_f64().unwrap_or(0.0) as f32;
            [x, x, x]
        }
        _ => [0.0; 3],
    }
}

/// `vec3` + 「**字段缺失**时用 lwe 缺省值」（字段存在则照原样解析，含显式 "0 0 0"）。
///
/// 用于 `directions`：lwe `ObjectParser::parseParticleEmitter`（ObjectParser.cpp:594）
/// `.directions = parseVec3("directions", glm::vec3(1.0f, 1.0f, 0.0f))` —— **缺省 (1,1,0)**。
/// 缺省取 0 向量会把 `emitter_local()` 的散射整体乘 0（粒子全部叠在发射点），
/// 见 `spec_to_emitter.rs` 的 `directions_default_1_1_0_when_absent` 回归测试。
fn vec3_or(v: &Value, default: [f32; 3]) -> [f32; 3] {
    match v {
        // 数字也交给 vec3（三轴同值）；否则 `directions: 1` 这类写法会被换成默认值而非报出原意。
        Value::String(_) | Value::Array(_) | Value::Number(_) => vec3(v),
        _ => default,
    }
}

/// `vec3` + 「**字段缺失/非法**时用默认值」的变体，并支持 **JSON 数字**（lwe
/// `ObjectParser::parseParticleEmitter` 的 `parseVec3`：`is_number()` → 三轴同值）。
///
/// 用于 `distancemin`/`distancemax`（发射散射半径）：WE 里既有字符串形式
/// `"1000 500 0"`（Crimson Stars / Lycoris dust），也有**数字**形式（DK `"distancemax": 50`、
/// 黑神话 `750`）。数字必须展开为 `(v, v, v)`（**不是** [v,0,0]，也不是取标量后只用 x），
/// 否则 boxrandom 各轴的散射范围会与 WE 不符（这正是 Crimson Stars「全屏白点」的成因）。
fn vec3_field(v: &Value, default: [f32; 3]) -> [f32; 3] {
    match v {
        // 数字展开为 (v,v,v) 的语义由 `vec3` 统一负责（lwe parseVec3 的 is_number 分支）；
        // 本变体只多一条「字段缺失/非法 → default」。
        Value::Number(_) | Value::String(_) | Value::Array(_) => vec3(v),
        _ => default,
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
                "oscillatealpha" => OperatorKind::OscillateAlpha,
                "oscillatesize" => OperatorKind::OscillateSize,
                "sizechange" => OperatorKind::SizeChange,
                "alphachange" => OperatorKind::AlphaChange,
                "colorchange" => OperatorKind::ColorChange,
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
            directions: vec3_or(&em["directions"], LWE_DEFAULT_DIRECTIONS),
            // 散射半径 **vec3 逐轴**（lwe `createBoxEmitter` 各轴用 distanceMin/Max[axis]；
            // `createSphereEmitter` 只用 `.x`）。数字形式展开为三轴同值。
            distance_min: vec3_field(&em["distancemin"], [0.0, 0.0, 0.0]),
            distance_max: vec3_field(&em["distancemax"], [256.0, 256.0, 0.0]),
            // 发射器局部偏移（"x y z"；缺省/缺失 → [0,0,0]）。黑神话花瓣 origin="350 750 0"。
            origin: vec3(&em["origin"]),
            // 球壳散射：emitter name=="sphererandom" → true；缺省 false。
            is_sphere: em["name"].as_str() == Some("sphererandom"),
        },
        init: InitSpec {
            lifetime_min: life.map(|i| scalar(&i["min"], 1.0)).unwrap_or(1.0),
            lifetime_max: life.map(|i| scalar(&i["max"], 1.0)).unwrap_or(1.0),
            size_min: size.map(|i| scalar(&i["min"], 16.0)).unwrap_or(16.0),
            size_max: size.map(|i| scalar(&i["max"], 16.0)).unwrap_or(16.0),
            // sizerandom 的 exponent（WE/lwe 缺省 1.0；黑神话显式 2）。
            size_exponent: size.map(|i| scalar(&i["exponent"], 1.0)).unwrap_or(1.0),
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
        material: raw.get("material").and_then(|m| m.as_str()).map(|s| s.to_string()),
    }
}

/// 解析 turbulentvelocityrandom 的平铺字段
/// （scale/speedmin/speedmax/offset/timescale/phasemin/phasemax/normal/forward）。
/// 缺省用官方默认；normal/forward 正交归一。
fn parse_turbulent(i: &Value) -> TurbulentInit {
    let mut tu = default_turbulent();
    let g = |k: &str, d: f32| i.get(k).map(|v| scalar(v, d)).unwrap_or(d);
    tu.scale = g("scale", 1.0);
    tu.speed_min = g("speedmin", 100.0);
    tu.speed_max = g("speedmax", 250.0);
    tu.offset = g("offset", 0.0);
    tu.timescale = g("timescale", 1.0);
    tu.phase_min = g("phasemin", 0.0);
    tu.phase_max = g("phasemax", 0.1);
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

    // ── 裸数字写法的 vec3 字段（2026-09-22 修复：此前 `vec3`/`vec3_or` 只认 String|Array，
    //    数字被静默丢成 [0,0,0] / 被换成默认值）──────────────────────────────────────────

    #[test]
    fn vec3_number_expands_to_three_axes() {
        // lwe `ObjectParser::parseVec3`：is_number() → 三轴同值（**不是** [v,0,0]）
        assert_eq!(vec3(&serde_json::json!(3)), [3.0, 3.0, 3.0]);
        assert_eq!(vec3(&serde_json::json!(-0.4)), [-0.4, -0.4, -0.4]);
        assert_eq!(vec3(&serde_json::json!(0)), [0.0, 0.0, 0.0]);
    }

    #[test]
    fn rotation_random_accepts_bare_numbers() {
        // 回归：1280029027 / 1429403119 / 2011060960 / 2911105183 的 light_shafts
        // 写的是 `"min": -0.4, "max": -0.3`（数字）→ 本应得到约 −20° 的自旋，
        // 修复前被解析成 0（CPU 取 z 分量 ⇒ lerp(0,0) = 0）⇒ 自旋静默失效。
        let json = r#"{"emitter":[{"rate":1}],"initializer":[
            {"name":"rotationrandom","min":-0.4,"max":-0.3}]}"#;
        let spec = parse_particle_spec(json);
        assert_eq!(spec.init.rotation_min.expect("rotation min"), [-0.4, -0.4, -0.4]);
        assert_eq!(spec.init.rotation_max.expect("rotation max"), [-0.3, -0.3, -0.3]);
        // CPU spawn 取 z 分量 → lerp(rotation[2]) 落在 (-0.4, -0.3)
        assert!((-0.4..=-0.3).contains(&spec.init.rotation_min.unwrap()[2]));
    }

    #[test]
    fn distance_field_keeps_number_semantics_after_unification() {
        // `vec3_field` 改为复用 `vec3` 后语义不变：数字 → (v,v,v)、缺失 → default
        let em = serde_json::json!({"distancemin": 50});
        assert_eq!(vec3_field(&em["distancemin"], [0.0, 0.0, 0.0]), [50.0, 50.0, 50.0]);
        assert_eq!(vec3_field(&em["distancemax"], [256.0, 256.0, 0.0]), [256.0, 256.0, 0.0]);
    }

    #[test]
    fn vec3_or_uses_number_instead_of_default() {
        // directions 写成裸数字时应按三轴同值解析，而不是被换成缺省 (1,1,0)
        assert_eq!(vec3_or(&serde_json::json!(0.5), [1.0, 1.0, 0.0]), [0.5, 0.5, 0.5]);
        // 缺失/非法仍走缺省
        assert_eq!(vec3_or(&serde_json::Value::Null, [1.0, 1.0, 0.0]), [1.0, 1.0, 0.0]);
    }
}
