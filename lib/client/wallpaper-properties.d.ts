import type { WallpaperUserProperty } from '../shared/types.js';
/** GET /wallpapers/properties?id=…：失败/畸形响应一律空数组（面板不渲染 section）。 */
export declare function fetchWallpaperProperties(id: string): Promise<WallpaperUserProperty[]>;
/** 读用户布尔值；键缺失/坏 JSON/非 boolean → undefined（渲染器回退壁纸默认 value）。 */
export declare function readBoolProperty(key: string): boolean | undefined;
/** 写用户布尔值；无 localStorage（node/SSR）/禁写（隐私模式）时静默。 */
export declare function writeBoolProperty(key: string, value: boolean): void;
