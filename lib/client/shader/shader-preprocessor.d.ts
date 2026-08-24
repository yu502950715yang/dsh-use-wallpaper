export interface UniformAnnotation {
    name: string;
    type: string;
    annotation?: Record<string, unknown>;
}
export declare function extractUniformAnnotations(source: string): UniformAnnotation[];
export declare function preprocessWeShader(source: string, combos: Record<string, number>): string;
