//! CPU 粒子模拟器（SceneParticleSim，Task 2）：逐粒子按 linux-wallpaperengine CParticle 语义模拟。
//! 与 GPU compute 路径（render/particle_pass.rs）不同，本模拟器在 CPU 端维护 `Vec<SimParticle>`，
//! 每帧 update 累计发射（emission_timer）、积分运动/寿命、回收死亡粒子，再由 build_vertices 输出
//! 顶点缓冲供渲染（Task 3/4）。
//!
//! 坐标约定（对齐 linux CParticle，见 coords.rs）：
//! - 对象中心用 `we_to_center`（we 屏幕 y 向下 → 中心原点 y 向上，Y 翻）。
//! - emitter.origin 为局部偏移，其 y 用 `emitter_origin_y_neg`（-y）。
//! - view_h 用 cover 相机半高（如 1906），非 scene 正交高度。
//! 粒子位置**不乘对象 scale**（全局约束）。
//!
//! 伪随机：先用进程级线程安全 Xorshift32（确定性，非加密），Task 4 再接入种子/发射器级状态。

use crate::coords::{emitter_origin_y_neg, we_to_center};
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
    /// 发射器在对象局部坐标中的偏移（y 在 spawn 时做 Y 翻）。
    pub origin: [f32; 3],
    /// 发射方向（分摊到各轴；球壳半径沿它缩放）。
    pub directions: [f32; 3],
    pub dist_min: f32,
    pub dist_max: f32,
    /// 是否球壳散射（当前 spawn 统一按 3D 球壳，见 spawn 注释）。
    pub is_sphere: bool,
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
}

impl SceneParticleSim {
    pub fn new(
        e: ParticleEmitterSpec,
        maxcount: u32,
        obj_origin: [f32; 3],
        view_w: f32,
        view_h: f32,
    ) -> Self {
        Self {
            maxcount,
            obj_origin,
            view_w,
            view_h,
            emission_timer: 0.0,
            particles: Vec::new(),
            emitter: e,
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

        // 发射点 = 对象中心（Y 翻）+ emitter.origin（Y 翻局部偏移）
        let c = we_to_center(self.obj_origin, self.view_w, self.view_h);
        let mut pos = [
            c[0] + self.emitter.origin[0],
            c[1] + emitter_origin_y_neg(self.emitter.origin[1]),
            c[2] + self.emitter.origin[2],
        ];
        pos[0] += local[0];
        pos[1] += local[1];
        pos[2] += local[2];

        // 速度：向下（黑神话向下飘）—— vel.y ∈ [-50,-15]；x ∈ [-50,0]
        let vel = [-50.0 + rand() * 50.0, -50.0 + rand() * 35.0, 0.0];

        // 初始属性（照 black spec）
        let size = 30.0 + (50.0 - 30.0) * rand().powf(2.0); // sizerandom exp2
        let life = 5.0 + rand() * (10.0 - 5.0);
        let alpha = 1.0;
        let color = [1.0, 0.83, 0.97]; // 粉花瓣（color 近似）
        let rot = rand() * 6.28318;
        let frame = 0.0;

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

    /// 输出顶点缓冲：每粒子 `[pos3, size, uv2, color3, alpha]`（10 元素；alive 粒子 uv=[0.5,0.5]）。
    /// 注：父需求接口写 `Vec<[f32;9]>`，但所给字面量与内联注释均含 10 元素（pos3+size+uv2+color3+alpha），
    /// 此处以字面量为准返回 `Vec<[f32;10]>`（已作为关注点上报，见任务报告）。
    pub fn build_vertices(&self) -> Vec<[f32; 10]> {
        self.particles
            .iter()
            .map(|p| {
                [
                    p.pos[0], p.pos[1], p.pos[2],
                    p.size,
                    0.5, 0.5, // uv（alive 默认中心）
                    p.color[0], p.color[1], p.color[2],
                    p.alpha,
                ]
            })
            .collect()
    }
}
