// 图片平面渲染（quad 由 vertex_index 推导角点）+ 纹理采样。
// 坐标约定：ImageUniform.center_x/center_y = quad 中心 NDC；CPU 经 coords::image_center_ndc 完成
// WE 左下原点、y 向上 → 中心原点、y 向上（对齐 scene-renderer.ts setImageObject 的 `ox-w/2, oy-h/2`。
// 两系 y 同向，不翻转）。
// UV 方向：上传纹理 top-down（write_texture 数据行，v=0=图像顶部），故 quad 顶部（corner.y=1）采样
// v=0 → `uv.y = 1.0 - corner.y`。曾误判 v=0=底部（被全局 passthrough 镜像掩盖、bypass 直渲才暴露），
// 教训见 git log（d926c99）。
// T4.3 调制：tint = vec4f(rgb=color×brightness 0-1, a=alpha 0-1)；采样逐通道相乘，缺省 (1,1,1,1) 无调制。
// ImageUniform 布局 32B：4×f32（@0/@4/@8/@12）+ vec4f tint（@16，对齐 16）。

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
    out.uv = vec2<f32>(corner.x, 1.0 - corner.y);
    return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    // T4.3 调制：采样 × tint（rgb 乘 color×brightness、a 乘 alpha）；保留 alpha 让透明边缘露出背景。
    return textureSample(tex, samp, in.uv) * img.tint;
}
