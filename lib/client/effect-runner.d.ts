import * as THREE from 'three';
import type { CompiledEffectPass } from './shader/effect-chain.js';
import { type TexLoadOptions } from './tex-loader.js';
export declare function resolveTextureSlotPath(path: string | null | undefined): string | null;
export declare function isBuiltinTexturePath(path: string | null | undefined): boolean;
export declare function builtinTextureUrl(path: string | null | undefined): string | null;
export declare function resolveBuiltinTexture(path: string | null | undefined): THREE.Texture | null;
export declare function resolveEmptySlotTexture(mode: string | null | undefined): THREE.Texture | null;
export declare function effectSlotCount(pass: CompiledEffectPass): number;
export declare function resolveSlotFallback(pass: CompiledEffectPass, index: number): THREE.Texture | null;
export type EffectTexLoader = (url: string, opts?: TexLoadOptions) => Promise<THREE.Texture | null>;
export declare function loadEffectTextureSlot(path: string | null, id: string, cache: Map<string, THREE.Texture | null>, load?: EffectTexLoader, warn?: (message: string) => void): Promise<THREE.Texture | null>;
export declare function resolveInputTexture(input: THREE.WebGLRenderTarget | THREE.Texture): THREE.Texture;
export declare function pickWriteTarget(previous: THREE.WebGLRenderTarget | null, rtA: THREE.WebGLRenderTarget, rtB: THREE.WebGLRenderTarget): THREE.WebGLRenderTarget;
export interface EffectTargetSize {
    width: number;
    height: number;
}
export declare function resolveTargetSize(current: EffectTargetSize, opts?: {
    width?: number;
    height?: number;
}): EffectTargetSize;
export declare function resolveTextureResolution(tex: {
    image?: {
        width?: number;
        height?: number;
    } | null;
} | null | undefined, fallbackW: number, fallbackH: number): EffectTargetSize;
export declare function resolveTextureResolution4(tex: {
    image?: {
        width?: number;
        height?: number;
    } | null;
    userData?: {
        fxRes?: unknown;
    };
} | null | undefined, fallbackW: number, fallbackH: number): {
    x: number;
    y: number;
    z: number;
    w: number;
};
export declare function fillAudioSpectrumUniform(dest: number[], src: Uint8Array): void;
export declare function describeEffectPass(pass: CompiledEffectPass, key: string, wallpaperId: string): string;
export declare class EffectRunner {
    private renderer;
    private rtA;
    private rtB;
    private chains;
    private id;
    private last;
    private materials;
    private scenes;
    private textures;
    private failed;
    private width;
    private height;
    private updateInFlight;
    private audioSpectrum;
    private readonly load;
    constructor(renderer: THREE.WebGLRenderer, width: number, height: number, opts?: {
        load?: EffectTexLoader;
    });
    setChains(chains: CompiledEffectPass[][], wallpaperId: string, opts?: {
        width?: number;
        height?: number;
    }): void;
    setAudioSpectrumSource(source: Uint8Array | null): void;
    private ensureTargets;
    private disposeMaterials;
    private getMaterial;
    private fillAudioUniforms;
    private disposeSceneQuads;
    private getScene;
    private resolveTextureSlot;
    update(time: number, input: THREE.WebGLRenderTarget | THREE.Texture): Promise<THREE.Texture | null>;
    lastOutput(): THREE.Texture | null;
    dispose(): void;
}
export declare function blendModeToThree(mode: string): THREE.Blending;
