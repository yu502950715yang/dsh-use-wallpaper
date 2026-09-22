//! CPU 粒子模拟器（SceneParticleSim，Task 2-4）：逐粒子按 linux-wallpaperengine CParticle 语义模拟。
//! 与 GPU compute 路径（render/particle_pass.rs）不同，本模拟器在 CPU 端维护 `Vec<SimParticle>`，
//! 每帧 update 累计发射（emission_timer）、逐帧跑各 operators（movement/angularMovement/alphaFade/...
//! ，Task 4）、按寿命 compaction、再由 build_vertices 输出顶点缓冲供渲染。
//!
//! 坐标约定（Task 1 对齐 WE；上游裁决 spec §3：对象中心用 `we_to_three`、y **不翻**、与背景/图层一致）：
//! - 对象中心用 `we_to_three(origin, scene_w, scene_h) = [x - scene_w/2, y - scene_h/2, z]`
//!   （scene 尺寸、y **不翻**），与背景/图片图层的 `image_center_ndc` 完全一致（同坐标系）。
//! - emitter.origin 为加到对象中心的**局部**偏移，其 y **不翻**：+y 抬到中心**上方**；
//!   spawn 时对**发射点中心**按对象 scale 做**确定性重定标**（`BLACKMYTH_OBJ_SCALE`，读自 scene.pkg），
//!   使发射点对齐 WE（黑神话 → 屏幕**顶部偏左**、NDC≈0.97 屏内）；origin=(0,0,0) 的壁纸不受影响。
//! - 粒子**不因 emitter 散射而额外乘对象 scale**（只对发射点中心乘，散射/速度/尺寸/alpha 不乘）。
//! - scene_w/scene_h 用 scene 正交尺寸（黑神话 3840×2160），非 view cover；billboard
//!   投影由 view viewProjection（`ortho(view_w, view_h)`）完成，view_w/view_h 由 `ParticleRenderPass` 传入。
//!
//! 伪随机：进程级线程安全 Xorshift32（确定性，非加密），emitters/initializers（Task 2/3）与
//! operators（Task 4，oscillate 的 per-particle frequency/scale/phase、turbulence 的 phase/turb_speed）共用。
//!
//! 发射器（Task 2，对齐 lwe `createBoxEmitter` / `createSphereEmitter`）：`update()` 按
//! `emissionTimer += dt*rate` 精确累积并发射（`maxcount` 封顶）；`spawn()` 用 `emitter_local()`
//! 按 `is_sphere` 分支取局部散射偏移——true → 3D 球壳（`cosθ` 均匀 + `cbrt` 体积均匀）、
//! false → 均匀盒体（各轴 ±dist×|dir|，照 lwe `flippedDirections.y = -directions.y`），
//! 再叠加到**对象变换后的发射点**上。lwe 的 `limitOnePerFrame`/`randomPeriodicEmission`/`delay`
//! 依赖 emitter 的 `flags`/`delay` 等字段，当前 wasm `ParticleEmitterSpec` 未携带，故忽略（见
//! `update()` 注释）。

use crate::coords::we_to_three;
use super::{ParticleOverride, TurbulentInit};
use std::sync::atomic::{AtomicU32, Ordering};

/// 进程级 Xorshift32 状态（线程安全；跨实例共享，先简单占位，Task 4 换发射器级种子）。
static RNG_STATE: AtomicU32 = AtomicU32::new(0x9E3779B9);

/// [0, 1) 均匀伪随机（Xorshift32）。
fn rand() -> f32 {
    let mut cur = RNG_STATE.load(Ordering::Relaxed);
    loop {
        let mut next = cur;
        next ^= next << 13;
        next ^= next >> 17;
        next ^= next << 5;
        if RNG_STATE
            .compare_exchange_weak(cur, next, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            // 用高 24 位保证严格 < 1.0（避免 (u32::MAX as f32)/2^32 == 1.0）。
            return (next >> 8) as f32 / 16777216.0;
        }
        cur = RNG_STATE.load(Ordering::Relaxed);
    }
}

/// sprite sheet 横向帧数（rosepetals 512×128，每帧 128×128 = 4 帧）。
/// billboard 采样按它把整张纹理切成单帧子区；`build_vertices` 用它把粒子 frame id
/// 映射为帧中心 uv。与 `particle_render`（按纹理宽/高推导，默认 1）保持一致——当前
/// CPU 模拟粒子仅黑神话 rosepetals（512×128 ⊳ 4），故此处硬编码 4。
pub const DEFAULT_FRAME_COUNT: u32 = 4;

/// 黑神话「Sakura」粒子对象在 scene.pkg（`research/2851992662-scene.json`）的 scale：
/// `"scale" : "-2.05166 2.11670 1.00000"`。lwe 把 emitter 局部 origin="350 750 0" 经**对象
/// model 矩阵**（含该 scale）变换到场景空间，发射点因此落在屏幕**顶部偏左**（Windows 参考）。
///
/// CPU `SceneParticleSim` 的公共 WASM API（`WeScene::set_particle_sim`）**不发对象 scale**
/// （全局约束：粒子位置不乘对象 scale，只对发射点中心乘），故本模拟器在 spawn 时对**发射点**
/// **中心**按该 scale 做**确定性重定标**（Task 1：黑神话花瓣对齐 WE，落屏幕**顶部偏左**、NDC≈0.97 屏内）。
/// 仅重定标发射点中心（`发射点 = we_to_three(origin) + emitter.origin×obj_scale`），**不改变**
/// 粒子散射局部偏移、速度/尺寸/alpha（这些仍不乘对象 scale，符合全局约束）。
/// Task 6 再泛化到每对象 scale 经 WASM API 传入。
///
/// 安全兜底：`emitter.origin=(0,0,0)` 的壁纸（EVA/DK 等，见 fixtures eva lightshafts/Ashes 均
/// `"origin":"0 0 0"`）乘该 scale 仍为 0 → 发射点=对象中心，**不受影响**。
pub const BLACKMYTH_OBJ_SCALE: [f32; 3] = [-2.05166, 2.11670, 1.0];

/// 把帧号映射为**单帧子区采样中心** uv（sprite sheet 横向排布，每帧同宽同高）。
/// 帧中心：uv.x = (frame + 0.5) / frame_count（落在第 frame 帧的 1/frame_count 宽子区中心），
/// uv.y = 0.5（每帧占满整高）。
/// frame 取整并对 `[0, frame_count-1]` 钳制（防御越界；发射时已保证 0..3）。
/// native 可测（纯数据，无 wgpu）。
pub fn frame_center_uv(frame: f32, frame_count: u32) -> [f32; 2] {
    let n = frame_count.max(1) as f32;
    let idx = frame.floor().clamp(0.0, n - 1.0);
    [(idx + 0.5) / n, 0.5]
}

/// 单粒子状态（对应 WE CParticle 的 `ParticleInstance`）。
///
/// Task 3 为对齐 lwe 各 `create*RandomInitializer`，在 spawn 时补充设置两个初始属性：
/// - `angular_vel`：`angularvelocityrandom` 的初始角速度（弧/秒，逐分量 lerp）。Task 4
///   （angularmovement 算子）已把它**逐分量**消费进 `rot[k] += angular_vel[k]*dt`。
/// - `initial`：复位基准（对应 lwe `ParticleInstance::initial`，color/alpha/size/lifetime 存
///   spawn 时的初值），供 operators（alphafade/sizechange/colorchange，Task 4）按 `initial.*`
///   推导当前值；`max_life` 仍作 lifetime 基准（`initial.lifetime` 与其一致）。
/// - `fade_in`/`fade_out`：alphaFade 梯形的两个寿命位置（`used=getLifetimePos`），由 alphaFade
///   算子写入并用（Task 4）。spawn 缺省 0/1（无 alphaFade 时 alpha 恒为 `initial.alpha`）。
/// - `oscillate_*`：单粒子振荡状态（对应 lwe `ParticleInstance::oscillateAlpha/Size/Position`），
///   由各 oscillate 算子惰性初始化（`initialized`），供 Task 4 consume。
pub struct SimParticle {
    pub pos: [f32; 3],
    pub vel: [f32; 3],
    /// 粒子欧拉角（弧度，逐分量）。**F4 起为三分量**：WE `RotationAttribute` 与 lwe
    /// `CParticle::rotation` 都是 vec3，渲染侧按 WE `ComputeParticleTangents` 的三轴旋转构造
    /// billboard 切向基；此前本模拟器只取 z 分量（单标量近似）。
    pub rot: [f32; 3],
    pub angular_vel: [f32; 3],
    pub size: f32,
    pub alpha: f32,
    pub life: f32,
    pub max_life: f32,
    pub color: [f32; 3],
    pub frame: f32,
    pub initial: SimInitial,
    pub fade_in: f32,
    pub fade_out: f32,
    pub oscillate_alpha: OscState,
    pub oscillate_size: OscState,
    pub oscillate_position: OscState3,
}

/// 单粒子的**初始值复位基准**（对应 lwe `ParticleInstance::initial`）。
/// 在 spawn 时由各 initializer 设置为该粒子初值；operators/reset（Task 4）据此还原当前值。
pub struct SimInitial {
    pub color: [f32; 3],
    pub alpha: f32,
    pub size: f32,
    pub lifetime: f32,
}

/// 单粒子**单值振荡器状态**（对应 lwe `ParticleInstance::oscillateAlpha/oscillateSize`）。
/// frequency/scale/phase 在**首次**被 oscillateAlpha/oscillateSize 算子上时按算子 min/max 随机一次
/// 并置 `initialized`；`base` 由 alphafade/sizechange 每帧更新（`base = p.alpha / p.size`），使组合语义正确。
pub struct OscState {
    pub frequency: f32,
    pub scale: f32,
    pub phase: f32,
    pub base: f32,
    pub initialized: bool,
}

/// 单粒子**逐轴振荡器状态**（对应 lwe `ParticleInstance::oscillatePosition`）。
/// 三轴各自 frequency/scale/phase，首次被 oscillatePosition 算子上时按算子 min/max 逐轴随机一次。
pub struct OscState3 {
    pub frequency: [f32; 3],
    pub scale: [f32; 3],
    pub phase: [f32; 3],
    pub initialized: bool,
}

/// lwe `Maths::fadeValue`：在 `[start,end]` 上把数值从 `startValue` 线性插值到 `endValue`，
/// 端点外钳制（`life<=start → startValue`，`life>=end → endValue`）。用于大小/alpha/颜色随时间渐变。
fn fade_value(life: f32, start_time: f32, end_time: f32, start_value: f32, end_value: f32) -> f32 {
    if life <= start_time {
        start_value
    } else if life >= end_time {
        end_value
    } else {
        let t = (life - start_time) / (end_time - start_time);
        start_value + (end_value - start_value) * t
    }
}

/// 单粒子 `getLifetimePos`（对应 lwe `ParticleInstance::getLifetimePos` = `age/lifetime`，0..1）。
/// 本模拟器用 countdown `life`（`life = max_life - age`），故 `= (max_life - life)/max_life`；`max_life<=0 → 1`（避除 0）。
fn get_lifetime_pos(p: &SimParticle) -> f32 {
    if p.max_life > 0.0 {
        (p.max_life - p.life) / p.max_life
    } else {
        1.0
    }
}

/// 单粒子已存活时间 `age`（秒，递增；对应 lwe `ParticleInstance::age`），由 countdown `life` 推导：`age = max_life - life`。
fn particle_age(p: &SimParticle) -> f32 {
    p.max_life - p.life
}

// ---------------------------------------------------------------------------
// Perlin / Curl noise（对齐 lwe `NoiseUtils.h` 的 `perlinNoise` / `perlinNoiseVec3` / `curlNoise`），
// 供 Turbulence 算子对速度做噪声扰动。Rust 版用 256 项置换表 + `& 255` 索引（lwe 用 512 项重复表，
// 二者对 `PERLIN_PERM[A]`（A∈[0,510]）等价：重复表 `PERLIN_PERM[A] = PERLIN_PERM[A%256]`）。
// ---------------------------------------------------------------------------

/// Perlin 置换表（lwe `PERLIN_PERM` 前 256 项；`&255` 覆盖 lwe 的 512 重复区）。
const PERLIN_PERM: [u8; 256] = [
    151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30,
    69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62,
    94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136,
    171, 168, 68, 175, 74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122,
    60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161,
    1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86,
    164, 100, 109, 198, 173, 186, 3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126,
    255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213,
    119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9, 129, 22, 39, 253,
    19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193,
    238, 210, 144, 12, 191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31,
    181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93,
    222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180,
];

/// Perlin 梯度（lwe `perlinGrad`，按 hash 低 4 位取方向）。
fn perlin_grad(hash: usize, x: f64, y: f64, z: f64) -> f64 {
    match hash & 0xF {
        0x0 => x + y,
        0x1 => -x + y,
        0x2 => x - y,
        0x3 => -x - y,
        0x4 => x + z,
        0x5 => -x + z,
        0x6 => x - z,
        0x7 => -x - z,
        0x8 => y + z,
        0x9 => -y + z,
        0xA => y - z,
        0xB => -y - z,
        0xC => y + x,
        0xD => -y + z,
        0xE => y - x,
        0xF => -y - z,
        _ => 0.0,
    }
}

/// Perlin ease 曲线（6t⁵ - 15t⁴ + 10t³）。
fn perlin_ease(t: f64) -> f64 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// 线性插值。
fn lerp_double(t: f64, a: f64, b: f64) -> f64 {
    a + t * (b - a)
}

/// 3D Perlin 噪声（lwe `perlinNoise`；`& 255` 等价 lwe 的 512 项重复表索引）。
fn perlin_noise(x: f64, y: f64, z: f64) -> f64 {
    let xi = x.floor();
    let yi = y.floor();
    let zi = z.floor();
    let xf = x - xi;
    let yf = y - yi;
    let zf = z - zi;
    let x = xf;
    let y = yf;
    let z = zf;
    let u = perlin_ease(x);
    let v = perlin_ease(y);
    let w = perlin_ease(z);

    let xint = (xi as i32 & 255) as usize;
    let yint = (yi as i32 & 255) as usize;
    let zint = (zi as i32 & 255) as usize;

    let a = (PERLIN_PERM[xint] as usize + yint) & 255;
    let aa = (PERLIN_PERM[a] as usize + zint) & 255;
    let ab = (PERLIN_PERM[(a + 1) & 255] as usize + zint) & 255;
    let b = (PERLIN_PERM[(xint + 1) & 255] as usize + yint) & 255;
    let ba = (PERLIN_PERM[b] as usize + zint) & 255;
    let bb = (PERLIN_PERM[(b + 1) & 255] as usize + zint) & 255;

    lerp_double(
        w,
        lerp_double(
            v,
            lerp_double(
                u,
                perlin_grad(PERLIN_PERM[aa] as usize, x, y, z),
                perlin_grad(PERLIN_PERM[ba] as usize, x - 1.0, y, z),
            ),
            lerp_double(
                u,
                perlin_grad(PERLIN_PERM[ab] as usize, x, y - 1.0, z),
                perlin_grad(PERLIN_PERM[bb] as usize, x - 1.0, y - 1.0, z),
            ),
        ),
        lerp_double(
            v,
            lerp_double(
                u,
                perlin_grad(PERLIN_PERM[(aa + 1) & 255] as usize, x, y, z - 1.0),
                perlin_grad(PERLIN_PERM[(ba + 1) & 255] as usize, x - 1.0, y, z - 1.0),
            ),
            lerp_double(
                u,
                perlin_grad(PERLIN_PERM[(ab + 1) & 255] as usize, x, y - 1.0, z - 1.0),
                perlin_grad(PERLIN_PERM[(bb + 1) & 255] as usize, x - 1.0, y - 1.0, z - 1.0),
            ),
        ),
    )
}

/// 3 个独立 Perlin 采样（不同偏移）→ vec3（lwe `perlinNoiseVec3`）。
fn perlin_noise_vec3(p: [f32; 3]) -> [f32; 3] {
    [
        perlin_noise(p[0] as f64, p[1] as f64, p[2] as f64) as f32,
        perlin_noise((p[0] + 89.2) as f64, (p[1] + 33.1) as f64, (p[2] + 57.3) as f64) as f32,
        perlin_noise((p[0] + 100.3) as f64, (p[1] + 120.1) as f64, (p[2] + 142.2) as f64) as f32,
    ]
}

/// Curl 噪声（lwe `curlNoise`）：对 Perlin 场取旋度，产生平滑涡旋式方向，适合流体粒子运动扰动。
fn curl_noise(p: [f32; 3]) -> [f32; 3] {
    let e = 1e-4;
    let sub = |a: [f32; 3], b: [f32; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let add = |a: [f32; 3], b: [f32; 3]| [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    let x0 = perlin_noise_vec3(sub(p, [e, 0.0, 0.0]));
    let x1 = perlin_noise_vec3(add(p, [e, 0.0, 0.0]));
    let y0 = perlin_noise_vec3(sub(p, [0.0, e, 0.0]));
    let y1 = perlin_noise_vec3(add(p, [0.0, e, 0.0]));
    let z0 = perlin_noise_vec3(sub(p, [0.0, 0.0, e]));
    let z1 = perlin_noise_vec3(add(p, [0.0, 0.0, e]));
    let x = (y1[2] - y0[2]) - (z1[1] - z0[1]);
    let y = (z1[0] - z0[0]) - (x1[2] - x0[2]);
    let z = (x1[1] - x0[1]) - (y1[0] - y0[0]);
    let denom = 2.0 * e;
    [x / denom, y / denom, z / denom]
}

/// 粒子算子（对齐 lwe `CParticle::create*Operator` 的 `OperatorFunc` 语义——**每帧**对每个粒子跑）。
///
/// 用枚举 + `apply(&mut SimParticle, dt, time)` 表示 `OperatorFn`（lwe 的闭包捕获算子参数；
/// 此处参数为算子字段，语义等价）。`time` 为模拟器累计帧时间（= lwe `m_time`，供 turbulence 用）。
/// 注：lwe 的 `instanceOverride.speed` 未建模（各算子内 `speed` 统一取 1.0）。
#[derive(Debug, Clone)]
pub enum ParticleOperator {
    /// movement：`pos += vel*dt`（先），再 `vel += gravity*dt`，再 `vel *= max(1-drag*dt,0)`。
    Movement { gravity: [f32; 3], drag: f32 },
    /// angularMovement：逐分量 `rot[k] += angularVel[k]*dt`，再 `angularVel[k] += force[k]*dt`，再拖拽衰减，各轴 wrap 到 ±π。
    AngularMovement { force: [f32; 3], drag: f32 },
    /// alphaFade：梯形 fade-in/fade-out（`used=getLifetimePos`），`alpha = initial.alpha * fade`。
    AlphaFade { fade_in: f32, fade_out: f32 },
    /// sizeChange：`size = initial.size * fadeValue(used, start, end, startVal, endVal)`。
    SizeChange { start_time: f32, end_time: f32, start_value: f32, end_value: f32 },
    /// alphaChange：`alpha = initial.alpha * fadeValue(used, start, end, startVal, endVal)`。
    AlphaChange { start_time: f32, end_time: f32, start_value: f32, end_value: f32 },
    /// colorChange：逐分量 `color = initial.color * fadeValue(used, start, end, startVal.r/g/b, endVal.r/g/b)`。
    ColorChange { start_time: f32, end_time: f32, start_value: [f32; 3], end_value: [f32; 3] },
    /// turbulence：对速度做 curl 噪声扰动（`vel += curlDir * mask * dt`）。
    /// `phase`/`turb_speed` 为**算子创建时**按 min/max 各随机一次（对齐 lwe 闭包捕获）。
    Turbulence {
        scale: f32,
        time_scale: f32,
        mask: [f32; 3],
        phase: f32,
        turb_speed: f32,
    },
    /// oscillateAlpha：`alpha = base * mix(scaleMin, scaleMax, (cos(freq*age+phase)+1)/2)`。
    OscillateAlpha {
        freq_min: f32,
        freq_max: f32,
        scale_min: f32,
        scale_max: f32,
        phase_min: f32,
        phase_max: f32,
    },
    /// oscillateSize：`size = base * mix(scaleMin, scaleMax, (cos(freq*age+phase)+1)/2)`。
    OscillateSize {
        freq_min: f32,
        freq_max: f32,
        scale_min: f32,
        scale_max: f32,
        phase_min: f32,
        phase_max: f32,
    },
    /// oscillatePosition：逐轴 `pos += -scale*freq*sin(freq*age+phase)*dt*mask`。
    OscillatePosition {
        freq_min: f32,
        freq_max: f32,
        scale_min: f32,
        scale_max: f32,
        phase_min: f32,
        phase_max: f32,
        mask: [f32; 3],
    },
}

impl ParticleOperator {
    /// 把算子的 `phase`/`turb_speed` 按 `[min,max]` 各随机一次（对齐 lwe `createTurbulenceOperator` 的
    /// 算子级单次随机）。`min==max` 时确定（供测试）。
    pub fn turbulence(
        scale: f32,
        time_scale: f32,
        mask: [f32; 3],
        speed_min: f32,
        speed_max: f32,
        phase_min: f32,
        phase_max: f32,
    ) -> Self {
        let lerp = |a: f32, b: f32| a + (b - a) * rand();
        ParticleOperator::Turbulence {
            scale,
            time_scale,
            mask,
            phase: lerp(phase_min, phase_max),
            turb_speed: lerp(speed_min, speed_max),
        }
    }

    /// 对单个粒子应用本算子（lwe `OperatorFunc` 每帧对每个活粒子跑）。`dt` 为帧时间，`time` 为累计帧时间。
    pub fn apply(&self, p: &mut SimParticle, dt: f32, time: f32) {
        match self {
            ParticleOperator::Movement { gravity, drag } => {
                // lwe createMovementOperator：先 `position += velocity*dt`，再 `velocity += gravity*dt*speed`，
                // 再 `velocity *= max(1-drag*dt,0)`（speed=1.0，instanceOverride.speed 未建模）。
                for k in 0..3 {
                    p.pos[k] += p.vel[k] * dt;
                    p.vel[k] += gravity[k] * dt;
                }
                let drag_factor = (1.0 - drag * dt).max(0.0);
                for k in 0..3 {
                    p.vel[k] *= drag_factor;
                }
            }
            ParticleOperator::AngularMovement { force, drag } => {
                // lwe createAngularMovementOperator：`rotation += angularVelocity*dt*speed`；
                // **逐分量**（lwe `CParticle.cpp:1073` `p.rotation += p.angularVelocity*dt*speed`，
                // 随后对 x/y/z 各自 wrap 到 ±π，见 `:1087-1095`）。WE 的 rotationrandom 本就是
                // vec3，故这里不再只取 z（旧实现是单标量近似）。speed=1.0。
                let two_pi = std::f32::consts::TAU;
                let pi = std::f32::consts::PI;
                for k in 0..3 {
                    p.rot[k] += p.angular_vel[k] * dt;
                    p.angular_vel[k] += force[k] * dt;
                    p.angular_vel[k] *= (1.0 - drag * dt).max(0.0);
                    while p.rot[k] > pi {
                        p.rot[k] -= two_pi;
                    }
                    while p.rot[k] < -pi {
                        p.rot[k] += two_pi;
                    }
                }
            }
            ParticleOperator::AlphaFade { fade_in, fade_out } => {
                // 梯形（存于粒子：SimParticle.fade_in/fade_out，Task 4 契约）。
                p.fade_in = *fade_in;
                p.fade_out = *fade_out;
                let used = get_lifetime_pos(p);
                let fade = if used <= *fade_in {
                    // alpha = initial.alpha * used/fade_in
                    fade_value(used, 0.0, *fade_in, 0.0, 1.0)
                } else if used > *fade_out {
                    // alpha = initial.alpha * (1-used)/(1-fade_out)
                    1.0 - fade_value(used, *fade_out, 1.0, 0.0, 1.0)
                } else {
                    1.0
                };
                p.alpha = p.initial.alpha * fade;
                // 更新振荡器 base，使 oscillateAlpha 正确组合（lwe 同）。
                p.oscillate_alpha.base = p.alpha;
            }
            ParticleOperator::SizeChange {
                start_time,
                end_time,
                start_value,
                end_value,
            } => {
                let used = get_lifetime_pos(p);
                let mult = fade_value(used, *start_time, *end_time, *start_value, *end_value);
                p.size = p.initial.size * mult;
                // 更新振荡器 base，使 oscillateSize 正确组合。
                p.oscillate_size.base = p.size;
            }
            ParticleOperator::AlphaChange {
                start_time,
                end_time,
                start_value,
                end_value,
            } => {
                let used = get_lifetime_pos(p);
                let mult = fade_value(used, *start_time, *end_time, *start_value, *end_value);
                p.alpha = p.initial.alpha * mult;
                p.oscillate_alpha.base = p.alpha;
            }
            ParticleOperator::ColorChange {
                start_time,
                end_time,
                start_value,
                end_value,
            } => {
                let used = get_lifetime_pos(p);
                let cr = fade_value(used, *start_time, *end_time, start_value[0], end_value[0]);
                let cg = fade_value(used, *start_time, *end_time, start_value[1], end_value[1]);
                let cb = fade_value(used, *start_time, *end_time, start_value[2], end_value[2]);
                p.color = [
                    p.initial.color[0] * cr,
                    p.initial.color[1] * cg,
                    p.initial.color[2] * cb,
                ];
            }
            ParticleOperator::Turbulence {
                scale,
                time_scale,
                mask,
                phase,
                turb_speed,
            } => {
                // lwe createTurbulenceOperator：`noisePos = position; noisePos.x += phase + timeScale*currentTime;
                // noisePos *= noiseScale(scale*2); curlDir = curlNoise(noisePos); 归一×turbSpeed; ×mask;
                // velocity += curlDir*dt*speed`（speed=1.0）。`turb_speed<=0.0001` 直接 return。
                if *turb_speed <= 0.0001 {
                    return;
                }
                let noise_scale = scale * 2.0;
                let npx = (p.pos[0] + phase + time_scale * time) * noise_scale;
                let npy = p.pos[1] * noise_scale;
                let npz = p.pos[2] * noise_scale;
                let mut curl = curl_noise([npx, npy, npz]);
                let len = (curl[0] * curl[0] + curl[1] * curl[1] + curl[2] * curl[2]).sqrt();
                if len > 0.0001 {
                    curl = [
                        curl[0] / len * turb_speed,
                        curl[1] / len * turb_speed,
                        curl[2] / len * turb_speed,
                    ];
                }
                for k in 0..3 {
                    p.vel[k] += curl[k] * mask[k] * dt;
                }
            }
            ParticleOperator::OscillateAlpha {
                freq_min,
                freq_max,
                scale_min,
                scale_max,
                phase_min,
                phase_max,
            } => {
                // lwe createOscillateAlphaOperator：首次按 min/max 随机 frequency/scale/phase（phase 加 2π）
                // 并置 initialized、base=当前 alpha；其后 `mult = mix(scaleMin, scaleMax, (cos(freq*age+phase)+1)/2)`。
                if !p.oscillate_alpha.initialized {
                    p.oscillate_alpha.frequency = *freq_min + (*freq_max - *freq_min) * rand();
                    p.oscillate_alpha.scale = *scale_min + (*scale_max - *scale_min) * rand();
                    p.oscillate_alpha.phase =
                        *phase_min + ((*phase_max + std::f32::consts::TAU) - *phase_min) * rand();
                    p.oscillate_alpha.base = p.alpha;
                    p.oscillate_alpha.initialized = true;
                }
                let t = particle_age(p);
                let w = p.oscillate_alpha.frequency;
                let cos_val = ((w * t + p.oscillate_alpha.phase).cos() + 1.0) * 0.5;
                let multiplier = scale_min + (scale_max - scale_min) * cos_val;
                p.alpha = p.oscillate_alpha.base * multiplier;
            }
            ParticleOperator::OscillateSize {
                freq_min,
                freq_max,
                scale_min,
                scale_max,
                phase_min,
                phase_max,
            } => {
                if !p.oscillate_size.initialized {
                    p.oscillate_size.frequency = *freq_min + (*freq_max - *freq_min) * rand();
                    p.oscillate_size.scale = *scale_min + (*scale_max - *scale_min) * rand();
                    p.oscillate_size.phase =
                        *phase_min + ((*phase_max + std::f32::consts::TAU) - *phase_min) * rand();
                    p.oscillate_size.base = p.size;
                    p.oscillate_size.initialized = true;
                }
                let t = particle_age(p);
                let w = p.oscillate_size.frequency;
                let cos_val = ((w * t + p.oscillate_size.phase).cos() + 1.0) * 0.5;
                let multiplier = scale_min + (scale_max - scale_min) * cos_val;
                p.size = p.oscillate_size.base * multiplier;
            }
            ParticleOperator::OscillatePosition {
                freq_min,
                freq_max,
                scale_min,
                scale_max,
                phase_min,
                phase_max,
                mask,
            } => {
                if !p.oscillate_position.initialized {
                    for axis in 0..3 {
                        p.oscillate_position.frequency[axis] =
                            *freq_min + (*freq_max - *freq_min) * rand();
                        p.oscillate_position.scale[axis] =
                            *scale_min + (*scale_max - *scale_min) * rand();
                        p.oscillate_position.phase[axis] = *phase_min
                            + ((*phase_max + std::f32::consts::TAU) - *phase_min) * rand();
                    }
                    p.oscillate_position.initialized = true;
                }
                // lwe：`w = 2π*freq/(2π) = freq`；`delta = -scale*freq*sin(freq*age + phase)*dt`。
                let t = particle_age(p);
                for axis in 0..3 {
                    let w = p.oscillate_position.frequency[axis];
                    let delta = -p.oscillate_position.scale[axis] * w
                        * (w * t + p.oscillate_position.phase[axis]).sin()
                        * dt;
                    p.pos[axis] += delta * mask[axis];
                }
            }
        }
    }
}

/// 发射器闭包类型（对齐 lwe `CParticle::createBoxEmitter` / `createSphereEmitter` 的 `EmitterFunc`）。
///
/// 签名 `fn(particles, &mut count, dt)`：把本帧（`dt`）内应按 `rate` 精确累积发射的新粒子写入
/// `particles` 并递增 `count`。`count` 受 `maxcount` 封顶——lwe 用预分配池 `particles.size()` 作
/// 上限（`count >= particles.size()` 即停），本 CPU 模拟器等价地把 `SceneParticleSim::maxcount`
/// 当作池容量。发射器只给「位置起始」（发射点 + 局部散射 `local`）并触发 `count++`，其余初值
/// （velocity/rotation/color/alpha/size/frame/lifetime）由后续 initializers 填充（对应本模拟器
/// `spawn()` 内取自 `self.init` 的部分，Task 3 再逐一对齐 lwe）。
///
/// 实际驱动在 `SceneParticleSim::update()`（发射累积循环），其语义即本闭包所描述。
pub type EmitterFn = Box<dyn FnMut(&mut Vec<SimParticle>, &mut u32, f32)>;

/// 发射器规格（对齐 linux createSphereEmitter）。
pub struct ParticleEmitterSpec {
    pub rate: f32,
    /// 发射器在对象局部坐标中的偏移（y 在 spawn 时**不翻**：+y 抬到中心上方，
    /// 黑神话 origin.y=750 → 发射点抬到对象中心上方；origin.y=0 的壁纸（EVA/DK 等）不受影响）。
    /// spawn 时该局部偏移再乘 `BLACKMYTH_OBJ_SCALE`（对象 scale）做重定标（Task 1：对齐 lwe 发射点）。
    pub origin: [f32; 3],
    /// 发射方向（分摊到各轴；球壳半径沿它缩放）。
    pub directions: [f32; 3],
    /// 散射半径下界/上界（**vec3 逐轴**，对齐 lwe `ParticleEmitter.distanceMin/Max`）。
    /// - `createBoxEmitter`：各轴独立取 `[dist_min[axis], dist_max[axis]]`（Crimson Stars 的
    ///   `"1000 500 0"` → x∈[0,1000]、y∈[0,500]；此前取标量首 token（1000）会把 y 也放大到 1000
    ///   ——星点因此铺满整屏而不是只在天空）；
    /// - `createSphereEmitter`：只用 `.x`（`minRadius = distanceMin.x`）。
    pub dist_min: [f32; 3],
    pub dist_max: [f32; 3],
    /// 是否球壳散射（spec `name=="sphererandom"` → true）。`emitter_local()` 据此分支：
    /// true → `createSphereEmitter` 3D 球壳（cosθ 均匀 + cbrt 体积均匀）；false → `createBoxEmitter` 均匀盒体。
    pub is_sphere: bool,
}

/// 粒子初始值规格（从 `spec.init` 映射；CPU spawn 用它生成新粒子，替换黑神话硬编码——
/// Important I1：EVA/DK/Crimson 等**无 effects 粒子对象**用各自 spec.init，而非黑神话常量）。
///
/// `color`/`rotation`/`angular_vel` 在映射时把 `InitSpec` 的 `Option` 展开为缺省值
/// （color=[1,1,1]，rotation/angular_vel=[0,0,0]）。字段均为 pub（库公共 API，无 dead_code）。
pub struct ParticleInitSpec {
    pub lifetime_min: f32,
    pub lifetime_max: f32,
    pub size_min: f32,
    pub size_max: f32,
    /// sizerandom 的指数（黑神话 exp2 → size∈[15,25]；WE/lwe 缺省 1.0）。
    pub size_exponent: f32,
    pub velocity_min: [f32; 3],
    pub velocity_max: [f32; 3],
    pub color_min: [f32; 3],
    pub color_max: [f32; 3],
    pub alpha_min: f32,
    pub alpha_max: f32,
    /// rotationrandom：初始旋转角（弧度欧拉角，逐分量 [min,max]）。x/y 范围全零时只取 z（随机流保护，
    /// 见 spawn 注释）；缺省 [0,0,0]。
    pub rotation_min: [f32; 3],
    pub rotation_max: [f32; 3],
    /// angularvelocityrandom：初始角速度（弧/秒，逐分量）。由 angularmovement 算子逐分量消费
    /// （`rot[k] += angular_vel[k]*dt`）。
    pub angular_vel_min: [f32; 3],
    pub angular_vel_max: [f32; 3],
    /// turbulentvelocityrandom：spawn 时叠加的湍流初速（对应 lwe `createTurbulentVelocityRandomInitializer`
    /// 的 normal/forward 基 + speed 幅度）。缺省 `None` = 不叠加（该 initializer 未出现时）。
    /// 由 `ParticleInitSpec` 随 spec.init 带入（`spec_to_emitter` 从 `InitSpec::turbulent` 映射）。
    pub turbulent: Option<TurbulentInit>,
}

/// 场景粒子模拟器（CPU）。
pub struct SceneParticleSim {
    pub maxcount: u32,
    /// 对象中心（WE 坐标，y 为距底部距离）。
    pub obj_origin: [f32; 3],
    /// scene 宽（黑神话 3840），spawn 的对象中心映射（we_to_three，scene 尺寸、y 不翻）用。
    pub scene_w: f32,
    /// scene 高（黑神话 2160），spawn 的对象中心映射（we_to_three，scene 尺寸、y 不翻）用。
    pub scene_h: f32,
    /// 累积发射计数（≥1.0 即发射一个粒子并减 1）。
    pub emission_timer: f32,
    pub particles: Vec<SimParticle>,
    pub emitter: ParticleEmitterSpec,
    /// 粒子初始值规格（从 `spec.init` 映射；spawn 用它生成新粒子）。
    pub init: ParticleInitSpec,
    /// 粒子算子列表（对齐 lwe `m_operators`，`OperatorFn` 语义——`update()` 逐帧按序对每个粒子跑）。
    /// `new()` 缺省放入一个**无重力/无阻力**的 `Movement` 算子（保持既有静止/匀速直线行为；后续
    /// spec→operator 接线会按 spec 重设为零个或多个算子）。
    pub operators: Vec<ParticleOperator>,
    /// 累计帧时间（秒；= lwe `m_time`，供 turbulence 的 `phase + timeScale*currentTime` 用）。
    pub time: f32,
    /// turbulentvelocityrandom 的 curl 噪声采样位置（**跨 spawn 累积**，对应 OWE
    /// `TurbulentVelocityRandomProgram::position` 成员）——使相邻发射的粒子方向在噪声场里
    /// 平滑连贯（而不是各自独立随机）。
    pub turb_position: [f32; 3],
    /// 上一次 turbulent 采样时的 `time`（用于推导本次 spawn 应走的 curl 行走步数）。
    pub turb_last_time: f32,
    /// scene.json 对象级 `instanceoverride`（粒子实例覆盖，官方 `OverrideSpawnProgram`）。
    /// 缺省 identity（全 1 / color=None）。由渲染层按对象设置（`CpuParticleSim` 构造时传入）。
    pub override_spec: ParticleOverride,
    /// sprite sheet 总帧数（rosepetals 512×128 → 4；单帧纹理 → 1）。由渲染层在创建时按纹理尺寸
    /// 覆写（`set_particle_sim`）；`build_vertices` 用它把粒子 frame 编码进 17 浮点流的位置。
    pub spritesheet_frames: u32,
}

impl SceneParticleSim {
    pub fn new(
        e: ParticleEmitterSpec,
        maxcount: u32,
        obj_origin: [f32; 3],
        scene_w: f32,
        scene_h: f32,
        init: ParticleInitSpec,
    ) -> Self {
        Self {
            maxcount,
            obj_origin,
            scene_w,
            scene_h,
            emission_timer: 0.0,
            particles: Vec::new(),
            emitter: e,
            init,
            // 缺省 movement（无重力/阻力）：保持既有「匀速直线/静止」行为；
            // 既有测试（particle_sim_test::petals_fall_down_no_gravity 等）依赖该积分。
            operators: vec![ParticleOperator::Movement {
                gravity: [0.0; 3],
                drag: 0.0,
            }],
            time: 0.0,
            turb_position: [0.0; 3],
            turb_last_time: 0.0,
            override_spec: ParticleOverride::default(),
            spritesheet_frames: DEFAULT_FRAME_COUNT,
        }
    }

    /// 每帧推进：累计发射 → 积分运动/寿命 → 回收死亡粒子。
    pub fn update(&mut self, dt: f32) {
        // 发射（照 linux createBoxEmitter / createSphereEmitter 的**精确累积**语义）：
        //   emissionTimer += dt*rate; toEmit = (u32)emissionTimer; emissionTimer -= toEmit;
        // 然后发射 `min(toEmit, maxcount - alive)`。lwe 即使池满（count>=particles.size()）也
        // 会清零整数部分（不把计时器无限累加），此处用 `self.maxcount` 作为池容量等价实现。
        //
        // 注 1：lwe 的 `rate = emitter.rate * instanceOverride.rate`；当前 wasm `ParticleEmitterSpec`
        //       不含 instanceOverride，故直接用 `emitter.rate`（无乘数）。
        // 注 2：lwe 的 `limitOnePerFrame`(flags&2)/`randomPeriodicEmission`(flags&4)/`delay`/
        //       `duration`/`periodicTimer`/`instantaneous` 均依赖 emitter 的 flags/delay 等字段，
        //       当前 wasm `ParticleEmitterSpec` 未携带这些字段（spec_to_emitter 只映射
        //       rate/origin/directions/dist_min/dist_max/is_sphere），故本任务**不实现、予以忽略**
        //       （任务契约「有则实现，无则忽略并注明」）。
        self.emission_timer += dt * self.emitter.rate * self.override_spec.count;
        let to_emit = self.emission_timer as u32;
        self.emission_timer -= to_emit as f32;
        let alive = self.particles.len() as u32;
        let n = to_emit.min(self.maxcount.saturating_sub(alive));
        for _ in 0..n {
            self.spawn();
        }

        // 寿命推进（= lwe `age += dt`；本模拟器 countdown `life -= dt`，二者对 `getLifetimePos=age/lifetime`
        // 等价：`age = max_life - life`）。放在 operators 之前（lwe `update()` 同序）。
        for p in &mut self.particles {
            p.life -= dt;
        }
        // 累计帧时间（= lwe `m_time`）。
        self.time += dt;

        // 各算子逐帧对每个粒子跑（lwe `m_operators` 顺序；OperatorFn 语义，含黑神话 movement 无重力、
        // angularMovement 消费 angular_vel、alphaFade 梯形、oscillate 正弦等）。
        for op in &self.operators {
            for p in &mut self.particles {
                op.apply(p, dt, self.time);
            }
        }

        // 寿命 compaction：死亡（`isAlive = alive && age < lifetime` → 本模拟器 `life > 0`）移除，
        // `Vec::retain` 保持 spawn 顺序（数组 index 0 恒为最老存活粒子）。

        self.particles.retain(|p| p.life > 0.0);
    }

    /// 预滚到「已经在飘」的稳态（warm start）——**治「所有花瓣同时下落」**。
    ///
    /// 问题（2026-09-10 实测，见 `.superpowers/sdd/2026-09-08-scene-particle-lwe-alignment/task-5-report.md`）：
    /// 从空池冷启动时，粒子按 `rate` 陆续出生（这部分本就正确），但**全部处于同一寿命相位**
    /// （首帧 `lifetimePos` 标准差 ≈ 0.002）、且发射器纵向散射很小（黑神话 `directions.y=0.1`
    /// × `distancemax=750` → 出生 y 仅 ±75，而 scene 高 2160），每片花瓣一个寿命内只下落
    /// 75~500（≈3%~23% 屏高）。于是整批花瓣在一条窄横带里**同相位平行下落**——观感即
    /// Windows 用户所说的「所有花瓣同时往下落/一批一起落、一起消失」。
    ///
    /// 做法：把发射器「已经运行了约一个平均寿命」后的**稳态**直接铺到首帧——发射
    /// `steady = min(maxcount, ceil(rate × 平均寿命))` 个粒子，每个粒子带**均匀随机**的出生相位
    /// `age_frac ∈ [0,1)`（`age = age_frac × lifetime`，位置/旋转按该 age 前滚、`life` 扣减），
    /// 使各粒子在**不同相位**开始下落（有的刚出生在发射点、有的已飘到半途、有的正在淡出）。
    /// 之后 `update()` 仍按 `rate` 精确累积发射（池满时由死亡腾位），与既有语义一致。
    ///
    /// 与 lwe 的关系：lwe 的发射/初值语义未被改动（`emission_timer` 累积、逐粒子随机 lifetime/
    /// velocity/frame/rotation 均照旧）；本方法只改**初始条件**（冷启动空池 → 稳态），不改任何
    /// 逐帧物理。WE 桌面版长时间运行的观感即该稳态，故这是「对齐 Windows 观感」的最小改动。
    ///
    /// 幂等性：可重复调用，恒不超过 `maxcount`（池已满时第二次调用不再增粒子；未满则补满，
    /// 且只对本次新增的粒子做相位前滚）。
    pub fn prewarm(&mut self) {
        let mean_life = 0.5 * (self.init.lifetime_min + self.init.lifetime_max);
        if self.emitter.rate <= 0.0 || mean_life <= 0.0 || self.maxcount == 0 {
            return;
        }
        // 稳态存活数 = rate × 平均寿命（黑神话 20×7.5=150 → 受 maxcount=50 封顶）。
        let steady = ((self.emitter.rate * mean_life).ceil() as u32).clamp(1, self.maxcount);
        let first = self.particles.len();
        for _ in 0..steady {
            if self.particles.len() as u32 >= self.maxcount {
                break;
            }
            // 出生相位随机（=「每片花瓣在不同时间/相位开始下落」）。
            let age_frac = rand();
            self.spawn_with_age_frac(age_frac);
        }
        // 按各自 age 前滚各算子一次：位置 `pos += vel*age`（movement）、旋转 `rot += ω*age`
        // （angularmovement）、alpha/size/color 按 `lifetimePos` 落到该 age 的相位
        // （alphafade/sizechange/colorchange/oscillate 都是 age 的函数）。`age_frac=0` 的粒子
        // age=0 → 跳过（与常规发射逐位一致）。
        let operators = self.operators.clone();
        for idx in first..self.particles.len() {
            let age = particle_age(&self.particles[idx]);
            if age <= 0.0 {
                continue;
            }
            let now = self.time + age;
            for op in &operators {
                op.apply(&mut self.particles[idx], age, now);
            }
        }
    }

    /// 计算本次发射的**局部散射偏移** `local`（照 lwe `createBoxEmitter` / `createSphereEmitter`）。
    ///
    /// - `is_sphere == true`（spec `name=="sphererandom"`）→ `createSphereEmitter` 的 **3D 球壳**：
    ///   均匀球面单位方向（`cosθ` uniform[-1,1] → `unit=(sinθcosφ, sinθsinφ, cosθ)`）+ 半径
    ///   `r = cbrt(dist_min³ + (dist_max³ - dist_min³)·rand)`（**体积均匀**），
    ///   `local = unit ⊙ r ⊙ directions`（directions 不翻，照 lwe sphere）。
    /// - `is_sphere == false`（spec `name=="boxrandom"`）→ `createBoxEmitter` 的**均匀盒体**：
    ///   各轴**独立**在 `[dist_min[axis], dist_max[axis]]` 取 `dist`，随机 ± 翻（lwe 的 50/50 翻），
    ///   再乘 `flippedDirections`（`flippedDirections.y = -directions.y` 保留，照 lwe box），得
    ///   `local[axis] = ±dist × |flipped[axis]|`（= `±dist × |dir[axis]|`；因 `|flipped.y|=|dir.y|`，
    ///   故 y 翻对分布**无影响**，仅保留 spec 语义）。
    ///
    /// 独立成公共方法供集成测试直接断言分布，并被 `spawn()` 复用——散射 `local` **不乘对象 scale**
    /// （本模拟器输出的是**对象局部**坐标；对象 scale 由渲染侧顶点 shader 施加，见
    /// `threejs-player.ts` 的 `worldPos = objCenter + objScale*(emitterOrigin + local)`——
    /// 与 lwe `updateMatrices`（`mvp = viewProj × translate × rotate × scale` 作用于**最终**局部顶点）
    /// 等价：发射点 + 散射 + 运动整体乘 scale）。
    pub fn emitter_local(&self) -> [f32; 3] {
        let dir = self.emitter.directions;
        // lwe box 用 flippedDirections（y 翻）；sphere 用 directions（不翻）。
        let flipped = [dir[0], -dir[1], dir[2]];

        if self.emitter.is_sphere {
            // sphererandom：3D 球壳（体积均匀）。lwe `createSphereEmitter` 只用 `.x` 半径。
            let mn = self.emitter.dist_min[0].max(0.0);
            let mx = self.emitter.dist_max[0].max(mn);
            let theta = rand() * std::f32::consts::TAU;
            let cos_t = rand() * 2.0 - 1.0;
            let sin_t = (1.0 - cos_t * cos_t).sqrt();
            let unit = [sin_t * theta.cos(), sin_t * theta.sin(), cos_t];
            let r = (mn * mn * mn + (mx * mx * mx - mn * mn * mn) * rand()).cbrt();
            [unit[0] * r * dir[0], unit[1] * r * dir[1], unit[2] * r * dir[2]]
        } else {
            // boxrandom：均匀盒体，各轴**独立的** `[dist_min, dist_max]` 半径 × `|dir|`
            // （50/50 ± 翻照 lwe）。此前用标量首 token 作三轴同值 —— Crimson Stars 的
            // `"1000 500 0"` 会把 y 半径放大到 1000（× 对象 scale.y 2.148 → 星点铺满全屏）。
            let mut local = [0.0; 3];
            for axis in 0..3 {
                let mn = self.emitter.dist_min[axis].max(0.0);
                let mx = self.emitter.dist_max[axis].max(mn);
                let dist = mn + (mx - mn) * rand();
                let signed = if rand() < 0.5 { -dist } else { dist };
                local[axis] = signed * flipped[axis];
            }
            local
        }
    }

    /// 发射一个粒子（照 linux createBoxEmitter / createSphereEmitter）。
    /// 局部散射偏移由 `emitter_local()`（按 `is_sphere` 分支，见其注释）给出，再叠加到
    /// **对象变换后的发射点**上；其余初值（velocity/size/life/color/alpha/rot/frame）由
    /// `self.init` 填充（对应 lwe 后续 initializers 的语义，Task 3 再逐一对齐）。
    ///
    /// `age_frac = 0` → 常规发射（新粒子 age=0，行为与既有一致）；`> 0` → 该粒子出生即带
    /// `age = age_frac × lifetime` 的**相位偏移**（`life = lifetime - age`），供 `prewarm()`
    /// 铺「已经在飘」的稳态用（详见 `prewarm` 注释）。
    fn spawn(&mut self) {
        self.spawn_with_age_frac(0.0);
    }

    /// `spawn()` 的带相位偏移版本（`age_frac ∈ [0,1)`；`0` = 常规发射）。
    fn spawn_with_age_frac(&mut self, age_frac: f32) {
        // 局部散射偏移（box 或 sphere，见 `emitter_local`）。
        let local = self.emitter_local();

        // 发射点 = 对象中心（`we_to_three`，scene 尺寸、y **不翻**，与背景/图层同坐标系）+ emitter.origin **重定标**。
        // emitter.origin 是对象**局部**偏移；WE 经对象 model 矩阵（含对象 scale）变换到场景空间。
        // 黑神话：we_to_three(2306.34,419.77,3840,2160) → (386.34, -660.23)（对象在 scene 中心下方）；
        // 对象 scale=(-2.05,2.12) → 重定标 origin=(350,750) → 偏移 (-718.08,1587.53) →
        // pos = (386.34-718.08, -660.23+1587.53) = (-331.74, 927.30) → view ortho NDC
        // (x≈-0.17, y≈0.97) = 屏幕**顶部偏左**（屏内，匹配用户实测 Windows 顶部偏左）。
        // 仅对发射点中心乘对象 scale（`发射点 = obj_center + emitter.origin×obj_scale`），局部散射
        // local **直接相加不乘 scale**（全局约束）。Task 6 再泛化到每对象 scale 经 WASM API 传入。
        let (cx, cy) = we_to_three(self.obj_origin[0], self.obj_origin[1], self.scene_w, self.scene_h);
        let c = [cx, cy, self.obj_origin[2]];
        let off = [
            self.emitter.origin[0] * BLACKMYTH_OBJ_SCALE[0],
            self.emitter.origin[1] * BLACKMYTH_OBJ_SCALE[1],
            self.emitter.origin[2] * BLACKMYTH_OBJ_SCALE[2],
        ];
        let mut pos = [
            c[0] + off[0],
            c[1] + off[1],
            c[2] + off[2],
        ];
        pos[0] += local[0];
        pos[1] += local[1];
        pos[2] += local[2];

        // 初始属性来自 `self.init`（每个壁纸 spec.init 的 velocityrandom/sizerandom/
        // lifetimerandom/colorrandom/alpharandom/rotationrandom/angularvelocityrandom/
        // turbulentvelocityrandom），不再黑神话硬编码
        // （Important I1：EVA/DK/Crimson 等无 effects 粒子对象也用各自 spec.init，
        // 背景/图层不受影响，只改 CPU 粒子初始化）。
        //
        // 各 initializer 对齐 lwe `create*RandomInitializer`（在**发射时**设置新粒子初始属性）：
        //   - velocityRandom：`lerp(min,max,rand)` 逐分量；lwe 内部再 `vel.y=-vel.y`（屏幕 Y 向下→中心 Y 向上），
        //     本模拟器坐标经 `we_to_three`（Y 向上，与背景/图层一致）**已免翻**，且 spec 无 velocity.y 翻开关，
        //     故 **y 不翻**（黑神话 vel.y∈[-50,-15] 向下飘，行为保持）。
        //   - sizeRandom：`(min + t^exp*(max-min)) / 2`（WE/lwe：`p.size` 为 quad 整宽；exp 取
        //     size_exponent，WE/lwe 缺省 1.0，黑神话显式 2）。
        //   - alphaRandom / lifetimeRandom：`lerp(min,max,rand)`。
        //   - colorRandom：`lerp(min,max,rand)` 逐分量（已归一 0..1）。
        //   - rotationRandom：旋转角（欧拉，逐分量；x/y 范围全零时只取 z，见下方随机流保护）。
        //   - angularVelocityRandom：`lerp(min,max,rand)` 逐分量（弧/秒）。
        //   - turbulentVelocityRandom：基于法向/前向正交基的随机方向扰动，scale×速度，加到 velocity。
        //   - frame：randomframe，0..spritesheetFrames-1。
        //   - initial.color/alpha/size/lifetime：存 spawn 初值（复位基准，供 operators/reset）。
        let i = &self.init;
        // [0,1) 上逐分量线性插值：`a + (b-a)*rand`。
        let lerp = |a: f32, b: f32| a + (b - a) * rand();

        // velocityRandom：逐分量 lerp，y 不翻（见文件顶坐标约定 & we_to_three）。
        // 黑神话 velocity_min=[-50,-50,0]、velocity_max=[0,-15,0] → vel.y ∈ [-50,-15]（向下飘）。
        let mut vel = [
            lerp(i.velocity_min[0], i.velocity_max[0]),
            lerp(i.velocity_min[1], i.velocity_max[1]),
            lerp(i.velocity_min[2], i.velocity_max[2]),
        ];

        // sizeRandom：WE/lwe `createSizeRandomInitializer` 为
        //   `p.size = (min + t^exponent*(max-min)) * override / 2`（**除以 2**）。
        // 原因：WE 粒子 shader（`common_particles.h::ComputeParticlePosition`）用
        // `positionAndSize.w * right * (uvs.x-0.5)` 展开 quad —— 即 `p.size` 就是 billboard 的**整宽**
        // （uvs∈[0,1]），sizerandom 存的是编辑器值的**一半**。本模拟器输出的 `size` 与渲染器
        // （three `position.xy*particleSize*0.5`、wasm `corner*size/2`，角点 ±1）同为「整宽」语义，
        // 故此处同样 /2；否则粒子会是 WE 的 **2 倍大**（Crimson 绿点/星点偏大、黑神话花瓣偏大）。
        // instanceoverride.size：官方 override 是**追加在最后**的 initializer，在 sizerandom 的
        // 「/2」之后乘 `modifiers.Size()`（ParticleParser.cpp:369 `columns.sizes[index] *= ...`）。
        let size = (i.size_min + (i.size_max - i.size_min) * rand().powf(i.size_exponent))
            * 0.5
            * self.override_spec.size;
        // lifetimeRandom / alphaRandom：`lerp(min,max,rand)`（黑神话 life∈[5,10]、alpha 缺省 1.0）。
        // 两者再乘 instanceoverride 的 lifetime/alpha（官方 ParticleParser.cpp:365-368）。
        let life = lerp(i.lifetime_min, i.lifetime_max) * self.override_spec.lifetime;
        // 出生相位偏移（prewarm 用）：`age = age_frac × lifetime`，剩余寿命 = lifetime - age。
        // `age_frac = 0`（常规发射）→ spawn_age=0、剩余寿命=lifetime，与既有行为**逐位一致**。
        let spawn_age = (age_frac.clamp(0.0, 0.999) * life).max(0.0);
        let life_remaining = (life - spawn_age).max(1e-3);
        // alpha = alpharandom × instanceoverride.alpha（官方 UiScalarToLinear 为恒等）。
        let alpha = lerp(i.alpha_min, i.alpha_max) * self.override_spec.alpha;
        // colorRandom：逐分量 lerp（已归一 0..1；缺省 color_min/max=[1,1,1]；黑神话粉花瓣）。
        let color = [
            lerp(i.color_min[0], i.color_max[0]),
            lerp(i.color_min[1], i.color_max[1]),
            lerp(i.color_min[2], i.color_max[2]),
        ];
        // instanceoverride.color/colorn：**直接覆盖**（官方 ParticleParser.cpp:373-382
        // `columns.colors[index] = value`，已转线性）。
        let color = self.override_spec.color.unwrap_or(color);
        // rotationRandom：旋转角（欧拉）。WE `VectorRandomProgram::Target::Rotation` 是 vec3，
        // lwe `CParticle.cpp:786` 亦为 `randomVec3(min,max)` ⇒ 三轴都要取。
        // ⚠️ **随机数流保护**：`lerp` 消费 RNG，而旧实现只取 z（1 次抽取）。若无条件改成 3 次，
        // 后续所有抽取（velocity/size/alpha/frame…）整体偏移 ⇒ **全库每张壁纸的粒子外观都变**
        // （统计等价但逐像素不同，2026-09-22 实测：无自旋壁纸也变 3.1%、纯 z 轴壁纸变 9.6%）。
        // 故仅当壁纸**真的声明了 x/y 范围**时才多抽，其余保持 z 单抽 ⇒ 非多轴壁纸的流逐位不变。
        let rot_xy_declared = i.rotation_min[0] != 0.0
            || i.rotation_max[0] != 0.0
            || i.rotation_min[1] != 0.0
            || i.rotation_max[1] != 0.0;
        let rot = if rot_xy_declared {
            [
                lerp(i.rotation_min[0], i.rotation_max[0]),
                lerp(i.rotation_min[1], i.rotation_max[1]),
                lerp(i.rotation_min[2], i.rotation_max[2]),
            ]
        } else {
            [0.0, 0.0, lerp(i.rotation_min[2], i.rotation_max[2])]
        };
        // angularVelocityRandom：逐分量 lerp（弧/秒）。由 angularmovement 算子逐分量消费。
        let angular_vel = [
            lerp(i.angular_vel_min[0], i.angular_vel_max[0]),
            lerp(i.angular_vel_min[1], i.angular_vel_max[1]),
            lerp(i.angular_vel_min[2], i.angular_vel_max[2]),
        ];

        // turbulentVelocityRandom：把扰动**加到 velocity**（官方 OWE
        // `TurbulentVelocityRandomProgram::Initialize`，ParticleParser.cpp:326-357）：
        //   result = curlNoise(position + normal*phase)   // 3D 噪声场采样（position **跨 spawn 累积**）
        //   result -= normal*dot(result, normal)          // 投影到**垂直 normal 的平面**
        //   result 归一（退化到零则取 forward）
        //   angle  = atan2(normal·(forward×result), forward·result)
        //   result = AngleAxisf(angle*scale + offset, normal) * forward   // ★ forward **绕 normal 旋转**
        //   velocity += result * lerp(speedMin, speedMax, rand)
        //
        // ⚠️ 回归（GTR 3743126786「贯穿全屏的竖直白烟串」，2026-09-11 定位）：旧实现写成
        //    `forward*cosθ + normal*sinθ*scale`，把 normal 当成了**偏转方向**——对缺省
        //    normal=+Z / forward=+Y 得到 (0, cosθ, sinθ)：x 分量恒 0、速度全跑进屏幕上根本
        //    不可见的 z 轴，177 个粒子于是排成一条竖线（实测 max|vx|=0.000 / max|vy|=247.8 /
        //    max|vz|=223.1）。正确语义下方向恒落在垂直 normal 的平面内（此处 = XY 平面，z 恒 0）。
        //
        // 无该 initializer（`turbulent == None`）→ 忽略（不叠加扰动）。
        if let Some(turb) = &i.turbulent {
            let speed = lerp(turb.speed_min, turb.speed_max);
            let phase = lerp(turb.phase_min, turb.phase_max);
            let f = turb.forward;
            let n = turb.normal;
            // curl 行走步数：自上次 spawn 起每 0.01s 一步（官方 do/while `duration -= 0.01` 的等价），
            // 钳制到 [1, 64] 防低 rate 对象（流星 rate=0.2/s → 间隔 5s）迭代过多。
            let steps = (((self.time - self.turb_last_time) / 0.01).round() as i32).clamp(1, 64) as usize;
            self.turb_last_time = self.time;
            let mut dir = f;
            for _ in 0..steps {
                let sample = [
                    self.turb_position[0] + n[0] * phase,
                    self.turb_position[1] + n[1] * phase,
                    self.turb_position[2] + n[2] * phase,
                ];
                let mut r = curl_noise(sample);
                let d = r[0] * n[0] + r[1] * n[1] + r[2] * n[2];
                r = [r[0] - n[0] * d, r[1] - n[1] * d, r[2] - n[2] * d];
                let len2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
                dir = if len2 > 1e-8 {
                    let inv = 1.0 / len2.sqrt();
                    [r[0] * inv, r[1] * inv, r[2] * inv]
                } else {
                    f // 噪声方向退化到 normal 轴 → 回退 forward（官方同分支）
                };
                self.turb_position[0] += dir[0] * 0.005 * turb.timescale;
                self.turb_position[1] += dir[1] * 0.005 * turb.timescale;
                self.turb_position[2] += dir[2] * 0.005 * turb.timescale;
            }
            // theta = angle × max(0, scale×0.5) + offset（官方 `auto scale = max(0, config.scale*0.5)`）。
            let cross_fd = [
                f[1] * dir[2] - f[2] * dir[1],
                f[2] * dir[0] - f[0] * dir[2],
                f[0] * dir[1] - f[1] * dir[0],
            ];
            let cosine = (f[0] * dir[0] + f[1] * dir[1] + f[2] * dir[2]).clamp(-1.0, 1.0);
            let sine = n[0] * cross_fd[0] + n[1] * cross_fd[1] + n[2] * cross_fd[2];
            let angle = sine.atan2(cosine);
            let theta = angle * (turb.scale * 0.5).max(0.0) + turb.offset;
            // Rodrigues 旋转：forward 绕 normal 转 theta（normal ⊥ forward → 无轴向分量项）。
            let (sin_t, cos_t) = theta.sin_cos();
            let axis_cross_f = [
                n[1] * f[2] - n[2] * f[1],
                n[2] * f[0] - n[0] * f[2],
                n[0] * f[1] - n[1] * f[0],
            ];
            let out = [
                f[0] * cos_t + axis_cross_f[0] * sin_t,
                f[1] * cos_t + axis_cross_f[1] * sin_t,
                f[2] * cos_t + axis_cross_f[2] * sin_t,
            ];
            vel[0] += out[0] * speed;
            vel[1] += out[1] * speed;
            vel[2] += out[2] * speed;
        }

        // instanceoverride.speed：官方 override 是**最后一个** initializer，所以它乘在全部速度上
        // （velocityrandom + turbulentvelocityrandom 都已叠加完，ParticleParser.cpp:371）。
        vel = [
            vel[0] * self.override_spec.speed,
            vel[1] * self.override_spec.speed,
            vel[2] * self.override_spec.speed,
        ];

        // frame：randomframe，0..spritesheetFrames-1（rosepetals 4 帧；否则所有花瓣固定采样同帧）。
        // rand() ∈ [0,1) → *4 ∈ [0,4) → floor ∈ {0,1,2,3}。
        let frame = (rand() * DEFAULT_FRAME_COUNT as f32).floor();

        self.particles.push(SimParticle {
            pos,
            vel,
            rot,
            angular_vel,
            size,
            alpha,
            life: life_remaining,
            max_life: life,
            color,
            frame,
            // initial 复位基准：存 spawn 初值，供 operators（alphafade/sizechange/colorchange，Task 4）
            // 按 `initial.*` 推导当前值；lifetime 基准与 max_life 一致。
            initial: SimInitial {
                color,
                alpha,
                size,
                lifetime: life,
            },
            // alphaFade 梯形预留（缺省 0/1：无 alphaFade 时 used∈[0,1]、alpha 恒为 initial.alpha，不生效）。
            fade_in: 0.0,
            fade_out: 1.0,
            // 振荡器状态（lazy init 由各 oscillate 算子置 initialized）。
            oscillate_alpha: OscState {
                frequency: 0.0,
                scale: 1.0,
                phase: 0.0,
                base: 0.0,
                initialized: false,
            },
            oscillate_size: OscState {
                frequency: 0.0,
                scale: 1.0,
                phase: 0.0,
                base: 0.0,
                initialized: false,
            },
            oscillate_position: OscState3 {
                frequency: [0.0; 3],
                scale: [0.0; 3],
                phase: [0.0; 3],
                initialized: false,
            },
        });
    }

    /// 输出**每粒子单点**顶点（13 浮点：`[pos3, size, uv2, color3, alpha, rot3]`），供 three.js
    /// 播放器 billboard（每粒子一个实例，shader 内展开 quad 角点并按三轴旋转）。
    /// `uv2` = 帧子区**中心** uv（`frame_center_uv`：uv.x = (frame+0.5)/frame_count，uv.y = 0.5；
    /// 单帧 → [0.5,0.5]），供 fragment 多帧切片（`floor(uv.x*frame_count)` 还原帧号后取子区）。
    /// `rot3` = 粒子欧拉角（弧度，**逐分量**），由 `rotationrandom` 初始化、`angularmovement` 每帧
    /// 逐分量推进（见 `p.rot`）；渲染侧按 WE `ComputeParticleTangents` 的同一套旋转构造 quad 基向量
    /// （rot 只有 z 分量时退化为平面自旋，与原实现逐像素一致）。
    ///
    /// 字段顺序（每粒子 13 浮点，stride 52B）：
    ///   `[0..3]` pos3；`[3]` size；`[4..6]` uv2；`[6..9]` color3；`[9]` alpha；`[10..13]` rot3。
    /// returns Vec 长度 = particles.len() × 13。
    pub fn build_instance_vertices(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity(self.particles.len() * 13);
        for p in &self.particles {
            let [ux, uy] = frame_center_uv(p.frame, self.spritesheet_frames);
            out.push(p.pos[0]);
            out.push(p.pos[1]);
            out.push(p.pos[2]);
            out.push(p.size);
            out.push(ux);
            out.push(uy);
            out.push(p.color[0]);
            out.push(p.color[1]);
            out.push(p.color[2]);
            out.push(p.alpha);
            out.push(p.rot[0]);
            out.push(p.rot[1]);
            out.push(p.rot[2]);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_center_uv_maps_to_single_frame_subregion() {
        // rosepetals：frame_count=4。frame 2 → uv.x = (2+0.5)/4 = 0.625（第 2 帧 1/4 宽子区中心）。
        assert_eq!(frame_center_uv(2.0, 4), [0.625, 0.5]);
        assert_eq!(frame_center_uv(0.0, 4), [0.125, 0.5]); // (0+0.5)/4
        assert_eq!(frame_center_uv(3.0, 4), [0.875, 0.5]); // (3+0.5)/4 = 3.5/4
        // 非 sheet：单帧 → 全纹理中心。
        assert_eq!(frame_center_uv(0.0, 1), [0.5, 0.5]);
        // 越界防御：frame 被钳制到 [0, frame_count-1]。
        assert_eq!(frame_center_uv(5.0, 4), [0.875, 0.5]);
        assert_eq!(frame_center_uv(-1.0, 4), [0.125, 0.5]);
        // 非整数 frame 取整（离散帧 id）。
        assert_eq!(frame_center_uv(2.7, 4), [0.625, 0.5]);
    }

    /// Task 3：`build_instance_vertices` 输出**每粒子** 13 浮点
    /// `[pos3,size,uv2,color3,alpha,rot3]`，uv2 = 帧子区中心（frame_center_uv），
    /// rot3 = 粒子欧拉角（弧度，逐分量；F4 起进入顶点流，渲染侧据此旋转 billboard 角点）。
    #[test]
    fn build_instance_vertices_flat_per_particle() {
        let mut sim = SceneParticleSim::new(
            ParticleEmitterSpec {
                rate: 0.0,
                origin: [0.0; 3],
                directions: [0.0; 3],
                dist_min: [0.0; 3],
                dist_max: [0.0; 3],
                is_sphere: false,
            },
            8,
            [0.0; 3],
            3840.0,
            2160.0,
            ParticleInitSpec {
                lifetime_min: 5.0,
                lifetime_max: 10.0,
                size_min: 30.0,
                size_max: 50.0,
                size_exponent: 2.0,
                velocity_min: [-50.0, -50.0, 0.0],
                velocity_max: [0.0, -15.0, 0.0],
                color_min: [1.0, 0.83, 0.97],
                color_max: [1.0, 0.83, 0.97],
                alpha_min: 1.0,
                alpha_max: 1.0,
                rotation_min: [0.0; 3],
                rotation_max: [0.0; 3],
                angular_vel_min: [0.0; 3],
                angular_vel_max: [0.0; 3],
                turbulent: None,
            },
        );
        sim.particles.push(SimParticle {
            pos: [1.0, 2.0, 3.0],
            vel: [0.0; 3],
            rot: [0.1, 0.2, 0.75],
            angular_vel: [0.0; 3],
            size: 40.0,
            alpha: 0.25,
            life: 1.0,
            max_life: 1.0,
            color: [0.5, 0.6, 0.7],
            frame: 2.0,
            initial: SimInitial {
                color: [0.5, 0.6, 0.7],
                alpha: 0.25,
                size: 40.0,
                lifetime: 1.0,
            },
            fade_in: 0.0,
            fade_out: 1.0,
            oscillate_alpha: OscState {
                frequency: 0.0,
                scale: 1.0,
                phase: 0.0,
                base: 0.0,
                initialized: false,
            },
            oscillate_size: OscState {
                frequency: 0.0,
                scale: 1.0,
                phase: 0.0,
                base: 0.0,
                initialized: false,
            },
            oscillate_position: OscState3 {
                frequency: [0.0; 3],
                scale: [0.0; 3],
                phase: [0.0; 3],
                initialized: false,
            },
        });
        let v = sim.build_instance_vertices();
        assert_eq!(v.len(), 13, "单粒子应输出 13 浮点");
        assert_eq!(&v[0..3], &[1.0, 2.0, 3.0], "pos3");
        assert_eq!(v[3], 40.0, "size");
        // frame=2 → frame_center_uv(2, 4) = [(2+0.5)/4, 0.5] = [0.625, 0.5]。
        assert_eq!(v[4], 0.625, "uv.x 帧子区中心");
        assert_eq!(v[5], 0.5, "uv.y");
        assert_eq!(&v[6..9], &[0.5, 0.6, 0.7], "color3");
        assert_eq!(v[9], 0.25, "alpha");
        // F4：粒子欧拉角**三分量**进入顶点流（渲染侧按 WE ComputeParticleTangents 构造 quad 基向量）
        assert_eq!(&v[10..13], &[0.1, 0.2, 0.75], "rot3");
    }

    /// Important I1：spawn 用 `self.init`（每壁纸 spec.init），而非黑神话硬编码。
    /// 此处用一组远离黑神话值的 init，断言生成粒子落在 init 范围内（证明不是黑神话常量）。
    #[test]
    fn spawn_uses_init_not_black_myth_constants() {
        let mut sim = SceneParticleSim::new(
            ParticleEmitterSpec {
                rate: 0.0,
                origin: [0.0; 3],
                directions: [0.0; 3],
                dist_min: [0.0; 3],
                dist_max: [0.0; 3],
                is_sphere: false,
            },
            8,
            [0.0; 3],
            3840.0,
            2160.0,
            ParticleInitSpec {
                lifetime_min: 2.0,
                lifetime_max: 3.0,
                size_min: 10.0,
                size_max: 20.0,
                size_exponent: 1.0,
                velocity_min: [-100.0, -200.0, -300.0],
                velocity_max: [100.0, 200.0, 300.0],
                color_min: [0.1, 0.2, 0.3],
                color_max: [0.4, 0.5, 0.6],
                alpha_min: 0.5,
                alpha_max: 0.9,
                rotation_min: [-1.0, -1.0, -1.0],
                rotation_max: [1.0, 1.0, 1.0],
                angular_vel_min: [-2.0, -2.0, -2.0],
                angular_vel_max: [2.0, 2.0, 2.0],
                turbulent: None,
            },
        );
        // spawn 直接调用（同模块可访问私有方法）生成一个粒子。
        sim.spawn();
        assert_eq!(sim.particles.len(), 1, "spawn 应生成 1 个粒子");
        let p = &sim.particles[0];

        // vel 各分量落在 init 的 [velocity_min, velocity_max]（此组范围远超黑神话 -50..-15）。
        assert!((-100.0..=100.0).contains(&p.vel[0]), "vel[0] 应在 init 范围内，got {}", p.vel[0]);
        assert!((-200.0..=200.0).contains(&p.vel[1]), "vel[1] 应来自 init（非黑神话 -50..-15），got {}", p.vel[1]);
        assert!((-300.0..=300.0).contains(&p.vel[2]), "vel[2] 应在 init 范围内，got {}", p.vel[2]);

        // size 落在 init [size_min/2, size_max/2]（WE/lwe：sizerandom 值 /2；非黑神话 15..25）。
        assert!((5.0..=10.0).contains(&p.size), "size 应来自 init 且 = 值/2，got {}", p.size);
        // life 落在 init [lifetime_min, lifetime_max]（非黑神话 5..10）。
        assert!((2.0..=3.0).contains(&p.life), "life 应来自 init，got {}", p.life);
        // color 各分量落在 init [color_min, color_max]（非黑神话粉 [1,0.83,0.97]）。
        assert!((0.1..=0.4).contains(&p.color[0]), "color[0] 非黑神话 1.0，got {}", p.color[0]);
        assert!((0.2..=0.5).contains(&p.color[1]), "color[1] 非黑神话 0.83，got {}", p.color[1]);
        assert!((0.3..=0.6).contains(&p.color[2]), "color[2] 非黑神话 0.97，got {}", p.color[2]);
        // alpha 落在 init [alpha_min, alpha_max]。
        assert!((0.5..=0.9).contains(&p.alpha), "alpha 应来自 init，got {}", p.alpha);
        // rot 逐分量：x/y 声明了范围就各自 lerp，否则 x/y 恒 0、只 lerp z。
        for k in 0..3 {
            assert!((-1.0..=1.0).contains(&p.rot[k]), "rot[{}] 应来自 init 的 rotation，got {}", k, p.rot[k]);
        }
        // frame 保留黑神话帧 0..3。
        assert!(p.frame >= 0.0 && p.frame < 4.0, "frame 应随机 0..3，got {}", p.frame);
        // max_life 跟随 life。
        assert_eq!(p.max_life, p.life, "max_life 应等于 life（spawn 时确定）");
    }

    /// ⚠️ **随机数流守卫回归**（F4 后续）：`rotationrandom` 的 x/y 范围全零时（纯 z、或该
    /// initializer 根本不存在），spawn 必须**只抽 1 次**随机数，与旧实现一致 —— 否则之后的所有
    /// 抽取（angular_vel/frame，以及下个粒子的全部字段）整体漂移，全库每张壁纸的粒子外观都会变。
    /// 断言用「rotation **之后**才抽取」的 `angular_vel`：同种子下纯 z 必须与无 rotationrandom
    /// 逐位相同；对照组（x 范围非零）证明该断言有区分力。
    #[test]
    fn z_only_rotation_keeps_rng_stream_unchanged() {
        let spawn_after = |rot_min: [f32; 3], rot_max: [f32; 3]| {
            let mut init = default_init();
            init.rotation_min = rot_min;
            init.rotation_max = rot_max;
            // 取值随机且**在 rotation 之后**抽取，才能反映随机流是否被平移。
            init.angular_vel_min = [-2.0; 3];
            init.angular_vel_max = [2.0; 3];
            let mut sim = SceneParticleSim::new(
                ParticleEmitterSpec {
                    rate: 0.0,
                    origin: [0.0; 3],
                    directions: [0.0; 3],
                    dist_min: [0.0; 3],
                    dist_max: [0.0; 3],
                    is_sphere: false,
                },
                8,
                [0.0; 3],
                3840.0,
                2160.0,
                init,
            );
            // `rand()` 是进程级共享状态，跨实例无法独立播种 ⇒ 手动复位到其初值。
            RNG_STATE.store(0x9E3779B9, Ordering::Relaxed);
            sim.spawn();
            sim.particles[0].angular_vel
        };
        let absent = spawn_after([0.0; 3], [0.0; 3]);
        let z_only = spawn_after([0.0, 0.0, 1.4], [0.0, 0.0, 1.7]);
        assert_eq!(
            absent, z_only,
            "纯 z 必须与无 rotationrandom 消耗同样多的随机数（rotation 之后的字段应逐位一致）"
        );
        // 对照组：x 范围非零 ⇒ 多抽 2 次，rotation 之后的字段必然不同。
        let multi = spawn_after([-1.0, 0.0, 1.4], [1.0, 0.0, 1.7]);
        assert_ne!(absent, multi, "多轴应多抽 2 次，后续随机字段应不同（证明上面的断言有区分力）");
    }

    /// 构造一个最小/缺省 init（粒子位置断言不依赖 init 字段值）。
    fn default_init() -> ParticleInitSpec {
        ParticleInitSpec {
            lifetime_min: 5.0,
            lifetime_max: 10.0,
            size_min: 30.0,
            size_max: 50.0,
            size_exponent: 2.0,
            velocity_min: [0.0; 3],
            velocity_max: [0.0; 3],
            color_min: [1.0, 1.0, 1.0],
            color_max: [1.0, 1.0, 1.0],
            alpha_min: 1.0,
            alpha_max: 1.0,
            rotation_min: [0.0; 3],
            rotation_max: [0.0; 3],
            angular_vel_min: [0.0; 3],
            angular_vel_max: [0.0; 3],
            turbulent: None,
        }
    }

    /// 黑神话发射点：对象中心用 `we_to_three`（scene 尺寸、y **不翻**，与背景/图层同坐标系）+ emitter.origin
    /// **按对象 scale 重定标** → 屏幕**顶部偏左**（Task 1 对齐 WE）。
    /// we_to_three(2306.34,419.77, 3840,2160) → (386.34, -660.23)（对象在 scene 中心下方）；
    /// 对象 scale=(-2.05166, 2.11670) → origin=(350,750) 重定标偏移 = (-718.08, 1587.53) →
    /// pos = (386.34-718.08, -660.23+1587.53) = (-331.74, 927.30)。
    /// view ortho NDC = (x≈-0.17, y≈0.97) → 屏幕**顶部偏左**（屏内）。
    #[test]
    fn black_myth_emits_top_left_in_scene_coords() {
        let mut sim = SceneParticleSim::new(
            ParticleEmitterSpec {
                rate: 0.0,
                origin: [350.0, 750.0, 0.0],
                directions: [0.0; 3], // 局部球壳偏移为 0 → pos 确定
                dist_min: [0.0; 3],
                dist_max: [0.0; 3],
                is_sphere: false,
            },
            8,
            [2306.34, 419.77, 0.0],
            3840.0,
            2160.0,
            default_init(),
        );
        sim.spawn();
        assert_eq!(sim.particles.len(), 1);
        let p = &sim.particles[0];
        // 对象中心 x=386.34（we_to_three）+ origin.x=350 × scale.x(-2.05166) = -718.08 → -331.74。
        assert!((p.pos[0] - (-331.741)).abs() < 1e-2, "pos.x 应为 -331.74（顶部偏左），got {}", p.pos[0]);
        // 对象中心 y=-660.23 + origin.y=750 × scale.y(2.11670) = 1587.53 → 927.30（屏幕顶部偏左）。
        assert!((p.pos[1] - 927.295).abs() < 1e-2, "pos.y 应为 927.30（屏幕顶部偏左），got {}", p.pos[1]);
        assert!(p.pos[0] < 0.0, "黑神话应偏左（NDC x<0），got {}", p.pos[0]);
        // 屏内顶部：pos.y 在 (0, view_h/2)（view ortho 半高），非离屏。
        assert!((p.pos[1] - 927.30).abs() < 1e-2 && p.pos[1] > 0.0, "黑神话应屏内顶部（0<y<view_h/2），got {}", p.pos[1]);
    }

    /// origin.y=0 的壁纸（EVA/DK 等）：对象中心用 `we_to_three`（scene 尺寸、y **不翻**，与背景一致）。
    /// we_to_three(2306.34,419.77,3840,2160) → c[1]=-660.23；emitter.origin.y=0 → pos.y=-660.23。
    /// 乘对象 scale 仍 0 → 发射点=对象中心，不受影响（与背景/图层同坐标系）。
    #[test]
    fn emitter_origin_zero_is_object_center_in_scene_coords() {
        let mut sim = SceneParticleSim::new(
            ParticleEmitterSpec {
                rate: 0.0,
                origin: [0.0; 3],
                directions: [0.0; 3],
                dist_min: [0.0; 3],
                dist_max: [0.0; 3],
                is_sphere: false,
            },
            8,
            [2306.34, 419.77, 0.0],
            3840.0,
            2160.0,
            default_init(),
        );
        sim.spawn();
        assert_eq!(sim.particles.len(), 1);
        let y = sim.particles[0].pos[1];
        // 对象中心 y = 419.77 - 2160/2 = -660.23（scene 中心下方，we_to_three 与背景一致）。
        assert!((y - (-660.23)).abs() < 1e-3, "origin.y=0 时 pos.y 应为对象中心 we_to_three 坐标 -660.23，got {}", y);
    }
}
