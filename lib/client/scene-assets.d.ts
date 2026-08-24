import type { SceneDescription } from '../shared/types.js';
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
