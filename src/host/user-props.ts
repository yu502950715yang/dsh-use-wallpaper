// host 侧用户属性聚合：project.json 的 general.properties ∩ scene.json 中被 {user} 引用的键。
import type { WallpaperUserProperty } from '../shared/types.js';
import { parseUserRef } from '../client/user-bindings.js';

const ORDER = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
const TYPES = new Set(['bool', 'slider', 'color', 'combo']);

const numberOr = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const optionalNumber = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** 把 {user} 节点的父路径归一为稳定的 usedBy 标签（去掉数组下标）。 */
function normalizeRefPath(path: string[]): string {
  const full = path.filter(Boolean).join('.');
  if (!full) return 'scene';
  if (!full.startsWith('objects[]')) return full; // general.bloom / general.cameraparallax…
  const rest = full.slice('objects[].'.length);
  if (!rest) return 'objects[]';
  if (rest.startsWith('effects[].passes[].constantshadervalues')) return 'objects[].effects[].passes[].constantshadervalues';
  if (rest.startsWith('effects[].visible')) return 'objects[].effects[].visible';
  if (rest.startsWith('effects[]')) return 'objects[].effects[]';
  if (rest.startsWith('visible.scriptproperties')) return 'objects[].visible.scriptproperties';
  if (rest.startsWith('text.scriptproperties')) return 'objects[].text.scriptproperties';
  if (rest.startsWith('instanceoverride')) return 'objects[].instanceoverride';
  return `objects[].${rest.split('.')[0]}`; // 对象直接字段：color / alpha / origin…
}

/** 递归扫描 scene，记录每个 user 绑定键 → 引用路径集合；绑定节点不再下钻。 */
function collectUsedBy(node: unknown, path: string[], usedBy: Map<string, Set<string>>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectUsedBy(item, path, usedBy);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const obj = node as Record<string, unknown>;
  const ref = parseUserRef(obj.user);
  if (ref) {
    let labels = usedBy.get(ref.name);
    if (!labels) {
      labels = new Set<string>();
      usedBy.set(ref.name, labels);
    }
    labels.add(normalizeRefPath(path));
    return;
  }
  for (const [key, value] of Object.entries(obj)) {
    collectUsedBy(value, [...path, Array.isArray(value) ? `${key}[]` : key], usedBy);
  }
}

function readOptions(raw: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string; value: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as { label?: unknown; value?: unknown };
    const value = typeof o.value === 'string' ? o.value : String(o.value ?? '');
    out.push({ label: typeof o.label === 'string' ? o.label : value, value });
  }
  return out;
}

/** 把一条 project.json 属性定义转成面板属性（类型专属字段按白色名单取）。 */
function toProperty(key: string, raw: unknown, usedBy: Set<string>): WallpaperUserProperty | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const def = raw as Record<string, unknown>;
  if (def.editable === false || typeof def.type !== 'string' || !TYPES.has(def.type)) return undefined;

  const condition = typeof def.condition === 'string' && def.condition.trim() ? def.condition : undefined;
  const base = {
    key,
    label: stripHtml(typeof def.text === 'string' ? def.text : '') || key,
    order: ORDER(def.order),
    usedBy: [...usedBy],
    ...(condition !== undefined ? { condition } : {}),
  };

  if (def.type === 'bool') return { ...base, type: 'bool', value: Boolean(def.value) };
  if (def.type === 'slider') {
    const min = numberOr(def.min, 0);
    const step = optionalNumber(def.step);
    const precision = optionalNumber(def.precision);
    return {
      ...base,
      type: 'slider',
      value: numberOr(def.value, min),
      min,
      max: numberOr(def.max, 1),
      ...(step !== undefined ? { step } : {}),
      ...(precision !== undefined ? { precision } : {}),
      ...(typeof def.fraction === 'boolean' ? { fraction: def.fraction } : {}),
    };
  }
  if (def.type === 'color') return { ...base, type: 'color', value: typeof def.value === 'string' ? def.value : '' };
  return {
    ...base,
    type: 'combo',
    value: typeof def.value === 'string' ? def.value : String(def.value ?? ''),
    options: readOptions(def.options),
  };
}

/** 聚合被 scene 引用的 bool/slider/color/combo 属性；坏 JSON / 缺字段返回 []，不抛。 */
export function collectUserProperties(project: unknown, scene: unknown): WallpaperUserProperty[] {
  const props = (project as { general?: { properties?: unknown } } | null)?.general?.properties;
  if (typeof props !== 'object' || props === null || Array.isArray(props)) return [];

  const usedBy = new Map<string, Set<string>>();
  collectUsedBy(scene, [], usedBy);
  if (usedBy.size === 0) return [];

  const out: WallpaperUserProperty[] = [];
  for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
    const labels = usedBy.get(key);
    if (!labels || labels.size === 0) continue;
    const prop = toProperty(key, raw, labels);
    if (prop) out.push(prop);
  }
  // order 浮点升序；同序按 key 码位（UTF-16 code unit）升序
  out.sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/** v0.8 旧接口（仅测试使用）：只保留 bool 子集，避免既有调用与测试破坏。 */
export function collectVisibleBoolProperties(project: unknown, scene: unknown): WallpaperUserProperty[] {
  return collectUserProperties(project, scene).filter((p) => p.type === 'bool');
}
