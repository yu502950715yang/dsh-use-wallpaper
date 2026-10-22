import type { UtilLayerKind } from '../shared/types.js';
/** util 层内置材质：solid 为纯色 quad，其余为直通（真实观感由效果链/合成叠加产生）。 */
export interface UtilMaterialSpec {
    layerKind: UtilLayerKind;
    kind: 'passthrough' | 'solid';
    color: [number, number, number];
    opacity: number;
}
export declare function resolveUtilMaterial(layerKind: UtilLayerKind, overrides?: {
    color?: [number, number, number];
    alpha?: number;
}): UtilMaterialSpec;
