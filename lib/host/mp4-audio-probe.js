import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { Buffer } from 'node:buffer';
// moov 整段读入内存的上限（视频文件本身可能几十 MB，不整文件读入）。
const MOOV_MAX = 64 * 1024 * 1024;
// 解析 [start, end) 内连续的 box；结构非法返回 null（调用方按「无法判断」处理）。
function parseBoxes(buf, start, end) {
    const boxes = [];
    let off = start;
    while (off < end) {
        if (end - off < 8)
            return null;
        let size = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        let headerSize = 8;
        if (size === 1) {
            if (end - off < 16)
                return null;
            size = buf.readUInt32BE(off + 8) * 0x100000000 + buf.readUInt32BE(off + 12);
            headerSize = 16;
        }
        else if (size === 0) {
            size = end - off; // size=0：延伸到所在区间末尾
        }
        if (size < headerSize || off + size > end)
            return null;
        boxes.push({ type, end: off + size, contentStart: off + headerSize });
        off += size;
    }
    return boxes;
}
// moov 载荷内按 trak → mdia → hdlr 找 soun 轨（handler_type 在 hdlr 载荷 +8 处）。
function moovHasSoundTrak(moov) {
    const moovBoxes = parseBoxes(moov, 0, moov.length);
    if (!moovBoxes)
        return null;
    for (const trak of moovBoxes) {
        if (trak.type !== 'trak')
            continue;
        const trakBoxes = parseBoxes(moov, trak.contentStart, trak.end);
        if (!trakBoxes)
            return null;
        for (const mdia of trakBoxes) {
            if (mdia.type !== 'mdia')
                continue;
            const mdiaBoxes = parseBoxes(moov, mdia.contentStart, mdia.end);
            if (!mdiaBoxes)
                return null;
            for (const hdlr of mdiaBoxes) {
                if (hdlr.type !== 'hdlr')
                    continue;
                if (hdlr.end - hdlr.contentStart < 12)
                    return null; // 至少要能读到 handler_type
                if (moov.toString('latin1', hdlr.contentStart + 8, hdlr.contentStart + 12) === 'soun')
                    return true;
            }
        }
    }
    return false;
}
// 只读 offset 处的 box 头，按 size 跳转，不碰 mdat 数据。
function readTopBox(fd, offset, fileSize) {
    const head = Buffer.allocUnsafe(16);
    const n = readSync(fd, head, 0, 16, offset);
    if (n < 8)
        return null;
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let headerSize = 8;
    if (size === 1) {
        if (n < 16)
            return null;
        size = head.readUInt32BE(8) * 0x100000000 + head.readUInt32BE(12);
        headerSize = 16;
    }
    else if (size === 0) {
        size = fileSize - offset; // size=0：延伸到文件末尾
    }
    if (size < headerSize || offset + size > fileSize)
        return null;
    return { type, size, headerSize };
}
function probeOpened(fd, fileSize) {
    let offset = 0;
    while (offset < fileSize) {
        const box = readTopBox(fd, offset, fileSize);
        if (!box)
            return null;
        if (box.type === 'moov') {
            const size = box.size - box.headerSize;
            if (size > MOOV_MAX)
                return null;
            const moov = Buffer.alloc(size);
            if (readSync(fd, moov, 0, size, offset + box.headerSize) !== size)
                return null;
            return moovHasSoundTrak(moov);
        }
        offset += box.size;
    }
    return null; // 没有 moov：不是可解析的 mp4
}
/** 探测 mp4 是否含音轨：true/false 确定，null = 文件缺失/结构非法等无法判断。 */
export function probeMp4HasAudio(filePath) {
    let fd = -1;
    try {
        const st = statSync(filePath);
        if (!st.isFile())
            return null;
        fd = openSync(filePath, 'r');
        return probeOpened(fd, st.size);
    }
    catch {
        return null; // 读取异常一律按无法判断
    }
    finally {
        if (fd >= 0) {
            try {
                closeSync(fd);
            }
            catch { /* 关闭失败不影响探测结论 */ }
        }
    }
}
