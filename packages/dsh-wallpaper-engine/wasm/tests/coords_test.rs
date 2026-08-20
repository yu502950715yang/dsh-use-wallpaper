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

// —— Task 9 审查修复：image_center_ndc 的 y 翻转（原实现 (oy - sh/2) 符号相反，
// 非垂直居中图片上下颠倒；EVA 主图 oy=sh/2 → 0 恰好漏过）——

#[test]
fn image_center_ndc_centered_y_is_zero() {
    // 垂直居中：oy = sh/2 → center_y NDC = 0（EVA 主图 origin=(1200,777.5), sh=1555）
    let (_, cy) = coords::image_center_ndc([1200.0, 777.5, 0.0], 2400.0, 1555.0, 3133.0, 1555.0);
    assert!(cy.abs() < 1e-4, "居中 center_y 应为 0, got {cy}");
}

#[test]
fn image_center_ndc_top_y_is_positive() {
    // 场景顶部：oy=0（WE y 向下，顶部=0）→ 翻转后 center_y = +1（NDC 顶部）
    let (_, cy) = coords::image_center_ndc([0.0, 0.0, 0.0], 100.0, 100.0, 100.0, 100.0);
    assert!((cy - 1.0).abs() < 1e-4, "顶部 center_y 应为 +1, got {cy}");
}

#[test]
fn image_center_ndc_bottom_y_is_negative() {
    // 场景底部：oy=sh → 翻转后 center_y = -1（NDC 底部）
    let (_, cy) = coords::image_center_ndc([0.0, 100.0, 0.0], 100.0, 100.0, 100.0, 100.0);
    assert!((cy + 1.0).abs() < 1e-4, "底部 center_y 应为 -1, got {cy}");
}

#[test]
fn image_center_ndc_consistency_with_we_to_three() {
    // 与 we_to_three 语义严格一致（y 翻转，非对称原点验证）
    let origin = [430.0, 220.0, 0.0];
    let (sw, sh, fw, fh) = (1280.0, 720.0, 1600.0, 900.0);
    let (wx, wy) = coords::we_to_three(origin[0], origin[1], sw, sh);
    let (cx, cy) = coords::image_center_ndc(origin, sw, sh, fw, fh);
    assert!((cx - wx / (fw / 2.0)).abs() < 1e-4);
    assert!((cy - wy / (fh / 2.0)).abs() < 1e-4);
}

#[test]
fn image_half_ndc_size_priority_and_scale() {
    // obj.size 优先（2400×1555），scale=(1,1,1)，相机 3133×1555
    let (hw, hh) = coords::image_half_ndc(Some([2400.0, 1555.0]), [1.0, 1.0, 1.0], 4096, 2048, 3133.0, 1555.0);
    assert!((hw - 1200.0 / 1566.5).abs() < 1e-4, "hw={hw}");
    assert!((hh - 1.0).abs() < 1e-4, "hh={hh}");
    // 缺省回退纹理宽高
    let (hw2, _) = coords::image_half_ndc(None, [1.0, 1.0, 1.0], 4096, 2048, 4096.0, 2048.0);
    assert!((hw2 - 1.0).abs() < 1e-4, "纹理宽高回退 hw2={hw2}");
}
