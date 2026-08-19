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
