import * as THREE from 'three';
import type { CompiledEffectPass } from './shader/effect-chain.js';
import { type TexLoadOptions } from './tex-loader.js';
import { type EffectPlan } from './effect-graph.js';
export declare function resolveTextureSlotPath(path: string | null | undefined): string | null;
export declare function isBuiltinTexturePath(path: string | null | undefined): boolean;
export declare function builtinTextureUrl(path: string | null | undefined): string | null;
export declare const FRAME_SNAPSHOT_RT = "_rt_FullFrameBuffer";
/** 该槽路径是否指向整帧快照（只认这一个名字；`_rt_FullCompoBuffer1_23_40` 这类派生名一律 false）。 */
export declare function isFrameSnapshotPath(path: string | null | undefined): boolean;
/** 该纹理槽是否被**计划里的** bind 覆盖（覆盖 ⇒ `update` 实际绑的是 bind 的源，不是 `textureSlots[slot]`）。
 *  「谁引用了整帧快照」的判定与实际槽绑定共用本函数 ⇒ 两处口径不可能分叉。 */
export declare function slotBoundByBind(bindings: readonly {
    slot: number;
}[], slot: number): boolean;
/** 该 pass 是否**真的**会采样整帧快照：`textures[j] = _rt_FullFrameBuffer` 且该槽未被 bind 覆盖。
 *  ⚠️ bind 的**唯一来源必须是执行计划的 `pp.bindings`**（`update` 的槽绑定读的就是它）：原始
 *  `pass.bind` 里未解析名字的 bind 会被 `buildEffectPlan` 丢弃，那种形态下 `update` 实际绑的是
 *  `textureSlots[j]` —— 读 `pass.bind` 会对同一 pass 给出相反结论（两套来源，已废弃）。 */
export declare function passSamplesFrameSnapshot(pass: CompiledEffectPass, bindings: readonly {
    slot: number;
}[]): boolean;
/** 该对象是否引用整帧快照（判定完全基于执行计划）：任一**计划内** pass 会采样它 ⇒ 该对象就是段边界
 *  消费者。计划里没有的 pass（`droppedChains`）不算 —— 它们不会执行。 */
export declare function planSamplesFrameSnapshot(chains: CompiledEffectPass[][], plan: EffectPlan): boolean;
export declare function resolveBuiltinTexture(path: string | null | undefined, frameTexture?: THREE.Texture | null): THREE.Texture | null;
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
    /** 挂载带具名 RT 的效果计划：建具名 RT 池 + 清材质缓存。**只允许在加载期 / resize 重挂期调用**（帧内不得建 RT，§5.11）。
     *  材质与 1×1 探针编译不在本方法内 —— 仍由首个 update 帧的 getMaterial 懒建（帧内首次编译有停顿）。 */
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
    /** 纹理槽缓存清理：**只释放本实例加载的纹理**，跳过模块级共享纹理（`BUILTIN_CACHE` /
     *  `EMPTY_SLOT_CACHE` —— 其它 runner 仍在复用，误释放会让它们采样到已删除的纹理）。
     *  只 `.clear()` 不 dispose 会漏掉 `deleteTexture` ⇒ **同一 WebGL 上下文内**每次 resize 重挂链
     *  泄漏该壁纸全部效果槽纹理（真机实测 +28 张/次，见 AGENT.md §7.13）。 */
    private clearTextures;
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
    update(time: number, input: THREE.WebGLRenderTarget | THREE.Texture, frameTexture?: THREE.Texture | null): Promise<THREE.Texture | null>;
    lastOutput(): THREE.Texture | null;
    dispose(): void;
}
export declare function blendModeToThree(mode: string): THREE.Blending;
