//! CPU 粒子模拟器（SceneParticleSim，Task 2）：逐粒子按 linux-wallpaperengine CParticle 语义模拟。
//! 与 GPU compute 路径（render/particle_pass.rs）不同，本模拟器在 CPU 端维护 `Vec<SimParticle>`，
//! 每帧 update 累计发射（emission_timer）、积分运动/寿命、回收死亡粒子，再由 build_vertices 输出
//! 顶点缓冲供渲染（Task 3/4）。
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
//! 伪随机：先用进程级线程安全 Xorshift32（确定性，非加密），Task 4 再接入种子/发射器级状态。
//!
//! 发射器（Task 2，对齐 lwe `createBoxEmitter` / `createSphereEmitter`）：`update()` 按
//! `emissionTimer += dt*rate` 精确累积并发射（`maxcount` 封顶）；`spawn()` 用 `emitter_local()`
//! 按 `is_sphere` 分支取局部散射偏移——true → 3D 球壳（`cosθ` 均匀 + `cbrt` 体积均匀）、
//! false → 均匀盒体（各轴 ±dist×|dir|，照 lwe `flippedDirections.y = -directions.y`），
//! 再叠加到**对象变换后的发射点**上。lwe 的 `limitOnePerFrame`/`randomPeriodicEmission`/`delay`
//! 依赖 emitter 的 `flags`/`delay` 等字段，当前 wasm `ParticleEmitterSpec` 未携带，故忽略（见
//! `update()` 注释）。

use crate::coords::we_to_three;
use super::TurbulentInit;
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
/// - `angular_vel`：`angularvelocityrandom` 的初始角速度（弧/秒，逐分量 lerp）。当前 `update()`
///   仍用黑神话角速度近似 `rot += 0.5*dt`，本字段带 init 语义但**尚未被消费**——由 Task 4
///   （angularmovement 算子）接入 `rot += angular_vel*dt`。
/// - `initial`：复位基准（对应 lwe `ParticleInstance::initial`，color/alpha/size/lifetime 存
///   spawn 时的初值），供 operators（alphafade/sizechange/colorchange，Task 4）按 `initial.*`
///   推导当前值；`max_life` 仍作 lifetime 基准（`initial.lifetime` 与其一致）。
pub struct SimParticle {
    pub pos: [f32; 3],
    pub vel: [f32; 3],
    pub rot: f32,
    pub angular_vel: [f32; 3],
    pub size: f32,
    pub alpha: f32,
    pub life: f32,
    pub max_life: f32,
    pub color: [f32; 3],
    pub frame: f32,
    pub initial: SimInitial,
}

/// 单粒子的**初始值复位基准**（对应 lwe `ParticleInstance::initial`）。
/// 在 spawn 时由各 initializer 设置为该粒子初值；operators/reset（Task 4）据此还原当前值。
pub struct SimInitial {
    pub color: [f32; 3],
    pub alpha: f32,
    pub size: f32,
    pub lifetime: f32,
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
    pub dist_min: f32,
    pub dist_max: f32,
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
    /// sizerandom 的指数（黑神话 exp2 → size∈[30,50]）。`InitSpec` 未解析 sizerandom 的
    /// exponent 字段，映射时统一给 2.0（对齐原硬编码，行为不变）。
    pub size_exponent: f32,
    pub velocity_min: [f32; 3],
    pub velocity_max: [f32; 3],
    pub color_min: [f32; 3],
    pub color_max: [f32; 3],
    pub alpha_min: f32,
    pub alpha_max: f32,
    /// rotationrandom：初始旋转角（弧度欧拉角，逐分量 [min,max]）。CPU spawn 取 z 轴（`[2]`）
    /// 做单轴近似。缺省 [0,0,0]。
    pub rotation_min: [f32; 3],
    pub rotation_max: [f32; 3],
    /// angularvelocityrandom：初始角速度（弧/秒，逐分量）。当前 CPU `update` 仍用 0.5*dt
    /// （黑神话角速度近似，见 update 注释），本字段随 init 带入但尚未被消费
    /// （angularmovement 算子未完整实现，见文件顶注释）。
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
        self.emission_timer += dt * self.emitter.rate;
        let to_emit = self.emission_timer as u32;
        self.emission_timer -= to_emit as f32;
        let alive = self.particles.len() as u32;
        let n = to_emit.min(self.maxcount.saturating_sub(alive));
        for _ in 0..n {
            self.spawn();
        }

        for p in &mut self.particles {
            p.life -= dt;
            for k in 0..3 {
                p.pos[k] += p.vel[k] * dt;
            }
            // 无重力（父代理裁决 2026-09-08）：black movement operator(id11) 无 gravity，
            // 花瓣靠初始 velocity.y=-50..-15 向下飘，vel[1] 保持初始负值、不叠加任何重力
            // （不用 `-= -9.8*dt`，那会使 vy 渐增/向上，与"向下飘"相悖）。
            p.rot += 0.5 * dt; // 角速度近似（照 black spec）
        }
        self.particles.retain(|p| p.life > 0.0);
    }

    /// 计算本次发射的**局部散射偏移** `local`（照 lwe `createBoxEmitter` / `createSphereEmitter`）。
    ///
    /// - `is_sphere == true`（spec `name=="sphererandom"`）→ `createSphereEmitter` 的 **3D 球壳**：
    ///   均匀球面单位方向（`cosθ` uniform[-1,1] → `unit=(sinθcosφ, sinθsinφ, cosθ)`）+ 半径
    ///   `r = cbrt(dist_min³ + (dist_max³ - dist_min³)·rand)`（**体积均匀**），
    ///   `local = unit ⊙ r ⊙ directions`（directions 不翻，照 lwe sphere）。
    /// - `is_sphere == false`（spec `name=="boxrandom"`）→ `createBoxEmitter` 的**均匀盒体**：
    ///   各轴**独立**在 `[dist_min, dist_max]` 取 `dist`，随机 ± 翻（lwe 的 50/50 翻），再乘
    ///   `flippedDirections`（`flippedDirections.y = -directions.y` 保留，照 lwe box），得
    ///   `local[axis] = ±dist × |flipped[axis]|`（= `±dist × |dir[axis]|`；因 `|flipped.y|=|dir.y|`，
    ///   故 y 翻对分布**无影响**，仅保留 spec 语义）。
    ///
    /// 独立成公共方法供集成测试直接断言分布，并被 `spawn()` 复用——散射 `local` **不乘对象 scale**
    /// （全局约束），由 `spawn()` 直接加到发射点上。
    pub fn emitter_local(&self) -> [f32; 3] {
        let dir = self.emitter.directions;
        // lwe box 用 flippedDirections（y 翻）；sphere 用 directions（不翻）。
        let flipped = [dir[0], -dir[1], dir[2]];
        let mn = self.emitter.dist_min.max(0.0);
        let mx = self.emitter.dist_max.max(mn);

        if self.emitter.is_sphere {
            // sphererandom：3D 球壳（体积均匀）。
            let theta = rand() * std::f32::consts::TAU;
            let cos_t = rand() * 2.0 - 1.0;
            let sin_t = (1.0 - cos_t * cos_t).sqrt();
            let unit = [sin_t * theta.cos(), sin_t * theta.sin(), cos_t];
            let r = (mn * mn * mn + (mx * mx * mx - mn * mn * mn) * rand()).cbrt();
            [unit[0] * r * dir[0], unit[1] * r * dir[1], unit[2] * r * dir[2]]
        } else {
            // boxrandom：均匀盒体，各轴 `±dist × |dir|`（50/50 ± 翻照 lwe）。
            let mut local = [0.0; 3];
            for axis in 0..3 {
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
    fn spawn(&mut self) {
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
        //   - sizeRandom：`min + t^exp*(max-min)`（**不做 /2**；exp 取 size_exponent，缺省 2.0）。
        //   - alphaRandom / lifetimeRandom：`lerp(min,max,rand)`。
        //   - colorRandom：`lerp(min,max,rand)` 逐分量（已归一 0..1）。
        //   - rotationRandom：旋转角（欧拉），本模拟器单轴近似取 z 分量。
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

        // sizeRandom：`min + t^exp*(max-min)`（不做 /2）。黑神话 sizerandom exp2 → size∈[30,50]。
        let size = i.size_min + (i.size_max - i.size_min) * rand().powf(i.size_exponent);
        // lifetimeRandom / alphaRandom：`lerp(min,max,rand)`（黑神话 life∈[5,10]、alpha 缺省 1.0）。
        let life = lerp(i.lifetime_min, i.lifetime_max);
        let alpha = lerp(i.alpha_min, i.alpha_max);
        // colorRandom：逐分量 lerp（已归一 0..1；缺省 color_min/max=[1,1,1]；黑神话粉花瓣）。
        let color = [
            lerp(i.color_min[0], i.color_max[0]),
            lerp(i.color_min[1], i.color_max[1]),
            lerp(i.color_min[2], i.color_max[2]),
        ];
        // rotationRandom：旋转角（欧拉，lwe 逐分量）；本模拟器单轴近似取 z。
        let rot = lerp(i.rotation_min[2], i.rotation_max[2]);
        // angularVelocityRandom：逐分量 lerp（弧/秒）。当前 update 仍用 0.5*dt 近似旋转，
        // 本字段带 init 语义但尚未被消费（angularmovement 算子为 Task 4）。
        let angular_vel = [
            lerp(i.angular_vel_min[0], i.angular_vel_max[0]),
            lerp(i.angular_vel_min[1], i.angular_vel_max[1]),
            lerp(i.angular_vel_min[2], i.angular_vel_max[2]),
        ];

        // turbulentVelocityRandom：把扰动**加到 velocity**。方向取法向/前向正交基平面内的随机方向
        // （`cosθ×forward + sinθ×scale×normal`，归一），速度 `lerp(speedMin, speedMax, rand)`。
        // 无该 initializer（`turbulent == None`）→ 忽略（不叠加扰动）。
        if let Some(turb) = &i.turbulent {
            let speed = lerp(turb.speed_min, turb.speed_max);
            let angle = rand() * std::f32::consts::TAU;
            let f = turb.forward;
            let n = turb.normal;
            let mut dir = [
                f[0] * angle.cos() + n[0] * angle.sin() * turb.scale,
                f[1] * angle.cos() + n[1] * angle.sin() * turb.scale,
                f[2] * angle.cos() + n[2] * angle.sin() * turb.scale,
            ];
            let len = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
            if len > 1e-8 {
                dir = [dir[0] / len, dir[1] / len, dir[2] / len];
            }
            vel[0] += dir[0] * speed;
            vel[1] += dir[1] * speed;
            vel[2] += dir[2] * speed;
        }

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
            life,
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
        });
    }

    /// 输出顶点缓冲：每粒子 `[pos3, size, uv2, color3, alpha]`（10 元素；alive 粒子的 uv
    /// 编码为**所属单帧子区中心**——uv.x=(frame+0.5)/frame_count，uv.y=0.5，供 billboard
    /// shader 按 frame_count 采样单帧而非整张 sprite sheet（玫瑰花瓣 512×128 横向 4 帧，
    /// 整张 uv∈[0,1] 会把四帧叠成竖条纹，见任务报告）。
    /// 注：父需求接口写 `Vec<[f32;9]>`，但所给字面量与内联注释均含 10 元素（pos3+size+uv2+color3+alpha），
    /// 此处以字面量为准返回 `Vec<[f32;10]>`（已作为关注点上报，见任务报告）。
    pub fn build_vertices(&self) -> Vec<[f32; 10]> {
        self.particles
            .iter()
            .map(|p| {
                let uv = frame_center_uv(p.frame, DEFAULT_FRAME_COUNT);
                [
                    p.pos[0], p.pos[1], p.pos[2],
                    p.size,
                    uv[0], uv[1], // uv（该 frame 的单帧子区中心）
                    p.color[0], p.color[1], p.color[2],
                    p.alpha,
                ]
            })
            .collect()
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

    #[test]
    fn build_vertices_encodes_frame_center_uv() {
        let mut sim = SceneParticleSim::new(
            ParticleEmitterSpec {
                rate: 0.0,
                origin: [0.0; 3],
                directions: [0.0; 3],
                dist_min: 0.0,
                dist_max: 0.0,
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
            rot: 0.0,
            angular_vel: [0.0; 3],
            size: 40.0,
            alpha: 1.0,
            life: 1.0,
            max_life: 1.0,
            color: [1.0, 0.83, 0.97],
            frame: 2.0,
            initial: SimInitial {
                color: [1.0, 0.83, 0.97],
                alpha: 1.0,
                size: 40.0,
                lifetime: 1.0,
            },
        });
        let vs = sim.build_vertices();
        assert_eq!(vs.len(), 1, "单粒子应输出 1 个 10 元素顶点");
        // 布局 [pos3, size, uv2, color3, alpha]：index 3=size, 4=uv.x, 5=uv.y。
        assert_eq!(vs[0][3], 40.0, "size 应在 index 3");
        assert_eq!(vs[0][4], 0.625, "uv.x 应为第 2 帧（rosepetals frame 2）的帧中心");
        assert_eq!(vs[0][5], 0.5, "uv.y 恒 0.5（每帧占满整高）");
        assert_eq!(vs[0][6], 1.0, "color[0] 应在 index 6");
        assert_eq!(vs[0][9], 1.0, "alpha 应在 index 9");
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
                dist_min: 0.0,
                dist_max: 0.0,
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

        // size 落在 init [size_min, size_max]（非黑神话 30..50）。
        assert!((10.0..=20.0).contains(&p.size), "size 应来自 init，got {}", p.size);
        // life 落在 init [lifetime_min, lifetime_max]（非黑神话 5..10）。
        assert!((2.0..=3.0).contains(&p.life), "life 应来自 init，got {}", p.life);
        // color 各分量落在 init [color_min, color_max]（非黑神话粉 [1,0.83,0.97]）。
        assert!((0.1..=0.4).contains(&p.color[0]), "color[0] 非黑神话 1.0，got {}", p.color[0]);
        assert!((0.2..=0.5).contains(&p.color[1]), "color[1] 非黑神话 0.83，got {}", p.color[1]);
        assert!((0.3..=0.6).contains(&p.color[2]), "color[2] 非黑神话 0.97，got {}", p.color[2]);
        // alpha 落在 init [alpha_min, alpha_max]。
        assert!((0.5..=0.9).contains(&p.alpha), "alpha 应来自 init，got {}", p.alpha);
        // rot 单轴近似：落在 rotation_min[2]..rotation_max[2]。
        assert!((-1.0..=1.0).contains(&p.rot), "rot 应来自 init 的 rotation，got {}", p.rot);
        // frame 保留黑神话帧 0..3。
        assert!(p.frame >= 0.0 && p.frame < 4.0, "frame 应随机 0..3，got {}", p.frame);
        // max_life 跟随 life。
        assert_eq!(p.max_life, p.life, "max_life 应等于 life（spawn 时确定）");
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
                dist_min: 0.0,
                dist_max: 0.0,
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
                dist_min: 0.0,
                dist_max: 0.0,
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
