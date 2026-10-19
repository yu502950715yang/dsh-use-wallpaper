/** 插件全部 localStorage 键（收藏 / 隐藏 / 最近使用）。 */
export const STORAGE_KEYS = { favorites: 'we:fav', hidden: 'we:hidden', recent: 'we:recent' };
function storeOf(store) {
    if (store)
        return store;
    return typeof localStorage !== 'undefined' ? localStorage : null;
}
export function loadJson(key, fallback, store) {
    const s = storeOf(store);
    if (!s)
        return fallback;
    try {
        const raw = s.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
/** 写入成功返回 true（配额满 / 隐私模式禁写返回 false，不抛）。 */
export function saveJson(key, value, store) {
    const s = storeOf(store);
    if (!s)
        return false;
    try {
        s.setItem(key, JSON.stringify(value));
        return true;
    }
    catch {
        return false;
    }
}
/** 读取字符串集合：非数组 / 非 string 元素一律丢弃。 */
export function loadStringSet(key, store) {
    const value = loadJson(key, [], store);
    const ids = Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];
    return new Set(ids);
}
export function saveStringSet(key, ids, store) {
    saveJson(key, [...new Set(ids)], store);
}
