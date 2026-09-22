pub mod coords;
pub mod particle;

// ===== wasm-bindgen 导出（CpuParticleSim，供 three.js 播放器路径）=====
//
// three.js 播放器复用既有 CPU 粒子**模拟**：本结构只持有 `particle::SceneParticleSim`，
// 由 `update(dt)` 推进、`vertices()` 返回**摊平**的每粒子顶点
// （`[pos3,size,uv2,color3,alpha]`，每粒子 10 浮点）；渲染交给 three.js
// （BufferGeometry + ShaderMaterial）—— 不重写模拟，只换渲染引擎。
//
// 仅 `cpu-sim` feature（wasm 构建，含 js-sys）下导出：`vertices()` 返回 `Float32Array`
// 需要 `js-sys`。native `cargo test`（无该 feature）不编译本段，
// `build_instance_vertices`（sim.rs，非门控）由 native 测试覆盖。

#[cfg(feature = "cpu-sim")]
use wasm_bindgen::prelude::*;

/// Vec<f32>（JS Float32Array/Array）→ [f32; 3]；缺省补 0（对齐 WE 向量语义）。
fn arr3(v: &[f32]) -> [f32; 3] {
    [v.first().copied().unwrap_or(0.0), v.get(1).copied().unwrap_or(0.0), v.get(2).copied().unwrap_or(0.0)]
}

/// 独立 CPU 粒子模拟器 wasm 导出（three.js 播放器路径用）。
#[cfg(feature = "cpu-sim")]
#[wasm_bindgen]
pub struct CpuParticleSim {
    sim: particle::SceneParticleSim,
}

#[cfg(feature = "cpu-sim")]
#[wasm_bindgen]
impl CpuParticleSim {
    /// 从粒子规格 JSON + 对象中心构造 CPU 模拟器（复用 `particle::emitter_spec_to_particle`，
    /// 把 WE spec 的 emitter/initializer/operator 映射为 `SceneParticleSim`）。
    /// `origin` 为对象中心（WE 坐标）；`scene_w`/`scene_h` 为 scene 正交尺寸（we_to_three 用）。
    /// `override_json` 为 scene.json 对象的 `instanceoverride`（JSON 文本；**空串 = 无覆盖**，
    /// 见 `particle::parse_particle_override`）—— 官方 `OverrideSpawnProgram` 语义：对 spawn 初值
    /// 乘 alpha/size/lifetime/speed、覆盖 color，并让 emitter rate 乘 `count`。
    /// sprite sheet 帧数缺省为 `DEFAULT_FRAME_COUNT`（4），渲染层按纹理尺寸用
    /// `set_frame_count` 覆写。返回 `Err`（spec 解析失败）→ JS 侧 Promise reject。
    pub fn new(
        json: &str,
        origin: Vec<f32>,
        scene_w: f32,
        scene_h: f32,
        override_json: &str,
    ) -> Result<CpuParticleSim, JsValue> {
        let spec = particle::parse_particle_spec(json);
        let mut sim = particle::emitter_spec_to_particle(&spec, arr3(&origin), scene_w, scene_h);
        // scene.json 的 instanceoverride（缺字段/非法 → None → 保持 identity）。
        if let Some(ov) = particle::parse_particle_override(override_json) {
            sim.override_spec = ov;
        }
        // 预滚到「已经在飘」的稳态（修复「所有花瓣同时下落」）：首帧就铺满稳态相位错落的粒子
        // （每片随机出生 age，位置/旋转/alpha 按该 age 前滚），而不是空池冷启动、一批花瓣
        // 同相位平行下落。逐帧发射/算子语义不变（详见 `SceneParticleSim::prewarm` 注释）。
        sim.prewarm();
        Ok(CpuParticleSim { sim })
    }

    /// 每帧推进模拟（`dt` 秒；JS 侧用 `performance.now` 差分）。
    pub fn update(&mut self, dt: f32) {
        self.sim.update(dt);
    }

    /// 当前粒子数（`vertices()` 长度 = count × 10）。
    pub fn particle_count(&self) -> u32 {
        self.sim.particles.len() as u32
    }

    /// sprite sheet 总帧数（rosepetals 512×128 → 4；单帧 → 1）。
    pub fn frame_count(&self) -> u32 {
        self.sim.spritesheet_frames
    }

    /// 覆写总帧数（渲染层按纹理尺寸推导；`n < 1` 钳制到 1）。
    pub fn set_frame_count(&mut self, n: u32) {
        self.sim.spritesheet_frames = n.max(1);
    }

    /// 把每粒子顶点摊平为 `Float32Array`：`[pos3, size, uv2, color3, alpha]`（每粒子 10 浮点，
    /// 见 `SceneParticleSim::build_instance_vertices`），供 three.js 播放器 `updateParticles`
    /// 每帧刷新 `BufferAttribute`。
    pub fn vertices(&self) -> js_sys::Float32Array {
        let flat = self.sim.build_instance_vertices();
        js_sys::Float32Array::new_from_slice(&flat)
    }
}
