import type { WallpaperInfo } from '../shared/types.js';
import type { RotationOrder } from './types.js';
import type { LibraryState } from './library-view.js';
/** 设置面板可选的轮播间隔（与 host schema 的 1–30 分钟钳制一致）。 */
export declare const ROTATION_INTERVAL_OPTIONS: ReadonlyArray<{
    ms: number;
    label: string;
}>;
/** 轮播顺序归一：只认 random，其余（含旧值/非法值）回 sequential。 */
export declare function normalizeRotationOrder(raw: unknown): RotationOrder;
/** 间隔文案（分钟）：非法值回退 5 分钟（= DEFAULTS.rotationIntervalMs）。 */
export declare function formatRotationInterval(ms: unknown): string;
/** 轮播池：收藏 ≥2 张时只用收藏（收藏即轻量播放列表）；否则全部非隐藏且可渲染的壁纸。 */
export declare function buildRotationPool(list: WallpaperInfo[], state: LibraryState): WallpaperInfo[];
/** 下一张：空池/单张返回 null（1 张时不动）；顺序取 current 之后（环形），随机排除 current。 */
export declare function pickNext(pool: WallpaperInfo[], currentId: string, order: RotationOrder, rand?: () => number): WallpaperInfo | null;
/** 调度器状态（面板/排查用）：enabled = 已在跑且未暂停；nextInMs = 距下次 tick 的毫秒数。 */
export interface RotationStatus {
    enabled: boolean;
    poolSize: number;
    nextInMs: number | null;
}
export interface RotationSchedulerDeps {
    getPool: () => WallpaperInfo[];
    getCurrentId: () => string;
    select: (id: string) => Promise<void>;
    isPaused: () => boolean;
    intervalMs: number;
    order?: RotationOrder;
    now?: () => number;
    setTimeoutFn?: (fn: () => void, ms: number) => number;
    clearTimeoutFn?: (handle: number) => void;
}
export interface RotationScheduler {
    start(): void;
    stop(): void;
    setConfig(cfg: {
        intervalMs?: number;
        order?: RotationOrder;
    }): void;
    notifyManualSelect(): void;
    markFailed(id: string): void;
    setPaused(paused: boolean): void;
    status(): RotationStatus;
}
export declare function createRotationScheduler(deps: RotationSchedulerDeps): RotationScheduler;
