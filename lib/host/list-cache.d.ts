import type { WallpaperInfo } from '../shared/types.js';
/** 一次列表读取的结果：列表 + 弱 ETag。 */
export interface WallpaperListResult {
    list: WallpaperInfo[];
    etag: string;
}
export interface WallpaperListGetOptions {
    /** 强制重扫（「刷新」按钮用） */
    refresh?: boolean;
}
export interface WallpaperListCache {
    get(dir: string, opts?: WallpaperListGetOptions): Promise<WallpaperListResult>;
}
export declare function createWallpaperListCache(): WallpaperListCache;
