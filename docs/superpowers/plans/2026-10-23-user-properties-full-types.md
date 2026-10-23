# 用户属性面板全类型 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `project.json` 的 bool/slider/color/combo 用户属性在面板可调、并在 scene 渲染中真正生效（可见性、对象字段、效果、脚本），同时修复「对象形态 condition 未识别 + 父可见性未继承」导致的文字重影。

**Architecture:** 三层落地——① `src/client/user-bindings.ts` 纯逻辑内核（条件语义 + 属性级表达式 + 统一 resolve）；② `scene-json.ts` 解析时**保留** `{user,value}` 引用、装配前由 `resolveSceneUserBindings()` 一次性替换为静态值，下游渲染代码无感；③ host 聚合被引用属性（schema + 默认值）→ client 属性表（localStorage overrides）→ 面板四类控件，变更走重装配。

**Tech Stack:** TypeScript（strict）、vitest（node + jsdom）、React 18 面板、QuickJS 脚本宿主、Rust/wasm 粒子（本计划不改 wasm）。

**Spec:** `docs/superpowers/specs/2026-10-23-user-properties-full-types-design.md`

## Global Constraints

- 不新增第三方依赖；不修改 `wasm/src/**`；壁纸目录只读。
- 所有新代码走 TypeScript strict（`tsconfig.json`），测试侧类型错误受 `scripts/check-known-type-errors.mjs` 棘轮约束。
- 注释中文、从简（一行说清是什么/为什么，最多 2 行）；不加变更流水账。
- 提交信息：中文标题一行 + 正文最多 3 行。
- 改行为必须跑相关 vitest；每个 Task 的「Run:」步骤给出精确命令。
- 文档同步：`AGENT.md §7.41①`、`TESTING.md` 新增 §2.16、`README` 用户属性面板描述、`.agents/notes/` 决策笔记（Task 8）。
- 既有 e2e 门禁（`e2e:verify-v081` / `e2e:verify-v082` / `e2e:compare` / `e2e:hidpi`）结果不得回归；`lib/`+`dist/` 产物在 Task 8 统一重建。
- 实现口径（对 spec §2 的细化）：**不把 `Bound<T>` 扩散到下游**，改为「scene 解析保留 `user` 引用 → 装配前统一 resolve 成静态值」，避免改动 threejs-player/effect-runner 的全部消费路径。

## File Structure

| 文件 | 责任 |
|---|---|
| `src/client/user-bindings.ts`（新） | 条件语义、属性级 condition 最小表达式、`resolveUserValue`、`resolveSceneUserBindings` |
| `src/shared/types.ts` | `WallpaperUserProperty` 判别联合、`UserBindingRef`、`SceneDescription` 的引用字段 |
| `src/host/user-props.ts` | `collectUserProperties` 全类型聚合 + usedBy |
| `src/client/visibility.ts` | 对象形态 user、条件求值、`computeEffectiveVisibility`（父链） |
| `src/client/scene-json.ts` | 解析时保留 user 引用（对象字段 / general / instanceoverride / scriptproperties / visible） |
| `src/client/three-renderer.ts` | userProps 表构建、装配前 resolve、effect visible、脚本注入 |
| `src/client/wallpaper-properties.ts` | 四类型读写 + 恢复默认 |
| `src/client/settings-section.tsx` + `styles.ts` | 四类控件、condition 禁用、防抖提交 |
| `tests/user-bindings.test.ts`（新）等 | 单测 |

---

### Task 1: 绑定解析内核（纯逻辑）

**Files:**
- Create: `src/client/user-bindings.ts`
- Modify: `src/shared/types.ts:33-41`
- Test: `tests/user-bindings.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces（后续任务依赖的精确签名）:
  - `type UserBindingRef = { name: string; condition?: string }`
  - `parseUserRef(user: unknown): UserBindingRef | undefined`
  - `matchCondition(value: unknown, condition: string | undefined): boolean`
  - `resolveUserValue<T>(bound: { value: T; user?: UserBindingRef }, userProps: Record<string, unknown>, hint: 'bool' | 'number' | 'color'): T`
  - `propertyConditionMet(condition: string | undefined, userProps: Record<string, unknown>): boolean`
  - `parseColorTriplet(s: string): [number, number, number] | undefined`（0-1/0-255 双语义，后续 scene-json 复用）

- [ ] **Step 1: 写失败测试**

```ts
// tests/user-bindings.test.ts
import { describe, it, expect } from 'vitest';
import {
  parseUserRef, matchCondition, resolveUserValue, propertyConditionMet, parseColorTriplet,
} from '../src/client/user-bindings.js';

describe('parseUserRef', () => {
  it('字符串与对象形态', () => {
    expect(parseUserRef('clock')).toEqual({ name: 'clock' });
    expect(parseUserRef({ name: 'clock', condition: '1' })).toEqual({ name: 'clock', condition: '1' });
    expect(parseUserRef(null)).toBeUndefined();
    expect(parseUserRef({})).toBeUndefined();
    expect(parseUserRef({ name: '' })).toBeUndefined();
  });
});

describe('matchCondition（绑定侧）', () => {
  it('bool：condition "0"=开、"1"=关', () => {
    expect(matchCondition(true, '0')).toBe(true);
    expect(matchCondition(false, '1')).toBe(true);
    expect(matchCondition(true, '1')).toBe(false);
    expect(matchCondition(false, '0')).toBe(false);
  });
  it('combo 精确匹配、slider 数值容差', () => {
    expect(matchCondition('1', '1')).toBe(true);
    expect(matchCondition('1', '2')).toBe(false);
    expect(matchCondition(2, '2')).toBe(true);
    expect(matchCondition(3.13, '3.13')).toBe(true);
  });
  it('空 condition = 真值判定', () => {
    expect(matchCondition(true, undefined)).toBe(true);
    expect(matchCondition('', undefined)).toBe(false);
  });
});

describe('resolveUserValue', () => {
  const props = { clock: '1', clockcolor: '0.5 0 0', speed: 2 };
  it('条件匹配用用户值；不匹配写中性零值', () => {
    expect(resolveUserValue({ value: true, user: { name: 'clock', condition: '1' } }, props, 'bool')).toBe(true);
    expect(resolveUserValue({ value: true, user: { name: 'clock', condition: '2' } }, props, 'bool')).toBe(false);
  });
  it('无绑定/属性缺失 → 静态 value', () => {
    expect(resolveUserValue({ value: 0.5 }, props, 'number')).toBe(0.5);
    expect(resolveUserValue({ value: 0.5, user: { name: 'missing' } }, props, 'number')).toBe(0.5);
  });
  it('color 解析为 0-255 三元组', () => {
    expect(resolveUserValue({ value: '1 1 1', user: { name: 'clockcolor' } }, props, 'color')).toEqual([127.5, 0, 0]);
  });
});

describe('propertyConditionMet（属性级 condition）', () => {
  const props = { audiobar: true, mode: 'balanced', speed: 2 };
  it('最小表达式', () => {
    expect(propertyConditionMet('audiobar.value==true', props)).toBe(true);
    expect(propertyConditionMet('audiobar.value==false', props)).toBe(false);
    expect(propertyConditionMet('mode.value==balanced', props)).toBe(true);
    expect(propertyConditionMet('speed.value==2', props)).toBe(true);
    expect(propertyConditionMet('audiobar.value==true && mode.value==balanced', props)).toBe(true);
    expect(propertyConditionMet('audiobar.value==false || mode.value==balanced', props)).toBe(true);
  });
  it('空/畸形 → 满足（失败开放）', () => {
    expect(propertyConditionMet(undefined, props)).toBe(true);
    expect(propertyConditionMet('(((', props)).toBe(true);
  });
});

describe('parseColorTriplet', () => {
  it('0-1 与 0-255 双语义', () => {
    expect(parseColorTriplet('1 1 1')).toEqual([255, 255, 255]);
    expect(parseColorTriplet('0.5 0 0')).toEqual([127.5, 0, 0]);
    expect(parseColorTriplet('255 0 0')).toEqual([255, 0, 0]);
    expect(parseColorTriplet('bad')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/user-bindings.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `user-bindings.ts` 与类型**

要点（完整实现按此写，注释从简）：

```ts
// src/client/user-bindings.ts
import type { UserBindingRef } from '../shared/types.js';

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

export function isTruthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Math.abs(v) > 1e-4;
  if (typeof v === 'string') { const s = v.trim().toLowerCase(); return s !== '' && s !== '0' && s !== 'false'; }
  return false;
}

// we-layerd 语义：条件不匹配 → 中性零值；bool 的 condition "0"=开、"1"=关
export function matchCondition(value: unknown, condition: string | undefined): boolean {
  const c = String(condition ?? '').trim();
  if (!c) return isTruthy(value);
  const n = Number(c);
  if (c !== '' && !Number.isNaN(n) && Number.isFinite(n)) {
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

export function parseColorTriplet(text: string): [number, number, number] | undefined {
  const parts = text.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((x) => !Number.isFinite(x))) return undefined;
  const max = Math.max(parts[0], parts[1], parts[2]);
  return max <= 1 ? [parts[0] * 255, parts[1] * 255, parts[2] * 255] : [parts[0], parts[1], parts[2]];
}

export function resolveUserValue<T>(
  bound: { value: T; user?: UserBindingRef },
  userProps: Record<string, unknown>,
  hint: 'bool' | 'number' | 'color',
): T {
  const ref = bound.user;
  if (!ref) return bound.value;
  if (!(ref.name in userProps)) return bound.value; // 属性缺失 → 作者 value
  const uv = userProps[ref.name];
  if (!matchCondition(uv, ref.condition)) {
    // 条件不匹配 → 中性零值
    return (hint === 'bool' ? false : hint === 'number' ? 0 : ([0, 0, 0] as unknown)) as T;
  }
  if (hint === 'bool') return (typeof uv === 'boolean' ? uv : isTruthy(uv)) as unknown as T;
  if (hint === 'number') { const n = Number(uv); return (Number.isFinite(n) ? n : 0) as unknown as T; }
  const c = typeof uv === 'string' ? parseColorTriplet(uv) : undefined;
  return (c ?? [0, 0, 0]) as unknown as T;
}
```

属性级表达式：递归下降 `or → and → comparison → operand`；操作数 `<key>.value`（查 userProps）或字面量 true/false/数字/字符串；`==`/`!=` 用 `matchCondition` 的值比较（复用）；解析失败返回 true（失败开放）。

`src/shared/types.ts` 改动：

```ts
export type UserPropertyValue = boolean | number | string;
export interface UserBindingRef { name: string; condition?: string; }
interface UserPropertyBase { key: string; label: string; order: number; usedBy: string[]; condition?: string; }
export type WallpaperUserProperty =
  | (UserPropertyBase & { type: 'bool'; value: boolean })
  | (UserPropertyBase & { type: 'slider'; value: number; min: number; max: number; step?: number; precision?: number; fraction?: boolean })
  | (UserPropertyBase & { type: 'color'; value: string })
  | (UserPropertyBase & { type: 'combo'; value: string; options: Array<{ label: string; value: string }> });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/user-bindings.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/client/user-bindings.ts src/shared/types.ts tests/user-bindings.test.ts
git commit -m "feat(userprops): 绑定解析内核与四类型判别联合"
```

---

### Task 2: host 全类型聚合

**Files:**
- Modify: `src/host/user-props.ts:8-36`、`src/host/routes.ts:598`
- Test: `tests/user-props.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `WallpaperUserProperty`、`UserBindingRef`。
- Produces: `collectUserProperties(project: unknown, scene: unknown): WallpaperUserProperty[]`（路由与面板依赖）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/user-props.test.ts（文件已有 collectVisibleBoolProperties 测试，保留；新增 collectUserProperties 用例）
import { collectUserProperties } from '../src/host/user-props.js';

const project = { general: { properties: {
  bool1: { type: 'bool', value: true, text: 'B', order: 101 },
  slider1: { type: 'slider', value: 0.4, min: 0, max: 1, step: 0.01, precision: 3, fraction: true, text: 'S', order: 102 },
  color1: { type: 'color', value: '1 0 0', text: 'C', order: 103 },
  combo1: { type: 'combo', value: '1', options: [{ label: 'A', value: '1' }, { label: 'B', value: '2' }], text: 'M', order: 104 },
  unused: { type: 'bool', value: true },
  schemecolor: { type: 'color', value: '0 0 0', text: 'ui_browse_properties_scheme_color' },
  group1: { type: 'group', value: '' },
  hidden: { type: 'bool', value: true, editable: false },
} } };
const scene = { objects: [
  { id: 1, image: 'a', visible: { user: 'bool1', value: true } },
  { id: 2, image: 'b', color: { user: 'color1', value: '0 0 0' } },
  { id: 3, text: { value: 'x' }, visible: { user: { name: 'combo1', condition: '1' }, value: true } },
  { id: 4, image: 'c', effects: [{ passes: [{ constantshadervalues: { speed: { user: 'slider1', value: 1 } } }] }] },
] };

it('只返回被 scene 引用的四类型属性，带默认值与 usedBy', () => {
  const out = collectUserProperties(project, scene);
  expect(out.map((p) => p.key)).toEqual(['bool1', 'slider1', 'color1', 'combo1']);
  expect(out.find((p) => p.key === 'slider1')).toMatchObject({
    type: 'slider', value: 0.4, min: 0, max: 1, step: 0.01, precision: 3, fraction: true,
  });
  expect(out.find((p) => p.key === 'combo1')).toMatchObject({
    type: 'combo', options: [{ label: 'A', value: '1' }, { label: 'B', value: '2' }],
  });
  expect(out.find((p) => p.key === 'bool1')!.usedBy).toContain('objects[].visible');
  expect(out.find((p) => p.key === 'slider1')!.usedBy.length).toBeGreaterThan(0);
});
it('未引用 / schemecolor / group / editable=false 不返回', () => {
  const out = collectUserProperties(project, scene);
  for (const k of ['unused', 'schemecolor', 'group1', 'hidden']) expect(out.find((p) => p.key === k)).toBeUndefined();
});
it('默认值取 project.json 的 value（不是 scene 的 value）', () => {
  const p2 = { general: { properties: { slider2: { type: 'slider', value: 2, min: 0, max: 4, order: 100 } } } };
  const s2 = { objects: [{ id: 9, image: 'x', effects: [{ passes: [{ constantshadervalues: { speed: { user: 'slider2', value: 3.13 } } }] }] }] };
  expect(collectUserProperties(p2, s2)[0]).toMatchObject({ key: 'slider2', value: 2 });
});
it('坏 JSON / 缺字段 → []', () => {
  expect(collectUserProperties(null, null)).toEqual([]);
  expect(collectUserProperties({}, {})).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/user-props.test.ts`
Expected: FAIL（`collectUserProperties` 未定义）。

- [ ] **Step 3: 实现 `collectUserProperties`**

要点：
1. 读 `project.general.properties`（Record）；过滤未知 type / `group` / `editable === false`；取 `text`（stripHtml）/`order`/`value`/类型专属字段。
2. 递归扫 `scene` 收集引用：遍历任意节点，遇到 `{user}` 且能 `parseUserRef` 时把「父路径归类」加入该 key 的 usedBy（路径归一：`objects[].visible` / `objects[].color` / `objects[].effects[].visible` / `objects[].effects[].passes[].constantshadervalues` / `objects[].text.scriptproperties` / `objects[].instanceoverride` / `general.*`）。
3. 只返回 usedBy 非空的属性；`order` 升序、同序按 key。
4. 缺字段/坏 JSON 返回 `[]`。旧函数 `collectVisibleBoolProperties` 保留为薄封装（`collectUserProperties(...).filter(p => p.type === 'bool')`），避免现有测试与路由破坏。

`routes.ts:598` 改为 `collectUserProperties(projectJson, sceneJson)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/user-props.test.ts tests/routes.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/host/user-props.ts src/host/routes.ts tests/user-props.test.ts
git commit -m "feat(userprops): host 聚合四类型属性并标注引用路径"
```

---

### Task 3: 可见性（对象形态 + condition + 父链继承）

**Files:**
- Modify: `src/client/visibility.ts`、`src/client/three-renderer.ts:528-546`（userProps 构建与过滤）
- Test: `tests/visibility.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `parseUserRef` / `matchCondition`。
- Produces:
  - `VisibleBinding` 增加 `condition?: string`（既有字段不变）
  - `computeEffectiveVisibility(objects: Array<{ id: number; parent?: number; visible?: VisibleBinding }>, userProps: Record<string, unknown>, defs?: WallpaperUserProperty[]): Map<number, boolean>`
  - `isStaticallyHidden` / `resolveVisibility` 语义不变（供 text 历史口径使用）。

- [ ] **Step 1: 写失败测试（Leon 夹具）**

```ts
// tests/visibility.test.ts 追加
import { computeEffectiveVisibility, parseVisible } from '../src/client/visibility.js';

const leon = [
  { id: 192, visible: { kind: 'user', key: 'clock', condition: '1', value: true } },
  { id: 199, parent: 192 },
  { id: 209, parent: 192 },
  { id: 227, visible: { kind: 'user', key: 'clock', condition: '2', value: false } },
  { id: 234, parent: 227 },
  { id: 245, parent: 227 },
];
it('对象形态 user 解析出 condition', () => {
  expect(parseVisible({ user: { name: 'clock', condition: '1' }, value: true }))
    .toEqual({ kind: 'user', key: 'clock', condition: '1', value: true });
});
it('clock=1：只显示样式 A（192/199/209），父链隐藏样式 B', () => {
  const eff = computeEffectiveVisibility(leon, { clock: '1' });
  expect([...eff.entries()].filter(([, v]) => v).map(([k]) => k).sort((a, b) => a - b)).toEqual([192, 199, 209]);
});
it('clock=2：只显示样式 B', () => {
  const eff = computeEffectiveVisibility(leon, { clock: '2' });
  expect([...eff.entries()].filter(([, v]) => v).map(([k]) => k).sort((a, b) => a - b)).toEqual([227, 234, 245]);
});
it('父缺失/环容错；script 绑定不静态剔除', () => {
  const eff = computeEffectiveVisibility([
    { id: 1, visible: { kind: 'user', key: 'missing', value: false } },
    { id: 2, parent: 999 },
    { id: 3, parent: 3 },
    { id: 4, visible: { kind: 'script', value: true } },
  ], {});
  expect(eff.get(1)).toBe(false);
  expect(eff.get(2)).toBe(true);
  expect(eff.get(3)).toBe(true);
  expect(eff.get(4)).toBe(true);
});
it('2911105183 场景：三个独立 Clock 只在 condition 匹配时可见', () => {
  const clocks = [
    { id: 108, visible: { kind: 'user', key: 'clock', condition: '0', value: true } },
    { id: 144, visible: { kind: 'user', key: 'clock', condition: '1', value: true } },
    { id: 148, visible: { kind: 'user', key: 'clock', condition: '2', value: true } },
  ];
  const eff = computeEffectiveVisibility(clocks, { clock: '0' });
  expect([...eff.entries()].filter(([, v]) => v).map(([k]) => k)).toEqual([108]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/visibility.test.ts`
Expected: FAIL（`computeEffectiveVisibility` 未定义、`condition` 字段缺失）。

- [ ] **Step 3: 实现**

1. `parseVisible`：`typeof o.user === 'object'` 时用 `parseUserRef` 取 `{name, condition}` → `{ kind:'user', key: name, condition, value }`；字符串形态保持。
2. `resolveVisibility` / `isStaticallyHidden`：user 绑定改用 `resolveUserValue({ value: binding.value, user: { name: key, condition } }, userProps, 'bool')`（条件不匹配 → false），保留「键缺失回退 value」语义（`resolveUserValue` 已处理）。
3. 新增 `computeEffectiveVisibility(objects, userProps, defs?)`：
   - own = resolveVisibility；
   - 沿 `parent` 链求值（`Map` 缓存；父缺失 → 只按自身；环 → 视为 true 防死循环）；
   - `script` 绑定的对象**自身**保留（own 用 value），其祖先若为 script 也只按 value（不静态剔除）——即实现上不特殊处理（value 默认 true），但 `isStaticallyHidden` 对 script 仍返回 false。
4. `three-renderer.ts:528-546`：`userProps` 构建改为「所有被引用属性键」：从 `collectUserProperties` 的 host 响应不可用（渲染器无项目 JSON）——改为**从 scene 收集所有 user 键**（递归），值 = `getUserPropertyValue(key, id)`；随后 `effective = computeEffectiveVisibility(desc.objects, userProps)`，把各过滤点（`:546`/`:638`/`:719`/`:753-758`/`:809`）改为查 `effective.get(obj.id) === false` 跳过。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/visibility.test.ts tests/three-renderer.test.ts tests/scene-json-object-script.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/client/visibility.ts src/client/three-renderer.ts tests/visibility.test.ts
git commit -m "fix(userprops): 识别对象形态 condition 并沿父链继承可见性"
```

---

### Task 4: scene 解析保留 user 引用 + 装配前统一 resolve

**Files:**
- Modify: `src/client/scene-json.ts`（对象字段 / general / instanceoverride / scriptproperties）、`src/client/user-bindings.ts`（新增 `resolveSceneUserBindings`）、`src/client/three-renderer.ts`（装配入口调用）
- Test: `tests/scene-json.test.ts`、`tests/user-bindings.test.ts`

**Interfaces:**
- Consumes: Task 1 内核。
- Produces:
  - `SceneObjectBase` 新增 `userRefs?: { color?: UserBindingRef; alpha?: UserBindingRef; brightness?: UserBindingRef; origin?: UserBindingRef; scale?: UserBindingRef; angles?: UserBindingRef }`
  - `SceneDescription` 新增 `bloomUser?: UserBindingRef`、`parallaxUser?: UserBindingRef`
  - `export function resolveSceneUserBindings(desc: SceneDescription, userProps: Record<string, unknown>): SceneDescription`（返回新对象，不就地改）

- [ ] **Step 1: 写失败测试**

```ts
// tests/scene-json.test.ts 追加
it('对象字段的 {user} 绑定被保留为 userRefs', () => {
  const desc = parseSceneJson({ objects: [
    { id: 1, image: 'a', color: { user: 'clockcolor', value: '1 1 1' }, alpha: { user: 'vis', value: 0.5 } },
  ] })!;
  const o = desc.objects[0] as any;
  expect(o.userRefs.color).toEqual({ name: 'clockcolor' });
  expect(o.userRefs.alpha).toEqual({ name: 'vis' });
  expect(o.color).toEqual([255, 255, 255]); // 静态兜底仍保留
  expect(o.alpha).toBe(0.5);
});
// tests/user-bindings.test.ts 追加
import { resolveSceneUserBindings } from '../src/client/user-bindings.js';
it('装配前 resolve：绑定字段被用户值覆盖、静态字段不动', () => {
  const desc = { objects: [
    { id: 1, kind: 'image', color: [255, 255, 255], userRefs: { color: { name: 'clockcolor' } } },
    { id: 2, kind: 'image', color: [255, 255, 255] },
  ] } as any;
  const out = resolveSceneUserBindings(desc, { clockcolor: '0.5 0 0' });
  expect(out.objects[0].color).toEqual([127.5, 0, 0]);
  expect(out.objects[1].color).toEqual([255, 255, 255]);
});
it('effects / instanceoverride / scriptproperties 内的 {user} 也被 resolve', () => {
  const desc = { objects: [
    { id: 1, kind: 'particle', effects: [{ visible: { user: 'depthparallax', value: true } }],
      instanceOverrideJson: '{"rate":{"user":"leavedspeed","value":1}}',
      scriptProperties: { use24hFormat: { user: '_24h', value: true } } },
  ] } as any;
  const out = resolveSceneUserBindings(desc, { depthparallax: false, leavedspeed: 2, _24h: false });
  expect(out.objects[0].effects[0].visible).toBe(false);
  expect(JSON.parse(out.objects[0].instanceOverrideJson)).toEqual({ rate: 2 });
  expect(out.objects[0].scriptProperties.use24hFormat).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scene-json.test.ts tests/user-bindings.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

1. `scene-json.ts`：
   - 新增 `parseUserRefField(s): UserBindingRef | undefined`（用 `parseUserRef`，支持 `{user:"k"}` 与 `{user:{name,condition}}`）。
   - 在 `base`/各分支对 `color/alpha/brightness/origin/scale/angles` 解析后把 ref 写入 `userRefs`；`optColor/optAlpha` 保留静态值（现有双语义逻辑不变）。
   - `general.bloom` / `general.cameraparallax` 保留 `bloomUser` / `parallaxUser`。
   - `normalizeInstanceOverride`：序列化前保留 `{user,value}` 结构（不再预解包；由 resolve 阶段处理）。
   - `parseScriptProperties`（`script-patterns.ts`）：返回值保留 `{ value }` 之外的 `user` 引用（新结构 `{ value, user? }`；下游 `scene-script-host` 已知 `scriptProperties` 是 unknown 记录，改为 resolve 后的标量）。
2. `user-bindings.ts` 新增 `resolveSceneUserBindings`：深拷贝 desc（`structuredClone` 不可用则手写递归拷贝），对每个对象：
   - `userRefs` 各字段 → `resolveUserValue({ value, user }, userProps, hint)`（origin/scale/angles 为 number 数组，hint 用 number 逐分量）；
   - `effects`：递归替换任意 `{user,value}` 节点（`parseUserRef` + 按原字段类型推断：原 value 为 boolean→bool、number→number、字符串含空格→color）；
   - `instanceOverrideJson`：JSON.parse → 递归 resolve → stringify；
   - `scriptProperties`：递归 resolve；
   - `bloomUser`/`parallaxUser` 覆盖 `desc.bloom`/`desc.parallax`。
3. `three-renderer.ts`：拿到 `desc` 后、任何消费前调用 `resolveSceneUserBindings(desc, userProps)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/scene-json.test.ts tests/user-bindings.test.ts tests/scene-json-text-fields.test.ts tests/scene-json-parallax.test.ts tests/image-modulation.test.ts tests/three-renderer.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/client/scene-json.ts src/client/script-patterns.ts src/client/user-bindings.ts src/client/three-renderer.ts src/shared/types.ts tests/scene-json.test.ts tests/user-bindings.test.ts
git commit -m "feat(userprops): 解析保留 {user} 引用并在装配前统一 resolve"
```

---

### Task 5: 效果 visible 与脚本全量属性注入

**Files:**
- Modify: `src/client/three-renderer.ts:151-176`、`:983-986`、`src/client/scene-script-host.ts`
- Test: `tests/three-renderer.test.ts`、`tests/scene-script-host.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `resolveSceneUserBindings`。
- Produces: `SceneScriptHost.create({ userProperties })` 收到**全部被引用属性**（不再只有 visible 键）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/three-renderer.test.ts：effect 级 visible:{user}
it('effect 级 visible 的 {user} 按用户值生效', () => {
  const effects = [{ visible: { user: 'depthparallax', value: true } }];
  const resolved = resolveSceneUserBindings({ objects: [{ id: 1, kind: 'image', effects }] } as any, { depthparallax: false });
  expect((resolved.objects[0].effects as any[])[0].visible).toBe(false);
});
// tests/scene-script-host.test.ts：注入全部属性
it('engine.userProperties 收到全部被引用属性', () => {
  const props = { clock: '1', _24h: true, rain: false };
  // 断言 host.create({userProperties: props}) 后 vm 的 userProperties 相等（用现有 stub 方式）
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/three-renderer.test.ts tests/scene-script-host.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

1. `three-renderer.ts:165` 的 effect visible 判定改为「resolve 后 `fx.visible === false` 才隐藏」——由于 Task 4 已把 effect 内绑定 resolve 成静态值，这里只需确认 `false` 判定覆盖；`{user,value}` 经 Task 4 后已是 bool。
2. `three-renderer.ts:528-546` 的 `userProps`：递归收集 scene 内**所有** user 键（不再限 visible）+ `getUserPropertyValue`。
3. `SceneScriptHost.create({ userProperties: userProps })`：确保传入全表（现有调用点已传 `userProps`，改为全表后即完成）。脚本 VM 的 `engine.userProperties` 与 `createScriptProperties` 的覆盖值已经在 Task 4 的 `scriptProperties` resolve 后生效。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/three-renderer.test.ts tests/scene-script-host.test.ts tests/scene-script-vm.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/client/three-renderer.ts src/client/scene-script-host.ts tests/three-renderer.test.ts tests/scene-script-host.test.ts
git commit -m "feat(userprops): effect visible 与脚本注入全量用户属性"
```

---

### Task 6: client 四类型读写 + 恢复默认

**Files:**
- Modify: `src/client/wallpaper-properties.ts`、`src/client/settings.ts:113-124`
- Test: `tests/wallpaper-properties.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `WallpaperUserProperty`、`UserPropertyValue`。
- Produces:
  - `readUserProperty(key: string, wallpaperId?: string): UserPropertyValue | undefined`
  - `writeUserProperty(key: string, value: UserPropertyValue, wallpaperId?: string): void`
  - `resetUserProperty(key: string, wallpaperId?: string): void`（删除 per-id 键）
  - 兼容保留 `readBoolProperty` / `writeBoolProperty`（转调新函数）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/wallpaper-properties.test.ts 追加
it('四类型值往返（bool/number/string）', () => {
  writeUserProperty('a', true, 'id1');
  writeUserProperty('b', 0.4, 'id1');
  writeUserProperty('c', '1', 'id1');
  expect(readUserProperty('a', 'id1')).toBe(true);
  expect(readUserProperty('b', 'id1')).toBe(0.4);
  expect(readUserProperty('c', 'id1')).toBe('1');
});
it('per-wallpaper 隔离与恢复默认', () => {
  writeUserProperty('a', false, 'id1');
  writeUserProperty('a', true, 'id2');
  expect(readUserProperty('a', 'id1')).toBe(false);
  resetUserProperty('a', 'id1');
  expect(readUserProperty('a', 'id1')).toBeUndefined();
  expect(readUserProperty('a', 'id2')).toBe(true);
});
it('旧全局键仍可读（迁移兼容）', () => {
  localStorage.setItem('we:userprop:oldkey', 'true');
  expect(readUserProperty('oldkey', 'id1')).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/wallpaper-properties.test.ts`
Expected: FAIL（`readUserProperty` 等未定义）。

- [ ] **Step 3: 实现**

要点：通用 JSON 读写（值经 `JSON.parse`/`JSON.stringify`）；`resetUserProperty` 只删 per-id 键，不动旧全局键；`readBoolProperty` 改为 `const v = readUserProperty(...); return typeof v === 'boolean' ? v : undefined;`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/wallpaper-properties.test.ts tests/settings.test.ts tests/client-settings.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/client/wallpaper-properties.ts src/client/settings.ts tests/wallpaper-properties.test.ts
git commit -m "feat(userprops): 四类型属性读写与恢复默认"
```

---

### Task 7: 面板四类控件

**Files:**
- Modify: `src/client/settings-section.tsx:520-544`、`src/client/styles.ts`
- Test: `tests/dom/settings-section.dom.test.tsx`

**Interfaces:**
- Consumes: Task 1 类型；Task 6 读写；`fetchWallpaperProperties`（Task 2 返回新类型）。
- Produces: 面板 UI（无新导出）。

- [ ] **Step 1: 写失败测试**

```tsx
// tests/dom/settings-section.dom.test.tsx 追加
it('按类型渲染控件：bool 复选框 / slider 滑杆 / color 取色 / combo 下拉', async () => {
  // 用现有 renderSettingsSection harness + fetchProperties stub 返回四类型数组
  const props = [
    { key: 'b', label: 'Bool', type: 'bool', value: true, order: 1, usedBy: ['objects[].visible'] },
    { key: 's', label: 'Slider', type: 'slider', value: 0.4, min: 0, max: 1, step: 0.01, order: 2, usedBy: ['x'] },
    { key: 'c', label: 'Color', type: 'color', value: '1 0 0', order: 3, usedBy: ['x'] },
    { key: 'm', label: 'Combo', type: 'combo', value: '1', options: [{ label: 'A', value: '1' }], order: 4, usedBy: ['x'] },
  ];
  // 断言存在 input[type=checkbox]/[type=range]/[type=color]/select 且 data-key 对应
});
it('slider 变更防抖后才触发重装配；color/combo 立即', async () => { /* fake timers + onReselect 断言 */ });
it('condition 不满足时控件禁用', async () => { /* 提供 audiobar=false + 属性 condition */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/dom/settings-section.dom.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现**

要点：
1. 属性 section 渲染按 `type` 分支：bool（现有）、slider（range，value=本地 state，onInput 更新显示、`onPointerUp`/`onBlur` 300ms 防抖提交）、color（`input[type=color]`，`"r g b"`(0-1) ↔ `#rrggbb` 转换；提交前转回 `"r g b"`）、combo（select，options label/value）。
2. 提交：`writeUserProperty(key, value, selectedId)` → `onReselect(selectedId)`；slider 防抖用 `useRef` 定时器，卸载时清理。
3. condition：`propertyConditionMet(p.condition, currentValues)` 不满足时 `disabled` + `title` 提示。
4. 每项右侧「恢复默认」按钮：`resetUserProperty` → `onReselect`。
5. CSS 类沿用 `wss-row` / `wss-slider`，新增少量样式（`styles.ts` 字符串常量）。
6. `settings-section.tsx:209-230` 的拉取已用 `WallpaperUserProperty[]`，类型自动收窄；初值 `propValues[key] ?? property.value` 按类型初始化。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/dom/settings-section.dom.test.tsx tests/styles.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/client/settings-section.tsx src/client/styles.ts tests/dom/settings-section.dom.test.tsx
git commit -m "feat(userprops): 面板支持 slider/color/combo 与恢复默认"
```

---

### Task 8: 文档、真机清单、产物与全量验证

**Files:**
- Modify: `AGENT.md:244`（§7.41①）、`TESTING.md`（新增 §2.16）、`README.md:65`（属性面板说明）
- Create: `.agents/notes/implemented/feature/2026-10-23-user-properties-full-types.md`
- 重建：`lib/`、`dist/`（`npm run build` + `npm run build:client`）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 文档与验收记录。

- [ ] **Step 1: 文档更新**

- `AGENT.md §7.41①`：改为「四类型 + 对象形态 condition + 父链可见性」现状，链接 spec 与笔记。
- `TESTING.md` 新增 §2.16「用户属性面板与绑定」：用例与期望（`3812518176` clock 三态/clockcolor/_24h/leavedspeed/ember；`2911105183` Clock combo；`2937346640` slider；`3118949804` slider+parallax；`2832263418` color+condition），标注「需人工验收」。
- `README.md:65`：属性面板条目改为「bool / slider / color / combo 可调，只显示当前壁纸真正引用的属性」。
- 新笔记（implemented/feature）记录：为什么先统一 resolve 而非 Bound 扩散、父链继承的影响面（2 张 5 对象）、server 端只给被引用属性。

- [ ] **Step 2: 构建产物**

```bash
npm run build
npm run build:client
```

- [ ] **Step 3: 全量验证**

```bash
npx vitest run
npm run typecheck:tests
node .agents/skills/intent-notes/scripts/verify-note-tree.ts .agents/notes
node .agents/skills/intent-notes/scripts/verify-note-format.ts .agents/notes
node .agents/skills/intent-notes/scripts/verify-note-anchors.ts .
```

Expected: vitest 无新增失败（允许已知基线）；typecheck 无新增键；门禁全绿。

- [ ] **Step 4: 真机验收（用户执行）**

按 `TESTING.md §2.16` 勾选；重点：`3812518176` 文字不再重影、`clock` 三档切换正确、`clockcolor`/`_24h`/`leavedspeed` 生效。

- [ ] **Step 5: 提交**

```bash
git add AGENT.md TESTING.md README.md .agents/notes lib dist
git commit -m "docs+release: 用户属性面板全类型落地，补真机清单与决策笔记"
```

---

## Self-Review

- **Spec 覆盖**：§2 数据模型→Task 1；§3 host→Task 2；§4.1/4.2/4.3→Task 1/3；§4.4→Task 3/5；§5 消费点→Task 3/4/5；§6 面板→Task 7；§7 生效→Task 3/7（重装配沿用）；§8 测试→各 Task；§9 风险→Task 8 文档。无缺口。
- **占位符扫描**：无 TBD/TODO；每 Task 含可运行测试与命令。
- **类型一致性**：`UserBindingRef` / `resolveUserValue` / `computeEffectiveVisibility` / `readUserProperty` 在前后任务中名称与签名一致；`userRefs` 字段名在 Task 4/5 统一。
- **对 spec 的细化**：以「静态值 + userRefs + 装配前统一 resolve」替代 `Bound<T>` 全链路扩散，理由已写入 Global Constraints 与 Task 4。
