struct VsIn { @location(0) pos: vec3f, @location(1) size: f32, @location(2) uv: vec2f,
              @location(3) color: vec3f, @location(4) alpha: f32 }
// frame_count = sprite sheet 横向帧数（rosepetals 512×128 → 4；单帧纹理 → 1）。
// uniform 以 Rust repr(C) 16B 写入（view_w, view_h, frame_count, pad）。
struct P { view_w: f32, view_h: f32, frame_count: f32, _pad: f32 }
// 单个粒子 quad 的 NDC 半宽上限（相对半视口）。防御异常大 size 的 spec 渲染成"贴视口大块"。
// 合理粒子（花瓣 ~0.026、光柱 ≤0.31）远低于此。
const MAX_HALF_NDC: f32 = 0.45;
@group(0) @binding(0) var<uniform> p: P;
struct VsOut { @builtin(position) clip: vec4f, @location(0) uv: vec2f,
               @location(1) color: vec3f, @location(2) alpha: f32,
               @location(3) local: vec2f }
@vertex fn vs(@builtin(vertex_index) vi:u32, i:VsIn) -> VsOut {
  let corner = vec2f(f32(vi & 1u)*2.0-1.0, f32((vi>>1u)&1u)*2.0-1.0);
  let half = i.size*0.5;
  // 尺寸映射到 NDC：half/半视口。防御上限 MAX_HALF_NDC——单个粒子 quad 半宽不超过该值，防止异常大
  // size 的 spec（如 EVA 光柱 sizerandom=350..750，若缺失纹理/alpha 会裸露成大块）渲染成"贴视口大块"。
  // 正常小粒子（黑神话花瓣 size 30..50 → half_ndc≈0.026）与光柱（≤0.31）远低于上限，不受影响。
  let half_ndc_x = half/(p.view_w/2.0);
  let half_ndc_y = half/(p.view_h/2.0);
  let hx = min(half_ndc_x, MAX_HALF_NDC);
  let hy = min(half_ndc_y, MAX_HALF_NDC);
  var o: VsOut;
  o.clip.x = (i.pos.x / (p.view_w/2.0)) + corner.x*hx;
  o.clip.y = (i.pos.y / (p.view_h/2.0)) + corner.y*hy;
  o.clip.z = 0.0; o.clip.w = 1.0;
  // 顶点 uv：>1 帧（sprite sheet，rosepetals 4 帧）按帧中心 uv + 单帧宽步进采样——quad 只采样
  // 自己那一帧（i.uv 是 sim build_vertices 输出的帧中心 uv.x=(frame+0.5)/frame_count）。单帧纹理
  // （frame_count<=1：EVA 光柱/余烬/雾，非 rosepetal sheet）整张纹理中心采样 `corner*0.5+0.5`，
  // 否则 sim 烘焙的 (frame+0.5)/4 uv 会把单帧纹理采样到越界/错位区 → quad 只采到纹理一角 → 显示为
  // 纯色/红块（Task 5 修复 B 根因之一）。
  if (p.frame_count > 1.0) {
    o.uv = vec2f(i.uv.x + corner.x*(0.5/p.frame_count), i.uv.y + corner.y*0.5);
  } else {
    o.uv = corner * 0.5 + 0.5;
  }
  o.color = i.color; o.alpha = i.alpha;
  // 传递 quad 局部坐标（corner ∈ [-1,1]²），fragment 据此做软圆盘裁剪（与 uv 解耦，帧切分下也正确）。
  o.local = corner;
  return o;
}
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@fragment fn fs(o:VsOut) -> @location(0) vec4f {
  let texel = textureSample(tex, samp, o.uv);
  // 软圆盘 + 纹理 alpha 形状（对齐 GPU 路径 particle_render.wgsl）：quad 局部半径 >1 裁掉、边缘 0..1
  // 平滑衰减，再乘纹理 alpha。无纹理（1×1 白兜底 texel=(1,1,1,1)）时整块 quad 不会渲染成"硬色块"，
  // 而是软圆点（点状）；有纹理时按纹理 alpha 呈现光柱/花瓣形状。blend=Translucent（SrcAlpha/
  // OneMinusSrcAlpha）→ 半透明叠加，非不透明红块（Task 5 修复 B）。
  let d = length(o.local);
  if (d > 1.0) { discard; }
  let shape = (1.0 - smoothstep(0.0, 1.0, d)) * texel.a;
  return vec4f(o.color * texel.rgb, o.alpha * shape);
}
