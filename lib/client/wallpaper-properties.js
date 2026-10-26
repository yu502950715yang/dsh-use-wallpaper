import { getUserPropertyValue, USERPROP_PREFIX } from './settings.js';
/** GET /wallpapers/properties?id=…：失败/畸形响应一律空属性 + audioProcessing=false（面板不渲染 section）。 */
export async function fetchWallpaperProperties(id) {
    try {
        const r = await fetch(`/wallpapers/properties?id=${encodeURIComponent(id)}`);
        if (!r.ok)
            return { properties: [], audioProcessing: false };
        const body = (await r.json());
        return {
            properties: Array.isArray(body?.properties) ? body.properties : [],
            audioProcessing: body?.audioProcessing === true,
        };
    }
    catch {
        return { properties: [], audioProcessing: false };
    }
}
/** 读用户属性（四类型标量）；传壁纸 id 时 per-id 键优先，缺失回退旧全局键。 */
export function readUserProperty(key, wallpaperId) {
    return getUserPropertyValue(key, wallpaperId);
}
/** 写用户属性（JSON 标量）；无 localStorage/配额满/隐私模式时静默。 */
export function writeUserProperty(key, value, wallpaperId) {
    if (typeof localStorage === 'undefined')
        return;
    try {
        localStorage.setItem(userPropertyKey(key, wallpaperId), JSON.stringify(value));
    }
    catch {
        // 配额满/隐私模式：与 local-store 的 saveJson 同策略，不向面板抛错
    }
}
/** 恢复默认：只删 per-id 覆盖键；无 id 时不动作（旧全局键是迁移回退，删了会影响所有壁纸）。 */
export function resetUserProperty(key, wallpaperId) {
    if (!wallpaperId)
        return;
    if (typeof localStorage === 'undefined')
        return;
    try {
        localStorage.removeItem(userPropertyKey(key, wallpaperId));
    }
    catch {
        // 存储不可用：静默，重装配时读回默认值
    }
}
function userPropertyKey(key, wallpaperId) {
    return wallpaperId ? `${USERPROP_PREFIX}${wallpaperId}:${key}` : USERPROP_PREFIX + key;
}
/** 兼容旧调用：只认布尔（四类型写入的 number/string 不误当 bool）。 */
export function readBoolProperty(key, wallpaperId) {
    const value = readUserProperty(key, wallpaperId);
    return typeof value === 'boolean' ? value : undefined;
}
/** 兼容旧调用：转调四类型写入。 */
export function writeBoolProperty(key, value, wallpaperId) {
    writeUserProperty(key, value, wallpaperId);
}
