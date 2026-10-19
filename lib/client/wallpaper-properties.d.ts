import type { WallpaperUserProperty } from '../shared/types.js';
/** GET /wallpapers/properties?id=…：失败/畸形响应一律空数组（面板不渲染 section）。 */
export declare function fetchWallpaperProperties(id: string): Promise<WallpaperUserProperty[]>;
/** 读用户布尔值（传壁纸 id 时优先 per-wallpaper 键）；缺失/坏 JSON/非 boolean → undefined。 */
export declare function readBoolProperty(key: string, wallpaperId?: string): boolean | undefined;
/** 写用户布尔值（传壁纸 id 时写 per-wallpaper 键）；无 localStorage/禁写时静默。 */
export declare function writeBoolProperty(key: string, value: boolean, wallpaperId?: string): void;
