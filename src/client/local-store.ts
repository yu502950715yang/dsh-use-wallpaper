// 浏览器侧 localStorage 封装：无存储环境（node/SSR）静默降级，损坏值回退 fallback。
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 插件全部 localStorage 键（收藏 / 隐藏 / 最近使用）。 */
export const STORAGE_KEYS = { favorites: 'we:fav', hidden: 'we:hidden', recent: 'we:recent' } as const;

function storeOf(store?: StorageLike): StorageLike | null {
  if (store) return store;
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

export function loadJson<T>(key: string, fallback: T, store?: StorageLike): T {
  const s = storeOf(store);
  if (!s) return fallback;
  try {
    const raw = s.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** 写入成功返回 true（配额满 / 隐私模式禁写返回 false，不抛）。 */
export function saveJson(key: string, value: unknown, store?: StorageLike): boolean {
  const s = storeOf(store);
  if (!s) return false;
  try {
    s.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** 读取字符串集合：非数组 / 非 string 元素一律丢弃。 */
export function loadStringSet(key: string, store?: StorageLike): Set<string> {
  const value = loadJson<unknown>(key, [], store);
  const ids = Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  return new Set(ids);
}

export function saveStringSet(key: string, ids: Iterable<string>, store?: StorageLike): void {
  saveJson(key, [...new Set(ids)], store);
}
