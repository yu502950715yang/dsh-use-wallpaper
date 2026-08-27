// 对象合成 quad shader（Milestone 3 / Task5，wasm 内置 WGSL，不经过 naga glsl-in）。
// 用途：把带效果对象的对象 RT（效果链输出 / 原始内容）经 UV 窗口映射贴回 surface——
// 完成「对象 RT → 效果链 ping-pong → 合成 quad → surface」对象级管线链路。
//
// 顶点：由 @builtin(vertex_index) 推导 triangle-strip 4 顶点（与 shaders/image.wgsl 同模式）。
//   pos = center + (corner - 0.5) × 2 × half（center/half 为 CPU 算的 NDC 中心/半宽，
//   CompositeUniform；quad 帧尺寸 = 未钳制 |world_size|，见 effect::composite_ndc_uniform）。
//   uv = 基础 UV 经窗口展开：(base_uv - uv_start) / (uv_end - uv_start)；未钳制轴窗口
//   [0,1] 时等价 base_uv（精确 1:1）。基础 UV y 翻转（场景 y 向上 ↔ 纹理 v=0 顶部，
//   同 image.wgsl），x 不翻转。
// 片元：采样对象 RT/效果输出纹理（绑定 1）+ sampler（绑定 2）。该纹理与场景已同系（对象
// 内容渲染进 RT 时已由 image.wgsl 做过 y 翻转），故此处不再二次翻转（对齐 JS `applyUvWindow`）。
//
// CompositeUniform 布局（32 字节 = 8×f32，CPU 侧 effect::CompositeUniform，repr(C)）：

struct CompositeUniform {
    center_x: f32,
    center_y: f32,
    half_w: f32,
    half_h: f32,
    uv_w0: f32,
    uv_w1: f32,
    uv_h0: f32,
    uv_h1: f32,
};

@group(0) @binding(0) var<uniform> u: CompositeUniform;
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
        u.center_x + (corner.x - 0.5) * 2.0 * u.half_w,
        u.center_y + (corner.y - 0.5) * 2.0 * u.half_h,
    );
    // 基础 UV：y 翻转（corner.y=1 顶部 → 纹理 v=0 顶部，同 image.wgsl 约定）。
    let base_uv = vec2<f32>(corner.x, 1.0 - corner.y);
    let wlen = u.uv_w1 - u.uv_w0;
    let hlen = u.uv_h1 - u.uv_h0;
    // 窗口展开：UV' = (base_uv - start) / (end - start)。未钳制轴 start=0/end=1 → UV'=base_uv；
    // 钳制轴中间 [start,end] 与 RT [0,1] 一一对应（RT 像素与场景像素 1:1），窗口外侧由采样器
    // ClampToEdge 夹到 0/1。len>0 防御（uv_window 恒 end>start，此处防御钳制退化）。
    let uv = vec2<f32>(
        select(base_uv.x, (base_uv.x - u.uv_w0) / wlen, wlen > 0.0),
        select(base_uv.y, (base_uv.y - u.uv_h0) / hlen, hlen > 0.0),
    );
    out.pos = vec4<f32>(pos, 0.0, 1.0);
    out.uv = uv;
    return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    // 采样对象 RT/效果输出。alpha 混合在管线 ColorTargetState 配置（透明边缘露背景层，
    // 对齐 JS MeshBasicMaterial transparent）。这里不做调制（对象调制已在源内容带入 RT）。
    return textureSample(tex, samp, in.uv);
}
