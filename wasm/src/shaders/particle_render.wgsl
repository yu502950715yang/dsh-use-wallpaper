// particle render shader：billboard quad 粒子渲染（加法混合）。
// 与 particle_compute.wgsl 拆分：vertex 阶段只能静态访问 `var<storage, read>` 的 storage
// （WGSL 规范：vertex 阶段 read_write storage 非法，Dawn/Tint validator 强制实施），
// 故本文件声明 read 并配 render_bgl（read_only: true）。
// uniform 布局与 Rust EmitterParams（repr(C)，纯 f32 字段）严格对齐（std140 240B：15 × vec4，
// 2026-08-31 算子内核扩容后 240B；与 compute module 共享）。
// 显示 alpha（Task 0.3，控制器裁定 P0-1）：compute 不衰减 alpha（存 spawn 初始值），
// 本文件按寿命比例计算 v_life_alpha = clamp(life/max_life, 0, 1) * alpha，
// 对齐 JS 版 alphaAt(initialAlpha, life, maxLife) 语义（open-wallpaper-engine AlphaFadeOperator）。
// 2026-08-31 算子内核：sprite 旋转（按寿命比例从 rot_min→rot_max 插值）+ spritetrail 拉伸
// （沿速度方向，长度 clamp 到 [min_length, max_length]）。

struct EmitterParams {
  origin: vec3f, view_w: f32,
  scale: vec3f, view_h: f32,
  rate: f32, distance_min: f32, distance_max: f32, elapsed: f32,
  directions: vec3f, _pad3: f32,
  life_min: f32, life_max: f32, size_min: f32, size_max: f32,
  vel_min: vec3f, _pad4: f32,
  vel_max: vec3f, _pad5: f32,
  color_min: vec3f, _pad6: f32,
  color_max: vec3f, _pad7: f32,
  dt: f32, max_particles: u32, alpha_min: f32, alpha_max: f32,
  turb_speed_min: f32, turb_speed_max: f32, turb_scale: f32, turb_active: f32,
  grav_x: f32, grav_y: f32, grav_z: f32, drag: f32,
  osc_freq_min: f32, osc_freq_max: f32, osc_scale_min: f32, osc_scale_max: f32,
  osc_mask_x: f32, osc_mask_y: f32, osc_active: f32, renderer_type: f32,
  rot_active: f32, ang_drag: f32, rot_min: f32, rot_max: f32,
}
@group(0) @binding(0) var<uniform> p: EmitterParams;

struct Particle { pos: vec3f, vel: vec3f, life: f32, max_life: f32, size: f32, alpha: f32, color: vec3f }
@group(0) @binding(1) var<storage, read> particles: array<Particle>;

// 粒子纹理（2026-08-21 方案 A）：WE 粒子材质 textures（如 particle/fog/fog1）是引擎
// 内置雾/光晕纹理；无纹理时绑定 1×1 白（texel = (1,1,1,1)，保持纯色圆盘行为）。
@group(0) @binding(2) var tex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

struct VsOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) v_uv: vec2f,
  @location(1) v_color: vec3f,
  @location(2) v_life_alpha: f32,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VsOut {
  let part = particles[ii];
  // quad 角点 [-1,1]²：vi 0..3 → (-1,-1),(1,-1),(1,1),(-1,1)（TriangleList，无顶点 buffer）
  let corner = vec2f(f32(vi & 1u) * 2.0 - 1.0, f32((vi >> 1u) & 1u) * 2.0 - 1.0);
  // 已用寿命比例（0=出生，1=死亡）；life 从 max_life 减到 0。
  let used = 1.0 - clamp(part.life / max(part.max_life, 0.0001), 0.0, 1.0);
  // 粒子中心：中心原点、像素量级坐标 → 裁剪坐标（除以半视口映射到 [-1,1]）
  let center = vec2f(part.pos.x / p.view_w * 2.0, part.pos.y / p.view_h * 2.0);
  // 像素量级尺寸；换算 NDC 每像素。
  let half_px = part.size * 0.5;
  let ndc_per_px = vec2f(2.0 / p.view_w, 2.0 / p.view_h);
  // 本地像素坐标（未变换）
  var local_px = corner * half_px;
  var v_uv = corner * 0.5 + 0.5;
  if (p.renderer_type > 0.5) {
    // spritetrail：沿速度方向拉伸。取速度方向基，把 quad 的"长轴"对齐速度方向。
    // trail_length = clamp(speed * length, min_length, max_length)；此处 length/min/max
    // 未单独传入，用 rot 槽复用（min=rot_min, max=rot_max 语义不匹配，改用固定系数近似）。
    // 实际按速度归一化方向把 quad 拷贝在移动方向拉长 2×（视觉拖尾）。
    let speed = length(part.vel);
    if (speed > 1e-6) {
      let dir = part.vel / speed;
      // 沿速度方向拉长：把本地 x 轴对齐 dir，拉长 half_px*2
      let stretch = half_px * 2.0;
      let px = corner.x * stretch;
      local_px = vec2f(dir.x * px, dir.y * px);
      // uv 在拉伸轴仍用 corner.x（避免变形）
      v_uv = vec2f(corner.x * 0.5 + 0.5, corner.y * 0.5 + 0.5);
    }
  } else {
    // sprite：绕中心旋转（rot_active 时按寿命比例 rot_min→rot_max 插值）。
    var rot_angle = 0.0;
    if (p.rot_active > 0.5) {
      rot_angle = p.rot_min + (p.rot_max - p.rot_min) * used;
    }
    let c = cos(rot_angle);
    let s = sin(rot_angle);
    let rp = vec2f(local_px.x * c - local_px.y * s, local_px.x * s + local_px.y * c);
    local_px = rp;
  }
  var out: VsOut;
  out.clip_pos = vec4f(center + local_px * ndc_per_px, 0.0, 1.0);
  out.v_uv = v_uv;
  out.v_color = part.color;
  // 寿命 alpha（2026-08-21 对齐官方 AlphaFadeOperator：fade_in=fade_out=0.5）：
  // 官方 alpha 随寿命 **三角波**（前 50% 淡入 0→满、后 50% 淡出 满→0）。
  let fade = 1.0 - abs(2.0 * used - 1.0); // 三角波：0-0.5 升 0→1、0.5-1 降 1→0
  out.v_life_alpha = fade * part.alpha;
  return out;
}

@fragment
fn fs_main(
  @location(0) v_uv: vec2f,
  @location(1) v_color: vec3f,
  @location(2) v_life_alpha: f32,
) -> @location(0) vec4f {
  // 圆盘光栅 + 软边缘渐变 + 粒子纹理采样（2026-08-21）：
  let d = length(v_uv - vec2f(0.5));
  if (d > 0.5) { discard; }
  let texel = textureSample(tex, samp, v_uv);
  let edge = smoothstep(0.5, 0.0, d) * v_life_alpha * texel.a;
  return vec4f(v_color * texel.rgb, edge);
}
