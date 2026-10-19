import { statSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { getPkgReader } from './routes.js';
// 只在 .tex 头 204B 内找合法 mp4 box（ftyp）；视频纹理标志 = flags bit5（AGENT §5.23）。
export function findEmbeddedMp4(entry) {
    if (entry.length < 64)
        return null;
    const head = Buffer.from(entry.subarray(0, Math.min(204, entry.length)));
    if (Buffer.from(head.subarray(0, 9)).toString('ascii') !== 'TEXV0005\0')
        return null;
    const flags = head.readUInt32LE(22);
    if ((flags & 32) === 0)
        return null;
    const idx = head.indexOf('ftyp');
    if (idx < 8)
        return null;
    const boxStart = idx - 4;
    const size = head.readUInt32BE(boxStart);
    if (size < 16 || boxStart + size > entry.length)
        return null;
    return { offset: boxStart };
}
// 探测结果按 (pkgPath, mtime) 缓存，video-probe 与 embedded-video 共用，避免重复扫包。
const PROBE_CACHE = new Map();
const PROBE_CACHE_MAX = 32;
function scanPkg(pkgPath) {
    let reader;
    let entries;
    try {
        reader = getPkgReader(pkgPath);
        entries = reader.listEntries();
    }
    catch {
        return null; // pkg 缺失/损坏：按无内嵌视频处理（探测必须无副作用）
    }
    for (const e of entries) {
        if (!e.name.toLowerCase().endsWith('.tex'))
            continue;
        let data;
        try {
            data = reader.readEntry(e.name);
        }
        catch {
            continue;
        }
        if (!data)
            continue;
        const found = findEmbeddedMp4(data);
        if (found)
            return { entryName: e.name, offset: found.offset };
    }
    return null;
}
function findCached(pkgPath) {
    let mtimeMs = 0;
    try {
        mtimeMs = statSync(pkgPath).mtimeMs;
    }
    catch {
        // 文件不可读：mtime 归零，不命中旧缓存
    }
    const cached = PROBE_CACHE.get(pkgPath);
    if (cached && cached.mtimeMs === mtimeMs)
        return cached.hit;
    const hit = scanPkg(pkgPath);
    PROBE_CACHE.set(pkgPath, { mtimeMs, hit });
    if (PROBE_CACHE.size > PROBE_CACHE_MAX) {
        const oldest = PROBE_CACHE.keys().next().value;
        if (oldest !== undefined)
            PROBE_CACHE.delete(oldest);
    }
    return hit;
}
/** pkg 内是否有可播放的内嵌 MP4（视频纹理）。 */
export function probeEmbeddedMp4(pkgPath) {
    return findCached(pkgPath) !== null;
}
/** 取内嵌 MP4 原始字节（从 mp4 首个 box 起）；无则 null。 */
export function extractEmbeddedMp4(pkgPath) {
    const hit = findCached(pkgPath);
    if (!hit)
        return null;
    try {
        const entry = getPkgReader(pkgPath).readEntry(hit.entryName);
        if (!entry)
            return null;
        return { entryName: hit.entryName, bytes: entry.subarray(hit.offset) };
    }
    catch {
        return null;
    }
}
