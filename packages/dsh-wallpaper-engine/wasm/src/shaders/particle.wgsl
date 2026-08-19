// compute shader 粒子：GPU 模拟（发射 + 运动 + 寿命衰减）+ billboard quad 渲染（加法混合）。
// 布局：uniform 结构体与 Rust EmitterParams（repr(C)）严格对齐
// （std140：vec3 后补 4 字节 pad；origin/scale 后的 pad 槽复用于 view_w/view_h，
// rate 后的 pad 槽复用于 elapsed，与 Rust 侧显式字段一一对应）。
//
// 渲染方式说明：不用 `@builtin(point_size)`——naga 24.0.0（wgpu 24 锁定）的 WGSL
// 前端缺失该 builtin 映射（BuiltIn::PointSize 枚举存在但 parse 表无），用了必报
// UnknownBuiltin。改为 billboard quad（vertex_index 0..3 推导角点，实例化每粒子），
// 点尺寸=像素尺寸（CAMERA_DISTANCE 语义），fragment 内圆裁剪，无大小限制。

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
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> count: atomic<u32>;

// lowbias32 确定性 hash 随机。移位优先级必须显式括号：`((s >> 28u) + 4u)`，
// 原 `s >> 28u + 4u` 会被解析为 `s >> 32u`（`+` 优先级高于 `>>`），移位 ≥ 32 为未定义行为。
// 修正后移位计数 ∈ [4, 19] 恒安全。
fn rand(seed: u32) -> f32 {
  var s = seed * 747796405u + 2891336453u;
  s = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  s = (s >> ((s >> 28u) + 4u)) ^ s;
  return f32(s) / 4294967295.0;
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let i = gid.x;
  if (i >= p.max_particles) { return; }
  // 每粒子独立随机种，含累计时间（elapsed*60 ≈ 帧计数）：
  // spawn 判定随时间演化，粒子场不会停在静态不动点（审查修复：原种无时间分量逐帧恒定）。
  let seed = i * 2654435761u + lid.x + u32(p.elapsed * 60.0);
  let life_span = p.life_min + rand(seed) * max(p.life_max - p.life_min, 0.0);
  let spawn = rand(seed + 1u) < p.rate * p.dt;
  var pos = vec3f(0.0); var vel = vec3f(0.0); var life = 0.0; var size = p.size_min; var col = vec3f(1.0);
  if (spawn) {
    let dir = normalize(p.directions + vec3f(rand(seed+2u)-0.5, rand(seed+3u)-0.5, rand(seed+4u)-0.5));
    let dist = p.distance_min + rand(seed+5u) * max(p.distance_max - p.distance_min, 0.0);
    pos = p.origin + dir * dist * p.scale;
    vel = p.vel_min + vec3f(rand(seed+6u), rand(seed+7u), rand(seed+8u)) * max(p.vel_max - p.vel_min, vec3f(0.0));
    life = life_span;
    size = p.size_min + rand(seed+9u) * max(p.size_max - p.size_min, 0.0);
    col = p.color_min + vec3f(rand(seed+10u), rand(seed+11u), rand(seed+12u)) * max(p.color_max - p.color_min, vec3f(0.0));
  }
  // 存活粒子继续运动 + 寿命衰减
  var cur = particles[i];
  if (cur.life > 0.0) {
    cur.pos += cur.vel * p.dt;
    cur.life -= p.dt;
    if (cur.life <= 0.0) { cur.life = 0.0; }
  } else if (spawn) {
    cur = Particle(pos, vel, life, life_span, size, col);
  }
  particles[i] = cur;
  atomicStore(&count, 0u);
}

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
  // 粒子中心：中心原点、像素量级坐标 → 裁剪坐标（除以半视口映射到 [-1,1]，
  // 审查修复：原直接输出像素坐标当裁剪坐标，粒子出界不可见）
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
  // quad 方形光栅 → 圆形裁剪（圆盘）+ 寿命透明度（加法混合，透明像素无贡献）
  if (length(v_uv - vec2f(0.5)) > 0.5) { discard; }
  return vec4f(v_color, v_life_alpha);
}
