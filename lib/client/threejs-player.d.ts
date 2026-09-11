import * as THREE from 'three';
export declare const DEFAULT_PARTICLE_CAPACITY = 1024;
export declare const MAX_PARTICLE_CAPACITY = 2048;
export declare function specMaxcount(specJson: string): number;
export declare function specEmitterOrigin(specJson: string): [number, number, number];
export declare const BLACKMYTH_OBJ_SCALE: [number, number, number];
export declare function simEmitterOffset(emitterOrigin: [number, number, number]): [number, number, number];
export declare function particleCapacity(declaredMax: number, aliveAtCreate: number): number;
export declare class ThreeScenePlayer {
    readonly renderer: THREE.WebGLRenderer;
    readonly scene: THREE.Scene;
    readonly camera: THREE.OrthographicCamera;
    readonly canvas: HTMLCanvasElement;
    private sceneWidth;
    private sceneHeight;
    private viewWidth;
    private viewHeight;
    private readonly pixelRatio;
    private lastTime;
    private backgroundEntries;
    private nextBackgroundId;
    private particleLayers;
    private nextParticleLayerId;
    constructor(canvas: HTMLCanvasElement, width: number, height: number, renderer?: THREE.WebGLRenderer);
    resize(width: number, height: number): void;
    setSceneSize(width: number, height: number): void;
    private applyCover;
    update(_dt: number): void;
    setAnimationLoop(fn?: (dt: number) => void): void;
    render(): void;
    addBackground(opts: {
        origin: [number, number, number];
        size?: [number, number];
        scale: [number, number, number];
        angles?: [number, number, number];
        texture?: THREE.Texture;
        alpha?: number;
        brightness?: number;
        sceneW: number;
        sceneH: number;
    }): number;
    update_background(id: number, origin?: [number, number, number], scale?: [number, number, number], alpha?: number, brightness?: number): void;
    addParticle(simVerticesGetter: () => Float32Array, opts: {
        tex?: THREE.Texture;
        frameCount: number;
        frameCols?: number;
        frameRows?: number;
        blend: 'additive' | 'alpha';
        softness?: number;
        objectCenter?: [number, number, number];
        objectScale?: [number, number, number];
        objectAngles?: [number, number, number];
        emitterOrigin?: [number, number, number];
        maxInstances?: number;
    }): number;
    updateParticles(dt: number): void;
    private writeParticleData;
    dispose(): void;
}
export interface ParticleSim {
    update(dt: number): void;
    vertices(): Float32Array;
    frame_count(): number;
    set_frame_count(n: number): void;
    particle_count(): number;
    free?(): void;
}
export interface LoadedParticleAssets {
    specJson: string;
    tex?: THREE.Texture;
    blend: 'additive' | 'alpha';
    softness?: number;
    overrideJson?: string;
}
export type ParticleSimFactory = (json: string, origin: [number, number, number], sceneW: number, sceneH: number, overrideJson: string) => ParticleSim;
export interface SceneAssets {
    renderer?: THREE.WebGLRenderer;
    backgroundTextures?: Map<number, THREE.Texture>;
    particles?: Map<number, LoadedParticleAssets>;
    createParticleSim?: ParticleSimFactory;
}
export interface ThreeSceneLoadResult {
    player: ThreeScenePlayer;
    sims: ParticleSim[];
    backgroundIds: number[];
    particleLayers: Array<{
        id: number;
        sim: ParticleSim;
    }>;
}
export declare function frameCountFromDims(width: number, height: number): number;
export declare function textureFrameCount(tex?: THREE.Texture): number;
export declare function textureSpriteInfo(tex?: THREE.Texture): {
    frames: number;
    cols: number;
    rows: number;
} | undefined;
export declare function textureFrameGrid(tex?: THREE.Texture): {
    cols: number;
    rows: number;
};
export declare function loadSceneToThree(sceneJson: string, assets: SceneAssets, canvas: HTMLCanvasElement, viewport?: {
    width: number;
    height: number;
}): ThreeSceneLoadResult;
