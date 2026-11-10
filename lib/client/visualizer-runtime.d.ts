import * as THREE from 'three';
export interface VisualizerBarsOpts {
    origin: [number, number, number];
    barSize: [number, number];
    texture?: THREE.Texture;
    barWidth: number;
    scaleY: number;
    originX: number;
    sceneW: number;
    sceneH: number;
    renderOrder?: number;
    count?: number;
}
export interface PixelVisualizerBarsOpts {
    origin: [number, number, number];
    scale: [number, number, number];
    angles: [number, number, number];
    barSize: [number, number];
    barWidth: number;
    minBarHeight: number;
    scaleY: number;
    barPath: string;
    downscaleMode: 'max' | 'average';
    sceneW: number;
    sceneH: number;
    renderOrder?: number;
    count: number;
    alignment?: string;
    texture?: THREE.Texture;
}
/** addBackground 的最小参数面（结构兼容 player 的 addBackground）。 */
export interface VisualizerAddOpts {
    origin: [number, number, number];
    size: [number, number];
    scale: [number, number, number];
    angles?: [number, number, number];
    alignment?: string;
    texture?: THREE.Texture;
    sceneW: number;
    sceneH: number;
    renderOrder?: number;
}
export interface VisualizerHost {
    addBackground(opts: VisualizerAddOpts): number;
    entryMesh(id: number): THREE.Mesh | undefined;
}
export declare class VisualizerRuntime {
    private readonly host;
    private bars;
    private pixelBars;
    constructor(host: VisualizerHost);
    /** SceneScript 的 64 条音频条：按 origin 横向排布，barWidth 为世界宽度、初始高度 0。 */
    setBars(opts: VisualizerBarsOpts): number[];
    /**
     * 自定义 visualizer（pixel-bars 家族，如 3118949804）：按对象 scale/angles 布局 count 条；
     * 高度倍率默认 minBarHeight（静音仍可见，与脚本 Math.max(minBarHeight, …) 一致）。
     */
    setPixelBars(opts: PixelVisualizerBarsOpts): number[];
    /** 每帧更新可视化条高度：freqData = 64 bin 频谱（0-255）；null = 无音频 → 全部归零。 */
    update(freqData: Uint8Array | null): void;
}
