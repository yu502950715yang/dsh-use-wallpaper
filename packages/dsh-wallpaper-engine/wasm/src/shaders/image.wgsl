// 图片平面渲染（Task 9 修复）：NDC 顶点（vertex_index 推导 quad 角点）+ 纹理采样。
// 坐标约定：ImageUniform.center_x/center_y = quad 中心 NDC（CPU 按 contain/cover 相机范围
// 归一化，经 coords::image_center_ndc 完成 WE 左下原点、y 向上 → 中心原点、y 向上——
// 对齐 scene-renderer.ts setImageObject 的 `(ox - w/2, oy - h/2)` 映射，两系 y 同向不做翻转）。
// UV 翻转：场景 y 向上（quad 顶部 corner.y=1）↔ WebGPU 纹理 v=0（顶部），故 v = 1 - corner.y。

struct ImageUniform {
    center_x: f32,
    center_y: f32,
    half_w: f32,
    half_h: f32,
};

@group(0) @binding(0) var<uniform> img: ImageUniform;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    var out: VSOut;
    let corner = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u));
    let pos = vec2<f32>(
        img.center_x + (corner.x - 0.5) * 2.0 * img.half_w,
        img.center_y + (corner.y - 0.5) * 2.0 * img.half_h,
    );
    out.pos = vec4<f32>(pos, 0.0, 1.0);
    out.uv = vec2<f32>(corner.x, 1.0 - corner.y);
    return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    // 保留纹理 alpha：前景 contain 的透明/半透明区域露出背景层（cover + CSS blur），
    // 对齐 scene-renderer.ts 双 canvas 语义（透明边缘露出模糊背景而非黑色）。
    return textureSample(tex, samp, in.uv);
}
