import * as THREE from 'three';
import type { GlowStage } from './glow-stage.js';
export declare const DEFAULT_PARTICLE_CAPACITY = 1024;
export declare const MAX_PARTICLE_CAPACITY = 2048;
export declare function specMaxcount(specJson: string): number;
export declare function specEmitterOrigin(specJson: string): [number, number, number];
export declare const BLACKMYTH_OBJ_SCALE: [number, number, number];
export declare function simEmitterOffset(emitterOrigin: [number, number, number]): [number, number, number];
export declare function particleCapacity(declaredMax: number, aliveAtCreate: number): number;
/** WE `colorBlendMode` → three `CustomBlending` 设置；未实现的模式返回 null。 */
export declare function colorBlendModeToThree(mode: number): {
    blendEquation: THREE.BlendingEquation;
    blendSrc: THREE.BlendingSrcFactor | THREE.BlendingDstFactor;
    blendDst: THREE.BlendingDstFactor;
} | null;
export interface IsolatedObject {
    /** 键 = scene.json 的**对象 id**（不是本类图层的计数器 id，见 attachIsolated 注释）。 */
    id: number;
    kind: 'background' | 'particle';
    rt: THREE.WebGLRenderTarget;
    rtWidth: number;
    rtHeight: number;
    rtTexture: THREE.Texture;
    localScene: THREE.Scene;
    localCamera: THREE.OrthographicCamera;
    quad: THREE.Mesh;
    /** 合成 quad 的世界尺寸（= |对象 size/dist × scale|，未钳制幅值），resize 重建几何时用。 */
    worldW: number;
    worldH: number;
}
export interface ObjectEffectStage {
    bindOutputs(): void;
    advance(time: number): void;
}
export declare function resolvePixelRatio(devicePixelRatio: number, qualityScale: number): number;
export declare class ThreeScenePlayer {
    readonly renderer: THREE.WebGLRenderer;
    readonly scene: THREE.Scene;
    readonly camera: THREE.OrthographicCamera;
    readonly canvas: HTMLCanvasElement;
    private sceneWidth;
    private sceneHeight;
    private viewWidth;
    private viewHeight;
    private pixelRatio;
    private qualityScale;
    private paused;
    private pausedAt;
    private pausedTotal;
    private loopFn;
    private lastTime;
    private backgroundEntries;
    private nextBackgroundId;
    private particleLayers;
    private nextParticleLayerId;
    private isolated;
    private objectEffectStage;
    private glowStage;
    private readonly startedAt;
    constructor(canvas: HTMLCanvasElement, width: number, height: number, renderer?: THREE.WebGLRenderer, qualityScale?: number);
    resize(width: number, height: number): void;
    /** 画质档位：走 resize 路径重推画布缓冲与屏幕密度（对象 RT 的基准随之变化）。 */
    setQualityScale(scale: number): void;
    /** 暂停帧循环（省电）：停 RAF 排程；暂停时长不计入 elapsedSeconds。 */
    pause(): void;
    /** 恢复帧循环（暂停期间的时间被扣除，恢复后 g_Time 不跳变）。 */
    resume(): void;
    isPaused(): boolean;
    private devicePixelRatio;
    private nowMs;
    setSceneSize(width: number, height: number): void;
    screenScalePx(): number;
    private applyCover;
    update(_dt: number): void;
    setAnimationLoop(fn?: (dt: number) => void): void;
    private installLoop;
    render(): void;
    setObjectEffectStage(stage: ObjectEffectStage | null): void;
    /** 装配应用级 Glow（null = 关闭）。关闭时帧序与本方法加入前逐字相同。 */
    setGlowStage(stage: GlowStage | null): void;
    isolatedObjects(): IsolatedObject[];
    setObjectOutput(id: number, texture: THREE.Texture): void;
    resizeObjectRT(id: number, width: number, height: number): void;
    private renderIsolatedContents;
    elapsedSeconds(): number;
    addBackground(opts: {
        origin: [number, number, number];
        size?: [number, number];
        scale: [number, number, number];
        angles?: [number, number, number];
        colorBlendMode?: number;
        texture?: THREE.Texture;
        alpha?: number;
        brightness?: number;
        sceneW: number;
        sceneH: number;
        isolate?: {
            objectId: number;
            rtWidth: number;
            rtHeight: number;
            worldW: number;
            worldH: number;
        };
    }): number;
    private createLayerMaterial;
    private createCompositeQuadMaterial;
    private attachIsolated;
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
        isolate?: {
            objectId: number;
            rtWidth: number;
            rtHeight: number;
            worldW: number;
            worldH: number;
        };
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
    isolate?: Map<number, {
        objectId: number;
        rtWidth: number;
        rtHeight: number;
        worldW: number;
        worldH: number;
    }>;
    qualityScale?: number;
    textLayers?: Map<number, {
        texture: THREE.Texture;
        driver?: {
            update(now: Date): boolean;
        };
    }>;
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
