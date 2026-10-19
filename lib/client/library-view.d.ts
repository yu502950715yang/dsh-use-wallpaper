import type { WallpaperInfo, WallpaperKind } from '../shared/types.js';
export interface LibraryState {
    favorites: Set<string>;
    hidden: Set<string>;
    recent: Record<string, number>;
}
export interface LibraryFilter {
    query: string;
    types: ReadonlyArray<WallpaperKind>;
    favoritesOnly: boolean;
    showHidden: boolean;
    sort: 'default' | 'recent' | 'title';
}
export declare function loadLibraryState(): LibraryState;
export declare function saveLibraryState(s: LibraryState): void;
export declare function toggleFavorite(id: string, s?: LibraryState): LibraryState;
export declare function toggleHidden(id: string, s?: LibraryState): LibraryState;
export declare function markRecent(id: string, now?: number): void;
export declare function filterLibrary(list: WallpaperInfo[], f: LibraryFilter, s: LibraryState): WallpaperInfo[];
