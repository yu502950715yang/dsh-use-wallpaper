// host/client 共用的用户属性引用解析（纯函数、零依赖）：scene 的 `{user, condition}` 归一化。
// 放在 shared 的原因：host 侧 `user-props.ts` 也要解析同一份引用；此前 host 直接 import client 模块，
// 违反分层（见 `scripts/verify-arch.mjs` 的 host/client 边界规则）。
import type { UserBindingRef } from './types.js';

/** 绑定引用归一化：字符串 → {name}；对象取非空 name + 字符串 condition；缺失/畸形 → undefined。 */
export function parseUserRef(user: unknown): UserBindingRef | undefined {
  if (typeof user === 'string') return user ? { name: user } : undefined;
  if (user && typeof user === 'object') {
    const o = user as { name?: unknown; condition?: unknown };
    if (typeof o.name === 'string' && o.name) {
      return { name: o.name, condition: typeof o.condition === 'string' ? o.condition : undefined };
    }
  }
  return undefined;
}
