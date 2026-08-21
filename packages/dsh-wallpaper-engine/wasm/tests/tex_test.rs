use std::io::Cursor;
use we_scene_wasm::tex::{crop_to_map, parse_tex, r8_to_rgba_white_alpha, TexFormat};

const RGBA_LZ4: &[u8] = include_bytes!("fixtures/tex/rgba_lz4.tex");
const DXT1: &[u8] = include_bytes!("fixtures/tex/dxt1.tex");
const RG88: &[u8] = include_bytes!("fixtures/tex/rg88.tex");

#[test]
fn parses_rgba8888_lz4_and_decompresses() {
    let img = parse_tex(RGBA_LZ4).expect("rgba_lz4 应可解析");
    assert_eq!(img.format, TexFormat::Rgba8888);
    assert_eq!(img.width, 2);
    assert_eq!(img.height, 2);
    assert_eq!(img.mip0.len(), 4 * 4); // 2x2 RGBA = 16 字节
    assert_eq!(&img.mip0[0..4], &[255, 0, 0, 255]); // 红像素
}

#[test]
fn parses_dxt1() {
    let img = parse_tex(DXT1).expect("dxt1 应可解析");
    assert_eq!(img.format, TexFormat::Dxt1);
    // 注意：make-tex.ts 对 DXT1 直接写入 16 字节原始数据（未压缩），
    // 而规范 DXT1 4x4 块应为 8 字节——以生成器实际输出为准，断言 16 字节。
    assert_eq!(img.mip0.len(), 16);
}

#[test]
fn parses_rg88() {
    let img = parse_tex(RG88).expect("rg88 应可解析");
    assert_eq!(img.format, TexFormat::Rg88);
    assert_eq!(img.mip0.len(), 4 * 2); // 2x2 RG88 = 8 字节
}

#[test]
fn r8_to_rgba_white_alpha_expands_grayscale() {
    // R8 灰度粒子纹理（fog1 等）：ConvertTexture0Format FORMAT_R8 语义——
    // rgb 恒白(255) + alpha=灰度值；每像素 1 字节 → 4 字节 [255,255,255,v]
    let out = r8_to_rgba_white_alpha(&[0u8, 64, 128, 200, 255]);
    assert_eq!(out.len(), 5 * 4);
    assert_eq!(&out[0..4], &[255, 255, 255, 0]);     // 黑 → 白 rgb + alpha 0
    assert_eq!(&out[4..8], &[255, 255, 255, 64]);
    assert_eq!(&out[16..20], &[255, 255, 255, 255]); // 白 → 白 rgb + alpha 255
}

#[test]
fn r8_to_rgba_white_alpha_empty_input() {
    assert_eq!(r8_to_rgba_white_alpha(&[]), Vec::<u8>::new());
}

// ===== 2 的幂填充裁剪（2026-08-21 铺满修复）=====
// TEXV0005 头 28B @18：format@0 flags@4 texW@8 texH@12 mapW@16 mapH@20 unk@24；
// mip 记录尺寸是上传尺寸（2 的幂），map 尺寸是逻辑内容（内容在 mip0 左上角）。
// 构造 RGBA8 8×8 上传（map 6×5）：内容区像素 [x,y,0,255]，填充区（x≥6|y≥5）[255,255,255,0]。
fn tex_rgba8_padded() -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(b"TEXV0005\0");
    v.extend_from_slice(b"TEXI0001\0");
    v.extend_from_slice(&0u32.to_le_bytes()); // format = RGBA8
    v.extend_from_slice(&0u32.to_le_bytes()); // flags（非 sprite）
    v.extend_from_slice(&8u32.to_le_bytes()); // texW（上传宽）
    v.extend_from_slice(&8u32.to_le_bytes()); // texH（上传高）
    v.extend_from_slice(&6u32.to_le_bytes()); // mapW（逻辑宽）
    v.extend_from_slice(&5u32.to_le_bytes()); // mapH（逻辑高）
    v.extend_from_slice(&0u32.to_le_bytes()); // unknown
    v.extend_from_slice(b"TEXB0002\0");
    v.extend_from_slice(&1u32.to_le_bytes()); // imageCount
    v.extend_from_slice(&1u32.to_le_bytes()); // mipmapCount
    v.extend_from_slice(&8u32.to_le_bytes()); // mip 宽
    v.extend_from_slice(&8u32.to_le_bytes()); // mip 高
    v.extend_from_slice(&0u32.to_le_bytes()); // isLZ4
    v.extend_from_slice(&0u32.to_le_bytes()); // decompressedBytes
    v.extend_from_slice(&256u32.to_le_bytes()); // bytesLen = 8×8×4
    for y in 0..8u32 {
        for x in 0..8u32 {
            if x < 6 && y < 5 {
                v.extend_from_slice(&[x as u8, y as u8, 0, 255]); // 内容区
            } else {
                v.extend_from_slice(&[255, 255, 255, 0]); // 2 的幂填充（黑透明）
            }
        }
    }
    v
}

#[test]
fn parse_tex_crops_pow2_padding_to_map_size() {
    // 上传 8×8（2 的幂）、map 6×5：parse_tex 必须裁剪到 6×5，填充区不得进入纹理
    let img = parse_tex(&tex_rgba8_padded()).expect("应可解析");
    assert_eq!(img.format, TexFormat::Rgba8888);
    assert_eq!(img.width, 6);
    assert_eq!(img.height, 5);
    assert_eq!(img.mip0.len(), 6 * 5 * 4);
    // 内容区左上角像素 [0,0,0,255]
    assert_eq!(&img.mip0[0..4], &[0, 0, 0, 255]);
    // 内容区右下角（x=5,y=4）像素 [5,4,0,255]
    let last = (4 * 6 + 5) * 4;
    assert_eq!(&img.mip0[last..last + 4], &[5, 4, 0, 255]);
}

#[test]
fn crop_to_map_keeps_unpadded_and_sprite() {
    // map ≥ mip（无填充）：原样保留
    let data: Vec<u8> = (0..16).collect();
    let (w, h, out) = crop_to_map(&data, 2, 2, 2, 2, TexFormat::Rgba8888, 0);
    assert_eq!((w, h), (2, 2));
    assert_eq!(out, data);
    // sprite 标志（flags bit 2）：即使 mip > map 也不裁剪（精灵表保留完整纹理）
    let data2: Vec<u8> = (0..64).collect();
    let (w2, h2, out2) = crop_to_map(&data2, 4, 4, 2, 2, TexFormat::Rgba8888, 1 << 2);
    assert_eq!((w2, h2), (4, 4));
    assert_eq!(out2, data2);
}

#[test]
fn crop_to_map_dxt1_crops_blocks() {
    // DXT1（8B/块）：8×8 上传（4×4 块 = 16 块 × 8B = 128B），map 6×6 → 裁剪到 8×8？
    // 不对——map 6×6 → ceil(6/4)×4 = 8？6/4 向上 = 2 块 = 8px > 6。用 map 4×4（1 块）：
    // 8×8 上传（16 块）裁剪到 4×4（1 块 = 8B），内容取左上角块。
    let mut blocks = Vec::new();
    for i in 0..16u32 {
        blocks.extend_from_slice(&[i as u8; 8]);
    }
    let (w, h, out) = crop_to_map(&blocks, 8, 8, 4, 4, TexFormat::Dxt1, 0);
    assert_eq!((w, h), (4, 4)); // BC 纹理尺寸向上取整 4 倍数
    assert_eq!(out.len(), 8); // 1 块
    assert_eq!(out, vec![0u8; 8]); // 左上角块
}

// 构造与 make-tex.ts 的 TEXB0002 布局一致的单个 mipmap 容器（1x1），
// 便于注入越界字段值做防御性回归测试（make-tex 无法生成巨大 decompressedBytes，
// 因为它写死 m.data.length，故此处内联构造等价字节序列）。
fn tex_with_mip(is_lz4: u32, decompressed: u32, bytes_len: u32) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(b"TEXV0005\0");
    v.extend_from_slice(b"TEXI0001\0");
    // 28B 头：format=0, flags=0, texW=1, texH=1, imgW=1, imgH=1, unk=0
    v.extend_from_slice(&0u32.to_le_bytes());
    v.extend_from_slice(&0u32.to_le_bytes());
    v.extend_from_slice(&1u32.to_le_bytes());
    v.extend_from_slice(&1u32.to_le_bytes());
    v.extend_from_slice(&1u32.to_le_bytes());
    v.extend_from_slice(&1u32.to_le_bytes());
    v.extend_from_slice(&0u32.to_le_bytes());
    v.extend_from_slice(b"TEXB0002\0");
    v.extend_from_slice(&1u32.to_le_bytes()); // imageCount
    v.extend_from_slice(&1u32.to_le_bytes()); // mipmapCount
    v.extend_from_slice(&1u32.to_le_bytes()); // width
    v.extend_from_slice(&1u32.to_le_bytes()); // height
    v.extend_from_slice(&is_lz4.to_le_bytes());
    v.extend_from_slice(&decompressed.to_le_bytes());
    v.extend_from_slice(&bytes_len.to_le_bytes());
    v.extend_from_slice(&[1, 2, 3, 4]); // payload（bytes_len 巨大时不足 4 字节也走越界拒绝）
    v
}

#[test]
fn rejects_huge_decompressed_bytes() {
    // 防御性回归：isLZ4=1 且 decompressedBytes=0xFFFFFFFF 时必须返回 None，
    // 不能按该值预分配缓冲区导致内存暴涨/wasm trap（对齐 tex-loader 的 null 语义）。
    assert!(parse_tex(&tex_with_mip(1, u32::MAX, 4)).is_none());
}

#[test]
fn rejects_zero_decompressed_bytes() {
    // LZ4 分支 decompressedBytes=0 也应拒绝（上界校验：decompressed == 0）。
    assert!(parse_tex(&tex_with_mip(1, 0, 4)).is_none());
}

#[test]
fn rejects_huge_bytes_len() {
    // 未解压分支：bytesLen 巨大时同样必须返回 None（越界/上界防护，不崩溃）。
    assert!(parse_tex(&tex_with_mip(0, 4, u32::MAX)).is_none());
}

#[test]
fn fixtures_are_decodable() {
    // PNG fixture：60x33，最小 mip 的编码载荷
    let png_bytes = include_bytes!("fixtures/tex/png_mip_tail.png");
    let dec = png::Decoder::new(Cursor::new(png_bytes));
    let mut reader = dec.read_info().expect("png header");
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).expect("png frame");
    assert_eq!(info.width, 60);
    assert_eq!(info.height, 33);

    // JPEG fixture：13x5，最小 mip 的编码载荷
    let jpg_bytes = include_bytes!("fixtures/tex/jpeg_mip_tail.jpg");
    let mut jdec = jpeg_decoder::Decoder::new(Cursor::new(jpg_bytes));
    let pixels = jdec.decode().expect("jpeg decode");
    let jinfo = jdec.info().expect("jpeg info");
    assert_eq!(jinfo.width, 13);
    assert_eq!(jinfo.height, 5);
    assert!(!pixels.is_empty());
}

// 构造 TEXB0003 容器：1 image × 1 mip，编码载荷直接作为 mip payload（is_lz4=0）
fn tex_v3_with_encoded_payload(payload: &[u8], declared_image_format: u32) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(b"TEXV0005\0");
    v.extend_from_slice(b"TEXI0001\0");
    // 28B 头：format=0(RGBA8888 名义), flags=0, texW=1, texH=1, imgW=1, imgH=1, unk=0
    v.extend_from_slice(&0u32.to_le_bytes());
    v.extend_from_slice(&0u32.to_le_bytes());
    v.extend_from_slice(&1u32.to_le_bytes());
    v.extend_from_slice(&1u32.to_le_bytes());
    v.extend_from_slice(&1u32.to_le_bytes());
    v.extend_from_slice(&1u32.to_le_bytes());
    v.extend_from_slice(&0u32.to_le_bytes());
    v.extend_from_slice(b"TEXB0003\0");
    v.extend_from_slice(&1u32.to_le_bytes()); // imageCount
    v.extend_from_slice(&declared_image_format.to_le_bytes()); // image_format (FreeImage FIF)
    v.extend_from_slice(&1u32.to_le_bytes()); // mipmapCount
    v.extend_from_slice(&60u32.to_le_bytes()); // width（以 PNG fixture 实际宽为准）
    v.extend_from_slice(&33u32.to_le_bytes()); // height
    v.extend_from_slice(&0u32.to_le_bytes()); // isLZ4 = 0
    v.extend_from_slice(&0u32.to_le_bytes()); // decompressedBytes = 0
    v.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    v.extend_from_slice(payload);
    v
}

#[test]
fn parses_png_encoded_tex_as_rgba() {
    let png = include_bytes!("fixtures/tex/png_mip_tail.png");
    // FIF.PNG = 13（tex-loader.ts FIF 枚举一致）
    let tex = tex_v3_with_encoded_payload(png, 13);
    let img = parse_tex(&tex).expect("png 编码 tex 应可解析");
    assert_eq!(img.format, TexFormat::Rgba8888);
    assert_eq!(img.width, 60);
    assert_eq!(img.height, 33);
    // RGBA8 数据量 = 60*33*4 = 7920
    assert_eq!(img.mip0.len(), 60 * 33 * 4);
}

#[test]
fn parses_jpeg_encoded_tex_as_rgba() {
    let jpg = include_bytes!("fixtures/tex/jpeg_mip_tail.jpg");
    // FIF.JPEG = 2
    let tex = tex_v3_with_encoded_payload(jpg, 2);
    let img = parse_tex(&tex).expect("jpeg 编码 tex 应可解析");
    assert_eq!(img.format, TexFormat::Rgba8888);
    assert_eq!(img.width, 13);
    assert_eq!(img.height, 5);
    assert_eq!(img.mip0.len(), 13 * 5 * 4);
}

#[test]
fn sniffs_encoded_tex_when_image_format_unknown() {
    // 声明 -1（UNKNOWN）但 body 是 PNG → 魔数嗅探应解码（对齐 DetectEmbeddedImageType）
    let png = include_bytes!("fixtures/tex/png_mip_tail.png");
    let tex = tex_v3_with_encoded_payload(png, u32::MAX);
    let img = parse_tex(&tex).expect("image_format=-1 时魔数嗅探应解码");
    assert_eq!(img.format, TexFormat::Rgba8888);
    assert_eq!(img.width, 60);
    assert_eq!(img.height, 33);
    // 嗅探命中应解码为 RGBA8（60*33*4=7920），而非原始 PNG 字节透传
    assert_eq!(img.mip0.len(), 60 * 33 * 4);
}

// 构造 TEXB0003 容器：1 image × 1 mip，编码载荷先 LZ4 压缩再作为 mip payload（is_lz4=1）
fn tex_v3_with_lz4_encoded_payload(payload: &[u8], declared_image_format: u32) -> Vec<u8> {
    let compressed = lz4_flex::block::compress(payload);
    let mut v = Vec::new();
    v.extend_from_slice(b"TEXV0005\0");
    v.extend_from_slice(b"TEXI0001\0");
    // 28B 头：format=0(RGBA8888 名义), flags=0, texW=1, texH=1, imgW=1, imgH=1, unk=0
    v.extend_from_slice(&0u32.to_le_bytes());
    v.extend_from_slice(&0u32.to_le_bytes());
    v.extend_from_slice(&1u32.to_le_bytes());
    v.extend_from_slice(&1u32.to_le_bytes());
    v.extend_from_slice(&1u32.to_le_bytes());
    v.extend_from_slice(&1u32.to_le_bytes());
    v.extend_from_slice(&0u32.to_le_bytes());
    v.extend_from_slice(b"TEXB0003\0");
    v.extend_from_slice(&1u32.to_le_bytes()); // imageCount
    v.extend_from_slice(&declared_image_format.to_le_bytes()); // image_format (FreeImage FIF)
    v.extend_from_slice(&1u32.to_le_bytes()); // mipmapCount
    v.extend_from_slice(&60u32.to_le_bytes()); // width（以 PNG fixture 实际宽为准）
    v.extend_from_slice(&33u32.to_le_bytes()); // height
    v.extend_from_slice(&1u32.to_le_bytes()); // isLZ4 = 1
    v.extend_from_slice(&(payload.len() as u32).to_le_bytes()); // decompressedBytes = 解压后载荷长度
    v.extend_from_slice(&(compressed.len() as u32).to_le_bytes()); // bytesLen = 压缩后长度
    v.extend_from_slice(&compressed);
    v
}

#[test]
fn parses_lz4_compressed_png_encoded_tex_as_rgba() {
    // 计划要求：编码图像 mip 载荷可能是 LZ4 压缩 → parse_tex 应先解压再按声明 FIF 解码
    let png = include_bytes!("fixtures/tex/png_mip_tail.png");
    let tex = tex_v3_with_lz4_encoded_payload(png, 13);
    let img = parse_tex(&tex).expect("LZ4 压缩的 PNG 编码 tex 应可解析");
    assert_eq!(img.format, TexFormat::Rgba8888);
    assert_eq!(img.width, 60);
    assert_eq!(img.height, 33);
    // RGBA8 数据量 = 60*33*4 = 7920（解压 + 解码后与未压缩路径一致）
    assert_eq!(img.mip0.len(), 60 * 33 * 4);
}

// 构造超大尺寸 PNG：编码真实 1x1 RGBA PNG → 改写 IHDR 的 width/height 为大值 → 重算 IHDR CRC。
// CRC 必须合法：png crate 校验 CRC 通过后才会接受尺寸（只拒 0），才能让 read_info 真正走到
// 解码尺寸守卫——png crate 自身不拒绝非 0 超大尺寸（1e6x1e6 实测 read_info 成功、out_buf 4TB，
// 若不守卫 vec![0u8; 4e12] 在 wasm32 上必然 OOM/panic）。
fn oversized_png(width: u32, height: u32) -> Vec<u8> {
    let mut png_bytes = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut png_bytes, 1, 1);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().unwrap();
        w.write_image_data(&[255, 0, 0, 255]).unwrap();
    }
    // IHDR 布局：签名 8B + length 4B + "IHDR" 4B → width@16, height@20
    png_bytes[16..20].copy_from_slice(&width.to_be_bytes());
    png_bytes[20..24].copy_from_slice(&height.to_be_bytes());
    // 重算 IHDR CRC（chunk type + data，@12 起的 17 字节）
    let mut hasher = crc32fast::Hasher::new();
    hasher.update(&png_bytes[12..29]);
    let crc = hasher.finalize();
    png_bytes[29..33].copy_from_slice(&crc.to_be_bytes());
    png_bytes
}

#[test]
fn rejects_oversized_png_dimensions_without_panic() {
    // 尺寸守卫防御纵深（最终审查 Important 2）：构造 (2^31, 2^31)（w*h ≥ 2^62）。
    // 当前 png 0.17.16 对 2^31 宽度自身报 "limits are exceeded"（read_info Err → None），
    // 同时我们的按维短路（任一维 > 2^28 即拒）在乘法守卫（u64 溢出为 0 会放行）之前
    // 拦截——双保险确保 wasm32 上无 capacity overflow / 乘法溢出 panic。
    let oversized = oversized_png(1 << 31, 1 << 31);
    let tex = tex_v3_with_encoded_payload(&oversized, 13);
    assert!(parse_tex(&tex).is_none(), "超大尺寸 PNG 头应被尺寸守卫拒绝");
}

#[test]
fn rejects_billion_pixel_png_without_panic() {
    // 乘法守卫真实覆盖：png crate 放行 1e6x1e6（实测 read_info OK、out_buf 4TB），
    // 若不加 w*h*4 > 1 GiB 守卫，vec![0u8; 4e12] 在 wasm32 上必然 OOM/panic。
    let oversized = oversized_png(1_000_000, 1_000_000);
    let tex = tex_v3_with_encoded_payload(&oversized, 13);
    assert!(parse_tex(&tex).is_none(), "超过 1 GiB 的 PNG 应被拒绝");
}


