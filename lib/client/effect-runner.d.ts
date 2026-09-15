import * as THREE from 'three';
import type { CompiledEffectPass } from './shader/effect-chain.js';
import { type TexLoadOptions } from './tex-loader.js';
import { type EffectPlan } from './effect-graph.js';
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
    private plan;
    private namedRt;
    private warnedKeys;
    private width;
    private height;
    private updateInFlight;
    private audioSpectrum;
    private readonly load;
    constructor(renderer: THREE.WebGLRenderer, width: number, height: number, opts?: {
        load?: EffectTexLoader;
    });
    /** 挂载带具名 RT 的效果计划。**只允许在加载期 / resize 重挂期调用**（帧内不得建 RT，§5.11）。 */
    setPlan(plan: EffectPlan, chains: CompiledEffectPass[][], wallpaperId: string, opts?: {
        width?: number;
        height?: number;
    }): void;
    /** 具名 RT 池：先释放旧的再按计划重建（resize / 换壁纸 / 重挂链共用）。 */
    private ensureNamedTargets;
    private clearNamedTargets;
    /** 按 key 去重的 console.warn（同一条件只报一次，避免每帧 / 每次重挂刷屏）。 */
    private warnOnce;
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
    /** 绑一个槽：纹理 + g_TextureNResolution（vec4 口径见 AGENT.md §5.17）。 */
    private bindSlot;
    /** 无计划（setChains 旧路径）时的退化计划：全部按线性 ping-pong。 */
    private plannedPasses;
    /** `textures` 槽引用的 `_rt_*` 是否为本链**未声明**的全局运行时 RT（如 _rt_FullFrameBuffer）。
     *  调用方还需排除「该槽已被 bind 覆盖」：那时实际用的是 bind 的源，拦截与告警都是误导。 */
    private isForeignRuntimeRt;
    private resolveTextureSlot;
    update(time: number, input: THREE.WebGLRenderTarget | THREE.Texture): Promise<THREE.Texture | null>;
    lastOutput(): THREE.Texture | null;
    dispose(): void;
}
export declare function blendModeToThree(mode: string): THREE.Blending;
