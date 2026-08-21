use we_scene_wasm::coords;

#[test]
fn eva_fullscreen_image_centers_at_zero() {
    // EVA 主图 origin=(1200, 777.5) = size/2，视口 2400×1555 → 中心应为 (0,0)
    let (x, y) = coords::we_to_three(1200.0, 777.5, 2400.0, 1555.0);
    assert!((x).abs() < 1e-4, "x={x}");
    assert!((y).abs() < 1e-4, "y={y}");
}

#[test]
fn origin_to_center_maps_y_no_flip() {
    // WE (0,0)（左下角、y 向上）→ 中心系 (-vw/2, -vh/2)
    // 2026-08-20 方向修正：WE y 向上与渲染系同向，origin.y 是距底部距离（不翻转）
    let c = coords::origin_to_center([0.0, 0.0, 5.0], 1920.0, 1080.0);
    assert_eq!(c, [-960.0, -540.0, 5.0]);
}

#[test]
fn particle_scale_keeps_y() {
    // 2026-08-20：scale.y 不再取负（WE y 向上与渲染系同向）
    assert_eq!(coords::particle_scale([1.0, 2.0, 3.0]), [1.0, 2.0, 3.0]);
}

#[test]
fn particle_scale_keeps_negative_y() {
    // T4.4：负 scale.y 透传（不取负、不钳制为正）——粒子为圆盘，镜像不可见；
    // 布局绕 origin 镜像由 shader 的 `pos = origin + dir*dist*scale` 直乘承担。
    // 2026-08-20 约定（AGENT.md §2.3）：不得把负 scale 当作映射级 y 翻转重取负。
    assert_eq!(coords::particle_scale([0.41565, -0.18259, 1.0]), [0.41565, -0.18259, 1.0]);
}

// —— 2026-08-20 方向修正：image_center_ndc 的 y 不再翻转（原 `vh/2 - we_y` 把
// 非居中对象上下镜像：NERV logo origin.y=150 官方在右下角被渲染到右上角；
// Orange 部件被渲染到少女头顶。EVA 主图 oy=sh/2 恰为 0 故旧实现漏过）——

#[test]
fn image_center_ndc_centered_y_is_zero() {
    // 垂直居中：oy = sh/2 → center_y NDC = 0（EVA 主图 origin=(1200,777.5), sh=1555）
    let (_, cy) = coords::image_center_ndc([1200.0, 777.5, 0.0], 2400.0, 1555.0, 3133.0, 1555.0);
    assert!(cy.abs() < 1e-4, "居中 center_y 应为 0, got {cy}");
}

#[test]
fn image_center_ndc_top_y_is_positive() {
    // 场景顶部：oy=sh（WE y 向上，顶部=sh）→ center_y = +1（NDC 顶部）
    let (_, cy) = coords::image_center_ndc([0.0, 100.0, 0.0], 100.0, 100.0, 100.0, 100.0);
    assert!((cy - 1.0).abs() < 1e-4, "顶部 center_y 应为 +1, got {cy}");
}

#[test]
fn image_center_ndc_bottom_y_is_negative() {
    // 场景底部：oy=0（WE y 向上，底部=0）→ center_y = -1（NDC 底部）
    let (_, cy) = coords::image_center_ndc([0.0, 0.0, 0.0], 100.0, 100.0, 100.0, 100.0);
    assert!((cy + 1.0).abs() < 1e-4, "底部 center_y 应为 -1, got {cy}");
}

#[test]
fn image_center_ndc_consistency_with_we_to_three() {
    // 与 we_to_three 语义严格一致（y 不翻转，非对称原点验证）
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

#[test]
fn image_half_ndc_negative_scale_y_mirrors() {
    // T4.4：负 scale.y → 负 half_h（镜像）。image.wgsl 顶点 `center_y + (corner.y-0.5)*2*half_h`
    // 中负 half_h 翻转 quad 顶点 y、UV 不变 → 纹理内容镜像（与 JS 版 mesh.scale 负 y 同语义，
    // 属对象自身镜像，与 2026-08-20 映射级 y 翻转修复无关）。
    let (_, hh) = coords::image_half_ndc(Some([400.0, 300.0]), [1.0, -0.18, 1.0], 4096, 2048, 1920.0, 1080.0);
    assert!(hh < 0.0, "负 scale.y 应产生负 half_h（镜像）, got {hh}");
    // 幅值 = 正 scale 的 half_h（镜像只改方向、不改大小）
    let (_, hh_pos) = coords::image_half_ndc(Some([400.0, 300.0]), [1.0, 0.18, 1.0], 4096, 2048, 1920.0, 1080.0);
    assert!((hh + hh_pos).abs() < 1e-4, "镜像 half_h 应为 -正 half_h, got {hh} vs {hh_pos}");
    // x 轴同理（负 scale.x → 负 half_w）
    let (hw, _) = coords::image_half_ndc(Some([400.0, 300.0]), [-0.5, 1.0, 1.0], 4096, 2048, 1920.0, 1080.0);
    assert!(hw < 0.0, "负 scale.x 应产生负 half_w, got {hw}");
}
