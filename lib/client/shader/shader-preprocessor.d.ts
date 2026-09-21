export interface UniformAnnotation {
    name: string;
    type: string;
    annotation?: Record<string, unknown>;
}
export declare function extractUniformAnnotations(source: string): UniformAnnotation[];
export declare function extractIfIdentifiers(src: string): Set<string>;
export declare function extractComboDefaults(src: string): Map<string, number>;
export declare function reconcileVaryingDeclarations(rawVert: string, rawFrag: string): {
    vert: string;
    frag: string;
    warnings: string[];
};
export declare function normalizeFloatIntLiterals(src: string): string;
export declare function floatifyIntVarUses(src: string): string;
export declare function relaxGlsl3Strictness(src: string): string;
/** 用区段标记包住内置头文本（展开 include / 隐式注入时使用）。 */
export declare function markHeaderText(text: string): string;
/** 剥掉区段标记（最终源码不需要它们）。 */
export declare function stripHeaderMarks(text: string): string;
export declare function protectIntContexts(src: string): {
    text: string;
    restore: (s: string) => string;
};
/** GLSL3 严格化三连（normalize 补 .0 → floatify 包 float() → relax 去 const/改保留字）。
 *  F6 的 int 上下文跨度必须横跨 normalize 与 floatify（见 protectIntContexts），
 *  relax 在还原之后跑，保留它对保留字/const 的改写。 */
export declare function applyGlsl3StrictnessFixes(src: string): string;
export declare function preprocessWeShader(source: string, combos: Record<string, number>): string;
