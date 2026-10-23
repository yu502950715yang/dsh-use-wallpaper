// 用户属性绑定解析内核（纯逻辑）：scene 的 {user, condition} 引用 + project.json 属性级 condition。
// 渲染侧只消费解析结果，不依赖 DOM/three。
import type { SceneDescription, SceneObject, UserBindingRef } from '../shared/types.js';

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
 * 匹配 → 用户值按 hint 归一化（bool / number / color 0-255 三元组 / color01 0-1 原串）。
 */
export function resolveUserValue<T>(
  bound: { value: T; user?: UserBindingRef },
  userProps: Record<string, unknown>,
  hint: 'bool' | 'number' | 'color' | 'color01',
): T {
  const ref = bound.user;
  if (!ref) return bound.value;
  if (!Object.hasOwn(userProps, ref.name)) return bound.value; // 属性缺失 → 作者值
  const uv = userProps[ref.name];
  if (!matchCondition(uv, ref.condition)) {
    const neutral = hint === 'bool' ? false
      : hint === 'number' ? 0
        : hint === 'color' ? [0, 0, 0] : '0 0 0';
    return neutral as unknown as T;
  }
  if (hint === 'bool') return (typeof uv === 'boolean' ? uv : isTruthy(uv)) as unknown as T;
  if (hint === 'number') {
    const n = Number(uv);
    return (Number.isFinite(n) ? n : 0) as unknown as T;
  }
  if (hint === 'color01') {
    // shader 常量颜色是 0-1 语义：保留字符串交给 uniform-binder，不能转 0-255 数组。
    return (typeof uv === 'string' ? uv.trim() : '0 0 0') as unknown as T;
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

// ---- 装配前统一 resolve：scene 解析产物（userRefs / effects / instanceoverride / scriptproperties） ----

// 深拷贝（structuredClone 优先；环境不支持/含不可克隆值时回退 JSON 结构递归拷贝）。
function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* 回退手写拷贝 */
    }
  }
  return cloneJsonLike(value);
}

function cloneJsonLike<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJsonLike(item)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = cloneJsonLike(item);
    return out as T;
  }
  return value;
}

// 任意 {user,value} 节点的值：按作者 value 的类型推断 hint（bool/number/color01/字符串）。
function resolveBoundNode(
  value: unknown,
  user: UserBindingRef,
  userProps: Record<string, unknown>,
): unknown {
  if (typeof value === 'boolean') return resolveUserValue({ value, user }, userProps, 'bool');
  if (typeof value === 'number') return resolveUserValue({ value, user }, userProps, 'number');
  if (typeof value === 'string') {
    // effects 内空格分隔串是 shader 颜色（0-1），保留原串由 uniform-binder 解析。
    if (/\s/.test(value.trim())) return resolveUserValue({ value, user }, userProps, 'color01');
    return resolveRawString(value, user, userProps);
  }
  return value;
}

// 字符串绑定：键缺失回退作者值，condition 不匹配写中性空串（spec §4.1）；用户值保持字符串。
function resolveRawString(
  value: string,
  user: UserBindingRef,
  userProps: Record<string, unknown>,
): string {
  if (!Object.hasOwn(userProps, user.name)) return value;
  const uv = userProps[user.name];
  if (!matchCondition(uv, user.condition)) return '';
  return typeof uv === 'string' ? uv : String(uv);
}

// scriptproperties / instanceoverride：保持作者 value 的类型语义（颜色字符串不能被转成三元组，
// wasm/脚本按 WE 原格式消费），只把绑定换成用户值。
function resolveValueNode(
  value: unknown,
  user: UserBindingRef,
  userProps: Record<string, unknown>,
): unknown {
  if (typeof value === 'boolean') return resolveUserValue({ value, user }, userProps, 'bool');
  if (typeof value === 'number') return resolveUserValue({ value, user }, userProps, 'number');
  if (typeof value === 'string') return resolveRawString(value, user, userProps);
  return value;
}

// 递归 replace 任意 {user,value} 节点（effects / scriptProperties / instanceoverride）。
// mode='effects'：颜色按 shader 0-1 语义保留字符串；'raw'：所有字符串保持原格式。
function resolveBindingsDeep(
  node: unknown,
  userProps: Record<string, unknown>,
  mode: 'effects' | 'raw',
): unknown {
  if (Array.isArray(node)) return node.map((item) => resolveBindingsDeep(item, userProps, mode));
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    const user = parseUserRef(o.user);
    if (user && 'value' in o) {
      return mode === 'effects'
        ? resolveBoundNode(o.value, user, userProps)
        : resolveValueNode(o.value, user, userProps);
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(o)) out[key] = resolveBindingsDeep(value, userProps, mode);
    return out;
  }
  return node;
}

const TRANSFORM_DEFAULT = { origin: 0, scale: 1, angles: 0 } as const;

// 解析对象字段绑定：userRefs 各字段（color/alpha/brightness 标量，origin/scale/angles 逐分量）。
function resolveObjectUserRefs(obj: SceneObject, userProps: Record<string, unknown>): void {
  const refs = obj.userRefs;
  if (!refs) return;
  const rec = obj as unknown as Record<string, unknown>;
  if (refs.color) rec.color = resolveUserValue({ value: rec.color, user: refs.color }, userProps, 'color');
  if (refs.alpha) rec.alpha = resolveUserValue({ value: rec.alpha, user: refs.alpha }, userProps, 'number');
  if (refs.brightness) {
    rec.brightness = resolveUserValue({ value: rec.brightness, user: refs.brightness }, userProps, 'number');
  }
  for (const key of ['origin', 'scale', 'angles'] as const) {
    const ref = refs[key];
    if (!ref) continue;
    const fallback = TRANSFORM_DEFAULT[key];
    const raw = Array.isArray(rec[key]) ? (rec[key] as unknown[]) : [];
    rec[key] = [0, 1, 2].map((i) => {
      const component = typeof raw[i] === 'number' ? (raw[i] as number) : fallback;
      return resolveUserValue({ value: component, user: ref }, userProps, 'number');
    });
  }
}

// 装配入口调用一次：返回**新** desc（不就地改），下游只消费静态值。
export function resolveSceneUserBindings(
  desc: SceneDescription,
  userProps: Record<string, unknown>,
): SceneDescription {
  const out = deepClone(desc);
  for (const obj of out.objects) {
    resolveObjectUserRefs(obj, userProps);
    const rec = obj as unknown as Record<string, unknown>;
    if (Array.isArray(rec.effects)) rec.effects = resolveBindingsDeep(rec.effects, userProps, 'effects');
    if (typeof rec.instanceOverrideJson === 'string') {
      try {
        const parsed = JSON.parse(rec.instanceOverrideJson) as unknown;
        rec.instanceOverrideJson = JSON.stringify(resolveBindingsDeep(parsed, userProps, 'raw'));
      } catch {
        /* 畸形 JSON 保持原样（wasm 侧同样会忽略） */
      }
    }
    for (const key of ['scriptProperties', 'objectScriptProperties'] as const) {
      const props = rec[key];
      if (props && typeof props === 'object' && !Array.isArray(props)) {
        rec[key] = resolveBindingsDeep(props, userProps, 'raw');
      }
    }
    const visible = rec.visible as { scriptProperties?: Record<string, unknown> } | undefined;
    if (visible?.scriptProperties) {
      visible.scriptProperties = resolveBindingsDeep(
        visible.scriptProperties, userProps, 'raw',
      ) as Record<string, unknown>;
    }
  }
  // general.bloom/cameraparallax：用户值覆盖静态开关；bloom 由关闭 → 打开时补缺省参数。
  if (out.bloomUser) {
    const enabled = resolveUserValue(
      { value: out.bloom !== undefined, user: out.bloomUser }, userProps, 'bool',
    );
    if (!enabled) out.bloom = undefined;
    else if (!out.bloom) out.bloom = { strength: 2, threshold: 0.65 };
  }
  if (out.parallaxUser) {
    out.parallax = {
      ...out.parallax,
      enabled: resolveUserValue(
        { value: out.parallax.enabled, user: out.parallaxUser }, userProps, 'bool',
      ),
    };
  }
  return out;
}
