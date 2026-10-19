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
export declare function createMediaHealthStore(now?: () => number): MediaHealthStore;
