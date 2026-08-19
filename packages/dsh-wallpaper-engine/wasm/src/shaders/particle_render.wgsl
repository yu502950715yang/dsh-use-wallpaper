// particle render shader：billboard quad 粒子渲染（加法混合）。
// 与 particle_compute.wgsl 拆分：vertex 阶段只能静态访问 `var<storage, read>` 的 storage
// （WGSL 规范：vertex 阶段 read_write storage 非法，Dawn/Tint validator 强制实施），
// 故本文件声明 read 并配 render_bgl（read_only: true）。
// uniform 布局与 Rust EmitterParams（repr(C)）严格对齐（std140 160B，与 compute module 共享）。

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
  dt: f32, max_particles: u32, _pad8: u32, _pad9: u32,
}
@group(0) @binding(0) var<uniform> p: EmitterParams;

struct Particle { pos: vec3f, vel: vec3f, life: f32, max_life: f32, size: f32, color: vec3f }
@group(0) @binding(1) var<storage, read> particles: array<Particle>;

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
  // 粒子中心：中心原点、像素量级坐标 → 裁剪坐标（除以半视口映射到 [-1,1]）
  let center_clip = vec2f(part.pos.x / p.view_w * 2.0, part.pos.y / p.view_h * 2.0);
  // 点尺寸=像素尺寸（CAMERA_DISTANCE 语义）；半尺寸像素偏移 → NDC 偏移
  let half_px = part.size * 0.5;
  let ndc_per_px = vec2f(2.0 / p.view_w, 2.0 / p.view_h);
  var out: VsOut;
  out.clip_pos = vec4f(center_clip + corner * half_px * ndc_per_px, 0.0, 1.0);
  out.v_uv = corner * 0.5 + 0.5;
  out.v_color = part.color;
  out.v_life_alpha = clamp(part.life / max(part.max_life, 0.0001), 0.0, 1.0);
  return out;
}

@fragment
fn fs_main(
  @location(0) v_uv: vec2f,
  @location(1) v_color: vec3f,
  @location(2) v_life_alpha: f32,
) -> @location(0) vec4f {
  // quad 方形光栅 → 圆形裁剪（圆盘）+ 寿命透明度（SrcAlpha/One 加法混合）
  if (length(v_uv - vec2f(0.5)) > 0.5) { discard; }
  return vec4f(v_color, v_life_alpha);
}
