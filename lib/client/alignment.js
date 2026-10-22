// v0.8.2 F13：WE image alignment 的锚点 → 中心偏移（纯函数，image/text 共用口径）。
// origin 是锚点（命名边/角钉在 origin），返回「锚点 → 中心」的偏移；与 WE
// `WPImageAlignment.hpp::ResolveImageAlignmentOffset` 同向，也与 textLayerOffset 的 anchor 一致。
export function alignOffset(worldW, worldH, alignment) {
    const a = typeof alignment === 'string' ? alignment.toLowerCase() : '';
    const half = (v) => (Number.isFinite(v) ? Math.abs(v) / 2 : 0);
    const w = half(worldW);
    const h = half(worldH);
    return {
        x: a.includes('left') ? w : a.includes('right') ? -w : 0,
        y: a.includes('top') ? -h : a.includes('bottom') ? h : 0,
    };
}
