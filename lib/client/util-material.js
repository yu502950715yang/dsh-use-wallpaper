// solid 取颜色+透明度；其余直通（颜色/透明度仍携带，供 Task 2 合成时使用）。
export function resolveUtilMaterial(layerKind, overrides = {}) {
    const color = overrides.color ?? [255, 255, 255];
    const opacity = typeof overrides.alpha === 'number' && Number.isFinite(overrides.alpha)
        ? Math.min(Math.max(overrides.alpha, 0), 1)
        : 1;
    return layerKind === 'solid'
        ? { layerKind, kind: 'solid', color, opacity }
        : { layerKind, kind: 'passthrough', color, opacity };
}
