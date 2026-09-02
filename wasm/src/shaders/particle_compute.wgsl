// compute shader 粒子模拟：emitter 生成 + 运动 + 寿命衰减 + 时间种子。
// 与 particle_render.wgsl 拆分的标准做法：compute 阶段允许 `var<storage, read_write>`
// （WGSL 规范禁止 vertex 阶段静态访问 read_write storage，Dawn/Tint validator 强制实施）。
// uniform 布局与 Rust EmitterParams（repr(C)，纯 f32 字段）严格对齐（std140 240B：15 × vec4，
// 全标量无 vec3，避免 std140 对齐歧义；view_w/view_h/elapsed 复用原 pad 槽；Task 0.3 追加
// alpha_min/alpha_max；2026-08-31 算子内核扩容后 240B）。
// Particle 存 spawn 时生成的初始 alpha（Task 0.3，控制器裁定 P0-1）：compute 不衰减
// alpha（避免累积误差），显示 alpha 由渲染侧按寿命比例计算。
// 2026-08-31 算子内核（补 3 张 STATIC 壁纸 root cause）：
//   - turbulentvelocityrandom：spawn 初速叠加（turb_velocity）。
//   - movement：每帧 velocity += (gravity - velocity*drag)*dt；pos += velocity*dt。
//   - oscillateposition：pos += 每轴正弦摆动（确定性 per-particle phase，mask 控制轴）。
//   - angular/rotation 由 render shader 按寿命比例线性插值（不在此存状态）。

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
  // 2026-08-31 算子内核追加段（全标量，与 Rust 偏移一致）：
  turb_speed_min: f32, turb_speed_max: f32, turb_scale: f32, turb_active: f32,
  grav_x: f32, grav_y: f32, grav_z: f32, drag: f32,
  osc_freq_min: f32, osc_freq_max: f32, osc_scale_min: f32, osc_scale_max: f32,
  osc_mask_x: f32, osc_mask_y: f32, osc_active: f32, renderer_type: f32,
  rot_active: f32, ang_drag: f32, rot_min: f32, rot_max: f32,
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

// per-particle 湍流速度：确定性 hash 噪声方向 × 速度范围随机（官方 TurbulentVelocityRandomProgram
// 的 spawn 初速近似）。turb_active==0 时返回 0。
fn turb_velocity(i: u32, t: f32) -> vec3f {
  if (p.turb_active < 0.5) { return vec3f(0.0); }
  var s = i * 2654435761u + u32(t * 60.0) * 40503u;
  let a = rand(s) * 6.28318;
  let b = rand(s + 1u) * 6.28318;
  var dir = vec3f(cos(a) * sin(b), sin(a) * sin(b), cos(b));
  let speed = p.turb_speed_min + rand(s + 2u) * max(p.turb_speed_max - p.turb_speed_min, 0.0);
  return dir * speed;
}

// per-particle 摆动偏移（oscillateposition）：沿 mask 轴的正弦摆动。
// time = 粒子已存活时间；phase/freq/scale 用粒子索引确定性派生（各粒子不同）。
// 官方 OscillatePositionOperator：offset[axis] = -scale*omega*sin(omega*time+phase)*dt，
// 这里近似为直接位置正弦（幅度 scale，频率 freq，方向受 mask 与 per-particle phase 调制）。
fn osc_offset(i: u32, time: f32) -> vec3f {
  if (p.osc_active < 0.5) { return vec3f(0.0); }
  let s = i * 40503u + 12345u;
  let freq = p.osc_freq_min + rand(s) * max(p.osc_freq_max - p.osc_freq_min, 0.0);
  let scale = p.osc_scale_min + rand(s + 1u) * max(p.osc_scale_max - p.osc_scale_min, 0.0);
  let phase = rand(s + 2u) * 6.28318;
  let omega = freq * 6.28318;
  let wave = sin(omega * time + phase);
  // 仅 mask 控制轴生效（x/y；2D 壁纸 z 恒 0）
  return vec3f(wave * scale * p.osc_mask_x, wave * scale * p.osc_mask_y, 0.0);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let i = gid.x;
  if (i >= p.max_particles) { return; }
  // 每粒子独立随机种，含累计时间（elapsed*60 ≈ 帧计数）：
  // spawn 判定随时间演化，粒子场不会停在静态不动点。
  let seed = i * 2654435761u + lid.x + u32(p.elapsed * 60.0);
  let life_span = p.life_min + rand(seed) * max(p.life_max - p.life_min, 0.0);
  // 出生率 = rate*dt/max_particles（对齐 JS 累积出生率，防无限饱和）。
  let spawn = rand(seed + 1u) < (p.rate * p.dt / f32(p.max_particles));
  var pos = vec3f(0.0); var vel = vec3f(0.0); var life = 0.0; var size = p.size_min; var col = vec3f(1.0);
  var alpha = p.alpha_min;
  if (spawn) {
    let dir = normalize(p.directions + vec3f(rand(seed+2u)-0.5, rand(seed+3u)-0.5, rand(seed+4u)-0.5));
    let dist = p.distance_min + rand(seed+5u) * max(p.distance_max - p.distance_min, 0.0);
    pos = p.origin + dir * dist * p.scale;
    vel = p.vel_min + vec3f(rand(seed+6u), rand(seed+7u), rand(seed+8u)) * max(p.vel_max - p.vel_min, vec3f(0.0));
    // 湍流初速（turbulentvelocityrandom spin-up）
    vel += turb_velocity(i, p.elapsed);
    life = life_span;
    size = p.size_min + rand(seed+9u) * max(p.size_max - p.size_min, 0.0);
    col = p.color_min + vec3f(rand(seed+10u), rand(seed+11u), rand(seed+12u)) * max(p.color_max - p.color_min, vec3f(0.0));
    alpha = p.alpha_min + rand(seed+13u) * max(p.alpha_max - p.alpha_min, 0.0);
  }
  // 存活粒子继续运动 + 寿命衰减（算子积分：gravity+drag → vel；vel → pos）
  var cur = particles[i];
  if (cur.life > 0.0) {
    // MovementOperator：acceleration = DragForce(vel, drag) + gravity；DragForce(v,s) = -v*s。
    let gravity = vec3f(p.grav_x, p.grav_y, p.grav_z);
    let dt = p.dt;
    let accel = -cur.vel * p.drag + gravity;
    cur.vel += accel * dt;
    // oscillateposition：按已存活时间加摆动偏移
    let alive_time = cur.max_life - cur.life;
    let osc = osc_offset(i, alive_time);
    cur.pos += cur.vel * dt + osc;
    cur.life -= dt;
    if (cur.life <= 0.0) { cur.life = 0.0; }
  } else if (spawn) {
    cur = Particle(pos, vel, life, life_span, size, alpha, col);
  }
  particles[i] = cur;
  atomicStore(&count, 0u);
}
