# 场景树层级变换（parent）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 解析 WE 场景的 `parent` 层级并累积出每个对象的**世界变换**，让 `3798688689` 这类树形壁纸正确铺满画面。

**Architecture:** 新增纯逻辑模块 `src/client/scene-graph.ts`（`resolveWorldTransforms`）；`scene-json` 补 `parent` 字段解析；`three-renderer` 在组装**最前面**算一次世界变换表，下游（quad / 粒子 / text / 隔离对象世界尺寸）统一改读世界值 —— 不改各渲染器内部结构。

**Tech Stack:** TypeScript（ESM/strict）、three.js（`Matrix4`/`Euler` 用于含旋转的 origin 累积）、vitest。

**Spec:** `docs/superpowers/specs/2026-09-20-scene-hierarchy-design.md`

## Global Constraints

- 回复、注释、文档、提交信息一律**简体中文**；代码/命令/文件名/术语保留原文。
- **注释从简**：一行说清「是什么 / 为什么」，最多 2 行；不复述代码、不贴实测数字（写进 AGENT.md/docs）。
- 提交信息：标题一行 `type(scope): 中文标题`，正文最多 3 行；**每个 Task 一个提交**。
- **零回归是硬要求**：无 `parent` 的对象，其世界变换必须与局部值**逐字段相等**（26/29 张壁纸不受影响）。
- 累积规则（AGENT.md §5.14）：`scale` 逐分量相乘（OME `cwiseProduct`）；`origin` 按父的世界旋转与 scale 变换后平移到父的世界 origin；`angles` 逐分量相加（多轴父链下为近似，**如实标注**）。
- **不要跑全量 `npx vitest run`**（本机 `tests/shader` 会挂起）；只跑计划里指定的文件。
- 已知既有失败：`tests/dom/bootstrap.dom.test.ts` 的 I1、`tests/verify-real-library.test.ts` 的硬编码计数（129 vs 实际），均非回归。
- 改完 `npm run build` + `npm run build:client`，`lib/`、`dist/` 一起提交。
- 环境：file policy 已是 `danger-full-access`。

---

### Task 1: scene-graph 纯函数 + `parent` 字段解析

**Files:**
- Create: `src/client/scene-graph.ts`
- Modify: `src/shared/types.ts`（`SceneObject` 各变体加 `parent?: number`）
- Modify: `src/client/scene-json.ts`（`base` 里解析 `parent`）
- Test: `tests/scene-graph.test.ts`（新建）、`tests/scene-json.test.ts`（追加）

**Interfaces:**
- Produces:
  - `interface SceneGraphNode { id: number; parent?: number; origin: [number,number,number]; scale: [number,number,number]; angles?: [number,number,number] }`
  - `interface WorldTransform { origin: [number,number,number]; scale: [number,number,number]; angles: [number,number,number] }`
  - `resolveWorldTransforms(nodes: SceneGraphNode[]): Map<number, WorldTransform>`

- [ ] **Step 1: 写失败测试**

`tests/scene-graph.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { resolveWorldTransforms, type SceneGraphNode } from '../src/client/scene-graph.js';

// 3798688689 的真实层级截取（1 → 1000 → 1001 → 1003 → 10030）
const CHAIN = [
  { id: 1, origin: [1280, 720, 0], scale: [1.64103, 1.64103, 1] },
  { id: 1000, parent: 1, origin: [0, 0, 0], scale: [1, 1, 1] },
  { id: 1001, parent: 1000, origin: [0, 0, 0], scale: [1, 1, 1] },
  { id: 1003, parent: 1001, origin: [0, 0, 0], scale: [1, 1, 1] },
  { id: 10030, parent: 1003, scale: [15.6, 9.6, 1] },   // origin/scale 可缺失
] as unknown as SceneGraphNode[];

describe('resolveWorldTransforms', () => {
  it('反算基准：累积 scale 使 100×100 的 solidlayer 铺满场景宽 2560', () => {
    const w = resolveWorldTransforms(CHAIN);
    const t = w.get(10030)!;
    expect(t.scale[0]).toBeCloseTo(25.6001, 3);      // 1.64103 × 15.6
    expect(t.scale[1]).toBeCloseTo(15.7539, 3);
    expect(t.origin[0]).toBeCloseTo(1280, 3);        // 父的世界 origin
    expect(100 * t.scale[0]).toBeCloseTo(2560, 0);
  });

  it('退化保证：无 parent 的对象逐字段等于局部值（含负 scale）', () => {
    const nodes = [{ id: 7, origin: [10, 20, 0], scale: [-1, 0.5, 1], angles: [0, 0, 1.2] }] as unknown as SceneGraphNode[];
    expect(resolveWorldTransforms(nodes).get(7)).toEqual({
      origin: [10, 20, 0], scale: [-1, 0.5, 1], angles: [0, 0, 1.2],
    });
  });

  it('缺 angles 的对象 angles 取 [0,0,0]', () => {
    const nodes = [{ id: 1, origin: [0, 0, 0], scale: [1, 1, 1] }] as unknown as SceneGraphNode[];
    expect(resolveWorldTransforms(nodes).get(1)!.angles).toEqual([0, 0, 0]);
  });

  it('子对象的 origin 按父的世界 scale 缩放后叠加到父的世界 origin', () => {
    const nodes = [
      { id: 1, origin: [100, 100, 0], scale: [2, 2, 1] },
      { id: 2, parent: 1, origin: [10, 5, 0], scale: [1, 1, 1] },
    ] as unknown as SceneGraphNode[];
    const w = resolveWorldTransforms(nodes);
    expect(w.get(2)!.origin[0]).toBeCloseTo(120, 6);   // 100 + 2×10
    expect(w.get(2)!.origin[1]).toBeCloseTo(110, 6);   // 100 + 2×5
    expect(w.get(2)!.scale).toEqual([2, 2, 1]);
  });

  it('父链含旋转时不产出 NaN，且 origin 随旋转改变', () => {
    const nodes = [
      { id: 1, origin: [0, 0, 0], scale: [1, 1, 1], angles: [0, 0, Math.PI / 2] },
      { id: 2, parent: 1, origin: [10, 0, 0], scale: [1, 1, 1] },
    ] as unknown as SceneGraphNode[];
    const t = resolveWorldTransforms(nodes).get(2)!;
    expect(t.origin.every(Number.isFinite)).toBe(true);
    expect(t.origin[0]).toBeCloseTo(0, 3);      // 绕 z 转 90° → (10,0) → (0,10)
    expect(t.origin[1]).toBeCloseTo(10, 3);
  });

  it('环状 parent 链不挂死：退化为局部值并标记', () => {
    const nodes = [
      { id: 1, parent: 2, origin: [1, 1, 0], scale: [1, 1, 1] },
      { id: 2, parent: 1, origin: [2, 2, 0], scale: [1, 1, 1] },
    ] as unknown as SceneGraphNode[];
    const w = resolveWorldTransforms(nodes);
    expect(w.size).toBe(2);
    expect(Number.isFinite(w.get(1)!.origin[0])).toBe(true);
  });

  it('未知 parent id（悬空引用）→ 按无父处理', () => {
    const nodes = [{ id: 5, parent: 999, origin: [3, 4, 0], scale: [1, 1, 1] }] as unknown as SceneGraphNode[];
    expect(resolveWorldTransforms(nodes).get(5)!.origin).toEqual([3, 4, 0]);
  });
});
```

`tests/scene-json.test.ts` 追加（放 `parseSceneJson` 主 describe 内）：

```ts
  it('parent 字段解析（含容器对象）', () => {
    const desc = parseSceneJson(JSON.stringify({
      objects: [
        { id: 1, name: 'root', origin: '0 0 0', scale: '1 1 1' },
        { id: 2, parent: 1, image: 'models/a.json', origin: '0 0 0', scale: '1 1 1' },
      ],
    }));
    expect((desc.objects[0] as any).parent).toBeUndefined();
    expect((desc.objects[1] as any).parent).toBe(1);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scene-graph.test.ts tests/scene-json.test.ts --reporter=basic`
Expected: FAIL（`scene-graph.js` 不存在；`parent` 为 undefined）

- [ ] **Step 3: 实现 `src/client/scene-graph.ts`**

```ts
// src/client/scene-graph.ts —— WE 场景树（parent）的世界变换累积。
// 子对象变换相对父节点：scale 逐分量相乘（OME cwiseProduct），origin 经父的世界旋转/缩放后
// 叠加到父的世界 origin；angles 逐分量相加（多轴父链下为近似，见 spec §3.2）。
import * as THREE from 'three';

export interface SceneGraphNode {
  id: number;
  parent?: number;
  // 真实 scene.json 里子对象的 origin/scale 常缺失（3798688689 实测 158/278 个）→ 可选
  origin?: [number, number, number];
  scale?: [number, number, number];
  angles?: [number, number, number];
}

export interface WorldTransform {
  origin: [number, number, number];
  scale: [number, number, number];
  angles: [number, number, number];
}

// 防御畸形数据：深度上限（正常场景远低于此）
const MAX_DEPTH = 64;

const ZERO: [number, number, number] = [0, 0, 0];

export function resolveWorldTransforms(nodes: SceneGraphNode[]): Map<number, WorldTransform> {
  const byId = new Map<number, SceneGraphNode>();
  for (const n of nodes) byId.set(n.id, n);
  const out = new Map<number, WorldTransform>();
  const visiting = new Set<number>();

  const local = (n: SceneGraphNode): WorldTransform => ({
    origin: n.origin ?? ZERO,
    scale: n.scale ?? [1, 1, 1],
    angles: n.angles ?? ZERO,
  });

  const resolve = (n: SceneGraphNode, depth: number): WorldTransform => {
    const cached = out.get(n.id);
    if (cached) return cached;
    const self = local(n);
    const parent = n.parent !== undefined ? byId.get(n.parent) : undefined;
    // 无父 / 悬空引用 / 环 / 超深 → 退化为局部值（保证「无 parent 逐字段相等」）
    if (!parent || depth >= MAX_DEPTH || visiting.has(n.id)) {
      out.set(n.id, self);
      return self;
    }
    visiting.add(n.id);
    const pw = resolve(parent, depth + 1);
    visiting.delete(n.id);
    // origin：父的世界 scale ⊙ 子 origin，经父的世界旋转后叠加到父的世界 origin
    const offset = new THREE.Vector3(self.origin[0] * pw.scale[0], self.origin[1] * pw.scale[1], self.origin[2] * pw.scale[2]);
    offset.applyEuler(new THREE.Euler(pw.angles[0], pw.angles[1], pw.angles[2]));
    const world: WorldTransform = {
      origin: [pw.origin[0] + offset.x, pw.origin[1] + offset.y, pw.origin[2] + offset.z],
      scale: [pw.scale[0] * self.scale[0], pw.scale[1] * self.scale[1], pw.scale[2] * self.scale[2]],
      angles: [pw.angles[0] + self.angles[0], pw.angles[1] + self.angles[1], pw.angles[2] + self.angles[2]],
    };
    out.set(n.id, world);
    return world;
  };

  for (const n of nodes) resolve(n, 0);
  return out;
}
```

`scene-json.ts` 的 `base` 对象里加一行（与 `alignment`/`effects` 同处）：

```ts
      // 场景树：子对象变换相对父节点（世界变换由 scene-graph.ts 累积）
      parent: optNum(o.parent),
```

`types.ts` 的 `SceneImageObject` / `SceneParticleObject` / `SceneUtilObject` / `SceneTextObject` 各加：

```ts
  parent?: number;   // 场景树父对象 id（世界变换由 scene-graph 累积）
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/scene-graph.test.ts tests/scene-json.test.ts --reporter=basic`
Expected: PASS（新增 7 + 1 项）

- [ ] **Step 5: 提交**

```bash
git add src/client/scene-graph.ts src/shared/types.ts src/client/scene-json.ts tests/scene-graph.test.ts tests/scene-json.test.ts
git commit -m "feat(scene): 场景树世界变换累积（parent/scale 相乘/origin 经父旋转）"
```

---

### Task 2: 接入 three-renderer（下游统一读世界值）

**Files:**
- Modify: `src/client/three-renderer.ts`
- Test: `tests/three-renderer.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `resolveWorldTransforms`
- Produces: 无新导出（内部接线）

- [ ] **Step 1: 写失败测试**

```ts
  it('parent 层级：组装折叠出世界变换（3798688689 的 solidlayer 世界宽 = 2560）', async () => {
    const scene = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 2560, height: 1440 } },
      objects: [
        { id: 1, name: 'root', origin: '1280 720 0', scale: '1.64103 1.64103 1' },
        { id: 1003, parent: 1, name: 'matte', origin: '0 0 0', scale: '1 1 1' },
        { id: 10030, parent: 1003, name: 'solid', image: 'models/layers/l_10030.json', size: '100 100', scale: '15.6 9.6 1' },
      ],
    });
    stubAssetFetch(scene, {});
    resolveImageTexture.mockResolvedValue(fakeTexture() as never);
    loadSceneToThree.mockReturnValue({ player: scriptPlayer(), sims: [], backgroundIds: [0, 1], particleLayers: [] } as never);

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm, getTextScriptRuntime: async () => null });
    await r.render('3798688689', document.createElement('canvas'), null);

    const t = lastWorldTransformOf(10030)!;
    expect(t.scale[0]).toBeCloseTo(25.6001, 3);        // 1.64103 × 15.6
    expect(t.origin[0]).toBeCloseTo(1280, 3);
    expect(100 * t.scale[0]).toBeCloseTo(2560, 0);     // 世界宽 = 场景宽
    r.dispose();
  });

  it('无 parent 的对象：接线后世界值逐字段等于局部值（零回归）', async () => {
    const scene = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 1920, height: 1080 } },
      objects: [{ id: 9, name: 'flat', image: 'models/layers/l_9.json', origin: '100 200 0', scale: '2 3 1', size: '10 10' }],
    });
    stubAssetFetch(scene, {});
    resolveImageTexture.mockResolvedValue(fakeTexture() as never);
    loadSceneToThree.mockReturnValue({ player: scriptPlayer(), sims: [], backgroundIds: [0], particleLayers: [] } as never);

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm, getTextScriptRuntime: async () => null });
    await r.render('3743126786', document.createElement('canvas'), null);
    expect(lastWorldTransformOf(9)).toEqual({ origin: [100, 200, 0], scale: [2, 3, 1], angles: [0, 0, 0] });
    r.dispose();
  });
```
（`lastWorldTransformOf` 由 Step 3 在 `three-renderer.ts` 导出，测试文件顶部与既有 helper 一起 import。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/three-renderer.test.ts -t 世界变换 --reporter=basic`
Expected: FAIL

- [ ] **Step 3: 实现（最小侵入）**

`three-renderer.ts`：

1. 顶部 `import { resolveWorldTransforms } from './scene-graph.js';`
2. `createThreeSceneRenderer` 增加**仅供测试**的只读钩子导出（放模块级）：

```ts
// 最近一次 render 计算出的世界变换表（只读，供测试断言接线；生产不消费）。
let lastWorldTransforms: Map<number, import('./scene-graph.js').WorldTransform> | null = null;
export function lastWorldTransformOf(id: number) {
  return lastWorldTransforms?.get(id) ?? null;
}
```

3. `render()` 里、**组装 assets 之前**：

```ts
        // 场景树：先把每个对象的变换折叠进「世界值」，下游（quad/粒子/text/隔离世界尺寸）统一读它。
        // 无 parent 的对象逐字段不变（零回归）。
        const world = resolveWorldTransforms(desc.objects);
        lastWorldTransforms = world;
        const worldOf = (o: { id: number }) => world.get(o.id);
```

4. 所有消费 `obj.origin/scale/angles` 的地方改为读世界值（缺失时回退局部值）。**image（含 text）分支**：

```ts
      const w = worldOf(obj) ?? { origin: obj.origin, scale: obj.scale, angles: obj.angles ?? [0, 0, 0] };
      const id = player.addBackground({
        origin: w.origin,           // ← 原为 obj.origin
        size: obj.size,
        scale: w.scale,             // ← 原为 obj.scale
        angles: w.angles,           // ← 原为 obj.angles
        ...
      });
```

   **隔离对象世界尺寸**（`isolate.set` 的两处 `world` 计算）：

```ts
      // image：
      const world = { w: Math.abs(w0 * wscale[0]), h: Math.abs(h0 * wscale[1]) };   // wscale = 世界 scale
      // particle：
      const world = particleWorldSize(spec, [wscale[0], wscale[1]]);
```

   **particle 分支**的 `addParticle`：`objectCenter` 用世界 origin 折算（`w.origin[0] - sceneW / 2`）、`objectScale` 用世界 scale、`objectAngles` 用世界 angles。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/three-renderer.test.ts tests/threejs-player.test.ts tests/scene-graph.test.ts --reporter=basic`
Expected: PASS（无回归）

- [ ] **Step 5: 提交**

```bash
git add src/client/three-renderer.ts tests/three-renderer.test.ts
git commit -m "feat(scene): three-renderer 组装改用世界变换，隔离世界尺寸随父链 scale"
```

---

### Task 3: 端到端验证、文档回写与最终提交

**Files:**
- Modify: `AGENT.md`（§7.1 新增条目）、`docs/technical-notes.md`（§1.1）
- Modify: `lib/`、`dist/`（构建产物）

- [ ] **Step 1: 构建**

Run: `npm run build; npm run build:client`
Expected: 均 exit 0

- [ ] **Step 2: 端到端验证（核心验收）**

Run: `node research/verify-hidpi-object-rt.mjs --id=3798688689 --dprs=1 --phase=5 --no-particles --tag=hier --out=verify-text`
Expected: `harness ok=true`、`console error = 0`、主场景 quad 数**远多于改动前**（改动前 184 个对象各自错位）；`read_image` 目检：画面**铺满**而不是只剩左侧一块。

- [ ] **Step 3: 回归（零回归主张的证据）**

Run: `node research/verify-hidpi-object-rt.mjs --id=3743126786 --dprs=1 --phase=5 --no-particles --tag=hiergtr --out=verify-text`
Run: `node research/verify-hidpi-object-rt.mjs --id=2980088441 --dprs=1 --phase=5 --no-particles --tag=hiercode --out=verify-text`
Expected: 与本次改动前**逐像素接近**（这两张无 parent）：`read_image` 目检结构一致、`console error = 0`。

- [ ] **Step 4: 回写文档（如实）**

- `AGENT.md` §7.1 新增条目：场景树层级已实现（累积规则、反算基准、影响面 3/29、**边界**：`angles` 在多轴父链下为近似、`disablepropagation`/视差未做、`3798688689` 因 util 24 个对象仍不渲染而**不完全等于桌面**）；
- `docs/technical-notes.md` §1.1 补一句世界变换折叠。

- [ ] **Step 5: 跑受影响的单测**

Run: `npx vitest run tests/scene-graph.test.ts tests/scene-json.test.ts tests/three-renderer.test.ts tests/threejs-player.test.ts --reporter=basic`
Expected: 通过

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "docs(scene): 回写层级变换的实测与边界；补构建产物"
```

---

## 完成判据

- spec §5 的 6 条全部有证据；其中第 4 条（画面铺满）必须附 `read_image` 目检结论；
- **不得**把「`3798688689` 已完全还原」写成结论 —— util 24 个对象（含 16 条效果链）仍不渲染，属下一块工作；
- 若 `angles` 近似在 e2e 上造成可见偏差，如实写进 AGENT.md §7.1，不要隐瞒。
