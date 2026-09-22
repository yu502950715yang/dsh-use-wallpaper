//! Task 4：operators 完整对齐 lwe——`create*Operator`（movement / angularMovement / alphaFade /
//! sizeChange / alphaChange / colorChange / turbulence / oscillateAlpha / oscillateSize /
//! oscillatePosition）测试。
//!
//! 对照 `research/.lwe/src/WallpaperEngine/Render/Objects/CParticle.cpp` 的 `create*Operator`
//! （`OperatorFunc` 语义——**每帧**对每个粒子跑）：
//! - **movement**：`pos += vel*dt`（先），再 `vel += gravity*dt*speed`，再 `vel *= max(1-drag*dt,0)`，
//!   `speed=1.0`（`instanceOverride.speed` 未建模）。黑神话 movement 无 gravity → vel 保持向下。
//! - **angularMovement**：**逐分量** `rot[k] += angularVel[k]*dt`（lwe `CParticle.cpp:1073`），
//!   再 `angularVel[k] += force[k]*dt`、拖拽衰减、各轴独立 wrap 到 ±π（`:1087-1095`）。
//! - **alphaFade**：梯形（存与读 `SimParticle.fade_in/fade_out`；`used=getLifetimePos`；
//!   `used<fadeIn → alpha=initial.alpha*used/fadeIn`；`used>fadeOut → alpha=initial.alpha*(1-used)/(1-fadeOut)`）。
//! - **sizeChange / alphaChange / colorChange**：`fade_value(used, start, end, startVal, endVal)` 随时间。
//! - **turbulence**：对速度做 curl 噪声扰动（`phase`/`turb_speed` 算子级随机一次）。
//! - **oscillateAlpha / Size / Position**：正弦（`(cos(freq*age+phase)+1)/2`；base 由 alphafade/sizechange 更新）。
//! - **寿命 compaction**：`age += dt`（=`life -= dt`）；`isAlive`（`life>0`）；死亡移除保持 spawn 顺序。
//!
//! 该文件全程 native 可测（纯 Rust 数学，无 wgpu / wasm）。RNG 为进程级 Xorshift32（确定性、共享），
//! 测试用 `min==max` 或预置粒子状态消除随机性。

use we_scene_wasm::particle::sim::{
    OscState, OscState3, ParticleEmitterSpec, ParticleInitSpec, ParticleOperator, SceneParticleSim,
    SimInitial, SimParticle,
};

/// scene 默认正交尺寸（黑神话 scene.pkg，非 view cover）。
const SCENE_W: f32 = 3840.0;
const SCENE_H: f32 = 2160.0;
const TWO_PI: f32 = std::f32::consts::TAU;

/// 中性 init：vel=0（粒子停留发射点，位置断言确定）、寿命极大（多次 update 仍存活）、
/// size/color/alpha 中性，使结论只与算子相关。
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

/// 构造一个**发射点=0、不发射**（rate=0）的模拟器，并把算子列表装进 `sim.operators`
/// （覆盖 `new()` 的缺省 movement 算子，使被测算子独占）。
fn mk_sim(operators: Vec<ParticleOperator>) -> SceneParticleSim {
    let mut sim = SceneParticleSim::new(
        ParticleEmitterSpec {
            rate: 0.0,
            origin: [0.0; 3],
            directions: [0.0; 3],
            dist_min: [0.0; 3],
            dist_max: [0.0; 3],
            is_sphere: false,
        },
        100,
        [SCENE_W / 2.0, SCENE_H / 2.0, 0.0],
        SCENE_W,
        SCENE_H,
        neutral_init(),
    );
    sim.operators = operators;
    sim
}

/// 手工构造一个确定状态的粒子（字段全 pub，直接字面量；`initial` 复位基准取传入值）。
/// `rot` 参数保持**标量**（写入 z 轴）——本文件的用例只考 z 轴自旋，三轴另有 `sim.rs` 单测
/// （`z_only_rotation_keeps_rng_stream_unchanged`）与 `angular_movement_integrates_all_axes`。
#[allow(clippy::too_many_arguments)]
fn particle(
    pos: [f32; 3],
    vel: [f32; 3],
    rot: f32,
    angular_vel: [f32; 3],
    size: f32,
    alpha: f32,
    life: f32,
    max_life: f32,
    color: [f32; 3],
) -> SimParticle {
    SimParticle {
        pos,
        vel,
        rot: [0.0, 0.0, rot],
        angular_vel,
        size,
        alpha,
        life,
        max_life,
        color,
        frame: 0.0,
        initial: SimInitial {
            color,
            alpha,
            size,
            lifetime: max_life,
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
    }
}

// ---------------------------------------------------------------------------
// movement：`pos += vel*dt`（先）→ `vel += gravity*dt` → `vel *= max(1-drag*dt,0)`。
// ---------------------------------------------------------------------------

#[test]
fn movement_integrates_position_then_applies_gravity() {
    // lwe 顺序：先 `position += velocity*dt`（用**旧** vel），再 `velocity += gravity*dt`。
    // vel.y=0 且 gravity.y=-10 → 一次性验证「先位置后速度」：pos.y 仍 0（用旧 vel.y=0），vel.y 变 -5。
    let mut sim = mk_sim(vec![ParticleOperator::Movement {
        gravity: [0.0, -10.0, 0.0],
        drag: 0.0,
    }]);
    sim.particles.push(particle(
        [0.0, 0.0, 0.0],
        [2.0, 0.0, 0.0],
        0.0,
        [0.0; 3],
        16.0,
        1.0,
        100.0,
        100.0,
        [1.0; 3],
    ));
    sim.update(0.5);
    let p = &sim.particles[0];
    assert!((p.pos[0] - 1.0).abs() < 1e-6, "pos.x = 0 + vel.x*dt = 2*0.5 = 1, got {}", p.pos[0]);
    // 关键顺序断言：pos.y 用旧 vel.y=0 → 保持 0（若先加速再位移则 pos.y = -2.5）。
    assert!((p.pos[1] - 0.0).abs() < 1e-6, "lwe 先位置后速度：pos.y 用旧 vel.y=0 → 0, got {}", p.pos[1]);
    assert!((p.vel[0] - 2.0).abs() < 1e-6, "vel.x 无重力/阻力，应不变, got {}", p.vel[0]);
    assert!((p.vel[1] - (-5.0)).abs() < 1e-6, "vel.y += gravity.y*dt = -10*0.5 = -5, got {}", p.vel[1]);
}

#[test]
fn movement_drag_decays_velocity() {
    // dragFactor = 1 - drag*dt；clamp 非负（dragFactor<0 → 0，防速度反向）。
    let mut p = particle([0.0; 3], [10.0, 0.0, 0.0], 0.0, [0.0; 3], 16.0, 1.0, 100.0, 100.0, [1.0; 3]);
    let op = ParticleOperator::Movement {
        gravity: [0.0; 3],
        drag: 2.0,
    };
    op.apply(&mut p, 0.5, 0.0); // dragFactor = 1 - 2*0.5 = 0 → vel 归零
    assert!((p.vel[0]).abs() < 1e-6, "drag=2, dt=0.5 → dragFactor=0 → vel 归零, got {}", p.vel[0]);

    let mut p = particle([0.0; 3], [10.0, 0.0, 0.0], 0.0, [0.0; 3], 16.0, 1.0, 100.0, 100.0, [1.0; 3]);
    let op = ParticleOperator::Movement {
        gravity: [0.0; 3],
        drag: 1.0,
    };
    op.apply(&mut p, 0.5, 0.0); // dragFactor = 1 - 0.5 = 0.5 → vel=5
    assert!((p.vel[0] - 5.0).abs() < 1e-6, "drag=1, dt=0.5 → vel 减半=5, got {}", p.vel[0]);
}

// ---------------------------------------------------------------------------
// angularMovement：逐分量 `rot[k] += angularVel[k]*dt`（消费 Task 3 存的 angular_vel）。
// ---------------------------------------------------------------------------

#[test]
fn angular_movement_integrates_all_axes() {
    // 三轴各自独立积分（F4 后续：rot 为欧拉三分量，不再只取 z）：
    // rot=[0,0,0] + ω=[1,2,-3]*dt=0.5 → [0.5, 1.0, -1.5]。
    let mut p = particle(
        [0.0; 3],
        [0.0; 3],
        0.0,
        [1.0, 2.0, -3.0],
        16.0,
        1.0,
        10.0,
        10.0,
        [1.0; 3],
    );
    let op = ParticleOperator::AngularMovement {
        force: [0.0; 3],
        drag: 0.0,
    };
    op.apply(&mut p, 0.5, 0.0);
    for (k, exp) in [0.5_f32, 1.0, -1.5].iter().enumerate() {
        assert!(
            (p.rot[k] - exp).abs() < 1e-6,
            "rot[{}] = angVel[{}]*dt = {}, got {}",
            k,
            k,
            exp,
            p.rot[k]
        );
    }
}

#[test]
fn angular_movement_integrates_rot_by_angular_vel() {
    let mut p = particle(
        [0.0; 3],
        [0.0; 3],
        0.0,
        [0.0, 0.0, 3.0],
        16.0,
        1.0,
        10.0,
        10.0,
        [1.0; 3],
    );
    let op = ParticleOperator::AngularMovement {
        force: [0.0; 3],
        drag: 0.0,
    };
    op.apply(&mut p, 0.5, 0.0);
    assert!((p.rot[2] - 1.5).abs() < 1e-6, "rot[z] += angVel[z]*dt = 3.0*0.5 = 1.5, got {}", p.rot[2]);
    assert!((p.angular_vel[2] - 3.0).abs() < 1e-6, "force=0, drag=0 → angular_vel[z] 不变, got {}", p.angular_vel[2]);
}

#[test]
fn angular_movement_with_force_and_wrap() {
    // rot 初值 3.0，angular_vel.z=4.0，dt=1.0 → rot=7.0 → wrap 到 7-2π≈0.7168；
    // force.z=2.0 → angular_vel.z = 4.0 + 2.0*1.0 = 6.0。
    let mut p = particle(
        [0.0; 3],
        [0.0; 3],
        3.0,
        [0.0, 0.0, 4.0],
        16.0,
        1.0,
        10.0,
        10.0,
        [1.0; 3],
    );
    let op = ParticleOperator::AngularMovement {
        force: [0.0, 0.0, 2.0],
        drag: 0.0,
    };
    op.apply(&mut p, 1.0, 0.0);
    let expected = 7.0 - TWO_PI;
    assert!((p.rot[2] - expected).abs() < 1e-4, "rot[z] 应被 wrap 到 ±π（7-2π≈0.7168）, got {}", p.rot[2]);
    assert!((p.angular_vel[2] - 6.0).abs() < 1e-6, "angular_vel[z] += force[z]*dt = 6.0, got {}", p.angular_vel[2]);
}

#[test]
fn operators_apply_every_frame() {
    // OperatorFn 语义——每帧跑：2 帧后 rot = ω*2dt。
    let mut sim = mk_sim(vec![ParticleOperator::AngularMovement {
        force: [0.0; 3],
        drag: 0.0,
    }]);
    sim.particles.push(particle(
        [0.0; 3],
        [0.0; 3],
        0.0,
        [0.0, 0.0, 2.0],
        16.0,
        1.0,
        100.0,
        100.0,
        [1.0; 3],
    ));
    sim.update(0.5);
    sim.update(0.5);
    assert!((sim.particles[0].rot[2] - 2.0).abs() < 1e-6, "2 帧累计 rot[z]=ω*2dt=2.0, got {}", sim.particles[0].rot[2]);
}

// ---------------------------------------------------------------------------
// alphaFade：梯形 fadein/out。
// ---------------------------------------------------------------------------

#[test]
fn alpha_fade_trapezoid() {
    // max_life=1 → used = 1 - life。
    let make = |life: f32| {
        let mut p = particle([0.0; 3], [0.0; 3], 0.0, [0.0; 3], 16.0, 1.0, life, 1.0, [1.0; 3]);
        let op = ParticleOperator::AlphaFade {
            fade_in: 0.2,
            fade_out: 0.8,
        };
        op.apply(&mut p, 0.0, 0.0);
        p
    };
    // fade-in 段（used <= fadeIn）：alpha = initial.alpha * used/fadeIn = 1.0*0.1/0.2 = 0.5
    let p = make(0.9);
    assert!((p.alpha - 0.5).abs() < 1e-6, "fade-in 段 alpha=used/fadeIn=0.5, got {}", p.alpha);
    // 梯形存于 SimParticle（Task 4 契约）：fade_in/fade_out 已被算子写入。
    assert!((p.fade_in - 0.2).abs() < 1e-6 && (p.fade_out - 0.8).abs() < 1e-6, "fade_in/out 应存到 SimParticle");
    // 中段（fadeIn < used <= fadeOut）：alpha = initial.alpha = 1.0
    let p = make(0.5);
    assert!((p.alpha - 1.0).abs() < 1e-6, "中段 alpha=initial.alpha=1.0, got {}", p.alpha);
    // fade-out 段（used > fadeOut）：alpha = initial.alpha*(1-used)/(1-fadeOut) = 1.0*0.1/0.2 = 0.5
    let p = make(0.1);
    assert!((p.alpha - 0.5).abs() < 1e-6, "fade-out 段 alpha=(1-used)/(1-fadeOut)=0.5, got {}", p.alpha);
}

#[test]
fn alpha_fade_scales_by_initial_alpha() {
    // initial.alpha=0.5 → fade-in 段 alpha = 0.5 * (used/fadeIn)。
    let mut p = particle([0.0; 3], [0.0; 3], 0.0, [0.0; 3], 16.0, 0.5, 0.9, 1.0, [1.0; 3]);
    let op = ParticleOperator::AlphaFade {
        fade_in: 0.2,
        fade_out: 0.8,
    };
    op.apply(&mut p, 0.0, 0.0);
    assert!((p.alpha - 0.25).abs() < 1e-6, "alpha=initial.alpha*used/fadeIn=0.5*0.5=0.25, got {}", p.alpha);
}

// ---------------------------------------------------------------------------
// sizeChange / alphaChange / colorChange：随时间（getLifetimePos）。
// ---------------------------------------------------------------------------

#[test]
fn size_change_fades_over_lifetime() {
    let op = ParticleOperator::SizeChange {
        start_time: 0.0,
        end_time: 1.0,
        start_value: 1.0,
        end_value: 3.0,
    };
    let mul = |life: f32| {
        let mut p = particle([0.0; 3], [0.0; 3], 0.0, [0.0; 3], 10.0, 1.0, life, 1.0, [1.0; 3]);
        op.apply(&mut p, 0.0, 0.0);
        p
    };
    assert!((mul(1.0).size - 10.0).abs() < 1e-6, "used=0 → size=initial.size*1=10, got {}", mul(1.0).size);
    assert!((mul(0.5).size - 20.0).abs() < 1e-6, "used=0.5 → size=10*(1+2*0.5)=20, got {}", mul(0.5).size);
    assert!((mul(0.0).size - 30.0).abs() < 1e-6, "used=1 → size=10*3=30, got {}", mul(0.0).size);
    // base 跟随 size（供 oscillateSize 组合）。
    let p = mul(0.5);
    assert!((p.oscillate_size.base - p.size).abs() < 1e-6, "oscillateSize.base 应更新为 size");
}

#[test]
fn alpha_change_fades_over_lifetime() {
    let mut p = particle([0.0; 3], [0.0; 3], 0.0, [0.0; 3], 16.0, 0.8, 0.5, 1.0, [1.0; 3]);
    let op = ParticleOperator::AlphaChange {
        start_time: 0.0,
        end_time: 1.0,
        start_value: 0.0,
        end_value: 1.0,
    };
    op.apply(&mut p, 0.0, 0.0);
    // used=0.5 → multiplier=0.5 → alpha=0.8*0.5=0.4
    assert!((p.alpha - 0.4).abs() < 1e-6, "alpha=initial.alpha*multiplier=0.4, got {}", p.alpha);
    // base 跟随 alpha（供 oscillateAlpha 组合）。
    assert!((p.oscillate_alpha.base - p.alpha).abs() < 1e-6, "oscillateAlpha.base 应更新为 alpha");
}

#[test]
fn color_change_fades_per_component() {
    let mut p = particle(
        [0.0; 3],
        [0.0; 3],
        0.0,
        [0.0; 3],
        16.0,
        1.0,
        0.5,
        1.0,
        [1.0; 3],
    );
    let op = ParticleOperator::ColorChange {
        start_time: 0.0,
        end_time: 1.0,
        start_value: [1.0, 0.0, 0.0],
        end_value: [0.0, 1.0, 0.0],
    };
    op.apply(&mut p, 0.0, 0.0);
    // used=0.5：cr=0.5, cg=0.5, cb=0 → color=initial.color*每分量 = [0.5,0.5,0]
    assert!((p.color[0] - 0.5).abs() < 1e-6, "color.r=initial.r*0.5=0.5, got {}", p.color[0]);
    assert!((p.color[1] - 0.5).abs() < 1e-6, "color.g=initial.g*0.5=0.5, got {}", p.color[1]);
    assert!((p.color[2] - 0.0).abs() < 1e-6, "color.b=initial.b*0=0, got {}", p.color[2]);
}

// ---------------------------------------------------------------------------
// turbulence：速度扰动（curl 噪声；phase/turb_speed 算子级随机一次）。
// ---------------------------------------------------------------------------

#[test]
fn turbulence_perturbs_velocity_within_bounds() {
    // min==max → phase=0、turb_speed=5 确定；mask=[1,0,0] 只扰动 x。
    let op = ParticleOperator::turbulence(1.0, 0.0, [1.0, 0.0, 0.0], 5.0, 5.0, 0.0, 0.0);
    let mut sim = mk_sim(vec![op]);
    for i in 0..20 {
        sim.particles.push(particle(
            [i as f32, 0.5, -0.25],
            [0.0; 3],
            0.0,
            [0.0; 3],
            16.0,
            1.0,
            100.0,
            100.0,
            [1.0; 3],
        ));
    }
    sim.update(0.1);
    let mut any = false;
    for p in &sim.particles {
        let dvx = p.vel[0];
        assert!(
            dvx.abs() <= 5.0 * 1.0 * 0.1 + 1e-5,
            "|Δvel.x| 应 ≤ turb_speed*|mask|*dt=0.5, got {}",
            dvx
        );
        assert!(
            p.vel[1].abs() < 1e-6 && p.vel[2].abs() < 1e-6,
            "mask=[1,0,0] → y/z 不受扰动, got {}/{}",
            p.vel[1],
            p.vel[2]
        );
        if dvx.abs() > 1e-6 {
            any = true;
        }
    }
    assert!(any, "扰动应非零（至少一个粒子速度改变）");
}

#[test]
fn turbulence_zero_speed_is_noop() {
    let mut p = particle([0.0; 3], [0.0; 3], 0.0, [0.0; 3], 16.0, 1.0, 100.0, 100.0, [1.0; 3]);
    let op = ParticleOperator::turbulence(1.0, 0.0, [1.0; 3], 0.0, 0.0, 0.0, 0.0);
    op.apply(&mut p, 0.1, 0.0);
    assert!(
        (p.vel[0].abs() + p.vel[1].abs() + p.vel[2].abs()) < 1e-6,
        "turb_speed<=0.0001 → 不扰动（lwe 直接 return）"
    );
}

// ---------------------------------------------------------------------------
// oscillateAlpha / oscillateSize：正弦（base 更新组合）。
// ---------------------------------------------------------------------------

#[test]
fn oscillate_alpha_sine_between_scale_range() {
    // 预置已初始化状态：freq=π、phase=0、base=1.0；算子 scale∈[0.5,1.5]。
    let op = ParticleOperator::OscillateAlpha {
        freq_min: 0.0,
        freq_max: 0.0,
        scale_min: 0.5,
        scale_max: 1.5,
        phase_min: 0.0,
        phase_max: 0.0,
    };
    let setup = |life: f32| {
        let mut p = particle([0.0; 3], [0.0; 3], 0.0, [0.0; 3], 16.0, 1.0, life, 10.0, [1.0; 3]);
        p.oscillate_alpha.frequency = std::f32::consts::PI;
        p.oscillate_alpha.scale = 1.0;
        p.oscillate_alpha.phase = 0.0;
        p.oscillate_alpha.base = 1.0;
        p.oscillate_alpha.initialized = true;
        op.apply(&mut p, 0.0, 0.0);
        p
    };
    // age=0（life=10, max_life=10）：cos(π*0)=1 → multiplier=scaleMax=1.5 → alpha=1.5
    let p = setup(10.0);
    assert!((p.alpha - 1.5).abs() < 1e-5, "age=0 → multiplier=scaleMax=1.5, got {}", p.alpha);
    // age=1（life=9）：cos(π)=−1 → multiplier=scaleMin=0.5 → alpha=0.5
    let p = setup(9.0);
    assert!((p.alpha - 0.5).abs() < 1e-5, "age=1 → multiplier=scaleMin=0.5, got {}", p.alpha);
}

#[test]
fn oscillate_alpha_initializes_from_ranges_once() {
    let mut p = particle([0.0; 3], [0.0; 3], 0.0, [0.0; 3], 16.0, 0.9, 10.0, 10.0, [1.0; 3]);
    let op = ParticleOperator::OscillateAlpha {
        freq_min: 2.0,
        freq_max: 2.0,
        scale_min: 0.5,
        scale_max: 0.5,
        phase_min: 0.0,
        phase_max: 0.0,
    };
    op.apply(&mut p, 0.0, 0.0);
    assert!(p.oscillate_alpha.initialized, "首次应用应置 initialized");
    assert!((p.oscillate_alpha.frequency - 2.0).abs() < 1e-6, "freq 确定性（min==max）");
    assert!((p.oscillate_alpha.base - 0.9).abs() < 1e-6, "base 捕获当前 alpha=0.9");
    // 已初始化后不再重随机。
    p.oscillate_alpha.frequency = 7.0;
    op.apply(&mut p, 0.0, 0.0);
    assert!((p.oscillate_alpha.frequency - 7.0).abs() < 1e-6, "已初始化后不再重随机");
}

#[test]
fn oscillate_size_sine_between_scale_range() {
    let op = ParticleOperator::OscillateSize {
        freq_min: 0.0,
        freq_max: 0.0,
        scale_min: 0.5,
        scale_max: 1.5,
        phase_min: 0.0,
        phase_max: 0.0,
    };
    let mut p = particle([0.0; 3], [0.0; 3], 0.0, [0.0; 3], 20.0, 1.0, 10.0, 10.0, [1.0; 3]);
    p.oscillate_size.frequency = std::f32::consts::PI;
    p.oscillate_size.scale = 1.0;
    p.oscillate_size.phase = 0.0;
    p.oscillate_size.base = 20.0;
    p.oscillate_size.initialized = true;
    op.apply(&mut p, 0.0, 0.0); // age=0 → multiplier=scaleMax=1.5 → size=30
    assert!((p.size - 30.0).abs() < 1e-5, "age=0 → size=base*scaleMax=30, got {}", p.size);
}

// ---------------------------------------------------------------------------
// oscillatePosition：逐轴正弦位移（cos 的导数形式）。
// ---------------------------------------------------------------------------

#[test]
fn oscillate_position_moves_by_derivative() {
    let mut p = particle([0.0; 3], [0.0; 3], 0.0, [0.0; 3], 16.0, 1.0, 10.0, 10.0, [1.0; 3]);
    p.oscillate_position.frequency = [1.0; 3];
    p.oscillate_position.scale = [1.0; 3];
    p.oscillate_position.phase = [0.0; 3];
    p.oscillate_position.initialized = true;
    // age = π/2（life = max_life - π/2）：sin(age)=1 → delta = -scale*freq*1*dt。
    p.life = 10.0 - std::f32::consts::PI / 2.0;
    let op = ParticleOperator::OscillatePosition {
        freq_min: 0.0,
        freq_max: 0.0,
        scale_min: 0.0,
        scale_max: 0.0,
        phase_min: 0.0,
        phase_max: 0.0,
        mask: [1.0; 3],
    };
    op.apply(&mut p, 1.0, 0.0);
    for axis in 0..3 {
        assert!(
            (p.pos[axis] - (-1.0)).abs() < 1e-4,
            "pos[{}] 应 -= scale*freq*sin(age)*dt = -1, got {}",
            axis,
            p.pos[axis]
        );
    }
}

#[test]
fn oscillate_position_respects_mask() {
    let mut p = particle([0.0; 3], [0.0; 3], 0.0, [0.0; 3], 16.0, 1.0, 10.0, 10.0, [1.0; 3]);
    p.oscillate_position.frequency = [1.0; 3];
    p.oscillate_position.scale = [1.0; 3];
    p.oscillate_position.phase = [0.0; 3];
    p.oscillate_position.initialized = true;
    p.life = 10.0 - std::f32::consts::PI / 2.0;
    let op = ParticleOperator::OscillatePosition {
        freq_min: 0.0,
        freq_max: 0.0,
        scale_min: 0.0,
        scale_max: 0.0,
        phase_min: 0.0,
        phase_max: 0.0,
        mask: [1.0, 0.0, 0.0],
    };
    op.apply(&mut p, 1.0, 0.0);
    assert!((p.pos[0] - (-1.0)).abs() < 1e-4, "x 轴受 mask=1 扰动, got {}", p.pos[0]);
    assert!((p.pos[1]).abs() < 1e-6 && (p.pos[2]).abs() < 1e-6, "mask=0 轴不受扰, got {}/{}", p.pos[1], p.pos[2]);
}

// ---------------------------------------------------------------------------
// 寿命 compaction：age+=dt（=life-=dt）；isAlive（life>0）；死亡移除保持 spawn 顺序（index 0 最老）。
// ---------------------------------------------------------------------------

#[test]
fn lifecycle_compaction_removes_dead_preserving_order() {
    let mut sim = mk_sim(vec![]); // 无算子：仅验证寿命 compaction。
    sim.particles.push(particle([0.0; 3], [0.0; 3], 0.0, [0.0; 3], 16.0, 1.0, 1.0, 1.0, [1.0; 3])); // a（最老）
    sim.particles.push(particle([10.0; 3], [0.0; 3], 0.0, [0.0; 3], 16.0, 1.0, 0.05, 1.0, [1.0; 3])); // b（将死）
    sim.particles.push(particle([20.0; 3], [0.0; 3], 0.0, [0.0; 3], 16.0, 1.0, 1.0, 1.0, [1.0; 3])); // c
    sim.update(0.1);
    assert_eq!(sim.particles.len(), 2, "寿命<dt 的粒子死亡，应存活 2 个, got {}", sim.particles.len());
    // 死亡移除且**顺序保持**：index 0 恒为最老（a），index 1 为 c；b（死亡）被剔除。
    assert!((sim.particles[0].pos[0] - 0.0).abs() < 1e-6, "index 0 应为 a（最老）, got {}", sim.particles[0].pos[0]);
    assert!((sim.particles[1].pos[0] - 20.0).abs() < 1e-6, "index 1 应为 c, got {}", sim.particles[1].pos[0]);
}

#[test]
fn compaction_keeps_oldest_at_index_zero_after_many_frames() {
    // 发射若干帧后再死亡，验证「index 0 恒为最老」。
    let mut sim = mk_sim(vec![ParticleOperator::Movement {
        gravity: [0.0; 3],
        drag: 0.0,
    }]);
    // 直接用 init 生命周期：rate=0 不发射，手动推入如三个「年龄递增」粒子（用 life 表示剩余寿命）。
    // life 越大 = 越年轻（剩余寿命多）；故 index 0（life 小）最老。
    sim.particles.push(particle([0.0; 3], [0.0; 3], 0.0, [0.0; 3], 16.0, 1.0, 0.4, 1.0, [1.0; 3])); // 最老
    sim.particles.push(particle([1.0; 3], [0.0; 3], 0.0, [0.0; 3], 16.0, 1.0, 0.8, 1.0, [1.0; 3]));
    sim.particles.push(particle([2.0; 3], [0.0; 3], 0.0, [0.0; 3], 16.0, 1.0, 1.0, 1.0, [1.0; 3])); // 最年轻
    sim.update(0.05); // 0.4→0.35, 0.8→0.75, 1.0→0.95（全存活）
    assert_eq!(sim.particles.len(), 3);
    assert!((sim.particles[0].pos[0] - 0.0).abs() < 1e-6, "index 0 仍最老, got {}", sim.particles[0].pos[0]);
    sim.update(0.5); // 0.35→-0.15(死), 0.75→0.25, 0.95→0.45 → 移除 index0
    assert_eq!(sim.particles.len(), 2);
    assert!((sim.particles[0].pos[0] - 1.0).abs() < 1e-6, "死亡移除后 index 0 为次老, got {}", sim.particles[0].pos[0]);
}
