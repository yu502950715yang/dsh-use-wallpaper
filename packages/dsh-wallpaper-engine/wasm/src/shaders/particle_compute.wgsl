// compute shader 粒子模拟：emitter 生成 + 运动 + 寿命衰减 + 时间种子。
// 与 particle_render.wgsl 拆分的标准做法：compute 阶段允许 `var<storage, read_write>`
// （WGSL 规范禁止 vertex 阶段静态访问 read_write storage，Dawn/Tint validator 强制实施）。
// uniform 布局与 Rust EmitterParams（repr(C)）严格对齐（std140 176B：11 × vec4，
// vec3 后补 4 字节 pad；view_w/view_h/elapsed 复用原 pad 槽；Task 0.3 追加
// alpha_min/alpha_max 与 _pad8.._pad11；与 render module 共享）。
// Particle 存 spawn 时生成的初始 alpha（Task 0.3，控制器裁定 P0-1）：compute 不衰减
// alpha（避免累积误差），显示 alpha 由渲染侧按寿命比例计算。

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
  _pad8: u32, _pad9: u32, _pad10: u32, _pad11: u32,
}
@group(0) @binding(0) var<uniform> p: EmitterParams;

struct Particle { pos: vec3f, vel: vec3f, life: f32, max_life: f32, size: f32, alpha: f32, color: vec3f }
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
  // spawn 判定随时间演化，粒子场不会停在静态不动点。
  let seed = i * 2654435761u + lid.x + u32(p.elapsed * 60.0);
  let life_span = p.life_min + rand(seed) * max(p.life_max - p.life_min, 0.0);
  // 2026-08-21 修复（对齐 JS particles.ts 累积出生率）：spawn 概率除以 max_particles——
  // 原 `rand < rate*dt` 是**每槽位每帧**独立判定 → 总出生率 = max_particles × rate
  // （fog1: 71 槽位 × 1.5/s ≈ 106/s，应为 1.5/s）→ 粒子无限累积到饱和（71 个巨大雾粒子
  // additive 叠加 → 画面越来越亮）。除以 max_particles 后总出生率 = rate × dt ✓。
  let spawn = rand(seed + 1u) < (p.rate * p.dt / f32(p.max_particles));
  var pos = vec3f(0.0); var vel = vec3f(0.0); var life = 0.0; var size = p.size_min; var col = vec3f(1.0);
  // 初始 alpha（Task 0.3）：spawn 时在 [alpha_min, alpha_max] 内随机一次，此后不再衰减
  // （控制器裁定 P0-1——compute 衰减会逐帧累积误差；显示 alpha 由渲染侧计算）。
  var alpha = p.alpha_min;
  if (spawn) {
    let dir = normalize(p.directions + vec3f(rand(seed+2u)-0.5, rand(seed+3u)-0.5, rand(seed+4u)-0.5));
    let dist = p.distance_min + rand(seed+5u) * max(p.distance_max - p.distance_min, 0.0);
    pos = p.origin + dir * dist * p.scale;
    vel = p.vel_min + vec3f(rand(seed+6u), rand(seed+7u), rand(seed+8u)) * max(p.vel_max - p.vel_min, vec3f(0.0));
    life = life_span;
    size = p.size_min + rand(seed+9u) * max(p.size_max - p.size_min, 0.0);
    col = p.color_min + vec3f(rand(seed+10u), rand(seed+11u), rand(seed+12u)) * max(p.color_max - p.color_min, vec3f(0.0));
    alpha = p.alpha_min + rand(seed+13u) * max(p.alpha_max - p.alpha_min, 0.0);
  }
  // 存活粒子继续运动 + 寿命衰减
  var cur = particles[i];
  if (cur.life > 0.0) {
    cur.pos += cur.vel * p.dt;
    cur.life -= p.dt;
    if (cur.life <= 0.0) { cur.life = 0.0; }
  } else if (spawn) {
    cur = Particle(pos, vel, life, life_span, size, alpha, col);
  }
  particles[i] = cur;
  atomicStore(&count, 0u);
}
