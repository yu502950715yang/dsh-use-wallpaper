import { type WorldTransform } from './scene-graph.js';
import type { LoadWasm } from './wasm-loader.js';
import type { SceneRendererLike } from './wallpaper-controller.js';
import type { ObjectScriptProperty, SceneDescription } from '../shared/types.js';
import { type CompiledEffectPass } from './shader/effect-chain.js';
import type { TextScriptRuntime } from './text-script.js';
import type { RenderHealthStore } from './render-health.js';
export declare function lastWorldTransformOf(id: number): WorldTransform | null;
export declare function particleBlend(blending: string | null | undefined, specText: string): 'additive' | 'alpha';
export declare function collectObjectEffectChains(desc: SceneDescription, loadFile: (name: string) => Promise<Uint8Array | null>, isHidden?: (obj: SceneDescription['objects'][number]) => boolean): Promise<Map<number, CompiledEffectPass[][]>>;
export declare function collectScriptSources(desc: SceneDescription): Array<{
    objectId: number;
    source: string;
    scriptProperties?: Record<string, unknown>;
    property?: ObjectScriptProperty;
}>;
export declare function createThreeSceneRenderer(opts?: {
    loadWasm?: LoadWasm;
    getTextScriptRuntime?: () => Promise<TextScriptRuntime | null>;
    healthStore?: RenderHealthStore;
}): SceneRendererLike;
