//! TexFormat → wgpu::TextureFormat 映射（WebGPU 原生 BC/R8/RG88 支持）。
//!
//! 本模块仅在 render feature（wasm 构建）下编译：wgpu 是 optional 依赖，
//! native `cargo test` 无法引用 `wgpu::TextureFormat`。
//!
//! 单一事实源（审查 Round 1 修复）：`tex_format_to_wgpu` 以
//! `crate::tex::tex_format_id` 返回的字符串标识驱动 wgpu 查表，而非直接
//! match TexFormat——字符串层与 wgpu 层不可能漂移（如 Dxt1 误映射 Bc3）；
//! 若 tex_format_id 新增标识而本表未加，返回 None（显式失败而非错误映射）。

use crate::tex::TexFormat;

/// TexFormat → wgpu::TextureFormat（以 `tex::tex_format_id` 字符串为键）。
pub fn tex_format_to_wgpu(format: TexFormat) -> Option<wgpu::TextureFormat> {
    match crate::tex::tex_format_id(format)? {
        "rgba8unorm-srgb" => Some(wgpu::TextureFormat::Rgba8UnormSrgb),
        "bc1-rgba-unorm-srgb" => Some(wgpu::TextureFormat::Bc1RgbaUnormSrgb),
        "bc2-rgba-unorm-srgb" => Some(wgpu::TextureFormat::Bc2RgbaUnormSrgb),
        "bc3-rgba-unorm-srgb" => Some(wgpu::TextureFormat::Bc3RgbaUnormSrgb),
        "r8-unorm" => Some(wgpu::TextureFormat::R8Unorm),
        "rg8-unorm" => Some(wgpu::TextureFormat::Rg8Unorm),
        _ => None,
    }
}
