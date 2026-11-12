import * as THREE from 'three';
import type { ParticleLayer } from './particle-layer-factory.js';
export type BackgroundEntry = {
    mesh: THREE.Mesh;
    origin: [number, number, number];
    size: [number, number];
    scale: [number, number, number];
    angles: [number, number, number];
    align: [number, number];
    alignment?: string;
    color?: [number, number, number];
    alpha: number;
    brightness: number;
    sceneW: number;
    sceneH: number;
    renderOffset: [number, number, number];
    parallaxNode: THREE.Object3D;
    parallaxDepth?: [number, number];
    parallaxNodeOrigin?: [number, number, number];
    parallaxApplied?: boolean;
};
export interface BackgroundLayerHost {
    readonly sceneWidth: number;
    readonly sceneHeight: number;
    entryById(backgroundId: number): BackgroundEntry | undefined;
    backgroundIdOf(objectId: number): number | undefined;
    particleOf(objectId: number): ParticleLayer | undefined;
    isIsolated(objectId: number): boolean;
    hasPuppetLayer(id: number): boolean;
    /** 换几何后按 backgroundId 重写精灵表 UV 的 base（见 sprite-sheet-runtime.rebaseForBackground）。 */
    rebaseSpriteSheet(backgroundId: number): void;
    /** 同对象只告警一次（防每帧刷屏）。 */
    warnedUnsupportedTransform: Set<number>;
}
/** alignment 锚点偏移的世界坐标：局部半尺寸先乘 scale（含镜像），再按对象 angles 旋转（与 mesh TRS 同序）。 */
export declare function alignmentWorldOffset(size: [number, number], scale: [number, number, number], angles: [number, number, number], alignment?: string): [number, number];
/**
 * 时间线动画：按 scene 对象 id 写入**世界变换**。
 * 支持非隔离背景/puppet（mesh TRS）与非隔离粒子的 origin 平移增量（粒子内容由 shader 定位，
 * 写绝对中心会双重平移）；隔离对象（对象级效果链的合成 quad）暂不支持 → false + 告警一次。
 */
export declare function updateBackgroundTransform(host: BackgroundLayerHost, objectId: number, wt: {
    origin: [number, number, number];
    scale: [number, number, number];
    angles: [number, number, number];
}): boolean;
/**
 * 刷新背景图层的锚点偏移（renderOffset = 渲染中心 − 对象锚点）。文本标题/字号变化后
 * 由 text driver 按新 layout 调用；只记偏移，位置由随后的 update_background / syncWorld 写入。
 */
export declare function setBackgroundAnchorOffset(host: BackgroundLayerHost, backgroundId: number, offset: [number, number]): boolean;
export declare function updateBackground(host: BackgroundLayerHost, id: number, origin?: [number, number, number], scale?: [number, number, number], alpha?: number, brightness?: number): void;
export declare function resizeBackground(host: BackgroundLayerHost, id: number, size: [number, number]): void;
