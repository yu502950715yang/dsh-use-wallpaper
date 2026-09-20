import { type WorldTransform } from './scene-graph.js';
import type { LoadWasm, SceneRendererLike } from './wasm-renderer.js';
import type { SceneDescription } from '../shared/types.js';
import { type CompiledEffectPass } from './shader/effect-chain.js';
import type { TextScriptRuntime } from './text-script.js';
export declare function lastWorldTransformOf(id: number): WorldTransform | null;
export declare function particleBlend(blending: string | null | undefined, specText: string): 'additive' | 'alpha';
export declare function collectObjectEffectChains(desc: SceneDescription, loadFile: (name: string) => Promise<Uint8Array | null>): Promise<Map<number, CompiledEffectPass[][]>>;
export declare function createThreeSceneRenderer(opts?: {
    loadWasm?: LoadWasm;
    getTextScriptRuntime?: () => Promise<TextScriptRuntime | null>;
}): SceneRendererLike;
