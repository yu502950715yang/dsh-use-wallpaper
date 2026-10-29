import type { UserBindingRef } from './types.js';
/** 绑定引用归一化：字符串 → {name}；对象取非空 name + 字符串 condition；缺失/畸形 → undefined。 */
export declare function parseUserRef(user: unknown): UserBindingRef | undefined;
