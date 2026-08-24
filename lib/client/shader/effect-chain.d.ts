import { type UniformValue } from './uniform-binder.js';
export interface CompiledEffectPass {
    vertSrc: string;
    fragSrc: string;
    uniforms: Map<string, UniformValue>;
    textureSlots: (string | null)[];
    blendMode: string;
}
export declare function resolveEffectChain(sceneEffect: {
    file: string;
    passes?: unknown[];
}, loadFile: (name: string) => Promise<Uint8Array | null>): Promise<CompiledEffectPass[] | null>;
