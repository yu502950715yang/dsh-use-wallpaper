// v0.8.2 F13：WE image alignment 的锚点 → 中心偏移（纯函数，image/text 共用口径）。
// origin 是锚点；与 WE `WPImageAlignment.hpp::ResolveImageAlignmentOffset` 及 textLayerOffset 同向。
export function alignOffset(
  worldW: number,
  worldH: number,
  alignment?: string,
): { x: number; y: number } {
  const a = typeof alignment === 'string' ? alignment.toLowerCase() : '';
  const half = (v: number): number => (Number.isFinite(v) ? Math.abs(v) / 2 : 0);
  const w = half(worldW);
  const h = half(worldH);
  return {
    x: a.includes('left') ? w : a.includes('right') ? -w : 0,
    y: a.includes('top') ? -h : a.includes('bottom') ? h : 0,
  };
}
