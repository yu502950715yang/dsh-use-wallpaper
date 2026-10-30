const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_BACKOFF_MS = 10_000;
const FAILURES_BEFORE_BACKOFF = 3;
const DIFF_KEYS = [
    'available',
    'reason',
    'appId',
    'contentType',
    'playback',
    'title',
    'artist',
    'album',
    'hasThumbnail',
    'thumbnailRev',
];
export function mediaUrl(pageTitle) {
    return '/wallpapers/now-playing?title=' + encodeURIComponent(pageTitle);
}
/** 返回变化的键；首次（prev=null）视为全变化。一律按 !== 判，thumbnailRev 回退也算变化。 */
export function diffSnapshot(prev, next) {
    if (!prev)
        return [...DIFF_KEYS];
    return DIFF_KEYS.filter((key) => prev[key] !== next[key]);
}
export function createMediaInput(opts) {
    const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    const fetchImpl = opts.fetchImpl ?? ((url) => fetch(url));
    const pageTitle = opts.pageTitle ?? (() => (typeof document === 'undefined' ? '' : document.title));
    const setIntervalImpl = opts.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
    const clearIntervalImpl = opts.clearIntervalImpl ?? ((handle) => { clearInterval(handle); });
    let running = false;
    let paused = false;
    let disposed = false;
    let timer = null;
    let currentIntervalMs = intervalMs;
    let failures = 0;
    let inflight = false;
    let prev = null;
    // stop() 递增：丢弃停机后才到的旧响应，避免它写回 prev 让「关→开」首帧不再重放。
    let stopSeq = 0;
    const targetIntervalMs = () => (failures >= FAILURES_BEFORE_BACKOFF ? backoffMs : intervalMs);
    const stopTimer = () => {
        if (timer === null)
            return;
        clearIntervalImpl(timer);
        timer = null;
    };
    // 仅在运行中且间隔真的变化时重建定时器（退避↔常规），避免重复挖掉刚设的 interval。
    const armTimer = (ms) => {
        if (disposed || !running || paused)
            return;
        if (timer !== null && currentIntervalMs === ms)
            return;
        stopTimer();
        currentIntervalMs = ms;
        timer = setIntervalImpl(() => {
            if (running && !paused && !disposed)
                void poll();
        }, ms);
    };
    const poll = async () => {
        if (disposed || paused || inflight)
            return;
        const seq = stopSeq;
        inflight = true;
        try {
            const resp = await fetchImpl(mediaUrl(pageTitle()));
            if (!resp.ok)
                throw new Error('now-playing http ' + (resp.status ?? 'unknown'));
            const next = await resp.json();
            if (disposed || paused || seq !== stopSeq)
                return;
            failures = 0;
            if (diffSnapshot(prev, next).length > 0) {
                const old = prev;
                prev = next;
                // 回调异常**不是网络失败**：不得计入 failures/触发退避，否则「渲染侧一次抛错」会把轮询打进 10s 退避。
                try {
                    opts.onSnapshot(next, old);
                }
                catch {
                    // 单个消费方异常只丢该次通知
                }
            }
            armTimer(intervalMs);
        }
        catch (error) {
            if (disposed || seq !== stopSeq)
                return;
            failures += 1;
            try {
                opts.onError?.(error);
            }
            catch {
                // onError 自身异常不外抛
            }
            if (failures >= FAILURES_BEFORE_BACKOFF)
                armTimer(backoffMs);
        }
        finally {
            inflight = false;
        }
    };
    return {
        start() {
            if (disposed || running)
                return;
            running = true;
            armTimer(targetIntervalMs());
            void poll();
        },
        stop() {
            running = false;
            stopTimer();
            // 清 prev：重新 start 后首个快照必须按「首帧」重放（关→开时曲目没变也要重派事件）。
            prev = null;
            stopSeq += 1;
        },
        setPaused(value) {
            if (disposed || value === paused)
                return;
            paused = value;
            if (value) {
                stopTimer();
            }
            else if (running) {
                armTimer(targetIntervalMs());
                void poll();
            }
        },
        async pollNow() {
            await poll();
        },
        isRunning() {
            return running && !paused && !disposed;
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            running = false;
            stopTimer();
        },
    };
}
/** 中性调色板：无封面/未实现主色提取时的统一颜色（黑色系 + 白字，不影响任何图层可见性）。 */
export const NEUTRAL_MEDIA_PALETTE = {
    primary: [0, 0, 0], secondary: [0, 0, 0], tertiary: [0, 0, 0],
    text: [1, 1, 1], highContrast: [1, 1, 1],
};
/** 快照 diff → 事件顺序：status（仅首次）→ playback → properties → thumbnail。
 *  停止/不可用只派 playback('stopped')：媒体层已被脚本隐藏，再派空属性只会白重绘文本层。 */
export function applyMediaSnapshot(prev, next, sink) {
    const changed = diffSnapshot(prev, next);
    if (changed.length === 0)
        return;
    if (prev === null)
        sink.status(true); // 首次快照 = 媒体集成已启用
    if (!next.available || (changed.includes('playback') && next.playback === 'stopped')) {
        sink.playback('stopped');
        return;
    }
    if (changed.includes('playback'))
        sink.playback(next.playback);
    // contentType 也在 diff 键里（音乐↔视频切换的脚本分支），事件侧必须一并重派。
    if (changed.includes('title') || changed.includes('artist') || changed.includes('album')
        || changed.includes('contentType')) {
        sink.properties({ title: next.title, artist: next.artist, album: next.album, contentType: next.contentType });
    }
    if (changed.includes('thumbnailRev') || changed.includes('hasThumbnail')) {
        sink.thumbnail({ hasThumbnail: next.hasThumbnail, rev: next.thumbnailRev, palette: NEUTRAL_MEDIA_PALETTE });
    }
}
const MEDIA_SCRIPT_RE = /mediaPlaybackChanged|mediaStatusChanged|mediaPropertiesChanged|mediaThumbnailChanged|MediaPlaybackEvent/;
/** 场景是否声明了媒体事件脚本（visible/属性/text 三处）；没有则零轮询、零开销。 */
export function sceneNeedsMedia(desc) {
    for (const obj of desc.objects) {
        if (typeof obj.visible?.script === 'string' && obj.visible.script && MEDIA_SCRIPT_RE.test(obj.visible.script)) {
            return true;
        }
        for (const e of obj.objectScripts ?? []) {
            if (typeof e?.script === 'string' && e.script && MEDIA_SCRIPT_RE.test(e.script))
                return true;
        }
        if (obj.kind === 'text' && typeof obj.script === 'string' && obj.script && MEDIA_SCRIPT_RE.test(obj.script)) {
            return true;
        }
    }
    return false;
}
