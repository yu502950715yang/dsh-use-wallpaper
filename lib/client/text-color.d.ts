/** 文字颜色模式：auto = 跟随壁纸亮度测量；其余为手动固定。 */
export type TextColorMode = 'auto' | 'white' | 'black' | 'custom';
export declare const TEXT_COLOR_MODES: readonly TextColorMode[];
/** 手动「白色」：纯白（不用 luma 的 #f9fafb——用户选的档位要所见即所得）。 */
export declare const MANUAL_WHITE = "#ffffff";
/** 手动「黑色」：纯黑。 */
export declare const MANUAL_BLACK = "#000000";
/** 描边档位上限（0 = 关；1-3 递增）。 */
export declare const TEXT_OUTLINE_MAX = 3;
/** 文字色亮度达到此值时配深色描边（亮字配暗边），否则配浅色描边。 */
export declare const OUTLINE_FLIP_LUMA = 140;
/** 归一化任意输入为合法模式（未知/缺省 → auto，即保持既有行为）。 */
export declare function normalizeMode(raw: unknown): TextColorMode;
/** 校验颜色：只认 #rgb / #rrggbb；非法值回退 fallback（防任意串写进 CSS 变量）。 */
export declare function normalizeHexColor(raw: unknown, fallback?: string): string;
/**
 * 手动档位的最终文字色；auto → null（表示「交给 preview 亮度测量」，调用方据此走 luma）。
 * white/black/custom 均返回可直接写进 --wp-chat-fg 的 hex。
 */
export declare function manualTextColor(mode: unknown, custom: unknown): string | null;
/** #rgb/#rrggbb → 0-255 感知亮度（Rec.601，与 luma.averageLuma 同口径）。 */
export declare function hexLuma(hex: string): number;
/** 描边档位归一化：非数值 → 0；四舍五入并钳到 [0, TEXT_OUTLINE_MAX]。 */
export declare function normalizeOutlineLevel(raw: unknown): number;
/**
 * 描边档位 → `text-shadow` 值（多个方向的模糊阴影，视觉上等同描边）。
 * 0 档返回 null（调用方移除变量 = 无阴影，保持既有观感）。
 * 注意：只作用于「贴壁纸的透明文字」——实底按钮/卡片加阴影会发脏（项目既有教训）。
 */
export declare function outlineShadow(color: string, level: unknown): string | null;
/** 描边档位 → 设置面板上的文案。 */
export declare function outlineLabel(level: unknown): string;
