const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_BACKOFF_MS = 10_000;
const FAILURES_BEFORE_BACKOFF = 3;
const DIFF_KEYS = [
    'available',
    'reason',
    'appId',
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
        inflight = true;
        try {
            const resp = await fetchImpl(mediaUrl(pageTitle()));
            if (!resp.ok)
                throw new Error('now-playing http ' + (resp.status ?? 'unknown'));
            const next = await resp.json();
            if (disposed || paused)
                return;
            failures = 0;
            if (diffSnapshot(prev, next).length > 0) {
                const old = prev;
                prev = next;
                opts.onSnapshot(next, old);
            }
            armTimer(intervalMs);
        }
        catch (error) {
            if (disposed)
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
