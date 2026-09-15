# 具名 RT 图执行器（P2）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 three.js 主路径能执行 WE 的具名 RT 图效果链（blur / blurprecise / localcontrast / godrays / shine / bloom / bokeh_blur，全库 24 条），消除 `AGENT.md` §7.1 的能力差与 README 里"模糊/泛光/光轴/局部对比度暂不支持"。

**Architecture:** 把 `effect.json` 的链编译成**静态执行计划**（纯函数 `buildEffectPlan`），`EffectRunner` 按计划执行：具名 RT 池（每条链一套，尺寸 = 对象 RT ÷ `fbos.scale`）+ `previous` 的"目标序列起点输入"语义 + `bind.index → g_Texture<index>` 覆盖。线性链退化为同一套执行器的特例（`bindings` 空、写端全 ping-pong），保证零回归。

**Tech Stack:** TypeScript strict / ESM-only、three.js（WebGL2）、vitest（node + jsdom）、esbuild（client 打包）。**本计划不改 Rust/wasm**。

**Spec:** `docs/superpowers/specs/2026-09-15-three-rt-graph-executor-design.md`

## Global Constraints

- 回复、注释、文档、提交信息一律**简体中文**；代码、命令、文件名、技术术语保留原文。
- 注释**从简**：一行说清是什么/为什么，最多 2 行；禁止复述代码、罗列实验数据、粘贴推理过程。根因与实测数字写 `AGENT.md` / `docs/`。
- 提交信息格式：标题一行 `type(scope): 中文标题`；正文可选、**最多 3 行**，每行一句（改了什么 / 关键根因 / 怎么验证）。
- **帧内禁止编译/建管线/建 RT**（`AGENT.md` §5.11）：链解析、`setPlan`、材质与探针编译、具名 RT 创建全部发生在加载期或 resize 重挂期。
- 渲染进任何 RenderTarget 必须走 `renderIntoRenderTarget()`（透明清屏，`AGENT.md` §5.22）。
- RT 纹理保持 `ClampToEdgeWrapping`（`AGENT.md` §5.19）。
- `g_TextureNResolution` 的 vec4 分量是 `(mip0.w, mip0.h, header.w, header.h)`（`AGENT.md` §5.17），一律经 `resolveTextureResolution4()` 取值。
- 纯函数（可 node 测）与 WebGL 代码分离：所有新语义进 `src/client/effect-graph.ts`。
- 测试命令：`npx vitest run tests/<file>.test.ts --reporter=basic`。
- 全量 `vitest run` 有 **15 项既有失败**（`wasm-renderer` 7 / `scene-renderer` 6 / `verify-real-library` 1 / `dom/bootstrap.dom` 1），改动后与 `git stash` 基线对比，别当成本次回归。
- `lib/` 与 `dist/` **入库**：改完源码要 `npm run build` + `npm run build:client`，产物一并提交。
- 全库实测数字（勿放宽）：**RT 图链 24 条 / 线性链 106 条**；具名 RT 每链最多 8 张。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/client/effect-graph.ts` | **新增** | 执行计划的类型与纯函数：具名 RT 清单（名字/尺寸/scale）、`bind` 覆盖项、写端三态、线性链退化。不 import three、不碰 WebGL |
| `tests/effect-graph.test.ts` | **新增** | 上述纯函数的 node 单测（含全库 24 条真实链的形态回归） |
| `src/client/effect-runner.ts` | 改 | 新增 `setPlan()` 与具名 RT 池；`update()` 改为按计划执行（槽优先级、`previous` 序列、链放弃）；`setChains()` 保留给未接入的 `scene-renderer.ts`（内部视为无计划的退化路径） |
| `tests/effect-runner.test.ts` | 改 | 追加 `setPlan` 生命周期与"按计划执行"的用例（沿用 `createBindRenderer()`） |
| `src/client/object-effects.ts` | 改 | 去掉 RT 图链的整链跳过与 `rtGraphSkips()`；挂载前过滤 effect 级 `visible === false`；`mount` 改为 `setPlan` |
| `tests/object-effects.test.ts` | 改 | 把"整链跳过"类用例改写为"照常挂载"；新增 `visible:false` 用例 |
| `src/client/three-renderer.ts` | 改 | isolate 准入从"至少有一条线性链"改为"至少有一条**可见**链"；删除 `rtGraphOnly` 分支与其"不再隔离"的告警 |
| `tests/three-renderer.test.ts` | 改 | 把"链全为具名 RT 图链的对象不进 isolate"改写为"照常隔离" |
| `research/verify-object-effects.mjs` | 改（gitignore） | 端到端判据（盒外零变化、黑像素、亮部提升、具名 RT 显存估算） |
| `AGENT.md` / `README.md` | 改 | §2.1/§5/§7 与用户向能力说明 |

依赖方向：`three-renderer` → `object-effects` → { `effect-graph`, `effect-runner`, `object-range` }；`effect-runner` → `effect-graph`（仅 import 类型与 `NAMED_RT_LIMIT`）；`effect-graph` 不 import three。

---

### Task 1: `effect-graph.ts` 骨架 + 具名 RT 清单

**Files:**
- Create: `src/client/effect-graph.ts`
- Test: `tests/effect-graph.test.ts`

**Interfaces:**
- Consumes: `CompiledEffectPass`（`src/client/shader/effect-chain.ts`：`target: string | null`、`bind: {name,index}[]`、`fboScale: Record<string, number>`）
- Produces: `RtSource` / `RtWrite` / `PlannedPass` / `EffectPlan` 类型；`NAMED_RT_LIMIT = 16`；`namedRtKey(chainIndex, name): string`；`namedRtScale(fboScale, name): number`；`namedRtSize(baseWidth, baseHeight, scale): {width, height}`；`buildEffectPlan(chains, {baseWidth, baseHeight}): EffectPlan`

- [ ] **Step 1: 写失败测试**

创建 `tests/effect-graph.test.ts`：

```ts
// tests/effect-graph.test.ts
// RT 图执行计划的纯函数单测（语义依据见 docs/superpowers/specs/2026-09-15-three-rt-graph-executor-design.md）。
import { describe, expect, it } from 'vitest';
import {
  buildEffectPlan, namedRtKey, namedRtScale, namedRtSize, NAMED_RT_LIMIT,
} from '../src/client/effect-graph.js';
import type { CompiledEffectPass } from '../src/client/shader/effect-chain.js';

// 最小 CompiledEffectPass：只填本文件关心的字段。
function pass(over: Partial<CompiledEffectPass> = {}): CompiledEffectPass {
  return {
    vertSrc: '', fragSrc: '', rawVert: '', rawFrag: '',
    combos: {}, uniforms: new Map(), textureSlots: [], samplerModes: {},
    blendMode: 'normal', target: null, bind: [], fboScale: {},
    ...over,
  };
}

describe('namedRtKey / namedRtScale / namedRtSize（具名 RT 口径）', () => {
  it('key 带链序号 → 两条链的同名 RT 互不覆盖', () => {
    expect(namedRtKey(0, '_rt_Q1')).toBe('0:_rt_Q1');
    expect(namedRtKey(1, '_rt_Q1')).toBe('1:_rt_Q1');
  });
  it('scale 缺失 / 0 / 负 / NaN → 1（缺省全尺寸）', () => {
    expect(namedRtScale({}, '_rt_a')).toBe(1);
    expect(namedRtScale({ _rt_a: 0 }, '_rt_a')).toBe(1);
    expect(namedRtScale({ _rt_a: -4 }, '_rt_a')).toBe(1);
    expect(namedRtScale({ _rt_a: Number.NaN }, '_rt_a')).toBe(1);
    expect(namedRtScale(undefined, '_rt_a')).toBe(1);
  });
  it('scale 正常值原样返回（含小数）', () => {
    expect(namedRtScale({ _rt_a: 4 }, '_rt_a')).toBe(4);
    expect(namedRtScale({ _rt_a: 1.5 }, '_rt_a')).toBe(1.5);
  });
  it('尺寸 = base ÷ scale，四舍五入，下限 1', () => {
    expect(namedRtSize(1000, 600, 4)).toEqual({ width: 250, height: 150 });
    expect(namedRtSize(1000, 600, 2)).toEqual({ width: 500, height: 300 });
    expect(namedRtSize(1000, 600, 3)).toEqual({ width: 333, height: 200 });
    expect(namedRtSize(1, 1, 4)).toEqual({ width: 1, height: 1 });
  });
});

describe('buildEffectPlan — 具名 RT 清单', () => {
  it('按 target 建表（同名多 pass 只建一张），scale 查 fbos', () => {
    const fb = { _rt_Q1: 4, _rt_Q2: 4 };
    const chain = [
      pass({ target: '_rt_Q1', fboScale: fb }),
      pass({ target: '_rt_Q2', fboScale: fb }),
      pass({ target: '_rt_Q1', fboScale: fb }),
      pass({ fboScale: fb }),
    ];
    const plan = buildEffectPlan([chain], { baseWidth: 1000, baseHeight: 600 });
    expect(plan.namedTargets).toEqual([
      { key: '0:_rt_Q1', name: '_rt_Q1', width: 250, height: 150 },
      { key: '0:_rt_Q2', name: '_rt_Q2', width: 250, height: 150 },
    ]);
  });
  it('target 出现但 fbos 未声明 → 照建、scale=1（GTR 的 blur_start_* 形态）', () => {
    const chain = [pass({ target: 'blur_start_2' }), pass({ target: 'blur_end_2' })];
    const plan = buildEffectPlan([chain], { baseWidth: 1000, baseHeight: 600 });
    expect(plan.namedTargets.map((t) => [t.name, t.width, t.height])).toEqual([
      ['blur_start_2', 1000, 600],
      ['blur_end_2', 1000, 600],
    ]);
  });
  it('两条链同名 RT → 各持一份', () => {
    const chain = [pass({ target: '_rt_Q1', fboScale: { _rt_Q1: 4 } })];
    const plan = buildEffectPlan([chain, chain], { baseWidth: 800, baseHeight: 400 });
    expect(plan.namedTargets.map((t) => t.key)).toEqual(['0:_rt_Q1', '1:_rt_Q1']);
  });
  it('单链具名 RT 超上限 → 该链进 droppedChains 且不产出 pass', () => {
    const many = Array.from({ length: NAMED_RT_LIMIT + 1 }, (_, i) => pass({ target: `_rt_${i}` }));
    const plan = buildEffectPlan([many, [pass({ target: '_rt_ok' })]], { baseWidth: 100, baseHeight: 100 });
    expect(plan.droppedChains).toEqual([0]);
    expect(plan.namedTargets.map((t) => t.key)).toEqual(['1:_rt_ok']);
    expect(plan.passes.every((p) => p.chainIndex === 1)).toBe(true);
  });
  it('base 非法（0 / NaN）→ 按 1 计算，不产生 0 尺寸 RT', () => {
    const plan = buildEffectPlan([[pass({ target: '_rt_a' })]], { baseWidth: 0, baseHeight: Number.NaN });
    expect([plan.namedTargets[0].width, plan.namedTargets[0].height]).toEqual([1, 1]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/effect-graph.test.ts --reporter=basic`
Expected: FAIL —— 无法解析 `../src/client/effect-graph.js`（模块不存在）

- [ ] **Step 3: 写最小实现**

创建 `src/client/effect-graph.ts`：

```ts
// src/client/effect-graph.ts
// RT 图效果链的**静态执行计划**（纯函数，node 可测）。
// 语义依据 WE 参考实现 lwe：bind.index → g_Texture<index>、previous = 进入 target 序列前的输入、
// 具名 RT 尺寸 = 对象 RT ÷ fbos.scale、RT 池作用域 = 单条链（见 spec §2.2）。
import type { CompiledEffectPass } from './shader/effect-chain.js';

/** bind 覆盖项：指向序列起点输入，或链内具名 RT。 */
export type RtSource = { type: 'previous' } | { type: 'named'; key: string };

/** 写端：具名 RT / ping-pong 对端 / 本条计划最后一个 pass 的输出。 */
export type RtWrite = { type: 'named'; key: string } | { type: 'pingpong' } | { type: 'final' };

export interface PlannedPass {
  chainIndex: number;
  /** 链内下标：执行器用 chains[chainIndex][passIndex] 取材质信息（droppedChains 会让平坦下标错位）。 */
  passIndex: number;
  /** 只含 bind 覆盖项；未覆盖的槽由执行器按既有默认语义处理。 */
  bindings: Array<{ slot: number; source: RtSource }>;
  write: RtWrite;
  blendMode: string;
  target?: string;
  unresolvedBinds?: string[];
}

export interface EffectPlan {
  namedTargets: Array<{ key: string; name: string; width: number; height: number }>;
  passes: PlannedPass[];
  /** 具名 RT 超上限而整体放弃的链序号。 */
  droppedChains: number[];
}

/** 单链具名 RT 软上限（全库最多 8 张，防病态数据把显存吃穿）。 */
export const NAMED_RT_LIMIT = 16;

export function namedRtKey(chainIndex: number, name: string): string {
  return `${chainIndex}:${name}`;
}

/** fbos 未声明 / 非正数 / 非有限值 → 1（全尺寸）。 */
export function namedRtScale(fboScale: Record<string, number> | undefined, name: string): number {
  const s = fboScale?.[name];
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1;
}

export function namedRtSize(baseWidth: number, baseHeight: number, scale: number): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(baseWidth / scale)),
    height: Math.max(1, Math.round(baseHeight / scale)),
  };
}

export function buildEffectPlan(
  chains: CompiledEffectPass[][],
  opts: { baseWidth: number; baseHeight: number },
): EffectPlan {
  const baseW = Number.isFinite(opts.baseWidth) && opts.baseWidth > 0 ? opts.baseWidth : 1;
  const baseH = Number.isFinite(opts.baseHeight) && opts.baseHeight > 0 ? opts.baseHeight : 1;
  const namedTargets: EffectPlan['namedTargets'] = [];
  const passes: PlannedPass[] = [];
  const droppedChains: number[] = [];

  chains.forEach((chain, chainIndex) => {
    // ① 具名 RT 清单：按 target 建（fbos 只用来查 scale —— GTR 的 fbos 声明与 target 实际不一致）
    const names: string[] = [];
    for (const p of chain) {
      if (p.target && !names.includes(p.target)) names.push(p.target);
    }
    if (names.length > NAMED_RT_LIMIT) {
      droppedChains.push(chainIndex);
      return;
    }
    for (const name of names) {
      const size = namedRtSize(baseW, baseH, namedRtScale(chain[0]?.fboScale, name));
      namedTargets.push({ key: namedRtKey(chainIndex, name), name, width: size.width, height: size.height });
    }
  });

  return { namedTargets, passes, droppedChains };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/effect-graph.test.ts --reporter=basic`
Expected: PASS（11 项）

- [ ] **Step 5: 提交**

```bash
git add src/client/effect-graph.ts tests/effect-graph.test.ts
git commit -m "feat(effects): 新增 RT 图执行计划的具名 RT 清单纯函数" -m "按 target 建表、scale 查 fbos（GTR 的 fbos 声明与实际 target 不一致，故不能按 fbos 建）" -m "key 带链序号：同名 RT 在不同链上各持一份（lwe 每条 effect 一个 FBOProvider）"
```

---

### Task 2: 计划的 `bind` 覆盖项（读端）

**Files:**
- Modify: `src/client/effect-graph.ts`（`buildEffectPlan` 内补 `passes`）
- Test: `tests/effect-graph.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的类型与 `namedRtKey`
- Produces: `plan.passes[i] = { chainIndex, passIndex, bindings, write, blendMode, target?, unresolvedBinds? }`，其中 `bindings[i].slot` 就是 `g_Texture<slot>`

- [ ] **Step 1: 写失败测试**

追加到 `tests/effect-graph.test.ts`：

```ts
describe('buildEffectPlan — bind 覆盖项（读端）', () => {
  it('bind.index 就是 g_Texture<index>（不是 index+1）：index 0 与 1 分别落槽', () => {
    const chain = [
      pass({ target: '_rt_F' }),
      pass({ bind: [{ index: 0, name: '_rt_F' }, { index: 1, name: 'previous' }] }),
    ];
    const plan = buildEffectPlan([chain], { baseWidth: 10, baseHeight: 10 });
    expect(plan.passes[1].bindings).toEqual([
      { slot: 0, source: { type: 'named', key: '0:_rt_F' } },
      { slot: 1, source: { type: 'previous' } },
    ]);
  });
  it('blur 的 combine 形态：bind[2]=previous 落在 slot 2，且 slot 0 仍绑具名 RT', () => {
    const fb = { _rt_Q1: 4 };
    const chain = [
      pass({ target: '_rt_Q1', fboScale: fb }),
      pass({ target: '_rt_Q1', fboScale: fb }),
      pass({ bind: [{ index: 0, name: '_rt_Q1' }, { index: 2, name: 'previous' }], fboScale: fb }),
    ];
    const plan = buildEffectPlan([chain], { baseWidth: 100, baseHeight: 100 });
    expect(plan.passes[2].bindings).toEqual([
      { slot: 0, source: { type: 'named', key: '0:_rt_Q1' } },
      { slot: 2, source: { type: 'previous' } },
    ]);
    expect(plan.passes[2].unresolvedBinds).toBeUndefined();
  });
  it('链内不存在的名字（_rt_FullFrameBuffer）→ 不产出覆盖项 + 记入 unresolvedBinds', () => {
    const chain = [
      pass({ target: '_rt_H' }),
      pass({ bind: [{ index: 0, name: '_rt_H' }, { index: 2, name: '_rt_FullFrameBuffer' }] }),
    ];
    const plan = buildEffectPlan([chain], { baseWidth: 10, baseHeight: 10 });
    expect(plan.passes[1].bindings).toEqual([{ slot: 0, source: { type: 'named', key: '0:_rt_H' } }]);
    expect(plan.passes[1].unresolvedBinds).toEqual(['_rt_FullFrameBuffer']);
  });
  it('空名 bind → 记入 unresolvedBinds（不猜语义，保持该槽默认）', () => {
    const chain = [pass({ bind: [{ index: 1, name: '' }] })];
    const plan = buildEffectPlan([chain], { baseWidth: 10, baseHeight: 10 });
    expect(plan.passes[0].bindings).toEqual([]);
    expect(plan.passes[0].unresolvedBinds).toEqual(['']);
  });
  it('passIndex 保留链内下标、chainIndex 保留链序（多链不串位）', () => {
    const plan = buildEffectPlan([[pass(), pass()], [pass()]], { baseWidth: 10, baseHeight: 10 });
    expect(plan.passes.map((p) => [p.chainIndex, p.passIndex])).toEqual([[0, 0], [0, 1], [1, 0]]);
  });
  it('blendMode 与 target 名随 pass 带出（供执行器与诊断使用）', () => {
    const chain = [pass({ target: '_rt_F', blendMode: 'additive' })];
    const plan = buildEffectPlan([chain], { baseWidth: 10, baseHeight: 10 });
    expect(plan.passes[0].blendMode).toBe('additive');
    expect(plan.passes[0].target).toBe('_rt_F');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/effect-graph.test.ts --reporter=basic`
Expected: FAIL —— `plan.passes` 长度 0，`expect([...]).toEqual([...])` 不匹配

- [ ] **Step 3: 写最小实现**

在 `src/client/effect-graph.ts` 的 `buildEffectPlan` 内、具名 RT 清单之后补 `passes`（把 `forEach` 回调体改为）：

```ts
  chains.forEach((chain, chainIndex) => {
    const names: string[] = [];
    for (const p of chain) {
      if (p.target && !names.includes(p.target)) names.push(p.target);
    }
    if (names.length > NAMED_RT_LIMIT) {
      droppedChains.push(chainIndex);
      return;
    }
    const keyOf = new Map<string, string>();
    for (const name of names) {
      const key = namedRtKey(chainIndex, name);
      keyOf.set(name, key);
      const size = namedRtSize(baseW, baseH, namedRtScale(chain[0]?.fboScale, name));
      namedTargets.push({ key, name, width: size.width, height: size.height });
    }

    // ② 逐 pass 的 bind 覆盖项（写端在 Task 3 补）
    chain.forEach((p, passIndex) => {
      const bindings: PlannedPass['bindings'] = [];
      const unresolvedBinds: string[] = [];
      for (const b of p.bind ?? []) {
        const name = (b.name ?? '').trim();
        if (name === 'previous') {
          bindings.push({ slot: b.index, source: { type: 'previous' } });
          continue;
        }
        const key = name ? keyOf.get(name) : undefined;
        if (key) {
          bindings.push({ slot: b.index, source: { type: 'named', key } });
          continue;
        }
        unresolvedBinds.push(name);
      }
      const planned: PlannedPass = {
        chainIndex,
        passIndex,
        bindings,
        write: { type: 'pingpong' },
        blendMode: p.blendMode,
      };
      if (p.target) planned.target = p.target;
      if (unresolvedBinds.length > 0) planned.unresolvedBinds = unresolvedBinds;
      passes.push(planned);
    });
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/effect-graph.test.ts --reporter=basic`
Expected: PASS（17 项）

- [ ] **Step 5: 提交**

```bash
git add src/client/effect-graph.ts tests/effect-graph.test.ts
git commit -m "feat(effects): 计划补 bind 覆盖项（index 即 g_Texture<index>）" -m "依据 lwe CPass::bindTextureOverrides；链内不存在的名字记 unresolvedBinds 保持默认槽" -m "单测覆盖 blur combine 的 bind[2]=previous 与 _rt_FullFrameBuffer 降级形态"
```

---

### Task 3: 写端三态 + 线性链退化 + 全库真实形态回归

**Files:**
- Modify: `src/client/effect-graph.ts`（写端与 `final` 标记）
- Test: `tests/effect-graph.test.ts`（追加两个 describe）

**Interfaces:**
- Consumes: Task 2 的 `passes`
- Produces: `plan.passes[i].write ∈ {named, pingpong, final}`；线性链计划满足 `bindings` 全空 + 写端 `pingpong…final`

- [ ] **Step 1: 写失败测试**

追加到 `tests/effect-graph.test.ts`（文件顶部 import 追加 `PkgReader`、`readdirSync`、`existsSync`、`join`）：

```ts
import { PkgReader } from '../src/host/pkg-reader.js';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
```

```ts
describe('buildEffectPlan — 写端三态与线性链退化', () => {
  it('有 target → named；无 target → pingpong；整条计划的最后一个 pass → final', () => {
    const chain = [pass({ target: '_rt_F' }), pass({ target: '_rt_G' }), pass()];
    const plan = buildEffectPlan([chain], { baseWidth: 10, baseHeight: 10 });
    expect(plan.passes.map((p) => p.write)).toEqual([
      { type: 'named', key: '0:_rt_F' },
      { type: 'named', key: '0:_rt_G' },
      { type: 'final' },
    ]);
  });
  it('最后一个 pass 写具名 RT → write 保持 named（执行器据此把 lastOutput 设为该 RT）', () => {
    const chain = [pass(), pass({ target: '_rt_F' })];
    const plan = buildEffectPlan([chain], { baseWidth: 10, baseHeight: 10 });
    expect(plan.passes.map((p) => p.write.type)).toEqual(['pingpong', 'named']);
  });
  it('线性链退化：bindings 全空、写端全 pingpong、末 pass final（零回归判据）', () => {
    const plan = buildEffectPlan([[pass(), pass(), pass()]], { baseWidth: 10, baseHeight: 10 });
    expect(plan.namedTargets).toEqual([]);
    expect(plan.passes.every((p) => p.bindings.length === 0)).toBe(true);
    expect(plan.passes.map((p) => p.write.type)).toEqual(['pingpong', 'pingpong', 'final']);
  });
  it('多链：只有整条计划的最后一个 pass 是 final（链间不重置）', () => {
    const plan = buildEffectPlan([[pass()], [pass()]], { baseWidth: 10, baseHeight: 10 });
    expect(plan.passes.map((p) => [p.chainIndex, p.write.type])).toEqual([[0, 'pingpong'], [1, 'final']]);
  });
  it('空链 / 全空输入 → 不崩、无 pass', () => {
    expect(buildEffectPlan([[]], { baseWidth: 10, baseHeight: 10 }).passes).toEqual([]);
    expect(buildEffectPlan([], { baseWidth: 10, baseHeight: 10 }).passes).toEqual([]);
  });
});

// 全库真实链的形态回归（本机无壁纸库时跳过）：24 条 RT 图链必须全部可计划、无 droppedChains。
const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';

describe.skipIf(!existsSync(WALLPAPER_DIR))('buildEffectPlan — 全库 RT 图链形态（实测数字，勿放宽）', () => {
  it('24 条 RT 图链：每条都有具名 RT、末 pass 写端非 named、无 droppedChains', async () => {
    const dirs = readdirSync(WALLPAPER_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    let rtChains = 0;
    let maxNamed = 0;
    for (const id of dirs) {
      const pkgPath = join(WALLPAPER_DIR, id, 'scene.pkg');
      if (!existsSync(pkgPath)) continue;
      const reader = new PkgReader(pkgPath);
      const raw = reader.readEntry('scene.json');
      if (!raw) continue;
      const scene = JSON.parse(Buffer.from(raw).toString('utf8')) as {
        objects?: Array<{ effects?: Array<{ file?: string; passes?: unknown[] }> }>;
      };
      const loadFile = async (name: string) => { const e = reader.readEntry(name); return e ? new Uint8Array(e) : null; };
      for (const obj of scene.objects ?? []) {
        for (const fx of obj.effects ?? []) {
          if (typeof fx.file !== 'string') continue;
          const chain = await resolveEffectChain({ file: fx.file, passes: fx.passes }, loadFile);
          if (!chain || isLinearEffectChain(chain)) continue;
          rtChains++;
          const plan = buildEffectPlan([chain], { baseWidth: 1280, baseHeight: 720 });
          expect(plan.droppedChains).toEqual([]);
          expect(plan.namedTargets.length).toBeGreaterThan(0);
          expect(plan.passes.length).toBe(chain.length);
          // 末 pass 若不是 named，必须是 final；具名 RT 读数不超过上限
          const lastWrite = plan.passes[plan.passes.length - 1].write;
          expect(lastWrite.type === 'final' || lastWrite.type === 'named').toBe(true);
          maxNamed = Math.max(maxNamed, plan.namedTargets.length);
        }
      }
    }
    console.log(`[全库计划] RT 图链 ${rtChains} 条；单链具名 RT 最多 ${maxNamed} 张`);
    expect(rtChains).toBe(24);
    expect(maxNamed).toBeLessThanOrEqual(8);
  });
});
```

> 该测试需要 import `resolveEffectChain` 与 `isLinearEffectChain`，在文件顶部追加：
> ```ts
> import { resolveEffectChain } from '../src/client/shader/effect-chain.js';
> import { isLinearEffectChain } from '../src/client/object-effects.js';
> ```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/effect-graph.test.ts --reporter=basic`
Expected: FAIL —— 前 5 项里 `write` 恒为 `pingpong`（缺 `named`/`final`），全库用例 `lastWrite.type === 'final'` 失败

- [ ] **Step 3: 写最小实现**

在 `src/client/effect-graph.ts` 的 `buildEffectPlan` 内，逐 pass 循环里把写端按 target 决定，并在循环结束后标记 `final`：

```ts
      const writesNamed = p.target !== undefined && p.target !== null && p.target !== '' && keyOf.has(p.target);
      const planned: PlannedPass = {
        chainIndex,
        passIndex,
        bindings,
        write: writesNamed ? { type: 'named', key: keyOf.get(p.target as string) as string } : { type: 'pingpong' },
        blendMode: p.blendMode,
      };
```

并在 `chains.forEach(...)` 之后、`return` 之前补：

```ts
  // 整条计划的最后一个 pass：pingpong → final（named 保持，执行器据此把 lastOutput 设为该 RT）
  const last = passes[passes.length - 1];
  if (last && last.write.type === 'pingpong') last.write = { type: 'final' };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/effect-graph.test.ts --reporter=basic`
Expected: PASS（23 项；全库用例打印 `RT 图链 24 条；单链具名 RT 最多 8 张`）

- [ ] **Step 5: 回归既有分类测试**

Run: `npx vitest run tests/object-effects.test.ts --reporter=basic`
Expected: PASS（`isLinearEffectChain` 仍导出、24/106 数字不变 —— 本任务不删它）

- [ ] **Step 6: 提交**

```bash
git add src/client/effect-graph.ts tests/effect-graph.test.ts
git commit -m "feat(effects): 计划补写端三态与线性链退化" -m "有 target 写具名 RT、末 pass 标 final；线性链退化为 bindings 空 + 全 pingpong" -m "全库回归：24 条 RT 图链全部可计划、无 droppedChains、单链具名 RT 最多 8 张"
```

---

### Task 4: `EffectRunner.setPlan`（具名 RT 池与生命周期）

**Files:**
- Modify: `src/client/effect-runner.ts`（新增字段、`setPlan`、`ensureNamedTargets`、`clearNamedTargets`；`setChains` 与 `dispose` 收口）
- Test: `tests/effect-runner.test.ts`（追加 describe）

**Interfaces:**
- Consumes: `EffectPlan` / `NAMED_RT_LIMIT`（`effect-graph.ts`）；既有 `resolveTargetSize`、`ensureTargets`
- Produces: `EffectRunner.setPlan(plan: EffectPlan, chains: CompiledEffectPass[][], wallpaperId: string, opts?: {width?, height?}): void`；私有 `namedRt: Map<string, THREE.WebGLRenderTarget>`

- [ ] **Step 1: 写失败测试**

追加到 `tests/effect-runner.test.ts`（import 追加 `buildEffectPlan`）：

```ts
import { buildEffectPlan, NAMED_RT_LIMIT } from '../src/client/effect-graph.js';
```

```ts
/** 读私有具名 RT 池（只作观测；执行器不导出它）。 */
function namedOf(runner: EffectRunner): Map<string, THREE.WebGLRenderTarget> {
  return (runner as unknown as { namedRt: Map<string, THREE.WebGLRenderTarget> }).namedRt;
}

describe('EffectRunner.setPlan（具名 RT 池与生命周期）', () => {
  it('按计划的 namedTargets 建池，尺寸 = 对象 RT ÷ scale', () => {
    const { renderer } = createBindRenderer();
    const fb = { _rt_Q1: 4, _rt_Q2: 2 };
    const chain = [pass({ target: '_rt_Q1', fboScale: fb }), pass({ target: '_rt_Q2', fboScale: fb })];
    const plan = buildEffectPlan([chain], { baseWidth: 64, baseHeight: 32 });
    const runner = new EffectRunner(renderer as never, 64, 32);
    runner.setPlan(plan, [chain], 'wp1', { width: 64, height: 32 });
    const named = namedOf(runner);
    expect([...named.keys()]).toEqual(['0:_rt_Q1', '0:_rt_Q2']);
    expect([named.get('0:_rt_Q1')!.width, named.get('0:_rt_Q1')!.height]).toEqual([16, 8]);
    expect([named.get('0:_rt_Q2')!.width, named.get('0:_rt_Q2')!.height]).toEqual([32, 16]);
    runner.dispose();
  });

  it('resize 重挂（setPlan 新尺寸）→ 旧具名 RT 被释放、按新基准重建', () => {
    const { renderer } = createBindRenderer();
    const chain = [pass({ target: '_rt_Q1', fboScale: { _rt_Q1: 4 } })];
    const runner = new EffectRunner(renderer as never, 64, 32);
    runner.setPlan(buildEffectPlan([chain], { baseWidth: 64, baseHeight: 32 }), [chain], 'wp1', { width: 64, height: 32 });
    const oldRt = namedOf(runner).get('0:_rt_Q1')!;
    const spy = vi.spyOn(oldRt, 'dispose');
    runner.setPlan(buildEffectPlan([chain], { baseWidth: 128, baseHeight: 64 }), [chain], 'wp1', { width: 128, height: 64 });
    expect(spy).toHaveBeenCalled();
    expect(namedOf(runner).get('0:_rt_Q1')!.width).toBe(32);
    runner.dispose();
  });

  it('dispose → 具名 RT 全部释放、池清空', () => {
    const { renderer } = createBindRenderer();
    const chain = [pass({ target: '_rt_Q1' })];
    const runner = new EffectRunner(renderer as never, 16, 16);
    runner.setPlan(buildEffectPlan([chain], { baseWidth: 16, baseHeight: 16 }), [chain], 'wp1', { width: 16, height: 16 });
    const rt = namedOf(runner).get('0:_rt_Q1')!;
    const spy = vi.spyOn(rt, 'dispose');
    runner.dispose();
    expect(spy).toHaveBeenCalled();
    expect(namedOf(runner).size).toBe(0);
  });

  it('链被 droppedChains 丢弃 → 不建该链的池，且按壁纸+链序号告警一次', () => {
    const { renderer } = createBindRenderer();
    const many = Array.from({ length: NAMED_RT_LIMIT + 1 }, (_, i) => pass({ target: `_rt_${i}` }));
    const plan = buildEffectPlan([many], { baseWidth: 16, baseHeight: 16 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new EffectRunner(renderer as never, 16, 16);
    runner.setPlan(plan, [many], 'wp9', { width: 16, height: 16 });
    expect(namedOf(runner).size).toBe(0);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('wp9')).length).toBe(1);
    warn.mockRestore();
    runner.dispose();
  });

  it('setChains（旧场景级路径）不残留上一份计划的具名 RT', () => {
    const { renderer } = createBindRenderer();
    const chain = [pass({ target: '_rt_Q1' })];
    const runner = new EffectRunner(renderer as never, 16, 16);
    runner.setPlan(buildEffectPlan([chain], { baseWidth: 16, baseHeight: 16 }), [chain], 'wp1', { width: 16, height: 16 });
    expect(namedOf(runner).size).toBe(1);
    runner.setChains([[pass()]], 'wp1');
    expect(namedOf(runner).size).toBe(0);
    runner.dispose();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/effect-runner.test.ts --reporter=basic`
Expected: FAIL —— `runner.setPlan is not a function`

- [ ] **Step 3: 写最小实现**

在 `src/client/effect-runner.ts` 顶部 import 追加：

```ts
import { NAMED_RT_LIMIT, type EffectPlan } from './effect-graph.js';
```

在 `EffectRunner` 类内新增字段（放在 `private failed = new Set<string>();` 之后）：

```ts
  private plan: EffectPlan | null = null;
  // 具名 RT 池：key = `${chainIndex}:${name}`（作用域 = 单条链，见 effect-graph.ts 头注）
  private namedRt = new Map<string, THREE.WebGLRenderTarget>();
  private chainWarned = new Set<string>();
```

新增方法（放在 `setChains` 之前）：

```ts
  /** 挂载带具名 RT 的效果计划。**只允许在加载期 / resize 重挂期调用**（帧内不得建 RT，§5.11）。 */
  setPlan(
    plan: EffectPlan,
    chains: CompiledEffectPass[][],
    wallpaperId: string,
    opts?: { width?: number; height?: number },
  ): void {
    this.plan = plan;
    this.chains = chains;
    this.id = wallpaperId;
    this.last = null;
    this.failed.clear();
    const size = resolveTargetSize({ width: this.width, height: this.height }, opts);
    this.ensureTargets(size.width, size.height);
    this.ensureNamedTargets(plan);
    this.disposeMaterials();
    this.textures.clear();
    for (const pass of chains.flat()) {
      for (const path of pass.textureSlots) {
        if (path) void this.resolveTextureSlot(path);
      }
    }
  }

  /** 具名 RT 池：先释放旧的再按计划重建（resize / 换壁纸 / 重挂链共用）。 */
  private ensureNamedTargets(plan: EffectPlan): void {
    this.clearNamedTargets();
    for (const target of plan.namedTargets) {
      this.namedRt.set(target.key, new THREE.WebGLRenderTarget(target.width, target.height));
    }
    for (const chainIndex of plan.droppedChains) {
      const key = `${this.id}:${chainIndex}`;
      if (this.chainWarned.has(key)) continue;
      this.chainWarned.add(key);
      console.warn(
        `[wallpaper-engine] 效果链 ${chainIndex} 的具名 RT 超过 ${NAMED_RT_LIMIT} 张，整链跳过（壁纸 ${this.id}）`,
      );
    }
  }

  private clearNamedTargets(): void {
    for (const rt of this.namedRt.values()) rt.dispose();
    this.namedRt.clear();
  }
```

`setChains` 开头补两行（旧路径无计划、不残留池）：

```ts
  setChains(
    chains: CompiledEffectPass[][],
    wallpaperId: string,
    opts?: { width?: number; height?: number },
  ): void {
    this.plan = null;
    this.clearNamedTargets();
    this.chains = chains;
```

`dispose()` 里补一行（在 `this.rtB.dispose();` 之后）：

```ts
    this.clearNamedTargets();
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/effect-runner.test.ts --reporter=basic`
Expected: PASS（既有 40+ 项 + 新增 5 项）

- [ ] **Step 5: 提交**

```bash
git add src/client/effect-runner.ts tests/effect-runner.test.ts
git commit -m "feat(effects): EffectRunner 支持具名 RT 池与 setPlan" -m "池作用域 = 单条链（key 带链序号），尺寸取计划的 namedTargets；resize/换壁纸/dispose 三处收口" -m "setChains 旧路径清空池；超上限的链按壁纸+链序号告警一次"
```

---

### Task 5: `EffectRunner.update` 按计划执行

**Files:**
- Modify: `src/client/effect-runner.ts`（`update` 主体、新增 `bindSlot`、退化计划构造）
- Test: `tests/effect-runner.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 4 的 `plan` / `namedRt`；Task 3 的写端三态；既有 `pickWriteTarget`、`effectSlotCount`、`resolveSlotFallback`、`resolveTextureResolution4`、`renderIntoRenderTarget`
- Produces: 帧内行为 —— 具名 RT 写/读、`previous` = 序列起点输入、`bindings` 覆盖槽、写具名 RT 的 pass 编译失败 ⇒ 整条计划放弃（`lastOutput()` 为 null）

- [ ] **Step 1: 写失败测试**

追加到 `tests/effect-runner.test.ts`：

```ts
describe('EffectRunner 按计划执行（具名 RT 写读 / previous 序列 / 槽覆盖）', () => {
  // 记录每次渲染的写端（renderIntoRenderTarget 会先 setRenderTarget(rt)）
  function createPlanRenderer() {
    const mats: THREE.ShaderMaterial[] = [];
    const targets: Array<THREE.WebGLRenderTarget | null> = [];
    const renderer = {
      debug: { onShaderError: null as null | ((...a: unknown[]) => void) },
      setRenderTarget: vi.fn((rt: THREE.WebGLRenderTarget | null) => { targets.push(rt); }),
      render: vi.fn((scene: THREE.Scene) => {
        const mesh = scene.children[0] as THREE.Mesh;
        mats.push(mesh.material as THREE.ShaderMaterial);
      }),
    };
    return { renderer, mats, targets };
  }

  it('blurprecise 形态：p0 写具名 RT、p1 的 g_Texture0 = 该 RT、g_Texture1 = previous(=输入)', async () => {
    const { renderer, mats, targets } = createPlanRenderer();
    const fb = { _rt_FullCompoBuffer1: 1 };
    const chain = [
      pass({ target: '_rt_FullCompoBuffer1', fboScale: fb }),
      pass({ bind: [{ index: 0, name: '_rt_FullCompoBuffer1' }, { index: 1, name: 'previous' }], fboScale: fb }),
    ];
    const runner = new EffectRunner(renderer as never, 32, 16);
    runner.setPlan(buildEffectPlan([chain], { baseWidth: 32, baseHeight: 16 }), [chain], 'wp', { width: 32, height: 16 });
    const input = new THREE.Texture();
    await runner.update(0, input);

    const namedRt = namedOf(runner).get('0:_rt_FullCompoBuffer1')!;
    // p0 写到具名 RT（尺寸 32×16），p1 写到 ping-pong RT（不是具名 RT）
    expect(targets[0]).toBe(namedRt);
    expect(targets[1]).not.toBe(namedRt);
    // p1 的 g_Texture0 = 具名 RT 纹理、g_Texture1 = 对象 RT 输入（previous 落在序列起点输入）
    const p1 = mats[1];
    expect(p1.uniforms.g_Texture0.value).toBe(namedRt.texture);
    expect(p1.uniforms.g_Texture1.value).toBe(input);
    // 输出 = p1 的输出（ping-pong RT 纹理）
    expect(runner.lastOutput()).toBe(targets[1]!.texture);
    runner.dispose();
  });

  it('blur 形态：bind[0] 指向刚写的具名 RT，bind[2]=previous 拿到原始输入（不是上一 pass 输出）', async () => {
    const { renderer, mats } = createPlanRenderer();
    const fb = { _rt_Q1: 4, _rt_Q2: 4 };
    const chain = [
      pass({ target: '_rt_Q1', fboScale: fb }),
      pass({ target: '_rt_Q2', fboScale: fb }),
      pass({ target: '_rt_Q1', fboScale: fb }),
      pass({ bind: [{ index: 0, name: '_rt_Q1' }, { index: 2, name: 'previous' }], fboScale: fb }),
    ];
    const runner = new EffectRunner(renderer as never, 32, 16);
    runner.setPlan(buildEffectPlan([chain], { baseWidth: 32, baseHeight: 16 }), [chain], 'wp', { width: 32, height: 16 });
    const input = new THREE.Texture();
    await runner.update(0, input);
    const combine = mats[3];
    expect(combine.uniforms.g_Texture0.value).toBe(namedOf(runner).get('0:_rt_Q1')!.texture);
    expect(combine.uniforms.g_Texture2.value).toBe(input); // previous = 序列起点输入
    runner.dispose();
  });

  it('bind 覆盖 textures：被 bind 覆写的槽用 bind 的源，未被覆写的槽保持 textures 解析结果', async () => {
    const { renderer, mats } = createPlanRenderer();
    const slotTex = new THREE.Texture();
    const chain = [
      pass({ target: '_rt_H' }),
      pass({
        bind: [{ index: 1, name: 'previous' }],
        textureSlots: [null, 'util/white'],
      }),
    ];
    const runner = new EffectRunner(renderer as never, 8, 8, {
      load: async () => slotTex,
    });
    runner.setPlan(buildEffectPlan([chain], { baseWidth: 8, baseHeight: 8 }), [chain], 'wp', { width: 8, height: 8 });
    const input = new THREE.Texture();
    await runner.update(0, input);
    const p1 = mats[1];
    expect(p1.uniforms.g_Texture1.value).toBe(input);   // bind[1]=previous 覆写了 textures[1]
    expect(p1.uniforms.g_Texture0.value).toBe(namedOf(runner).get('0:_rt_H')!.texture);
    runner.dispose();
  });

  it('写具名 RT 的 pass 编译失败 → 整条计划放弃、lastOutput() 为 null（不采样半成品）', async () => {
    const { renderer } = createPlanRenderer();
    // 让探针渲染触发 onShaderError ⇒ getMaterial 判定编译失败
    renderer.render = vi.fn((scene: THREE.Scene) => {
      const cb = renderer.debug.onShaderError as null | ((...a: unknown[]) => void);
      if (cb) cb({ getShaderInfoLog: () => 'boom' } as never, {}, {}, {});
      void scene;
    });
    const chain = [pass({ target: '_rt_F' }), pass({ bind: [{ index: 0, name: '_rt_F' }] })];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new EffectRunner(renderer as never, 8, 8);
    runner.setPlan(buildEffectPlan([chain], { baseWidth: 8, baseHeight: 8 }), [chain], 'wp', { width: 8, height: 8 });
    const out = await runner.update(0, new THREE.Texture());
    expect(out).toBeNull();
    expect(runner.lastOutput()).toBeNull();
    warn.mockRestore();
    runner.dispose();
  });

  it('无 plan（setChains 旧路径）→ 走线性 ping-pong，末输出非 null（零回归）', async () => {
    const { renderer } = createPlanRenderer();
    const runner = new EffectRunner(renderer as never, 8, 8);
    runner.setChains([[pass()]], 'wp');
    const out = await runner.update(0, new THREE.Texture());
    expect(out).not.toBeNull();
    runner.dispose();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/effect-runner.test.ts --reporter=basic`
Expected: FAIL —— 第一项 `targets[0]` 是 `rtA`（不是具名 RT）、`g_Texture1` 为 null

- [ ] **Step 3: 写最小实现**

在 `src/client/effect-runner.ts` 的 `EffectRunner` 内新增去重告警工具（若尚无同名方法）：

```ts
  private warnedKeys = new Set<string>();

  private warnOnce(key: string, message: string): void {
    if (this.warnedKeys.has(key)) return;
    this.warnedKeys.add(key);
    console.warn(`[wallpaper-engine] ${message}`);
  }
```

同时把 `ensureNamedTargets` 里手写的 `chainWarned` 逻辑换成 `this.warnOnce(...)`（`chainWarned` 字段可删）。

在 `src/client/effect-runner.ts` 的 `EffectRunner` 内新增两个私有方法：

```ts
  /** 绑一个槽：纹理 + g_TextureNResolution（vec4 口径见 AGENT.md §5.17）。 */
  private bindSlot(material: THREE.ShaderMaterial, slot: number, tex: THREE.Texture | null): void {
    const u = material.uniforms[`g_Texture${slot}`];
    if (u) u.value = tex;
    const res = material.uniforms[`g_Texture${slot}Resolution`];
    if (res) {
      const r4 = resolveTextureResolution4(tex, this.width, this.height);
      res.value = new THREE.Vector4(r4.x, r4.y, r4.z, r4.w);
    }
  }

  /** 无计划（setChains 旧路径）时的退化计划：全部按线性 ping-pong。 */
  private plannedPasses(flat: CompiledEffectPass[]): PlannedPass[] {
    if (this.plan) return this.plan.passes;
    return this.chains.flatMap((chain, chainIndex) => chain.map((p, passIndex) => ({
      chainIndex,
      passIndex,
      bindings: [],
      write: { type: 'pingpong' } as RtWrite,
      blendMode: p.blendMode,
    })));
  }
```

> `flat` 参数仅用于保持调用点可读；若 lint 报未使用，改为 `private plannedPasses(): PlannedPass[]` 并从 `this.chains` 推导。

把 `update()` 的 pass 循环整段替换为：

```ts
  async update(time: number, input: THREE.WebGLRenderTarget | THREE.Texture): Promise<THREE.Texture | null> {
    if (this.updateInFlight) return null;
    this.updateInFlight = true;
    try {
      const flat: CompiledEffectPass[] = this.chains.flat();
      if (flat.length === 0) return null;
      const planned = this.plannedPasses(flat);
      if (planned.length === 0) return null;

      // 纹理槽统一预解析（await 集中在此；key 用链内下标，不用平坦下标——droppedChains 会错位）
      const slotTex = new Map<string, THREE.Texture | null>();
      for (const pp of planned) {
        const p = this.chains[pp.chainIndex][pp.passIndex];
        const slots = effectSlotCount(p);
        for (let j = 0; j < slots; j++) {
          const path = p.textureSlots[j];
          const key = `${pp.chainIndex}:${pp.passIndex}:${j}`;
          slotTex.set(key, path ? await this.resolveTextureSlot(path) : resolveSlotFallback(p, j));
        }
      }

      let readTex = resolveInputTexture(input);
      let lastWrite: THREE.WebGLRenderTarget | null = null;
      let last: THREE.Texture | null = null;
      // previous = 进入 target 序列前的输入（lwe CImage::configurePassTarget），逐链独立
      let inSeq = false;
      let effectInput: THREE.Texture | null = null;
      let currentChain = -1;

      for (const pp of planned) {
        const p = this.chains[pp.chainIndex][pp.passIndex];
        const key = `${pp.chainIndex}:${pp.passIndex}`;
        if (pp.chainIndex !== currentChain) {
          inSeq = false;
          effectInput = null;
          currentChain = pp.chainIndex;
        }
        const writesNamed = pp.write.type === 'named';
        const material = this.getMaterial(p, key);
        if (!material) {
          // 写具名 RT 的 pass 失败 ⇒ 派生读端会读到空 RT，整条计划放弃（spec §6）
          if (writesNamed) {
            this.renderer.setRenderTarget(null);
            this.last = null;
            return null;
          }
          continue; // ping-pong pass 失败：读端不变，继续（P1 既有语义）
        }
        if (writesNamed && !inSeq) {
          inSeq = true;
          effectInput = readTex;
        }
        // 默认槽绑定（slot 0 = 当前内容提供者；其余按 textures/空槽兜底）
        for (let j = 0; j < effectSlotCount(p); j++) {
          this.bindSlot(material, j, slotTex.get(`${pp.chainIndex}:${pp.passIndex}:${j}`) ?? null);
        }
        this.bindSlot(material, 0, readTex);
        // bind 覆盖项（优先级最高）
        for (const b of pp.bindings) {
          const tex = b.source.type === 'previous'
            ? effectInput
            : this.namedRt.get(b.source.key)?.texture ?? null;
          if (tex) this.bindSlot(material, b.slot, tex);
        }
        if (material.uniforms['g_Time']) material.uniforms['g_Time'].value = time;
        if (this.audioSpectrum) this.fillAudioUniforms(material, this.audioSpectrum);

        let writeTarget: THREE.WebGLRenderTarget;
        if (writesNamed) {
          const namedTarget = this.namedRt.get((pp.write as { key: string }).key);
          if (!namedTarget) {
            // 计划与池不一致（不应发生）：放弃整条计划，而不是写到错误目标
            this.warnOnce(`no-named-rt:${this.id}:${key}`, `具名 RT 缺失（${key}），放弃该效果链（壁纸 ${this.id}）`);
            this.renderer.setRenderTarget(null);
            this.last = null;
            return null;
          }
          writeTarget = namedTarget;
        } else {
          writeTarget = pickWriteTarget(lastWrite, this.rtA, this.rtB);
          lastWrite = writeTarget;
        }
        renderIntoRenderTarget(this.renderer, writeTarget, this.getScene(key, material), SCREEN_CAMERA);
        readTex = writeTarget.texture;
        last = readTex;
        if (!writesNamed && inSeq) {
          inSeq = false;
          effectInput = null;
        }
      }
      this.renderer.setRenderTarget(null);
      this.last = last;
      return last;
    } finally {
      this.updateInFlight = false;
    }
  }
```

同时把 `PlannedPass` / `RtWrite` 类型加进 `effect-runner.ts` 的 import：

```ts
import { NAMED_RT_LIMIT, type EffectPlan, type PlannedPass, type RtWrite } from './effect-graph.js';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/effect-runner.test.ts --reporter=basic`
Expected: PASS（既有 40+ 项 + 新增 5 项）

- [ ] **Step 5: 回归对象级编排（可能与 stage 的调用契约冲突）**

Run: `npx vitest run tests/object-effects.test.ts tests/three-renderer.test.ts --reporter=basic`
Expected: PASS（Task 4 保留了 `setChains`，`mount` 尚未改用 `setPlan` ⇒ 本步应零回归；若失败，先修接线再进 Task 6）

- [ ] **Step 6: 提交**

```bash
git add src/client/effect-runner.ts tests/effect-runner.test.ts
git commit -m "feat(effects): 执行器按计划执行具名 RT 图" -m "写端三态 + bind 按 g_Texture<index> 覆盖 + previous = 目标序列起点输入（逐链独立）" -m "写具名 RT 的 pass 编译失败即整条计划放弃（lastOutput 为 null，回退对象 RT 原图）"
```

---

### Task 6: `object-effects` 去整链跳过、改用 `setPlan`

**Files:**
- Modify: `src/client/object-effects.ts`
- Test: `tests/object-effects.test.ts`

**Interfaces:**
- Consumes: `buildEffectPlan` / `EffectPlan`（`effect-graph.ts`）；Task 4 的 `EffectRunner.setPlan`
- Produces: `ObjectEffectStage.setObjectChains(objId, chains)` 对**所有**链挂载（不再有 `rtGraphSkips()`）；`ObjectChainEntry` 持有 `plan`

- [ ] **Step 1: 改测试为先（新行为）**

编辑 `tests/object-effects.test.ts`：

① mock 的 `EffectRunner` 加 `setPlan`（第 126-136 行的 mock 工厂内）：

```ts
vi.mock('../src/client/effect-runner.js', () => {
  class EffectRunner {
    constructor(...args: unknown[]) { runnerCtorArgs.push(args); }
    setChains = vi.fn();
    setPlan = vi.fn();
    setAudioSpectrumSource = vi.fn();
    update = vi.fn(async () => null);
    lastOutput = vi.fn(() => null);
    dispose = vi.fn();
  }
  return { EffectRunner };
});
```

② 把「RT 图链整条跳过并只告警一次」（原第 222-236 行）整段替换为：

```ts
  it('RT 图链照常挂载：setPlan 收到含具名 RT 的计划（不再整链跳过）', () => {
    const host = createHost([{ id: 1, rtWidth: 100, rtHeight: 50 }]);
    const stage = new ObjectEffectStage(host as never, { wallpaperId: 'w', screenScale: 1 });
    const rtChain = [
      pass({ target: '_rt_FullCompoBuffer1', fboScale: { _rt_FullCompoBuffer1: 1 } }),
      pass({ bind: [{ index: 0, name: '_rt_FullCompoBuffer1' }, { index: 1, name: 'previous' }] }),
    ];
    stage.setObjectChains(1, [rtChain]);
    const entry = (stage as unknown as {
      entries: Map<number, { plan: { namedTargets: Array<{ key: string }> } | null }>;
    }).entries.get(1);
    expect(entry?.plan?.namedTargets.map((t) => t.key)).toEqual(['0:_rt_FullCompoBuffer1']);
    // 与线性链一致：所有链都挂载，不再有 rtGraphSkips()
    expect(typeof (stage as unknown as { rtGraphSkips?: unknown }).rtGraphSkips).toBe('undefined');
  });
```

③ 把「RT 图链的对象不建 runner，bindOutputs 不调用 setObjectOutput」（原第 237-252 行）替换为：

```ts
  it('RT 图链的对象照常建 runner；链未有输出前 bindOutputs 不动输出（quad 保持对象 RT 原图）', () => {
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }]);
    const stage = new ObjectEffectStage(host as never, { wallpaperId: 'w', screenScale: 1 });
    const rtChain = [pass({ target: '_rt_F' }), pass({ bind: [{ index: 0, name: '_rt_F' }] })];
    stage.setObjectChains(1, [rtChain]);
    expect(stage.debugRunners().size).toBe(1);
    stage.bindOutputs();                       // mock runner 的 lastOutput() 恒 null
    expect(host._outputs.has(1)).toBe(false);  // 未就绪 → 不切输出
  });
```

④ 「setObjectChains 为线性链创建 runner，并把对象 chains 展平后交给它」（原第 205-221 行）里对 `setChains` 的断言改为 `setPlan`：把断言 `setChains` 入参/次数的部分改为读 `setPlan.mock.calls`，并断言第二参数（chains）与第三参数（wallpaperId）与既有断言一致。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/object-effects.test.ts --reporter=basic`
Expected: FAIL —— `entry.plan` 为 undefined（`mount` 仍走 `setChains`）

- [ ] **Step 3: 改实现**

`src/client/object-effects.ts`：

① 顶部 import 追加：

```ts
import { buildEffectPlan, type EffectPlan } from './effect-graph.js';
```

② `ObjectChainEntry` 加字段：

```ts
interface ObjectChainEntry {
  runner: EffectRunner | null;
  chains: CompiledEffectPass[][];
  /** 本次挂载的计划（resize 重挂时按新尺寸重建）。 */
  plan: EffectPlan | null;
  worldW: number;
  worldH: number;
}
```

③ `setObjectChains` 去掉分类与跳过（改为全部挂载），并把 `rtGraphSkips()` 方法整体删除：

```ts
  setObjectChains(objId: number, chains: CompiledEffectPass[][]): void {
    if (this.disposed) return;
    if (chains.length === 0) return;
    const view = this.host.isolatedObjects().find((o) => o.id === objId);
    if (!view) {
      this.warnOnce(`no-isolated:${objId}`, `对象 ${objId} 尚无隔离条目，效果链未挂载（调用顺序错误）`);
      return;
    }
    this.mount(objId, chains, view.rtWidth, view.rtHeight);
  }
```

④ `mount` 改为建计划 + `setPlan`：

```ts
  private mount(objId: number, chains: CompiledEffectPass[][], rtW: number, rtH: number): void {
    let entry = this.entries.get(objId);
    if (!entry) {
      entry = { runner: null, chains, plan: null, worldW: rtW / this.scale(), worldH: rtH / this.scale() };
      this.entries.set(objId, entry);
    }
    entry.chains = chains;
    entry.plan = buildEffectPlan(chains, { baseWidth: rtW, baseHeight: rtH });
    if (!entry.runner) {
      entry.runner = new EffectRunner(this.host.renderer, rtW, rtH, { load: weVRowOrderLoader() });
    }
    entry.runner.setPlan(entry.plan, chains, this.wallpaperId, { width: rtW, height: rtH });
  }
```

⑤ `onViewportResize` 里重挂 runner 的那两行改为重建计划 + `setPlan`：

```ts
      if (!entry.runner) continue;
      entry.plan = buildEffectPlan(entry.chains, { baseWidth: size.width, baseHeight: size.height });
      entry.runner.setPlan(entry.plan, entry.chains, this.wallpaperId, { width: size.width, height: size.height });
```

⑥ `setWorldSize` 里新建条目时补 `plan: null`；`debugInjectRunner` 同样补 `plan: null`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/object-effects.test.ts --reporter=basic`
Expected: PASS（全部用例；含新写的两段）

- [ ] **Step 5: 提交**

```bash
git add src/client/object-effects.ts tests/object-effects.test.ts
git commit -m "feat(effects): 编排器改为对所有链挂载 RT 图计划" -m "删除 isLinearEffectChain 整链跳过与 rtGraphSkips()；mount/resize 改调 setPlan（计划按对象 RT 尺寸重建）" -m "单测改用例：RT 图链照常建 runner，链未就绪前 bindOutputs 不动输出"
```

---

### Task 7: `three-renderer` 准入放开 + `rtGraphOnly` 清理 + effect 级 `visible`

**Files:**
- Modify: `src/client/three-renderer.ts`
- Test: `tests/three-renderer.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `setObjectChains`（不再跳过）
- Produces: isolate 准入 = 「有链」；`fx.visible === false` 的 effect 不进链表

- [ ] **Step 1: 改测试为先**

`tests/three-renderer.test.ts`：

① 把「链全为具名 RT 图链的对象不进 isolate；线性对象（含 colorBlendMode=7）照常隔离」（原第 675 行起）改写为：

```ts
  it('链全为具名 RT 图链的对象**照常**隔离（P2 起可执行，不再有 rtGraphOnly 优化）', async () => {
    stubAssetFetch(sceneWith([
      {
        id: 13, name: 'rtgraph', image: 'models/a.json',
        origin: '960 540 0', scale: '1 1 1', size: '3840 2160',
        effects: [{ file: 'effects/rtg/effect.json' }],
      },
    ]), FX_FILES_RT_GRAPH);
    resolveImageTexture.mockResolvedValue(fakeTexture() as never);
    defaultLoadWasm.mockResolvedValue(null);
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage: vi.fn(),
      renderer: {},
      // P2 起这类对象进入隔离（真实 player 会为 isolate 里每个对象建条目）
      isolatedObjects: () => [{ id: 13, kind: 'background', rtWidth: 3840, rtHeight: 2160, rtTexture: {} }],
    };
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [] } as never);
    const worldSpy = vi.spyOn(ObjectEffectStage.prototype, 'setWorldSize').mockImplementation(() => {});
    const chainsSpy = vi.spyOn(ObjectEffectStage.prototype, 'setObjectChains').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2132420420', document.createElement('canvas'), null)).toBe(true);
    const assets = loadSceneToThree.mock.calls[0][1];
    expect(assets.isolate.has(13)).toBe(true);                    // ← 反转点（原为 false）
    expect(worldSpy.mock.calls.map((c) => c[0])).toEqual([13]);
    expect(chainsSpy.mock.calls.map((c) => c[0])).toEqual([13]);
    // 不再有「效果需要具名 RT（P2 未实现）」告警
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('效果需要具名 RT'))).toHaveLength(0);
    worldSpy.mockRestore();
    chainsSpy.mockRestore();
    warn.mockRestore();
    r.dispose();


  });
```

> `FX_FILES_RT_GRAPH` 是该文件既有的具名 RT 图链 fixture（原用例就在用）；观测方式沿用该文件既有的 `console.warn` spy 与 `ObjectEffectStage.prototype` spy。

② 新增用例：

```ts
  it('effect 级 visible:false 的 effect 不进链表（lwe CImage 语义），且不在解析阶段告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const desc = {
      camera: { center: [0, 0, 0], eye: [0, 0, 0], up: [0, 1, 0] },
      orthogonal: { width: 100, height: 100 },
      objects: [
        { kind: 'image', id: 7, name: 'a', origin: [0, 0, 0], scale: [1, 1, 1], image: 'x',
          effects: [{ file: 'effects/w/effect.json', visible: false }] },
      ],
    } as never;
    // 刻意不提供 material/shader：若过滤失效就会走解析并打「效果链解析失败」告警
    const files = new Map<string, Uint8Array>();
    files.set('effects/w/effect.json', new TextEncoder().encode(JSON.stringify({ passes: [{ material: 'materials/effects/w.json' }] })));
    const out = await collectObjectEffectChains(desc, async (n) => files.get(n) ?? null);
    expect(out.size).toBe(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('效果链解析失败'))).toBe(false);
    warn.mockRestore();
  });



  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/three-renderer.test.ts --reporter=basic`
Expected: FAIL —— 仍会打印「效果需要具名 RT（P2 未实现）」；`visible:false` 的 effect 仍进链表

- [ ] **Step 3: 改实现**

`src/client/three-renderer.ts`：

① `collectObjectEffectChains` 内过滤不可见 effect：

```ts
    for (const fx of group.effects as Array<{ file?: string; passes?: unknown[]; visible?: boolean }>) {
      if (typeof fx?.file !== 'string') continue;
      // effect 级可见性：lwe CImage::setupPasses 对 visible=false 的 effect 整条跳过（正常内容，不告警）
      if (fx.visible === false) continue;
      const chain = await resolveEffectChain({ file: fx.file, passes: fx.passes }, loadFile);
```

② 删除 `rtGraphOnly` 声明（第 272-275 行）与整个 `if (!usable) { … }` 分支（第 280-304 行）—— 准入回到「有链即隔离」：

```ts
        for (const obj of desc.objects) {
          const chains = effectChains.get(obj.id);
          if (!chains || chains.length === 0) continue;
          if (obj.kind === 'image') {
```

③ 删除第 370-372 行对 `rtGraphOnly` 的引用（该 `continue` 条件只留 `isolate.has(objId)`）。

④ 若 `isLinearEffectChain` 在 `three-renderer.ts` 内已无引用，从 import 行移除（`import { ObjectEffectStage } from './object-effects.js';`）；`warnOnce` 若也无其它使用则一并清理（grep 确认后再删）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/three-renderer.test.ts tests/object-effects.test.ts --reporter=basic`
Expected: PASS

- [ ] **Step 5: 全量单测回归（排除既有 15 项失败）**

Run: `npx vitest run --reporter=basic`
Expected: 与基线相比只多出本计划新增用例；既有失败仍为 15 项（`wasm-renderer` 7 / `scene-renderer` 6 / `verify-real-library` 1 / `dom/bootstrap.dom` 1）

- [ ] **Step 6: 提交**

```bash
git add src/client/three-renderer.ts tests/three-renderer.test.ts
git commit -m "feat(effects): isolate 准入放开为「有链即隔离」并过滤不可见 effect" -m "删除 rtGraphOnly 分支与其「不再隔离」告警（具名 RT 链已可执行）" -m "effect 级 visible=false 整条跳过（对齐 lwe），不打降级告警"
```

---

### Task 8: 端到端验证（判据反转 + 亮部提升 + 5 样本）

**Files:**
- Modify: `research/verify-object-effects.mjs`（gitignore，不入提交）
- 产物：`research/object-effects/*.png`、控制台报告

**Interfaces:**
- Consumes: `lib/` 生产代码（**先 `npm run build`**）；脚本既有的 `runPage(id, opts)` / `diffStat(A,B,mask)` / `mutateScene(id, fn)` / `R.checks`
- Produces: [3a]/[3b] 判据反转、【3c】GTR、【5】亮部提升

- [ ] **Step 1: 反转 [3] 的告警判据**

`research/verify-object-effects.mjs` 第 781-788 行改为：

```js
    const rtWarns = r.logs.filter((l) => l.text.includes('效果需要具名 RT'));
    const namedRtOver = r.logs.filter((l) => l.text.includes('的具名 RT 超过'));
    say(`  「效果需要具名 RT，跳过」告警条数 = ${rtWarns.length}（P2 后应为 0）`);
    for (const e of rtWarns) say(`    ${e.text.slice(0, 220)}`);
    say(`  「具名 RT 超过上限，整链跳过」告警条数 = ${namedRtOver.length}`);
    const ok = consErrs.length === 0 && excs.length === 0;
    R.checks.push({ name: `[${tag}] 无 console error`, pass: ok, why: `${consErrs.length} 条 + ${excs.length} 条异常` });
    R.checks.push({ name: `[${tag}] 具名 RT 链已可执行（零跳过告警）`, pass: rtWarns.length === 0, why: `${rtWarns.length} 条` });
```

同步把 82-83 行常量注释改为 P2 口径（`WP_RTGRAPH` 现在用于验证"text 上的链不报错"、`WP_RTGRAPH2` 验证"image 上的 blurprecise 生效"）。

- [ ] **Step 2: 新增 [3c] GTR bloom 段**

在判定 3 的 `for` 循环之后插入：

```js
  // ═══ 判定 3c：GTR bloom（16 pass / 8 张全尺寸具名 RT）════════════════════════
  {
    const id = '3743126786';
    say(`\n===== [3c] ${id}（16 pass 全尺寸具名 RT 的 bloom 链）=====`);
    const r = await runPage(id, { label: 'gtr-bloom' });
    if (r.fail) { say('  ' + r.fail); R.checks.push({ name: '[3c] 无 error', pass: false, why: r.fail }); }
    else {
      writeFileSync(join(OUT, 'check3c-A.png'), r.A);
      writeFileSync(join(OUT, 'check3c-B.png'), r.B);
      const consErrs = r.logs.filter((l) => (l.kind === 'cdp-console' || l.kind === 'page') && l.level === 'error');
      const rtWarns = r.logs.filter((l) => l.text.includes('效果需要具名 RT'));
      R.checks.push({ name: '[3c] 无 console error', pass: consErrs.length === 0, why: `${consErrs.length} 条` });
      R.checks.push({ name: '[3c] 零跳过告警', pass: rtWarns.length === 0, why: `${rtWarns.length} 条` });
      R.checks.push({ name: '[3c] 隔离对象数 > 0（16 pass 链的对象确实进了隔离）', pass: (r.stats?.isolated ?? 0) > 0, why: `isolated=${r.stats?.isolated}` });
    }
  }
```

- [ ] **Step 3: 新增 [5] 亮部提升段（bloom 是否真的发光）**

在 [4] 段之前插入：

```js
  // ═══ 判定 5：具名 RT 链的**可见效果**——GTR 的 bloom 应抬高亮部（盒外零变化）══════
  // 口径：同一帧对比「含 bloom」与「去掉该对象的 effects」两张图；bloom 抬高云/城市灯的亮部
  // （分位数 p90/p99），且差值只出现在该对象盒内。桌面对照需用户截图，见 spec §7.4。
  {
    const id = '3743126786';
    const objId = 17;   // 挂 16 pass bloom 链的对象
    const pct = (P, q) => {
      const arr = new Uint8Array(256);
      for (let i = 0; i < P.length; i += 4) {
        arr[Math.round(0.299 * P[i] + 0.587 * P[i + 1] + 0.114 * P[i + 2])]++;
      }
      let acc = 0; const total = P.length / 4;
      for (let v = 0; v < 256; v++) { acc += arr[v]; if (acc >= total * q) return v; }
      return 255;
    };
    say(`\n===== [5] 具名 RT 链的可见效果：${id} obj ${objId} 的 bloom ═════`);
    const withFx = await runPage(id, { label: 'bloom-on' });
    const withoutFx = await runPage(id, { label: 'bloom-off', overrides: { dropEffectsFor: objId } });
    if (withFx.fail || withoutFx.fail) {
      say(`  跳过：[5] 运行失败（${withFx.fail ?? withoutFx.fail}）`);
      R.checks.push({ name: '[5] bloom 亮部提升', pass: false, why: String(withFx.fail ?? withoutFx.fail) });
    } else {
      const A = decodePng(withFx.A), B = decodePng(withoutFx.A);
      const p90on = pct(A.data, 0.9), p90off = pct(B.data, 0.9);
      const p99on = pct(A.data, 0.99), p99off = pct(B.data, 0.99);
      const s = diffStat(A, B, null);
      say(`  分位数（含 bloom / 无该对象 effects）：p90 ${p90on} / ${p90off}，p99 ${p99on} / ${p99off}`);
      say(`  两图最大差 ${s.maxDelta}、变化 ${(s.ratio * 100).toFixed(2)}%`);
      R.checks.push({ name: '[5] bloom 亮部提升（p99 提升 ≥ 5）', pass: p99on - p99off >= 5, why: `p99 ${p99off} → ${p99on}` });
      R.report.judge5 = { p90on, p90off, p99on, p99off, maxDelta: s.maxDelta, ratio: s.ratio };
    }
  }
```

> `overrides: { dropEffectsFor: objId }` 需要 harness 支持"丢弃指定对象的 effects"。`research/harness-object-effects-entry.mjs` 已有 `mutateScene` 类似的注入口（脚本第 864 行 `mutateScene(id, fn)` 走的是 `overrides.mutate`）；实施时按 harness 现有的 overrides 字段命名接入（读 `harness-object-effects-entry.mjs` 里 `overrides` 的分支，加一个 `dropEffectsFor` 分支：在 scene.objects 里把该对象的 `effects` 置空）。**若接入成本高，可退化为用 [2] 的 mask 判据**：断言"含 bloom 与去掉整张壁纸 effects 的亮部差 > 0 且变化只在该对象盒内"。

- [ ] **Step 4: 跑 5 个样本**

```bash
npm run build
node research/verify-object-effects.mjs 2>&1 | Tee-Object research/object-effects/rt-graph-run1.log
```

Expected（逐条检查控制台）：
- `[1]` PASS（既有 waterwaves 回归）
- `[2]` PASS（盒外零变化）
- `[3a]/[3b]` PASS（零 console error + **零跳过告警**）
- `[3c]` PASS（GTR：零 error、零跳过告警、isolated > 0）
- `[4]` 打印帧时间与显存（数字仅相对信号）
- `[5]` PASS（bloom 使 p99 提升 ≥ 5）
- 末尾 checks 汇总无 FAIL

- [ ] **Step 5: 另外 3 个样本回归（blur/localcontrast/godrays/shine）**

对 `2011060960`（blur + localcontrast，双链同名 RT）、`2937346640`（godrays）、`1968789468`（shine）各跑一次 `runPage` 并检查：console error = 0、跳过告警 = 0、帧间差分 > 0（效果在动）。

在脚本的判定 3 循环里把这三个 id 也加进去（`['3d', '2011060960', 'blur+localcontrast 双链同名 RT']`、`['3e', '2937346640', 'godrays scale=2']`、`['3f', '1968789468', 'shine scale=2']`），复用同一套判据（零 error + 零跳过告警）。

- [ ] **Step 6: 记录结果**

把 6 个样本的实际输出（各段 PASS/FAIL + 关键数字）写进 `AGENT.md` §7（Task 10 执行；本步先把日志留在 `research/object-effects/rt-graph-run1.log`）。

---

### Task 9: 具名 RT 显存测量

**Files:**
- Create: `research/q-named-rt-vram.mjs`（gitignore）
- Modify: `AGENT.md`（Task 10 一并做）

**Interfaces:**
- Consumes: `buildEffectPlan`（`lib/client/effect-graph.js`）、`objectRtSize` / `screenScalePx`（`lib/client/object-range.js`）、pkg 读取
- Produces: 全库每壁纸的"对象 RT + ping-pong + 具名 RT"显存表（1080p@dpr1 与 @dpr2）

- [ ] **Step 1: 写脚本**

```js
// research/q-named-rt-vram.mjs
// 全库显存估算（对象 RT + runner ping-pong + **具名 RT**）：1080p@dpr1 与 @dpr2 两档。
// 口径与 spec §5.1 一致：具名 RT 像素 = 对象 RT 像素 ÷ fbos.scale（未声明 = 1）。
import { PkgReader } from '../lib/host/pkg-reader.js';
import { resolveEffectChain } from '../lib/client/shader/effect-chain.js';
import { buildEffectPlan } from '../lib/client/effect-graph.js';
import { parseSceneJson } from '../lib/client/scene-json.js';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'd:/steam/steamapps/workshop/content/431960';
const VIEW = { w: 1920, h: 1080 };
const bytes = (w, h) => w * h * 4;

for (const dpr of [1, 2]) {
  const rows = [];
  for (const id of readdirSync(ROOT)) {
    let reader;
    try { reader = new PkgReader(join(ROOT, id, 'scene.pkg')); } catch { continue; }
    const raw = reader.readEntry('scene.json');
    if (!raw) continue;
    let desc; try { desc = parseSceneJson(Buffer.from(raw).toString('utf8')); } catch { continue; }
    const loadFile = async (n) => { const e = reader.readEntry(n); return e ? new Uint8Array(e) : null; };
    const ortho = desc.orthogonal;
    if (!ortho) continue;
    // 屏幕密度：画布缓冲宽 / cover 视锥宽（与主相机同源；此处用场景比例近似 cover）
    const sceneAspect = ortho.width / ortho.height;
    const viewAspect = VIEW.w / VIEW.h;
    const coverW = sceneAspect > viewAspect ? ortho.width : ortho.height * viewAspect;
    const scale = (VIEW.w * dpr) / coverW;
    let objRtBytes = 0, namedBytes = 0, pingBytes = 0;
    for (const obj of desc.objects ?? []) {
      const chains = [];
      for (const fx of obj.effects ?? []) {
        if (typeof fx?.file !== 'string' || fx.visible === false) continue;
        const chain = await resolveEffectChain({ file: fx.file, passes: fx.passes }, loadFile);
        if (chain) chains.push(chain);
      }
      if (chains.length === 0) continue;
      const texW = obj.size?.[0] ?? 1, texH = obj.size?.[1] ?? 1;
      const world = { w: Math.abs(texW * obj.scale[0]), h: Math.abs(texH * obj.scale[1]) };
      const rtW = Math.min(4096, Math.max(1, Math.round(world.w * scale)));
      const rtH = Math.min(4096, Math.max(1, Math.round(world.h * scale)));
      objRtBytes += bytes(rtW, rtH);
      pingBytes += 2 * bytes(rtW, rtH);
      const plan = buildEffectPlan(chains, { baseWidth: rtW, baseHeight: rtH });
      for (const t of plan.namedTargets) namedBytes += bytes(t.width, t.height);
    }
    const total = objRtBytes + pingBytes + namedBytes;
    if (total > 0) rows.push({ id, objRtBytes, pingBytes, namedBytes, total });
  }
  rows.sort((a, b) => b.total - a.total);
  const mb = (b) => (b / 1048576).toFixed(1);
  console.log(`\n=== ${VIEW.w}×${VIEW.h} @dpr${dpr}（只列前 12 张）===`);
  console.log('壁纸            对象RT     ping-pong   具名RT     合计(MB)');
  for (const r of rows.slice(0, 12)) {
    console.log(`${r.id}  ${mb(r.objRtBytes).padStart(7)}  ${mb(r.pingBytes).padStart(9)}  ${mb(r.namedBytes).padStart(8)}  ${mb(r.total).padStart(8)}`);
  }
  const namedTotal = rows.reduce((s, r) => s + r.namedBytes, 0);
  const maxNamed = Math.max(0, ...rows.map((r) => r.namedBytes));
  console.log(`具名 RT：全库合计 ${mb(namedTotal)} MB；单壁纸最大 ${mb(maxNamed)} MB`);
}
```

- [ ] **Step 2: 跑并核对量级**

```bash
node research/q-named-rt-vram.mjs 2>&1 | Tee-Object research/q-named-rt-vram.log
```

Expected：`3743126786` 的具名 RT 一栏最大（8 张全尺寸，1080p@dpr1 约 66 MB）；其余壁纸 < 10 MB。若 `3743126786` 不是最大或量级差一个数量级，先查 `buildEffectPlan` 的 scale 解析再继续。（**实现期订正 2026-09-15**：该链 `fbos` 实际声明 scale=2/4/8/16（降采样金字塔），实测约 **5.3 MB** —— 本行「8 张全尺寸约 66 MB」是错的预期，实测才是准；见 spec §5.1 与 `AGENT.md` §7.1。）

- [ ] **Step 3: 提交（脚本 gitignore，无代码改动）**

本任务不产生入库改动；数字在 Task 10 写进 `AGENT.md`。若 `git status` 显示 `research/` 以外有改动，说明前序任务尚未提交，先补提交。

---

### Task 10: 文档、用户向说明与产物

**Files:**
- Modify: `AGENT.md`（§2.1、§5 新增条目、§7）
- Modify: `README.md`（"使用前请了解"一节）
- Rebuild & commit: `lib/`、`dist/`

**Interfaces:**
- Consumes: Task 8/9 的实测日志与显存表
- Produces: 与实现一致的文档

- [ ] **Step 1: 更新 `AGENT.md` §2.1**

把「three 路径**已接通对象级效果链（P1）**，但**具名 RT 图链**…仍未实现 —— 这是与 wasm 侧相比**剩余**的能力差」改为：three 路径已接通对象级效果链并**支持具名 RT 图链（P2，2026-09-15）**，全库 130 条效果引用中 **106 条线性链 + 24 条 RT 图链**均可执行；并写明 wasm 备用路径的 `bind` 索引语义偏差（`bind[0] → g_Texture1`，与 lwe 的 `bind.index → g_Texture<index>` 不符）。

- [ ] **Step 2: 更新 `AGENT.md` §5（新增条目 28）**

新增一条「28. **具名 RT 图链的执行语义（P2，2026-09-15）**」，内容要点（每条一行，指向 spec）：

- 具名 RT 尺寸 = 对象 RT ÷ `fbos.scale`（未声明 = 1），池作用域 = 单条链；
- `bind.index` = `g_Texture<index>`；`bind` 优先于 `textures`；
- `previous` = **进入 target 序列前的输入**（不是上一 pass 输出）；
- 写具名 RT 的 pass 编译失败 ⇒ 整条计划放弃（回退对象 RT 原图）；
- 不可解析的 `bind`（全库 1 处 `_rt_FullFrameBuffer`）回落默认槽 + 告警一次；
- 未做显存 cap；清屏沿用透明清屏（与 lwe 的 Load 语义差异及影响面）。

- [ ] **Step 3: 更新 `AGENT.md` §7**

- §7.1 的 P2 遗留条目改为**已达成**，并如实标注：24 条链里 **10 条挂在 text/util 对象上**（管线支持但看不见）、`_rt_FullFrameBuffer` 1 处降级、未做 cap、FPS 门槛仍未在真机验证；
- 贴入 Task 8 的 6 样本实测结果与 Task 9 的显存表（表格形式，数字照抄日志）；
- §7「备用 wasm 路径」条目补一句：其 RT 图执行的 `bind` 索引语义与 lwe 不符（未接入运行时，本次未改）。

- [ ] **Step 4: 更新 `README.md`**

「使用前请了解 → 画面表现」里删掉这一条：

```
- **部分特效不会出现**：模糊、泛光、光轴、局部对比度这类需要多趟渲染的特效**暂不支持**——壁纸本身照常显示，只是这几个效果看不到。
```

替换为：

```
- **模糊、泛光、光轴、局部对比度现在支持了**：这些多趟渲染的特效已在本地实时执行（含 16 趟的泛光链）。若仍看不到效果，多半是它们挂在文字/合成层对象上——那类对象的渲染还没做。
```

同时把「能做什么」表格里「常见特效会动」一行的括注（"少数复杂特效暂不支持"）改为与之一致的口径。

- [ ] **Step 5: 重建产物并提交**

```bash
npm run build
npm run build:client
git add AGENT.md README.md lib dist src tests
git commit -m "docs: 记录具名 RT 图执行器（P2）的达成与遗留" -m "AGENT §2.1/§5/§7：能力差消除、执行语义条目、10 条挂在 text/util 上看不见、未做显存 cap" -m "README 去掉「模糊/泛光/光轴/局部对比度暂不支持」；重建 lib/dist"
```

- [ ] **Step 6: 最终回归**

```bash
npx vitest run --reporter=basic
```

Expected：新增用例全绿；既有 15 项失败不变（与基线一致）。

---

## Self-Review（写完计划后的自检）

**Spec 覆盖**：§2 事实基础 → 本计划 Task 1-3 的测试即其可执行形式；§3 接口 → Task 1/4；§4 执行语义 → Task 2/3/5；§5 资源与生命周期 → Task 4（池与尺寸）、Task 5（清屏沿用）；§6 降级 → Task 4（超限告警）、Task 5（链放弃）、Task 7（visible 过滤）；§7 测试与验收 → Task 1-7 的单测 + Task 8 的端到端 + Task 9 的显存；§7.5 文档 → Task 10。**无缺口**。

**占位符扫描**：Task 7 Step 1 的两处断言与 Task 8 Step 3 的 `overrides` 字段名依赖"该文件现有的观测/注入手段"，已在步骤内写明**以现有实现为准的判读方式**（warn spy / `mutateScene` 的 overrides 分支），不是空承诺；其余步骤均给出可直接写入的代码。

**类型一致性**：`EffectPlan` / `PlannedPass` / `RtSource` / `RtWrite` / `NAMED_RT_LIMIT`（Task 1 定义）在 Task 2/3/4/5/6 的引用一致；`setPlan(plan, chains, wallpaperId, opts)` 的四处调用点（Task 4 定义、Task 5 测试、Task 6 实现与 resize 重挂）签名一致；`namedRtKey(chainIndex, name)` 在纯函数与池 key 上同一形式。


---
