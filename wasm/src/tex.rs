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

/// R8 灰度粒子纹理展开为 RGBA8（2026-08-21 方案 A 修复，对齐 open-wallpaper-engine /
/// WE 官方 `ConvertTexture0Format` 的 `FORMAT_R8` 语义：`vec4(1, 1, 1, _sample.r)`——
/// rgb 恒白（纹理不调制颜色）、alpha = 灰度值）。fog1 等粒子雾纹理是 R8；
/// 直接采样 R8 时 WGSL 返回 (r,0,0,1)——rgb 变红、alpha=1 无纹理调制（雾均匀偏浓）。
/// 展开后 shader 统一 texel=(1,1,1,灰度)：颜色不调制、alpha 由纹理灰度调制（雾形状柔和）。
/// 纯函数（native 可测）：每像素 1 字节 → 4 字节 [255,255,255,v]。
pub fn r8_to_rgba_white_alpha(mip0: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(mip0.len() * 4);
    for &v in mip0 {
        out.extend_from_slice(&[255, 255, 255, v]);
    }
    out
}

// FreeImage 格式（TEXB0003+ 容器的 image_format 槽位，与 tex-loader.ts FIF 枚举一致）
pub const FIF_JPEG: u32 = 2;
pub const FIF_PNG: u32 = 13;

// 魔数嗅探（对齐 open-wallpaper-engine TexImageParser::DetectEmbeddedImageType）：
// 头部 image_format 声明 -1/0（UNKNOWN）但 body 实际是编码图像时回退嗅探。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EmbeddedImage { Png, Jpeg }

fn sniff_embedded_image(data: &[u8]) -> Option<EmbeddedImage> {
    if data.len() >= 8 && &data[0..8] == b"\x89PNG\r\n\x1a\n" {
        return Some(EmbeddedImage::Png);
    }
    if data.len() >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff {
        return Some(EmbeddedImage::Jpeg);
    }
    None
}

fn decode_embedded_image(data: &[u8], declared: Option<u32>) -> Option<(u32, u32, Vec<u8>)> {
    let kind = match declared {
        Some(f) if f == FIF_PNG => EmbeddedImage::Png,
        Some(f) if f == FIF_JPEG => EmbeddedImage::Jpeg,
        // 未声明编码格式 → 魔数嗅探（仅 -1/UNKNOWN 路径到达；0/RAW 在 parse_tex 内透传，不进入本函数）
        _ => sniff_embedded_image(data)?,
    };
    match kind {
        EmbeddedImage::Png => {
            let mut dec = png::Decoder::new(data);
            // 统一输出 8-bit RGB/RGBA：STRIP_16 把 16-bit 位深降到 8-bit（避免 16-bit RGB 被按
            // 8-bit 解析成乱码），EXPAND 把调色板展开为 RGB、灰度<8bit 提升到 8bit、tRNS 展开为 alpha
            dec.set_transformations(png::Transformations::normalize_to_color8());
            let mut reader = dec.read_info().ok()?;
            let info = reader.info();
            // 解码尺寸无界分配防护：w*h*4 超过 1 GiB 直接拒绝（与 raw/LZ4 分支上界一致），
            // 防止恶意 IHDR（如 100000x100000）在 wasm32 上容量溢出 panic。
            // 按维短路（任一维 > 2^28 即拒）避免 u64 乘法在 w*h ≥ 2^62 时自身溢出
            // （png crate 接受任意非 0 尺寸，构造 (2^31, 2^31) 头可绕过纯乘法守卫）。
            if info.width == 0
                || info.height == 0
                || info.width > (1 << 28)
                || info.height > (1 << 28)
                || info.width as u64 * info.height as u64 * 4 > (1 << 30)
            {
                return None;
            }
            let mut buf = vec![0u8; reader.output_buffer_size()];
            let info = reader.next_frame(&mut buf).ok()?;
            // normalize_to_color8 后输出仅剩 8-bit RGBA/RGB（灰度/灰度+alpha 落入 _ → None）
            let rgba = match info.color_type {
                png::ColorType::Rgba => buf,
                png::ColorType::Rgb => {
                    let mut out = Vec::with_capacity(info.width as usize * info.height as usize * 4);
                    for px in buf.chunks_exact(3) {
                        out.extend_from_slice(&[px[0], px[1], px[2], 255]);
                    }
                    out
                }
                _ => return None,
            };
            Some((info.width, info.height, rgba))
        }
        EmbeddedImage::Jpeg => {
            let mut dec = jpeg_decoder::Decoder::new(data);
            let pixels = dec.decode().ok()?;
            let info = dec.info()?;
            let wh = info.width as usize * info.height as usize;
            // jpeg-decoder 输出通道数随源格式变化：RGB=3、灰度 L8=1、CMYK=4。
            // 仅接受 3 通道（补 alpha=255）与 1 通道（灰度扩为 [v,v,v,255]），其余（如 CMYK）返回 None，
            // 避免 mip0 长度 ≠ w*h*4 导致 wgpu write_texture 数据不足校验失败
            let rgba = if pixels.len() == wh * 3 {
                let mut out = Vec::with_capacity(wh * 4);
                for px in pixels.chunks_exact(3) {
                    out.extend_from_slice(&[px[0], px[1], px[2], 255]);
                }
                out
            } else if pixels.len() == wh {
                // 灰度 L8 → 各通道复制为 [v, v, v, 255]
                let mut out = Vec::with_capacity(wh * 4);
                for &v in &pixels {
                    out.extend_from_slice(&[v, v, v, 255]);
                }
                out
            } else {
                return None;
            };
            Some((info.width as u32, info.height as u32, rgba))
        }
    }
}

fn u32_at(data: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(data[off..off + 4].try_into().unwrap_or([0; 4]))
}

/// TEXV0005 flags 的 sprite 位（对齐 open-wallpaper-engine TexFlagEnum::sprite = 2 → bit 2）。
/// 精灵表纹理：mip0 是整张表，逻辑图（map 尺寸）只是其中一格——**不可裁剪**（当前无
/// 精灵 UV 偏移支持，保留完整纹理，行为与现状一致）。
const FLAG_SPRITE: u32 = 1 << 2;

/// 2 的幂填充裁剪（2026-08-21 铺满修复）：TEXV0005 的 mip 记录尺寸（w/h）是**上传尺寸**
/// （2 的幂，如 4096×2048），而 mapWidth/mapHeight（头部 @34/@38）是**逻辑内容尺寸**
/// （如 2400×1555，对齐 open-wallpaper-engine ImageHeader.width/height vs mapWidth/mapHeight、
/// SceneMaterialBuilder 的 sample_extent = map 尺寸）——内容在 mip0 左上角，右侧/底部是
/// 2 的幂填充（通常黑/透明）。原实现把整个上传纹理当 UV 0-1 → 画面被压缩到 quad 的
/// map/mip 比例区域、填充区露出（EVA 1280029027 实测右侧/底部显示清屏色灰）。
/// 本函数把 mip0 裁剪到 map 尺寸：RGBA8/R8/RG88 按行裁剪；DXT 按 4×4 块裁剪
/// （BC 纹理尺寸须为 4 的倍数，向上取整后右下角 1-3px 冗余无害）；sprite 或
/// map ≥ mip（无填充）→ 原样保留。
pub fn crop_to_map(
    mip0: &[u8],
    w: u32,
    h: u32,
    map_w: u32,
    map_h: u32,
    format: TexFormat,
    flags: u32,
) -> (u32, u32, Vec<u8>) {
    let cw = map_w.min(w).max(1);
    let ch = map_h.min(h).max(1);
    if flags & FLAG_SPRITE != 0 || (cw >= w && ch >= h) {
        return (w, h, mip0.to_vec());
    }
    match format {
        TexFormat::Rgba8888 => crop_rows(mip0, w, h, cw, ch, 4),
        TexFormat::R8 => crop_rows(mip0, w, h, cw, ch, 1),
        TexFormat::Rg88 => crop_rows(mip0, w, h, cw, ch, 2),
        TexFormat::Dxt1 => crop_bc(mip0, w, h, cw, ch, 8),
        TexFormat::Dxt3 | TexFormat::Dxt5 => crop_bc(mip0, w, h, cw, ch, 16),
        // Unsupported：不裁剪（上传侧也会拒绝）
        TexFormat::Unsupported(_) => (w, h, mip0.to_vec()),
    }
}

/// 非压缩格式按行裁剪：每行取 cw×bpp 字节、取 ch 行（内容在左上角）。
fn crop_rows(mip0: &[u8], w: u32, h: u32, cw: u32, ch: u32, bpp: u32) -> (u32, u32, Vec<u8>) {
    let row = cw as usize * bpp as usize;
    let mut out = Vec::with_capacity(row * ch as usize);
    for y in 0..ch {
        let start = (y * w * bpp) as usize;
        let end = start + row;
        if end <= mip0.len() {
            out.extend_from_slice(&mip0[start..end]);
        }
    }
    (cw, ch, out)
}

/// 块压缩格式按 4×4 块裁剪：目标尺寸向上取整到 4 的倍数（BC 纹理尺寸约束），
/// 截取左上角块阵列（内容区外的 1-3px 冗余行/列来自原内容边缘块，无害）。
fn crop_bc(mip0: &[u8], w: u32, h: u32, cw: u32, ch: u32, bpp: u32) -> (u32, u32, Vec<u8>) {
    let nw = ((cw + 3) / 4) * 4;
    let nh = ((ch + 3) / 4) * 4;
    let src_bw = (w + 3) / 4;
    let dst_bw = nw / 4;
    let dst_bh = nh / 4;
    let row = dst_bw as usize * bpp as usize;
    let mut out = Vec::with_capacity(row * dst_bh as usize);
    for by in 0..dst_bh {
        let start = (by * src_bw * bpp) as usize;
        let end = start + row;
        if end <= mip0.len() {
            out.extend_from_slice(&mip0[start..end]);
        }
    }
    (nw, nh, out)
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
    // 2026-08-21 铺满修复：头部 @34/@38 = mapWidth/mapHeight（逻辑内容尺寸，对齐
    // open-wallpaper-engine ImageHeader.mapWidth/mapHeight）；@22 = flags（sprite 位）。
    // mip 记录尺寸是 2 的幂上传尺寸，内容在左上角、右侧/底部为填充 → crop_to_map 裁剪。
    let flags = u32_at(data, hdr + 4);
    let map_w = u32_at(data, hdr + 16);
    let map_h = u32_at(data, hdr + 20);
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
    // V3+：imageCount 后紧跟 FreeImage 格式（V4 还有 isVideoMp4 标志）。
    // 记录原始 image_format 供 mip 循环解码判定：
    // - FIF_PNG/FIF_JPEG → 按声明解码；
    // - u32::MAX（UNKNOWN）→ 魔数嗅探（对齐 open-wallpaper-engine DetectEmbeddedImageType）；
    // - 0（RAW，明确 RGBA 像素）→ 不嗅探（避免误伤以 FF D8 FF 开头的合法 RGBA 纹理）
    let mut encoded_image_format: Option<u32> = None;
    if v3plus {
        if data.len() < pos + 4 {
            return None;
        }
        let image_format = u32_at(data, pos);
        pos += 4;
        if container == b"TEXB0004\0" {
            pos += 4;
        }
        encoded_image_format = Some(image_format);
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
            // 编码图像（V3+）：mip0 载荷是 JPEG/PNG 字节流 → 解码为 RGBA8。
            // 声明 FIF_PNG/FIF_JPEG → 按声明解码（失败返回 None，图片缺失不中断渲染）；
            // 声明 u32::MAX（UNKNOWN）→ 魔数嗅探：命中解码、未命中透传原始数据、命中但解码失败 → None；
            // 声明其他格式（如 BMP/WEBP）→ 不支持，返回 None；
            // 声明 0（RAW）→ 不嗅探（避免误伤以 FF D8 FF 开头的合法 RGBA 纹理）。
            if mip0.is_none() {
                if let Some(declared) = encoded_image_format {
                    if declared == FIF_PNG || declared == FIF_JPEG {
                        if let Some((dw, dh, rgba)) = decode_embedded_image(&out, Some(declared)) {
                            return Some(TexImage {
                                width: dw,
                                height: dh,
                                format: TexFormat::Rgba8888,
                                mip0: rgba,
                            });
                        }
                        // 声明编码但解码失败 → 该纹理不可用（返回 None，图片缺失不中断渲染）
                        return None;
                    } else if declared == u32::MAX {
                        if let Some((dw, dh, rgba)) = decode_embedded_image(&out, None) {
                            return Some(TexImage {
                                width: dw,
                                height: dh,
                                format: TexFormat::Rgba8888,
                                mip0: rgba,
                            });
                        }
                        // 嗅探命中但解码失败 → 纹理不可用（返回 None，对齐参考实现 DecodeFailed）；
                        // 未命中（非编码图像）→ 透传原始数据
                        if sniff_embedded_image(&out).is_some() {
                            return None;
                        }
                    } else if declared != 0 {
                        // 声明了其他编码格式（如 BMP/WEBP）→ 不支持，返回 None（图片缺失不中断渲染）
                        return None;
                    }
                    // 声明 0（RAW）→ 原样透传
                }
            }
            if mip0.is_none() {
                mip0 = Some((w, h, out));
            }
            pos += bytes_len;
        }
    }
    mip0.map(|(w, h, mip0)| {
        let fmt = format.into();
        // 2 的幂填充裁剪：mip 记录尺寸（上传尺寸）→ map 尺寸（逻辑内容）。
        // 裁剪后 width/height 是内容尺寸，upload_texture 上传内容区（UV 0-1 = 内容，
        // 填充区不再显示；image_half_ndc 的 size 缺省回退也用内容尺寸，修正画面压缩）。
        let (cw, ch, cropped) = crop_to_map(&mip0, w, h, map_w, map_h, fmt, flags);
        TexImage {
            width: cw,
            height: ch,
            format: fmt,
            mip0: cropped,
        }
    })
}
