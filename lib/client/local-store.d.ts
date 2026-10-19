export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
/** 插件全部 localStorage 键（收藏 / 隐藏 / 最近使用）。 */
export declare const STORAGE_KEYS: {
    readonly favorites: "we:fav";
    readonly hidden: "we:hidden";
    readonly recent: "we:recent";
};
export declare function loadJson<T>(key: string, fallback: T, store?: StorageLike): T;
/** 写入成功返回 true（配额满 / 隐私模式禁写返回 false，不抛）。 */
export declare function saveJson(key: string, value: unknown, store?: StorageLike): boolean;
/** 读取字符串集合：非数组 / 非 string 元素一律丢弃。 */
export declare function loadStringSet(key: string, store?: StorageLike): Set<string>;
export declare function saveStringSet(key: string, ids: Iterable<string>, store?: StorageLike): void;
