// 视频解码失败的内存记录（不落盘）：面板只提示最近一条；重新选壁纸时清除。
export type MediaFailureKind = 'unsupported' | 'timeout';
/** 失败后实际回退到了什么：preview = 显示了预览图，none = 连预览图都没有。 */
export type MediaFallback = 'preview' | 'none';

export interface MediaFailure {
  id: string;
  kind: MediaFailureKind;
  /** 面板按此分档措辞，不得陈述未发生的回退。 */
  fallback: MediaFallback;
  at: number;
}

export interface MediaHealthStore {
  /** 记录一条失败（同一时刻只保留最近一条；空 id = 无可归属壁纸，忽略）。 */
  set(id: string, kind: MediaFailureKind, fallback: MediaFallback): void;
  get(): MediaFailure | null;
  clear(): void;
  /** 订阅 set/clear 推送（返回退订函数）；参照 render-health 的 subscriber Set 模式。 */
  subscribe(cb: (failure: MediaFailure | null) => void): () => void;
}

export function createMediaHealthStore(now: () => number = () => Date.now()): MediaHealthStore {
  let current: MediaFailure | null = null;
  const subscribers = new Set<(failure: MediaFailure | null) => void>();
  // 单个订阅者异常不影响其它订阅者（同 render-health 的推送约定）。
  const notify = (): void => {
    for (const cb of Array.from(subscribers)) {
      try { cb(current); } catch { /* 忽略订阅者异常 */ }
    }
  };
  return {
    set(id, kind, fallback) {
      if (!id) return;
      current = { id, kind, fallback, at: now() };
      notify();
    },
    get: () => current,
    clear() {
      if (current === null) return; // 空态不重复推送
      current = null;
      notify();
    },
    subscribe(cb) {
      subscribers.add(cb);
      return () => { subscribers.delete(cb); };
    },
  };
}
