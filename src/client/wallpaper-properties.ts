// v0.8 壁纸用户属性（仅布尔可见性）：拉取面板数据 + localStorage 读写。
// 存储键与 getUserPropertyValue 一致（we:userprop:<key>，JSON 值）；渲染器重装配时读取。
import type { WallpaperUserProperty } from '../shared/types.js';
import { getUserPropertyValue } from './settings.js';

const USERPROP_PREFIX = 'we:userprop:';

/** GET /wallpapers/properties?id=…：失败/畸形响应一律空数组（面板不渲染 section）。 */
export async function fetchWallpaperProperties(id: string): Promise<WallpaperUserProperty[]> {
  try {
    const r = await fetch(`/wallpapers/properties?id=${encodeURIComponent(id)}`);
    if (!r.ok) return [];
    const body = (await r.json()) as { properties?: unknown } | null;
    return Array.isArray(body?.properties) ? (body.properties as WallpaperUserProperty[]) : [];
  } catch {
    return [];
  }
}

/** 读用户布尔值；键缺失/坏 JSON/非 boolean → undefined（渲染器回退壁纸默认 value）。 */
export function readBoolProperty(key: string): boolean | undefined {
  const value = getUserPropertyValue(key);
  return typeof value === 'boolean' ? value : undefined;
}

/** 写用户布尔值；无 localStorage（node/SSR）/禁写（隐私模式）时静默。 */
export function writeBoolProperty(key: string, value: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(USERPROP_PREFIX + key, JSON.stringify(value));
  } catch {
    // 配额满/隐私模式：与 local-store 的 saveJson 同策略，不向面板抛错
  }
}
