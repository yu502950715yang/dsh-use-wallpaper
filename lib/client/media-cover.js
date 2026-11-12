/**
 * 本次同步需要改写的「对象 → 采样纹理」列表。
 * 无默认图的目标跳过：其 map 恒为共享封面纹理，随 `setImage` 自动更新（旧行为）。
 */
export function mediaCoverSwitches(input) {
    const { targets, thumbnail, hasThumbnail } = input;
    const out = [];
    for (const t of targets) {
        if (!t.fallback)
            continue;
        out.push({ objectId: t.objectId, texture: hasThumbnail ? (thumbnail ?? t.fallback) : t.fallback });
    }
    return out;
}
