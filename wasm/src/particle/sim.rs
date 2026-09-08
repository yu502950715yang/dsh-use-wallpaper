//! CPU 粒子模拟器（SceneParticleSim，Task 2）：逐粒子按 linux-wallpaperengine CParticle 语义模拟。
//! 与 GPU compute 路径（render/particle_pass.rs）不同，本模拟器在 CPU 端维护 `Vec<SimParticle>`，
//! 每帧 update 累计发射（emission_timer）、积分运动/寿命、回收死亡粒子，再由 build_vertices 输出
//! 顶点缓冲供渲染（Task 3/4）。
//!
//! 坐标约定（对齐 linux CParticle，见 coords.rs）：
//! - 对象中心用 `we_to_center`（we 屏幕 y 向下 → 中心原点 y 向上，Y 翻）。
//! - emitter.origin 为局部偏移，其 y **不翻**：we 屏幕 y 向下、中心原点 y 向上，
//!   origin.y>0 → 发射点抬到中心**上方**（黑神话 origin.y=750 → 从屏幕上方发射）。
//! - view_h 用 cover 相机半高（如 1906），非 scene 正交高度。
//! 粒子位置**不乘对象 scale**（全局约束）。
//!
//! 伪随机：先用进程级线程安全 Xorshift32（确定性，非加密），Task 4 再接入种子/发射器级状态。

use crate::coords::we_to_center;
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

/// 单粒子状态（对应 WE CParticle）。
pub struct SimParticle {
    pub pos: [f32; 3],
    pub vel: [f32; 3],
    pub rot: f32,
    pub size: f32,
    pub alpha: f32,
    pub life: f32,
    pub max_life: f32,
    pub color: [f32; 3],
    pub frame: f32,
}

/// 发射器规格（对齐 linux createSphereEmitter）。
pub struct ParticleEmitterSpec {
    pub rate: f32,
    /// 发射器在对象局部坐标中的偏移（y 在 spawn 时**不翻**：+y 抬到中心上方，
    /// 黑神话 origin.y=750 → 从屏幕上方发射；origin.y=0 的壁纸（EVA/DK 等）不受影响）。
    pub origin: [f32; 3],
    /// 发射方向（分摊到各轴；球壳半径沿它缩放）。
    pub directions: [f32; 3],
    pub dist_min: f32,
    pub dist_max: f32,
    /// 是否球壳散射（当前 spawn 统一按 3D 球壳，见 spawn 注释）。
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
}

/// 场景粒子模拟器（CPU）。
pub struct SceneParticleSim {
    pub maxcount: u32,
    /// 对象中心（WE 坐标，y 为距底部距离）。
    pub obj_origin: [f32; 3],
    /// 视口宽（cover/canvas 全宽，坐标映射用）。
    pub view_w: f32,
    /// 相机半高（cover，如 1906）。
    pub view_h: f32,
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
        view_w: f32,
        view_h: f32,
        init: ParticleInitSpec,
    ) -> Self {
        Self {
            maxcount,
            obj_origin,
            view_w,
            view_h,
            emission_timer: 0.0,
            particles: Vec::new(),
            emitter: e,
            init,
        }
    }

    /// 每帧推进：累计发射 → 积分运动/寿命 → 回收死亡粒子。
    pub fn update(&mut self, dt: f32) {
        // 累积出生率（照 linux：emission_timer += dt*rate；>=1 发射并减 1）
        self.emission_timer += dt * self.emitter.rate;
        while self.emission_timer >= 1.0 && (self.particles.len() as u32) < self.maxcount {
            self.spawn();
            self.emission_timer -= 1.0;
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

    /// 发射一个粒子（照 linux createSphereEmitter 3D 球壳）。
    fn spawn(&mut self) {
        // 3D 球壳：均匀球面单位方向
        let theta = rand() * 6.28318;
        let cos_t = rand() * 2.0 - 1.0;
        let sin_t = (1.0 - cos_t * cos_t).sqrt();
        let unit = [sin_t * theta.cos(), sin_t * theta.sin(), cos_t];

        // 半径：dist_min..dist_max 立方根均匀（球体内均匀分布，`is_sphere` 现统一按球壳/球体处理）
        let mn = self.emitter.dist_min.max(0.0);
        let mx = self.emitter.dist_max.max(mn);
        let r = (mn * mn * mn + (mx * mx * mx - mn * mn * mn) * rand()).powf(1.0 / 3.0);
        let d = self.emitter.directions;
        let local = [unit[0] * r * d[0], unit[1] * r * d[1], unit[2] * r * d[2]];

        // 发射点 = 对象中心（Y 翻）+ emitter.origin（局部偏移，y **不翻**）：
        // 黑神话 origin.y=750 → pos.y = c[1]+750 = 1283.23，落在屏幕**上方**（>视口中线 953）；
        // 而 origin.y=0 的壁纸（EVA/DK 等）与旧实现（-0）等价，不受影响。
        let c = we_to_center(self.obj_origin, self.view_w, self.view_h);
        let mut pos = [
            c[0] + self.emitter.origin[0],
            c[1] + self.emitter.origin[1],
            c[2] + self.emitter.origin[2],
        ];
        pos[0] += local[0];
        pos[1] += local[1];
        pos[2] += local[2];

        // 初始属性来自 `self.init`（每个壁纸 spec.init 的 velocityrandom/sizerandom/
        // lifetimerandom/colorrandom/alpharandom/rotationrandom），不再黑神话硬编码
        // （Important I1：EVA/DK/Crimson 等无 effects 粒子对象也用各自 spec.init，
        // 背景/图层不受影响，只改 CPU 粒子初始化）。
        let i = &self.init;
        // [0,1) 上逐分量线性插值：`a + (b-a)*rand`。
        let lerp = |a: f32, b: f32| a + (b - a) * rand();

        // 速度：各分量在 [min,max] 线性插值。黑神话 velocity_min=[-50,-50,0]、
        // velocity_max=[0,-15,0] → vel.y ∈ [-50,-15]（向下飘），行为保持。
        let vel = [
            lerp(i.velocity_min[0], i.velocity_max[0]),
            lerp(i.velocity_min[1], i.velocity_max[1]),
            lerp(i.velocity_min[2], i.velocity_max[2]),
        ];

        // 尺寸：min + (max-min)*rand^exponent（黑神话 sizerandom exp2 → size∈[30,50]）。
        let size = i.size_min + (i.size_max - i.size_min) * rand().powf(i.size_exponent);
        // 寿命：lerp(lifetime_min, lifetime_max, rand)（黑神话 life∈[5,10]）。
        let life = lerp(i.lifetime_min, i.lifetime_max);
        // alpha：lerp(alpha_min, alpha_max, rand)（缺省 min=max=1.0 → alpha=1.0）。
        let alpha = lerp(i.alpha_min, i.alpha_max);
        // 颜色：各分量线性插值（缺省 color_min/max=[1,1,1]；黑神话为粉花瓣）。
        let color = [
            lerp(i.color_min[0], i.color_max[0]),
            lerp(i.color_min[1], i.color_max[1]),
            lerp(i.color_min[2], i.color_max[2]),
        ];
        // 初始旋转角：rotation_min[2]..rotation_max[2] 单轴近似（缺省 [0,0,0] → rot=0）。
        let rot = lerp(i.rotation_min[2], i.rotation_max[2]);
        // 帧 id 随机取 0..3（rosepetals sprite sheet 4 帧；否则所有花瓣固定采样同帧）。
        // rand() ∈ [0,1) → *4 ∈ [0,4) → floor ∈ {0,1,2,3}。
        let frame = (rand() * DEFAULT_FRAME_COUNT as f32).floor();

        self.particles.push(SimParticle {
            pos,
            vel,
            rot,
            size,
            alpha,
            life,
            max_life: life,
            color,
            frame,
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
            1906.0,
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
            },
        );
        sim.particles.push(SimParticle {
            pos: [1.0, 2.0, 3.0],
            vel: [0.0; 3],
            rot: 0.0,
            size: 40.0,
            alpha: 1.0,
            life: 1.0,
            max_life: 1.0,
            color: [1.0, 0.83, 0.97],
            frame: 2.0,
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
            1906.0,
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
        }
    }

    /// 黑神话从**屏幕上方**发射（Task 5 修复：spawn 的 pos.y 不再对 emitter.origin.y 取负）。
    /// we_to_center(2306.34,419.77, 3840,1906) → c[1]=953-419.77=533.23；origin.y=750 **不翻**
    /// → pos.y=533.23+750=1283.23（>视口中线 953，屏幕上方）。修复前 `-750` → -216.77（中心下方）。
    #[test]
    fn black_myth_emits_from_above_center() {
        let mut sim = SceneParticleSim::new(
            ParticleEmitterSpec {
                rate: 0.0,
                origin: [350.0, 750.0, 0.0],
                directions: [0.0; 3], // 局部球壳偏移为 0 → pos.y 确定
                dist_min: 0.0,
                dist_max: 0.0,
                is_sphere: false,
            },
            8,
            [2306.34, 419.77, 0.0],
            3840.0,
            1906.0,
            default_init(),
        );
        sim.spawn();
        assert_eq!(sim.particles.len(), 1);
        let y = sim.particles[0].pos[1];
        // 在中心原点之上，且高于视口中线（视口半高 953）——黑神话从上方发射。
        assert!(y > 0.0, "黑神话应从中心上方发射，got {}", y);
        assert!(y > 1906.0 / 2.0, "黑神话发射点应高于屏幕中线，got {}", y);
        // 精确值：c[1]+origin.y = 533.23+750 = 1283.23。
        assert!((y - 1283.23).abs() < 1e-3, "pos.y 应为 1283.23（不翻），got {}", y);
    }

    /// origin.y=0 的壁纸（EVA/DK 等）：不翻与旧实现（-0）等价，发射点即对象中心上方 c[1]，不受影响。
    #[test]
    fn emitter_origin_zero_is_unaffected_by_y_flip() {
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
            1906.0,
            default_init(),
        );
        sim.spawn();
        assert_eq!(sim.particles.len(), 1);
        let y = sim.particles[0].pos[1];
        // c[1] = 953 - 419.77 = 533.23；origin.y=0 → pos.y = c[1]（不翻与翻等价）。
        assert!((y - 533.23).abs() < 1e-3, "origin.y=0 时 pos.y 应为对象中心上方 c[1]=533.23，got {}", y);
    }
}
