import type { SceneDescription, SceneImageObject } from '../shared/types.js';
import * as THREE from 'three';
import type { ParticleEmitterSpec, ParticleInitializerSpec } from './particles.js';
export declare function fetchSceneDescription(id: string): Promise<SceneDescription>;
export declare function particlesFromSpec(root: any): {
    emitter: ParticleEmitterSpec;
    init: ParticleInitializerSpec;
} | null;
export declare function fetchParticleSpec(id: string, assetName: string): Promise<{
    emitter: ParticleEmitterSpec;
    init: ParticleInitializerSpec;
} | null>;
export declare function resolveTexPath(matRef: string, texName: string): string;
export declare function resolveImageAssets(id: string, obj: SceneImageObject): Promise<{
    texture: THREE.Texture | null;
    puppetPath: string | null;
}>;
export declare function fetchMdlBytes(id: string, path: string): Promise<Uint8Array | null>;
export interface ParticleMaterialRef {
    texUrl: string | null;
    blending: string | null;
    refract: boolean;
    normalTexUrl: string | null;
    refractAmount: number;
}
export declare function resolveParticleMaterial(id: string, specText: string): Promise<ParticleMaterialRef | null>;
