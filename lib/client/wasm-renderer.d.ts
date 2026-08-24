import type { SceneDescription } from '../shared/types.js';
export declare function hasEffectChains(desc: SceneDescription): boolean;
export interface WasmScene {
    resize(w: number, h: number): void;
    load_scene(json: string): void;
    set_cover(): void;
    load_image(assetId: number, tex: Uint8Array, origin: Float32Array, scale: Float32Array, size: Float32Array, color: Float32Array, alpha: Float32Array, brightness: Float32Array): void;
    add_particle(json: string, origin: Float32Array, scale: Float32Array, texBytes: Uint8Array): void;
    step(dt: number): void;
    render(): void;
    scene_width(): number;
    scene_height(): number;
}
export interface WasmSceneModule {
    default(moduleOrPath?: string | URL | Request): Promise<unknown>;
    WeScene: {
        create(canvas: HTMLCanvasElement, width: number, height: number): Promise<WasmScene>;
    };
}
export type LoadWasm = () => Promise<WasmSceneModule | null>;
export interface SceneRendererLike {
    render(id: string, fg: HTMLCanvasElement, bg?: HTMLCanvasElement): Promise<boolean>;
}
export declare function createFallbackSceneRenderer(wasm: SceneRendererLike | null, _js: SceneRendererLike): SceneRendererLike;
export declare function createWasmSceneRenderer(opts?: {
    loadWasm?: LoadWasm;
}): SceneRendererLike | null;
