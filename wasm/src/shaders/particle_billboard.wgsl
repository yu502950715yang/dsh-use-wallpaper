// Task 5：对齐 lwe CParticle::renderSprites() 的 billboard 顶点流与材质。
//
// 顶点流（每个**角点顶点** 17 浮点，stride 68B；每粒子 4 角点 + 6 索引，对齐 CParticle.cpp 的
// `addVertex(u,v)` 四角顺序 (0,1),(1,1),(1,0),(0,0) 与 fillVertices 字段布局）：
//   @location(0) pos          : vec3  [0..3)  粒子中心（CPU sim 已含对象变换 + 发射点）
//   @location(1) uv_rot_size  : vec4  [3..7)  (uv.x, uv.y, rot.z, size)
//   @location(2) color        : vec4  [7..11) (r, g, b, alpha)
//   @location(3) vel_lifetime : vec4  [11..15)(vel.x, vel.y, vel.z, lifetime)
//   @location(4) rot_x_y      : vec2  [15..17)(rot.x, rot.y)
//
// mvp：`o.clip = mvp × pos`，`mvp = viewProjection × model`；viewProjection 为
// `ortho(view_w, view_h)`（centered 正交，对角阵 diag(2/view_w, 2/view_h, 1, 1)），model 取单位阵
// （CPU sim 已把对象变换 + emitter 发射点烘焙进 pos，对齐 lwe 注释）。corner（由 uv 推导 ±1）
// 在**世界空间**加到粒子中心（含 size 半宽与 rot.z 平面自旋），再经 viewProjection 到 NDC。
//
// 多帧（SPRITESHEET）：`lifetime` 编码粒子帧（lwe renderSprites 把 p.frame 写入 lifetime：
// randomframe → (frame+0.5)/frames，sequence/once → frame/frames），shader 用
// `floor(frac(lifetime) × frames)` 还原帧号，按 cols/rows 网格切片到该帧子区，corner uv (0..1)
// 映射为帧内 UV。frames<=1 → 整张纹理采样（退化为 corner uv）。
//
// 纹理 alpha 遮罩 + 材质：`mask_mode=1`（真实纹理）→ `alpha = texel.a × particle.alpha`（光柱/雪片
// 用纹理形状，非纯软圆盘）；`mask_mode=0`（无纹理 1×1 白兜底）→ 软圆点（disk 即形状）。
// `overbright`（材质 brightness 乘数）乘到彩色；blend 由管线绑定（Additive=SrcAlpha/One、
// Translucent=SrcAlpha/OneMinusSrcAlpha）。

struct VsIn {
  @location(0) pos: vec3f,
  @location(1) uv_rot_size: vec4f,
  @location(2) color: vec4f,
  @location(3) vel_lifetime: vec4f,
  @location(4) rot_x_y: vec2f,
}
// uniform（Rust repr(C) 8×f32 = 32B；wgpu uniform binding size 32B 为 16 对齐）。
struct P {
  view_w: f32,
  view_h: f32,
  spritesheet_frames: f32,
  spritesheet_cols: f32,
  spritesheet_rows: f32,
  overbright: f32,
  softness: f32,
  mask_mode: f32,
}
@group(0) @binding(0) var<uniform> p: P;
struct VsOut {
  @builtin(position) clip: vec4f,
  @location(0) tex_uv: vec2f,
  @location(1) color: vec4f,   // rgb 已乘 overbright；a = 粒子 alpha
  @location(2) local: vec2f,   // quad 局部坐标 [-1,1]^2（fragment 软边缘用）
}
@vertex fn vs(i: VsIn) -> VsOut {
  let corner = i.uv_rot_size.xy * 2.0 - 1.0;
  let rot_z = i.uv_rot_size.z;
  let size = i.uv_rot_size.w;
  // 平面自旋：把 quad 角点绕粒子中心旋转 rot.z。
  let c = cos(rot_z);
  let s = sin(rot_z);
  let rcorner = vec2f(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
  let half = size * 0.5;
  let world = vec3f(i.pos.x + rcorner.x * half, i.pos.y + rcorner.y * half, i.pos.z);
  // mvp = viewProjection × model（model = I）→ centered ortho diag(2/view_w, 2/view_h, 1, 1)。
  let vp = mat4x4f(
    vec4f(2.0 / p.view_w, 0.0, 0.0, 0.0),
    vec4f(0.0, 2.0 / p.view_h, 0.0, 0.0),
    vec4f(0.0, 0.0, 1.0, 0.0),
    vec4f(0.0, 0.0, 0.0, 1.0),
  );
  var o: VsOut;
  o.clip = vp * vec4f(world, 1.0);
  // 多帧切片（SPRITESHEET）。
  let frames = p.spritesheet_frames;
  let corner_uv = i.uv_rot_size.xy;
  if (frames > 1.0) {
    let lt = i.vel_lifetime.w;
    let frac_lt = lt - floor(lt);
    var frame = floor(frac_lt * frames);
    if (frame >= frames) {
      frame = frames - 1.0;
    }
    let cols = max(p.spritesheet_cols, 1.0);
    let rows = max(p.spritesheet_rows, 1.0);
    let col = frame % cols;
    let row = floor(frame / cols);
    let fw = 1.0 / cols;
    let fh = 1.0 / rows;
    o.tex_uv = vec2f((col + corner_uv.x) * fw, (row + corner_uv.y) * fh);
  } else {
    o.tex_uv = corner_uv;
  }
  o.color = vec4f(i.color.rgb * p.overbright, i.color.a);
  o.local = corner;
  return o;
}
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@fragment fn fs(o: VsOut) -> @location(0) vec4f {
  let texel = textureSample(tex, samp, o.tex_uv);
  // softness：quad 局部圆盘衰减（中心 1、边缘 0）。softness∈(0,1] 控制边缘宽度；
  // softness=1 → 整盘软（无纹理兜底圆点），小 softness → 薄软边。softness<=0 → 硬裁剪。
  let d = length(o.local);
  var disk = 1.0;
  if (p.softness > 0.0) {
    disk = 1.0 - smoothstep(1.0 - p.softness, 1.0, d);
  } else {
    if (d > 1.0) {
      discard;
    }
  }
  // mask_mode=1 → 真实纹理 alpha 遮罩（alpha = texel.a × particle.alpha，软边由纹理 alpha 提供，
  // 不再用纯软圆盘）；mask_mode=0 → 无纹理软圆点兜底（disk 即形状）。
  let shape = mix(disk, texel.a, p.mask_mode);
  let alpha = o.color.a * shape;
  let rgb = o.color.rgb * texel.rgb;
  return vec4f(rgb, alpha);
}
