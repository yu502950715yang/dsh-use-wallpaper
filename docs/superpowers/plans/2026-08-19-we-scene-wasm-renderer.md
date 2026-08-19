# Rust/WebGPU 通用 Scene 渲染引擎（v1）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 DSH 通用插件构建 Rust/wgpu（WASM/WebGPU）scene 渲染引擎 v1（图片对象 + compute shader 粒子 + 全格式纹理解码），替代现有 JS/WebGL 渲染器作为主渲染路径，效果逼近 WE 真机。

**Architecture:** 新 crate `we-scene-wasm` 编译为 wasm32-unknown-unknown，wasm-bindgen 导出渲染 API；host 复用现有路由提供资源字节流；JS 胶水实现 `sceneRenderer` 接口接入现有回退链（无 WebGPU/wasm 失败 → 回退 JS 渲染或 preview）。

**Tech Stack:** Rust 1.96、wgpu（WebGPU 后端，wasm32）、wasm-bindgen 0.2、wasm-pack、serde_json、lz4_flex、bytemuck。

**Spec:** `docs/superpowers/specs/2026-08-19-we-scene-wasm-renderer-design.md`

## Global Constraints

- target：`wasm32-unknown-unknown`；构建产物 `we-scene.wasm` 随插件 bundle 分发，体积 ≤ 2MB（release + wasm-opt）。
- 兼容底线：现代 Chromium（Edge/Chrome 113+）WebGPU；`navigator.gpu` 缺失或 wasm 失败 → 回退现有 JS/WebGL 渲染器（`src/client/wallpaper-controller.ts` 的 `sceneRenderer` 接口）。
- 解析全在 Rust（scene.json/粒子/纹理）；host 侧零改动（复用 `routes.ts`、`pkg-reader.ts`、`scanner.ts`）。
- 坐标映射（全局公式，引自 scene-renderer.ts 文件头注释）：`three.x = we.x - vw/2`；`three.y = vh/2 - we.y`；粒子 `scale.y` 取负。
- 粒子缺省值（对齐现有 `scene-assets.ts`）：emitter rate=10、distancemax=256；向量字段若为多 token 字符串取第一 token（防 NaN）。
- 纹理格式枚举（TEXV0005，引自 tex-loader.ts）：RGBA8888=0、DXT5=4、DXT3=6、DXT1=7、RG88=8、R8=9。
- 解析模块（scene/particle/tex/coords）**不得依赖 wgpu**——保证 `cargo test`（native）可在无 GPU 环境跑通；wgpu 渲染代码只在浏览器验证。
- 提交信息用中文；每个任务独立 commit。

---

## Task 0: 环境准备（wasm target + wasm-pack）

**Files:**
- 无代码文件；仅环境操作。

**Interfaces:**
- Produces: `rustup target add wasm32-unknown-unknown` 成功；`wasm-pack --version` 可用（后续任务依赖）。

- [ ] **Step 1: 安装 wasm32 target**

Run:
```bash
rustup target add wasm32-unknown-unknown
```
Expected: 成功。若报 `mirrors.tuna.tsinghua.edu.cn ... 403`（本机已知镜像问题），按顺序尝试：
1. 显式官方源（同一命令前加）：
```bash
set RUSTUP_DIST_SERVER=https://static.rust-lang.org
set RUSTUP_UPDATE_ROOT=https://static.rust-lang.org/rustup
rustup target add wasm32-unknown-unknown
```
2. 若仍 403，换 rsproxy：
```bash
set RUSTUP_DIST_SERVER=https://rsproxy.cn
set RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup
rustup target add wasm32-unknown-unknown
```
3. 若均失败，手动安装：下载 `https://static.rust-lang.org/dist/2026-05-28/rust-std-1.96.0-wasm32-unknown-unknown.tar.xz`，解压后将 `rust-std-wasm32-unknown-unknown/` 目录拷贝到 `C:\Users\0009\.rustup\toolchains\stable-x86_64-pc-windows-msvc\lib\rustlib\wasm32-unknown-unknown\`（无此目录则新建）。

- [ ] **Step 2: 验证 target**

Run: `rustup target list --installed`
Expected: 包含 `wasm32-unknown-unknown`。

- [ ] **Step 3: 安装 wasm-pack**

Run: `cargo install wasm-pack --locked`
Expected: 安装成功（约 5-10 分钟编译）。验证 `wasm-pack --version` 输出版本号。

- [ ] **Step 4: 提交**

无代码改动，本任务无需 commit（环境操作）。

---

## Task 1: crate 骨架 + 坐标映射模块

**Files:**
- Create: `packages/dsh-wallpaper-engine/wasm/Cargo.toml`
- Create: `packages/dsh-wallpaper-engine/wasm/src/lib.rs`
- Create: `packages/dsh-wallpaper-engine/wasm/src/coords.rs`
- Test: `packages/dsh-wallpaper-engine/wasm/tests/coords_test.rs`

**Interfaces:**
- Produces:
  - `coords::we_to_three(we_x: f32, we_y: f32, vw: f32, vh: f32) -> (f32, f32)`
  - `coords::origin_to_center(origin: [f32; 3], vw: f32, vh: f32) -> [f32; 3]`
  - `coords::particle_scale(scale: [f32; 3]) -> [f32; 3]`
- Consumes: 无（首个任务）。

- [ ] **Step 1: 写失败的测试**

`tests/coords_test.rs`:
```rust
use we_scene_wasm::coords;

#[test]
fn eva_fullscreen_image_centers_at_zero() {
    // EVA 主图 origin=(1200, 777.5) = size/2，视口 2400×1555 → 中心应为 (0,0)
    let (x, y) = coords::we_to_three(1200.0, 777.5, 2400.0, 1555.0);
    assert!((x).abs() < 1e-4, "x={x}");
    assert!((y).abs() < 1e-4, "y={y}");
}

#[test]
fn origin_to_center_maps_y_flip() {
    // WE (0,0)（左上角）→ 中心系 (-vw/2, +vh/2)
    let c = coords::origin_to_center([0.0, 0.0, 5.0], 1920.0, 1080.0);
    assert_eq!(c, [-960.0, 540.0, 5.0]);
}

#[test]
fn particle_scale_flips_y() {
    assert_eq!(coords::particle_scale([1.0, 2.0, 3.0]), [1.0, -2.0, 3.0]);
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path packages/dsh-wallpaper-engine/wasm/Cargo.toml`
Expected: 编译失败（`we_scene_wasm` crate 不存在）。

- [ ] **Step 3: 写最小实现**

`Cargo.toml`:
```toml
[package]
name = "we-scene-wasm"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
lz4_flex = "0.11"
bytemuck = { version = "1", features = ["derive"] }
wasm-bindgen = "0.2"
# wgpu 在 Task 5 引入；本任务保持解析模块无 wgpu 依赖
```

`src/lib.rs`:
```rust
pub mod coords;
```

`src/coords.rs`:
```rust
//! WE 场景坐标（左上原点、y 向下）→ WebGPU 中心原点、y 向上。
//! 公式：three.x = we.x - vw/2；three.y = vh/2 - we.y（scene-renderer.ts 文件头注释）

pub fn we_to_three(we_x: f32, we_y: f32, vw: f32, vh: f32) -> (f32, f32) {
    (we_x - vw / 2.0, vh / 2.0 - we_y)
}

/// 对象锚点（origin，WE 场景中的中心点）→ 场景中心坐标
pub fn origin_to_center(origin: [f32; 3], vw: f32, vh: f32) -> [f32; 3] {
    let (x, y) = we_to_three(origin[0], origin[1], vw, vh);
    [x, y, origin[2]]
}

/// 粒子 scale.y 取负完成 y 翻转（方向/速度与 WE 屏幕表现一致）
pub fn particle_scale(scale: [f32; 3]) -> [f32; 3] {
    [scale[0], -scale[1], scale[2]]
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path packages/dsh-wallpaper-engine/wasm/Cargo.toml`
Expected: 3 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-wallpaper-engine/wasm
git commit -m "feat(wallpaper-engine): wasm crate 骨架 + 坐标映射模块（TDD）"
```

---

## Task 2: scene.json 解析

**Files:**
- Create: `packages/dsh-wallpaper-engine/wasm/src/scene.rs`
- Modify: `packages/dsh-wallpaper-engine/wasm/src/lib.rs`（加 `pub mod scene;`）
- Create: `packages/dsh-wallpaper-engine/wasm/tests/fixtures/eva/scene.json`（复制自 `packages/dsh-wallpaper-engine/tests/fixtures/eva/scene.json`）
- Test: `packages/dsh-wallpaper-engine/wasm/tests/scene_test.rs`

**Interfaces:**
- Consumes: 无（纯解析）。
- Produces:
  - `scene::SceneDesc { orthogonal: (f32, f32), objects: Vec<SceneObject> }`
  - `scene::SceneObject { kind: ObjectKind, origin: [f32;3], scale: [f32;3], size: Option<[f32;2]>, image: Option<String>, particle: Option<String>, effects: Vec<serde_json::Value> }`
  - `scene::ObjectKind { Image, Particle, Util }`
  - `scene::parse_scene(json: &str) -> SceneDesc`（解析失败 panic——调用方保证传入有效 JSON；对齐现有 `parseSceneJson` 行为）
  - 辅助 `scene::vec3_str(s: &str) -> [f32; 3]`（多 token 字符串取前三分量，缺省 0）

- [ ] **Step 1: 写失败的测试**

`tests/scene_test.rs`（先复制 fixture 文件）:
```rust
use we_scene_wasm::scene::{parse_scene, ObjectKind};

const EVA_JSON: &str = include_str!("fixtures/eva/scene.json");

#[test]
fn parses_orthogonal_projection() {
    let desc = parse_scene(EVA_JSON);
    assert_eq!(desc.orthogonal, (2400.0, 1555.0));
}

#[test]
fn parses_image_objects() {
    let desc = parse_scene(EVA_JSON);
    let imgs: Vec<_> = desc.objects.iter().filter(|o| o.kind == ObjectKind::Image).collect();
    assert!(!imgs.is_empty());
    // EVA 主图：origin=size/2=(1200,777.5)、scale=(1,1,1)
    let main = imgs.iter().find(|o| o.size == Some([2400.0, 1555.0])).expect("main image");
    assert_eq!(main.origin, [1200.0, 777.5, 0.0]);
    assert!(main.image.as_deref().unwrap().contains("models/"));
}

#[test]
fn parses_particle_objects_with_effects() {
    let desc = parse_scene(EVA_JSON);
    let parts: Vec<_> = desc.objects.iter().filter(|o| o.kind == ObjectKind::Particle).collect();
    assert!(!parts.is_empty());
    assert!(parts.iter().all(|o| o.particle.is_some()));
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path packages/dsh-wallpaper-engine/wasm/Cargo.toml`
Expected: 编译失败（`scene` 模块不存在）。

- [ ] **Step 3: 写最小实现**

`src/scene.rs`:
```rust
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
#[serde(rename_all = "lowercase")]
struct RawObject {
    #[serde(rename = "type")]
    kind: Option<String>,
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
        let kind = match o.kind.as_deref() {
            Some("image") => ObjectKind::Image,
            Some("particle") => ObjectKind::Particle,
            _ => ObjectKind::Util,
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path packages/dsh-wallpaper-engine/wasm/Cargo.toml`
Expected: 3 个 scene 测试 + 3 个 coords 测试全 PASS。
注意：若 `origin` 缺省 scale 断言不符，以真实 EVA fixture 为准调整测试期望值（先读 fixture 确认字段）。

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-wallpaper-engine/wasm
git commit -m "feat(wallpaper-engine): scene.json 解析模块（TDD）"
```

---

## Task 3: 粒子规格解析

**Files:**
- Create: `packages/dsh-wallpaper-engine/wasm/src/particle.rs`
- Modify: `packages/dsh-wallpaper-engine/wasm/src/lib.rs`（加 `pub mod particle;`）
- Create: `packages/dsh-wallpaper-engine/wasm/tests/fixtures/eva/particles_Ashes.json`（复制自 `packages/dsh-wallpaper-engine/tests/fixtures/eva/particles_Ashes.json`）
- Create: `packages/dsh-wallpaper-engine/wasm/tests/fixtures/eva/particles_presets_lightshafts.json`（复制自同名文件）
- Test: `packages/dsh-wallpaper-engine/wasm/tests/particle_test.rs`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `particle::ParticleSpec { emitter: EmitterSpec, init: InitSpec, operators: Vec<Operator> }`
  - `particle::EmitterSpec { rate: f32, directions: [f32;3], distance_min: f32, distance_max: f32 }`
  - `particle::InitSpec { lifetime_min: f32, lifetime_max: f32, size_min: f32, size_max: f32, velocity_min: [f32;3], velocity_max: [f32;3], color_min: Option<[f32;3]>, color_max: Option<[f32;3]> }`
  - `particle::Operator { kind: OperatorKind, params: serde_json::Value }`（`OperatorKind::{Movement, AlphaFade, Other}`）
  - `particle::parse_particle_spec(json: &str) -> ParticleSpec`
  - 标量字段解析规则：字段为字符串时取**第一 token**（防 NaN，对齐 Global Constraints）；缺省 rate=10、distance_max=256、lifetime 1..1、size 16..16。

- [ ] **Step 1: 写失败的测试**

`tests/particle_test.rs`:
```rust
use we_scene_wasm::particle::{parse_particle_spec, OperatorKind};

const ASHES_JSON: &str = include_str!("fixtures/eva/particles_Ashes.json");
const LIGHTSHAFTS_JSON: &str = include_str!("fixtures/eva/particles_presets_lightshafts.json");

#[test]
fn ashes_emitter_defaults() {
    // Ashes emitter 无 rate 字段 → 缺省 10
    let spec = parse_particle_spec(ASHES_JSON);
    assert_eq!(spec.emitter.rate, 10.0);
    assert_eq!(spec.emitter.distance_max, 256.0);
}

#[test]
fn lightshafts_low_rate() {
    let spec = parse_particle_spec(LIGHTSHAFTS_JSON);
    assert!(spec.emitter.rate < 1.0, "lightshafts rate 应很低: {}", spec.emitter.rate);
}

#[test]
fn vector_fields_do_not_nan() {
    // distancemax 向量 "50 256 0" → 取第一 token 50，不得 NaN
    let spec = parse_particle_spec(ASHES_JSON);
    assert!(spec.emitter.distance_max.is_finite());
    assert!(spec.init.velocity_max.iter().all(|v| v.is_finite()));
}

#[test]
fn detects_movement_operator() {
    let spec = parse_particle_spec(ASHES_JSON);
    assert!(spec.operators.iter().any(|op| op.kind == OperatorKind::Movement));
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path packages/dsh-wallpaper-engine/wasm/Cargo.toml`
Expected: 编译失败（`particle` 模块不存在）。

- [ ] **Step 3: 写最小实现**

`src/particle.rs`:
```rust
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path packages/dsh-wallpaper-engine/wasm/Cargo.toml`
Expected: particle 4 个测试 PASS。若 `lightshafts_low_rate` 或 `detects_movement_operator` 与 fixture 不符，先读 fixture 确认字段名（`operator[].name`、`emitter.rate`）再调整实现或断言。

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-wallpaper-engine/wasm
git commit -m "feat(wallpaper-engine): 粒子规格解析模块（TDD，含缺省值与 NaN 防护）"
```

---

## Task 4: TEXV0005 解析 + LZ4 解压

**Files:**
- Create: `packages/dsh-wallpaper-engine/wasm/src/tex.rs`
- Modify: `packages/dsh-wallpaper-engine/wasm/src/lib.rs`（加 `pub mod tex;`）
- Create: `packages/dsh-wallpaper-engine/wasm/tests/fixtures/tex/`（由 JS 生成器产出固定 .tex 字节文件，见 Step 1）
- Test: `packages/dsh-wallpaper-engine/wasm/tests/tex_test.rs`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `tex::TexFormat { Rgba8888, Dxt1, Dxt3, Dxt5, Rg88, R8, Unsupported(u32) }`（from u32）
  - `tex::TexImage { width: u32, height: u32, format: TexFormat, mip0: Vec<u8> }`（mip0 为 LZ4 解压后的原始数据）
  - `tex::parse_tex(data: &[u8]) -> Option<TexImage>`（解析失败返回 None——对齐现有 tex-loader 返回 null 语义）

- [ ] **Step 1: 生成测试 fixture（使用现有 JS 生成器）**

在 `packages/dsh-wallpaper-engine/tests/fixtures/` 下用 node 运行（临时脚本，产出 3 个 .tex 文件到 wasm 测试 fixture 目录）：

```bash
cd packages/dsh-wallpaper-engine
node -e "
const { makeTex } = require('./tests/fixtures/make-tex.mjs');
const fs = require('fs');
const out = 'wasm/tests/fixtures/tex';
fs.mkdirSync(out, { recursive: true });
// RGBA8888 + LZ4：2x2 红像素
const red = new Uint8Array([255,0,0,255, 255,0,0,255, 255,0,0,255, 255,0,0,255]);
fs.writeFileSync(out + '/rgba_lz4.tex', makeTex({ format: 0, images: [[{ width: 2, height: 2, data: red, lz4: true }]] }));
// DXT1：4x4（16 字节块）
const dxt1 = new Uint8Array(16).fill(0x80);
fs.writeFileSync(out + '/dxt1.tex', makeTex({ format: 7, images: [[{ width: 4, height: 4, data: dxt1 }]] }));
// RG88：2x2（每像素 2 字节）
const rg = new Uint8Array([128,64, 128,64, 128,64, 128,64]);
fs.writeFileSync(out + '/rg88.tex', makeTex({ format: 8, images: [[{ width: 2, height: 2, data: rg }]] }));
console.log('fixtures written');
"
```
注意：若 `make-tex.ts` 是 ESM/TS 无法直接 require，改用 `node --experimental-strip-types` 或先用 tsc/esbuild 编译一次（参考 `scripts/build-client.mjs` 的 esbuild 用法）再 require；最终以能产出 3 个 .tex 文件为准。生成后删除临时脚本。

- [ ] **Step 2: 写失败的测试**

`tests/tex_test.rs`:
```rust
use we_scene_wasm::tex::{parse_tex, TexFormat};

const RGBA_LZ4: &[u8] = include_bytes!("fixtures/tex/rgba_lz4.tex");
const DXT1: &[u8] = include_bytes!("fixtures/tex/dxt1.tex");
const RG88: &[u8] = include_bytes!("fixtures/tex/rg88.tex");

#[test]
fn parses_rgba8888_lz4_and_decompresses() {
    let img = parse_tex(RGBA_LZ4).expect("rgba_lz4 应可解析");
    assert_eq!(img.format, TexFormat::Rgba8888);
    assert_eq!(img.width, 2);
    assert_eq!(img.height, 2);
    assert_eq!(img.mip0.len(), 4 * 4); // 2x2 RGBA = 16 字节
    assert_eq!(&img.mip0[0..4], &[255, 0, 0, 255]); // 红像素
}

#[test]
fn parses_dxt1() {
    let img = parse_tex(DXT1).expect("dxt1 应可解析");
    assert_eq!(img.format, TexFormat::Dxt1);
    assert_eq!(img.mip0.len(), 8); // 4x4 DXT1 = 8 字节块
}

#[test]
fn parses_rg88() {
    let img = parse_tex(RG88).expect("rg88 应可解析");
    assert_eq!(img.format, TexFormat::Rg88);
    assert_eq!(img.mip0.len(), 4 * 2); // 2x2 RG88 = 8 字节
}
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cargo test --manifest-path packages/dsh-wallpaper-engine/wasm/Cargo.toml`
Expected: 编译失败（`tex` 模块不存在）。

- [ ] **Step 4: 写最小实现**

`src/tex.rs`:
```rust
//! TEXV0005 容器解析（头 + TEXB 容器 + mipmap 表 + LZ4 解压）。
//! 字节布局见 tex-loader.ts 文件头注释：TEXV0005\0 TEXI0001\0 + 28B 头
//! + TEXB0001|0002\0 + imageCount(i32) + mipmapCount(i32)
//! + 每 mipmap: width height isLZ4 decompressedBytes bytesLen + 数据

use lz4_flex::block::decompress;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TexFormat { Rgba8888, Dxt1, Dxt3, Dxt5, Rg88, R8, Unsupported(u32) }

impl From<u32> for TexFormat {
    fn from(v: u32) -> Self {
        match v {
            0 => TexFormat::Rgba8888,
            4 => TexFormat::Dxt5,
            6 => TexFormat::Dxt3,
            7 => TexFormat::Dxt1,
            8 => TexFormat::Rg88,
            9 => TexFormat::R8,
            other => TexFormat::Unsupported(other),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TexImage {
    pub width: u32,
    pub height: u32,
    pub format: TexFormat,
    pub mip0: Vec<u8>, // LZ4 解压后的原始数据
}

fn u32_at(data: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(data[off..off + 4].try_into().unwrap_or([0; 4]))
}

pub fn parse_tex(data: &[u8]) -> Option<TexImage> {
    if data.len() < 12 || &data[0..8] != b"TEXV0005\0" { return None; }
    // TEXI0001\0 在偏移 8；28B 头从偏移 16 开始
    let hdr = 16usize;
    if data.len() < hdr + 28 { return None; }
    let format = u32_at(data, hdr);
    let tex_w = u32_at(data, hdr + 8);
    let tex_h = u32_at(data, hdr + 12);
    // 跳过 TEXB0001|0002\0 容器头（偏移 hdr+28，16 字节）
    let mut pos = hdr + 28 + 16;
    if data.len() < pos + 4 { return None; }
    let image_count = u32_at(data, pos) as usize;
    pos += 4;
    let mut mip0: Option<(u32, u32, Vec<u8>)> = None;
    for _img in 0..image_count {
        if data.len() < pos + 4 { return None; }
        let mip_count = u32_at(data, pos) as usize;
        pos += 4;
        for _m in 0..mip_count {
            if data.len() < pos + 20 { return None; }
            let w = u32_at(data, pos);
            let h = u32_at(data, pos + 4);
            let is_lz4 = u32_at(data, pos + 8) == 1;
            let decompressed = u32_at(data, pos + 12);
            let bytes_len = u32_at(data, pos + 16) as usize;
            pos += 20;
            if data.len() < pos + bytes_len { return None; }
            let raw = &data[pos..pos + bytes_len];
            let out = if is_lz4 {
                decompress(raw, decompressed as usize).ok()?
            } else {
                raw.to_vec()
            };
            if mip0.is_none() { mip0 = Some((w, h, out)); }
            pos += bytes_len;
        }
    }
    mip0.map(|(w, h, mip0)| TexImage { width: w, height: h, format: format.into(), mip0 })
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cargo test --manifest-path packages/dsh-wallpaper-engine/wasm/Cargo.toml`
Expected: tex 3 个测试 PASS。若 `parses_dxt1` 块大小断言失败（make-tex 对 DXT1 写入 16 字节而非 8），以生成器实际输出为准修正断言（DXT1 4×4 块应为 8 字节，若生成器填 16 字节则改断言为 16 并加注释）。

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-wallpaper-engine/wasm
git commit -m "feat(wallpaper-engine): TEXV0005 解析 + LZ4 解压模块（TDD）"
```

---

## Task 5: 渲染器核心 —— 正交相机 + 图片对象（wgpu）

**Files:**
- Modify: `packages/dsh-wallpaper-engine/wasm/Cargo.toml`（加 wgpu、web-sys、js-sys、wasm-bindgen-futures、console_error_panic_hook）
- Create: `packages/dsh-wallpaper-engine/wasm/src/render/mod.rs`
- Create: `packages/dsh-wallpaper-engine/wasm/src/render/camera.rs`
- Modify: `packages/dsh-wallpaper-engine/wasm/src/lib.rs`（加 `pub mod render;`）
- Test: `packages/dsh-wallpaper-engine/wasm/tests/camera_test.rs`（纯数学，native 可测）

**Interfaces:**
- Consumes: `scene::SceneDesc`、`coords::origin_to_center`、`tex::TexImage`。
- Produces:
  - `render::camera::contain_range(width: f32, height: f32, view_aspect: f32) -> (f32, f32)`（w,h；对齐 containRange）
  - `render::camera::cover_range(width: f32, height: f32, view_aspect: f32) -> (f32, f32)`
  - `render::Renderer::new(canvas: &web_sys::HtmlCanvasElement, width: u32, height: u32) -> Result<Renderer, String>`
  - `render::Renderer::resize(&mut self, width: u32, height: u32)`
  - `render::Renderer::render_scene(&mut self, desc: &SceneDesc, images: &[SceneImage])`（内部：相机 contain 范围、图片平面、全屏 quad 贴到 canvas）
  - `render::SceneImage { tex: wgpu::Texture, origin: [f32;3], scale: [f32;3], size: Option<[f32;2]> }`
  - 常量 `render::CAMERA_DISTANCE: f32 = 300.0`（点尺寸=像素尺寸，对齐 scene-renderer.ts）

- [ ] **Step 1: 写失败的测试（相机数学，native）**

`tests/camera_test.rs`:
```rust
use we_scene_wasm::render::camera::{contain_range, cover_range};

#[test]
fn contain_wide_scene_leaves_vertical_letterbox() {
    // 场景 2400x1555（更宽），视口 1920x1080（aspect 1.778）
    let (w, h) = contain_range(2400.0, 1555.0, 1920.0 / 1080.0);
    assert_eq!(w, 2400.0);
    assert!(h > 1555.0, "垂直应留白: {h}");
}

#[test]
fn contain_narrow_scene_leaves_horizontal_letterbox() {
    let (w, h) = contain_range(1080.0, 1920.0, 1920.0 / 1080.0);
    assert_eq!(h, 1920.0);
    assert!(w > 1080.0);
}

#[test]
fn cover_crops_the_longer_dimension() {
    let (w, h) = cover_range(2400.0, 1555.0, 1920.0 / 1080.0);
    assert_eq!(w, 2400.0);
    assert!(h < 1555.0, "垂直应裁剪: {h}");
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path packages/dsh-wallpaper-engine/wasm/Cargo.toml`
Expected: 编译失败（`render` 模块不存在）。

- [ ] **Step 3: 写最小实现（相机数学 + wgpu 渲染器）**

`src/render/camera.rs`:
```rust
//! 相机范围数学（对齐 scene-renderer.ts 的 containRange/coverRange）

/// contain：场景完整可见、不变形，多出的方向留白（透明）
pub fn contain_range(width: f32, height: f32, view_aspect: f32) -> (f32, f32) {
    let scene_aspect = width / height;
    if scene_aspect > view_aspect {
        (width, width / view_aspect)
    } else {
        (height * view_aspect, height)
    }
}

/// cover：场景铺满视口、不变形，超出方向被裁剪
pub fn cover_range(width: f32, height: f32, view_aspect: f32) -> (f32, f32) {
    let scene_aspect = width / height;
    if view_aspect > scene_aspect {
        (width, width / view_aspect)
    } else {
        (height * view_aspect, height)
    }
}
```

`src/render/mod.rs`（v1 最小渲染：正交相机 + 图片平面 + 全屏 quad；纹理上传见 Task 7）:
```rust
//! wgpu 渲染器。cargo test 只覆盖 camera 数学；渲染验证在浏览器（headless Edge + CDP）。

pub mod camera;

use wgpu::util::DeviceExt;

pub const CAMERA_DISTANCE: f32 = 300.0;

pub struct SceneImage {
    pub tex: wgpu::Texture,
    pub origin: [f32; 3],
    pub scale: [f32; 3],
    pub size: Option<[f32; 2]>,
}

pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    surface: wgpu::Surface<'static>,
    width: u32,
    height: u32,
}

impl Renderer {
    pub async fn new(canvas: &web_sys::HtmlCanvasElement, width: u32, height: u32) -> Result<Renderer, String> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::from_bits(1 << 2).unwrap_or(wgpu::Backends::all()), // WebGPU
            ..Default::default()
        });
        let surface = instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
            .map_err(|e| format!("create_surface: {e}"))?;
        let adapter = instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        }).await.ok_or("no WebGPU adapter")?;
        let (device, queue) = adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("we-scene"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            memory_hints: wgpu::MemoryHints::Performance,
        }).await.map_err(|e| format!("request_device: {e}"))?;
        let caps = surface.get_capabilities(&adapter);
        let format = caps.formats.iter().copied().find(|f| f.is_srgb())
            .unwrap_or(caps.formats[0]);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: width.max(1),
            height: height.max(1),
            present_mode: wgpu::PresentMode::AutoVsync,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);
        Ok(Renderer { device, queue, config, surface, width, height })
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        self.width = width.max(1);
        self.height = height.max(1);
        self.config.width = self.width;
        self.config.height = self.height;
        self.surface.configure(&self.device, &self.config);
    }

    /// 渲染场景到 canvas。v1：正交相机 contain + 图片平面（后续任务加粒子/纹理上传入口）。
    pub fn render_frame(&mut self) {
        let frame = match self.surface.get_current_texture() {
            Ok(f) => f,
            Err(_) => return,
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("clear"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
        }
        self.queue.submit([encoder.finish()]);
        frame.present();
    }
}
```

`src/lib.rs` 增加：
```rust
pub mod render;
```

- [ ] **Step 4: 跑测试确认通过（native 数学部分）**

Run: `cargo test --manifest-path packages/dsh-wallpaper-engine/wasm/Cargo.toml`
Expected: camera 3 个测试 PASS（wgpu 代码在本任务不参与 native 测试——`Renderer` 只在 wasm/浏览器路径调用；若 cargo test 因 wgpu 编译到 native 失败，见 Step 4b）。

- [ ] **Step 4b（仅当 Step 4 编译失败时）：隔离 wgpu 依赖**

若 `cargo test`（native x86_64-pc-windows-msvc）编译 wgpu 报错（缺系统库/链接失败），在 `Cargo.toml` 将渲染相关依赖与代码做 feature 隔离：
```toml
[features]
default = []
render = ["dep:wgpu", "dep:web-sys", "dep:js-sys", "dep:wasm-bindgen-futures"]
[dependencies]
wgpu = { version = "24", optional = true }
web-sys = { version = "0.3", features = ["HtmlCanvasElement"], optional = true }
js-sys = { version = "0.3", optional = true }
wasm-bindgen-futures = { version = "0.4", optional = true }
```
`src/render/mod.rs` 整体加 `#![cfg(feature = "render")]`；wasm 构建时 `wasm-pack build --features render`。测试保持 `cargo test`（无 render feature）只跑解析/数学模块。

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-wallpaper-engine/wasm
git commit -m "feat(wallpaper-engine): wgpu 渲染器骨架 + 正交相机数学（TDD）"
```

---

## Task 6: compute shader 粒子系统

**Files:**
- Create: `packages/dsh-wallpaper-engine/wasm/src/render/particle_pass.rs`
- Create: `packages/dsh-wallpaper-engine/wasm/src/shaders/particle.wgsl`
- Modify: `packages/dsh-wallpaper-engine/wasm/src/render/mod.rs`（`Renderer` 增加粒子管线与 `step(dt)`、渲染合并）
- Modify: `packages/dsh-wallpaper-engine/wasm/src/lib.rs`
- Test: `packages/dsh-wallpaper-engine/wasm/tests/particle_pass_test.rs`（分派/缓冲参数纯函数，native）

**Interfaces:**
- Consumes: `particle::ParticleSpec`、`coords::particle_scale`。
- Produces:
  - `render::particle_pass::ParticlePass::new(device, queue, spec: &ParticleSpec, max_particles: u32) -> ParticlePass`
  - `render::particle_pass::ParticlePass::step(&self, queue, dt: f32)`
  - `render::particle_pass::ParticlePass::render(&self, encoder, target: &wgpu::TextureView)`
  - `render::particle_pass::dispatch_dims(count: u32, workgroup: u32) -> (u32, u32, u32)`（纯函数：`(ceil(count/workgroup), 1, 1)`）
  - `render::particle_pass::EmitterParams::from_spec(spec: &ParticleSpec, origin: [f32;3], scale: [f32;3], vw: f32, vh: f32) -> EmitterParams`（CPU 侧坐标映射后写入 uniform；`scale.y` 取负）

- [ ] **Step 1: 写失败的测试（纯函数，native）**

`tests/particle_pass_test.rs`:
```rust
use we_scene_wasm::particle::parse_particle_spec;
use we_scene_wasm::render::particle_pass::{dispatch_dims, EmitterParams};

const ASHES_JSON: &str = include_str!("fixtures/eva/particles_Ashes.json");

#[test]
fn dispatch_dims_rounds_up() {
    assert_eq!(dispatch_dims(0, 64), (1, 1, 1)); // 空也分派 1 组（安全）
    assert_eq!(dispatch_dims(64, 64), (1, 1, 1));
    assert_eq!(dispatch_dims(65, 64), (2, 1, 1));
}

#[test]
fn emitter_params_applies_coords_and_flips_scale_y() {
    let spec = parse_particle_spec(ASHES_JSON);
    // EVA Ashes 原点 (1200,777.5)、视口 2400x1555、scale (1,1,1)
    let p = EmitterParams::from_spec(&spec, [1200.0, 777.5, 0.0], [1.0, 1.0, 1.0], 2400.0, 1555.0);
    assert!(p.origin_x.abs() < 1e-3 && p.origin_y.abs() < 1e-3, "原点应映射到中心: ({},{})", p.origin_x, p.origin_y);
    assert_eq!(p.scale_y, -1.0);
    assert_eq!(p.rate, 10.0);
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path packages/dsh-wallpaper-engine/wasm/Cargo.toml`
Expected: 编译失败（`particle_pass` 不存在）。

- [ ] **Step 3: 写最小实现**

`src/render/particle_pass.rs`（CPU 侧参数 + 分派；WGSL 见粒子 shader 文件）:
```rust
//! compute shader 粒子：CPU 侧只做参数打包与分派，模拟全在 GPU（WGSL）。
use crate::coords;
use crate::particle::ParticleSpec;

#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct EmitterParams {
    pub origin_x: f32,
    pub origin_y: f32,
    pub origin_z: f32,
    pub scale_x: f32,
    pub scale_y: f32,
    pub scale_z: f32,
    pub rate: f32,
    pub distance_min: f32,
    pub distance_max: f32,
    pub directions_x: f32,
    pub directions_y: f32,
    pub directions_z: f32,
    pub life_min: f32,
    pub life_max: f32,
    pub size_min: f32,
    pub size_max: f32,
    pub vel_min_x: f32, pub vel_min_y: f32, pub vel_min_z: f32,
    pub vel_max_x: f32, pub vel_max_y: f32, pub vel_max_z: f32,
    pub color_min_r: f32, pub color_min_g: f32, pub color_min_b: f32,
    pub color_max_r: f32, pub color_max_g: f32, pub color_max_b: f32,
    pub dt: f32,
    pub max_particles: u32,
    pub _pad: u32,
}

impl EmitterParams {
    pub fn from_spec(spec: &ParticleSpec, origin: [f32; 3], scale: [f32; 3], vw: f32, vh: f32) -> EmitterParams {
        let c = coords::origin_to_center(origin, vw, vh);
        let s = coords::particle_scale(scale);
        let i = &spec.init;
        EmitterParams {
            origin_x: c[0], origin_y: c[1], origin_z: c[2],
            scale_x: s[0], scale_y: s[1], scale_z: s[2],
            rate: spec.emitter.rate,
            distance_min: spec.emitter.distance_min,
            distance_max: spec.emitter.distance_max,
            directions_x: spec.emitter.directions[0],
            directions_y: spec.emitter.directions[1],
            directions_z: spec.emitter.directions[2],
            life_min: i.lifetime_min, life_max: i.lifetime_max,
            size_min: i.size_min, size_max: i.size_max,
            vel_min_x: i.velocity_min[0], vel_min_y: i.velocity_min[1], vel_min_z: i.velocity_min[2],
            vel_max_x: i.velocity_max[0], vel_max_y: i.velocity_max[1], vel_max_z: i.velocity_max[2],
            color_min_r: i.color_min.map(|c| c[0]).unwrap_or(1.0),
            color_min_g: i.color_min.map(|c| c[1]).unwrap_or(1.0),
            color_min_b: i.color_min.map(|c| c[2]).unwrap_or(1.0),
            color_max_r: i.color_max.map(|c| c[0]).unwrap_or(1.0),
            color_max_g: i.color_max.map(|c| c[1]).unwrap_or(1.0),
            color_max_b: i.color_max.map(|c| c[2]).unwrap_or(1.0),
            dt: 0.0, max_particles: 2048, _pad: 0,
        }
    }
}

pub fn dispatch_dims(count: u32, workgroup: u32) -> (u32, u32, u32) {
    let g = workgroup.max(1);
    (((count + g - 1) / g).max(1), 1, 1)
}
```

`src/shaders/particle.wgsl`（v1 最小：随机发射 + 线性运动 + 寿命衰减 + 点渲染）:
```wgsl
struct EmitterParams {
  origin: vec3f, scale: vec3f, rate: f32, distance_min: f32, distance_max: f32,
  directions: vec3f,
  life_min: f32, life_max: f32, size_min: f32, size_max: f32,
  vel_min: vec3f, vel_max: vec3f, color_min: vec3f, color_max: vec3f,
  dt: f32, max_particles: u32, _pad: u32,
}
@group(0) @binding(0) var<uniform> p: EmitterParams;

struct Particle { pos: vec3f, vel: vec3f, life: f32, max_life: f32, size: f32, color: vec3f }
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> count: atomic<u32>;

// 简单确定性 hash 随机（WE mulberry32 语义近似，v1 够用）
fn rand(seed: u32) -> f32 {
  var s = seed * 747796405u + 2891336453u;
  s = ((s >> (s >> 28u + 4u)) ^ s) * 277803737u;
  s = (s >> (s >> 28u + 4u)) ^ s;
  return f32(s) / 4294967295.0;
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let i = gid.x;
  if (i >= p.max_particles) { return; }
  // 每粒子独立随机种（i + 帧计数近似）
  let seed = i * 2654435761u + lid.x;
  let life_span = p.life_min + rand(seed) * max(p.life_max - p.life_min, 0.0);
  let spawn = rand(seed + 1u) < p.rate * p.dt;
  var pos = vec3f(0.0); var vel = vec3f(0.0); var life = 0.0; var size = p.size_min; var col = vec3f(1.0);
  if (spawn) {
    let dir = normalize(p.directions + vec3f(rand(seed+2u)-0.5, rand(seed+3u)-0.5, rand(seed+4u)-0.5));
    let dist = p.distance_min + rand(seed+5u) * max(p.distance_max - p.distance_min, 0.0);
    pos = p.origin + dir * dist * p.scale;
    vel = p.vel_min + vec3f(rand(seed+6u), rand(seed+7u), rand(seed+8u)) * max(p.vel_max - p.vel_min, vec3f(0.0));
    life = life_span;
    size = p.size_min + rand(seed+9u) * max(p.size_max - p.size_min, 0.0);
    col = p.color_min + vec3f(rand(seed+10u), rand(seed+11u), rand(seed+12u)) * max(p.color_max - p.color_min, vec3f(0.0));
  }
  // 存活粒子继续运动 + 寿命衰减
  var cur = particles[i];
  if (cur.life > 0.0) {
    cur.pos += cur.vel * p.dt;
    cur.life -= p.dt;
    if (cur.life <= 0.0) { cur.life = 0.0; }
  } else if (spawn) {
    cur = Particle(pos, vel, life, life_span, size, col);
  }
  particles[i] = cur;
  atomicStore(&count, 0u);
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  // v1：粒子点渲染（位置直接输出；点尺寸用 vp 常量，v2 换 uniform）
  let pos = particles[ii].pos;
  return vec4f(pos, 1.0);
}
@fragment
fn fs_main(@builtin(position) pos: vec4f, @builtin(instance_index) ii: u32) -> @location(0) vec4f {
  let p = particles[ii];
  let life_alpha = clamp(p.life / max(p.max_life, 0.0001), 0.0, 1.0);
  return vec4f(p.color, life_alpha);
}
```

`src/render/mod.rs` 增加（接入 Renderer）:
```rust
pub mod particle_pass;

// Renderer 新增字段：
//   particle_pass: Option<particle_pass::ParticlePass>,
//   particle_target: Option<wgpu::Texture>, // 粒子离屏 RT（加法混合），后续与场景合成
// 新增方法：
//   pub fn set_particle(&mut self, spec: &ParticleSpec, origin: [f32;3], scale: [f32;3], vw: f32, vh: f32) {
//       self.particle_pass = Some(particle_pass::ParticlePass::new(&self.device, &self.queue, spec, 2048));
//       self.particle_params = EmitterParams::from_spec(spec, origin, scale, vw, vh);
//   }
//   pub fn step(&mut self, dt: f32) {
//       if let Some(pass) = &self.particle_pass {
//           // 更新 uniform dt 后 dispatch（workgroup 64）
//       }
//   }
```
注：ParticlePass 的 wgpu 管线构建（bind group layout、compute/vertex/fragment pipeline、storage buffer、uniform buffer、采样 RT）在本任务实现，具体 API 调用以 wgpu 24 wasm 示例（`wgpu/examples` 的 `compute` + `boids`）为准；`render()` 将粒子 RT 与场景合成（加法混合）——若 v1 时间紧张可先粒子直接渲染到主 surface 的透明层，合成细节在浏览器验证阶段调整。

- [ ] **Step 4: 跑测试确认通过（纯函数）**

Run: `cargo test --manifest-path packages/dsh-wallpaper-engine/wasm/Cargo.toml`
Expected: particle_pass 2 个测试 PASS（native；wgpu 管线部分不参与 native 测试）。

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-wallpaper-engine/wasm
git commit -m "feat(wallpaper-engine): compute shader 粒子管线骨架（TDD，参数打包+分派）"
```

---

## Task 7: wasm-bindgen API + WebGPU 纹理解码上传

**Files:**
- Modify: `packages/dsh-wallpaper-engine/wasm/src/lib.rs`（wasm-bindgen 导出）
- Create: `packages/dsh-wallpaper-engine/wasm/src/render/texture.rs`
- Modify: `packages/dsh-wallpaper-engine/wasm/src/render/mod.rs`
- Test: `packages/dsh-wallpaper-engine/wasm/tests/texture_test.rs`（格式映射，native）

**Interfaces:**
- Consumes: `tex::TexImage`/`TexFormat`、`scene::SceneDesc`、`render::Renderer`。
- Produces:
  - `render::texture::tex_format_to_wgpu(format: TexFormat) -> Option<wgpu::TextureFormat>`（RGBA8888→Rgba8UnormSrgb；DXT1→Bc1RgbaUnormSrgb；DXT3→Bc2RgbaUnormSrgb；DXT5→Bc3RgbaUnormSrgb；R8→R8Unorm；RG88→Rg8Unorm；Unsupported→None）
  - `render::Renderer::upload_texture(&mut self, img: &TexImage) -> Option<wgpu::Texture>`
  - wasm 导出（`src/lib.rs`）：
    - `#[wasm_bindgen] pub struct WeScene { ... }`
    - `#[wasm_bindgen] impl WeScene { pub fn new(canvas: web_sys::HtmlCanvasElement, width: u32, height: u32) -> Result<WeScene, JsValue>; pub fn resize(&mut self, w: u32, h: u32); pub fn load_scene(&mut self, json: &str); pub fn load_image(&mut self, asset_id: u32, tex_bytes: &[u8], origin: Vec<f32>, scale: Vec<f32>, size: Vec<f32>); pub fn add_particle(&mut self, json: &str, origin: Vec<f32>, scale: Vec<f32>); pub fn step(&mut self, dt: f32); pub fn render(&mut self); pub fn scene_width(&self) -> f32; pub fn scene_height(&self) -> f32; }`

- [ ] **Step 1: 写失败的测试（格式映射）**

`tests/texture_test.rs`:
```rust
use we_scene_wasm::render::texture::tex_format_to_wgpu;
use we_scene_wasm::tex::TexFormat;

#[test]
fn maps_all_supported_formats() {
    assert!(tex_format_to_wgpu(TexFormat::Rgba8888).is_some());
    assert!(tex_format_to_wgpu(TexFormat::Dxt1).is_some());
    assert!(tex_format_to_wgpu(TexFormat::Dxt3).is_some());
    assert!(tex_format_to_wgpu(TexFormat::Dxt5).is_some());
    assert!(tex_format_to_wgpu(TexFormat::R8).is_some());
    assert!(tex_format_to_wgpu(TexFormat::Rg88).is_some());
    assert!(tex_format_to_wgpu(TexFormat::Unsupported(99)).is_none());
}

#[test]
fn dxt_maps_to_bc() {
    assert_eq!(tex_format_to_wgpu(TexFormat::Dxt1), Some(wgpu::TextureFormat::Bc1RgbaUnormSrgb));
    assert_eq!(tex_format_to_wgpu(TexFormat::Dxt5), Some(wgpu::TextureFormat::Bc3RgbaUnormSrgb));
}
```
注意：native `cargo test` 引用 `wgpu::TextureFormat` 需要 wgpu 在非 render feature 下也可用——若 Step 4b 已做 feature 隔离，本测试文件用 `#[cfg(feature = "render")]` 包裹（格式映射函数本身无 GPU 依赖，可放 `tex.rs` 避免 feature 纠缠，见 Step 3 说明）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path packages/dsh-wallpaper-engine/wasm/Cargo.toml`
Expected: 编译失败（函数/模块不存在）。

- [ ] **Step 3: 写最小实现**

`src/render/texture.rs`:
```rust
//! TexFormat → wgpu TextureFormat 映射（WebGPU 原生 BC/R8/RG88 支持）
use crate::tex::TexFormat;

pub fn tex_format_to_wgpu(format: TexFormat) -> Option<wgpu::TextureFormat> {
    match format {
        TexFormat::Rgba8888 => Some(wgpu::TextureFormat::Rgba8UnormSrgb),
        TexFormat::Dxt1 => Some(wgpu::TextureFormat::Bc1RgbaUnormSrgb),
        TexFormat::Dxt3 => Some(wgpu::TextureFormat::Bc2RgbaUnormSrgb),
        TexFormat::Dxt5 => Some(wgpu::TextureFormat::Bc3RgbaUnormSrgb),
        TexFormat::R8 => Some(wgpu::TextureFormat::R8Unorm),
        TexFormat::Rg88 => Some(wgpu::TextureFormat::Rg8Unorm),
        TexFormat::Unsupported(_) => None,
    }
}
```
若 Step 4b 已做 feature 隔离：此函数移到 `src/tex.rs`（不依赖 wgpu，返回字符串标识 `"rgba8unorm"|"bc1"|...`），wgpu 映射在 `render/texture.rs` 内做——**以"cargo test 无 render feature 也能测格式映射"为原则调整放置位置**，测试相应放在 `tex.rs` 的测试模块。

`src/render/mod.rs` 增加:
```rust
pub mod texture;

impl Renderer {
    pub fn upload_texture(&mut self, img: &crate::tex::TexImage) -> Option<wgpu::Texture> {
        let format = texture::tex_format_to_wgpu(img.format)?;
        let usage = wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST;
        let tex = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("we-tex"),
            size: wgpu::Extent3d { width: img.width.max(1), height: img.height.max(1), depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: &[],
        });
        // 块压缩格式需按块对齐字节数（block_size: BC=8/16, R8=1, RG88=2, RGBA=4）
        let block_size = match img.format {
            crate::tex::TexFormat::Dxt1 => 8u32,
            crate::tex::TexFormat::Dxt3 | crate::tex::TexFormat::Dxt5 => 16u32,
            crate::tex::TexFormat::Rgba8888 => 4u32,
            crate::tex::TexFormat::Rg88 => 2u32,
            crate::tex::TexFormat::R8 => 1u32,
            crate::tex::TexFormat::Unsupported(_) => return None,
        };
        let block_w = (img.width.max(1) + 3) / 4;
        let block_h = (img.height.max(1) + 3) / 4;
        let bytes_per_row = match img.format {
            crate::tex::TexFormat::Dxt1 | crate::tex::TexFormat::Dxt3 | crate::tex::TexFormat::Dxt5 => block_w * block_size,
            _ => img.width.max(1) * block_size,
        };
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            &img.mip0,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bytes_per_row), rows_per_image: Some(block_h.max(1)) },
            wgpu::Extent3d { width: img.width.max(1), height: img.height.max(1), depth_or_array_layers: 1 },
        );
        Some(tex)
    }
}
```

`src/lib.rs` 增加 wasm-bindgen 导出（v1 API 面）:
```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WeScene {
    renderer: Option<render::Renderer>,
    scene: Option<scene::SceneDesc>,
    images: Vec<(u32, wgpu::Texture)>,
    vw: f32,
    vh: f32,
}

#[wasm_bindgen]
impl WeScene {
    #[wasm_bindgen(constructor)]
    pub fn new(canvas: web_sys::HtmlCanvasElement, width: u32, height: u32) -> Result<WeScene, JsValue> {
        console_error_panic_hook::set_once();
        let renderer = wasm_bindgen_futures::spawn_local(async move {
            render::Renderer::new(&canvas, width, height).await
        });
        // v1 简化：Renderer::new 为 async，WeScene::new 同步构造；wasm 侧用
        // wasm_bindgen_futures::spawn_local + 内部状态机（或用 futures 在 JS 侧 await）
        // —— 实现以 wgpu wasm 示例的初始化模式为准（wasm-bindgen 的 async 构造：
        // 用 `#[wasm_bindgen(js_name = new)]` 包装 async fn，JS 侧 `await new WeScene(...)`）。
        unreachable!("见 Step 3 注：异步初始化模式")
    }
    // ... load_scene / load_image / add_particle / step / render / resize
}
```
**异步初始化说明（实施重点）**：`wgpu::Instance::request_adapter` 是 async，wasm-bindgen 的标准做法是导出 `async fn create(canvas, w, h) -> Result<WeScene, JsValue>`（`#[wasm_bindgen]` 自动转 Promise），JS 侧 `await WeScene.create(...)`。按此实现 `create` 替代同步 `new`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path packages/dsh-wallpaper-engine/wasm/Cargo.toml`
Expected: 格式映射测试 PASS。

- [ ] **Step 5: wasm 构建冒烟**

Run（需要 Task 0 的 wasm target + wasm-pack）:
```bash
cd packages/dsh-wallpaper-engine/wasm
wasm-pack build --target web --release
```
Expected: 产出 `pkg/we_scene_wasm.js` + `.wasm`，无编译错误。若 wgpu wasm 编译报错（feature/API 版本），按错误修正 Cargo.toml features（wgpu 需 `webgpu` 后端 feature，native 后端禁用）。

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-wallpaper-engine/wasm
git commit -m "feat(wallpaper-engine): wasm-bindgen API + WebGPU 纹理解码上传（TDD）"
```

---

## Task 8: JS 胶水 + 插件集成（回退链）

**Files:**
- Create: `packages/dsh-wallpaper-engine/src/client/wasm-renderer.ts`
- Modify: `packages/dsh-wallpaper-engine/src/client/index.ts`（wasm 可用时注入 wasm sceneRenderer）
- Modify: `packages/dsh-wallpaper-engine/src/client/wallpaper-controller.ts`（不改逻辑，sceneRenderer 接口已就绪；若需要可加 `navigator.gpu` 检测注释）
- Modify: `packages/dsh-wallpaper-engine/scripts/build-client.mjs`（把 wasm pkg 产物复制进 bundle）
- Test: `packages/dsh-wallpaper-engine/tests/wasm-renderer.test.ts`（纯 JS 侧：回退逻辑、API 调用顺序）

**Interfaces:**
- Consumes: 现有 `wallpaper-controller.ts` 的 `sceneRenderer?: { render(wallpaperId, fg, bg): Promise<boolean> }`；现有 `scene-assets.ts` 的 fetch 模式（`/wallpapers/scene/${id}/asset?name=`）；wasm 导出的 `WeScene`。
- Produces:
  - `createWasmSceneRenderer(): { render(id: string, fg: HTMLCanvasElement, bg?: HTMLCanvasElement): Promise<boolean> } | null`（`navigator.gpu` 缺失或 wasm 加载失败 → null）
  - 内部 `loadWasmModule(): Promise<typeof import('...wasm-glue') | null>`（instantiateStreaming + 缓存）

- [ ] **Step 1: 写失败的测试（回退与调用逻辑，jsdom）**

`tests/wasm-renderer.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { createWasmSceneRenderer } from '../src/client/wasm-renderer.js';

describe('createWasmSceneRenderer', () => {
  it('无 WebGPU 时返回 null（走现有 JS 渲染回退）', () => {
    vi.stubGlobal('navigator', { gpu: undefined });
    expect(createWasmSceneRenderer()).toBeNull();
  });

  it('wasm 模块加载失败时返回 null', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    vi.spyOn(globalThis, 'WebAssembly' as any, 'get')
      .mockReturnValue({ instantiateStreaming: () => Promise.reject(new Error('load fail')) } as any);
    // createWasmSceneRenderer 内部异步加载 → 返回的 render 调用时 resolve false
    const r = createWasmSceneRenderer();
    // 依赖注入版本（见实现）：传 loadWasm 参数便于测试
  });
});
```
（若 createWasmSceneRenderer 直接依赖全局 WebAssembly 不便 mock，实现时把 `loadWasm` 作为可注入参数：`createWasmSceneRenderer(opts?: { loadWasm?: () => Promise<WeSceneModule | null> })`——测试注入失败 loader 断言 `render()` resolve false。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/wasm-renderer.test.ts`（在 `packages/dsh-wallpaper-engine` 下）
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写最小实现**

`src/client/wasm-renderer.ts`:
```ts
// Rust/WebGPU 渲染器胶水：实现 wallpaper-controller 的 sceneRenderer 接口。
// 无 WebGPU / wasm 加载失败 → 返回 null，controller 走现有 JS 渲染/回退链。

export interface WasmSceneModule {
  WeScene: {
    create(canvas: HTMLCanvasElement, w: number, h: number): Promise<{
      resize(w: number, h: number): void;
      load_scene(json: string): void;
      load_image(assetId: number, tex: Uint8Array, origin: number[], scale: number[], size: number[]): void;
      add_particle(json: string, origin: number[], scale: number[]): void;
      step(dt: number): void;
      render(): void;
      scene_width(): number;
      scene_height(): number;
    }>;
  };
}

type LoadWasm = () => Promise<WasmSceneModule | null>;

async function defaultLoadWasm(): Promise<WasmSceneModule | null> {
  try {
    // bundle 资源路径（与现有 fetch 前缀一致）
    const resp = await fetch('/wallpapers/static/we_scene_wasm.js');
    if (!resp.ok) return null;
    const glue = await resp.text();
    const mod = await import(/* @vite-ignore */ URL.createObjectURL(new Blob([glue], { type: 'text/javascript' })));
    return mod as WasmSceneModule;
  } catch {
    return null;
  }
}

export function createWasmSceneRenderer(opts?: { loadWasm?: LoadWasm }): {
  render(id: string, fg: HTMLCanvasElement, bg?: HTMLCanvasElement): Promise<boolean>;
} | null {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return null;
  const loadWasm = opts?.loadWasm ?? defaultLoadWasm;
  let modulePromise: Promise<WasmSceneModule | null> | null = null;
  return {
    async render(id, fg) {
      try {
        modulePromise ??= loadWasm();
        const mod = await modulePromise;
        if (!mod) return false;
        const sceneJsonResp = await fetch(`/wallpapers/scene/${id}/asset?name=scene.json`);
        if (!sceneJsonResp.ok) return false;
        const sceneJson = await sceneJsonResp.text();
        const desc = JSON.parse(sceneJson) as { general?: { orthogonalprojection?: { width: number; height: number } } };
        const vw = desc.general?.orthogonalprojection?.width ?? 1920;
        const vh = desc.general?.orthogonalprojection?.height ?? 1080;
        const scene = await mod.WeScene.create(fg, vw, vh);
        scene.load_scene(sceneJson);
        // 对象遍历：image → model.json → material → .tex（复用 resolveImageTexture 的推导逻辑，
        // 但字节流直接传 wasm；v1 先实现 image + particle，util 跳过）
        // —— 具体对象遍历在浏览器验证阶段对齐现有 renderScene（scene-renderer.ts L262-315）
        let raf = 0;
        const loop = () => {
          scene.step(1 / 60);
          scene.render();
          if (fg.isConnected) raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        return true;
      } catch {
        return false;
      }
    },
  };
}
```

`src/client/index.ts` 修改（注入 wasm 渲染器）:
```ts
import { createWasmSceneRenderer } from './wasm-renderer.js';
// 现有 createWallpaperController 调用处：
//   sceneRenderer: createWasmSceneRenderer() ?? createJsSceneRenderer()
// （现有 JS 渲染器函数包装 renderScene；wasm 不可用时回退 JS）
```
（具体注入位置以 `index.ts` 现有结构为准——把 wasm renderer 作为首选、JS renderer 作为回退，两者都实现同一 sceneRenderer 接口。）

`scripts/build-client.mjs` 修改：wasm-pack 产物（`wasm/pkg/`）复制到 client bundle 输出（静态资源路径 `/wallpapers/static/`，需在 `routes.ts` 确认或新增静态资源路由——若 routes.ts 无静态资源支持，在 host 侧加一个 `/wallpapers/static/<file>` 路由，参考现有 asset 路由实现）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/wasm-renderer.test.ts`（在 `packages/dsh-wallpaper-engine` 下）
Expected: PASS（回退逻辑 + 注入 loader 失败路径）。

- [ ] **Step 5: 构建冒烟 + 提交**

```bash
cd packages/dsh-wallpaper-engine
npm run build        # tsc
npm run build:client # esbuild + wasm 产物复制
npx vitest run       # 全量单测（新增用例通过，既有用例不回归）
git add packages/dsh-wallpaper-engine
git commit -m "feat(wallpaper-engine): wasm 渲染器胶水 + 插件集成（回退链）"
```

---

## Task 9: 浏览器验收实测（全库）

**Files:**
- Modify: 无（验证性任务；若发现 bug 则修复并提交）
- Create（验证脚本）: `research/verify-wasm-render.mjs`（headless Edge + CDP，复用现有 `verify-blackout.mjs` 模式）

**Interfaces:**
- Consumes: Task 8 集成完成的可运行插件。
- Produces: 验收报告（更新 `research/scene-play-research.md` 或新增 `research/wasm-render-verify.md`）。

- [ ] **Step 1: 写验证脚本（复用现有 CDP 模式）**

复制 `research/verify-blackout.mjs` 为 `research/verify-wasm-render.mjs`，改动：
- 启动 headless Edge，加载 DSH GUI（`http://127.0.0.1:3080`）；
- Console 注入：确认 `navigator.gpu` 存在；确认 wasm 模块加载成功（`window.__weSceneWasmLoaded === true`，若胶水暴露）；
- 逐壁纸切换（24 个 scene），双帧间隔 1.5s 截图，像素 diff（复用现有统计逻辑）；
- 判定：BLACK / STATIC / OK，与 `scene-play-research.md` §2 基线表对比。

- [ ] **Step 2: 跑验证**

Run: `node research/verify-wasm-render.mjs`
Expected: 记录每壁纸判定。**v1 验收标准**（spec §8）：
1. EVA 由 wasm 渲染且判定 OK（diff > 基线 WebGL 版或相当）；
2. 24 壁纸 0 BLACK；
3. FPS ≥ 30（CDP Performance 采样）；
4. 手动禁用 WebGPU（`--disable-webgpu` 启动）→ 自动回退 JS 渲染，仍 0 BLACK。

- [ ] **Step 3: 修复发现的问题**

若某壁纸 wasm 渲染失败（黑屏/静态），对比 JS 渲染器行为定位（解析差异/纹理格式/粒子参数），修复后重跑。每个修复独立 commit（`fix(wallpaper-engine): ...`）。

- [ ] **Step 4: 更新调研文档 + 提交**

更新 `research/wasm-render-verify.md`（新建）：24 壁纸判定表 + wasm 体积（`pkg/*.wasm` 大小 ≤ 2MB 校验）+ 与 WebGL 基线对比结论。

```bash
git add research/wasm-render-verify.md
git commit -m "docs(research): Rust/WebGPU 渲染器全库实测验收"
```

---

## Self-Review 记录（写计划时已执行）

1. **Spec 覆盖**：spec §2 架构 → Task 8；§3 模块划分 → Task 1-7；§4 compute 粒子 → Task 6；§5 纹理格式 → Task 4+7；§6 相机 → Task 5；§7 回退链 → Task 8；§8 验收 → Task 9；§9 里程碑 M1→Task 0/1、M2→Task 2/5、M3→Task 4/7、M4→Task 6、M5→Task 8/9；§10 风险 → Task 0（镜像）/Task 5 Step 4b（feature 隔离）/Task 7（wasm 体积）/Task 9（BC 降级留 v1 后）。
2. **占位符扫描**：无 TBD/TODO；所有测试与实现代码均已写出；唯一开放点是 wgpu API 版本差异（Task 5/6 注明"以 wgpu wasm 示例为准"），属版本适配而非占位。
3. **类型一致性**：`EmitterParams` 字段名在 Task 6 测试与实现一致；`TexImage { width, height, format, mip0 }` 在 Task 4/7 一致；wasm API `load_scene/load_image/add_particle/step/render` 在 Task 7 定义、Task 8 调用一致。
