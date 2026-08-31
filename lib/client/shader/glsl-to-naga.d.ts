import type { CompiledEffectPass } from './effect-chain.js';
export interface UniformBindingDesc {
    name: string;
    type: string;
    value: unknown;
    binding: number;
    offset?: number;
    size?: number;
    blockName?: string;
}
export interface NagaPassDesc {
    vertGlsl: string;
    fragGlsl: string;
    uniforms: UniformBindingDesc[];
    textureSlots: (string | null)[];
    blendMode: string;
}
export interface SpvPassDesc {
    vertSpv: Uint8Array;
    fragSpv: Uint8Array;
    uniforms: UniformBindingDesc[];
    textureSlots: (string | null)[];
    blendMode: string;
}
export interface Std140TypeInfo {
    align: number;
    size: number;
    count: number;
}
export declare function std140TypeInfo(typeStr: string): Std140TypeInfo | null;
export declare function glslToNagaGlsl(pass: CompiledEffectPass): NagaPassDesc;
export declare function glslToNagaPass(pass: CompiledEffectPass): Promise<SpvPassDesc>;
export declare function interStageLocationsMatch(vertGlsl: string, fragGlsl: string): boolean;
