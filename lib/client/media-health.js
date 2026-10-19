export function createMediaHealthStore(now = () => Date.now()) {
    let current = null;
    const subscribers = new Set();
    // 单个订阅者异常不影响其它订阅者（同 render-health 的推送约定）。
    const notify = () => {
        for (const cb of Array.from(subscribers)) {
            try {
                cb(current);
            }
            catch { /* 忽略订阅者异常 */ }
        }
    };
    return {
        set(id, kind, fallback) {
            if (!id)
                return;
            current = { id, kind, fallback, at: now() };
            notify();
        },
        get: () => current,
        clear() {
            if (current === null)
                return; // 空态不重复推送
            current = null;
            notify();
        },
        subscribe(cb) {
            subscribers.add(cb);
            return () => { subscribers.delete(cb); };
        },
    };
}
