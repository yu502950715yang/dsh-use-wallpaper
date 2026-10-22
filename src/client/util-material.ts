import type { UtilLayerKind } from '../shared/types.js';

/** util 层内置材质：solid 为纯色 quad，其余为直通（真实观感由效果链/合成叠加产生）。 */
export interface UtilMaterialSpec {
  layerKind: UtilLayerKind;
  kind: 'passthrough' | 'solid';
  color: [number, number, number];
  opacity: number;
}

// solid 取颜色+透明度；其余直通（颜色/透明度仍携带，供 Task 2 合成时使用）。
export function resolveUtilMaterial(
  layerKind: UtilLayerKind,
  overrides: { color?: [number, number, number]; alpha?: number } = {},
): UtilMaterialSpec {
  const color = overrides.color ?? [255, 255, 255];
  const opacity = typeof overrides.alpha === 'number' && Number.isFinite(overrides.alpha)
    ? Math.min(Math.max(overrides.alpha, 0), 1)
    : 1;
  return layerKind === 'solid'
    ? { layerKind, kind: 'solid', color, opacity }
    : { layerKind, kind: 'passthrough', color, opacity };
}
