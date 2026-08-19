//! TEXV0005 容器解析（头 + TEXB 容器 + mipmap 表 + LZ4 解压）。
//! 字节布局见 tex-loader.ts 文件头注释：TEXV0005\0 TEXI0001\0 + 28B 头
//! + TEXB0001|0002\0 + imageCount(i32) + mipmapCount(i32)
//! + 每 mipmap: width height isLZ4 decompressedBytes bytesLen + 数据

use lz4_flex::block::decompress;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TexFormat {
    Rgba8888,
    Dxt1,
    Dxt3,
    Dxt5,
    Rg88,
    R8,
    Unsupported(u32),
}

impl From<u32> for TexFormat {
    fn from(v: u32) -> Self {
        match v {
            0 => TexFormat::Rgba8888,
            4 => TexFormat::Dxt5,
            6 => TexFormat::Dxt3,
            7 => TexFormat::Dxt1,
            8 => TexFormat::Rg88,
            9 => TexFormat::R8,
            other => TexFormat::Unsupported(other),
        }
    }
}

/// TexFormat → 纹理格式字符串标识（无 wgpu 依赖，native `cargo test` 可测）。
///
/// wgpu 是 optional 依赖（render feature 门控），native 测试无法引用
/// `wgpu::TextureFormat`，故格式映射分两层：
/// - 本函数：TexFormat → 稳定字符串标识（与 wgpu::TextureFormat 的 Debug 名一致）
/// - `render::texture::tex_format_to_wgpu`：字符串标识 → wgpu::TextureFormat
///   （render feature 下编译，映射表必须与本函数一一对应）
///
/// WebGPU 原生支持 BC 压缩（BC1/BC2/BC3）、R8/RG8 与 RGBA8，故全部映射为
/// sRGB/UNorm 格式：DXT1→BC1、DXT3→BC2、DXT5→BC3、R8→R8Unorm、RG88→Rg8Unorm。
pub fn tex_format_id(format: TexFormat) -> Option<&'static str> {
    match format {
        TexFormat::Rgba8888 => Some("rgba8unorm-srgb"),
        TexFormat::Dxt1 => Some("bc1-rgba-unorm-srgb"),
        TexFormat::Dxt3 => Some("bc2-rgba-unorm-srgb"),
        TexFormat::Dxt5 => Some("bc3-rgba-unorm-srgb"),
        TexFormat::R8 => Some("r8-unorm"),
        TexFormat::Rg88 => Some("rg8-unorm"),
        TexFormat::Unsupported(_) => None,
    }
}

#[derive(Debug, Clone)]
pub struct TexImage {
    pub width: u32,
    pub height: u32,
    pub format: TexFormat,
    pub mip0: Vec<u8>, // LZ4 解压后的原始数据
}

fn u32_at(data: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(data[off..off + 4].try_into().unwrap_or([0; 4]))
}

pub fn parse_tex(data: &[u8]) -> Option<TexImage> {
    // 真实布局（tex-loader.ts 实测）："TEXV0005\0"9B + "TEXI0001\0"9B + 28B 头@18
    // + 容器头("TEXB0001|0002\0" 等 9B)@46 + imageCount(i32)@55 + 每 image: mipmapCount
    // + 每 mipmap(V2): width height isLZ4 decompressedBytes bytesLen(20B) + 数据
    if data.len() < 55 || &data[0..9] != b"TEXV0005\0" || &data[9..18] != b"TEXI0001\0" {
        return None;
    }
    let hdr = 18usize;
    if data.len() < hdr + 28 {
        return None;
    }
    let format = u32_at(data, hdr);
    let _tex_w = u32_at(data, hdr + 8);
    let _tex_h = u32_at(data, hdr + 12);
    // 容器头 9 字节（TEXB0001|0002|0003|0004\0）
    let mut pos = hdr + 28 + 9;
    if data.len() < pos + 4 {
        return None;
    }
    let image_count = u32_at(data, pos) as usize;
    pos += 4;
    let mut mip0: Option<(u32, u32, Vec<u8>)> = None;
    for _img in 0..image_count {
        if data.len() < pos + 4 {
            return None;
        }
        let mip_count = u32_at(data, pos) as usize;
        pos += 4;
        for _m in 0..mip_count {
            if data.len() < pos + 20 {
                return None;
            }
            let w = u32_at(data, pos);
            let h = u32_at(data, pos + 4);
            let is_lz4 = u32_at(data, pos + 8) == 1;
            let decompressed = u32_at(data, pos + 12);
            let bytes_len = u32_at(data, pos + 16) as usize;
            pos += 20;
            if data.len() < pos + bytes_len {
                return None;
            }
            // 上界防护（对齐 tex-loader.ts 的 decompressedBytes <= 1<<30 校验）：
            // decompress 会按 decompressed 值预分配输出缓冲区，巨大值（如 0xFFFFFFFF）
            // 会导致内存暴涨/wasm trap 而非优雅返回 None，必须在解压前拦截。
            // 解压与未解压分支统一校验（未解压分支的 decompressedBytes 也应 > 0）。
            if decompressed == 0 || decompressed > (1 << 30) {
                return None;
            }
            // 未解压分支同样限制 bytes_len 上界，保持一致
            if bytes_len > (1 << 30) {
                return None;
            }
            let raw = &data[pos..pos + bytes_len];
            let out = if is_lz4 {
                decompress(raw, decompressed as usize).ok()?
            } else {
                raw.to_vec()
            };
            if mip0.is_none() {
                mip0 = Some((w, h, out));
            }
            pos += bytes_len;
        }
    }
    mip0.map(|(w, h, mip0)| TexImage {
        width: w,
        height: h,
        format: format.into(),
        mip0,
    })
}
