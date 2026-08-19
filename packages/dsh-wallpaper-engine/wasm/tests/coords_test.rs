use we_scene_wasm::coords;

#[test]
fn eva_fullscreen_image_centers_at_zero() {
    // EVA 主图 origin=(1200, 777.5) = size/2，视口 2400×1555 → 中心应为 (0,0)
    let (x, y) = coords::we_to_three(1200.0, 777.5, 2400.0, 1555.0);
    assert!((x).abs() < 1e-4, "x={x}");
    assert!((y).abs() < 1e-4, "y={y}");
}

#[test]
fn origin_to_center_maps_y_flip() {
    // WE (0,0)（左上角）→ 中心系 (-vw/2, +vh/2)
    let c = coords::origin_to_center([0.0, 0.0, 5.0], 1920.0, 1080.0);
    assert_eq!(c, [-960.0, 540.0, 5.0]);
}

#[test]
fn particle_scale_flips_y() {
    assert_eq!(coords::particle_scale([1.0, 2.0, 3.0]), [1.0, -2.0, 3.0]);
}
