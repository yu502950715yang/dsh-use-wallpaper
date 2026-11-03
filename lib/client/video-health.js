// 4K60 视频壁纸只读健康采样：fps / 丢帧 / 循环点停顿 / 事件状态，供设置面板与 __wallpaperEngine.videoHealth() 排查卡顿。
// 时钟与定时器可注入（node 下用手动推进的假 video 测）；DOM 字段读取对 jsdom 缺失字段容错。
const DEFAULT_SAMPLE_INTERVAL_MS = 1000;
const DEFAULT_TICK_INTERVAL_MS = 100;
const DEFAULT_MAX_LOOP_STALLS = 5;
// 循环点 = 上一拍在尾部 25% 段、本拍在头部 25% 段（中段来回拖动不算回绕）。
const LOOP_TAIL_RATIO = 0.75;
const LOOP_HEAD_RATIO = 0.25;
// waiting/stalled 事件在此窗口内仍算「卡顿」。
const STALL_WINDOW_MS = 5000;
const WATCHED_EVENTS = [
    'waiting',
    'stalled',
    'seeking',
    'seeked',
    'playing',
    'pause',
    'ended',
    'error',
];
/** 读数字字段：缺失 / NaN / Infinity 一律按 0（jsdom 的 duration 就是 NaN）。 */
function readNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
/** 读质量计数；无 getVideoPlaybackQuality（jsdom）或实现抛错 ⇒ null（调用方按 0 处理）。 */
function readFrameCounters(video) {
    try {
        if (typeof video.getVideoPlaybackQuality !== 'function')
            return null;
        const quality = video.getVideoPlaybackQuality();
        if (!quality)
            return null;
        return {
            totalFrames: readNumber(quality.totalVideoFrames),
            droppedFrames: readNumber(quality.droppedVideoFrames),
        };
    }
    catch {
        return null;
    }
}
/** 创建只读健康采样器；一次只跟一个 video（重复 attach 自动摘旧的）。 */
export function createVideoHealthMonitor(opts) {
    const now = opts?.now ?? (() => Date.now());
    const sampleIntervalMs = opts?.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    const tickIntervalMs = opts?.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    const maxLoopStalls = opts?.maxLoopStalls !== undefined && Number.isFinite(opts.maxLoopStalls)
        ? Math.max(0, Math.trunc(opts.maxLoopStalls))
        : DEFAULT_MAX_LOOP_STALLS;
    const timers = opts?.timers ?? {
        setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
        clearInterval: (id) => { globalThis.clearInterval(id); },
    };
    let video = null;
    let disposed = false;
    let sampleTimer = null;
    let tickTimer = null;
    const listeners = [];
    // 会话状态：最近事件、循环点历史、FPS/丢帧窗口与基线。
    let lastEvent = null;
    let lastEventAt = null;
    let lastStallEventAt = null;
    let loopStallsMs = [];
    let lastTime = null;
    let lastTickAt = null;
    let fps = 0;
    let droppedFrames = 0;
    let droppedRecent = 0;
    let totalFrames = 0;
    let prevCounters = null;
    let prevSampleAt = null;
    function reset() {
        lastEvent = null;
        lastEventAt = null;
        lastStallEventAt = null;
        loopStallsMs = [];
        lastTime = null;
        lastTickAt = null;
        fps = 0;
        droppedFrames = 0;
        droppedRecent = 0;
        totalFrames = 0;
        prevCounters = null;
        prevSampleAt = null;
    }
    function stopTimers() {
        if (tickTimer !== null) {
            timers.clearInterval(tickTimer);
            tickTimer = null;
        }
        if (sampleTimer !== null) {
            timers.clearInterval(sampleTimer);
            sampleTimer = null;
        }
    }
    function pushLoopStall(stallMs) {
        if (maxLoopStalls <= 0)
            return;
        loopStallsMs.push(Math.max(0, stallMs));
        if (loopStallsMs.length > maxLoopStalls)
            loopStallsMs.splice(0, loopStallsMs.length - maxLoopStalls);
    }
    // 循环点采样：只认「尾部跳回头部」，停顿取两次采样的墙钟差。
    function tick() {
        const el = video;
        if (!el)
            return;
        const at = now();
        const currentTime = readNumber(el.currentTime);
        const duration = readNumber(el.duration);
        const paused = el.paused === true;
        // 暂停 / 无 duration 时不判回绕：lastTickAt 置 null，恢复后的第一拍只重建基线。
        if (paused || duration <= 0) {
            lastTime = currentTime;
            lastTickAt = null;
            return;
        }
        if (lastTime !== null && lastTickAt !== null
            && lastTime > duration * LOOP_TAIL_RATIO
            && currentTime < duration * LOOP_HEAD_RATIO
            && currentTime < lastTime) {
            pushLoopStall(at - lastTickAt);
        }
        lastTime = currentTime;
        lastTickAt = at;
    }
    // FPS/丢帧采样：按两次采样的质量计数增量算，计数器回退（换源/重载）不产负值。
    function sample() {
        const el = video;
        if (!el)
            return;
        const at = now();
        const counters = readFrameCounters(el);
        if (!counters) {
            // 拿不到计数：窗口值记 0，累计值保留上次已知，回到有计数时重新建基线。
            fps = 0;
            droppedRecent = 0;
            prevCounters = null;
            prevSampleAt = null;
            return;
        }
        if (prevCounters !== null && prevSampleAt !== null) {
            const elapsedMs = at - prevSampleAt;
            const addedFrames = counters.totalFrames - prevCounters.totalFrames;
            const addedDropped = counters.droppedFrames - prevCounters.droppedFrames;
            fps = elapsedMs > 0 && addedFrames > 0 ? (addedFrames * 1000) / elapsedMs : 0;
            droppedRecent = addedDropped > 0 ? addedDropped : 0;
        }
        else {
            fps = 0;
            droppedRecent = 0; // 首拍只建基线
        }
        prevCounters = counters;
        prevSampleAt = at;
        droppedFrames = counters.droppedFrames;
        totalFrames = counters.totalFrames;
    }
    // 优先级：error 丢失 > 暂停 > 最近 5s 内出现过 waiting/stalled > ok。
    function stateOf(paused) {
        if (lastEvent === 'error')
            return 'lost';
        if (paused)
            return 'paused';
        if (lastStallEventAt !== null && now() - lastStallEventAt < STALL_WINDOW_MS)
            return 'stalled';
        return 'ok';
    }
    function detach() {
        stopTimers();
        const el = video;
        video = null;
        if (el) {
            for (const { type, handler } of listeners) {
                try {
                    el.removeEventListener(type, handler);
                }
                catch { /* 元素已失效：忽略 */ }
            }
        }
        listeners.length = 0;
        reset(); // 摘除后 snapshot() 返回 null；重新 attach 从零开始
    }
    function attach(el) {
        if (disposed)
            return;
        if (video)
            detach(); // 换视频：先摘旧监听与定时器
        video = el;
        reset();
        for (const type of WATCHED_EVENTS) {
            const handler = () => {
                lastEvent = type;
                lastEventAt = now();
                if (type === 'waiting' || type === 'stalled')
                    lastStallEventAt = lastEventAt;
            };
            try {
                if (typeof el.addEventListener === 'function') {
                    el.addEventListener(type, handler);
                    listeners.push({ type, handler });
                }
            }
            catch { /* 元素不可用：跳过该监听 */ }
        }
        // 先打一拍基线：fps 只算 attach 后的增量，首拍也不会把起播位置误判成循环回绕。
        tick();
        sample();
        tickTimer = timers.setInterval(tick, tickIntervalMs);
        sampleTimer = timers.setInterval(sample, sampleIntervalMs);
    }
    function dispose() {
        detach();
        disposed = true;
    }
    function snapshot() {
        const el = video;
        if (!el)
            return null;
        const paused = el.paused === true;
        return {
            fps,
            droppedFrames,
            droppedRecent,
            totalFrames,
            currentTime: readNumber(el.currentTime),
            duration: readNumber(el.duration),
            paused,
            videoWidth: readNumber(el.videoWidth),
            videoHeight: readNumber(el.videoHeight),
            loopStallsMs: [...loopStallsMs],
            lastEvent,
            lastEventAgoMs: lastEventAt === null ? null : Math.max(0, now() - lastEventAt),
            state: stateOf(paused),
            updatedAt: now(),
        };
    }
    return { attach, detach, snapshot, dispose };
}
