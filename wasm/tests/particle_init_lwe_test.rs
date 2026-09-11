//! Task 3：initializers 完整对齐 lwe——`create*RandomInitializer`（color/size/alpha/lifetime/velocity/
//! rotation/angularVelocity/turbulentVelocity random）测试。
//!
//! 对照 `research/.lwe/src/WallpaperEngine/Render/Objects/CParticle.cpp` 的 `create*RandomInitializer`：
//! - **sizeRandom**：`size = (min + t^exp*(max-min)) / 2`（对齐 lwe `createSizeRandomInitializer`：
//!   编辑器值 /2 后存为 `p.size`，因为 WE 粒子 shader 里该值就是 billboard 的**整宽**；
//!   exp 用 `size_exponent`，WE/lwe 缺省 1.0，黑神话显式 2）。
//! - **velocityRandom**：`vel = lerp(min,max,rand)` 逐分量（本模拟器坐标经 `we_to_three`（Y 向上）**已免翻**，
//!   spec 无 velocity.y 翻开关 → y 不翻）。
//! - **colorRandom**：`color = lerp(min,max,rand)` 逐分量（已归一 0..1）。
//! - **lifetimeRandom / alphaRandom**：`lerp(min,max,rand)`。
//! - **rotationRandom**：旋转角（欧拉），本模拟器单轴近似取 z 分量。
//! - **angularVelocityRandom**：`lerp(min,max,rand)` 逐分量（弧/秒）。
//! - **turbulentVelocityRandom**：基于法向/前向正交基的随机方向扰动（`cosθ×forward + sinθ×scale×normal`，归一），
//!   加上 `speed ∈ [speedMin, speedMax]`，**加到 velocity**；无该 initializer（`turbulent == None`）→ 忽略。
//! - **frame**：randomframe，0..spritesheetFrames-1。
//! - **initial 复位基准**：对应 lwe `ParticleInstance::initial`（color/alpha/size/lifetime 存 spawn 初值，
//!   供 operators/reset）。
//!
//! 该文件全程 native 可测（纯 Rust 数学，无 wgpu / wasm）。RNG 为进程级 Xorshift32，测试断言均为
//! **分布界/均值/趋势**（非逐值），并行执行亦稳健。

use we_scene_wasm::particle::{ParticleEmitterSpec, ParticleInitSpec, SceneParticleSim, SimParticle, TurbulentInit};

/// scene 默认正交尺寸（黑神话 scene.pkg，非 view cover）。
const SCENE_W: f32 = 3840.0;
const SCENE_H: f32 = 2160.0;

/// 中性 init：vel=0（粒子停留发射点）、寿命极大（多次 update 仍存活）、size/color/alpha 中性，
/// 使断言只与被测 initializer 相关。
fn neutral_init() -> ParticleInitSpec {
    ParticleInitSpec {
        lifetime_min: 1000.0,
        lifetime_max: 1000.0,
        size_min: 16.0,
        size_max: 16.0,
        size_exponent: 1.0,
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

/// 用给定 init 构造**发射点=0**的模拟器（origin=0、obj_origin=scene 中心 → `we_to_three`=[0,0,0]），
/// 单次 `update(0.01)` 触发一次大批量发射（rate×dt=500，dt 足够小使积分副作用——`rot += 0.5*dt` 与
/// `life -= dt`——可忽略），返回生成的粒子供断言初始值。
fn spawn_batch(init: ParticleInitSpec) -> Vec<SimParticle> {
    let mut sim = SceneParticleSim::new(
        ParticleEmitterSpec {
            rate: 50_000.0,
            origin: [0.0; 3],
            directions: [0.0; 3],
            dist_min: [0.0; 3],
            dist_max: [0.0; 3],
            is_sphere: false,
        },
        600,
        [SCENE_W / 2.0, SCENE_H / 2.0, 0.0], // we_to_three → [0,0,0]
        SCENE_W,
        SCENE_H,
        init,
    );
    sim.update(0.01);
    assert!(sim.particles.len() >= 300, "应有足够样本，got {}", sim.particles.len());
    sim.particles
}

/// 均值。
fn mean(v: &[f32]) -> f32 {
    v.iter().sum::<f32>() / v.len() as f32
}

// ---------------------------------------------------------------------------
// sizerandom：`(min + t^exp*(max-min)) / 2`（WE/lwe `createSizeRandomInitializer` 的 /2），exp 幂。
// ---------------------------------------------------------------------------

#[test]
fn size_random_uses_exponent_and_halves() {
    let mut init = neutral_init();
    init.size_min = 10.0;
    init.size_max = 50.0;
    init.size_exponent = 2.0;
    let ps = spawn_batch(init);

    let sizes: Vec<f32> = ps.iter().map(|p| p.size).collect();
    let max_size = sizes.iter().cloned().fold(f32::MIN, f32::max);
    let mean_size = mean(&sizes);

    // WE/lwe：sizerandom 编辑器值 **/2** 存为该粒子的 quad 整宽 → 全部落在 [5, 25]。
    for &s in &sizes {
        assert!((5.0..=25.0).contains(&s), "size 应在 [10/2, 50/2]=[5,25]，got {}", s);
    }
    // /2：上限 = 50/2 = 25，故不存在 >25 的值。
    assert!(max_size <= 25.0, "sizerandom 应 /2（上限 25），max_size={}", max_size);
    // exp=2 向 min 偏（mean≈11.7 < 线性中点 15）——与 lwe `pow(t, exponent)` 一致。
    assert!(mean_size < 14.0, "exp=2 应偏 min，mean_size={}", mean_size);
    assert!(mean_size > 8.0, "exp=2 均值应 ≈11.7（/2 后），mean_size={}", mean_size);
}

/// sizerandom 的 exponent **来自 spec**（WE/lwe 缺省 1.0）：无 exponent → 均匀分布（均值 ≈ 中点）；
/// 显式 exponent=2 → 向 min 偏。二者都 /2。
#[test]
fn size_random_exponent_default_is_one() {
    let mut uniform = neutral_init();
    uniform.size_min = 10.0;
    uniform.size_max = 50.0;
    uniform.size_exponent = 1.0; // WE/lwe 缺省
    let ps = spawn_batch(uniform);
    let sizes: Vec<f32> = ps.iter().map(|p| p.size).collect();
    let mean_size = mean(&sizes);
    // 均匀 [5,25] → 均值 ≈ 15（±1.5）。
    assert!((13.5..=16.5).contains(&mean_size), "exp=1 应近似均匀（/2 后均值≈15），got {}", mean_size);
    for &s in &sizes {
        assert!((5.0..=25.0).contains(&s), "size ∈ [5,25]，got {}", s);
    }
}

// ---------------------------------------------------------------------------
// velocityrandom：`lerp(min,max,rand)` 逐分量（各轴独立范围 → 各轴均值不同）。
// ---------------------------------------------------------------------------

#[test]
fn velocity_lerp_per_component() {
    let mut init = neutral_init();
    // 各轴范围明显不同，证明逐分量独立 lerp：x∈[0,10]、y∈[0,100]、z∈[0,1]。
    init.velocity_min = [0.0, 0.0, 0.0];
    init.velocity_max = [10.0, 100.0, 1.0];
    let ps = spawn_batch(init);

    let xs: Vec<f32> = ps.iter().map(|p| p.vel[0]).collect();
    let ys: Vec<f32> = ps.iter().map(|p| p.vel[1]).collect();
    let zs: Vec<f32> = ps.iter().map(|p| p.vel[2]).collect();

    for p in &ps {
        assert!((p.vel[0] >= 0.0 && p.vel[0] <= 10.0), "vel.x 应在 [0,10]，got {}", p.vel[0]);
        assert!((p.vel[1] >= 0.0 && p.vel[1] <= 100.0), "vel.y 应在 [0,100]，got {}", p.vel[1]);
        assert!((p.vel[2] >= 0.0 && p.vel[2] <= 1.0), "vel.z 应在 [0,1]，got {}", p.vel[2]);
    }
    // 均值 ≈ 各轴中点（per-component lerp 反映各轴不同范围；非单一标量）。
    assert!((mean(&xs) - 5.0).abs() < 1.0, "vel.x 均值应≈5，got {}", mean(&xs));
    assert!((mean(&ys) - 50.0).abs() < 4.0, "vel.y 均值应≈50，got {}", mean(&ys));
    assert!((mean(&zs) - 0.5).abs() < 0.1, "vel.z 均值应≈0.5，got {}", mean(&zs));
}

// ---------------------------------------------------------------------------
// colorrandom：`lerp(min,max,rand)` 逐分量（已归一 0..1）。
// ---------------------------------------------------------------------------

#[test]
fn color_lerp_normalized() {
    let mut init = neutral_init();
    init.color_min = [0.1, 0.2, 0.3];
    init.color_max = [0.4, 0.5, 0.6];
    let ps = spawn_batch(init);

    for p in &ps {
        // 每分量落在 [min,max]（输入已归一 0..1 → 结果也在 [0,1]）。
        assert!((0.1..=0.4).contains(&p.color[0]), "color[0] 应∈[0.1,0.4]，got {}", p.color[0]);
        assert!((0.2..=0.5).contains(&p.color[1]), "color[1] 应∈[0.2,0.5]，got {}", p.color[1]);
        assert!((0.3..=0.6).contains(&p.color[2]), "color[2] 应∈[0.3,0.6]，got {}", p.color[2]);
    }
    let rs: Vec<f32> = ps.iter().map(|p| p.color[0]).collect();
    let gs: Vec<f32> = ps.iter().map(|p| p.color[1]).collect();
    let bs: Vec<f32> = ps.iter().map(|p| p.color[2]).collect();
    // 均值 ≈ 各轴中点（lerp 均匀）。
    assert!((mean(&rs) - 0.25).abs() < 0.05, "color.r 均值应≈0.25，got {}", mean(&rs));
    assert!((mean(&gs) - 0.35).abs() < 0.05, "color.g 均值应≈0.35，got {}", mean(&gs));
    assert!((mean(&bs) - 0.45).abs() < 0.05, "color.b 均值应≈0.45，got {}", mean(&bs));
}

// ---------------------------------------------------------------------------
// lifetimerandom：`lerp(min,max,rand)`。
// ---------------------------------------------------------------------------

#[test]
fn lifetime_lerp() {
    let mut init = neutral_init();
    init.lifetime_min = 2.0;
    init.lifetime_max = 8.0;
    let ps = spawn_batch(init);

    let lts: Vec<f32> = ps.iter().map(|p| p.initial.lifetime).collect();
    for &lt in &lts {
        assert!((2.0..=8.0).contains(&lt), "lifetime 应∈[2,8]，got {}", lt);
    }
    // 均值 ≈ 中点 5。
    assert!((mean(&lts) - 5.0).abs() < 0.4, "lifetime 均值应≈5，got {}", mean(&lts));
    // initial.lifetime 为 spawn 基准，应等于 max_life（不随 update 的 life 递减而变化）。
    for p in &ps {
        assert!((p.initial.lifetime - p.max_life).abs() < 1e-6, "initial.lifetime 应等于 max_life");
    }
}

// ---------------------------------------------------------------------------
// rotationrandom（z 单轴）/ angularvelocityrandom（逐分量）：均 `lerp(min,max,rand)`。
// ---------------------------------------------------------------------------

#[test]
fn rotation_and_angular_velocity_lerp() {
    let mut init = neutral_init();
    init.rotation_min = [-1.0, -1.0, -1.0];
    init.rotation_max = [1.0, 1.0, 1.0];
    init.angular_vel_min = [-2.0, -2.0, -2.0];
    init.angular_vel_max = [2.0, 2.0, 2.0];
    let ps = spawn_batch(init);

    let rots: Vec<f32> = ps.iter().map(|p| p.rot).collect();
    for p in &ps {
        // rot：z 单轴近似。spawn 后 update 有 `rot += 0.5*dt`（dt=0.01 → 0.005）积分副作用，放宽 0.01。
        assert!((-1.01..=1.01).contains(&p.rot), "rot 应∈[-1,1]，got {}", p.rot);
        // angular_vel：逐分量 lerp（update 不消费，保持 spawn 初值）。
        for k in 0..3 {
            assert!((-2.0..=2.0).contains(&p.angular_vel[k]), "angular_vel[{}] 应∈[-2,2]，got {}", k, p.angular_vel[k]);
        }
    }
    // 均值 ≈ 0（对称范围中点）。
    assert!((mean(&rots) - 0.0).abs() < 0.1, "rot 均值应≈0，got {}", mean(&rots));
    let ax: Vec<f32> = ps.iter().map(|p| p.angular_vel[0]).collect();
    assert!((mean(&ax) - 0.0).abs() < 0.2, "angular_vel.x 均值应≈0，got {}", mean(&ax));
}

// ---------------------------------------------------------------------------
// turbulentvelocityrandom：基于法向/前向正交基的扰动，**加到 velocity**。
// ---------------------------------------------------------------------------

#[test]
fn turbulent_uses_basis_vectors() {
    let mut init = neutral_init();
    // base velocity = 0 → vel 即湍流扰动本身，便于断言。
    init.velocity_min = [0.0; 3];
    init.velocity_max = [0.0; 3];
    init.turbulent = Some(TurbulentInit {
        scale: 1.0,
        speed_min: 40.0,
        speed_max: 60.0,
        normal: [0.0, 0.0, 1.0],  // 法向 +Z
        forward: [0.0, 1.0, 0.0], // 前向 +Y（正交归一）
    });
    let ps = spawn_batch(init);

    let mut any_y = false;
    let mut any_z = false;
    for p in &ps {
        let (x, y, z) = (p.vel[0], p.vel[1], p.vel[2]);
        let speed = (x * x + y * y + z * z).sqrt();
        // 扰动方向 = cosθ×forward + sinθ×scale×normal，在前向/法向平面内（两者均为 Y/Z，x=0）→ x≈0。
        assert!(x.abs() < 1e-3, "湍流扰动应落在前向/法向基平面内（x≈0），vel.x={}", x);
        // 幅度 |speed| 在 [speedMin, speedMax]。
        assert!((speed >= 40.0 - 1e-3 && speed <= 60.0 + 1e-3), "湍流速度应∈[40,60]，got {}", speed);
        // 用了两个基向量：非仅前向（有 z 分量）非仅法向（有 y 分量）。
        if y.abs() > 0.01 { any_y = true; }
        if z.abs() > 0.01 { any_z = true; }
    }
    assert!(any_y, "湍流应使用前向基（有 y 分量）");
    assert!(any_z, "湍流应使用法向基（有 z 分量）");
}

// ---------------------------------------------------------------------------
// initial 复位基准：对应 lwe ParticleInstance::initial（color/alpha/size/lifetime 存 spawn 初值）。
// ---------------------------------------------------------------------------

#[test]
fn initial_reset_baseline_saved() {
    let mut init = neutral_init();
    init.lifetime_min = 3.0;
    init.lifetime_max = 7.0;
    init.size_min = 20.0;
    init.size_max = 80.0;
    init.size_exponent = 1.0;
    init.color_min = [0.2, 0.3, 0.4];
    init.color_max = [0.6, 0.7, 0.8];
    init.alpha_min = 0.3;
    init.alpha_max = 0.9;
    let ps = spawn_batch(init);

    for p in &ps {
        // initial 存 spawn 初值：color/alpha/size 不变（update 无配色/尺寸/alpha 算子）；
        // lifetime 基准 = max_life（spawn 时 life 的初值，不随 update 递减）。
        assert!((p.initial.color[0] - p.color[0]).abs() < 1e-6, "initial.color[0] 应等于 color[0]");
        assert!((p.initial.color[1] - p.color[1]).abs() < 1e-6, "initial.color[1] 应等于 color[1]");
        assert!((p.initial.color[2] - p.color[2]).abs() < 1e-6, "initial.color[2] 应等于 color[2]");
        assert!((p.initial.alpha - p.alpha).abs() < 1e-6, "initial.alpha 应等于 alpha");
        assert!((p.initial.size - p.size).abs() < 1e-6, "initial.size 应等于 size");
        assert!((p.initial.lifetime - p.max_life).abs() < 1e-6, "initial.lifetime 应等于 max_life");

        // 复位基准各自落在对应 init 范围内（证明存的不是黑神话硬编码；size 为 /2 后的值）。
        assert!((3.0..=7.0).contains(&p.initial.lifetime), "initial.lifetime 应∈[3,7]");
        assert!((10.0..=40.0).contains(&p.initial.size), "initial.size 应∈[20/2,80/2]=[10,40]，got {}", p.initial.size);
        assert!((0.3..=0.9).contains(&p.initial.alpha), "initial.alpha 应∈[0.3,0.9]");
    }
}
