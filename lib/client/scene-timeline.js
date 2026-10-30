import { resolveWorldTransforms } from './scene-graph.js';
// ── 时间线动画解析与求值（纯函数）：scene.json 的 { animation: { c0,c1,c2, options, relative } } 块 ──
const HANDLE_KEYS = ['c0', 'c1', 'c2'];
const PROPERTY_CHANNELS = { alpha: 1, origin: 3, scale: 3, angles: 3, color: 3 };
// 帧号/值只收有限数或数字字符串；其余（缺失/null/布尔/非数字串）⇒ null。
function asNumber(raw) {
    if (typeof raw === 'number')
        return Number.isFinite(raw) ? raw : null;
    if (typeof raw === 'string' && raw.trim() !== '') {
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}
function asRecord(raw) {
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}
// 贝塞尔手柄：x/y 必须是有限数，enabled 必须显式为 true 才参与曲线；畸形 ⇒ undefined（按无手柄处理）。
function parseHandle(raw) {
    const o = asRecord(raw);
    if (!o)
        return undefined;
    const x = asNumber(o.x);
    const y = asNumber(o.y);
    if (x === null || y === null)
        return undefined;
    return { x, y, enabled: o.enabled === true };
}
// 单通道关键帧：任一帧非法 ⇒ 整通道 null；空数组同样 null。按 frame 升序（同帧保持原相对顺序）。
function parseKeyframes(raw) {
    if (!Array.isArray(raw))
        return null;
    const out = [];
    for (const item of raw) {
        const o = asRecord(item);
        if (!o)
            return null;
        const frame = asNumber(o.frame);
        const value = asNumber(o.value);
        if (frame === null || value === null)
            return null;
        const keyframe = { frame, value };
        const front = parseHandle(o.front);
        if (front)
            keyframe.front = front;
        const back = parseHandle(o.back);
        if (back)
            keyframe.back = back;
        out.push(keyframe);
    }
    if (out.length === 0)
        return null;
    out.sort((a, b) => a.frame - b.frame);
    return out;
}
// options 里的联动键：{ key: 'origin' } / [{ key: 'alpha' }]；非字符串/缺失 ⇒ ''。
function keyOf(raw) {
    const o = asRecord(raw);
    return typeof o?.key === 'string' ? o.key : '';
}
export function parseTimelineAnimation(property, raw) {
    const o = asRecord(raw);
    if (!o)
        return null;
    const channels = [];
    for (let i = 0; i < PROPERTY_CHANNELS[property]; i++) {
        const parsed = parseKeyframes(o[HANDLE_KEYS[i]]);
        if (!parsed) {
            // c0 缺失/空 ⇒ 该属性不走时间线（回退静态 value）；i>0 缺通道 ⇒ 空数组（采样按 0 偏移）。
            if (i === 0)
                return null;
            channels.push([]);
            continue;
        }
        channels.push(parsed);
    }
    const options = asRecord(o.options) ?? {};
    const fpsRaw = asNumber(options.fps);
    const fps = fpsRaw !== null && fpsRaw > 0 ? fpsRaw : 60;
    const lengthRaw = asNumber(options.length);
    const frameCount = lengthRaw !== null && lengthRaw > 0 ? Math.floor(lengthRaw) : 60;
    const modeRaw = options.mode;
    const mode = modeRaw === 'loop' || modeRaw === 'mirror' ? modeRaw : 'single';
    const parentKey = keyOf(options.parent);
    const children = Array.isArray(options.children) ? options.children.map(keyOf).filter(Boolean) : [];
    return {
        property,
        channels,
        fps,
        frameCount,
        duration: frameCount / fps,
        mode,
        startPaused: options.startpaused === true,
        relative: o.relative === true,
        wrapLoop: options.wraploop === true,
        name: typeof options.name === 'string' ? options.name : '',
        parentKey: (parentKey || null),
        childrenKeys: children,
    };
}
function bezier(p0, p1, p2, p3, t) {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}
// handle 的 x/y 归一化到段长/值差；非有限值（畸形数据）按 0（无偏移）处理。
function handleCoord(handle, axis) {
    const v = handle?.[axis];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
// 单通道采样：端点精确；区间外钳制；段内 handles 两关 ⇒ 线性，否则三次贝塞尔（x(t)=frame 二分 24 次）。
// 帧号非有限（脚本 setFrame(NaN) 等）按 0 处理，保证采样结果永远有限。
export function sampleTimelineChannel(channel, frame) {
    if (channel.length === 0)
        return 0;
    if (channel.length === 1)
        return channel[0].value;
    if (!Number.isFinite(frame))
        frame = 0;
    const first = channel[0];
    if (frame <= first.frame)
        return first.value;
    const last = channel[channel.length - 1];
    if (frame >= last.frame)
        return last.value;
    let i = 0;
    while (i + 1 < channel.length && channel[i + 1].frame <= frame)
        i += 1;
    const a = channel[i];
    if (frame === a.frame)
        return a.value; // 中间关键帧也精确（避免贝塞尔求根的浮点误差）
    const b = channel[i + 1];
    const span = b.frame - a.frame;
    if (span <= 0)
        return b.value;
    const tFrame = (frame - a.frame) / span;
    const frontOn = a.front?.enabled === true;
    const backOn = b.back?.enabled === true;
    if (!frontOn && !backOn)
        return a.value + (b.value - a.value) * tFrame;
    // 手柄偏移量 = 归一化坐标 × 段长/值差；段起点用 front（出向），段终点用 back（入向）。
    const valueSpan = b.value - a.value;
    const c1x = a.frame + (frontOn ? handleCoord(a.front, 'x') : 0) * span;
    const c1y = a.value + (frontOn ? handleCoord(a.front, 'y') : 0) * valueSpan;
    const c2x = b.frame + (backOn ? handleCoord(b.back, 'x') : 0) * span;
    const c2y = b.value + (backOn ? handleCoord(b.back, 'y') : 0) * valueSpan;
    let lo = 0;
    let hi = 1;
    for (let n = 0; n < 24; n++) {
        const mid = (lo + hi) / 2;
        if (bezier(a.frame, c1x, c2x, b.frame, mid) < frame)
            lo = mid;
        else
            hi = mid;
    }
    return bezier(a.value, c1y, c2y, b.value, (lo + hi) / 2);
}
/** 逐通道采样；空通道（缺 c1/c2）给 0 偏移。 */
export function sampleTimeline(anim, frame) {
    return anim.channels.map((channel) => sampleTimelineChannel(channel, frame));
}
const VEC3_ZERO = [0, 0, 0];
const VEC3_ONE = [1, 1, 1];
const DEG2RAD = Math.PI / 180;
function isVec3(v) {
    return Array.isArray(v) && v.length >= 3
        && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}
function clamp01(v) {
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}
const stateKey = (objectId, property) => `${objectId}|${property}`;
/** 某对象的本地变换（状态表优先，缺省回退装配期快照）；角度从脚本通道的「度」转回弧度。 */
function localNodeOf(obj, localTransforms, readLocal) {
    const base = localTransforms.get(obj.id);
    const state = readLocal(obj.id);
    return {
        id: obj.id,
        parent: obj.parent,
        origin: isVec3(state.origin) ? [...state.origin] : base ? [...base.origin] : [...VEC3_ZERO],
        scale: isVec3(state.scale) ? [...state.scale] : base ? [...base.scale] : [...VEC3_ONE],
        angles: isVec3(state.angles)
            ? [state.angles[0] * DEG2RAD, state.angles[1] * DEG2RAD, state.angles[2] * DEG2RAD]
            : base ? [...base.angles] : [...VEC3_ZERO],
    };
}
// 显式 parent 优先；仅写了父的 children 时也建立关系；自引用/悬空/环一律断开（visited 集合）。
function resolveParentLinks(anims) {
    const parentOf = new Map();
    for (const [prop, anim] of anims) {
        const explicit = anim.parentKey;
        parentOf.set(prop, explicit && explicit !== prop && anims.has(explicit) ? explicit : null);
    }
    for (const [prop] of anims) {
        if (parentOf.get(prop))
            continue;
        for (const [other, candidate] of anims) {
            if (other !== prop && candidate.childrenKeys.includes(prop)) {
                parentOf.set(prop, other);
                break;
            }
        }
    }
    for (const prop of anims.keys()) {
        const seen = new Set();
        let cur = prop;
        while (cur) {
            if (seen.has(cur)) {
                parentOf.set(prop, null); // 该起点落在环上 ⇒ 断开这一条，环必破
                break;
            }
            seen.add(cur);
            cur = parentOf.get(cur) ?? null;
        }
    }
    return parentOf;
}
export function createTimelineRuntime(opts) {
    const animsOf = new Map();
    for (const obj of opts.desc.objects) {
        if (!obj.animations)
            continue;
        const map = new Map();
        for (const [prop, anim] of Object.entries(obj.animations)) {
            if (anim)
                map.set(prop, anim);
        }
        if (map.size > 0)
            animsOf.set(obj.id, map);
    }
    const ordered = [];
    const entriesByKey = new Map();
    const byName = new Map();
    const playbacks = new Map();
    for (const [objectId, anims] of animsOf) {
        const parentOf = resolveParentLinks(anims);
        // 深度 = 父链长度（父动画先推进；环已断开，最多 anims.size 层）。
        const depthOf = (prop) => {
            let depth = 0;
            let cur = parentOf.get(prop) ?? null;
            const guard = new Set();
            while (cur && depth <= anims.size) {
                if (guard.has(cur))
                    break;
                guard.add(cur);
                depth += 1;
                cur = parentOf.get(cur) ?? null;
            }
            return depth;
        };
        for (const [property, anim] of anims) {
            const key = stateKey(objectId, property);
            const entry = {
                objectId,
                property,
                anim,
                state: { phase: 0, frame: 0, playing: false, rate: 1, finished: false },
                key,
                parent: parentOf.get(property) ?? null,
                depth: depthOf(property),
            };
            ordered.push(entry);
            entriesByKey.set(key, entry);
            if (anim.name)
                byName.set(`${objectId}|${anim.name}`, entry);
        }
    }
    ordered.sort((a, b) => a.depth - b.depth);
    const animatedIds = [...animsOf.keys()];
    // 后代索引：动画对象的子树都要重算世界变换。
    const children = new Map();
    for (const node of opts.desc.objects) {
        if (node.parent === undefined)
            continue;
        const list = children.get(node.parent) ?? [];
        list.push(node.id);
        children.set(node.parent, list);
    }
    const affected = new Set();
    const addSubtree = (id) => {
        if (affected.has(id))
            return;
        affected.add(id);
        for (const child of children.get(id) ?? [])
            addSubtree(child);
    };
    for (const id of animatedIds)
        addSubtree(id);
    let disposed = false;
    const playbackOf = (entry) => {
        const cached = playbacks.get(entry.key);
        if (cached)
            return cached;
        const { anim, state } = entry;
        const playback = {
            play() {
                if (disposed)
                    return;
                // 播完再 play = 从头重播（真实素材靠 media 事件反复播放落回 1）。
                if (state.finished) {
                    state.phase = 0;
                    state.frame = 0;
                }
                state.playing = true;
                state.finished = false;
            },
            pause() { state.playing = false; },
            stop() { state.playing = false; state.phase = 0; state.frame = 0; state.finished = false; },
            isPlaying: () => state.playing && !state.finished,
            setFrame(v) {
                if (!Number.isFinite(v))
                    return; // NaN 帧号不写（否则采样/世界变换全变 NaN）
                const last = anim.frameCount > 0 ? anim.frameCount : 0;
                state.frame = Math.max(0, Math.min(last, v));
                state.phase = state.frame;
                state.finished = false;
            },
            getFrame: () => state.frame,
            get fps() { return anim.fps; },
            get frameCount() { return anim.frameCount; },
            get duration() { return anim.duration; },
            get name() { return anim.name; },
            get rate() { return state.rate; },
            set rate(v) { state.rate = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1; },
        };
        playbacks.set(entry.key, playback);
        return playback;
    };
    const source = {
        getByProperty(objectId, property, name) {
            const anim = animsOf.get(objectId)?.get(property);
            if (!anim || (name && anim.name !== name))
                return null;
            const entry = entriesByKey.get(stateKey(objectId, property));
            return entry ? playbackOf(entry) : null;
        },
        getByName(objectId, name) {
            const entry = byName.get(`${objectId}|${name}`);
            return entry ? playbackOf(entry) : null;
        },
    };
    /** 逐对象采样 → LayerWrite（绝对本地值；relative 叠加装配期静态值）。 */
    const sampleWrites = () => {
        const out = new Map();
        for (const [objectId, anims] of animsOf) {
            const base = opts.localTransforms.get(objectId);
            const patch = {};
            let has = false;
            for (const [property, anim] of anims) {
                const entry = entriesByKey.get(stateKey(objectId, property));
                if (!entry)
                    continue;
                const frame = Number.isFinite(entry.state.frame) ? entry.state.frame : 0;
                const values = sampleTimeline(anim, frame);
                if (property === 'alpha') {
                    patch.alpha = clamp01(values[0] ?? 0);
                    has = true;
                }
                else if (property === 'color') {
                    // 真实库无 color 时间线（Task 9 扫描）；沿用 brief 的 0-1 / 0-255 双语义 + 有限性钳制。
                    const max = Math.max(...values);
                    const to255 = max <= 1 ? 255 : 1;
                    patch.color = [
                        Math.max(0, Math.min(255, (values[0] ?? 0) * to255)),
                        Math.max(0, Math.min(255, (values[1] ?? 0) * to255)),
                        Math.max(0, Math.min(255, (values[2] ?? 0) * to255)),
                    ];
                    has = true;
                }
                else {
                    // 空通道（缺 c1/c2）= 该轴不用时间线 ⇒ 回退静态基值（不把缺失轴写成 0）。
                    const baseV = (base?.[property] ?? (property === 'scale' ? VEC3_ONE : VEC3_ZERO));
                    const v = [baseV[0], baseV[1], baseV[2]];
                    for (let i = 0; i < 3; i++) {
                        const channel = anim.channels[i];
                        if (!channel || channel.length === 0)
                            continue;
                        const sampled = sampleTimelineChannel(channel, frame);
                        v[i] = anim.relative ? baseV[i] + sampled : sampled;
                        if (!Number.isFinite(v[i]))
                            v[i] = baseV[i];
                    }
                    if (property === 'angles') {
                        // 状态表的角度是**度**（脚本通道口径，applyLayerState 负责转弧度）。
                        patch.angles = [v[0] / DEG2RAD, v[1] / DEG2RAD, v[2] / DEG2RAD];
                    }
                    else if (property === 'origin') {
                        patch.origin = v;
                    }
                    else {
                        patch.scale = v;
                    }
                    has = true;
                }
            }
            if (has)
                out.set(objectId, patch);
        }
        return out;
    };
    const syncWorld = () => {
        if (disposed || affected.size === 0)
            return;
        const nodes = opts.desc.objects.map((obj) => localNodeOf(obj, opts.localTransforms, opts.readLocal));
        const world = resolveWorldTransforms(nodes);
        for (const id of affected) {
            const wt = world.get(id);
            if (wt)
                opts.applyWorld(id, wt);
        }
    };
    const runtime = {
        ...source,
        advance(dt) {
            if (disposed)
                return;
            if (!Number.isFinite(dt) || dt <= 0)
                return;
            // WE 主循环口径：dt 钳 0.0001–0.25s，防切后台/卡顿后动画跳变。
            const step = Math.min(Math.max(dt, 0.0001), 0.25);
            for (const entry of ordered) {
                const state = entry.state;
                if (!state.playing || state.finished)
                    continue;
                const anim = entry.anim;
                if (!(anim.frameCount > 0)) {
                    state.frame = 0;
                    state.phase = 0;
                    state.finished = true;
                    state.playing = false;
                    continue;
                }
                let frame;
                if (entry.parent) {
                    const parentEntry = entriesByKey.get(stateKey(entry.objectId, entry.parent));
                    if (!parentEntry || !(parentEntry.anim.frameCount > 0) || !Number.isFinite(parentEntry.state.frame))
                        continue;
                    // 子帧 = 父帧 ×（子帧数 / 父帧数）
                    frame = (parentEntry.state.frame / parentEntry.anim.frameCount) * anim.frameCount;
                }
                else {
                    if (!(anim.fps > 0)) {
                        state.finished = true;
                        state.playing = false;
                        continue;
                    }
                    const delta = step * anim.fps * state.rate;
                    if (!Number.isFinite(delta))
                        continue;
                    state.phase = Number.isFinite(state.phase) ? state.phase + delta : 0;
                    frame = state.phase;
                }
                if (anim.mode === 'loop') {
                    frame %= anim.frameCount;
                    if (frame < 0)
                        frame += anim.frameCount;
                }
                else if (anim.mode === 'mirror') {
                    // 用单调相位反射：保留方向，不会在同一半区反复反射（brief 的 frame 取模写法会丢方向）。
                    const period = anim.frameCount * 2;
                    let cycle = frame % period;
                    if (cycle < 0)
                        cycle += period;
                    frame = cycle <= anim.frameCount ? cycle : period - cycle;
                }
                else if (frame >= anim.frameCount) {
                    frame = anim.frameCount;
                    state.finished = true;
                    state.playing = false;
                }
                if (!Number.isFinite(frame))
                    frame = 0;
                state.frame = frame;
            }
        },
        sampleAndWrite() {
            if (disposed)
                return;
            opts.applyLocal(sampleWrites());
        },
        applyInitial() {
            if (disposed)
                return;
            for (const entry of ordered) {
                entry.state.phase = 0;
                entry.state.frame = 0;
                entry.state.playing = !entry.anim.startPaused;
                entry.state.rate = 1;
                entry.state.finished = false;
            }
            runtime.sampleAndWrite();
            syncWorld();
        },
        syncWorld,
        dispose() {
            if (disposed)
                return;
            disposed = true;
            ordered.length = 0;
            entriesByKey.clear();
            animsOf.clear();
            byName.clear();
            playbacks.clear();
        },
    };
    return runtime;
}
