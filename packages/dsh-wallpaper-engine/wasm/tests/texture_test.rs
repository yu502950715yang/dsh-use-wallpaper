//! TexFormat → wgpu 纹理格式映射测试（native 可测层）。
//!
//! wgpu 为 optional 依赖（render feature 门控），native `cargo test` 无 wgpu，
//! 故映射函数分两层：
//! - `tex::tex_format_id`：TexFormat → 字符串标识（无 wgpu 依赖，本文件测这层）
//! - `render::texture::tex_format_to_wgpu`：字符串标识 → wgpu::TextureFormat
//!   （render feature 下由 wasm 构建编译验证，与 tex_format_id 一一对应）
//! 两层的映射表必须严格一致（Dxt1→BC1、Dxt3→BC2、Dxt5→BC3、R8→R8、RG88→RG8）。

use we_scene_wasm::tex::{tex_format_id, TexFormat};

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
    assert_eq!(tex_format_id(TexFormat::Dxt1), Some("bc1-rgba-unorm-srgb"));
    assert_eq!(tex_format_id(TexFormat::Dxt3), Some("bc2-rgba-unorm-srgb"));
    assert_eq!(tex_format_id(TexFormat::Dxt5), Some("bc3-rgba-unorm-srgb"));
}

#[test]
fn rgba_r8_rg88_map_ids() {
    assert_eq!(tex_format_id(TexFormat::Rgba8888), Some("rgba8unorm-srgb"));
    assert_eq!(tex_format_id(TexFormat::R8), Some("r8-unorm"));
    assert_eq!(tex_format_id(TexFormat::Rg88), Some("rg8-unorm"));
}

#[test]
fn unsupported_never_maps() {
    assert_eq!(tex_format_id(TexFormat::Unsupported(0)), None);
    assert_eq!(tex_format_id(TexFormat::Unsupported(7)), None);
}
