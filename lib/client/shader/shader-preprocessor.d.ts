export interface UniformAnnotation {
    name: string;
    type: string;
    annotation?: Record<string, unknown>;
}
export declare function extractUniformAnnotations(source: string): UniformAnnotation[];
export declare function extractIfIdentifiers(src: string): Set<string>;
export declare function extractComboDefaults(src: string): Map<string, number>;
export declare function normalizeFloatIntLiterals(src: string): string;
export declare function floatifyIntVarUses(src: string): string;
export declare function relaxGlsl3Strictness(src: string): string;
export declare function preprocessWeShader(source: string, combos: Record<string, number>): string;
