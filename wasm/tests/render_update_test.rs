//! Task 1: Renderer::update_image 字段更新语义的 native 测试。
//!
//! 说明：SceneImage 含 wgpu::Texture/BindGroup 等类型（render feature 门控），
//! native `cargo test`（无 render feature）无法构造。因此把「一次动态更新应改哪些
//! 字段」抽成纯函数 `apply_image_update(state: &mut ObjectState, ...)`（与 wgpu 解耦），
//! `Renderer::update_image` 对每个匹配的 SceneImage 做相同字段操作。本测试直接覆盖
//! 纯函数，验证 None = 保持现状、Some = 替换的字段语义。

use we_scene_wasm::render::{apply_image_update, ObjectState};

#[test]
fn apply_update_replaces_origin() {
    let mut s = ObjectState { origin: [1.0, 2.0, 3.0], scale: [1.0, 1.0, 1.0], tint_alpha: None, tint_brightness: None };
    apply_image_update(&mut s, Some([9.0, 8.0, 7.0]), None, None, None);
    assert_eq!(s.origin, [9.0, 8.0, 7.0]);
    assert_eq!(s.scale, [1.0, 1.0, 1.0]); // 保持
}

#[test]
fn apply_update_none_keeps() {
    let mut s = ObjectState { origin: [1.0, 2.0, 3.0], scale: [1.0, 1.0, 1.0], tint_alpha: Some(0.5), tint_brightness: Some(2.0) };
    apply_image_update(&mut s, None, Some([2.0, 2.0, 2.0]), None, None);
    assert_eq!(s.origin, [1.0, 2.0, 3.0]);
    assert_eq!(s.scale, [2.0, 2.0, 2.0]);
    assert_eq!(s.tint_alpha, Some(0.5));
}

#[test]
fn apply_update_replaces_alpha_brightness() {
    let mut s = ObjectState { origin: [0.0, 0.0, 0.0], scale: [1.0, 1.0, 1.0], tint_alpha: None, tint_brightness: None };
    apply_image_update(&mut s, None, None, Some(0.3), Some(1.5));
    assert_eq!(s.tint_alpha, Some(0.3));
    assert_eq!(s.tint_brightness, Some(1.5));
}

// =====================================================================
// M3/Task5：对象内容 quad 渲染到对象 RT 的 NDC uniform（content_ndc，native 纯函数）
// =====================================================================

use we_scene_wasm::render::content_ndc;

/// 内容在局部空间中心原点 → NDC center=(0,0)；world==rt（未钳制）→ half=1（内容填满 RT）。
#[test]
fn content_ndc_centered_at_origin() {
    let u = content_ndc([100.0, 100.0], 100.0, 100.0, [1.0, 1.0, 1.0, 1.0]);
    assert_eq!((u.center_x, u.center_y), (0.0, 0.0));
    assert!((u.half_w - 1.0).abs() < 1e-6);
    assert!((u.half_h - 1.0).abs() < 1e-6);
}

/// 负 scale → half 保留符号（镜像由内容 RT 承载，见 task-4.4「镜像活在 mesh/RT 内容」）。
#[test]
fn content_ndc_negative_scale_mirrors() {
    let u = content_ndc([100.0, -100.0], 100.0, 100.0, [1.0, 1.0, 1.0, 1.0]);
    assert!((u.half_w - 1.0).abs() < 1e-6);
    assert!((u.half_h + 1.0).abs() < 1e-6);
}
