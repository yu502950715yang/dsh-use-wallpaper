//! WE 场景坐标（左上原点、y 向下）→ WebGPU 中心原点、y 向上。
//! 公式：three.x = we.x - vw/2；three.y = vh/2 - we.y（scene-renderer.ts 文件头注释）

pub fn we_to_three(we_x: f32, we_y: f32, vw: f32, vh: f32) -> (f32, f32) {
    (we_x - vw / 2.0, vh / 2.0 - we_y)
}

/// 对象锚点（origin，WE 场景中的中心点）→ 场景中心坐标
pub fn origin_to_center(origin: [f32; 3], vw: f32, vh: f32) -> [f32; 3] {
    let (x, y) = we_to_three(origin[0], origin[1], vw, vh);
    [x, y, origin[2]]
}

/// 粒子 scale.y 取负完成 y 翻转（方向/速度与 WE 屏幕表现一致）
pub fn particle_scale(scale: [f32; 3]) -> [f32; 3] {
    [scale[0], -scale[1], scale[2]]
}

/// 图片 quad 中心 NDC（Task 9 审查修复：center_y 必须走 we_to_three 的 y 翻转——
/// WE 左上原点、y 向下 → 中心原点、y 向上；原实现 `(oy - sh/2)` 符号相反，
/// 非垂直居中图片上下颠倒。与粒子 origin_to_center / JS scene-renderer.ts:161
/// `mesh.position.set(ox - w/2, h/2 - oy, oz)` 语义一致）。
/// 返回 (center_x_ndc, center_y_ndc)，除以相机半宽/半高（contain/cover 范围）。
pub fn image_center_ndc(
    origin: [f32; 3],
    scene_w: f32,
    scene_h: f32,
    view_w: f32,
    view_h: f32,
) -> (f32, f32) {
    let (x, y) = we_to_three(origin[0], origin[1], scene_w, scene_h);
    (x / (view_w / 2.0), y / (view_h / 2.0))
}

/// 图片 quad 半宽/半高 NDC：尺寸×scale/2 除以相机半宽/半高。
/// 尺寸 = obj.size 优先、缺省回退纹理宽高（对齐 scene-renderer.ts setImageObject）；
/// scale.y 不取负（图片与粒子不同，JS 版 mesh.scale 直接 set(s[0], s[1])）。
pub fn image_half_ndc(
    size: Option<[f32; 2]>,
    scale: [f32; 3],
    tex_w: u32,
    tex_h: u32,
    view_w: f32,
    view_h: f32,
) -> (f32, f32) {
    let w = size.map(|s| s[0]).unwrap_or(tex_w as f32);
    let h = size.map(|s| s[1]).unwrap_or(tex_h as f32);
    (
        (w * scale[0] / 2.0) / (view_w / 2.0),
        (h * scale[1] / 2.0) / (view_h / 2.0),
    )
}
