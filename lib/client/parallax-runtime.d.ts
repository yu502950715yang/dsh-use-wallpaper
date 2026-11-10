import * as THREE from 'three';
import type { ParallaxConfig, PointerState } from './parallax.js';
/** 背景条目中视差用到的字段（结构兼容 player 内的 BackgroundEntry）。 */
export interface ParallaxBackgroundLike {
    origin: [number, number, number];
    sceneW: number;
    sceneH: number;
    align: [number, number];
    parallaxNode: THREE.Object3D;
    parallaxDepth?: [number, number];
    parallaxApplied?: boolean;
}
/** 粒子层中视差用到的字段（结构兼容 player 内的 ParticleLayer）。 */
export interface ParallaxParticleLike {
    parallaxCenter: [number, number];
    parallaxIsolated?: boolean;
    parallaxQuad?: THREE.Object3D;
    parallaxDepth?: [number, number];
    parallaxApplied?: boolean;
    material: {
        uniforms: Record<string, {
            value: unknown;
        }>;
    };
}
export interface ParallaxTickDeps {
    sceneWidth: number;
    sceneHeight: number;
    backgrounds: Iterable<ParallaxBackgroundLike>;
    particles: Iterable<ParallaxParticleLike>;
}
export declare class ParallaxRuntime {
    private cfg;
    private target;
    private follow;
    setConfig(cfg: ParallaxConfig | null): void;
    setPointer(p: PointerState): void;
    pointer(): PointerState;
    tick(dt: number, deps: ParallaxTickDeps): void;
}
