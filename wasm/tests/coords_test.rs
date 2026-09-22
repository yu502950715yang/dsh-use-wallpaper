use we_scene_wasm::coords;

// 2026-09-22：本文件原先还覆盖 origin_to_center / particle_scale / image_center_ndc /
// image_half_ndc —— 它们只服务已删除的 WebGPU 渲染器，已随代码一起移除，只留 we_to_three。

#[test]
fn eva_fullscreen_image_centers_at_zero() {
    // EVA 主图 origin=(1200, 777.5) = size/2，视口 2400×1555 → 中心应为 (0,0)
    let (x, y) = coords::we_to_three(1200.0, 777.5, 2400.0, 1555.0);
    assert!((x).abs() < 1e-4, "x={x}");
    assert!((y).abs() < 1e-4, "y={y}");
}

#[test]
fn we_to_three_does_not_flip_y() {
    // WE (0,0)（左下角、y 向上）→ 中心系 (-vw/2, -vh/2)：y 与 WE 同向，**不翻转**。
    let (x, y) = coords::we_to_three(0.0, 0.0, 1920.0, 1080.0);
    assert_eq!((x, y), (-960.0, -540.0));
}

#[test]
fn we_to_three_asymmetric_origin_keeps_sign() {
    // 非对称原点（回归旧 `vh/2 - we_y` 的上下镜像缺陷）：we_y < vh/2 → three_y < 0
    let (_, y) = coords::we_to_three(0.0, 100.0, 1920.0, 1080.0);
    assert!(y < 0.0, "y={y}（旧实现会得到正的 +440，即上下镜像）");
}
