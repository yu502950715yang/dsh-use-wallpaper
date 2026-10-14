// WE puppet 模型（.mdl）解析：MDLV（网格）+ MDLS（骨骼）+ MDLA（动画）三段。
// 段布局依据上游 mdl-parse.js 文档化口径（MDLV0021/0023 打包族 stride 80；MDLA0006 头 + 36B 关键帧），
// 并兼容本机实测的静态变体（12B 固定头 + stride 48 顶点，段标记不存在）。畸形输入返回结构化错误、不抛
// ——解析不了的 puppet 只能退化成普通贴图，不该拖垮整张壁纸。实测证据与口径差异见 AGENT.md §7.39。
export const MDL_VERTEX_STRIDE = 80;
/** 实测静态变体（本机唯一样本）的顶点记录：pos.xy@0 + 8 个常量 float + uv@40，共 12 float。 */
const STATIC_VERTEX_STRIDE = 48;
const KEYFRAME_BYTES = 36; // f32[3] pos + f32[4] quat + f32[2] scale
const SUPPORTED_MDLV = ['MDLV0013', 'MDLV0016', 'MDLV0017', 'MDLV0019', 'MDLV0021', 'MDLV0023'];
function ascii(buf, at, len) {
    let s = '';
    for (let i = 0; i < len; i++)
        s += String.fromCharCode(buf[at + i] ?? 0);
    return s;
}
/** 零结尾 C 字符串（返回 [字符串, 下一个可读位置]）。 */
function cstr(buf, at, limit = buf.length) {
    let e = at;
    while (e < limit && e < buf.length && buf[e] !== 0)
        e++;
    let s = '';
    for (let i = at; i < e; i++)
        s += String.fromCharCode(buf[i]);
    return [s, Math.min(e + 1, limit)];
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
/**
 * 校验一个顶点块候选并解码为 MdlMesh；任何自洽校验不过返回 null（调用方继续试下一个候选）。
 * 文档化口径：u32 顶点字节数 + 顶点流 + u32 索引字节数 + u16 索引。
 * 实测静态口径：u32 顶点数 + u32 顶点字节数 + 顶点流 + u32 索引字节数 + u16 索引。
 */
function decodeMesh(buf, dv, limit, verticesOffset, kind, materialPath) {
    const stride = kind === 'puppet' ? MDL_VERTEX_STRIDE : STATIC_VERTEX_STRIDE;
    const vertexBytes = dv.getUint32(verticesOffset - 4, true);
    const indexLenOffset = verticesOffset + vertexBytes;
    if (vertexBytes === 0 || vertexBytes % stride !== 0)
        return null;
    const vertexCount = vertexBytes / stride;
    if (vertexCount < 3 || vertexCount > 200_000)
        return null;
    if (indexLenOffset + 4 > limit || indexLenOffset + 4 > buf.length)
        return null;
    const indexBytes = dv.getUint32(indexLenOffset, true);
    const indicesOffset = indexLenOffset + 4;
    // 索引必是三角列表：偶数 + 3 的倍数
    if (indexBytes === 0 || indexBytes % 6 !== 0)
        return null;
    if (indicesOffset + indexBytes > limit || indicesOffset + indexBytes > buf.length)
        return null;
    const indexCount = indexBytes / 2;
    const indices = new Uint16Array(indexCount);
    let bad = 0;
    for (let i = 0; i < indexCount; i++) {
        const v = dv.getUint16(indicesOffset + i * 2, true);
        indices[i] = v;
        if (v >= vertexCount)
            bad++;
    }
    if (bad > indexCount * 0.02)
        return null;
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const blendIndices = kind === 'puppet' ? new Uint16Array(vertexCount * 4) : null;
    const blendWeights = kind === 'puppet' ? new Float32Array(vertexCount * 4) : null;
    let weightOk = true;
    for (let i = 0; i < vertexCount; i++) {
        const o = verticesOffset + i * stride;
        const x = dv.getFloat32(o, true);
        const y = dv.getFloat32(o + 4, true);
        const z = kind === 'puppet' ? dv.getFloat32(o + 8, true) : 0;
        // 位置合理性：非有限或量级失控 ⇒ 这个候选是垃圾块（选错会把顶点炸到 1e28）
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
            return null;
        if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6 || Math.abs(z) > 1e6)
            return null;
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;
        const uvOff = kind === 'puppet' ? 72 : 40;
        uvs[i * 2] = dv.getFloat32(o + uvOff, true);
        uvs[i * 2 + 1] = dv.getFloat32(o + uvOff + 4, true);
        if (kind === 'puppet') {
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
        return null;
    return {
        positions,
        uvs,
        // 权重不自洽 ⇒ 按静态网格渲染（不蒙皮），不把垃圾权重交给蒙皮
        blendIndices: kind === 'puppet' && weightOk ? blendIndices : null,
        blendWeights: kind === 'puppet' && weightOk ? blendWeights : null,
        indices,
        vertexCount,
        materialPath,
    };
}
/**
 * 网格块定位：文档化锚点（两种填充长度都试）优先，然后从 9 起逐字节扫描（参考实现口径）。
 * 每个位置都试「打包族（u32 顶点字节数 + stride 80）」与「实测静态变体（u32 顶点数 +
 * u32 顶点字节数 + stride 48）」两种排版 —— 头部填充长度在样本间不固定，只能靠自洽校验认。
 */
function parseMesh(buf, dv, meshLimit) {
    const [docMaterial, docAfterMat] = cstr(buf, 9, meshLimit);
    const [materialPath] = cstr(buf, 21, meshLimit);
    // 文档化口径：magic(9) + u32 + u32 + 材质 cstr（NUL 后 32B/36B 填充）→ u32 顶点字节数
    for (const pad of [32, 36]) {
        const offset = docAfterMat + pad + 4;
        if (offset + 12 > meshLimit)
            continue;
        for (const kind of ['puppet', 'static']) {
            const mesh = decodeMesh(buf, dv, meshLimit, offset, kind, kind === 'static' ? materialPath : docMaterial);
            if (mesh)
                return mesh;
        }
    }
    for (let offset = 9; offset + 12 < meshLimit; offset++) {
        // 便宜预筛：至少一种排版的顶点字节数要整除（否则 decodeMesh 必然拒绝）
        const v80 = dv.getUint32(offset - 4, true);
        const v48 = dv.getUint32(offset, true);
        if (!(v80 > 0 && v80 % MDL_VERTEX_STRIDE === 0) && !(v48 > 0 && v48 % STATIC_VERTEX_STRIDE === 0))
            continue;
        for (const kind of ['static', 'puppet']) {
            const mesh = decodeMesh(buf, dv, meshLimit, offset, kind, materialPath);
            if (mesh)
                return mesh;
        }
    }
    return null;
}
/** 绑定矩阵合理性：全有限、量级可控、最后一行是齐次行 (0,0,0,1)。 */
function saneBind(dv, off) {
    for (let i = 0; i < 16; i++) {
        const v = dv.getFloat32(off + i * 4, true);
        if (!Number.isFinite(v) || Math.abs(v) > 1e6)
            return false;
    }
    return dv.getFloat32(off + 12, true) === 0 && dv.getFloat32(off + 28, true) === 0
        && dv.getFloat32(off + 44, true) === 0 && dv.getFloat32(off + 60, true) === 1;
}
/**
 * MDLS0004：magic(9) + u32 段尾 + u32 骨数；每骨 tmp + u32 id + i32 parent + u32 matSize + f32[16] + cstr json。
 * 头部实测 13B（矩阵紧接 matSize），另容 10B（参考实现的 u16 tmp 变体，本机无样本）靠矩阵合理性择一。
 */
function parseBones(buf, dv) {
    const at = indexOfAscii(buf, 'MDLS');
    if (at < 0 || at + 17 > buf.length)
        return [];
    const next = indexOfAscii(buf, 'MDLA'); // 骨表不得吞掉后续段
    let p = at + 13; // 跳过 magic(9) 与段尾字段
    const boneCount = dv.getUint32(p, true);
    p += 4;
    const bones = [];
    for (let b = 0; b < boneCount && bones.length < 512; b++) {
        let ok = false;
        for (const head of [13, 10]) {
            if (p + head + 64 > buf.length)
                continue;
            if (next >= 0 && p + head + 64 > next)
                continue; // 骨表不得吞掉后续段
            if (!saneBind(dv, p + head))
                continue;
            const len = dv.getUint32(p + head - 4, true);
            if (len !== 64)
                continue;
            const bind = new Float32Array(16);
            for (let i = 0; i < 16; i++)
                bind[i] = dv.getFloat32(p + head + i * 4, true);
            bones.push({ index: b, parent: dv.getInt32(p + head - 8, true), bind });
            p += head + 64;
            [, p] = cstr(buf, p, buf.length); // 跳过每骨的 JSON 约束串
            ok = true;
            break;
        }
        if (!ok)
            break;
    }
    // 父索引必须在范围内（越界按根处理，避免建树时成环）
    for (const bone of bones)
        if (bone.parent >= bones.length)
            bone.parent = -1;
    return bones;
}
/**
 * 动画头的轨数与轨表定位：文档化口径在 fps/frameCount 与轨数之间还有一个 u32，
 * 而约定的夹具少了这 4B ⇒ 两个候选偏移都试，只接受「轨表自洽」的那个。
 */
function locateTracks(dv, p, bufLen) {
    let best = null;
    for (const delta of [0, -4]) {
        const t = p + delta;
        if (t < 0 || t + 4 > bufLen)
            continue;
        const count = dv.getUint32(t, true);
        if (count < 1 || count > 256)
            continue;
        const at = t + 4 + 35; // 轨数之后的固定填充
        let ok = true;
        let q = at;
        for (let k = 0; k < count; k++) {
            if (q + 8 > bufLen) {
                ok = false;
                break;
            }
            const bytes = dv.getUint32(q + 4, true);
            if (bytes === 0 || bytes % KEYFRAME_BYTES !== 0 || q + 8 + bytes > bufLen) {
                ok = false;
                break;
            }
            q += 8 + bytes;
        }
        // 轨表尾巴最贴近缓冲区结尾的那个候选最可信（另一个候选通常是错位的读法）
        if (ok && (!best || bufLen - q < bufLen - best.end))
            best = { trackCount: count, trackAt: at, end: q };
    }
    return best ? { trackCount: best.trackCount, trackAt: best.trackAt } : null;
}
/** MDLA0006：magic(9) + u32 段尾 + u32 动画数；每动画头 + 35B 填充 + 每轨 u32 boneId / u32 trackBytes / 36B 关键帧。 */
function parseAnimations(buf, dv, boneCount) {
    const at = indexOfAscii(buf, 'MDLA');
    if (at < 0 || at + 17 > buf.length)
        return [];
    let p = at + 13;
    const animCount = dv.getUint32(p, true);
    p += 4;
    const out = [];
    for (let a = 0; a < animCount && out.length < 64; a++) {
        if (p + 8 > buf.length)
            break;
        const id = dv.getUint32(p, true);
        p += 8; // u32 id + u32 unk
        let name;
        [name, p] = cstr(buf, p);
        let mode;
        [mode, p] = cstr(buf, p);
        if (p + 20 + 35 > buf.length)
            break;
        const fpsRaw = dv.getFloat32(p, true);
        const frameCount = dv.getUint32(p + 4, true);
        const located = locateTracks(dv, p + 12, buf.length);
        if (!located)
            break;
        let q = located.trackAt;
        const tracks = [];
        let ok = true;
        for (let t = 0; t < located.trackCount; t++) {
            if (q + 8 > buf.length) {
                ok = false;
                break;
            }
            const boneId = dv.getUint32(q, true);
            const trackBytes = dv.getUint32(q + 4, true);
            q += 8;
            // 轨自洽：36B 关键帧整数倍、不越界、boneId 在骨数内（boneCount 为 0 时不校验，交由消费方）
            if (trackBytes === 0 || trackBytes % KEYFRAME_BYTES !== 0 || q + trackBytes > buf.length) {
                ok = false;
                break;
            }
            if (boneCount > 0 && boneId >= boneCount) {
                ok = false;
                break;
            }
            const keyCount = trackBytes / KEYFRAME_BYTES;
            const keys = [];
            for (let k = 0; k < keyCount; k++) {
                const o = q + k * KEYFRAME_BYTES;
                keys.push({
                    pos: [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)],
                    rot: [dv.getFloat32(o + 12, true), dv.getFloat32(o + 16, true), dv.getFloat32(o + 20, true), dv.getFloat32(o + 24, true)],
                    scale: [dv.getFloat32(o + 28, true), dv.getFloat32(o + 32, true)],
                });
            }
            q += trackBytes;
            tracks.push({ boneId, keys });
        }
        // 轨自洽校验不过 ⇒ 该动画按文档化口径拒收（不返回半截轨）
        if (!ok)
            break;
        const fps = Number.isFinite(fpsRaw) && fpsRaw > 0 && fpsRaw <= 240 ? fpsRaw : 30;
        if (frameCount > 0 && tracks.length > 0)
            out.push({ id, name, mode, fps, frameCount, tracks });
        p = q; // 下一动画紧接本动画轨表之后
    }
    return out;
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
        // 网格块必须落在第一个 MDLS/MDLA 段之前
        let meshLimit = buf.length;
        for (const marker of ['MDLS', 'MDLA']) {
            const at = indexOfAscii(buf, marker);
            if (at >= 0 && at < meshLimit)
                meshLimit = at;
        }
        const mesh = parseMesh(buf, dv, meshLimit);
        if (!mesh)
            return { ok: false, error: 'mesh-parse-failed' };
        const bones = parseBones(buf, dv);
        const animations = parseAnimations(buf, dv, bones.length);
        return { ok: true, puppet: { version, mesh, bones, animations } };
    }
    catch {
        // 越界读取等异常一律收成结构化错误（契约：畸形输入不抛）
        return { ok: false, error: 'malformed' };
    }
}
