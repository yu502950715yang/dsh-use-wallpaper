import * as THREE from 'three';
import { type BackgroundEntry } from './background-layer-factory.js';
import type { PuppetInstance } from './puppet.js';
import type { SceneImageObject, UtilLayerKind } from '../shared/types.js';
export interface PuppetLayerEntry {
    instance: PuppetInstance;
    layers: NonNullable<SceneImageObject['animationLayers']> | null;
    elapsed: number;
    warned?: boolean;
}
export interface BackgroundAssemblyHost {
    readonly scene: THREE.Scene;
    nextBackgroundId(): number;
    addEntry(id: number, entry: BackgroundEntry): void;
    attachIsolated(objectId: number, kind: 'background' | 'particle' | 'puppet', content: THREE.Object3D, worldW: number, worldH: number, size: {
        width: number;
        height: number;
    }, position: {
        x: number;
        y: number;
        z: number;
    }, quadAngles: [number, number, number], colorBlendMode: number, renderOrder?: number, compositeOpacity?: number, attachQuad?: boolean, puppet?: PuppetInstance): void;
    isolatedQuad(objectId: number): THREE.Object3D | undefined;
    setDisplayObject(objectId: number, shown: THREE.Object3D): void;
    setObjectToBackground(objectId: number, id: number): void;
    registerSpriteSheet(backgroundId: number, objectId: number, mesh: THREE.Mesh, sprite: {
        frames: number;
        cols: number;
        rows: number;
        frametime?: number;
    }): void;
    registerUtilContent(objectId: number, mesh: THREE.Mesh, centerX: number, centerY: number): void;
    setPuppetLayer(id: number, layer: PuppetLayerEntry): void;
}
export interface AddBackgroundOptions {
    origin: [number, number, number];
    size?: [number, number];
    scale: [number, number, number];
    angles?: [number, number, number];
    colorBlendMode?: number;
    texture?: THREE.Texture;
    alpha?: number;
    brightness?: number;
    util?: UtilLayerKind;
    color?: [number, number, number];
    colorUserBound?: boolean;
    alignment?: string;
    sceneW: number;
    sceneH: number;
    objectId?: number;
    transformOrigin?: [number, number, number];
    renderOrder?: number;
    isolate?: {
        objectId: number;
        rtWidth: number;
        rtHeight: number;
        worldW: number;
        worldH: number;
    };
    parallaxDepth?: [number, number];
    parallaxNodeOrigin?: [number, number, number];
    disableDynamicColor?: boolean;
}
export interface AddPuppetOptions {
    objectId: number;
    puppet: PuppetInstance;
    origin: [number, number, number];
    scale: [number, number, number];
    angles: [number, number, number];
    sceneW: number;
    sceneH: number;
    renderOrder?: number;
    alpha?: number;
    brightness?: number;
    parallaxDepth?: [number, number];
    parallaxNodeOrigin?: [number, number, number];
    animationLayers?: SceneImageObject['animationLayers'];
    texture?: THREE.Texture | null;
    isolate?: {
        objectId: number;
        rtWidth: number;
        rtHeight: number;
        worldW: number;
        worldH: number;
    };
}
export declare function addBackground(host: BackgroundAssemblyHost, opts: AddBackgroundOptions): number;
export declare function addPuppet(host: BackgroundAssemblyHost, opts: AddPuppetOptions): number;
