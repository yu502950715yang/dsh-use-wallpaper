import type { SceneDescription, UserBindingRef } from '../shared/types.js';
export { parseUserRef } from '../shared/user-refs.js';
/** 真值：布尔原样；数值非零（容差 1e-4）；字符串非空且非 "0"/"false"。 */
export declare function isTruthy(value: unknown): boolean;
/**
 * 绑定侧 condition 匹配（we-layerd 语义）：空 = 真值判定；
 * bool 的数值条件 0=开、1=关，数值/字符串按容差/精确比较。
 */
export declare function matchCondition(value: unknown, condition: string | undefined): boolean;
/** 颜色三元组：分量 max ≤ 1 视为 0-1 语义乘以 255，否则按 0-255 原样。 */
export declare function parseColorTriplet(text: string): [number, number, number] | undefined;
/**
 * 解析绑定值：无绑定/属性缺失 → 作者静态值；condition 不匹配 → 中性零值；
 * 匹配 → 用户值按 hint 归一化（bool / number / color 0-255 三元组 / color01 0-1 原串）。
 */
export declare function resolveUserValue<T>(bound: {
    value: T;
    user?: UserBindingRef;
}, userProps: Record<string, unknown>, hint: 'bool' | 'number' | 'color' | 'color01'): T;
/** 属性级 condition：空/畸形一律满足（失败开放），避免面板误隐藏属性。 */
export declare function propertyConditionMet(condition: string | undefined, userProps: Record<string, unknown>): boolean;
export declare function resolveSceneUserBindings(desc: SceneDescription, userProps: Record<string, unknown>): SceneDescription;
