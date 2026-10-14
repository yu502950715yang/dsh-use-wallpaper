// WE puppet 模型（.mdl）解析：MDLV（网格）+ MDLS（骨骼）+ MDLA（动画）；零依赖、畸形一律返回结构化错误。
// 段布局的实测事实与未确证项见 AGENT.md §7.40（本文件只留结论与判据，不留推导）。
export const MDL_VERTEX_STRIDE = 80;
/** 静态族 stride 候选集：先筛「整除」、再筛「索引零越界」，最后按浪费率取最小。 */
const STRIDE_CANDIDATES = [24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80];
/** 紧覆盖下限：最小浪费率超过它就不认这个块（宁可拒收，也不静默画错）。 */
const MAX_STRIDE_WASTE = 0.05;
const MIN_VERTEX_COUNT = 3;
const MAX_VERTEX_COUNT = 200_000;
const KEYFRAME_BYTES = 36; // f32[3] pos + f32[4] quat + f32[2] scale
const SUPPORTED_MDLV = ['MDLV0013', 'MDLV0016', 'MDLV0017', 'MDLV0019', 'MDLV0021', 'MDLV0023'];
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
/** MDLS：magic(9) + u32 段尾 + u32 骨数；每骨 13B 头（tmp+id+parent+matSize）或 10B 变体 + f32[16] + cstr。 */
function parseBones(buf, dv) {
    const at = indexOfAscii(buf, 'MDLS');
    if (at < 0)
        return { bones: [], status: 'absent', idToIndex: null };
    if (at + 17 > buf.length)
        return { bones: [], status: 'failed', idToIndex: null };
    const next = indexOfAscii(buf, 'MDLA'); // 骨表不得吞掉后续段
    let p = at + 13; // 跳过 magic(9) 与段尾字段
    const boneCount = dv.getUint32(p, true);
    p += 4;
    // fileId 用于 id 自洽校验；10B 变体没有 id 字段，按序号记（本机无样本，仅容错）
    const raw = [];
    for (let b = 0; b < boneCount && raw.length < 512; b++) {
        let ok = false;
        for (const head of [13, 10]) {
            if (p + head + 64 > buf.length)
                continue;
            if (next >= 0 && p + head + 64 > next)
                continue; // 骨表不得吞掉后续段
            if (!saneBind(dv, p + head))
                continue;
            if (dv.getUint32(p + head - 4, true) !== 64)
                continue; // matSize 必须 64
            const bind = new Float32Array(16);
            for (let i = 0; i < 16; i++)
                bind[i] = dv.getFloat32(p + head + i * 4, true);
            raw.push({ fileId: head === 13 ? dv.getUint32(p + 1, true) : b, parent: dv.getInt32(p + head - 8, true), bind });
            p += head + 64;
            [, p] = cstr(buf, p, buf.length); // 跳过每骨的 JSON 约束串
            ok = true;
            break;
        }
        if (!ok)
            break;
    }
    // 文件 id 不是 0..n-1 时按 id 升序重排，并同步父索引：T7 的 bones[boneId] 才不会错绑
    const identity = raw.every((r, i) => r.fileId === i);
    const order = raw.map((_, i) => i);
    if (!identity)
        order.sort((x, y) => raw[x].fileId - raw[y].fileId || x - y);
    const idToIndex = identity ? null : new Map(order.map((b, i) => [raw[b].fileId, i]));
    const bones = order.map((b, i) => {
        const parent = idToIndex ? idToIndex.get(raw[b].parent) : raw[b].parent;
        // 父索引必须在范围内（越界按根处理，避免建树时成环）
        return { index: i, parent: parent !== undefined && parent >= 0 && parent < raw.length ? parent : -1, bind: raw[b].bind };
    });
    return { bones, status: bones.length === boneCount ? 'ok' : 'failed', idToIndex };
}
/** 动画头的轨数与轨表定位：文档化口径与夹具口径差一个 u32 ⇒ 只接受「轨表自洽」的那个。 */
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
/** MDLA：magic(9) + u32 段尾 + u32 动画数；每动画头 + 35B 填充 + 每轨 boneId/trackBytes/36B 关键帧。 */
function parseAnimations(buf, dv, boneCount, idToIndex) {
    const at = indexOfAscii(buf, 'MDLA');
    if (at < 0)
        return { animations: [], status: 'absent' };
    if (at + 17 > buf.length)
        return { animations: [], status: 'failed' };
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
            const rawBoneId = dv.getUint32(q, true);
            const trackBytes = dv.getUint32(q + 4, true);
            q += 8;
            const boneId = idToIndex ? (idToIndex.get(rawBoneId) ?? -1) : rawBoneId;
            // 轨自洽：36B 关键帧整数倍、不越界、boneId 在骨数内（boneCount 为 0 时不校验，交由消费方）
            if (trackBytes === 0 || trackBytes % KEYFRAME_BYTES !== 0 || q + trackBytes > buf.length) {
                ok = false;
                break;
            }
            if (boneCount > 0 && (boneId < 0 || boneId >= boneCount)) {
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
    // 声明了几个就必须完整解出几个；否则是「段在但坏了」，不能静默当成「无动画」
    return { animations: out, status: out.length === animCount ? 'ok' : 'failed' };
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
        const located = parseMesh(buf, dv, meshLimit);
        if ('error' in located) {
            return located.info
                ? { ok: false, error: located.error, strideInfo: located.info }
                : { ok: false, error: located.error };
        }
        const boneTable = parseBones(buf, dv);
        const anim = parseAnimations(buf, dv, boneTable.bones.length, boneTable.idToIndex);
        return {
            ok: true,
            puppet: {
                version,
                mesh: located.mesh,
                bones: boneTable.bones,
                animations: anim.animations,
                segments: { mdls: boneTable.status, mdla: anim.status },
                boneIdMapping: boneTable.idToIndex ? 'remapped' : 'identity',
            },
        };
    }
    catch {
        // 越界读取等异常一律收成结构化错误（契约：畸形输入不抛）
        return { ok: false, error: 'malformed' };
    }
}
