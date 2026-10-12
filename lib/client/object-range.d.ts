import * as THREE from 'three';
import type { SceneObject } from '../shared/types.js';
export declare const CAMERA_DISTANCE = 300;
export declare const OBJECT_RT_MAX = 4096;
export declare function materialModulation(color?: [number, number, number], alpha?: number, brightness?: number): {
    r: number;
    g: number;
    b: number;
    a: number;
};
export declare function objectCameraRange(objSize: [number, number], scale: [number, number]): {
    w: number;
    h: number;
};
export declare const PARTICLE_DEFAULT_DISTANCE = 64;
export declare function particleObjectRange(spec: {
    distanceMax?: number;
}, scale: [number, number]): {
    w: number;
    h: number;
};
export declare function particleWorldSize(spec: {
    distanceMax?: number;
}, scale: [number, number]): {
    w: number;
    h: number;
};
export declare function createObjectRenderTarget(width: number, height: number): THREE.WebGLRenderTarget;
export declare function shouldUseObjectPath(obj: {
    effects?: unknown;
}): obj is {
    effects: unknown[];
};
export declare function groupEffectsByObject(objects: SceneObject[]): Array<{
    obj: SceneObject;
    effects: unknown[];
}>;
export declare class PendingChainStore<T> {
    private stash;
    applyIfReady(objId: number, chains: T, hasEntry: boolean): boolean;
    take(objId: number): T | undefined;
    clear(): void;
}
export declare function uvWindow(unclamped: number, clamped: number): {
    start: number;
    end: number;
};
export declare function createCompositeGeometry(worldW: number, worldH: number, rtW: number, rtH: number): THREE.PlaneGeometry;
export declare function flipGeometryUvY(geometry: THREE.BufferGeometry): void;
export declare function coverRange(width: number, height: number, viewAspect: number): {
    w: number;
    h: number;
};
export declare function screenScalePx(sceneW: number, sceneH: number, viewW: number, viewH: number, dpr: number): number;
export declare function objectRtSize(worldW: number, worldH: number, screenScale: number, cap?: number): {
    width: number;
    height: number;
};
export interface SourcePixels {
    width: number;
    height: number;
}
export declare function isolatedRtLongEdge(occLongEdge: number, sourceLongEdge: number, cap?: number): number;
export declare function isolatedRtSize(worldW: number, worldH: number, density: number, source: SourcePixels | null, opts?: {
    cap?: number;
    budgetScale?: number;
}): {
    width: number;
    height: number;
    upgraded: boolean;
};
export interface TexLike {
    image?: {
        width?: number;
        height?: number;
        videoWidth?: number;
        videoHeight?: number;
    } | null;
    userData?: {
        sprite?: unknown;
    } | null;
}
export declare function sourcePixelsFromTexture(tex: TexLike | null | undefined): SourcePixels | null;
export declare const ISOLATED_RT_BUDGET_BYTES = 384000000;
export declare const ISOLATED_RT_BYTES_PER_PX = 28;
export declare function fitIsolatedBudget(items: Array<{
    worldW: number;
    worldH: number;
    source: SourcePixels | null;
}>, density: number, budgetBytes?: number, bytesPerPx?: number): number;
