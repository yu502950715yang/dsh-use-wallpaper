// src/client/rotation.ts —— 自动轮播（v0.8）：轮播池 / 下一张选择 / 定时调度。
// 纯逻辑 + 可注入定时器（node 假定时器可测）；「什么时候该切」与「界面/设置怎么读」解耦，
// 由 index.ts 注入 getPool/getCurrentId/select/isPaused（见 createRotationScheduler）。
/** 设置面板可选的轮播间隔（与 host schema 的 1–30 分钟钳制一致）。 */
export const ROTATION_INTERVAL_OPTIONS = [
    { ms: 60000, label: '1 分钟' },
    { ms: 300000, label: '5 分钟' },
    { ms: 600000, label: '10 分钟' },
    { ms: 1800000, label: '30 分钟' },
];
/** 轮播顺序归一：只认 random，其余（含旧值/非法值）回 sequential。 */
export function normalizeRotationOrder(raw) {
    return raw === 'random' ? 'random' : 'sequential';
}
/** 间隔文案（分钟）：非法值回退 5 分钟（= DEFAULTS.rotationIntervalMs）。 */
export function formatRotationInterval(ms) {
    const value = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 300000;
    return `${Math.max(1, Math.round(value / 60000))} 分钟`;
}
/** 轮播池：收藏 ≥2 张时只用收藏（收藏即轻量播放列表）；否则全部非隐藏且可渲染的壁纸。 */
export function buildRotationPool(list, state) {
    const favorites = list.filter((w) => state.favorites.has(w.id));
    if (favorites.length >= 2)
        return favorites;
    return list.filter((w) => w.type !== 'unknown' && !state.hidden.has(w.id));
}
/** 下一张：空池/单张返回 null（1 张时不动）；顺序取 current 之后（环形），随机排除 current。 */
export function pickNext(pool, currentId, order, rand = Math.random) {
    if (pool.length < 2)
        return null;
    if (order === 'random') {
        const candidates = pool.filter((w) => w.id !== currentId);
        if (candidates.length === 0)
            return null;
        const index = Math.min(candidates.length - 1, Math.max(0, Math.floor(rand() * candidates.length)));
        return candidates[index] ?? null;
    }
    const current = pool.findIndex((w) => w.id === currentId);
    // current 不在池中（刚换过壁纸/被排除）⇒ 从第一张开始。
    return pool[(current + 1) % pool.length] ?? null;
}
const timerHost = (typeof window !== 'undefined' ? window : globalThis);
export function createRotationScheduler(deps) {
    const setTimer = deps.setTimeoutFn ?? ((fn, ms) => timerHost.setTimeout(fn, ms));
    const clearTimer = deps.clearTimeoutFn ?? ((handle) => timerHost.clearTimeout(handle));
    const now = deps.now ?? (() => Date.now());
    const cfg = {
        intervalMs: deps.intervalMs,
        order: deps.order ?? 'sequential',
    };
    // failed = 本会话跳过集（硬失败）；不落盘，用户手动选择时清空。
    const failed = new Set();
    let started = false;
    let paused = false;
    let timer = null;
    let dueAt = null;
    const clear = () => {
        if (timer !== null)
            clearTimer(timer);
        timer = null;
        dueAt = null;
    };
    const schedule = () => {
        clear();
        if (!started || paused)
            return; // 暂停时完全不占定时器（isPaused 只作 tick 期兜底）
        dueAt = now() + cfg.intervalMs;
        timer = setTimer(() => { void tick(); }, cfg.intervalMs);
    };
    // 取下一张：跳过本会话失败项（从失败项往后继续找）；全失败/不足 2 张返回 null（不动）。
    const choose = () => {
        const pool = deps.getPool();
        let next = pickNext(pool, deps.getCurrentId(), cfg.order);
        for (let i = 0; next && failed.has(next.id) && i < pool.length; i += 1) {
            next = pickNext(pool, next.id, cfg.order);
        }
        return next && !failed.has(next.id) ? next : null;
    };
    const tick = async () => {
        timer = null;
        dueAt = null;
        if (!started)
            return;
        if (paused || deps.isPaused()) {
            schedule();
            return;
        }
        try {
            const next = choose();
            if (next)
                await deps.select(next.id);
        }
        catch {
            // 单次切换失败不终止轮播（下一拍继续）
        }
        schedule();
    };
    return {
        start() {
            if (started)
                return;
            started = true;
            schedule();
        },
        stop() {
            started = false;
            clear();
        },
        setConfig(next) {
            const intervalChanged = next.intervalMs !== undefined && next.intervalMs !== cfg.intervalMs;
            if (next.intervalMs !== undefined)
                cfg.intervalMs = next.intervalMs;
            if (next.order !== undefined)
                cfg.order = next.order;
            if (intervalChanged)
                schedule(); // 周期变了才从现在重排；order 只影响下一拍挑哪张
        },
        notifyManualSelect() {
            failed.clear();
            schedule(); // 手动选择重置计时（暂停/未启动时 schedule 自身不动）
        },
        markFailed(id) {
            if (id)
                failed.add(id);
        },
        setPaused(next) {
            if (next === paused)
                return;
            paused = next;
            if (paused)
                clear();
            else
                schedule();
        },
        status() {
            return {
                enabled: started && !paused && !deps.isPaused(),
                poolSize: deps.getPool().filter((w) => !failed.has(w.id)).length,
                nextInMs: timer === null || dueAt === null ? null : Math.max(0, dueAt - now()),
            };
        },
    };
}
