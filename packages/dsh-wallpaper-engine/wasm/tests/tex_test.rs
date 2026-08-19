use we_scene_wasm::tex::{parse_tex, TexFormat};

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
