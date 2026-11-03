export interface VideoHealthSnapshot {
    fps: number;
    droppedFrames: number;
    droppedRecent: number;
    totalFrames: number;
    currentTime: number;
    duration: number;
    paused: boolean;
    videoWidth: number;
    videoHeight: number;
    loopStallsMs: number[];
    lastEvent: string | null;
    lastEventAgoMs: number | null;
    state: 'ok' | 'stalled' | 'paused' | 'lost';
    updatedAt: number;
}
export interface VideoHealthMonitor {
    attach(video: HTMLVideoElement): void;
    detach(): void;
    snapshot(): VideoHealthSnapshot | null;
    dispose(): void;
}
/** 创建只读健康采样器；一次只跟一个 video（重复 attach 自动摘旧的）。 */
export declare function createVideoHealthMonitor(opts?: {
    now?: () => number;
    sampleIntervalMs?: number;
    tickIntervalMs?: number;
    maxLoopStalls?: number;
    timers?: {
        setInterval: (fn: () => void, ms: number) => number;
        clearInterval: (id: number) => void;
    };
}): VideoHealthMonitor;
