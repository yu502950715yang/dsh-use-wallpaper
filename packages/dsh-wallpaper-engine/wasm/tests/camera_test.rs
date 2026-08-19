use we_scene_wasm::render::camera::{contain_range, cover_range};

#[test]
fn contain_wide_scene_leaves_vertical_letterbox() {
    // 场景 2400x1200（aspect 2.0 > 视口 1.778，更宽），视口 1920x1080
    // → 宽度铺满相机（w=2400），垂直留白（h=1350 > 1200）。
    // 注：brief 原用例 2400x1555（aspect 1.543 < 1.778）实为"更窄"场景，
    // 其断言 w==2400 且 h>1555 要求相机宽高比 != 视口比例，与不变形性质矛盾；
    // 实现严格对齐 scene-renderer.ts 的 containRange，故修正用例以匹配"宽场景"意图。
    let (w, h) = contain_range(2400.0, 1200.0, 1920.0 / 1080.0);
    assert_eq!(w, 2400.0);
    assert!(h > 1200.0, "垂直应留白: {h}");
    // 相机宽高比恒等于视口比例（contain 不变形）
    assert!((w / h - 1920.0 / 1080.0).abs() < 1e-4);
}

#[test]
fn contain_narrow_scene_leaves_horizontal_letterbox() {
    let (w, h) = contain_range(1080.0, 1920.0, 1920.0 / 1080.0);
    assert_eq!(h, 1920.0);
    assert!(w > 1080.0);
}

#[test]
fn cover_crops_the_longer_dimension() {
    let (w, h) = cover_range(2400.0, 1555.0, 1920.0 / 1080.0);
    assert_eq!(w, 2400.0);
    assert!(h < 1555.0, "垂直应裁剪: {h}");
}
