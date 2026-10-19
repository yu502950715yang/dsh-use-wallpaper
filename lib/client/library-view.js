import { STORAGE_KEYS, loadJson, loadStringSet, saveJson, saveStringSet } from './local-store.js';
/** 「最近使用」最多保留的条数（超出按时间戳倒序淘汰最旧的）。 */
const RECENT_LIMIT = 200;
// recent 必须是「id → 时间戳」普通对象；存储里是 'null' / 数组 / 标量时一律回退空表。
function loadRecent() {
    const value = loadJson(STORAGE_KEYS.recent, {});
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
    return value;
}
export function loadLibraryState() {
    return {
        favorites: loadStringSet(STORAGE_KEYS.favorites),
        hidden: loadStringSet(STORAGE_KEYS.hidden),
        recent: loadRecent(),
    };
}
export function saveLibraryState(s) {
    saveStringSet(STORAGE_KEYS.favorites, s.favorites);
    saveStringSet(STORAGE_KEYS.hidden, s.hidden);
    saveJson(STORAGE_KEYS.recent, s.recent);
}
// 反转收藏并返回新状态（不改入参：React 状态要新对象才会重渲染）。
// 只写被改的键：面板里的 recent 是挂载时读的，整表回写会覆盖 index.ts 刚记的最近使用。
export function toggleFavorite(id, s = loadLibraryState()) {
    const favorites = new Set(s.favorites);
    if (favorites.has(id))
        favorites.delete(id);
    else
        favorites.add(id);
    saveStringSet(STORAGE_KEYS.favorites, favorites);
    return { ...s, favorites };
}
export function toggleHidden(id, s = loadLibraryState()) {
    const hidden = new Set(s.hidden);
    if (hidden.has(id))
        hidden.delete(id);
    else
        hidden.add(id);
    saveStringSet(STORAGE_KEYS.hidden, hidden);
    return { ...s, hidden };
}
// 记录一次使用：更新时间戳，按时间戳倒序只保留最近 RECENT_LIMIT 条；空 id（取消壁纸）不记录。
export function markRecent(id, now = Date.now()) {
    if (!id)
        return;
    const recent = loadRecent();
    recent[id] = now;
    const kept = Object.entries(recent).sort(([, a], [, b]) => b - a).slice(0, RECENT_LIMIT);
    saveJson(STORAGE_KEYS.recent, Object.fromEntries(kept));
}
export function filterLibrary(list, f, s) {
    const q = f.query.trim().toLowerCase();
    let out = list.filter((w) => {
        if (!f.showHidden && s.hidden.has(w.id))
            return false;
        if (f.favoritesOnly && !s.favorites.has(w.id))
            return false;
        if (f.types.length > 0 && !f.types.includes(w.type))
            return false;
        return q === '' || w.title.toLowerCase().includes(q);
    });
    // 默认排序保持入参顺序；recent 缺省时间戳视为 0（排后），同分由稳定排序保持原序。
    if (f.sort === 'recent')
        out = [...out].sort((a, b) => (s.recent[b.id] ?? 0) - (s.recent[a.id] ?? 0));
    if (f.sort === 'title')
        out = [...out].sort((a, b) => a.title.localeCompare(b.title));
    return out;
}
