// compute shader 粒子 v1：GPU 模拟（发射 + 运动 + 寿命衰减）+ 点渲染（加法混合）。
// 布局：uniform 结构体与 Rust EmitterParams（repr(C)）严格对齐
// （std140：vec3 后补 4 字节 pad，与 Rust 侧显式 _padN 字段一一对应）。

struct EmitterParams {
  origin: vec3f, _pad0: f32,
  scale: vec3f, _pad1: f32,
  rate: f32, distance_min: f32, distance_max: f32, _pad2: f32,
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

// lowbias32 确定性 hash 随机（mulberry32 语义近似，v1 够用）。
// 预检修正：移位优先级必须显式括号——`(s >> 28u) + 4u`，
// 原 `s >> 28u + 4u` 会被解析为 `s >> 32u`（`+` 优先级高于 `>>`），移位 ≥ 32 为未定义行为。
// 修正后移位计数范围 [4, 19] < 32，恒安全。
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
  // 每粒子独立随机种。v1 已知简化：种不随时间变化，spawn 判定逐帧恒定；
  // 真实随时间发射需累计时间/帧计数的种，Task 9 浏览器验收时迭代。
  let seed = i * 2654435761u + lid.x;
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

@vertex
fn vs_main(@builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  // v1：粒子点渲染（位置直接输出；点尺寸/投影矩阵在 Task 9 换 uniform + 相机）
  let pos = particles[ii].pos;
  return vec4f(pos, 1.0);
}

@fragment
fn fs_main(@builtin(instance_index) ii: u32) -> @location(0) vec4f {
  let part = particles[ii];
  let life_alpha = clamp(part.life / max(part.max_life, 0.0001), 0.0, 1.0);
  return vec4f(part.color, life_alpha);
}
