//! TexFormat → wgpu 纹理格式映射测试（native 可测层）。
//!
//! wgpu 为 optional 依赖（render feature 门控），native `cargo test` 无 wgpu，
//! 故映射函数分两层：
//! - `tex::tex_format_id`：TexFormat → 字符串标识（无 wgpu 依赖，本文件测这层）
//! - `render::texture::tex_format_to_wgpu`：字符串标识 → wgpu::TextureFormat
//!   （render feature 下由 wasm 构建编译验证，与 tex_format_id 一一对应）
//! 两层的映射表必须严格一致（Dxt1→BC1、Dxt3→BC2、Dxt5→BC3、R8→R8、RG88→RG8）。

use we_scene_wasm::tex::{copy_layout, tex_format_id, TexFormat, TexImage};

fn img(w: u32, h: u32, format: TexFormat, len: usize) -> TexImage {
    TexImage { width: w, height: h, format, mip0: vec![0u8; len] }
}

#[test]
fn maps_all_supported_formats() {
    assert!(tex_format_id(TexFormat::Rgba8888).is_some());
    assert!(tex_format_id(TexFormat::Dxt1).is_some());
    assert!(tex_format_id(TexFormat::Dxt3).is_some());
    assert!(tex_format_id(TexFormat::Dxt5).is_some());
    assert!(tex_format_id(TexFormat::R8).is_some());
    assert!(tex_format_id(TexFormat::Rg88).is_some());
    assert!(tex_format_id(TexFormat::Unsupported(99)).is_none());
}

#[test]
fn dxt_maps_to_bc_ids() {
    assert_eq!(tex_format_id(TexFormat::Dxt1), Some("bc1-rgba-unorm"));
    assert_eq!(tex_format_id(TexFormat::Dxt3), Some("bc2-rgba-unorm"));
    assert_eq!(tex_format_id(TexFormat::Dxt5), Some("bc3-rgba-unorm"));
}

#[test]
fn rgba_r8_rg88_map_ids() {
    assert_eq!(tex_format_id(TexFormat::Rgba8888), Some("rgba8unorm"));
    assert_eq!(tex_format_id(TexFormat::R8), Some("r8-unorm"));
    assert_eq!(tex_format_id(TexFormat::Rg88), Some("rg8-unorm"));
}

#[test]
fn unsupported_never_maps() {
    assert_eq!(tex_format_id(TexFormat::Unsupported(0)), None);
    assert_eq!(tex_format_id(TexFormat::Unsupported(7)), None);
}

// ===== copy_layout（上传布局纯计算，审查 Round 1 修复）=====

#[test]
fn layout_non_compressed_rows_are_pixel_rows_and_256_aligned() {
    // 审查反例：1080 宽 RGBA8888。raw_row = 4320 非 256 对齐 → bytes_per_row 显式对齐 4352
    let l = copy_layout(&img(1080, 1920, TexFormat::Rgba8888, 1080 * 1920 * 4)).expect("rgba 应可布局");
    assert_eq!(l.raw_row, 1080 * 4);
    assert_eq!(l.bytes_per_row, 4352); // (4320 + 255) & !255
    assert_eq!(l.rows, 1920);
    assert_eq!(l.bytes_per_row % 256, 0);
    assert!(l.needs_padding());
}

#[test]
fn layout_compressed_rows_are_block_rows_and_256_aligned() {
    // 审查反例：1080 宽 DXT1（块 4x4）：block_w=270，raw_row=2160 → 对齐 2304，rows=270 块行
    let l = copy_layout(&img(1080, 1080, TexFormat::Dxt1, 270 * 270 * 8)).expect("dxt1 应可布局");
    assert_eq!(l.raw_row, 270 * 8);
    assert_eq!(l.bytes_per_row, 2304);
    assert_eq!(l.rows, 270);
    assert_eq!(l.bytes_per_row % 256, 0);
    assert!(l.needs_padding());
}

#[test]
fn layout_small_widths_normalize_and_pad() {
    // 宽度 0/1 归一为 1（审查反例：任意 <256 宽 R8 → bytes_per_row 对齐 256）
    let l = copy_layout(&img(0, 1, TexFormat::R8, 1)).expect("r8 应可布局");
    assert_eq!(l.raw_row, 1);
    assert_eq!(l.bytes_per_row, 256);
    assert_eq!(l.rows, 1);
    let l = copy_layout(&img(1, 1, TexFormat::R8, 1)).expect("r8 应可布局");
    assert_eq!(l.bytes_per_row, 256);
    assert!(l.needs_padding());
    // 已 256 对齐的宽度零拷贝（needs_padding=false）
    let l = copy_layout(&img(256, 1, TexFormat::R8, 256)).expect("r8 应可布局");
    assert_eq!(l.bytes_per_row, 256);
    assert!(!l.needs_padding());
    let l = copy_layout(&img(64, 8, TexFormat::Rgba8888, 64 * 8 * 4)).expect("rgba 应可布局");
    assert_eq!(l.bytes_per_row, 256);
    assert!(!l.needs_padding());
}

#[test]
fn layout_non_compressed_height_above_4_uses_pixel_rows() {
    // 非压缩格式 rows = 高（不能是 ceil(h/4) 块行数；wgpu-core 校验 rows_per_image >= height_in_blocks）
    let l = copy_layout(&img(16, 8, TexFormat::Rgba8888, 16 * 8 * 4)).expect("rgba 应可布局");
    assert_eq!(l.rows, 8);
    let l = copy_layout(&img(16, 8, TexFormat::Rg88, 16 * 8 * 2)).expect("rg88 应可布局");
    assert_eq!(l.rows, 8);
    let l = copy_layout(&img(16, 8, TexFormat::R8, 16 * 8)).expect("r8 应可布局");
    assert_eq!(l.rows, 8);
}

#[test]
fn layout_dxt3_dxt5_use_16_byte_blocks() {
    let l = copy_layout(&img(8, 8, TexFormat::Dxt3, 2 * 2 * 16)).expect("dxt3 应可布局");
    assert_eq!(l.raw_row, 2 * 16);
    assert_eq!(l.bytes_per_row, 256);
    assert_eq!(l.rows, 2);
    let l = copy_layout(&img(8, 8, TexFormat::Dxt5, 2 * 2 * 16)).expect("dxt5 应可布局");
    assert_eq!(l.raw_row, 32);
    assert_eq!(l.rows, 2);
}

#[test]
fn layout_unsupported_is_none() {
    assert!(copy_layout(&img(2, 2, TexFormat::Unsupported(9), 16)).is_none());
}
