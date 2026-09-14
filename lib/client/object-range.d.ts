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
export declare function containRange(width: number, height: number, viewAspect: number): {
    w: number;
    h: number;
};
export declare function coverRange(width: number, height: number, viewAspect: number): {
    w: number;
    h: number;
};
