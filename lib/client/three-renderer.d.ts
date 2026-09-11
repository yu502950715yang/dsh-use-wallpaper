import type { LoadWasm, SceneRendererLike } from './wasm-renderer.js';
export declare function particleBlend(blending: string | null | undefined, specText: string): 'additive' | 'alpha';
export declare function createThreeSceneRenderer(opts?: {
    loadWasm?: LoadWasm;
}): SceneRendererLike;
