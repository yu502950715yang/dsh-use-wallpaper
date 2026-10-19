// v0.8 壁纸用户属性（仅布尔可见性）：拉取面板数据 + localStorage 读写。
// 存储键按壁纸隔离（we:userprop:<wallpaperId>:<key>，JSON 值）；读侧缺键回退旧全局键
// （迁移兼容），无 id 时保持旧行为。渲染器重装配时按 id 读取。
import type { WallpaperUserProperty } from '../shared/types.js';
import { getUserPropertyValue, USERPROP_PREFIX } from './settings.js';

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

/** 读用户布尔值（传壁纸 id 时优先 per-wallpaper 键）；缺失/坏 JSON/非 boolean → undefined。 */
export function readBoolProperty(key: string, wallpaperId?: string): boolean | undefined {
  const value = getUserPropertyValue(key, wallpaperId);
  return typeof value === 'boolean' ? value : undefined;
}

/** 写用户布尔值（传壁纸 id 时写 per-wallpaper 键）；无 localStorage/禁写时静默。 */
export function writeBoolProperty(key: string, value: boolean, wallpaperId?: string): void {
  if (typeof localStorage === 'undefined') return;
  const storageKey = wallpaperId
    ? `${USERPROP_PREFIX}${wallpaperId}:${key}`
    : USERPROP_PREFIX + key;
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // 配额满/隐私模式：与 local-store 的 saveJson 同策略，不向面板抛错
  }
}
