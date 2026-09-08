struct VsIn { @location(0) pos: vec3f, @location(1) size: f32, @location(2) uv: vec2f,
              @location(3) color: vec3f, @location(4) alpha: f32 }
// frame_count = sprite sheet 横向帧数（rosepetals 512×128 → 4；非 sheet → 1）。
// uniform 以 Rust repr(C) 16B 写入（view_w, view_h, frame_count, pad）。
struct P { view_w: f32, view_h: f32, frame_count: f32, _pad: f32 }
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
  // 顶点 uv（i.uv）是粒子**所属单帧子区的采样中心**（sim 的 build_vertices 输出
  // uv.x=(frame+0.5)/frame_count、uv.y=0.5）。quad 四角按帧宽满步进：x 只偏移 ±0.5/frame_count
  // （单帧宽），y 偏移 ±0.5（整高）→ uv 落在该帧子区
  // [frame/frame_count,(frame+1)/frame_count]×[0,1]，每粒子只采样自己的那帧。
  // 原实现 `i.uv + corner*0.5` 对整张纹理 (0..1)：rosepetals 是 512×128 sprite sheet
  // （横向 4 帧），把四帧叠在同一 quad 上 → 视觉为竖条纹片（本任务根因）。修复：按
  // frame_count 把 uv.x 缩放到单帧子区宽，仅在该帧内采样。
  o.uv = vec2f(i.uv.x + corner.x*(0.5/p.frame_count), i.uv.y + corner.y*0.5);
  o.color = i.color; o.alpha = i.alpha;
  return o;
}
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@fragment fn fs(o:VsOut) -> @location(0) vec4f {
  let texel = textureSample(tex, samp, o.uv);
  return vec4f(o.color * texel.rgb, o.alpha * texel.a);
}
