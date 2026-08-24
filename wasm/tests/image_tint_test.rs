//! Task 4.3: 图片对象调制——ImageUniform 布局（32B）与 image_tint 纯函数 native 测试。
//! `image_ndc` 位于 render feature 门控区（依赖 wgpu 的 SceneImage），调制数学抽为
//! 无门控纯函数 `image_tint`（color×brightness clamp 0-1、alpha clamp 0-1），
//! 供 image_ndc 打包 tint，native cargo test（无 render feature）直接覆盖。

use we_scene_wasm::render::{image_tint, ImageUniform};

#[test]
fn image_uniform_layout_is_32_bytes_with_tint_at_16() {
    // 4×f32（center_x/y、half_w/h）后接 tint vec4f：32 字节（16B → 32B 扩展）。
    // vec4 对齐 16，偏移 16 恰好对齐、无隐式填充；与 shaders/image.wgsl 的
    // ImageUniform（center@0、half@12、tint@16）field-for-field 一致。
    assert_eq!(std::mem::size_of::<ImageUniform>(), 32);
    assert_eq!(std::mem::offset_of!(ImageUniform, center_x), 0);
    assert_eq!(std::mem::offset_of!(ImageUniform, center_y), 4);
    assert_eq!(std::mem::offset_of!(ImageUniform, half_w), 8);
    assert_eq!(std::mem::offset_of!(ImageUniform, half_h), 12);
    assert_eq!(std::mem::offset_of!(ImageUniform, tint_r), 16);
    assert_eq!(std::mem::offset_of!(ImageUniform, tint_g), 20);
    assert_eq!(std::mem::offset_of!(ImageUniform, tint_b), 24);
    assert_eq!(std::mem::offset_of!(ImageUniform, tint_a), 28);
}

#[test]
fn image_tint_defaults_to_no_modulation() {
    // 无 color/alpha/brightness → (1,1,1,1)：纹理原样输出（向后兼容，不改变旧行为）
    assert_eq!(image_tint(None, None, None), [1.0, 1.0, 1.0, 1.0]);
}

#[test]
fn image_tint_color_255_scale_divided_to_unit() {
    // color 为 0-255 量级（对齐 JS optColor 输出）：/255 归一化
    assert_eq!(image_tint(Some([255.0, 0.0, 0.0]), None, None), [1.0, 0.0, 0.0, 1.0]);
    let t = image_tint(Some([128.0, 64.0, 32.0]), None, None);
    assert!((t[0] - 128.0 / 255.0).abs() < 1e-6, "r={}", t[0]);
    assert!((t[1] - 64.0 / 255.0).abs() < 1e-6, "g={}", t[1]);
    assert!((t[2] - 32.0 / 255.0).abs() < 1e-6, "b={}", t[2]);
}

#[test]
fn image_tint_brightness_multiplies_and_clamps() {
    // brightness 乘入 color：×0.5 减半；×2 超 1 → clamp 1（MeshBasicMaterial 无亮度通道）
    assert_eq!(image_tint(Some([255.0, 255.0, 255.0]), None, Some(0.5)), [0.5, 0.5, 0.5, 1.0]);
    assert_eq!(image_tint(Some([200.0, 200.0, 200.0]), None, Some(2.0)), [1.0, 1.0, 1.0, 1.0]);
}

#[test]
fn image_tint_alpha_clamped_and_defaulted() {
    assert_eq!(image_tint(None, Some(0.5), None), [1.0, 1.0, 1.0, 0.5]);
    // alpha 超出 0-1 → clamp（解析器已归一化，此处防御性 clamp）
    assert_eq!(image_tint(None, Some(1.5), None), [1.0, 1.0, 1.0, 1.0]);
}
