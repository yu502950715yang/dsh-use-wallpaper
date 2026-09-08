//! 坐标层：WE 场景坐标（左下原点、y 向上，origin.y 距底部）→ 中心原点（y 向上）的 scene 语义变换。
//! 粒子与背景/图层统一用 `we_to_three`（scene 尺寸、y **不翻**；2026-09-08 修正，不再用旧的
//! `we_to_center`——那是 view cover 尺寸 + Y 翻，与背景坐标错位，是粒子位置不对的根因）。

use we_scene_wasm::coords::we_to_three;

#[test]
fn we_origin_maps_to_scene_center_no_y_flip() {
    // scene 3840x2160；对象 origin (2306.34, 419.77)（黑神话粒子对象，origin.y 靠近 scene 底部）。
    let (x, y) = we_to_three(2306.34, 419.77, 3840.0, 2160.0);
    assert!((x - (2306.34 - 3840.0 / 2.0)).abs() < 1e-3, "x = we_x - scene_w/2");
    // y 不翻：we_to_three 给 origin.y - scene_h/2 = 419.77 - 1080 = -660.23（对象在 scene 中心下方）。
    // 旧 we_to_center（view cover 1906 + Y 翻）给 953 - 419.77 = 533.23（视口中线上方），与背景错位。
    assert!((y - (419.77 - 2160.0 / 2.0)).abs() < 1e-3, "应 y 不翻（scene 中心），got {}", y);
    assert!((y - (-660.23)).abs() < 1e-3, "黑神话对象中心 y 应为 -660.23（scene 语义），got {}", y);
}

#[test]
fn centered_origin_maps_to_scene_origin() {
    // scene 中心对象（背景 origin=1920,1080，scene 3840x2160）→ 中心 (0,0)（与 image_center_ndc 一致）。
    let (x, y) = we_to_three(1920.0, 1080.0, 3840.0, 2160.0);
    assert!((x).abs() < 1e-6, "x 应 0，got {}", x);
    assert!(y.abs() < 1e-6, "y 应 0（居中对象不被镜像/翻转），got {}", y);
}

/// emitter.origin 作为加到对象中心的局部偏移（y 不翻）：黑神话对象 (2306.34,419.77,scene 3840x2160)
/// → 对象中心 (386.34, -660.23)；emitter.origin=(350,750) → 发射点 (736.34, 89.77)（中心上方）。
#[test]
fn emitter_origin_offset_y_not_flipped() {
    let (cx, cy) = we_to_three(2306.34, 419.77, 3840.0, 2160.0);
    let px = cx + 350.0;
    let py = cy + 750.0;
    assert!((px - 736.34).abs() < 1e-3, "发射点 x 应为 736.34（we_to_three 场景语义），got {}", px);
    assert!((py - 89.77).abs() < 1e-3, "发射点 y 应为 89.77（origin.y 不翻），got {}", py);
    assert!(py > 0.0, "黑神话花瓣应从中心上方（y>0）发射，got {}", py);
}
