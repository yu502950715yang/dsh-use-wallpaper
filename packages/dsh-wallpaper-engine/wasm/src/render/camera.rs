//! 相机范围数学（对齐 scene-renderer.ts 的 containRange/coverRange）

/// contain：场景完整可见、不变形，多出的方向留白（透明）
pub fn contain_range(width: f32, height: f32, view_aspect: f32) -> (f32, f32) {
    let scene_aspect = width / height;
    if scene_aspect > view_aspect {
        (width, width / view_aspect)
    } else {
        (height * view_aspect, height)
    }
}

/// cover：场景铺满视口、不变形，超出方向被裁剪
pub fn cover_range(width: f32, height: f32, view_aspect: f32) -> (f32, f32) {
    let scene_aspect = width / height;
    if view_aspect > scene_aspect {
        (width, width / view_aspect)
    } else {
        (height * view_aspect, height)
    }
}
