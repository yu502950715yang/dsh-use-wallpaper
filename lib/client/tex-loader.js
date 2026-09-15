import * as THREE from 'three';
import LZ4 from 'lz4js';
import { fetchWithRetry } from './fetch-util.js';
// Wallpaper Engine .tex 容器（TEXV0005）解析器：
//   "TEXV0005\0" + "TEXI0001\0" + 28B 头（Format/Flags/TextureW/TextureH/ImageW/ImageH/UnkInt0）
//   + "TEXB0001|0002\0" + imageCount(i32) + 每 image: mipmapCount(i32)
//   + 每 mipmap: V2: width height isLZ4 decompressedBytes bytesLen + 数据 / V1: width height bytesLen + 数据
// mipmap 数据为 LZ4 block 或未压缩；本模块负责解压为原始像素/块数据。
// TexFormat 枚举（真实格式，与 RePKG 逆向一致）
export const TEX_FORMAT = {
    RGBA8888: 0,
    DXT5: 4,
    DXT3: 6,
    DXT1: 7,
    RG88: 8,
    R8: 9,
};
// FreeImage 格式枚举（TEXB0003+ 容器的 ImageFormat 字段，与 RePKG 一致）
export const FIF = {
    JPEG: 2,
    PNG: 13,
    WEBP: 21,
};
// fourCC → three/WebGL 压缩纹理格式常量。
// DXT1/3/5 对应 EXT_texture_compression_s3tc；BC4/BC5 采用 three 的 CompressedPixelFormat 常量
// （RED_RGTC1=0x8dbb、SIGNED_RED_RGTC1=0x8dbc、RED_GREEN_RGTC2=0x8dbd、SIGNED_RED_GREEN_RGTC2=0x8dbe，注意是 0x8d 而非 0x8f）。
const FORMAT_MAP = {
    DXT1: 0x83f1, DXT3: 0x83f2, DXT5: 0x83f3,
    BC4U: 0x8dbb, BC4S: 0x8dbc, BC5U: 0x8dbd, BC5S: 0x8dbe,
};
export function glFormatForDds(fourCC) {
    return FORMAT_MAP[fourCC] ?? 0;
}
// TexFormat 枚举值 → three 压缩纹理格式（仅压缩格式，非压缩格式走 DataTexture 分支）
const FORMAT_TO_GL = {
    [TEX_FORMAT.DXT1]: 0x83f1,
    [TEX_FORMAT.DXT3]: 0x83f2,
    [TEX_FORMAT.DXT5]: 0x83f3,
};
function readI32(buf, pos) {
    return buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24);
}
function readF32(buf, pos) {
    return new DataView(buf.buffer, buf.byteOffset + pos, 4).getFloat32(0, true);
}
function ascii(buf, pos, len) {
    let s = '';
    for (let i = 0; i < len; i++)
        s += String.fromCharCode(buf[pos + i]);
    return s;
}
const MIN_LEN = 18 + 28 + 9 + 4 + 4; // magic + header + container + imageCount + mipmapCount
export function parseTex(buf) {
    if (buf.length < MIN_LEN)
        return null;
    if (ascii(buf, 0, 9) !== 'TEXV0005\0')
        return null;
    if (ascii(buf, 9, 9) !== 'TEXI0001\0')
        return null;
    const format = readI32(buf, 18);
    const flags = readI32(buf, 22);
    const textureWidth = readI32(buf, 26);
    const textureHeight = readI32(buf, 30);
    const width = readI32(buf, 34); // ImageWidth
    const height = readI32(buf, 38); // ImageHeight
    const container = ascii(buf, 46, 9);
    if (container !== 'TEXB0002\0' && container !== 'TEXB0001\0'
        && container !== 'TEXB0003\0' && container !== 'TEXB0004\0')
        return null;
    const v2 = container === 'TEXB0002\0';
    const v3plus = container === 'TEXB0003\0' || container === 'TEXB0004\0';
    let pos = 46 + 9;
    const imageCount = readI32(buf, pos);
    if (imageCount <= 0 || imageCount > 64)
        return null;
    pos += 4;
    // TEXB0003/0004：imageCount 后紧跟 FreeImage 格式（V4 还有 isVideoMp4 标志）
    let imageFormat;
    if (v3plus) {
        imageFormat = readI32(buf, pos);
        pos += 4;
        if (container === 'TEXB0004\0')
            pos += 4;
    }
    const mipmaps = [];
    for (let img = 0; img < imageCount; img++) {
        if (pos + 4 > buf.length)
            return null;
        const mipmapCount = readI32(buf, pos);
        if (mipmapCount <= 0 || mipmapCount > 256)
            return null;
        pos += 4;
        for (let m = 0; m < mipmapCount; m++) {
            const fieldLen = v2 ? 20 : 12;
            if (pos + fieldLen > buf.length)
                return null;
            const mw = readI32(buf, pos);
            const mh = readI32(buf, pos + 4);
            let isLZ4 = 0;
            let decompressedBytes = 0;
            let bytesLen;
            if (v2 || v3plus) {
                // V2/V3/V4 的 mipmap 记录结构一致：width height isLZ4 decompressedBytes bytesLen
                isLZ4 = readI32(buf, pos + 8);
                decompressedBytes = readI32(buf, pos + 12);
                bytesLen = readI32(buf, pos + 16);
            }
            else {
                bytesLen = readI32(buf, pos + 8);
            }
            pos += v2 || v3plus ? 20 : 12;
            if (mw <= 0 || mh <= 0 || bytesLen < 0)
                return null;
            if (pos + bytesLen > buf.length)
                return null;
            const payload = buf.subarray(pos, pos + bytesLen);
            pos += bytesLen;
            if (isLZ4) {
                if (decompressedBytes <= 0 || decompressedBytes > 1 << 30)
                    return null;
                mipmaps.push({ width: mw, height: mh, data: lz4Decompress(payload, decompressedBytes) });
            }
            else {
                // 拷贝为纯 Uint8Array：与 LZ4 分支输出类型一致，且不 alias 输入 buffer
                mipmaps.push({ width: mw, height: mh, data: new Uint8Array(payload) });
            }
        }
    }
    if (mipmaps.length === 0)
        return null;
    // 精灵表（flags 位 2）：mip 循环之后紧跟 TEXS000x 动画段，记录**真实帧数**与每帧 uv。
    // 不解析该段就只能按「纹理宽/高」猜帧数（1024×1024 的 8×8 精灵表 → 1 帧 = 整张表被当单帧
    // 采样 → 每个粒子画出一整片网格亮点，见 parseSpriteSection 注释）。
    const first = mipmaps[0];
    const sprite = (flags & FLAG_SPRITE) !== 0
        ? parseSpriteSection(buf, pos, first.width, first.height)
        : undefined;
    return { width, height, textureWidth, textureHeight, format, flags, imageFormat, mipmaps, sprite };
}
// 解析 TEXV0005 的精灵表动画段（TEXS000x，紧跟在全部 image/mip 数据之后；对齐 open-wallpaper-engine
// `TexImageParser.cpp::ParseHeader` 的 sprite 分支）：
//   TEXS000x(9B, 尾随 NUL) + frameCount(i32) + [atlasW, atlasH](i32×2, texs>=3)
//   + 每帧: imageId(i32) + frametime(f32) + (x, y, xAxis0, xAxis1, yAxis0, yAxis1)
//           （texs==1 → 6×i32 像素；否则 6×f32 像素）
// 本函数只取「帧数 + 网格列/行数」：帧像素尺寸 = 第一帧 xAxis/yAxis 的欧氏长度，网格 = mip0 尺寸 / 帧尺寸
// （校验 cols×rows ≥ frames，装不下则视为不是规则精灵表 → undefined）。
//
// 为什么必须解析（DK WOTLK 全屏闪光粒子的根因，2026-09-11）：DK 的 `particle/fire/fire1`
// 与 `particle/fog/fog1` 都是 flags=4（sprite 位）的 1024×1024 **8×8 = 64 帧**精灵表；只按
// `frameCountFromDims(1024,1024)=1` 判定时，`particle_billboard`/three 粒子 shader 会把**整张表**
// 当一帧采样 → 单个火把粒子渲染出 64 个火苗排成的网格；DK 有 37 层火把（每层 maxcount=50）
// → 数万个亮点叠加（additive）＝ 用户所见的「全屏密布发光的闪光粒子、整屏泛光」。
// 任何越界/非法字段 → undefined（回退旧的宽高推导语义，绝不抛）。
export function parseSpriteSection(buf, pos, mipWidth, mipHeight) {
    if (!Number.isFinite(pos) || pos < 0 || pos + 13 > buf.length)
        return undefined;
    const stamp = ascii(buf, pos, 9);
    if (!stamp.startsWith('TEXS000'))
        return undefined;
    const texs = Number(stamp.slice(4, 8));
    if (!Number.isFinite(texs) || texs < 1 || texs > 9)
        return undefined;
    let p = pos + 9;
    const frames = readI32(buf, p);
    p += 4;
    if (frames <= 0 || frames > 4096)
        return undefined;
    if (texs >= 3)
        p += 8; // atlas 尺寸（未使用：帧几何取自每帧 xAxis/yAxis）
    const intCoords = texs === 1;
    const coord = () => {
        const v = intCoords ? readI32(buf, p) : readF32(buf, p);
        p += 4;
        return v;
    };
    if (p + 8 + 24 > buf.length)
        return undefined;
    coord(); // imageId
    coord(); // frametime
    coord();
    coord(); // x, y（帧左上角像素坐标）
    const ax0 = coord();
    const ax1 = coord();
    const ay0 = coord();
    const ay1 = coord();
    const frameW = Math.hypot(ax0, ax1);
    const frameH = Math.hypot(ay0, ay1);
    if (!(frameW > 0) || !(frameH > 0))
        return undefined;
    const cols = Math.max(1, Math.round(mipWidth / frameW));
    const rows = Math.max(1, Math.round(mipHeight / frameH));
    // 网格装不下全部帧（GIF 等非规则精灵表）→ 不按精灵表处理（对齐 owe 的保守判断）。
    if (cols * rows < frames)
        return undefined;
    return { frames, cols, rows };
}
// LZ4 block 解压（Wallpaper Engine .tex 内嵌为 LZ4 block，非 frame 格式）
function lz4Decompress(src, decompressedSize) {
    const out = new Uint8Array(decompressedSize);
    const n = LZ4.decompressBlock(src, out, 0, src.length, 0);
    return n === decompressedSize ? out : out.subarray(0, Math.min(n, decompressedSize));
}
// 基础层 mip = 全分辨率（mip[0]）。此前 `pickMipmap` 选「宽度 ≤2048 的最大级」做下采样，
// 当场景/视口需要更高分辨率时该纹理被**放大** → 画面模糊（不是原始分辨率，用户实测「整体糊」）。
// 这里统一取 mip[0]（解压后的原始尺寸），使背景/粒子纹理**保持原始分辨率**（锐利）。
// 本仓库 three 页面所有纹理均经 textureFromTex 处理；mipmaps 非空（parseTex 空 → null）故 mip[0] 恒存在。
// TEXV0005 flags 的 sprite 位（对齐 wasm/src/tex.rs `FLAG_SPRITE = 1 << 2` /
// open-wallpaper-engine `TexFlagEnum::sprite`）：精灵表纹理的 mip0 是**整张表**，头部 map 尺寸
// 只是其中一格 → **不可裁剪**（当前无精灵 UV 偏移支持，保持整表行为）。
const FLAG_SPRITE = 1 << 2;
// TEXV0005 flags 的 clampuvs 位（值 2，bit 1）—— 决定采样 wrap 模式。
// 位定义（逐字对齐参考实现 `research/.lwe/src/WallpaperEngine/Data/Assets/Texture.h:88-98`）：
//   TextureFlags_NoFlags = 0
//   TextureFlags_NoInterpolation = 1        （bit 0，未实现，见下）
//   TextureFlags_ClampUVs = 2               （bit 1，★ 本常量）
//   TextureFlags_IsGif = 4                  （bit 2，本文件 FLAG_SPRITE）
//   TextureFlags_ClampUVsBorder = 8         （bit 3，未实现，见下）
//   TextureFlags_Video = 32                 （bit 5，未实现）
//   TextureFlags_AlphaChannelPriority = 524288（bit 19，现由调用方传参决定，见下）
// flags 的来源是 **.tex 文件头本身**（`TextureParser.cpp:196` 读入 `header.flags`），与
// scene.json / material.json 无关。
const FLAG_CLAMP_UVS = 1 << 1;
// ⚠️ 已知未实现（与 WE 的其它差异，本次 wrap 修复**刻意不碰**，见 wrap-report.md 待办清单）：
//   · bit 0 `NoInterpolation`：WE 用 NEAREST（`CTexture.cpp:185-191`），而本文件 applyLinearSampling
//     现在无条件设 Linear/Mipmap ⇒ 带该位的像素风纹理会被线性插值（偏糊）。
//   · bit 3 `ClampUVsBorder`：WE 对**渲染目标**用 GL_CLAMP_TO_BORDER（`CFBO.cpp:29-31`）；磁盘 .tex
//     纹理在参考实现里只有 ClampUVs 分支、该位落到 else 的 REPEAT（`CTexture.cpp:177-183`），
//     three 亦无 CLAMP_TO_BORDER 对应的 `Wrapping` 常量 ⇒ 本实现按 lwe 语义一并视作 REPEAT。
//   · bit 19 `AlphaChannelPriority`：R8/RG88 的「alpha 写在 G/R 通道」语义，权威来源是该位，
//     现由 `EffectRunner` 按调用方路径传 `{ alphaPriority: false }` 推断（效果槽语义）。
// 2 的幂填充裁剪（与 wasm/src/tex.rs `crop_to_map` 同源语义，2026-09-10）：
// TEXV0005 的 **mip 记录尺寸**（w/h）是**上传尺寸**（2 的幂，如 4096×2048），而头部 @34/@38
// 的 width/height 是**逻辑内容尺寸**（如 2400×1555）。内容在 mip0 **左上角**，右侧/底部是
// 2 的幂填充（黑/透明）。若不裁剪就把整张上传纹理当 UV 0-1 采样：
//   - 纹理宽高 = mip 尺寸（4096×2048）→ 图像内容只出现在 quad 的左上 map/mip 比例区域
//     （EVA：58.6% 宽 × 75.9% 高），**右侧/底部露出填充黑边**——用户截图「EVA 背景只占左边约 2/3、
//     右侧大片黑」的根因（quad 尺寸 2400×1555 与场景一致、cover 相机也正确，问题在纹理内容域）；
//   - 「size 缺省回退纹理宽高」的对象也会拿到 4096×2048 这个错误的世界尺寸。
// 裁剪后纹理尺寸 = 内容尺寸 → UV 0-1 恰好是内容，与 wasm 渲染路径（crop_to_map）产出一致。
// 无填充（map ≥ mip）/ sprite / map 非法（0）→ 原样返回（不复制数据，零开销）。
export function cropToMap(data, mipWidth, mipHeight, mapWidth, mapHeight, format, flags) {
    const valid = Number.isFinite(mapWidth) && Number.isFinite(mapHeight) && mapWidth > 0 && mapHeight > 0;
    const cw = valid ? Math.min(Math.floor(mapWidth), mipWidth) : mipWidth;
    const ch = valid ? Math.min(Math.floor(mapHeight), mipHeight) : mipHeight;
    if ((flags & FLAG_SPRITE) !== 0 || (cw >= mipWidth && ch >= mipHeight)) {
        return { width: mipWidth, height: mipHeight, data };
    }
    if (format === TEX_FORMAT.DXT1 || format === TEX_FORMAT.DXT3 || format === TEX_FORMAT.DXT5) {
        const blockSize = format === TEX_FORMAT.DXT1 ? 8 : 16;
        return cropCompressedToMap(data, mipWidth, mipHeight, cw, ch, blockSize);
    }
    // 非压缩格式的每像素字节数：RGBA8888=4、RG88=2、R8=1（其余按 4 处理，与既有 Rgba 兜底一致）。
    const bpp = format === TEX_FORMAT.RG88 ? 2 : format === TEX_FORMAT.R8 ? 1 : 4;
    return cropRowsToMap(data, mipWidth, mipHeight, cw, ch, bpp);
}
// 非压缩格式按行裁剪：每行取 cw×bpp 字节、取前 ch 行（内容在左上角）。
function cropRowsToMap(data, mipWidth, mipHeight, cw, ch, bpp) {
    const rowBytes = cw * bpp;
    const out = new Uint8Array(rowBytes * ch);
    for (let y = 0; y < ch; y++) {
        const src = y * mipWidth * bpp;
        const end = Math.min(src + rowBytes, data.length);
        if (src >= data.length)
            break;
        out.set(data.subarray(src, end), y * rowBytes);
    }
    return { width: cw, height: ch, data: out };
}
// 块压缩格式按 4×4 块阵列裁剪（BC 纹理尺寸须为 4 的倍数 → 目标宽高向上取整到 4）。
// 截取左上角块阵列；内容区外的 1-3px 冗余行/列取自原内容边缘块（无害，对齐 wasm crop_bc）。
function cropCompressedToMap(data, mipWidth, mipHeight, cw, ch, blockSize) {
    const nw = Math.ceil(cw / 4) * 4;
    const nh = Math.ceil(ch / 4) * 4;
    const srcBlockW = Math.max(1, Math.ceil(mipWidth / 4));
    const dstBlockW = nw / 4;
    const dstBlockH = nh / 4;
    const rowBytes = dstBlockW * blockSize;
    const out = new Uint8Array(rowBytes * dstBlockH);
    for (let by = 0; by < dstBlockH; by++) {
        const src = by * srcBlockW * blockSize;
        if (src >= data.length)
            break;
        const end = Math.min(src + rowBytes, data.length);
        out.set(data.subarray(src, end), by * rowBytes);
    }
    return { width: nw, height: nh, data: out };
}
// TEXV0005 flags 的 video 位（值 32，bit 5；权威定义见 research/.lwe/.../Data/Assets/Texture.h:91-97
// 的 `TextureFlags_Video`）：带此位时 mip0 载荷是**完整 mp4 文件**（不是像素/块数据）。
const FLAG_VIDEO = 1 << 5;
/**
 * 视频纹理判定（纯函数，node 可测）：flags 带 Video 位 **且** mip0 载荷是 mp4 容器
 * （第一个 box 的 type = `ftyp`）。两个条件都要：单看 flags 会把「标了 Video 位但其实是像素数据」
 * 的包当视频（库里暂未出现），单看 magic 会误判恰好以 `?? ?? ?? ?? ftyp` 开头的像素数据。
 */
export function isVideoTexPayload(info) {
    if ((info.flags & FLAG_VIDEO) === 0)
        return false;
    const d = info.mipmaps[0]?.data;
    return !!d && d.length >= 12 && d[4] === 0x66 && d[5] === 0x74 && d[6] === 0x79 && d[7] === 0x70;
}
// 视频纹理就绪等待（`loadeddata` = 首帧可绘制）上限。超时按「播不了」处理（回落透明）。
const VIDEO_READY_TIMEOUT_MS = 5000;
/** 等 `<video>` 就绪：`loadeddata` → true；`error` / 超时 → false（幂等，只结算一次）。 */
function waitForVideoReady(video, timeoutMs) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            video.removeEventListener('loadeddata', onReady);
            video.removeEventListener('error', onError);
            resolve(ok);
        };
        const onReady = () => finish(true);
        const onError = () => finish(false);
        const timer = setTimeout(() => finish(false), timeoutMs);
        video.addEventListener('loadeddata', onReady);
        video.addEventListener('error', onError);
        // 已在缓存/已就绪（HAVE_CURRENT_DATA=2）时不会再有 loadeddata → 直接放行。
        if (typeof video.readyState === 'number' && video.readyState >= 2)
            finish(true);
    });
}
/** 视频不可播时的降级纹理：1×1 透明像素（见调用点注释：不白板、也不把 mp4 当像素解码）。 */
function transparentTexture() {
    const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    return tex;
}
/**
 * 由 mp4 载荷建 `THREE.VideoTexture`（WE 视频纹理）。失败返回 null（调用方决定降级）。
 *
 * 实测（`research/tmp-2911105183/probe-video-play.mjs`，headless Edge）：载荷是完整 mp4
 * （`ftyp isom/iso2/avc1/mp41`、H.264、1280×720、27.4s、无音轨），`loadeddata` 后
 * `play()` 成功、可作为 `texImage2D` 源（`glError=0`）⇒ 浏览器原生解码即可，不需要额外解封装。
 *
 * 三个不显然的约束：
 *  ① **静音自动播放**：`muted + playsInline` 才允许无手势起播（壁纸没有用户手势）；被策略拒绝时
 *     挂一次性 `pointerdown/keydown` 重试（与音频路径同思路），起播前纹理显示首帧之前的状态。
 *  ② **不进 mip 链**：`VideoTexture` 每帧 `needsUpdate`，`generateMipmaps` 会每帧重建整条 mip 链
 *     ⇒ 强制 `LinearFilter` + `generateMipmaps=false`（three 的 VideoTexture 缺省亦如此，这里写死
 *     以免未来被 `applyLinearSampling` 之类改动带上 mip）。
 *  ③ **生命周期不归 GPU 管**：`renderer.dispose()` 只释放 GPU 纹理，**不会停解码、不会撤销 Blob URL**
 *     ⇒ 在纹理的 `dispose` 事件（three `Texture.dispose()` 会派发）里 pause + 清 src + revoke。
 */
async function videoTextureFromMp4(data, info, topDown, decorate) {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        return null; // 非浏览器环境（node 测试/SSR）→ 交给调用方降级
    }
    const url = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    const release = () => {
        try {
            video.pause();
        }
        catch { /* 未起播时 pause 可能抛，忽略 */ }
        try {
            video.removeAttribute('src');
            video.src = '';
            video.load();
        }
        catch { /* 忽略 */ }
        URL.revokeObjectURL(url);
        try {
            video.remove();
        }
        catch { /* 未插入 DOM 时无 remove，忽略 */ }
    };
    if (!(await waitForVideoReady(video, VIDEO_READY_TIMEOUT_MS))) {
        release();
        return null;
    }
    const tex = new THREE.VideoTexture(video);
    // 行序：显示约定（bottomUp）→ flipY=true（video 是 DOM 元素源，UNPACK_FLIP_Y_WEBGL 生效）；
    // 效果槽约定（topDown = WE 的 v=0=顶部）→ flipY=false。与 ImageBitmap 分支同一套语义。
    tex.flipY = !topDown;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.addEventListener('dispose', release);
    // 静音自动播放；被策略拒绝 → 等一次用户手势重试。
    void video.play().catch(() => {
        if (typeof window === 'undefined')
            return;
        const resume = () => { void video.play().catch(() => { }); };
        window.addEventListener('pointerdown', resume, { once: true });
        window.addEventListener('keydown', resume, { once: true });
    });
    return decorate(tex);
}
// 由解析结果构造 three 纹理：
//   TEXB0003+ 编码图像（imageFormat=JPEG/PNG/WEBP）→ 解码为 ImageBitmap 后包装为 Texture（异步）
//   （注意：编码图像的 format 字段仍为 RGBA8888(0)，但 mipmap 数据是 JPEG/PNG 字节流，
//    必须先按 imageFormat 判断，否则会被误当原始 RGBA 创建 DataTexture → 渲染乱码）
//   RGBA8888 → DataTexture（`rowOrder` 决定是否翻转行序，见 TexRowOrder 注释）；
//   DXT1/3/5 → CompressedTexture
export async function textureFromTex(info, opts) {
    const mip = info.mipmaps[0];
    if (!mip)
        return null;
    // v 约定：缺省 'bottomUp'（= 本参数引入前的既有行为，纹理上传前翻行序）。
    const topDown = opts?.rowOrder === 'topDown';
    // 精灵表信息（TEXS 段）随纹理带走：three.js 粒子路径需要**真实帧数与网格**做多帧 uv 切片
    // （否则 8×8 精灵表被当单帧 → 每个粒子画出整片网格亮点，见 parseSpriteSection 注释）。
    const withSprite = (tex) => {
        const ud = { ...(tex.userData ?? {}) };
        if (info.sprite)
            ud.sprite = info.sprite;
        // WE 的 `g_TextureNResolution` 用 lwe 约定 **(mip0.w, mip0.h, header.w, header.h)**，
        // 不是 (w, h, 1/w, 1/h)。效果 shader 用 `.z/.x` 缩放 mask 的 UV，例如 shake.vert：
        //   `v_TexCoord.zw = uv * g_Texture1Resolution.z / g_Texture1Resolution.x`
        // header 尺寸（textureWidth/Height）可能大于 image 尺寸（NPOT padding），必须随纹理带走；
        // 若 .z 退化成 1/w ⇒ .z/.x = 1/w² ⇒ mask 的 UV 被压成 ~0 ⇒ 所有像素采到 mask 的同一个角
        // ⇒ 本该只作用于 mask 区域的 shake/pulse/foliagesway 变成**全图等量位移**
        // （真机现象：GTR 整屏晃动而不是只抖排气管）。
        ud.fxRes = [mip.width, mip.height, info.textureWidth, info.textureHeight];
        tex.userData = ud;
        return tex;
    };
    // 过滤/采样（关键，修复「模糊/不清」）：three.js `DataTexture` 缺省 **NearestFilter**
    //（逐像素最近采样，放大成马赛克方块、缩小无 mip 抗锯齿 → 观感「糊/不锐利」）。这里对
    // 非压缩背景/粒子纹理统一设 `magFilter=LinearFilter`（双线性）+ `minFilter=LinearMipmapLinearFilter`
    //（mip 链抗锯齿）+ `generateMipmaps=true`（GPU 自动生成 mip），匹配标准高质量采样：1:1 清晰、
    // 放大柔和、缩小抗锯齿（本仓库 three r170 仅 WebGL2，NPOT 也能生成 mip，无 WebGL1 NPOT 风险）。
    const applyLinearSampling = (tex) => {
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        tex.needsUpdate = true;
    };
    // wrap 模式（修复 CP2077 `effects/clouds` 整屏发白，2026-09-14）：
    // WE **默认 REPEAT**，只有 .tex 头 flags 带 `clampuvs`（bit 1）才 clamp —— 参考实现
    //   `research/.lwe/src/WallpaperEngine/Render/CTexture.cpp:176-183`
    //     if (flags & TextureFlags_ClampUVs) → GL_CLAMP_TO_EDGE else → GL_REPEAT
    // 此前本函数三条分支都不设 wrapS/wrapT ⇒ 落到 three 的默认 ClampToEdgeWrapping ⇒ 与 WE 相反。
    // 后果（clouds.frag 有意把第二组 UV 旋转到负象限：cloudTexCoods.zw = vec2(-w, z)，u∈[-0.5,0]）：
    // clamp 下 cloud1 整幅塌到纹理**最左一列**（该列 R 均值 0.706，远亮于全图均值 0.494）
    // ⇒ `cloudColor = cloud0 * cloud1` 被抬高 ⇒ `mix(原图, cloudColor, ~0.28)` 把整屏提亮，
    // 且 t≈77s 后 UV 全域越界 → 均匀提亮并饱和（真机：62.45 → 75.75，且随时间越来越白）。
    //
    // ⚠️ **边界（务必保持）**：本函数只作用于**经 textureFromTex 创建的 `.tex` 资源纹理**。
    // `WebGLRenderTarget.texture`（对象 RT / ping-pong RT / 具名 RT）**不经过本函数**，必须保持
    // three 默认的 CLAMP —— `src/client/object-range.ts:147-163` 的对象合成 quad 明确依赖 clamp
    //（窗口外侧 UV 夹到 RT 边缘），一旦改成 REPEAT 就会把 RT 内容平铺到对象四周。
    // 因此**绝不要把 wrap 设成全局默认**（例如 Three.js 层的 `Texture.DEFAULT_WRAPPING` 或渲染器钩子）。
    const applyWrap = (tex, info) => {
        const clamp = (info.flags & FLAG_CLAMP_UVS) !== 0;
        tex.wrapS = tex.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    };
    // 视频纹理优先（必须排在编码图像与原始像素两条分支**之前**）：flags bit5 置位时 mip0 是
    // **完整 mp4 文件**，按像素解会得到乱码（且载荷常比 w×h×4 小 ⇒ 后续 flipRows 直接越界抛错）。
    if (isVideoTexPayload(info)) {
        const decorate = (t) => {
            applyWrap(t, info);
            return withSprite(t);
        };
        const videoTex = await videoTextureFromMp4(mip.data, info, topDown, decorate);
        if (videoTex)
            return videoTex;
        // 播不了（编解码不支持 / 解码错误 / 5s 超时）→ **画透明**：
        //   ① 返回 null 会让 `createLayerMaterial(map: null)` 退回**白色不透明**面板；
        //   ② 按原始像素解 mp4 是乱码、且可能越界抛错。
        // 载体是 1×1 透明纹理 ⇒ 该图层不可见（与「视频纹理未实现」时的观感一致），并留一条可辨识告警。
        console.warn(`[wallpaper-engine] 视频纹理无法播放，回退为透明: flags=${info.flags} `
            + `${mip.width}x${mip.height} ${mip.data.length}B`);
        return transparentTexture();
    }
    // 编码图像优先：imageFormat 是 FreeImage 枚举（JPEG/PNG/WEBP）时数据为编码字节流
    const mime = info.imageFormat === FIF.JPEG ? 'image/jpeg'
        : info.imageFormat === FIF.PNG ? 'image/png'
            : info.imageFormat === FIF.WEBP ? 'image/webp' : '';
    if (mime) {
        if (typeof createImageBitmap !== 'function')
            return null;
        try {
            // 方向语义（关键）：three.js 的 texture.flipY 对 ImageBitmap 无效（翻转只能在 bitmap
            // 创建时通过 imageOrientation 指定）。WE tex 编码图像是 top-down（第一行=顶部）。
            //   `rowOrder:'bottomUp'`（显示约定）→ 解码时 `imageOrientation:'flipY'` + flipY=false，
            //     使 v=0=图像底部（与 DataTexture 路径一致，画面正立）；
            //   `rowOrder:'topDown'`（WE 约定）→ 解码保持 'from-image'（首行=顶部落在 v=0）。
            const bitmap = await createImageBitmap(new Blob([mip.data], { type: mime }), { imageOrientation: topDown ? 'from-image' : 'flipY' });
            const tex = new THREE.Texture(bitmap);
            tex.flipY = false;
            applyWrap(tex, info);
            applyLinearSampling(tex);
            return withSprite(tex);
        }
        catch {
            return null;
        }
    }
    // imageFormat=-1 或 TEXB0001/0002（无该字段）→ mipmap 数据为原始像素/块数据
    if (info.format === TEX_FORMAT.RGBA8888 || info.format === TEX_FORMAT.RG88 || info.format === TEX_FORMAT.R8) {
        // 方向语义（关键）：DataTexture 的 flipY 对 TypedArray 上传无效（WebGL 的
        // UNPACK_FLIP_Y_WEBGL 只对 DOM 元素源生效），数据第一行会落在纹理 v=0。
        // WE tex 原始数据是 top-down（第一行=图像顶部）：
        //   `rowOrder:'bottomUp'`（显示约定）→ 手动翻转行序为 bottom-up（第一行=图像底部），
        //     与 ImageBitmap 路径一致；
        //   `rowOrder:'topDown'`（WE 约定）→ 不翻（第一行=图像顶部 = v=0）。
        // 顺序（关键）：**先按 map 尺寸裁掉 2 的幂填充**（cropToMap，此时仍是原始 bpp 数据）
        // 再 RG88/R8 展开、最后按 rowOrder 决定是否翻转——翻转必须用裁剪后的宽高（否则行距错位）。
        // RGBA8888 原样；RG88/R8 先展开为 RGBA（convertUnormToRgba，WE 粒子纹理 alpha-priority 语义）
        // 再翻转——此前 RG88/R8 无分支直接 return null（DK 雪片/wasam 雾纹理加载失败 → 白图兜底）。
        const cropped = cropToMap(mip.data, mip.width, mip.height, info.width, info.height, info.format, info.flags);
        const src = info.format === TEX_FORMAT.RGBA8888 ? cropped.data : convertUnormToRgba(cropped.data, info.format, opts?.alphaPriority !== false);
        const rows = topDown ? src : flipRows(src, cropped.width, cropped.height, 4);
        const tex = new THREE.DataTexture(rows, cropped.width, cropped.height, THREE.RGBAFormat);
        applyWrap(tex, info);
        applyLinearSampling(tex);
        return withSprite(tex);
    }
    const glFormat = FORMAT_TO_GL[info.format];
    if (glFormat) {
        // 方向语义（关键，修复 DXT 背景上下颠倒 —— Task 5 深挖）：WE .tex 压缩数据是 **top-down**
        // （第一行=图像顶部，同 RGBA8888）。`CompressedTexture` 构造器把 `flipY` 置 false，且 WebGL 的
        // `UNPACK_FLIP_Y_WEBGL` 对压缩纹理上传**无效**（只能按块数据原样写入，v=0=图像顶部），而 three
        // PlaneGeometry 的 v=0=quad 底部 → 图像顶部被渲染到底部 = **上下颠倒**（RGBA8888 路径靠
        // `flipRows` 手动翻为 bottom-up 规避，编码图像靠 `imageOrientation:'flipY'` 规避，唯独 DXT 漏掉）。
        // 此处按**块行**（每 4 像素行一块，DXT 压缩纹理尺寸须为 4 的倍数）反转数据，使 v=0=bottom-up，
        // 与 DataTexture/ImageBitmap 两条路径的行序**一致**（图像正立）；`rowOrder:'topDown'` 时不翻
        // （第一块行=图像顶部 = v=0，见 TexRowOrder 注释）。
        const blockSize = info.format === TEX_FORMAT.DXT1 ? 8 : 16;
        // ⚠️ 只用 mip[0]（全分辨率基础层），**不传内嵌 mip 链**（关键，修复「DXT 背景模糊」——Lycoris
        // Recoil，2026-09-10 真机复现）：
        //   ① WE 的 DXT 纹理内嵌 mip 链往往**不完整**：materials/111.tex 为 DXT1 6144×3072，链只有
        //      5 级（6144→3072→1536→768→384），而完整链需 0..floor(log2(6144))=12 共 13 级。
        //      three 的压缩纹理上传用 `texStorage2D(TEXTURE_2D, levels = mipmaps.length …)` 分配
        //      **不可变存储**（`WebGLTextures` 25125-25232：`levels = getMipLevels()` → `mipmaps.length`），
        //      之后无法再补层级 ⇒ 该纹理在 ES 3.0 语义下**不是 mipmap complete**（mipmap 过滤器的
        //      采样结果由实现定义：宽松驱动会夹取到最深一层、严格驱动直接返回 (0,0,0,1)）——不可依赖。
        //   ② 即使驱动宽松（本机 RTX 3060/ANGLE D3D11 实测：补全链后画面与不补全**像素级一致**），
        //      `minFilter = LinearMipmapLinearFilter` 的**三线性过滤**会在常见视口下取到 mip1/mip2：
        //      Lycoris 背景对象 world 宽 = 6144×0.47891 = 2942（画布 2560×1440 的 1.15 倍），1920 宽视口
        //      下可见纹理跨度 ≈5345 texel → LOD≈1.48（mip1/mip2 混合）；实测锐度（相邻像素梯度均值）
        //      比基础层采样低 **31%**（4.25 vs 5.58，1920×1080）、17%（3200×1800），即用户所见的「糊」。
        //      对照：黑神话背景 3840×2160 纹理 ↔ 3840×2160 场景（1:1），1920 视口 LOD 恰为 1.0
        //      → mip1 = 1920×1080 = 屏幕分辨率 → 像素级锐利，故「同为 three 渲染，唯独 DXT 那张糊」。
        //   ③ 因此压缩纹理与 RGBA8888/编码图像路径对齐：**基础层 = mip0 全分辨率、不做 mip 下采样**，
        //      `minFilter = LinearFilter`（非 mipmap 过滤器 ⇒ 纹理必然 complete，无 ① 的未定义行为），
        //      `magFilter = LinearFilter`（与另两条路径一致的双线性放大）。
        //   ④ 与 RGBA8888 路径同源：**先按 map 尺寸裁掉 2 的幂填充**（DXT 按 4×4 块裁剪，见 cropToMap），
        //      再反转块行序——裁剪在前，翻转的块行距才与裁剪后的宽度一致。无填充纹理（Lycoris
        //      materials/111.tex 6144×3072）走原样路径，不复制数据。
        const cropped = cropToMap(mip.data, mip.width, mip.height, info.width, info.height, info.format, info.flags);
        const blocks = topDown ? cropped.data : flipCompressedRows(cropped.data, cropped.width, cropped.height, blockSize);
        const tex = new THREE.CompressedTexture([{
                data: blocks,
                width: cropped.width,
                height: cropped.height,
            }], cropped.width, cropped.height, glFormat);
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearFilter;
        // 压缩纹理不能由 GPU 生成 mip（three 会跳过 generateMipmap），显式关闭避免误判「需要 mip」。
        tex.generateMipmaps = false;
        applyWrap(tex, info);
        tex.needsUpdate = true;
        return withSprite(tex);
    }
    return null;
}
// 垂直翻转压缩纹理的**块行序**（top-down → bottom-up）。DXT（BC1/BC2/BC3）每 4×4 像素一块、
// 每块固定 `blockSize` 字节（DXT1=8、DXT3/5=16）；压缩纹理无法用 UNPACK_FLIP_Y 翻转，必须在数据层
// 反转块行（每块行 = 一块高 = 4 像素行，块内像素顺序不变）。尺寸须为 4 的倍数（DXT 约束），
// 不满足时按 `ceil` 对齐（超出区冗余，无害）。纯函数（native 可测）。
export function flipCompressedRows(data, width, height, blockSize) {
    const blockW = Math.max(1, Math.ceil(width / 4));
    const blockH = Math.max(1, Math.ceil(height / 4));
    const rowBytes = blockW * blockSize;
    const out = new Uint8Array(data.length);
    for (let by = 0; by < blockH; by++) {
        const src = by * rowBytes;
        const dst = (blockH - 1 - by) * rowBytes;
        // rowBytes 可能超出 data 尾部（不满足 4 倍时的冗余），用 subarray 截断安全拷贝。
        const end = Math.min(src + rowBytes, data.length);
        out.set(data.subarray(src, end), dst);
    }
    return out;
}
// RG88（format 8，2 字节/像素）与 R8（format 9，1 字节/像素）→ RGBA8888。
// WebGL 无便捷 2 通道/1 通道 DataTexture 渲染路径（ShaderMaterial 直接按 vec4 采样），故展开为
// RGBA8，对齐 WE `ConvertTexture0Format` 的粒子语义：
//   - R8：rgb 恒白、alpha = R 通道（`vec4(1,1,1,_sample.r)`，fog/rain 雾形状——同 wasm
//     `r8_to_rgba_white_alpha`，纹理不调制颜色、alpha 由灰度调制）。
//   - RG88：`vec4(r, r, r, g)`——r=亮度灰度（复制到 rgb）、g=alpha 覆盖（snow 雪片形状；
//     `TextureFlags_AlphaChannelPriority` = "alpha is in G/R channel"，RG88 的 alpha 在 G 通道，
//     R8 的 alpha 在 R 通道）。
// 纯函数（native 可测）。
// `alphaPriority`（缺省 true）= WE **粒子纹理**语义：R8 → `vec4(1,1,1,r)`、RG88 → `vec4(r,r,r,g)`
//（`TextureFlags_AlphaChannelPriority`：形状/覆盖写在 R（R8）或 G（RG88）通道）。
// 传 false = **效果纹理槽**语义：通道按原义映射（R8 → `vec4(r,r,r,1)`、RG88 → `vec4(r,g,0,1)`）——
// 效果 shader 直接读 `.r` / `.rg` 当遮罩数值，例如 pulse.frag：
//   `float mask = texSample2D(g_Texture2, v_TexCoord.zw).r; albedo = mix(sample, albedo, mask);`
// 若按粒子语义（rgb 恒白）则 `.r` 恒为 1 ⇒ mask 完全失效 ⇒ 本该只作用于遮罩区域的 pulse
// 变成**全图脉冲**（真机现象：GTR 整屏一闪一闪，而桌面 WE 上只有手机反光在女孩脸上闪）。
// 同理 shake 的 flowmask（RG88）需要 `.rg` = (R, G) 两个方向分量。
export function convertUnormToRgba(data, format, alphaPriority = true) {
    if (format === TEX_FORMAT.RG88) {
        const out = new Uint8Array(data.length * 2);
        for (let i = 0, o = 0; i < data.length; i += 2, o += 4) {
            const r = data[i];
            const g = data[i + 1];
            if (alphaPriority) {
                out[o] = r;
                out[o + 1] = r;
                out[o + 2] = r;
                out[o + 3] = g;
            }
            else {
                out[o] = r;
                out[o + 1] = g;
                out[o + 2] = 0;
                out[o + 3] = 255;
            }
        }
        return out;
    }
    // R8：粒子语义 rgb 恒白、alpha = R 通道；效果语义 r=g=b=R。
    const out = new Uint8Array(data.length * 4);
    for (let i = 0, o = 0; i < data.length; i++, o += 4) {
        const v = data[i];
        if (alphaPriority) {
            out[o] = 255;
            out[o + 1] = 255;
            out[o + 2] = 255;
            out[o + 3] = v;
        }
        else {
            out[o] = v;
            out[o + 1] = v;
            out[o + 2] = v;
            out[o + 3] = 255;
        }
    }
    return out;
}
// 垂直翻转像素行序（top-down → bottom-up）。DataTexture 上传 TypedArray 时 flipY 无效，
// 必须在数据层面翻转，使第一行对应图像底部（v=0 语义与 ImageBitmap 路径对齐）。
export function flipRows(data, width, height, bytesPerPixel) {
    const rowBytes = width * bytesPerPixel;
    const out = new Uint8Array(data.length);
    for (let y = 0; y < height; y++) {
        const src = y * rowBytes;
        const dst = (height - 1 - y) * rowBytes;
        out.set(data.subarray(src, src + rowBytes), dst);
    }
    return out;
}
// 拉取 .tex（带瞬时失败重试）→ parseTex → 构造纹理。解析失败/格式不支持返回 null。
// `opts.alphaPriority: false` = 效果纹理槽语义（R8/RG88 按原义映射通道，见 convertUnormToRgba）。
// `opts.rowOrder` = v 约定（缺省 'bottomUp' 显示约定，'topDown' = WE/对象 RT 约定，见 TexRowOrder）。
export async function loadTexTexture(url, opts) {
    const buf = await fetchWithRetry(url);
    if (!buf)
        return null;
    const info = parseTex(buf);
    if (!info)
        return null;
    return textureFromTex(info, opts);
}
