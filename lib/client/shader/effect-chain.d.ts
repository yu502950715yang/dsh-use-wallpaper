import { type UniformValue } from './uniform-binder.js';
export interface CompiledEffectPass {
    vertSrc: string;
    fragSrc: string;
    rawVert: string;
    rawFrag: string;
    combos: Record<string, number>;
    uniforms: Map<string, UniformValue>;
    textureSlots: (string | null)[];
    samplerModes: Record<string, string>;
    samplerNames: string[];
    samplerDefaults?: Record<string, string>;
    blendMode: string;
    target: string | null;
    bind: {
        name: string;
        index: number;
    }[];
    fboScale: Record<string, number>;
}
export interface EffectChainOptions {
    /**
     * 内容输入是否是**整帧场景快照**（util 的 project/fullscreen/compose 层）。
     * 影响 Simple_Audio_Bars 的 BLENDMODE 分叉：快照内容用官方 mix(A,B)（否则 min 会把竖条染成背景色）；
     * image 层（内容=图层贴图）保留 v0.8.2 的 0→5（min）映射以取桌面 WE 的内容色。
     */
    contentIsSceneSnapshot?: boolean;
}
export declare function resolveEffectChain(sceneEffect: {
    file: string;
    passes?: unknown[];
}, loadFile: (name: string) => Promise<Uint8Array | null>, options?: EffectChainOptions): Promise<CompiledEffectPass[] | null>;
