import type { UniformAnnotation } from './shader-preprocessor.js';
export type UniformValue = number | number[];
export declare function isAudioUniform(name: string): boolean;
export declare function resolveUniformBindings(annotations: UniformAnnotation[], constants: Record<string, unknown>): Map<string, UniformValue>;
