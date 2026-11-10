export class PanelBus {
    handlers = {};
    healthSubs = new Set();
    mediaSubs = new Set();
    /** 注册/覆盖处理器槽位（undefined 槽位保持现状；显式 null = 撤销该槽位）。 */
    setHandlers(patch) {
        Object.assign(this.handlers, patch);
        // 媒体 handler 变更时立即同步提示态（撤销 → 面板回「无失败」初始态）。
        if ('media' in patch)
            this.pushMedia(patch.media?.get() ?? null);
    }
    get() {
        return this.handlers;
    }
    subscribeHealth(cb) {
        this.healthSubs.add(cb);
        return () => { this.healthSubs.delete(cb); };
    }
    notifyHealth(snap) {
        for (const cb of Array.from(this.healthSubs)) {
            try {
                cb(snap);
            }
            catch { /* 单个订阅者异常不影响其它订阅者 */ }
        }
    }
    subscribeMedia(cb) {
        this.mediaSubs.add(cb);
        return () => { this.mediaSubs.delete(cb); };
    }
    /** handler 未注册时不推（面板已回初始态，迟到的失败不得复活提示）。 */
    notifyMedia(failure) {
        if (!this.handlers.media)
            return;
        this.pushMedia(failure);
    }
    pushMedia(failure) {
        for (const cb of Array.from(this.mediaSubs)) {
            try {
                cb(failure);
            }
            catch { /* 单个订阅者异常不影响其它订阅者 */ }
        }
    }
}
