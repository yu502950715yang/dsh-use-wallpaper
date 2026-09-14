import * as THREE from 'three';
import { CAMERA_DISTANCE, OBJECT_RT_MAX, PARTICLE_DEFAULT_DISTANCE, materialModulation, objectCameraRange, particleObjectRange, particleWorldSize, createObjectRenderTarget, shouldUseObjectPath, groupEffectsByObject, PendingChainStore, uvWindow, createCompositeGeometry, coverRange } from './object-range.js';
export { CAMERA_DISTANCE, OBJECT_RT_MAX, PARTICLE_DEFAULT_DISTANCE, materialModulation, objectCameraRange, particleObjectRange, particleWorldSize, createObjectRenderTarget, shouldUseObjectPath, groupEffectsByObject, PendingChainStore, uvWindow, createCompositeGeometry, coverRange, };
import type { SceneDescription, SceneImageObject, SceneParticleObject, SceneTextObject } from '../shared/types.js';
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
export declare function createSceneRenderer(fgCanvas: HTMLCanvasElement, bgCanvas?: HTMLCanvasElement, audioAnalyzer?: AudioAnalyzer | null): SceneRenderer;
export declare function resolveTexPath(matRef: string, texName: string): string;
export declare function resolveImageTexture(id: string, obj: SceneImageObject): Promise<THREE.Texture | null>;
export interface RenderSceneOptions {
    getUserProperty?: (key: string) => unknown;
}
export declare function renderScene(id: string, fgCanvas: HTMLCanvasElement, bgCanvas?: HTMLCanvasElement, opts?: RenderSceneOptions): Promise<boolean>;
