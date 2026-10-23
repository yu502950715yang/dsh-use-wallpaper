// 用户属性绑定解析内核（纯逻辑）：scene 的 {user, condition} 引用 + project.json 属性级 condition。
// 渲染侧只消费解析结果，不依赖 DOM/three。
import type { UserBindingRef } from '../shared/types.js';

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

/** 真值：布尔原样；数值非零（容差 1e-4）；字符串非空且非 "0"/"false"。 */
export function isTruthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Math.abs(value) > 1e-4;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    return s !== '' && s !== '0' && s !== 'false';
  }
  return false;
}

/**
 * 绑定侧 condition 匹配（we-layerd 语义）：空 = 真值判定；
 * bool 的数值条件 0=开、1=关，数值/字符串按容差/精确比较。
 */
export function matchCondition(value: unknown, condition: string | undefined): boolean {
  const c = String(condition ?? '').trim();
  if (!c) return isTruthy(value);
  const n = Number(c);
  if (!Number.isNaN(n) && Number.isFinite(n)) {
    if (typeof value === 'boolean') {
      if (Math.abs(n) < 1e-4) return isTruthy(value);
      if (Math.abs(n - 1) < 1e-4) return !isTruthy(value);
      return false;
    }
    const v = Number(value);
    return Number.isFinite(v) && Math.abs(v - n) < 1e-4;
  }
  if (c === 'true' || c === 'false') return isTruthy(value) === (c === 'true');
  return typeof value === 'string' ? value.trim() === c : String(value).trim() === c;
}

/** 颜色三元组：分量 max ≤ 1 视为 0-1 语义乘以 255，否则按 0-255 原样。 */
export function parseColorTriplet(text: string): [number, number, number] | undefined {
  const parts = text.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((x) => !Number.isFinite(x))) return undefined;
  const max = Math.max(parts[0], parts[1], parts[2]);
  return max <= 1
    ? [parts[0] * 255, parts[1] * 255, parts[2] * 255]
    : [parts[0], parts[1], parts[2]];
}

/**
 * 解析绑定值：无绑定/属性缺失 → 作者静态值；condition 不匹配 → 中性零值；
 * 匹配 → 用户值按 hint 归一化（bool / number / color 0-255 三元组）。
 */
export function resolveUserValue<T>(
  bound: { value: T; user?: UserBindingRef },
  userProps: Record<string, unknown>,
  hint: 'bool' | 'number' | 'color',
): T {
  const ref = bound.user;
  if (!ref) return bound.value;
  if (!Object.hasOwn(userProps, ref.name)) return bound.value; // 属性缺失 → 作者值
  const uv = userProps[ref.name];
  if (!matchCondition(uv, ref.condition)) {
    const neutral = hint === 'bool' ? false : hint === 'number' ? 0 : [0, 0, 0];
    return neutral as unknown as T;
  }
  if (hint === 'bool') return (typeof uv === 'boolean' ? uv : isTruthy(uv)) as unknown as T;
  if (hint === 'number') {
    const n = Number(uv);
    return (Number.isFinite(n) ? n : 0) as unknown as T;
  }
  const color = typeof uv === 'string' ? parseColorTriplet(uv) : undefined;
  return (color ?? [0, 0, 0]) as unknown as T;
}

// ---- 属性级 condition 表达式：or → and → comparison → operand 的递归下降 ----

interface ConditionToken { op?: string; atom?: string; }

const NUMBER_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

function tokenizeCondition(text: string): ConditionToken[] {
  const tokens: ConditionToken[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    const two = text.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '==' || two === '!=') {
      tokens.push({ op: two });
      i += 2;
      continue;
    }
    // 括号/单个逻辑符/赋值符不在文法内 → 畸形，交由失败开放处理
    if (ch === '(' || ch === ')' || ch === '&' || ch === '|' || ch === '=' || ch === '!') {
      throw new Error(`bad condition token: ${ch}`);
    }
    let end = i;
    while (end < text.length && !/[\s()&|=!]/.test(text[end])) end += 1;
    tokens.push({ atom: text.slice(i, end) });
    i = end;
  }
  return tokens;
}

// `<key>.value` 查 userProps；true/false 与数字转字面量；其余按字符串字面量。
function parseConditionOperand(atom: string, userProps: Record<string, unknown>): unknown {
  const ref = /^(.+)\.value$/.exec(atom);
  if (ref) {
    const key = ref[1];
    return Object.hasOwn(userProps, key) ? userProps[key] : undefined;
  }
  if (atom === 'true') return true;
  if (atom === 'false') return false;
  if (NUMBER_LITERAL.test(atom)) return Number(atom);
  return atom;
}

function evaluateCondition(text: string, userProps: Record<string, unknown>): boolean {
  const tokens = tokenizeCondition(text);
  if (tokens.length === 0) return true;
  let pos = 0;

  const eatOp = (op: string): boolean => {
    if (tokens[pos]?.op !== op) return false;
    pos += 1;
    return true;
  };

  const parseComparison = (): boolean => {
    const leftToken = tokens[pos];
    if (!leftToken?.atom) throw new Error('expected operand');
    pos += 1;
    const left = parseConditionOperand(leftToken.atom, userProps);
    const op = tokens[pos]?.op;
    if (op === '==' || op === '!=') {
      pos += 1;
      const rightToken = tokens[pos];
      if (!rightToken?.atom) throw new Error('expected operand');
      pos += 1;
      const right = parseConditionOperand(rightToken.atom, userProps);
      const matched = matchCondition(left, typeof right === 'string' ? right : String(right));
      return op === '==' ? matched : !matched;
    }
    return isTruthy(left);
  };

  const parseAnd = (): boolean => {
    let value = parseComparison();
    while (eatOp('&&')) {
      const rhs = parseComparison();
      value = value && rhs;
    }
    return value;
  };

  const parseOr = (): boolean => {
    let value = parseAnd();
    while (eatOp('||')) {
      const rhs = parseAnd();
      value = value || rhs;
    }
    return value;
  };

  const result = parseOr();
  return pos === tokens.length ? result : true; // 残留 token = 畸形 → 满足
}

/** 属性级 condition：空/畸形一律满足（失败开放），避免面板误隐藏属性。 */
export function propertyConditionMet(
  condition: string | undefined,
  userProps: Record<string, unknown>,
): boolean {
  const text = (condition ?? '').trim();
  if (!text) return true;
  try {
    return evaluateCondition(text, userProps);
  } catch {
    return true;
  }
}
