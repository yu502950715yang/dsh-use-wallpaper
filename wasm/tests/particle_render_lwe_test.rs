//! Task 5：lwe 对齐 `CParticle::renderSprites` 的渲染层校验。
//!
//! 断言范围：
//! - 17 浮点角点顶点流（`SPRITE_FLOATS_PER_VERTEX=17`、stride 68B）、每粒子 4 角点 + 6 索引，
//!   字段布局（pos3 / uv_rot_size4 / color4 / vel_lifetime4 / rot_x_y2）与 lwe `fillVertices` 一致；
//! - mvp 变换（`viewProjection=ortho(view_w,view_h)`、model=I → `clip=vp×pos`）；
//! - 多帧 / uv 映射（`lifetime` 编码 frame → `floor(frac(lifetime)×frames)` 切片，cols/rows 网格）；
//! - 材质 blend（Additive/Translucent 按材质名）与 overbright；
//! - `particle_billboard.wgsl` naga 校验通过。
//!
//! 渲染正确性（光柱纹理遮罩 / 软圆点 / 多帧切片）由集成/截图验证，native 测试只核数据与 shader 解析。

use we_scene_wasm::particle::sim::{OscState, OscState3, SimInitial, SimParticle};
use we_scene_wasm::particle::{ParticleEmitterSpec, ParticleInitSpec, SceneParticleSim};
use we_scene_wasm::render::effect::validate_wgsl;
use we_scene_wasm::render::particle_render;

const WGSL: &str = include_str!("../src/shaders/particle_billboard.wgsl");

/// 构造一个单粒子模拟器（rosepetals 黑神话花瓣：frame=2、size=40、color 粉、alpha=1、vel 向下、
/// rot=0；`spritesheet_frames=4`）。对象中心/发射点坐标取自 `we_to_three`（scene 尺寸、y 不翻）。
fn single_particle_sim(frame: f32) -> SceneParticleSim {
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
            lifetime_min: 1.0,
            lifetime_max: 1.0,
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
    sim.spritesheet_frames = 4;
    sim.particles.push(SimParticle {
        pos: [1.0, 2.0, 3.0],
        vel: [-10.0, -20.0, 0.0],
        rot: 0.5,
        angular_vel: [0.0; 3],
        size: 40.0,
        alpha: 1.0,
        life: 0.5,
        max_life: 1.0,
        color: [1.0, 0.83, 0.97],
        frame,
        initial: SimInitial { color: [1.0, 0.83, 0.97], alpha: 1.0, size: 40.0, lifetime: 1.0 },
        fade_in: 0.0,
        fade_out: 1.0,
        oscillate_alpha: OscState { frequency: 0.0, scale: 1.0, phase: 0.0, base: 0.0, initialized: false },
        oscillate_size: OscState { frequency: 0.0, scale: 1.0, phase: 0.0, base: 0.0, initialized: false },
        oscillate_position: OscState3 { frequency: [0.0; 3], scale: [0.0; 3], phase: [0.0; 3], initialized: false },
    });
    sim
}

#[test]
fn particle_billboard_wgsl_valid() {
    assert!(validate_wgsl(WGSL), "particle_billboard.wgsl naga 校验失败");
}

#[test]
fn vertex_stream_is_17_floats_per_vertex_4_per_particle() {
    // 单一粒子 → 4 角点顶点（17 浮点 each），顶点流字段数 = 17。
    let sim = single_particle_sim(2.0);
    let vs = sim.build_vertices();
    assert_eq!(vs.len(), 4, "每粒子应输出 4 角点");
    assert!(vs.iter().all(|v| v.len() == particle_render::SPRITE_FLOATS_PER_VERTEX as usize),
        "每角点应 17 浮点");

    // 字段布局（对齐 lwe __fillVertices 注释）：
    //   pos(3) + uv_rot_size(uv.x,uv.y,rot.z,size)(4) + color(r,g,b,a)(4)
    //   + vel_lifetime(vel.x,vel.y,vel.z,lifetime)(4) + rot_x_y(rot.x,rot.y)(2) = 17
    let v0 = &vs[0]; // 角点 0 = (u=0,v=1) 左下
    assert_eq!(&v0[0..3], &[1.0, 2.0, 3.0], "pos 应在 [0..3)");
    assert_eq!(v0[3], 0.0, "uv.x（角点 0）应在 index 3");
    assert_eq!(v0[4], 1.0, "uv.y（角点 0）应在 index 4");
    assert_eq!(v0[5], 0.5, "rot.z 应在 index 5");
    assert_eq!(v0[6], 40.0, "size 应在 index 6");
    assert_eq!(&v0[7..11], &[1.0, 0.83, 0.97, 1.0], "color rgba 应在 [7..11)");
    assert_eq!(&v0[11..14], &[-10.0, -20.0, 0.0], "vel 应在 [11..14)");
    assert!((v0[14] - 0.625).abs() < 1e-6, "lifetime 应编码 frame=2（rosepetals 4 帧）→ (2+0.5)/4");
    assert_eq!(&v0[15..17], &[0.0, 0.0], "rot.x/rot.y 占位应在 [15..17)");

    // 四角点顺序 lwe： (0,1) 左下、(1,1) 右下、(1,0) 右上、(0,0) 左上。
    let us: Vec<(f32, f32)> = vs.iter().map(|v| (v[3], v[4])).collect();
    assert_eq!(us, vec![(0.0, 1.0), (1.0, 1.0), (1.0, 0.0), (0.0, 0.0)]);
}

#[test]
fn vertex_stream_stride_and_attr_layout_match() {
    // stride = 17×4 = 68B；每粒子顶点/索引常量。
    assert_eq!(particle_render::PARTICLE_VERTEX_STRIDE, 68);
    assert_eq!(particle_render::VERTICES_PER_PARTICLE, 4);
    assert_eq!(particle_render::INDICES_PER_PARTICLE, 6);
    // 索引为 lwe renderSprites 的 `[b, b+1, b+2, b+2, b+3, b+0]`。
    assert_eq!(particle_render::build_sprite_indices(2), vec![0, 1, 2, 2, 3, 0, 4, 5, 6, 6, 7, 4]);
}

#[test]
fn mvp_ortho_view_projection_maps_world_to_ndc() {
    // model = I；viewProjection = centered ortho(view_w, view_h) = diag(2/view_w, 2/view_h, 1, 1)。
    // clip = vp × pos；NDC(x,y) = (2x/view_w, 2y/view_h)。
    let (w, h) = (3840.0, 1906.0);
    // 原点 → (0,0)（屏中心）。
    assert_eq!(particle_render::project_pos([0.0, 0.0, 0.0], w, h), [0.0, 0.0]);
    // 黑神话发射点（-331.74, 927.30）→ NDC (≈-0.17, ≈0.97)（顶部偏左、屏内）。
    let p = particle_render::project_pos([-331.74, 927.30, 0.0], w, h);
    assert!((p[0] - (-0.1728)).abs() < 1e-3, "x NDC ≈ -0.17，got {}", p[0]);
    assert!((p[1] - 0.973).abs() < 1e-2, "y NDC ≈ 0.97，got {}", p[1]);
    // clip.z 恒 0（billboard 无深度缓冲）。
}

#[test]
fn multiframe_lifetime_encodes_frame_and_uv_slices_sheet() {
    // lifetime 编码：randomframe → (frame+0.5)/frames。
    assert_eq!(particle_render::particle_lifetime_encode(0.0, 4), 0.125);
    assert_eq!(particle_render::particle_lifetime_encode(2.0, 4), 0.625);
    assert_eq!(particle_render::particle_lifetime_encode(3.0, 4), 0.875);
    // 单帧 → 0（shader 走整张采样）。
    assert_eq!(particle_render::particle_lifetime_encode(2.0, 1), 0.0);
    // shader 还原帧：floor(frac(lifetime)*frames)。
    for frame in [0.0, 1.0, 2.0, 3.0] {
        let lt = particle_render::particle_lifetime_encode(frame, 4);
        let recovered = (lt - lt.floor()) * 4.0;
        assert_eq!(recovered.floor(), frame);
    }

    // uv 切片：rosepetals 4×1 网格。frame=2 的右下角 (u=1,v=0) → frame 子区 (2+1)/4=0.75 宽、整高。
    let uv = particle_render::sprite_frame_uv(2.0, 4, 1, [1.0, 0.0]);
    assert!((uv[0] - 0.75).abs() < 1e-6, "u 应在第 2 帧右缘 0.75，got {}", uv[0]);
    assert!((uv[1] - 0.0).abs() < 1e-6, "v 应在 [0,1] 整高，got {}", uv[1]);
    // frame=0 左上角 (0,1) → (0+0)/4=0, v 整高。
    let uv0 = particle_render::sprite_frame_uv(0.0, 4, 1, [0.0, 1.0]);
    assert_eq!(uv0, [0.0, 1.0]);
    // 单帧退化为原 corner。
    assert_eq!(particle_render::sprite_frame_uv(0.0, 1, 1, [0.3, 0.7]), [0.3, 0.7]);
}

#[test]
fn blend_mode_follows_material_name() {
    use particle_render::BlendMode;
    // lightshaft（EVA 光柱）→ additive 辉光。
    assert_eq!(BlendMode::from_material(Some("materials/presets/lightshaft.json")), BlendMode::Additive);
    // 其它/缺失 → translucent 普通叠加。
    assert_ne!(BlendMode::from_material(Some("materials/presets/rose.json")), BlendMode::Additive);
    assert_eq!(BlendMode::from_material(None), BlendMode::Translucent);
    // overbright 缺省 1.0（不增亮）。
    assert_eq!(BlendMode::overbright(None), 1.0);
}

#[test]
fn uniform_holds_view_spritesheet_and_material() {
    let u = particle_render::ParticleRenderUniform {
        view_w: 3840.0,
        view_h: 1906.0,
        spritesheet_frames: 4.0,
        spritesheet_cols: 4.0,
        spritesheet_rows: 1.0,
        overbright: 1.0,
        softness: particle_render::SOFTNESS_MASKED,
        mask_mode: 1.0,
    };
    assert_eq!(u.view_w, 3840.0);
    assert_eq!(u.spritesheet_frames, 4.0);
    assert_eq!(u.mask_mode, 1.0);
    // uniform 16 对齐（32B，符合 wgpu uniform binding size 要求）。
    assert_eq!(std::mem::size_of::<particle_render::ParticleRenderUniform>(), 32);
    // 帧数由纹理宽高推导（rosepetals 512×128 → 4；方形/单帧 → 1）。
    assert_eq!(particle_render::frame_count_from_dims(512, 128), 4);
    assert_eq!(particle_render::frame_count_from_dims(256, 256), 1);
}
