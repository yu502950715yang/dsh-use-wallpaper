declare const HARD_KINDS: readonly ["scene-json", "no-visible-objects", "context-lost", "exception"];
export type HardFailureKind = typeof HARD_KINDS[number];
export type SoftFailureKind = 'load-error';
export type FailureKind = HardFailureKind | SoftFailureKind;
/** 硬失败 = 有证据表明「这张壁纸渲染不出来」⇒ 可落盘；软失败 = 可能是这次没供上 ⇒ 只记会话。 */
export declare function isHardFailure(kind: FailureKind): kind is HardFailureKind;
export interface RenderTiming {
    assembleMs: number;
    firstFrameMs: number;
}
export interface HealthEntry {
    kind: FailureKind;
    hard: boolean;
    at: number;
    detail: string;
}
export interface HealthSnapshot {
    wallpaperId: string;
    ok: boolean | null;
    failure: HealthEntry | null;
    timing: RenderTiming | null;
}
export declare const HEALTH_KEY_PREFIX = "we:renderfail:";
export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    key(index: number): string | null;
    readonly length: number;
}
export interface RenderHealthStore {
    recordHard(id: string, kind: HardFailureKind, detail: string): void;
    recordSoft(id: string, kind: SoftFailureKind, detail: string): void;
    recordOk(id: string, timing: RenderTiming): void;
    clear(id: string): void;
    clearAll(): void;
    snapshot(id: string): HealthSnapshot;
    shouldAutoRetry(id: string): boolean;
    markAutoRetried(id: string): void;
}
export declare function createRenderHealthStore(opts?: {
    storage?: StorageLike | null;
    now?: () => number;
    softCooldownMs?: number;
}): RenderHealthStore;
/** 面板状态行文案（不含 HTML）：三种状态各一句可读中文，不暴露原始枚举。 */
export declare function formatHealthLine(snap: HealthSnapshot, t: (s: string) => string): string;
export {};
