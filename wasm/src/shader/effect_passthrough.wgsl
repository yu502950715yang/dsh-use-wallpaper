// 全屏 quad 透传效果 shader（Task2 基线）。NDC 顶点由 @builtin(vertex_index) 推导角点
// （与 shaders/image.wgsl 同模式，triangle-strip 4 顶点），fragment 采样输入纹理透传输出。
// 不翻转 y（NDC 全屏 quad 用 c*2-1，WE 场景系 y 向上，无需 y 翻转）。
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, };
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    var out: VSOut;
    let c = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u));
    out.pos = vec4<f32>(c * 2.0 - 1.0, 0.0, 1.0);
    out.uv = c;
    return out;
}
@fragment fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    return textureSample(tex, samp, in.uv);
}
