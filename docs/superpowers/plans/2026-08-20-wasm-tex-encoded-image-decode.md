# wasm 渲染器 JPEG/PNG 编码纹理解码实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Rust/wgpu (wasm) 渲染器的 `parse_tex` 支持 TEXB0003/0004 容器中的 JPEG/PNG 编码图像（对齐 open-wallpaper-engine 的 stb_image 解码路径），修复全库 20/24 个 scene 壁纸主图缺失（`[wasm] load_image: parse_tex FAILED`）。

**Architecture:** `parse_tex` 当前对 `image_format != 0 && != u32::MAX` 直接返回 None（编码图像不支持）。方案：V3+ 分支改为记录编码格式并继续解析 mip；对编码图像，将 mip0 载荷（可能 LZ4 压缩）解码为 RGBA8（png 0.17 / jpeg-decoder 0.3，禁用 rayon），解码后的 `TexImage` 走现有 `upload_texture` 的 RGBA8 路径上传。同时增加魔数嗅探回退（对齐 `DetectEmbeddedImageType`）：声明 -1 但 body 实际是 PNG/JPEG 时也能解码。

**Tech Stack:** Rust（wasm32-unknown-unknown + wgpu 24）、png 0.17.16、jpeg-decoder 0.3.2（default-features=false，禁 rayon）、wasm-pack 0.15、headless Edge + CDP 验证。

**Spec:** `docs/superpowers/specs/2026-08-19-we-scene-wasm-renderer-design.md`（wasm 渲染器设计）＋ 本次根因（research/scene-play-research.md §4 已记录 imageFormat(FIF) JPEG×16/PNG×16；实测 20/24 壁纸含编码纹理，Orange 主图 `materials/Фон.tex` FIF=13 PNG 5739130B）。对齐参考：`research/open-wallpaper-engine/src/Scene/Pkg/Parse/Image/TexImageParser.cpp`（stb_image 解码 + `DetectEmbeddedImageType` 魔数嗅探）。

## Global Constraints

- wasm 构建：`cargo build --target wasm32-unknown-unknown --release --features render`；wasm-pack：`wasm-pack build --target web --release --features render`（Windows 上 wasm-pack 进程可能不自动退出——产物已生成即成功，需手动 kill 或超时保护）。
- `jpeg-decoder` 必须 `default-features = false`（默认启用 rayon，wasm32-unknown-unknown 无法编译线程池）。
- native `cargo test`（无 render feature）必须保持可编译可跑（解析层不依赖 wgpu）。
- 解码依赖（png/jpeg-decoder）只加在 `[dependencies]`，不 gate 到 render feature（tex.rs 是 native 可测模块）。
- wasm 体积目标：wasm-opt 后 ≤ 1MB（当前 433KB；解码器预计 +100-200KB）。
- 全量 vitest（`npm test`）保持全绿；`cargo test` 保持全绿。
- 所有失败路径保持"返回 None / 跳过该对象"，不 panic、不中断 wasm 渲染（与现有 upload_texture 防 panic 语义一致）。

---

### Task 1: 依赖声明与 fixture 就绪

**Files:**
- Modify: `packages/dsh-wallpaper-engine/wasm/Cargo.toml`（[dependencies] 加 png/jpeg-decoder）
- Create: `packages/dsh-wallpaper-engine/wasm/tests/fixtures/tex/jpeg_mip_tail.jpg`（已提取，440B，13×5 JPEG）
- Create: `packages/dsh-wallpaper-engine/wasm/tests/fixtures/tex/png_mip_tail.png`（已提取，4143B，60×33 PNG）

**Interfaces:**
- Consumes: 无（本任务只声明依赖）
- Produces: `png::Decoder` / `jpeg_decoder::Decoder` 可用；fixture 文件供 Task 3 测试使用

- [ ] **Step 1: 声明依赖（已预执行，验证存在）**

```toml
[dependencies]
png = "0.17"
jpeg-decoder = { version = "0.3", default-features = false }
```

已在 `wasm/Cargo.toml` 添加并验证：`cargo build --target wasm32-unknown-unknown --release --features render` 成功（含 png 0.17.16 / jpeg-decoder 0.3.2）。

- [ ] **Step 2: 验证依赖声明正确**

Run: `cargo tree -i jpeg-decoder`
Expected: `jpeg-decoder v0.3.2`，且 `rayon` 不在其依赖树中（default-features=false 生效）。

- [ ] **Step 3: 验证 fixture 文件存在且可解码（探测性单测，验证后保留为测试辅助）**

在 `tests/tex_test.rs` 追加一个 `#[test] fn probe_fixtures_are_decodable()`（本步只验证解码器 API 与 fixture 有效性，Task 3 会替换为完整断言）：

```rust
use std::io::Cursor;

#[test]
fn probe_fixtures_are_decodable() {
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
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test --test tex_test probe_fixtures_are_decodable`
Expected: PASS（png 解码 60×33、jpeg 解码 13×5）

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-wallpaper-engine/wasm/Cargo.toml packages/dsh-wallpaper-engine/wasm/Cargo.lock
git add packages/dsh-wallpaper-engine/wasm/tests/fixtures/tex/jpeg_mip_tail.jpg packages/dsh-wallpaper-engine/wasm/tests/fixtures/tex/png_mip_tail.png
git add packages/dsh-wallpaper-engine/wasm/tests/tex_test.rs
git commit -m "chore(wasm): 添加 png/jpeg-decoder 依赖与编码纹理 fixture（TEXB0003 解码前置）"
```

---

### Task 2: `parse_tex` 解码编码图像（PNG/JPEG，含魔数嗅探回退）

**Files:**
- Modify: `packages/dsh-wallpaper-engine/wasm/src/tex.rs`
- Test: `packages/dsh-wallpaper-engine/wasm/tests/tex_test.rs`

**Interfaces:**
- Consumes: `TexImage`（现有结构，含 `format: TexFormat`、`mip0: Vec<u8>`、`width/height: u32`）；`parse_tex(data: &[u8]) -> Option<TexImage>`
- Produces:
  - `fn decode_embedded_image(data: &[u8], declared: Option<u32>) -> Option<(u32, u32, Vec<u8>)>` — 解码编码图像为 RGBA8，返回 (宽, 高, 数据)；`declared` 为 TEXB0003+ 的 image_format（FreeImage FIF），None 或 -1 时用魔数嗅探
  - `parse_tex` 对编码图像返回 `TexImage { format: TexFormat::Rgba8888, width, height, mip0: rgba }`（V3+ 分支不再因编码直接 None）

**设计要点（对齐 open-wallpaper-engine TexImageParser.cpp）：**
- 魔数嗅探（对应 `DetectEmbeddedImageType`）：PNG `\x89PNG\r\n\x1a\n`、JPEG `\xFF\xD8\xFF`（GIF/BMP/TIFF/VIDEO 本计划不做，返回 None）
- 编码图像 mip 数据可能是 LZ4 压缩（`is_lz4=1`）或裸编码流（实测 Orange/2460786246 均 is_lz4=0）；解压逻辑复用现有分支
- 只解码 mip0（现有 `TexImage` 只承载 mip0；多 mip 链为后续扩展）
- 解码后 format 强制 `Rgba8888`（上传走现有 RGBA8 分支，`tex_format_id` → `rgba8unorm` 已存在）

- [ ] **Step 1: 写失败测试（编码图像解析 + 魔数嗅探）**

在 `tests/tex_test.rs` 追加（构造 TEXB0003 容器字节，内嵌 PNG/JPEG 编码载荷；仿照现有 `tex_with_mip` 辅助）：

```rust
use std::io::Cursor;

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
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test --test tex_test parses_png_encoded_tex_as_rgba parses_jpeg_encoded_tex_as_rgba sniffs_encoded_tex_when_image_format_unknown`
Expected: FAIL（`parse_tex` 对 image_format=13/2 直接返回 None，`expect` 触发 panic）

- [ ] **Step 3: 实现解码**

修改 `src/tex.rs`：

```rust
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
        // 声明 UNKNOWN（-1/0）→ 魔数嗅探
        _ => sniff_embedded_image(data)?,
    };
    match kind {
        EmbeddedImage::Png => {
            let dec = png::Decoder::new(data);
            let mut reader = dec.read_info().ok()?;
            let mut buf = vec![0u8; reader.output_buffer_size()];
            let info = reader.next_frame(&mut buf).ok()?;
            // png crate 默认输出与源一致的通道；仅接受 RGBA/RGB → 统一 RGBA8
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
            // jpeg-decoder 输出 RGB（3 通道）→ 补 alpha=255 为 RGBA
            let mut rgba = Vec::with_capacity(pixels.len() / 3 * 4);
            for px in pixels.chunks_exact(3) {
                rgba.extend_from_slice(&[px[0], px[1], px[2], 255]);
            }
            Some((info.width as u32, info.height as u32, rgba))
        }
    }
}
```

修改 `parse_tex` V3+ 分支（L149-164 区域）：

```rust
    // V3+：imageCount 后紧跟 FreeImage 格式（V4 还有 isVideoMp4 标志）
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
        // 编码图像（JPEG/PNG 等，FreeImage 格式 != -1/0）：不再跳过，记录格式待 mip 解码
        if image_format != 0 && image_format != u32::MAX {
            encoded_image_format = Some(image_format);
        }
    }
```

修改 mip 循环的载荷处理（原 L198-212 区域），在 `out` 解压得到后、`mip0` 赋值前插入解码分支：

```rust
            let raw = &data[pos..pos + bytes_len];
            let out = if is_lz4 {
                if decompressed == 0 || decompressed > (1 << 30) {
                    return None;
                }
                decompress(raw, decompressed as usize).ok()?
            } else {
                raw.to_vec()
            };
            // 编码图像（V3+）：mip0 载荷是 JPEG/PNG 字节流 → 解码为 RGBA8
            if mip0.is_none() {
                if let Some(declared) = encoded_image_format {
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
                }
            }
            if mip0.is_none() {
                mip0 = Some((w, h, out));
            }
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test --test tex_test`
Expected: PASS（全部用例，含既有 rgba_lz4/dxt1/rg88 与新增 3 个编码图像用例）

- [ ] **Step 5: 全量 native 回归**

Run: `cargo test`
Expected: PASS（含 coords/particle/scene/texture 等全部 native 测试）

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-wallpaper-engine/wasm/src/tex.rs packages/dsh-wallpaper-engine/wasm/tests/tex_test.rs
git commit -m "feat(wasm): parse_tex 支持 TEXB0003 JPEG/PNG 编码纹理解码（魔数嗅探回退）
- V3+ 分支不再对 image_format != 0/-1 直接返回 None，记录编码格式继续解析
- png 0.17 / jpeg-decoder 0.3（禁 rayon）解码 mip0 载荷为 RGBA8
- image_format=-1 时魔数嗅探（对齐 open-wallpaper-engine DetectEmbeddedImageType）
- 失败仍返回 None 不中断渲染；native 测试 3 新增用例全绿"
```

---

### Task 3: wasm 构建 + 浏览器全库复测（主图恢复验证）

**Files:**
- Modify: 无源码改动（构建 + 验证）
- Create: `research/diag-orange-scene.mjs` 已存在（复测脚本，含全 console 收集）

**Interfaces:**
- Consumes: Task 2 后的 `parse_tex`；`packages/dsh-wallpaper-engine/wasm/pkg/`（wasm-pack 产物）
- Produces: 验证数据（parse_tex FAILED 归零、主图恢复、20/24 壁纸判定变化）

- [ ] **Step 1: wasm-pack 构建并同步静态产物**

Run: `wasm-pack build --target web --release --features render`（Windows 下若进程不退出，产物生成后手动 kill；确认 `pkg/we_scene_wasm_bg.wasm` 时间戳更新）
Run: `node scripts/build-client.mjs`（把 wasm 产物复制到 `dist/static/`）

- [ ] **Step 2: 确认 profile 副本同步**

Run: `Copy-Item packages/dsh-wallpaper-engine/dist/static/* C:\Users\0009\.dsh\profiles\web\node_modules\@dsh-use\wallpaper-engine\dist\static\ -Force`
Expected: profile 副本 wasm 时间戳与 dist 一致（file: 依赖快照复制，需手动同步）

- [ ] **Step 3: 浏览器复测 Orange + 全库**

Run: `node research/diag-orange-scene.mjs`（headless Edge + CDP，全 console 收集）
Expected:
- Orange (1429403119) console **不再出现** `[wasm] load_image: parse_tex FAILED`（原 5739130B 消失）
- Orange 判定 avg 显著上升（原 54.8 偏暗 → 主图 2560×1440 铺满后应 >100）、dark 占比下降
- EVA (1280029027) 保持 OK（无回归）

- [ ] **Step 4: 全库复测（重点 20 个含编码纹理壁纸）**

Run: `node research/verify-wasm-render.mjs`（全 24 scene 壁纸判定表）
Expected: `parse_tex FAILED` 相关 console 计数归零（或仅剩声明编码但解码失败的极少数）；含编码主图壁纸（2212665284/2454403969/2460786246/2816905191/2851992662/2859263090/3303428996/3392903359/3760200530 等）从暗/STATIC 转 OK 或 avg 大幅上升；EVA 与既有 OK 壁纸无回归。

- [ ] **Step 5: 体积确认**

Run: `Get-Item packages/dsh-wallpaper-engine/dist/static/we_scene_wasm_bg.wasm | Select-Object Length`
Expected: ≤ 1MB（wasm-opt 后；当前 433KB + 解码器）

- [ ] **Step 6: 全量测试回归**

Run: `npm test`（vitest 全量，node + jsdom）
Run: `cargo test`
Expected: 全绿（JS 侧 tex-loader 已有编码图像支持，无关联改动；wasm 侧 native 测试已覆盖）

- [ ] **Step 7: Commit（如需保留构建脚本改动）**

```bash
git add packages/dsh-wallpaper-engine/dist/static packages/dsh-wallpaper-engine/wasm/pkg
git commit -m "build(wasm): 重新构建含编码纹理解码的 wasm 产物并同步 dist/static"
```

---

## 自审（Self-Review）

**Spec 覆盖：**
- 根因（parse_tex 对 FIF 编码返回 None）→ Task 2 核心修复 ✓
- 20/24 壁纸主图恢复 → Task 3 全库复测验证 ✓
- 魔数嗅探回退（open-wallpaper-engine DetectEmbeddedImageType 对齐）→ Task 2 `sniff_embedded_image` ✓
- wasm 兼容（jpeg-decoder 禁 rayon）→ Task 1 依赖验证 ✓
- 失败不中断渲染 → Task 2 所有解码失败路径返回 None ✓

**占位符扫描：** 无 TBD/TODO；所有测试代码、实现代码、命令均完整给出。

**类型一致性：**
- `decode_embedded_image(&[u8], Option<u32>) -> Option<(u32, u32, Vec<u8>)>` 在 Task 2 Step 1（测试）与 Step 3（实现）中签名一致 ✓
- `TexImage { format, width, height, mip0 }` 字段与现有 tex.rs 结构一致 ✓
- FIF 常量（PNG=13, JPEG=2）与 tex-loader.ts 枚举一致 ✓
- fixture 尺寸（png 60×33、jpeg 13×5）与测试断言一致 ✓

**遗留说明（非本计划范围）：**
- 多 mip 链解码（当前只解 mip0，`TexImage` 结构单 mip）——后续扩展
- GIF/BMP/TIFF/VIDEO 编码未实现（全库扫描无这些格式，VIDEO tex 为极少数）
- wasm 侧 `load_image` 失败仍只 console.log 不向 JS 返回（Task 2 已让主图可解码，回退链改进另案）
