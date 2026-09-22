// WE 动画的 fps 只存在于脚本内嵌 config 里（scene.pkg 内无动画数据，spec §6.2）。
// 脚本首行是几百 KB 的字面量，不做整体 JSON.parse：按对象字面量就近配对 "name" 与 "fps"。
// 必须按「同一字面量」配对 —— 相邻条目的 name 可能比自己的 name 更靠近自己的 fps。
const NAME_RE = /"name"\s*:\s*"([^"]{1,200})"/g;
const FPS_RE = /"fps"\s*:\s*(-?\d+(?:\.\d+)?)/g;
/** 跨字面量兜底配对的半径（字符）。 */
const PAIR_RADIUS = 400;
/** 从脚本源码提取 动画名 → fps。提取不到的动画由调用方兜底。 */
export function extractAnimFps(scriptSource) {
    const out = new Map();
    if (typeof scriptSource !== 'string' || scriptSource.length === 0)
        return out;
    const used = new Set(); // 已归属某个字面量的 fps 位置（外层字面量不再重复认领）
    const stack = []; // 尚未闭合的 `{` 位置 = 当前字面量的祖先链
    let inStr = false;
    let quote = '';
    for (let i = 0; i < scriptSource.length; i++) {
        const c = scriptSource[i];
        if (inStr) {
            // 跳过字符串内容：脚本里有大量字面量（含 base64），其中的花括号不是结构
            if (c === '\\')
                i++;
            else if (c === quote)
                inStr = false;
            continue;
        }
        // 注释必须先于引号处理：注释里的撇号（// don't）否则会吞掉余下全文的配对
        if (c === '/' && scriptSource[i + 1] === '/') {
            const nl = scriptSource.indexOf('\n', i);
            if (nl < 0)
                break;
            i = nl;
            continue;
        }
        if (c === '/' && scriptSource[i + 1] === '*') {
            const close = scriptSource.indexOf('*/', i + 2);
            if (close < 0)
                break;
            i = close + 1;
            continue;
        }
        if (c === '"' || c === "'") {
            inStr = true;
            quote = c;
        }
        else if (c === '{') {
            stack.push(i);
        }
        else if (c === '}' && stack.length > 0) {
            const start = stack.pop();
            pairLiteral(scriptSource, start, i + 1, stack, used, out);
        }
    }
    return out;
}
/** 在刚闭合的字面量内配对 name/fps；不含 name 时向外层字面量做半径内兜底。 */
function pairLiteral(src, start, end, ancestors, used, out) {
    const text = src.slice(start, end);
    for (const m of text.matchAll(FPS_RE)) {
        const localAt = m.index ?? 0;
        const abs = start + localAt;
        if (used.has(abs))
            continue;
        used.add(abs);
        const v = Number(m[1]);
        if (!Number.isFinite(v) || v <= 0)
            continue; // 非法 fps 直接丢弃
        const name = nearestName(src, start, end, localAt) ?? outerName(src, ancestors[ancestors.length - 1], abs);
        if (name && !out.has(name))
            out.set(name, v);
    }
}
/** 区间内离 `at` 最近的 name 值。 */
function nearestName(src, from, to, at) {
    let best = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const m of src.slice(from, to).matchAll(NAME_RE)) {
        const d = Math.abs((m.index ?? 0) - at);
        if (d < bestDist) {
            bestDist = d;
            best = m[1];
        }
    }
    return best;
}
/** 兜底：在最近的外层字面量内、fps 前后 PAIR_RADIUS 字符范围内找 name。 */
function outerName(src, outerStart, abs) {
    if (outerStart === undefined)
        return null;
    const from = Math.max(outerStart, abs - PAIR_RADIUS);
    const to = Math.min(src.length, abs + PAIR_RADIUS);
    let best = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const m of src.slice(from, to).matchAll(NAME_RE)) {
        const d = Math.abs(from + (m.index ?? 0) - abs);
        if (d < bestDist) {
            bestDist = d;
            best = m[1];
        }
    }
    return best;
}
export class AnimRegistry {
    byKey = new Map();
    fpsTable;
    defaultFps;
    /** 已警告过的动画名（避免每帧刷屏）。 */
    warned = new Set();
    constructor(fpsTable, defaultFps = 60) {
        this.fpsTable = fpsTable;
        this.defaultFps = Number.isFinite(defaultFps) && defaultFps > 0 ? defaultFps : 60;
    }
    /** 取（或创建）某动画的播放器。同一 (layerKey,name) 恒返回同一对象。 */
    get(layerKey, name) {
        const key = `${layerKey}|${name}`;
        const hit = this.byKey.get(key);
        if (hit)
            return hit.playback;
        const fps = this.fpsOf(name);
        const st = { frame: 0, fps, playing: false, playback: null };
        st.playback = {
            play: () => { st.playing = true; },
            pause: () => { st.playing = false; },
            stop: () => { st.playing = false; st.frame = 0; },
            isPlaying: () => st.playing,
            setFrame: (v) => { st.frame = Number.isFinite(v) ? v : 0; },
            getFrame: () => st.frame,
        };
        this.byKey.set(key, st);
        return st.playback;
    }
    /** 每帧推进所有在播播放器：frame += fps × dt。 */
    tick(dt) {
        if (!Number.isFinite(dt) || dt <= 0)
            return;
        for (const st of this.byKey.values()) {
            if (st.playing)
                st.frame += st.fps * dt;
        }
    }
    playingCount() {
        let n = 0;
        for (const st of this.byKey.values())
            if (st.playing)
                n++;
        return n;
    }
    /** 本动画实际使用的 fps（诊断用）。 */
    fpsOf(name) {
        return this.fpsTable.get(name) ?? this.defaultFps;
    }
}
