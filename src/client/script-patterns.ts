// src/client/script-patterns.ts —— WE 对象脚本内置模式识别（T3.3）
// WE scene 对象可携带 JS 脚本：image 对象的 visible.script（可见性/视觉脚本）、
// text 对象的 text.script（文本脚本）。完整 JS 引擎不在范围内——本模块只做
// 启发式模式识别 + scriptproperties 规范化 + 两种内置模式的纯逻辑（时钟文本生成）。
// 真实样本：2937346640 的 Simple Visualizer（visible.script，音频条）与
// VHS Time and Date（text.script，时钟文本），fixture 见 tests/fixtures/2937346640/。
import type { UserBindingRef } from '../shared/types.js';
import { parseUserRef } from './user-bindings.js';

// 视觉系脚本条数：脚本 `engine.registerAudioBuffers(64)` → 64 bin 频谱（与
// audio-input.ts 的 fftSize 128 → 64 bins 一致），渲染 64 条音频条。
export const VISUALIZER_BAR_COUNT = 64;

// 启发式识别（保持最小、可测试；fixture 已覆盖两个真实家族）：
//   visualizer：注册音频缓冲（registerAudioBuffers）+ 动态创建层（createLayer/
//     createLayerAsset）——Simple Visualizer 用 createLayer('models/bar.json') 造 64 条；
//   clock：new Date() + 月份数组（Jan./January 风格）+ 取时/分（getHours/getMinutes）
//     ——VHS Time and Date 即该形态；否则 null（静态对象，按 T3.1 原路径渲染）。
export function detectScriptPattern(src: string): 'visualizer' | 'clock' | null {
  if (typeof src !== 'string') return null;
  if (src.includes('registerAudioBuffers') && (src.includes('createLayer') || src.includes('createLayerAsset'))) {
    return 'visualizer';
  }
  if (src.includes('new Date()') && /Jan\.|January/.test(src) && (src.includes('getHours') || src.includes('getMinutes'))) {
    return 'clock';
  }
  return null;
}

// 规范化单条 scriptproperty：WE 的 { user, value } 包装保留为 { value, user }（T4 装配前再
// resolve 成标量）；无 user 的 { value } 包装仍解包；其余原样。非 WE 包装缺 value 键时也原样。
function unwrapScriptProperty(v: unknown): unknown {
  if (typeof v === 'object' && v !== null && !Array.isArray(v) && 'value' in v) {
    const o = v as { value?: unknown; user?: unknown };
    const user = parseUserRef(o.user);
    if (user) {
      const bound: { value: unknown; user: UserBindingRef } = { value: o.value, user };
      return bound;
    }
    return o.value;
  }
  return v;
}

// 规范化 WE scriptproperties JSON 对象（scene.json 已携带，直接读对象，不解析脚本源码）：
// 每条目可能为普通值或 { user, value } 包装 → 绑定保留 { value, user }，其余解包为内层值。
// 非对象输入（null/畸形）→ 空对象（渲染侧按缺省兜底，不抛错）。
export function parseScriptProperties(scriptProperties: unknown): Record<string, unknown> {
  if (typeof scriptProperties !== 'object' || scriptProperties === null || Array.isArray(scriptProperties)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(scriptProperties)) {
    out[key] = unwrapScriptProperty(value);
  }
  return out;
}

// 时钟文本月份数组（getMonth() 0 基索引），与 VHS Time and Date 脚本逐字一致。
const CLOCK_MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May.', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];

// 时钟文本生成（对齐 VHS Time and Date 脚本语义）：
//   24h：`HH:MM\nMon. D YYYY`（如 14:05\nAug. 21 2026）；
//   12h：`AM/PM HH:MM\nMon. D YYYY`（14 时 → PM 02:05；0 时 → AM 12:30，脚本 hours%=12 后 0→12）。
//   delimiter 取自 scriptProperties（缺省 ':'）；use24hFormat 缺省 true（脚本 addCheckbox 默认值）。
export function formatClockText(date: Date, props: Record<string, unknown>): string {
  const use24h = props.use24hFormat !== false;
  const delimiter = typeof props.delimiter === 'string' && props.delimiter ? props.delimiter : ':';
  const pad = (n: number) => ('00' + n).slice(-2);
  let hours = date.getHours();
  let meridiem = '';
  if (!use24h) {
    meridiem = hours < 12 ? 'AM' : 'PM';
    hours %= 12;
    if (hours === 0) hours = 12;
  }
  const timeLine = use24h
    ? `${pad(hours)}${delimiter}${pad(date.getMinutes())}`
    : `${meridiem} ${pad(hours)}${delimiter}${pad(date.getMinutes())}`;
  const dateLine = `${CLOCK_MONTHS[date.getMonth()]} ${date.getDate()} ${date.getFullYear()}`;
  return `${timeLine}\n${dateLine}`;
}

// ── 自定义 visualizer 家族（v0.9，真实样本 3118949804 / 3007895627）────────────────
// 与 Simple Visualizer 的区别：条数 / 间距 / 最小高度 / 条纹理路径由脚本 props 提供，
// 布局用对象自身 scale/angles（脚本 update 里按 thisLayer 计算）。
export type VisualizerFamily = 'simple' | 'pixel-bars';

export interface PixelBarLayout {
  count: number;
  barWidth: number;
  minBarHeight: number;
  scaleX: number;
  scaleY: number;
  barPath: string;
  downscaleMode: 'max' | 'average';
}

// 命中条件：registerAudioBuffers + createLayer（与 detectScriptPattern 同源），
// 且 props 带自定义家族字段（visualizerResolution / visualizerBarPath / minBarHeight）。
export function detectVisualizerFamily(
  src: string,
  props: Record<string, unknown>,
): VisualizerFamily | null {
  if (typeof src !== 'string') return null;
  if (!src.includes('registerAudioBuffers')) return null;
  if (!src.includes('createLayer') && !src.includes('createLayerAsset')) return null;
  if ('visualizerResolution' in props || 'visualizerBarPath' in props || 'minBarHeight' in props) {
    return 'pixel-bars';
  }
  return 'simple';
}

// pixel-bars 布局（对齐脚本 update/init 的公式与缺省值）：
//   count = visualizerResolution（clamp 2..64，缺省 64）
//   barWidth = scale.x / count × (1 − barSpacing)（世界单位；条纹理宽 1 时即世界宽）
//   minBarHeight = 静音时的世界高度倍率（世界高 = 条纹理高 × 倍率）
export function computePixelBarLayout(
  props: Record<string, unknown>,
  objectScale: [number, number, number],
): PixelBarLayout {
  const rawCount = Number(props.visualizerResolution);
  const count = Number.isFinite(rawCount) ? Math.min(64, Math.max(2, Math.round(rawCount))) : 64;
  const rawSpacing = Number(props.barSpacing);
  const spacing = Number.isFinite(rawSpacing) ? Math.min(1, Math.max(0, rawSpacing)) : 0.8;
  const rawMin = Number(props.minBarHeight);
  const minBarHeight = Number.isFinite(rawMin) ? Math.max(0, rawMin) : 2;
  const scaleX = Math.abs(Number(objectScale[0])) || 1;
  const scaleY = Math.abs(Number(objectScale[1])) || 1;
  return {
    count,
    barWidth: (scaleX / count) * (1 - spacing),
    minBarHeight,
    scaleX,
    scaleY,
    barPath: typeof props.visualizerBarPath === 'string' && props.visualizerBarPath
      ? props.visualizerBarPath
      : 'models/full-pixel.json',
    downscaleMode: props.downscaleMode === 'average' ? 'average' : 'max',
  };
}
