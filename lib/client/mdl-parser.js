// WE puppet 模型（.mdl）解析：MDLV（网格）+ MDLS（骨骼）+ MDLA（动画）；零依赖、畸形一律返回结构化错误。
// 段布局按真实素材实测（3828798871 / 3812518176）与参考实现 we-layerd 的 bounded section 口径，见 AGENT.md §7.40。
export const MDL_VERTEX_STRIDE = 80;
/** 静态族 stride 候选集：先筛「整除」、再筛「索引零越界」，最后按浪费率取最小。 */
const STRIDE_CANDIDATES = [24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80];
/** 紧覆盖下限：最小浪费率超过它就不认这个块（宁可拒收，也不静默画错）。 */
const MAX_STRIDE_WASTE = 0.05;
const MIN_VERTEX_COUNT = 3;
const MAX_VERTEX_COUNT = 200_000;
const KEYFRAME_BYTES = 36; // f32[3] pos + f32[3] 欧拉角 + f32[3] scale（9 个 float；见 AGENT.md §7.40）
const SUPPORTED_MDLV = ['MDLV0013', 'MDLV0016', 'MDLV0017', 'MDLV0019', 'MDLV0021', 'MDLV0023'];
/** 段头：9B stamp（"MDxx0000\0"）+ 4B 段尾绝对偏移；段尾之后的下一个段头可紧接着。 */
const SECTION_HEADER_BYTES = 13;
const MAX_BONES = 4096;
const MAX_ANIMATIONS = 4096;
const MAX_TRACKS = 4096;
/** 顶点记录布局表（键 = stride）：只列确认过字段偏移的 stride；选中但不在表里 = 拒收，不猜偏移。 */
const VERTEX_LAYOUTS = {
    48: { posZ: false, uv: 40, skin: false }, // 实测静态变体：pos.xy@0 + 8 个 float + uv@40
    80: { posZ: true, uv: 72, skin: true }, // 文档化打包族：pos/boneIdx@40/weights@56/uv@72
};
function ascii(buf, at, len) {
    let s = '';
    for (let i = 0; i < len; i++)
        s += String.fromCharCode(buf[at + i] ?? 0);
    return s;
}
// 文本字段（材质串 / 动画名）是 UTF-8（真实素材动画名 = 中文）；非法字节按替换符处理，不影响偏移。
const utf8Decoder = new TextDecoder('utf-8');
function decodeCStringBytes(buf, at, end) {
    return utf8Decoder.decode(buf.subarray(at, end));
}
/** 零结尾 C 字符串（返回 [字符串, 下一个可读位置]）。 */
function cstr(buf, at, limit = buf.length) {
    let e = at;
    while (e < limit && e < buf.length && buf[e] !== 0)
        e++;
    return [decodeCStringBytes(buf, at, e), Math.min(e + 1, limit)];
}
/** 段内零结尾 C 字符串；越界返回 null（调用方据此把段判 failed，不读段外字节）。 */
function sectionCString(buf, at, limit) {
    if (at >= limit)
        return null;
    let e = at;
    while (e < limit && buf[e] !== 0)
        e++;
    if (e >= limit)
        return null;
    return [decodeCStringBytes(buf, at, e), e + 1];
}
/** 段扫描：找 ASCII 标记（与参考实现同口径，但只在段头位置接受）。 */
function indexOfAscii(buf, marker) {
    outer: for (let i = 0; i + marker.length <= buf.length; i++) {
        for (let k = 0; k < marker.length; k++)
            if (buf[i + k] !== marker.charCodeAt(k))
                continue outer;
        return i;
    }
    return -1;
}
function isUpperAscii(c) {
    return c >= 0x41 && c <= 0x5a;
}
/** 读 at 处的段头；不是合法 bounded section 返回 null（段头无效 = 继续扫描，与参考实现同口径）。 */
function readSectionAt(buf, at) {
    if (at < 0 || at + SECTION_HEADER_BYTES > buf.length)
        return null;
    if (buf[at] !== 0x4d || buf[at + 1] !== 0x44)
        return null; // 'M' 'D'
    if (!isUpperAscii(buf[at + 2]) || !isUpperAscii(buf[at + 3]))
        return null;
    let version = 0;
    for (let i = at + 4; i < at + 8; i++) {
        const d = buf[i] - 0x30;
        if (d < 0 || d > 9)
            return null;
        version = version * 10 + d;
    }
    if (buf[at + 8] !== 0 || version <= 0)
        return null;
    const end = buf[at + 9] | (buf[at + 10] << 8) | (buf[at + 11] << 16) | (buf[at + 12] << 24);
    const payload = at + SECTION_HEADER_BYTES;
    if (end <= payload || end > buf.length)
        return null;
    return { type: ascii(buf, at, 4), version, payload, end };
}
/** 从 from 起找第一个指定类型的合法段头；找不到返回 null。 */
function findSection(buf, type, from = 0) {
    for (let at = from; at + SECTION_HEADER_BYTES <= buf.length; at++) {
        if (buf[at] !== 0x4d || buf[at + 1] !== 0x44)
            continue;
        const section = readSectionAt(buf, at);
        if (section && section.type === type)
            return section;
    }
    return null;
}
/** 段级状态：标记文本都没有 = absent；有标记但没有合法段头/解不完 = failed。 */
function sectionState(buf, type, section, ok) {
    if (ok)
        return 'ok';
    if (section)
        return 'failed';
    return indexOfAscii(buf, type) < 0 ? 'absent' : 'failed';
}
function readU16(buf, at) {
    return buf[at] | (buf[at + 1] << 8);
}
function readU32(buf, at) {
    return (buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)) >>> 0;
}
function readI32(buf, at) {
    return buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24);
}
function readF32(dv, at) {
    return dv.getFloat32(at, true);
}
const MISS = { kind: 'miss' };
/** 候选集全量判定：整除 → 顶点数在界内且索引零越界 → 浪费率（未通过 inRange 记 -1）。 */
function strideCandidates(vertexBytes, maxIndex) {
    return STRIDE_CANDIDATES.map((stride) => {
        const divides = vertexBytes % stride === 0;
        const vertexCount = divides ? vertexBytes / stride : 0;
        const inRange = divides && vertexCount >= MIN_VERTEX_COUNT && vertexCount <= MAX_VERTEX_COUNT && maxIndex < vertexCount;
        return { stride, vertexCount, divides, inRange, waste: inRange ? 1 - (maxIndex + 1) / vertexCount : -1 };
    });
}
/** 静态族 stride 择一：整除 → 索引零越界 → 紧覆盖（浪费率最小）；并列或超 5% 一律拒收。 */
function selectStride(vertexBytes, maxIndex) {
    const candidates = strideCandidates(vertexBytes, maxIndex);
    const info = (stride, reason) => ({ stride, reason, maxIndex, candidates });
    const fits = candidates.filter((c) => c.inRange);
    if (fits.length === 0) {
        return { ok: false, hard: false, error: `stride-no-candidate:bytes=${vertexBytes}`, info: info(0, 'no-candidate') };
    }
    const minWaste = Math.min(...fits.map((c) => c.waste));
    // 同一 vertexBytes 下各候选顶点数互不相同 ⇒ 并列实际不会出现，保留为「不猜」的守卫
    const best = fits.filter((c) => c.waste <= minWaste + 1e-9);
    if (best.length > 1) {
        const strides = best.map((c) => c.stride).join('/');
        return { ok: false, hard: true, error: `stride-ambiguous:${strides}:bytes=${vertexBytes}:maxIndex=${maxIndex}`, info: info(best[0].stride, 'ambiguous') };
    }
    if (minWaste > MAX_STRIDE_WASTE) {
        const error = `stride-waste:${minWaste.toFixed(4)}:stride=${best[0].stride}:bytes=${vertexBytes}:maxIndex=${maxIndex}`;
        return { ok: false, hard: true, error, info: info(best[0].stride, 'waste-too-high') };
    }
    return { ok: true, stride: best[0].stride, info: info(best[0].stride, 'tight-coverage') };
}
/** 校验一个顶点块候选并解码为 MdlMesh；不像顶点块即 miss（调用方继续试下一个位置）。 */
function decodeMesh(buf, dv, limit, verticesOffset, family, materialPath) {
    const vertexBytes = dv.getUint32(verticesOffset - 4, true);
    if (vertexBytes === 0)
        return MISS;
    const indexLenOffset = verticesOffset + vertexBytes;
    if (indexLenOffset + 4 > limit || indexLenOffset + 4 > buf.length)
        return MISS;
    const indexBytes = dv.getUint32(indexLenOffset, true);
    const indicesOffset = indexLenOffset + 4;
    // 索引必是三角列表：偶数 + 3 的倍数
    if (indexBytes === 0 || indexBytes % 6 !== 0)
        return MISS;
    if (indicesOffset + indexBytes > limit || indicesOffset + indexBytes > buf.length)
        return MISS;
    const indexCount = indexBytes / 2;
    const indices = new Uint16Array(indexCount);
    let maxIndex = 0;
    // 静态族早退：任一索引 ≥ vertexBytes/24（最小候选也是 24B/顶点）⇒ 没有候选装得下它
    const staticCap = vertexBytes / STRIDE_CANDIDATES[0];
    for (let i = 0; i < indexCount; i++) {
        const v = dv.getUint16(indicesOffset + i * 2, true);
        indices[i] = v;
        if (v > maxIndex)
            maxIndex = v;
        if (family === 'static' && v >= staticCap)
            return MISS;
    }
    let stride;
    let strideInfo;
    if (family === 'packed') {
        // 蒙皮族：stride 恒为 80（brief 契约），索引允许 2% 越界 —— 与基线行为一致，不做紧覆盖择一
        if (vertexBytes % MDL_VERTEX_STRIDE !== 0)
            return MISS;
        const vertexCount = vertexBytes / MDL_VERTEX_STRIDE;
        if (vertexCount < MIN_VERTEX_COUNT || vertexCount > MAX_VERTEX_COUNT)
            return MISS;
        let bad = 0;
        for (let i = 0; i < indexCount; i++)
            if (indices[i] >= vertexCount)
                bad++;
        if (bad > indexCount * 0.02)
            return MISS;
        stride = MDL_VERTEX_STRIDE;
        strideInfo = { stride, reason: 'packed-80', maxIndex, candidates: strideCandidates(vertexBytes, maxIndex) };
    }
    else {
        const picked = selectStride(vertexBytes, maxIndex);
        if (!picked.ok)
            return picked.hard ? { kind: 'hard', error: picked.error, info: picked.info } : MISS;
        stride = picked.stride;
        strideInfo = picked.info;
    }
    const layout = VERTEX_LAYOUTS[stride];
    // 选中但没确认过字段布局 ⇒ 拒收，reason 记为布局缺口（Task 7 排查用）
    if (!layout) {
        const error = `stride-layout-unknown:${stride}:bytes=${vertexBytes}:maxIndex=${maxIndex}`;
        return { kind: 'hard', error, info: { ...strideInfo, reason: 'layout-unknown' } };
    }
    const vertexCount = vertexBytes / stride;
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const blendIndices = layout.skin ? new Uint16Array(vertexCount * 4) : null;
    const blendWeights = layout.skin ? new Float32Array(vertexCount * 4) : null;
    let weightOk = true;
    for (let i = 0; i < vertexCount; i++) {
        const o = verticesOffset + i * stride;
        const x = dv.getFloat32(o, true);
        const y = dv.getFloat32(o + 4, true);
        const z = layout.posZ ? dv.getFloat32(o + 8, true) : 0;
        // 位置合理性：非有限或量级失控 ⇒ 这个候选是垃圾块（选错会把顶点炸到 1e28）
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
            return MISS;
        if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6 || Math.abs(z) > 1e6)
            return MISS;
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;
        uvs[i * 2] = dv.getFloat32(o + layout.uv, true);
        uvs[i * 2 + 1] = dv.getFloat32(o + layout.uv + 4, true);
        if (layout.skin && blendIndices && blendWeights) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                blendIndices[i * 4 + k] = dv.getUint32(o + 40 + k * 4, true);
                const w = dv.getFloat32(o + 56 + k * 4, true);
                blendWeights[i * 4 + k] = w;
                sum += w;
            }
            if (Math.abs(sum - 1) > 0.05)
                weightOk = false;
        }
    }
    if (!Number.isFinite(uvs[0]) || !Number.isFinite(uvs[uvs.length - 1]))
        return MISS;
    return {
        kind: 'ok',
        mesh: {
            positions,
            uvs,
            // 权重不自洽 ⇒ 按静态网格渲染（不蒙皮），不把垃圾权重交给蒙皮
            blendIndices: layout.skin && weightOk ? blendIndices : null,
            blendWeights: layout.skin && weightOk ? blendWeights : null,
            indices,
            vertexCount,
            materialPath,
            strideInfo,
        },
    };
}
/** 网格块定位：文档化锚点（+32/+36 填充）优先，然后从 9 起逐字节扫描（参考实现口径）。 */
function parseMesh(buf, dv, meshLimit) {
    const [briefMaterial, afterMat] = cstr(buf, 9, meshLimit);
    const [observedMaterial] = cstr(buf, 21, meshLimit);
    /** 材质串宽窄两种口径；优先取以 .json 结尾者（窄口径常是真串的后缀，如 m.json）。 */
    const materialOf = (family) => {
        const cands = family === 'static' ? [observedMaterial, briefMaterial] : [briefMaterial, observedMaterial];
        return cands.find((s) => s.endsWith('.json')) ?? cands[0];
    };
    // 定位到块上的硬失败（stride 不唯一 / 无字段布局）要留痕：整份文件都找不出网格时上报，
    // 但不立即中止 —— 锚点与扫描都可能先撞上假块，立即中止会把本可解析的文件误拒。
    const hard = [];
    const attempt = (offset, family) => {
        const out = decodeMesh(buf, dv, meshLimit, offset, family, materialOf(family));
        if (out.kind === 'ok')
            return out.mesh;
        if (out.kind === 'hard' && hard.length === 0)
            hard.push({ error: out.error, info: out.info });
        return null;
    };
    for (const pad of [32, 36]) {
        const offset = afterMat + pad + 4;
        if (offset + 12 > meshLimit)
            continue;
        for (const family of ['packed', 'static']) {
            const mesh = attempt(offset, family);
            if (mesh)
                return { mesh };
        }
    }
    for (let offset = 9; offset + 12 < meshLimit; offset++) {
        // 便宜预筛：顶点字节数（@offset-4）至少要能被某个候选 stride 整除，否则 decodeMesh 必然拒绝
        const vertexBytes = dv.getUint32(offset - 4, true);
        if (vertexBytes === 0 || !STRIDE_CANDIDATES.some((s) => vertexBytes % s === 0))
            continue;
        for (const family of ['static', 'packed']) {
            const mesh = attempt(offset, family);
            if (mesh)
                return { mesh };
        }
    }
    return hard.length > 0 ? { error: hard[0].error, info: hard[0].info } : { error: 'mesh-parse-failed' };
}
/**
 * MDLS：stamp + u32 段尾 + u16 骨数 + u16 填充；每骨 = name cstr / i32（临时值，非骨 id）/
 * u32 父索引（0xFFFFFFFF = 根）/ u32 绑矩阵字节数（恒 64）/ f32[16] 列主序 / 仿真 JSON cstr。
 */
function parseBones(buf, dv) {
    const section = findSection(buf, 'MDLS');
    if (!section)
        return { bones: [], status: sectionState(buf, 'MDLS', null, false) };
    let p = section.payload;
    if (p + 4 > section.end)
        return { bones: [], status: 'failed' };
    const boneCount = readU16(buf, p);
    p += 4;
    if (boneCount === 0 || boneCount > MAX_BONES)
        return { bones: [], status: 'failed' };
    const bones = [];
    for (let i = 0; i < boneCount; i++) {
        const name = sectionCString(buf, p, section.end);
        if (!name)
            return { bones: [], status: 'failed' };
        p = name[1];
        if (p + 12 > section.end)
            return { bones: [], status: 'failed' };
        p += 4; // 临时值：真实素材 5 根骨该字段恒为 1，不是骨 id，也不参与任何映射
        const rawParent = readU32(buf, p);
        const transformBytes = readU32(buf, p + 4);
        p += 8;
        if (transformBytes !== 64 || p + 64 > section.end)
            return { bones: [], status: 'failed' };
        const bind = new Float32Array(16);
        for (let k = 0; k < 16; k++) {
            bind[k] = readF32(dv, p + k * 4);
            if (!Number.isFinite(bind[k]))
                return { bones: [], status: 'failed' };
        }
        p += 64;
        const simulation = sectionCString(buf, p, section.end);
        if (!simulation)
            return { bones: [], status: 'failed' };
        p = simulation[1];
        // 父索引必须指向更早的骨（0xFFFFFFFF = 根）；越界按根处理，避免建树成环。
        const parent = rawParent !== 0xffffffff && rawParent < bones.length ? rawParent : -1;
        bones.push({ index: i, parent, bind });
    }
    return { bones, status: bones.length === boneCount ? 'ok' : 'failed' };
}
function isNonZeroTriple(v) {
    return Math.abs(v[0]) > 1e-6 || Math.abs(v[1]) > 1e-6 || Math.abs(v[2]) > 1e-6;
}
function isDefaultScale(v) {
    return Math.abs(v[0] - 1) <= 1e-6 && Math.abs(v[1] - 1) <= 1e-6 && Math.abs(v[2] - 1) <= 1e-6;
}
/** 轨是否有作者姿态（WE 语义：无作者姿态的轨保持绑定姿态，不把骨骼清成 0）。 */
function trackAuthored(keys) {
    for (const k of keys) {
        if (isNonZeroTriple(k.pos) || isNonZeroTriple(k.angle) || !isDefaultScale(k.scale))
            return true;
    }
    return false;
}
/**
 * MDLA：stamp + u32 段尾 + u32 动画数；每动画 = id（跳过 0 填充）/ i32 / name cstr / 可选空名兜底 /
 * mode cstr / f32 fps / i32 长度 / i32 / u32 轨数；每轨 = i32（真实素材恒 0）/ u32 字节数 / 36B 关键帧；
 * 轨后：mdla ≥ 3 读 1B 分隔，旧版本读 metadata 表。
 */
function parseAnimations(buf, dv) {
    const section = findSection(buf, 'MDLA');
    if (!section)
        return { animations: [], status: sectionState(buf, 'MDLA', null, false) };
    let p = section.payload;
    if (p + 4 > section.end)
        return { animations: [], status: 'failed' };
    const animCount = readU32(buf, p);
    p += 4;
    if (animCount === 0 || animCount > MAX_ANIMATIONS)
        return { animations: [], status: 'failed' };
    const out = [];
    for (let a = 0; a < animCount; a++) {
        // id 前可能有 0 值字段（WE 导出器补位）⇒ 读到第一个非 0 为止
        let id = 0;
        let guard = 0;
        do {
            if (p + 4 > section.end)
                return { animations: [], status: 'failed' };
            id = readI32(buf, p);
            p += 4;
            if (++guard > 64)
                return { animations: [], status: 'failed' };
        } while (id === 0);
        if (id < 0)
            return { animations: [], status: 'failed' };
        if (p + 4 > section.end)
            return { animations: [], status: 'failed' };
        p += 4;
        const name = sectionCString(buf, p, section.end);
        if (!name)
            return { animations: [], status: 'failed' };
        p = name[1];
        // 空名时参考实现再读一次（部分导出器把名称留空）；读不到才判失败
        if (!name[0] && p < section.end) {
            const fallback = sectionCString(buf, p, section.end);
            if (!fallback)
                return { animations: [], status: 'failed' };
            p = fallback[1];
        }
        const mode = sectionCString(buf, p, section.end);
        if (!mode)
            return { animations: [], status: 'failed' };
        p = mode[1];
        if (p + 16 > section.end)
            return { animations: [], status: 'failed' };
        const fpsRaw = readF32(dv, p);
        const frameCount = readI32(buf, p + 4);
        const trackCount = readU32(buf, p + 12);
        p += 16;
        if (trackCount > MAX_TRACKS)
            return { animations: [], status: 'failed' };
        const tracks = [];
        for (let t = 0; t < trackCount; t++) {
            if (p + 8 > section.end)
                return { animations: [], status: 'failed' };
            p += 4; // 轨头 i32：真实素材恒 0（不是骨 id）⇒ 轨序即骨序
            const trackBytes = readU32(buf, p);
            p += 4;
            if (trackBytes === 0 || trackBytes % KEYFRAME_BYTES !== 0 || p + trackBytes > section.end) {
                return { animations: [], status: 'failed' };
            }
            const keyCount = trackBytes / KEYFRAME_BYTES;
            const keys = new Array(keyCount);
            for (let k = 0; k < keyCount; k++) {
                const o = p + k * KEYFRAME_BYTES;
                const key = {
                    pos: [readF32(dv, o), readF32(dv, o + 4), readF32(dv, o + 8)],
                    // 欧拉角（弧度）：WE 组合顺序 Rz·Ry·Rx，渲染侧换算四元数（AGENT.md §7.40）
                    angle: [readF32(dv, o + 12), readF32(dv, o + 16), readF32(dv, o + 20)],
                    scale: [readF32(dv, o + 24), readF32(dv, o + 28), readF32(dv, o + 32)],
                };
                if (!Number.isFinite(key.pos[0]) || !Number.isFinite(key.angle[0]) || !Number.isFinite(key.scale[0])) {
                    return { animations: [], status: 'failed' };
                }
                keys[k] = key;
            }
            p += trackBytes;
            tracks.push({ boneId: t, authored: trackAuthored(keys), keys });
        }
        if (section.version >= 3) {
            // 轨表之后固定 35B 尾块（实测 6/6 动画全零：renwu 2 + leon 4；多动画文件必须按 35B 跳过，
            // 否则下一动画错位。内部结构未确证 ⇒ 只按长度跳过，见 AGENT.md §7.40）。
            const trailerBytes = 35;
            if (p + trailerBytes > section.end)
                return { animations: [], status: 'failed' };
            p += trailerBytes;
        }
        else {
            if (p + 4 > section.end)
                return { animations: [], status: 'failed' };
            const metadataCount = readU32(buf, p);
            p += 4;
            if (metadataCount > 65536)
                return { animations: [], status: 'failed' };
            for (let m = 0; m < metadataCount; m++) {
                if (p + 4 > section.end)
                    return { animations: [], status: 'failed' };
                p += 4;
                const meta = sectionCString(buf, p, section.end);
                if (!meta)
                    return { animations: [], status: 'failed' };
                p = meta[1];
            }
        }
        const fps = Number.isFinite(fpsRaw) && fpsRaw > 0 && fpsRaw <= 240 ? fpsRaw : 30;
        out.push({ id, name: name[0], mode: mode[0], fps, frameCount, tracks });
    }
    return { animations: out, status: out.length === animCount ? 'ok' : 'failed' };
}
/** 顶点蒙皮槽 = 骨骼下标（无文件 id 映射）；引用越界下标 ⇒ 整份蒙皮不可信，退化为静态网格。 */
function validateBlendIndices(mesh, boneCount) {
    const src = mesh.blendIndices;
    const weights = mesh.blendWeights;
    if (!src)
        return;
    if (boneCount === 0) {
        mesh.blendIndices = null;
        mesh.blendWeights = null;
        return;
    }
    for (let i = 0; i < src.length; i++) {
        // 权重为 0 的槽不参与蒙皮：其 id 即使是垃圾值也不影响结果，不得据此丢弃整份蒙皮。
        if (weights && weights[i] === 0)
            continue;
        if (src[i] >= boneCount) {
            console.warn(`[mdl] 顶点蒙皮槽引用了骨表里没有的骨骼下标=${src[i]} ⇒ 整份蒙皮退化为静态网格`);
            mesh.blendIndices = null;
            mesh.blendWeights = null;
            return;
        }
    }
}
export function parseMdl(buf) {
    if (!(buf instanceof Uint8Array))
        return { ok: false, error: 'not-bytes' };
    if (buf.length < 16)
        return { ok: false, error: 'too-short' };
    const version = ascii(buf, 0, 8);
    if (!version.startsWith('MDLV') || !SUPPORTED_MDLV.includes(version)) {
        return { ok: false, error: 'unsupported-header:' + version };
    }
    try {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        // 网格块必须落在第一个 segment 之前（MDLS/MDLA/MDAT/MDLE/MDMP 任一）
        let meshLimit = buf.length;
        for (const marker of ['MDLS', 'MDLA', 'MDAT', 'MDLE', 'MDMP']) {
            const at = indexOfAscii(buf, marker);
            if (at >= 0 && at < meshLimit)
                meshLimit = at;
        }
        const located = parseMesh(buf, dv, meshLimit);
        if ('error' in located) {
            return located.info
                ? { ok: false, error: located.error, strideInfo: located.info }
                : { ok: false, error: located.error };
        }
        const boneTable = parseBones(buf, dv);
        // 承重项：蒙皮下标与骨表同口径（都是文件记录顺序），只校验不重映射。
        validateBlendIndices(located.mesh, boneTable.bones.length);
        const anim = parseAnimations(buf, dv);
        return {
            ok: true,
            puppet: {
                version,
                mesh: located.mesh,
                bones: boneTable.bones,
                animations: anim.animations,
                segments: { mdls: boneTable.status, mdla: anim.status },
            },
        };
    }
    catch {
        // 越界读取等异常一律收成结构化错误（契约：畸形输入不抛）
        return { ok: false, error: 'malformed' };
    }
}
