import { getUserPropertyValue, USERPROP_PREFIX } from './settings.js';
/** GET /wallpapers/properties?id=…：失败/畸形响应一律空数组（面板不渲染 section）。 */
export async function fetchWallpaperProperties(id) {
    try {
        const r = await fetch(`/wallpapers/properties?id=${encodeURIComponent(id)}`);
        if (!r.ok)
            return [];
        const body = (await r.json());
        return Array.isArray(body?.properties) ? body.properties : [];
    }
    catch {
        return [];
    }
}
/** 读用户布尔值（传壁纸 id 时优先 per-wallpaper 键）；缺失/坏 JSON/非 boolean → undefined。 */
export function readBoolProperty(key, wallpaperId) {
    const value = getUserPropertyValue(key, wallpaperId);
    return typeof value === 'boolean' ? value : undefined;
}
/** 写用户布尔值（传壁纸 id 时写 per-wallpaper 键）；无 localStorage/禁写时静默。 */
export function writeBoolProperty(key, value, wallpaperId) {
    if (typeof localStorage === 'undefined')
        return;
    const storageKey = wallpaperId
        ? `${USERPROP_PREFIX}${wallpaperId}:${key}`
        : USERPROP_PREFIX + key;
    try {
        localStorage.setItem(storageKey, JSON.stringify(value));
    }
    catch {
        // 配额满/隐私模式：与 local-store 的 saveJson 同策略，不向面板抛错
    }
}
