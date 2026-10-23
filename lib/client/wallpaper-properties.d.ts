import type { UserPropertyValue, WallpaperUserProperty } from '../shared/types.js';
/** GET /wallpapers/properties?id=…：失败/畸形响应一律空数组（面板不渲染 section）。 */
export declare function fetchWallpaperProperties(id: string): Promise<WallpaperUserProperty[]>;
/** 读用户属性（四类型标量）；传壁纸 id 时 per-id 键优先，缺失回退旧全局键。 */
export declare function readUserProperty(key: string, wallpaperId?: string): UserPropertyValue | undefined;
/** 写用户属性（JSON 标量）；无 localStorage/配额满/隐私模式时静默。 */
export declare function writeUserProperty(key: string, value: UserPropertyValue, wallpaperId?: string): void;
/** 恢复默认：只删 per-id 覆盖键；无 id 时不动作（旧全局键是迁移回退，删了会影响所有壁纸）。 */
export declare function resetUserProperty(key: string, wallpaperId?: string): void;
/** 兼容旧调用：只认布尔（四类型写入的 number/string 不误当 bool）。 */
export declare function readBoolProperty(key: string, wallpaperId?: string): boolean | undefined;
/** 兼容旧调用：转调四类型写入。 */
export declare function writeBoolProperty(key: string, value: boolean, wallpaperId?: string): void;
