// 全屏 quad 透传效果 shader（Task2 基线）。NDC 顶点由 @builtin(vertex_index) 推导角点
// （与 shaders/image.wgsl 同模式，triangle-strip 4 顶点），fragment 采样输入纹理透传输出。
// UV y 方向（task-20 修正）：离屏为**渲染目标**（v=0=顶部内存行 = NDC 顶部内容），surface 顶部
// 应采样离屏顶部 → uv.y = 1.0 - c.y（不镜像）。旧实现 `out.uv = c` 使 surface 顶部采样离屏底部
// → 整帧垂直镜像：居中背景（center=0）镜像后不变，非居中对象（人物）被镜像到顶部（位置偏上）。
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, };
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    var out: VSOut;
    let c = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u));
    out.pos = vec4<f32>(c * 2.0 - 1.0, 0.0, 1.0);
    out.uv = vec2<f32>(c.x, 1.0 - c.y);
    return out;
}
@fragment fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    return textureSample(tex, samp, in.uv);
}
