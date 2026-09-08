struct VsIn { @location(0) pos: vec3f, @location(1) size: f32, @location(2) uv: vec2f,
              @location(3) color: vec3f, @location(4) alpha: f32 }
struct P { view_w: f32, view_h: f32 }
@group(0) @binding(0) var<uniform> p: P;
struct VsOut { @builtin(position) clip: vec4f, @location(0) uv: vec2f,
               @location(1) color: vec3f, @location(2) alpha: f32 }
@vertex fn vs(@builtin(vertex_index) vi:u32, i:VsIn) -> VsOut {
  let corner = vec2f(f32(vi & 1u)*2.0-1.0, f32((vi>>1u)&1u)*2.0-1.0);
  let half = i.size*0.5;
  var o: VsOut;
  o.clip.x = (i.pos.x / (p.view_w/2.0)) + corner.x*(half/(p.view_w/2.0));
  o.clip.y = (i.pos.y / (p.view_h/2.0)) + corner.y*(half/(p.view_h/2.0));
  o.clip.z = 0.0; o.clip.w = 1.0;
  // 顶点 uv（i.uv）是粒子纹理的采样中心（sim 的 build_vertices 输出 0.5,0.5 = 纹理中心）。
  // quad 四角各偏移 ±0.5 → 完整采样 i.uv 周围一个 UV 单位（默认 → [0,1] 整张纹理）。
  // 原实现是 `vec2f(0.5 + i.uv.x*0.5, ...) + corner*0.5`：对默认中心 0.5 得到 uv∈[0.25,1.25]，
  // +1 角出界 0..1 被钳制到纹理右/下边缘，只采到纹理右下一角（纹理被局部放大/偏移）——修正。
  o.uv = i.uv + corner*0.5;
  o.color = i.color; o.alpha = i.alpha;
  return o;
}
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@fragment fn fs(o:VsOut) -> @location(0) vec4f {
  let texel = textureSample(tex, samp, o.uv);
  return vec4f(o.color * texel.rgb, o.alpha * texel.a);
}
