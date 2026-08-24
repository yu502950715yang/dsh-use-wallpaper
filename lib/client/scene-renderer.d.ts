import * as THREE from 'three';
import type { SceneDescription, SceneImageObject, SceneObject, SceneParticleObject, SceneTextObject } from '../shared/types.js';
import type { ParticleEmitterSpec, ParticleInitializerSpec } from './particles.js';
import type { TextTextureOptions } from './text-object.js';
import type { AudioAnalyzer } from './audio-input.js';
type CompiledEffectChains = import('./shader/effect-chain.js').CompiledEffectPass[][];
export interface SceneRenderer {
    setScene(desc: SceneDescription): void;
    setImageObject(tex: THREE.Texture | null, obj: SceneImageObject): void;
    setTextObject(tex: THREE.CanvasTexture, obj: SceneTextObject): void;
    setVisualizerObject(tex: THREE.Texture, obj: SceneImageObject): void;
    setClockObject(obj: SceneTextObject): void;
    addParticleSystem(spec: {
        emitter: ParticleEmitterSpec;
        init: ParticleInitializerSpec;
    }, obj: SceneParticleObject): void;
    setObjectEffectChains(objId: number, chains: CompiledEffectChains | null, wallpaperId: string): void;
    start(): void;
    stop(): void;
}
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
export declare function barAnchorOffsetY(alignment: string | undefined, height: number): number;
export declare function updateVisualizerBars(bars: readonly THREE.Mesh[], anchorY: number, // 三坐标系锚点 y（对象 origin 的中心映射，不翻转）
props: Record<string, unknown>, // 已解包的 scriptProperties
freqData: Uint8Array | null): void;
export declare class ClockTextDriver {
    private mesh;
    private opts;
    private props;
    private lastText;
    private lastTex;
    constructor(mesh: THREE.Mesh, opts: TextTextureOptions, props: Record<string, unknown>);
    update(now: Date): void;
    dispose(): void;
}
export declare function uvWindow(unclamped: number, clamped: number): {
    start: number;
    end: number;
};
export declare function createCompositeGeometry(worldW: number, worldH: number, rtW: number, rtH: number): THREE.PlaneGeometry;
export declare function createSceneRenderer(fgCanvas: HTMLCanvasElement, bgCanvas?: HTMLCanvasElement, audioAnalyzer?: AudioAnalyzer | null): SceneRenderer;
export declare function resolveTexPath(matRef: string, texName: string): string;
export interface RenderSceneOptions {
    getUserProperty?: (key: string) => unknown;
}
export declare function renderScene(id: string, fgCanvas: HTMLCanvasElement, bgCanvas?: HTMLCanvasElement, opts?: RenderSceneOptions): Promise<boolean>;
export {};
