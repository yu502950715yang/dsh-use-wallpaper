//! 坐标层 Task 1：WE 屏幕坐标（y 向下）→ 中心原点（y 向上）的粒子坐标变换。
//! 与 we_to_three（图片，y 不翻转）不同，粒子按 linux CParticle 语义做 Y 翻转。

use we_scene_wasm::coords::we_to_center;

#[test]
fn we_origin_flips_y_to_center() {
    // scene 3840x2160、view cover 3840x1906；对象 origin (2306.34, 419.77)
    let c = we_to_center([2306.34, 419.77, 0.0], 3840.0, 1906.0);
    assert!((c[0] - (2306.34 - 3840.0/2.0)).abs() < 1e-3);
    assert!((c[1] - (1906.0/2.0 - 419.77)).abs() < 1e-3, "应 Y 翻到上方");
}
