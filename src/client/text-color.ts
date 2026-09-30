// src/client/text-color.ts —— 贴壁纸文字的颜色与描边（纯逻辑，node 可测）
// 「文字看不清」的手动解法（2026-10-01）：设置面板给用户选文字色（自动/白/黑/自定义），
// 并可选文字描边（对立色阴影）——描边与背景无关，是亮暗差异大的壁纸上最有效的一层。
// 「自动」= 沿用既有 preview 图亮度测量（见 luma.ts），故本模块只管手动档与描边值生成。

/** 文字颜色模式：auto = 跟随壁纸亮度测量；其余为手动固定。 */
export type TextColorMode = 'auto' | 'white' | 'black' | 'custom';

export const TEXT_COLOR_MODES: readonly TextColorMode[] = ['auto', 'white', 'black', 'custom'];

/** 手动「白色」：纯白（不用 luma 的 #f9fafb——用户选的档位要所见即所得）。 */
export const MANUAL_WHITE = '#ffffff';
/** 手动「黑色」：纯黑。 */
export const MANUAL_BLACK = '#000000';

/** 描边档位上限（0 = 关；1-3 递增）。 */
export const TEXT_OUTLINE_MAX = 3;
/** 文字色亮度达到此值时配深色描边（亮字配暗边），否则配浅色描边。 */
export const OUTLINE_FLIP_LUMA = 140;

/** 归一化任意输入为合法模式（未知/缺省 → auto，即保持既有行为）。 */
export function normalizeMode(raw: unknown): TextColorMode {
  return typeof raw === 'string' && (TEXT_COLOR_MODES as readonly string[]).includes(raw)
    ? (raw as TextColorMode)
    : 'auto';
}

/** 校验颜色：只认 #rgb / #rrggbb；非法值回退 fallback（防任意串写进 CSS 变量）。 */
export function normalizeHexColor(raw: unknown, fallback: string = MANUAL_WHITE): string {
  if (typeof raw !== 'string') return fallback;
  const v = raw.trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v.toLowerCase() : fallback;
}

/**
 * 手动档位的最终文字色；auto → null（表示「交给 preview 亮度测量」，调用方据此走 luma）。
 * white/black/custom 均返回可直接写进 --wp-chat-fg 的 hex。
 */
export function manualTextColor(mode: unknown, custom: unknown): string | null {
  switch (normalizeMode(mode)) {
    case 'white': return MANUAL_WHITE;
    case 'black': return MANUAL_BLACK;
    case 'custom': return normalizeHexColor(custom, MANUAL_WHITE);
    default: return null;
  }
}

/** #rgb/#rrggbb → 0-255 感知亮度（Rec.601，与 luma.averageLuma 同口径）。 */
export function hexLuma(hex: string): number {
  const v = normalizeHexColor(hex, '#000000');
  const full = v.length === 4 ? '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3] : v;
  const r = parseInt(full.slice(1, 3), 16);
  const g = parseInt(full.slice(3, 5), 16);
  const b = parseInt(full.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** 描边档位归一化：非数值 → 0；四舍五入并钳到 [0, TEXT_OUTLINE_MAX]。 */
export function normalizeOutlineLevel(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(TEXT_OUTLINE_MAX, Math.max(0, Math.round(n)));
}

/**
 * 描边档位 → `text-shadow` 值（多个方向的模糊阴影，视觉上等同描边）。
 * 0 档返回 null（调用方移除变量 = 无阴影，保持既有观感）。
 * 注意：只作用于「贴壁纸的透明文字」——实底按钮/卡片加阴影会发脏（项目既有教训）。
 */
export function outlineShadow(color: string, level: unknown): string | null {
  const lv = normalizeOutlineLevel(level);
  if (lv === 0) return null;
  const c = hexLuma(color) >= OUTLINE_FLIP_LUMA ? 'rgba(0,0,0,.78)' : 'rgba(255,255,255,.9)';
  if (lv === 1) return `0 1px 2px ${c}`;
  if (lv === 2) return `0 0 2px ${c},0 1px 3px ${c}`;
  return `0 0 2px ${c},0 0 4px ${c},0 1px 4px ${c}`;
}

/** 描边档位 → 设置面板上的文案。 */
export function outlineLabel(level: unknown): string {
  const lv = normalizeOutlineLevel(level);
  return lv === 0 ? '关' : lv === 1 ? '轻' : lv === 2 ? '中' : '强';
}
