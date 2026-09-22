/** 从脚本源码提取 动画名 → fps。提取不到的动画由调用方兜底。 */
export declare function extractAnimFps(scriptSource: string): Map<string, number>;
export interface AnimPlayback {
    play(): void;
    pause(): void;
    stop(): void;
    isPlaying(): boolean;
    setFrame(v: number): void;
    getFrame(): number;
}
export declare class AnimRegistry {
    private readonly byKey;
    private readonly fpsTable;
    private readonly defaultFps;
    /** 已警告过的动画名（避免每帧刷屏）。 */
    readonly warned: Set<string>;
    constructor(fpsTable: Map<string, number>, defaultFps?: number);
    /** 取（或创建）某动画的播放器。同一 (layerKey,name) 恒返回同一对象。 */
    get(layerKey: string, name: string): AnimPlayback;
    /** 每帧推进所有在播播放器：frame += fps × dt。 */
    tick(dt: number): void;
    playingCount(): number;
    /** 本动画实际使用的 fps（诊断用）。 */
    fpsOf(name: string): number;
}
