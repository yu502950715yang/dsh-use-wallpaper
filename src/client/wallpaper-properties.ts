// v0.8 壁纸用户属性（v0.9 四类型）：拉取面板数据 + localStorage 读写与恢复默认。
// 存储键按壁纸隔离（we:userprop:<wallpaperId>:<key>，JSON 标量）；读侧缺键回退旧全局键
// （迁移兼容），无 id 读写沿用旧全局键，reset 无 id 不动作（不删迁移回退）。渲染器按 id 读取。
import type { UserPropertyValue, WallpaperUserProperty } from '../shared/types.js';
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

/** 读用户属性（四类型标量）；传壁纸 id 时 per-id 键优先，缺失回退旧全局键。 */
export function readUserProperty(key: string, wallpaperId?: string): UserPropertyValue | undefined {
  return getUserPropertyValue(key, wallpaperId);
}

/** 写用户属性（JSON 标量）；无 localStorage/配额满/隐私模式时静默。 */
export function writeUserProperty(key: string, value: UserPropertyValue, wallpaperId?: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(userPropertyKey(key, wallpaperId), JSON.stringify(value));
  } catch {
    // 配额满/隐私模式：与 local-store 的 saveJson 同策略，不向面板抛错
  }
}

/** 恢复默认：只删 per-id 覆盖键；无 id 时不动作（旧全局键是迁移回退，删了会影响所有壁纸）。 */
export function resetUserProperty(key: string, wallpaperId?: string): void {
  if (!wallpaperId) return;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(userPropertyKey(key, wallpaperId));
  } catch {
    // 存储不可用：静默，重装配时读回默认值
  }
}

function userPropertyKey(key: string, wallpaperId?: string): string {
  return wallpaperId ? `${USERPROP_PREFIX}${wallpaperId}:${key}` : USERPROP_PREFIX + key;
}

/** 兼容旧调用：只认布尔（四类型写入的 number/string 不误当 bool）。 */
export function readBoolProperty(key: string, wallpaperId?: string): boolean | undefined {
  const value = readUserProperty(key, wallpaperId);
  return typeof value === 'boolean' ? value : undefined;
}

/** 兼容旧调用：转调四类型写入。 */
export function writeBoolProperty(key: string, value: boolean, wallpaperId?: string): void {
  writeUserProperty(key, value, wallpaperId);
}
