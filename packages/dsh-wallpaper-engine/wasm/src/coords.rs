//! WE 场景坐标（左下原点、y 向上；origin.y 是距底部的距离）→ 中心原点、y 向上。
//! 公式：three.x = we.x - vw/2；three.y = we.y - vh/2（两系 y 同向，不做翻转）。
//! 2026-08-20 方向修正：旧实现 `vh/2 - we_y` 把非居中对象上下镜像（NERV logo
//! origin.y=150 官方在右下角、被镜像到右上角；Orange 部件被镜像到少女头顶），
//! EVA 主图 oy=sh/2 恰为 0 故验收漏过。scene-renderer.ts 文件头注释同步修正。

pub fn we_to_three(we_x: f32, we_y: f32, vw: f32, vh: f32) -> (f32, f32) {
    (we_x - vw / 2.0, we_y - vh / 2.0)
}

/// 对象锚点（origin，WE 场景中的中心点）→ 场景中心坐标
pub fn origin_to_center(origin: [f32; 3], vw: f32, vh: f32) -> [f32; 3] {
    let (x, y) = we_to_three(origin[0], origin[1], vw, vh);
    [x, y, origin[2]]
}

/// 粒子 scale：y 不取负（WE y 向上与渲染系同向；snowflat 速度 vy∈[-90,-50]
/// 为向下运动即证据。旧实现取负是配合错误的 y 翻转）
pub fn particle_scale(scale: [f32; 3]) -> [f32; 3] {
    [scale[0], scale[1], scale[2]]
}

/// 图片 quad 中心 NDC：WE 左下原点、y 向上 → 中心原点、y 向上（we_to_three，
/// 不翻转），除以相机半宽/半高（contain/cover 范围）。与粒子 origin_to_center /
/// JS scene-renderer.ts `mesh.position.set(ox - w/2, oy - h/2, oz)` 语义一致。
/// 返回 (center_x_ndc, center_y_ndc)。
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
