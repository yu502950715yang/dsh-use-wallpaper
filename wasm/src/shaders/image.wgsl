// 图片平面渲染（Task 9 修复）：NDC 顶点（vertex_index 推导 quad 角点）+ 纹理采样。
// 坐标约定：ImageUniform.center_x/center_y = quad 中心 NDC（CPU 按 contain/cover 相机范围
// 归一化，经 coords::image_center_ndc 完成 WE 左下原点、y 向上 → 中心原点、y 向上——
// 对齐 scene-renderer.ts setImageObject 的 `(ox - w/2, oy - h/2)` 映射，两系 y 同向不做翻转）。
// UV 方向（2026-08-31 方向修正，实测 headless Edge WebGPU）：纹理经 write_texture 上传（数据
// 从 mip0 顶部行起），纹理坐标 v=0 对应**数据最后一行（图像底部）**、v=1 对应数据首行
// （图像顶部）——即上传后纹理的 v 轴与显示「底→顶」同向（对齐 JS tex-loader：DataTexture
// 翻转行序后 v=0=图像底部、v=1=图像顶部，见 scene-renderer.ts 平面 uv.y=1 顶部采样 v=1）。
// 故 quad 顶部（corner.y=1，画面顶部）应采样 v=1（图像顶部）：v = +corner.y（不做 1.0- 反转；
// 旧实现 `1.0 - corner.y` 把 v=0（图像底部）映到画面顶部 → 上下颠倒）。
// T4.3 调制：tint = vec4f（rgb = color×brightness 0-1、a = alpha 0-1，CPU 侧 image_tint
// 计算），fs_main 采样结果逐通道相乘（rgb × tint.rgb、a × tint.a）；全缺省 → (1,1,1,1)
// 等价无调制。布局 32 字节：4×f32（@0/@4/@8/@12）+ vec4f tint（@16，对齐 16 无填充）。

struct ImageUniform {
    center_x: f32,
    center_y: f32,
    half_w: f32,
    half_h: f32,
    tint: vec4f,
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
    out.uv = vec2<f32>(corner.x, corner.y);
    return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    // T4.3 调制：纹理 × tint（rgb 乘 color×brightness、a 乘 alpha）。
    // 保留纹理 alpha：前景 contain 的透明/半透明区域露出背景层（cover + CSS blur），
    // 对齐 scene-renderer.ts 双 canvas 语义（透明边缘露出模糊背景而非黑色）。
    return textureSample(tex, samp, in.uv) * img.tint;
}
