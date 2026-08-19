//! TexFormat → wgpu::TextureFormat 映射（WebGPU 原生 BC/R8/RG88 支持）。
//!
//! 本模块仅在 render feature（wasm 构建）下编译：wgpu 是 optional 依赖，
//! native `cargo test` 无法引用 `wgpu::TextureFormat`，故纯映射层放在
//! `crate::tex::tex_format_id`（返回稳定字符串标识，native 可测），本模块的
//! `tex_format_to_wgpu` 与之严格一一对应（映射表变更必须同步两侧）。

use crate::tex::TexFormat;

/// TexFormat → wgpu::TextureFormat（与 `tex::tex_format_id` 一一对应）。
pub fn tex_format_to_wgpu(format: TexFormat) -> Option<wgpu::TextureFormat> {
    match format {
        TexFormat::Rgba8888 => Some(wgpu::TextureFormat::Rgba8UnormSrgb),
        TexFormat::Dxt1 => Some(wgpu::TextureFormat::Bc1RgbaUnormSrgb),
        TexFormat::Dxt3 => Some(wgpu::TextureFormat::Bc2RgbaUnormSrgb),
        TexFormat::Dxt5 => Some(wgpu::TextureFormat::Bc3RgbaUnormSrgb),
        TexFormat::R8 => Some(wgpu::TextureFormat::R8Unorm),
        TexFormat::Rg88 => Some(wgpu::TextureFormat::Rg8Unorm),
        TexFormat::Unsupported(_) => None,
    }
}
