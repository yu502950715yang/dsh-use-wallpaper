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
/// UNorm（**非 sRGB**）格式：DXT1→BC1、DXT3→BC2、DXT5→BC3、R8→R8Unorm、RG88→Rg8Unorm。
///
/// Task 9 实测修复：原映射为 *Srgb 格式，textureSample 会做 sRGB→线性解码；若 surface
/// 是非 sRGB 格式（headless Edge 实测 formats 首选非 sRGB），fragment 输出的线性值被
/// 直接显示 → 画面比原图暗约 50%（EVA 主图 avg 200→20）。改为 UNorm 后 fragment 输出
/// 纹理原始（sRGB 编码）值，与 surface（同样非 sRGB）匹配，图片显示接近原图。
pub fn tex_format_id(format: TexFormat) -> Option<&'static str> {
    match format {
        TexFormat::Rgba8888 => Some("rgba8unorm"),
        TexFormat::Dxt1 => Some("bc1-rgba-unorm"),
        TexFormat::Dxt3 => Some("bc2-rgba-unorm"),
        TexFormat::Dxt5 => Some("bc3-rgba-unorm"),
        TexFormat::R8 => Some("r8-unorm"),
        TexFormat::Rg88 => Some("rg8-unorm"),
        TexFormat::Unsupported(_) => None,
    }
}

/// 纹理上传布局（纯计算，native 可测；wgpu 上传侧消费，见
/// `render::Renderer::upload_texture`）。WebGPU texel-block 语义：
/// - 块压缩格式（BC1/2/3）每块 4x4 像素，行按"块行"计；
/// - 非压缩格式块为 1x1 像素，行按像素行计。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CopyLayout {
    /// write_texture 的 bytes_per_row：显式 256 对齐
    /// （(raw_row + 255) & !255，wgpu `COPY_BYTES_PER_ROW_ALIGNMENT=256`）。
    /// writeTexture 规范上无对齐要求（见 wgpu-types 文档与 WebGPU 规范
    /// writeTexture validusage note），但显式对齐 + 按需重打包可兼容所有
    /// 后端/实现（对齐宽度零拷贝，非对齐才补 padding）。
    pub bytes_per_row: u32,
    /// 紧密行字节数（LZ4 解压后的 mip0 每行原始宽度；重打包的源行宽）。
    pub raw_row: u32,
    /// rows_per_image：非压缩 = 高（像素行），块压缩 = 块行数 ceil(h/4)。
    /// 不能统一用块行数——wgpu-core 校验 `rows_per_image >= height_in_blocks`，
    /// 非压缩格式 height_in_blocks = h。
    pub rows: u32,
}

impl CopyLayout {
    /// 数据是否需要按行补 padding（bytes_per_row > raw_row）。
    pub fn needs_padding(&self) -> bool {
        self.bytes_per_row > self.raw_row
    }
}

/// 计算上传布局；Unsupported 格式返回 None（无法上传）。
pub fn copy_layout(img: &TexImage) -> Option<CopyLayout> {
    let block_size = match img.format {
        TexFormat::Dxt1 => 8u32,
        TexFormat::Dxt3 | TexFormat::Dxt5 => 16u32,
        TexFormat::Rgba8888 => 4u32,
        TexFormat::Rg88 => 2u32,
        TexFormat::R8 => 1u32,
        TexFormat::Unsupported(_) => return None,
    };
    let w = img.width.max(1);
    let h = img.height.max(1);
    let (block_w, block_h) = ((w + 3) / 4, (h + 3) / 4);
    let (raw_row, rows) = match img.format {
        TexFormat::Dxt1 | TexFormat::Dxt3 | TexFormat::Dxt5 => (block_w * block_size, block_h.max(1)),
        _ => (w * block_size, h),
    };
    let bytes_per_row = (raw_row + 255) & !255;
    Some(CopyLayout { bytes_per_row, raw_row, rows })
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
    // + 容器头("TEXB0001|0002|0003|0004\0" 等 9B)@46 + imageCount(i32)@55 + 每 image: mipmapCount
    // + 每 mipmap(V2/V3+): width height isLZ4 decompressedBytes bytesLen(20B) + 数据
    //   （V1/TEXB0001: width height bytesLen 12B，无 isLZ4）
    // Task 9 修复：V3+(TEXB0003/0004) 在 imageCount 后多 4B FreeImage 格式（V4 再加 4B 标志），
    // 原实现未处理导致 TEXB0003 壁纸（如 2683211654）解析错位失败；另对齐 tex-loader 容错：
    // 非 LZ4 mip 不校验 decompressedBytes（原实现统一校验导致部分壁纸 parse 失败）。
    if data.len() < 55 || &data[0..9] != b"TEXV0005\0" || &data[9..18] != b"TEXI0001\0" {
        return None;
    }
    let hdr = 18usize;
    if data.len() < hdr + 28 {
        return None;
    }
    let format = u32_at(data, hdr);
    let container = &data[46..55];
    let v1 = container == b"TEXB0001\0";
    let v2 = container == b"TEXB0002\0";
    let v3plus = container == b"TEXB0003\0" || container == b"TEXB0004\0";
    if !v1 && !v2 && !v3plus {
        return None;
    }
    let mut pos = hdr + 28 + 9;
    if data.len() < pos + 4 {
        return None;
    }
    let image_count = u32_at(data, pos) as usize;
    pos += 4;
    // V3+：imageCount 后紧跟 FreeImage 格式（V4 还有 isVideoMp4 标志）
    if v3plus {
        if data.len() < pos + 4 {
            return None;
        }
        let image_format = u32_at(data, pos);
        pos += 4;
        if container == b"TEXB0004\0" {
            pos += 4;
        }
        // 编码图像（JPEG/PNG 等，FreeImage 格式 != -1/0）无法在 Rust 侧解码 → 跳过
        // （返回 None，该图片不上传，保持与 JS 渲染器 preview 回退一致）
        if image_format != 0 && image_format != u32::MAX {
            return None;
        }
    }
    let mut mip0: Option<(u32, u32, Vec<u8>)> = None;
    for _img in 0..image_count {
        if data.len() < pos + 4 {
            return None;
        }
        let mip_count = u32_at(data, pos) as usize;
        pos += 4;
        for _m in 0..mip_count {
            let (w, h, is_lz4, decompressed, bytes_len) = if v2 || v3plus {
                if data.len() < pos + 20 {
                    return None;
                }
                (
                    u32_at(data, pos),
                    u32_at(data, pos + 4),
                    u32_at(data, pos + 8) == 1,
                    u32_at(data, pos + 12),
                    u32_at(data, pos + 16) as usize,
                )
            } else {
                if data.len() < pos + 12 {
                    return None;
                }
                (u32_at(data, pos), u32_at(data, pos + 4), false, 0, u32_at(data, pos + 8) as usize)
            };
            pos += if v2 || v3plus { 20 } else { 12 };
            if data.len() < pos + bytes_len {
                return None;
            }
            // 未解压分支同样限制 bytes_len 上界，保持一致
            if bytes_len > (1 << 30) {
                return None;
            }
            let raw = &data[pos..pos + bytes_len];
            // 对齐 tex-loader.ts：仅 LZ4 分支校验 decompressedBytes；非 LZ4 直接用原始数据
            let out = if is_lz4 {
                if decompressed == 0 || decompressed > (1 << 30) {
                    return None;
                }
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
