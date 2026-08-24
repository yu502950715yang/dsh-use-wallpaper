import type { WallpaperInfo, WallpaperKind } from '../shared/types.js';
export declare function kindFromProjectJson(pj: Record<string, unknown>): WallpaperKind;
export declare function scanWallpapers(dir: string): Promise<WallpaperInfo[]>;
