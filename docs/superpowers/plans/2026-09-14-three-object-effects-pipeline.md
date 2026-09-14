# three.js 主路径对象级效果链（effects）管线 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `scene.json` 每个对象的 `effects` 效果链在 three.js 主路径上以**对象级局部 RT** 方式真正执行——全库 106/130 条线性链生效，24 条具名 RT 图链显式跳过并告警。

**Architecture:** `threejs-player.ts` 新增「对象隔离渲染」能力（带效果对象的 mesh/粒子进独立 `localScene`，主场景放一张合成 quad 顶上它的位置）；`object-effects.ts` 负责效果链编排（每对象一个 `EffectRunner`，复用未改动的 `effect-runner.ts` 执行器与 `shader/effect-chain.ts` 解析器）；`three-renderer.ts` 把此前被丢弃的 `effects` 解析成链并装配到 player 上。

**Tech Stack:** TypeScript（ESM、strict）、three.js r170（WebGL2）、vitest（node + jsdom）、esbuild（client 打包）、headless Edge（端到端验证）。

**Spec:** `docs/superpowers/specs/2026-09-14-three-object-effects-pipeline-design.md`

## Global Constraints

- **语言**：注释、文档、提交信息一律简体中文；代码/命令/文件名/术语保留原文。
- **坐标约定（不得违反）**：`three = we − scene/2`，**y 不翻转**；对象 model matrix = `T·R·S`，`angles` 是**弧度**，旋转顺序 `Rz·Ry·Rx`。新代码不得引入 y 翻转或 `scale.y` 取负（`AGENT.md` §2.3）。
- **对象 RT 单边上限 = 4096**（`scene-renderer.ts:53` 的 `OBJECT_RT_MAX`，以代码为准；`AGENT.md` §5.10 写的 2048 是过时值，Task 6 一并订正）。
- **加载期一次性编译（硬约束）**：效果链的解析、材质创建、`setChains`、探针编译全部在**加载阶段**完成；帧内只写 uniform + 提交 pass（`AGENT.md` §5.11）。
- **未实现就回退，绝不静默画错**（`AGENT.md` §5.6）：具名 RT 图链整条跳过 + `console.warn`，不得用线性执行器硬跑。
- **零回归**：不传 `isolate` 时，`ThreeScenePlayer` 的逐帧调用序列与今天**逐字相同**。
- **构建命令**：只改 client 侧 → `npm run build:client`（本特性**不碰 Rust**，无需 `build:wasm`）。类型检查用 `npm run build`（`tsc -p tsconfig.json`）。
- **测试基线**：全量 `npm test` 有 **15 项既有失败**（`wasm-renderer` 7 / `scene-renderer` 6 / `verify-real-library` 1 / `dom/bootstrap.dom` 1，`AGENT.md` §7.11）。改动后必须与 `git stash` 基线对比，**不得把既有失败当成本次回归**。
- **单文件测试**：`npx vitest run tests/<file>.test.ts --reporter=basic`。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/client/object-range.ts` | 创建 | 对象级几何/尺寸/分组纯函数的**唯一实现**（从 `scene-renderer.ts` 移入） |
| `src/client/scene-renderer.ts` | 修改 | 移出上述函数，改为 import + 重新导出（既有 import 方零改动） |
| `src/client/object-effects.ts` | 创建 | 效果链编排：`isLinearEffectChain` / `resolveObjectRtSize` / `ObjectEffectStage` |
| `src/client/threejs-player.ts` | 修改 | 对象隔离能力、隔离内容渲染、帧钩子、对象输出接线 |
| `src/client/three-renderer.ts` | 修改 | 解析 `effects` → 装配 `ObjectEffectStage` 到 player |
| `tests/object-range.test.ts` | 创建 | 纯函数回归（含 re-export 同一性） |
| `tests/object-effects.test.ts` | 创建 | 分类器 / RT 尺寸预算 / 编排 / 降级 |
| `tests/threejs-player.test.ts` | 修改 | 隔离模式 + 零回归调用序列断言 |
| `research/verify-object-effects.mjs` | 创建 | headless Edge 端到端（效果在动 + 对象级判据） |
| `AGENT.md` | 修改 | §5.10 订正 4096、§7.1 据实改写 |

**依赖方向**：`three-renderer.ts` → `object-effects.ts` → { `object-range.ts`, `effect-runner.ts`, `shader/effect-chain.ts` }；`threejs-player.ts` **不 import** `object-effects.ts`（只导出一个结构化接口供其实现）。

---

### Task 1: 提取 `object-range.ts`（纯移动，零行为变化）

**Files:**
- Create: `src/client/object-range.ts`
- Modify: `src/client/scene-renderer.ts`（删除移出的实现，改为 import + re-export）
- Test: `tests/object-range.test.ts`
- Modify: `docs/superpowers/specs/2026-09-14-three-object-effects-pipeline-design.md`（两处表述精确化，见 Step 6）

**Interfaces:**
- Consumes: 无（本任务不依赖其他任务）
- Produces（`object-range.ts` 的新导出面，后续任务与既有代码共用）：
  - `CAMERA_DISTANCE: number`（= 300）
  - `OBJECT_RT_MAX: number`（= 4096，本任务新导出——此前是模块私有）
  - `PARTICLE_DEFAULT_DISTANCE: number`（= 64）
  - `materialModulation(color?: [number,number,number], alpha?: number, brightness?: number): { r: number; g: number; b: number; a: number }`
  - `objectCameraRange(objSize: [number,number], scale: [number,number]): { w: number; h: number }`
  - `particleObjectRange(spec: { distanceMax?: number }, scale: [number,number]): { w: number; h: number }`
  - `particleWorldSize(spec: { distanceMax?: number }, scale: [number,number]): { w: number; h: number }`
  - `createObjectRenderTarget(width: number, height: number): THREE.WebGLRenderTarget`
  - `shouldUseObjectPath(obj: { effects?: unknown }): obj is { effects: unknown[] }`
  - `groupEffectsByObject(objects: SceneObject[]): Array<{ obj: SceneObject; effects: unknown[] }>`
  - `class PendingChainStore<T> { applyIfReady(objId: number, chains: T, hasEntry: boolean): boolean; take(objId: number): T | undefined; clear(): void }`
  - `uvWindow(unclamped: number, clamped: number): { start: number; end: number }`
  - `createCompositeGeometry(worldW: number, worldH: number, rtW: number, rtH: number): THREE.PlaneGeometry`
  - `coverRange(width: number, height: number, viewAspect: number): { w: number; h: number }`

- [ ] **Step 1: 写失败测试**

创建 `tests/object-range.test.ts`：

```ts
// 对象级效果链所需的共享纯函数。本文件断言两件事：
//   ① 行为与搬移前一致（关键边界：幅值/钳制/下限、UV 窗口、等比与钳制语义）；
//   ② scene-renderer.ts 的重新导出与 object-range.ts 是**同一个函数对象**
//      （防止有人日后在 scene-renderer 里再写一份实现，造成两处漂移）。
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CAMERA_DISTANCE, OBJECT_RT_MAX, PARTICLE_DEFAULT_DISTANCE,
  materialModulation, objectCameraRange, particleObjectRange, particleWorldSize,
  createObjectRenderTarget, shouldUseObjectPath, groupEffectsByObject, PendingChainStore,
  uvWindow, createCompositeGeometry, coverRange,
} from '../src/client/object-range.js';
import * as sceneRenderer from '../src/client/scene-renderer.js';

describe('object-range 常量', () => {
  it('CAMERA_DISTANCE=300 / OBJECT_RT_MAX=4096 / PARTICLE_DEFAULT_DISTANCE=64', () => {
    expect(CAMERA_DISTANCE).toBe(300);
    expect(OBJECT_RT_MAX).toBe(4096);
    expect(PARTICLE_DEFAULT_DISTANCE).toBe(64);
  });
});

describe('objectCameraRange', () => {
  it('按幅值取对象尺寸×缩放，逐轴钳制 4096、下限 1', () => {
    expect(objectCameraRange([100, 50], [2, 3])).toEqual({ w: 200, h: 150 });
    // 负 scale 是对象自身镜像，不改变可见大小（取幅值），也不得被下限钳成 1
    expect(objectCameraRange([100, 50], [-2, -0.18])).toEqual({ w: 200, h: 9 });
    expect(objectCameraRange([10000, 10], [1, 1])).toEqual({ w: 4096, h: 10 });
    expect(objectCameraRange([0, 0], [1, 1])).toEqual({ w: 1, h: 1 });
  });
});

describe('particleObjectRange / particleWorldSize', () => {
  const spec = { distanceMax: 100 };
  it('范围取 |distanceMax × scale| 并钳制；缺省 distanceMax 回退 64', () => {
    expect(particleObjectRange(spec, [2, 1])).toEqual({ w: 200, h: 100 });
    expect(particleObjectRange({}, [1, 1])).toEqual({ w: 64, h: 64 });
    expect(particleObjectRange({ distanceMax: 0 }, [1, 1])).toEqual({ w: 64, h: 64 });
  });
  it('世界尺寸 = 未钳制的 |distanceMax × scale|（钳制只发生在 RT 范围）', () => {
    expect(particleWorldSize({ distanceMax: 10000 }, [1, 1])).toEqual({ w: 10000, h: 10000 });
  });
});

describe('uvWindow / createCompositeGeometry', () => {
  it('未钳制轴（clamped ≥ unclamped）→ 全窗口；钳制轴 → 居中窗口', () => {
    expect(uvWindow(100, 100)).toEqual({ start: 0, end: 1 });
    expect(uvWindow(100, 200)).toEqual({ start: 0, end: 1 });
    expect(uvWindow(100, 50)).toEqual({ start: 0.25, end: 0.75 });
    expect(uvWindow(0, 50)).toEqual({ start: 0, end: 1 });
  });
  it('合成几何尺寸取幅值（镜像活在 RT 内容里，不在 quad 帧上二次翻转）', () => {
    const geo = createCompositeGeometry(-200, 100, 200, 100);
    const pos = geo.attributes.position.array as Float32Array;
    // PlaneGeometry(200,100) 的 x 极值应为 ±100
    expect(Math.max(...Array.from(pos).filter((_, i) => i % 3 === 0))).toBeCloseTo(100, 5);
    expect(Math.min(...Array.from(pos).filter((_, i) => i % 3 === 0))).toBeCloseTo(-100, 5);
  });
});

describe('分组与调度谓词', () => {
  it('shouldUseObjectPath 仅对非空 effects 数组为真', () => {
    expect(shouldUseObjectPath({ effects: [] })).toBe(false);
    expect(shouldUseObjectPath({ effects: [{ file: 'a' }] })).toBe(true);
    expect(shouldUseObjectPath({})).toBe(false);
  });
  it('groupEffectsByObject 按 objects 顺序保留每对象自身 effects，且跳过 text', () => {
    const objs = [
      { kind: 'image', id: 1, effects: [{ file: 'a' }] },
      { kind: 'text', id: 2, effects: [{ file: 'b' }] },
      { kind: 'particle', id: 3, effects: [{ file: 'c' }] },
      { kind: 'image', id: 4 },
    ] as never[];
    const groups = groupEffectsByObject(objs);
    expect(groups.map((g) => g.obj.id)).toEqual([1, 3]);
    expect(groups[0].effects).toEqual([{ file: 'a' }]);
  });
});

describe('PendingChainStore', () => {
  it('条目已存在 → 就地应用；否则暂存并在 take 时取出一次', () => {
    const store = new PendingChainStore<string[]>();
    expect(store.applyIfReady(7, ['x'], true)).toBe(true);
    expect(store.take(7)).toBeUndefined();
    expect(store.applyIfReady(7, ['y'], false)).toBe(false);
    expect(store.take(7)).toEqual(['y']);
    expect(store.take(7)).toBeUndefined();
  });
});

describe('createObjectRenderTarget / coverRange / materialModulation', () => {
  it('RT 尺寸取整并下限 1（不产生退化 RT）', () => {
    const rt = createObjectRenderTarget(100.4, 0);
    expect(rt.width).toBe(100);
    expect(rt.height).toBe(1);
    rt.dispose();
  });
  it('coverRange 按视口宽高比裁剪', () => {
    expect(coverRange(1920, 1080, 1920 / 1080)).toEqual({ w: 1920, h: 1080 });
    expect(coverRange(1920, 1080, 1)).toEqual({ w: 1920, h: 1920 });
  });
  it('materialModulation：color/255×brightness、alpha 钳制 0-1', () => {
    expect(materialModulation()).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(materialModulation([255, 128, 0], 0.5, 0.5).a).toBeCloseTo(0.5, 5);
    expect(materialModulation([255, 255, 255], undefined, 2).r).toBe(1);
  });
});

describe('re-export 同一性（防两处实现漂移）', () => {
  it('scene-renderer.ts 的导出与 object-range.ts 是同一函数对象', () => {
    expect(sceneRenderer.objectCameraRange).toBe(objectCameraRange);
    expect(sceneRenderer.uvWindow).toBe(uvWindow);
    expect(sceneRenderer.createCompositeGeometry).toBe(createCompositeGeometry);
    expect(sceneRenderer.coverRange).toBe(coverRange);
    expect(sceneRenderer.materialModulation).toBe(materialModulation);
    expect(sceneRenderer.PendingChainStore).toBe(PendingChainStore);
    expect(sceneRenderer.CAMERA_DISTANCE).toBe(CAMERA_DISTANCE);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/object-range.test.ts --reporter=basic`
Expected: FAIL —— `Failed to resolve import "../src/client/object-range.js"`。

- [ ] **Step 3: 创建 `object-range.ts`（把实现整体移入）**

新建 `src/client/object-range.ts`，文件头写：

```ts
// src/client/object-range.ts
// 对象级效果链所需的几何 / 尺寸 / 分组 / 竞态纯函数 —— **唯一实现**。
//
// 这些函数一期在 scene-renderer.ts 中实现并已单测；three 主路径的对象级效果链
// （object-effects.ts）同样需要它们，故移到本模块，scene-renderer.ts 改为
// import + 重新导出（既有 import 方零改动、单测零改动）。
// 移动是纯机械的：实现逐字保持不变。
import * as THREE from 'three';
import type { SceneObject } from '../shared/types.js';
```

随后从 `src/client/scene-renderer.ts` **逐字复制以下符号的实现**（含其上方注释）到本文件，并加上 `export`：

| 源行号（`scene-renderer.ts`，移动前） | 符号 | 备注 |
|---|---|---|
| `:49` | `CAMERA_DISTANCE` | 已是 export |
| `:53` | `OBJECT_RT_MAX` | 此行需**新增** `export` 关键字 |
| `:92` | `PARTICLE_DEFAULT_DISTANCE` | 已是 export |
| `:60-74` | `materialModulation` | 已是 export |
| `:82-87` | `objectCameraRange` | 已是 export |
| `:96-99` | `effectiveParticleDistance` | 模块私有，保持私有 |
| `:106-112` | `particleObjectRange` | 已是 export |
| `:116-119` | `particleWorldSize` | 已是 export |
| `:123-125` | `createObjectRenderTarget` | 已是 export |
| `:130-132` | `shouldUseObjectPath` | 已是 export |
| `:139-148` | `groupEffectsByObject` | 已是 export |
| `:158-173` | `PendingChainStore` | 已是 export |
| `:264-268` | `uvWindow` | 已是 export |
| `:277-286` | `applyUvWindow` | 模块私有，保持私有 |
| `:294-300` | `createCompositeGeometry` | 已是 export |
| `:303-311` | `containRange` | 模块私有，`scene-renderer.ts` 内部仍用 |
| `:316-324` | `coverRange` | 已是 export |

**注意 `effectiveParticleDistance` / `applyUvWindow` 必须是 `object-range.ts` 的模块私有函数**（它们只被同文件的其他函数调用），且 `scene-renderer.ts` 侧**不要**再保留一份。

- [ ] **Step 4: 改 `scene-renderer.ts` 为 import + 重新导出**

在 `scene-renderer.ts` 顶部（`import * as THREE from 'three';` 之后）加入：

```ts
// 对象级几何/尺寸/分组纯函数已移至 object-range.ts（唯一定义处）。
// 此处 import 供本模块内部使用，并原样重新导出以保持既有 import 方（wasm-renderer.ts、
// threejs-player.ts、tests）零改动。⚠️ 不要在此文件重新实现这些函数。
import {
  CAMERA_DISTANCE, OBJECT_RT_MAX, PARTICLE_DEFAULT_DISTANCE,
  materialModulation, objectCameraRange, particleObjectRange, particleWorldSize,
  createObjectRenderTarget, shouldUseObjectPath, groupEffectsByObject, PendingChainStore,
  uvWindow, createCompositeGeometry, coverRange, containRange,
} from './object-range.js';

export {
  CAMERA_DISTANCE, OBJECT_RT_MAX, PARTICLE_DEFAULT_DISTANCE,
  materialModulation, objectCameraRange, particleObjectRange, particleWorldSize,
  createObjectRenderTarget, shouldUseObjectPath, groupEffectsByObject, PendingChainStore,
  uvWindow, createCompositeGeometry, coverRange,
};
```

`containRange` 只 import 不导出（它在 `scene-renderer.ts` 内部使用，此前也未导出）。

**⚠️ 关键点**：`export { x } from './y.js'` 形式**不会**在当前模块建立本地绑定，因此 `scene-renderer.ts` 内部对这些函数的所有调用（`setScene` / `frame` / `createObjectEntry` 等）必须走上面这条 `import` 语句。不要用 `export ... from` 的简写形式。

同时删除 `scene-renderer.ts` 中被移走的那 16 个符号的定义（含各自上方的注释块）。删除后 `scene-renderer.ts` 中不得残留任何同名函数/常量。

- [ ] **Step 5: 跑测试确认通过，并做类型检查与回归**

Run: `npx vitest run tests/object-range.test.ts tests/scene-renderer.test.ts tests/threejs-player.test.ts --reporter=basic`
Expected: `object-range.test.ts` 全绿；`scene-renderer.test.ts` 与 `threejs-player.test.ts` 结果与改动前**完全一致**（`scene-renderer.test.ts` 有 6 项既有失败，属基线）。

Run: `npm run build`
Expected: `tsc` 无错误（若报 `Cannot find name 'objectCameraRange'`，说明 Step 4 的 import 漏了某个被内部调用的符号）。

- [ ] **Step 6: 精确化 spec 的两处表述**

`docs/superpowers/specs/2026-09-14-three-object-effects-pipeline-design.md` §4.1 中「主 scene 里放一张合成 `PlaneGeometry` quad，其 `position` = 对象 origin 的 `we_to_three` 值（`origin - scene/2`，y 不翻）、`rotation` = 对象 angles、`scale` = 对象 scale」改为准确表述：

```
主 scene 里放一张合成 quad（几何尺寸 = `createCompositeGeometry(|size×scale|, rt.width, rt.height)`，
即世界尺寸已含缩放，quad 自身 `scale` 恒为 1）：`position` = `origin − scene/2`（y 不翻）、
`rotation` = 对象 angles；而局部 `localScene` 里的**内容**只保留 `scale`（含负值镜像）、
`position` 归零、`rotation` 归零 —— 效果因此作用在对象**自身纹理空间**（spec §2.3 论据 b），
旋转由合成 quad 施加。
```

同文件 §4.2 的接口块改为：

```ts
// 隔离内容的渲染（setRenderTarget + render(localScene, localCamera)）由 player 自己完成，
// 因为它拥有 scene/camera；stage 只负责「输出绑定」与「链推进」两件事。
export interface ObjectEffectStage {
  bindOutputs(): void;          // 主场景渲染之前：quad 采样效果输出或对象 RT
  advance(time: number): void;  // 主场景渲染之后：串行推进 runner.update（异步，不阻塞本帧）
}
```

- [ ] **Step 7: 提交**

```bash
git add src/client/object-range.ts src/client/scene-renderer.ts tests/object-range.test.ts docs/superpowers/specs/2026-09-14-three-object-effects-pipeline-design.md
git commit -m "refactor(client): 提取 object-range.ts 作为对象级几何纯函数的唯一定义处

根因：对象级效果链需要的几何/尺寸/分组纯函数（objectCameraRange、uvWindow、
createCompositeGeometry、PendingChainStore 等）一期实现在 scene-renderer.ts 里，
而 three 主路径要对它们做第二次消费；若各自实现会立刻出现两处漂移。

改法：整体移入 object-range.ts（实现逐字不变，OBJECT_RT_MAX 由私有改为导出），
scene-renderer.ts 改为 import + 重新导出，既有 import 方（wasm-renderer.ts、
threejs-player.ts、tests）零改动。

验证：tests/object-range.test.ts 断言行为边界 + re-export 同一性（toBe）；
scene-renderer/threejs-player 既有测试结果与改动前一致；npm run build 无错误。"
```

---

### Task 2: 效果链分类器与对象 RT 尺寸预算

**Files:**
- Create: `src/client/object-effects.ts`（本任务只放纯函数与类型）
- Test: `tests/object-effects.test.ts`

**Interfaces:**
- Consumes: `CompiledEffectPass`（`src/client/shader/effect-chain.js`）、`OBJECT_RT_MAX`（Task 1）
- Produces:
  - `isLinearEffectChain(passes: CompiledEffectPass[]): boolean`
  - `resolveObjectRtSize(worldW: number, worldH: number, dpr: number, budgetW: number, budgetH: number): { width: number; height: number }`
  - `interface ObjectEffectStage { bindOutputs(): void; advance(time: number): void }`（导出，供 Task 5 的 player 结构化消费）

- [ ] **Step 1: 写失败测试**

创建 `tests/object-effects.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { isLinearEffectChain, resolveObjectRtSize } from '../src/client/object-effects.js';
import type { CompiledEffectPass } from '../src/client/shader/effect-chain.js';

// 造一个最小 CompiledEffectPass：只填本任务关心的字段（其余为占位值）。
function pass(over: Partial<CompiledEffectPass> = {}): CompiledEffectPass {
  return {
    vertSrc: '', fragSrc: '', rawVert: '', rawFrag: '',
    combos: {}, uniforms: new Map(), textureSlots: [], blendMode: 'normal',
    target: null, bind: [], fboScale: {},
    ...over,
  };
}

describe('isLinearEffectChain', () => {
  it('单 pass、无 target/bind → 线性可执行（现有 ping-pong 语义正确）', () => {
    expect(isLinearEffectChain([pass()])).toBe(true);
  });
  it('纯多 pass（无 target/bind，如 refraction 2 pass）→ 线性可执行（previous 默认语义）', () => {
    expect(isLinearEffectChain([pass(), pass()])).toBe(true);
  });
  it('pass 写出具名 RT（target 非空）→ 非线性的 RT 图链', () => {
    expect(isLinearEffectChain([pass({ target: '_rt_FullCompoBuffer1' }), pass()])).toBe(false);
  });
  it('pass 采样具名 RT（bind 非空）→ 非线性的 RT 图链', () => {
    expect(isLinearEffectChain([pass({ bind: [{ name: 'previous', index: 0 }] })])).toBe(false);
  });
  it('只有 fbos 声明但没有 target/bind → 仍视为线性（fbo 无消费者）', () => {
    expect(isLinearEffectChain([pass({ fboScale: { _rt_a: 4 } })])).toBe(true);
  });
  it('空链 → false（没有任何 pass 可执行）', () => {
    expect(isLinearEffectChain([])).toBe(false);
  });
});

describe('resolveObjectRtSize', () => {
  it('无预算压力时 = 世界尺寸 × dpr（四舍五入）', () => {
    expect(resolveObjectRtSize(200, 100, 2, 3840, 2160)).toEqual({ width: 400, height: 200 });
  });
  it('超出画布预算 → 等比缩小（两轴同一比例，不破坏 aspect）', () => {
    // 8000×2000 @dpr1，预算 1920×1080：s = min(1920/8000, 1080/2000) = 0.24 → 1920×480
    expect(resolveObjectRtSize(8000, 2000, 1, 1920, 1080)).toEqual({ width: 1920, height: 480 });
  });
  it('预算本身超过硬上限 4096 时按 4096 收口（4096 单边上限不被预算放宽）', () => {
    // 世界 10000×10000 @dpr1，预算 8192×8192 → capW=capH=4096 → 4096×4096
    expect(resolveObjectRtSize(10000, 10000, 1, 8192, 8192)).toEqual({ width: 4096, height: 4096 });
  });
  it('退化输入（0/负）→ 逐轴下限 1，不产生 0 尺寸 RT', () => {
    expect(resolveObjectRtSize(0, -5, 1, 1920, 1080)).toEqual({ width: 1, height: 1 });
  });
  it('极端窄条保持比例（不被逐轴独立 clamp 压成方块）', () => {
    // 8192×4608 @dpr1 预算 4096×4096：s = min(4096/8192, 4096/4608) = 0.5 → 4096×2304（非 4096×4096）
    expect(resolveObjectRtSize(8192, 4608, 1, 4096, 4096)).toEqual({ width: 4096, height: 2304 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/object-effects.test.ts --reporter=basic`
Expected: FAIL —— `Failed to resolve import "../src/client/object-effects.js"`。

- [ ] **Step 3: 写最小实现**

创建 `src/client/object-effects.ts`：

```ts
// src/client/object-effects.ts
// three 主路径的对象级效果链编排。
//
// 分工（见 spec §3）：
//   - 本模块：效果链的**编排**（分类、尺寸预算、每对象一个 EffectRunner、串行推进、降级）。
//   - threejs-player.ts：对象的**隔离渲染**（内容进 localScene / 主场景放合成 quad / 帧序）。
//   - effect-runner.ts：pass 执行（本特性不改它一行）。
//
// 本模块不构造 three 场景、不持有 canvas；player 通过结构化接口（ObjectEffectStage）
// 被注入，因此本模块不 import threejs-player.ts（避免循环依赖）。
import type * as THREE from 'three';
import { OBJECT_RT_MAX } from './object-range.js';
import type { CompiledEffectPass } from './shader/effect-chain.js';

// player 消费的钩子接口（结构化匹配，player 不 import 本模块）。
// 隔离内容的渲染（setRenderTarget + render(localScene, localCamera)）由 player 自己完成，
// 因为它拥有 scene/camera；stage 只负责下面两件事。
export interface ObjectEffectStage {
  /** 主场景渲染之前：把每个隔离对象的合成 quad 绑到效果输出（或回退对象 RT 原图）。 */
  bindOutputs(): void;
  /** 主场景渲染之后：串行推进 runner.update（异步，不阻塞本帧）。 */
  advance(time: number): void;
}

// 线性可执行判定（spec §5.1）：无具名 RT 写出、也无具名 RT 采样。
//   - WE 效果链的默认读取源是 `previous`（上一 pass 输出），单 pass 与纯多 pass 都由
//     EffectRunner 的 ping-pong 正确实现（如 refraction 的 2 pass）；
//   - `fbos` 只对具名 RT 有意义：链内没有 target 时它没有消费者，不构成降级理由。
// 具名 RT 图链（blur / blurprecise / godrays / bloom / shine / localcontrast / bokeh_blur）
// 需要 RT 图执行器（P2），当前整条跳过——产品是错画面，不得硬跑。
export function isLinearEffectChain(passes: CompiledEffectPass[]): boolean {
  if (passes.length === 0) return false;
  return passes.every((p) => !p.target && p.bind.length === 0);
}

// 对象 RT 像素尺寸（spec §5.2）：
//   世界尺寸（场景像素，已含 objectCameraRange 的 4096 钳制与幅值语义）× dpr，
//   再**等比**收口到 min(4096, 画布缓冲预算)。
// 等比而非逐轴独立 clamp：独立 clamp 会把 8192×4608 压成 4096×4096，破坏依赖 aspect 的
// 效果（竞品 perf-audit 2026-08-29 记录的真实事故）。
export function resolveObjectRtSize(
  worldW: number,
  worldH: number,
  dpr: number,
  budgetW: number,
  budgetH: number,
): { width: number; height: number } {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const rawW = Math.max(0, Math.abs(worldW)) * scale;
  const rawH = Math.max(0, Math.abs(worldH)) * scale;
  const capW = Math.max(1, Math.min(OBJECT_RT_MAX, Math.floor(budgetW) || OBJECT_RT_MAX));
  const capH = Math.max(1, Math.min(OBJECT_RT_MAX, Math.floor(budgetH) || OBJECT_RT_MAX));
  // 两轴共用同一比例（等比）；rawW/rawH 为 0 时该轴的比例不参与（避免除零与 0×0）
  const ratios: number[] = [1];
  if (rawW > 0) ratios.push(capW / rawW);
  if (rawH > 0) ratios.push(capH / rawH);
  const s = Math.min(...ratios);
  const width = Math.max(1, Math.round(rawW * s));
  const height = Math.max(1, Math.round(rawH * s));
  return { width, height };
}

// 占位：本任务不实现（Task 4 落地）。保留类型引用避免未使用告警。
export type EffectTexture = THREE.Texture;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/object-effects.test.ts --reporter=basic`
Expected: PASS（13 项）。

- [ ] **Step 5: 全库链分类回归（把实测数字钉进测试）**

在 `tests/object-effects.test.ts` 追加一个全库回归 describe（与 `tests/verify-real-library.test.ts` 同样的 pkg 读取方式：`D:/Steam/steamapps/workshop/content/431960`；该目录不存在时 `it.skip`）：

```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveEffectChain } from '../src/client/shader/effect-chain.js';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';

function readPkgFiles(id: string): Map<string, Uint8Array> | null {
  const pkgPath = join(WALLPAPER_DIR, id, 'scene.pkg');
  if (!existsSync(pkgPath)) return null;
  const buf = readFileSync(pkgPath);
  const entries: Array<{ name: string; off: number; size: number }> = [];
  let pos = 16;
  let dataStart = -1;
  while (pos + 8 <= buf.length) {
    const nameLen = buf.readUInt32LE(pos);
    if (nameLen <= 0 || nameLen > 1024) { dataStart = pos; break; }
    const nameStart = pos + 4;
    const name = buf.toString('utf8', nameStart, nameStart + nameLen);
    const off = buf.readUInt32LE(nameStart + nameLen);
    const size = buf.readUInt32LE(nameStart + nameLen + 4);
    entries.push({ name, off, size });
    pos = nameStart + nameLen + 8;
  }
  const files = new Map<string, Uint8Array>();
  for (const e of entries) files.set(e.name, new Uint8Array(buf.subarray(dataStart + e.off, dataStart + e.off + e.size)));
  return files;
}

describe.skipIf(!existsSync(WALLPAPER_DIR))('全库效果链分类（实测数字，勿随意放宽）', () => {
  it('线性链 25 种 / 106 次引用；具名 RT 图链 9 种 / 24 次引用', async () => {
    const dirs = readdirSync(WALLPAPER_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    const linear = new Set<string>();
    const rtGraph = new Set<string>();
    let linearRefs = 0;
    let rtGraphRefs = 0;
    let unparsed = 0;
    for (const id of dirs) {
      const files = readPkgFiles(id);
      if (!files) continue;
      const scRaw = files.get('scene.json');
      if (!scRaw) continue;
      let scene: { objects?: Array<{ effects?: Array<{ file?: string; passes?: unknown[] }> }> };
      try { scene = JSON.parse(Buffer.from(scRaw).toString('utf8')); } catch { continue; }
      for (const obj of scene.objects ?? []) {
        for (const fx of obj.effects ?? []) {
          if (typeof fx.file !== 'string') continue;
          const loadFile = async (name: string) => files.get(name) ?? null;
          const chain = await resolveEffectChain({ file: fx.file, passes: fx.passes }, loadFile);
          if (!chain) { unparsed++; continue; }
          if (isLinearEffectChain(chain)) { linear.add(fx.file); linearRefs++; }
          else { rtGraph.add(fx.file); rtGraphRefs++; }
        }
      }
    }
    expect({ unparsed }).toEqual({ unparsed: 0 });
    expect(linearRefs).toBe(106);
    expect(rtGraphRefs).toBe(24);
    expect(linear.size).toBe(25);
    expect(rtGraph.size).toBe(9);
  }, 120_000);
});
```

Run: `npx vitest run tests/object-effects.test.ts --reporter=basic`
Expected: PASS。若数字不符，**先查清原因**（`resolveEffectChain` 解析失败会计入 `unparsed`），不要直接改期望值——这些数字是 spec §2.1 的事实基础。

- [ ] **Step 6: 提交**

```bash
git add src/client/object-effects.ts tests/object-effects.test.ts
git commit -m "feat(effects): 效果链线性判定与对象 RT 尺寸预算

改法：新增 object-effects.ts，含 isLinearEffectChain（无 target/bind 即可由现有
ping-pong 正确执行）与 resolveObjectRtSize（世界尺寸×dpr，等比收口到
min(4096, 画布预算)）。

证据：全库 28 张壁纸实测钉进测试——线性链 25 种/106 次、具名 RT 图链 9 种/24 次、
解析零失败（与 spec §2.1 一致）。等比而非逐轴 clamp，避免 8192×4608 被压成
4096×4096 破坏 aspect（竞品 perf-audit 记录的真实事故）。"
```

---

### Task 3: player 对象隔离能力与帧钩子

**Files:**
- Modify: `src/client/threejs-player.ts`（`addBackground` / `addParticle` 各加 `isolate`；新增隔离条目、内容渲染方法、帧钩子、访问器；`setAnimationLoop` / `render` / `dispose` 改）
- Test: `tests/threejs-player.test.ts`（追加）

**Interfaces:**
- Consumes: `createCompositeGeometry`、`CAMERA_DISTANCE`（Task 1 的 `object-range.js`；player 此前从 `scene-renderer.js` 拿，本任务把 import 源改为 `object-range.js` 以免经由 scene-renderer 转手）
- Produces（后续任务依赖的确切形状）：
  - `interface IsolatedObject { id: number; kind: 'background' | 'particle'; rt: THREE.WebGLRenderTarget; localScene: THREE.Scene; localCamera: THREE.OrthographicCamera; quad: THREE.Mesh; worldW: number; worldH: number }`
  - `interface ObjectEffectStage { bindOutputs(): void; advance(time: number): void }`（与 Task 2 同名同形，此处再导出一次供 player 自身类型使用）
  - `addBackground(opts: ... & { isolate?: { width: number; height: number } }): number`
  - `addParticle(getter, opts: ... & { isolate?: { width: number; height: number } }): number`
  - `isolatedObjects(): IsolatedObject[]`
  - `setObjectOutput(id: number, texture: THREE.Texture): void`
  - `resizeObjectRT(id: number, width: number, height: number): void`
  - `setObjectEffectStage(stage: ObjectEffectStage | null): void`

- [ ] **Step 1: 写失败测试**

在 `tests/threejs-player.test.ts` **文件末尾**追加（复用文件已有的 `createMockRenderer` / `makePlayer`）：

```ts
// ===== 对象隔离渲染（对象级效果链的前置能力）=====
describe('ThreeScenePlayer 对象隔离', () => {
  function makeTexture(): THREE.Texture {
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    tex.needsUpdate = true;
    return tex;
  }

  it('isolate：内容进 localScene（position/rotation 归零、scale 保留），主 scene 放合成 quad', () => {
    const { player } = makePlayer();
    const id = player.addBackground({
      origin: [960, 540, 0], size: [400, 200], scale: [2, 2, 1], angles: [0, 0, 0.5],
      texture: makeTexture(), sceneW: 1920, sceneH: 1080,
      isolate: { width: 400, height: 200 },
    });
    const iso = player.isolatedObjects();
    expect(iso).toHaveLength(1);
    const entry = iso[0];
    expect(entry.id).toBe(id);
    expect(entry.kind).toBe('background');
    expect(entry.rt.width).toBe(400);
    expect(entry.rt.height).toBe(200);
    // 内容：对象中心即局部原点，旋转归零（效果作用在对象自身纹理空间），缩放保留
    const content = entry.localScene.children[0] as THREE.Mesh;
    expect(content.position.toArray()).toEqual([0, 0, 0]);
    expect(content.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
    expect(content.scale.toArray()).toEqual([2, 2, 1]);
    // 合成 quad：世界位置 = origin - scene/2（y 不翻），旋转 = 对象 angles，尺寸 = |size×scale| 由几何承载
    expect(entry.quad.position.toArray()).toEqual([0, 0, 0]);
    expect(entry.quad.rotation.z).toBeCloseTo(0.5, 6);
    expect(entry.quad.scale.toArray()).toEqual([1, 1, 1]);
    // 主 scene 里只有合成 quad（内容不在主 scene）
    expect(player.scene.children).toContain(entry.quad);
    expect(player.scene.children).not.toContain(content);
  });

  it('不传 isolate 时行为不变：内容直接进主 scene，isolatedObjects 为空', () => {
    const { player } = makePlayer();
    player.addBackground({
      origin: [960, 540, 0], size: [400, 200], scale: [1, 1, 1],
      texture: makeTexture(), sceneW: 1920, sceneH: 1080,
    });
    expect(player.isolatedObjects()).toHaveLength(0);
    expect(player.scene.children).toHaveLength(1);
  });

  it('粒子隔离：uObjectCenter 归零（世界位移由合成 quad 承载）', () => {
    const { player } = makePlayer();
    const verts = () => new Float32Array([0, 0, 0, 10, 0, 0, 1, 1, 1, 1]);
    const id = player.addParticle(verts, {
      frameCount: 1, blend: 'alpha',
      objectCenter: [100, 50, 0], objectScale: [1, 1, 1], objectAngles: [0, 0, 0],
      isolate: { width: 64, height: 64 },
    });
    const entry = player.isolatedObjects().find((e) => e.id === id)!;
    expect(entry.kind).toBe('particle');
    const content = entry.localScene.children[0] as THREE.Mesh;
    const mat = content.material as THREE.ShaderMaterial;
    expect((mat.uniforms.objectCenter.value as THREE.Vector3).toArray()).toEqual([0, 0, 0]);
  });

  it('setObjectOutput 切换合成 quad 的采样源（MeshBasicMaterial 与 ShaderMaterial 两条路径）', () => {
    const { player } = makePlayer();
    const texA = makeTexture();
    const texB = makeTexture();
    const idBasic = player.addBackground({
      origin: [0, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: texA,
      sceneW: 100, sceneH: 100, isolate: { width: 10, height: 10 },
    });
    const idBlend = player.addBackground({
      origin: [0, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: texA, colorBlendMode: 7,
      sceneW: 100, sceneH: 100, isolate: { width: 10, height: 10 },
    });
    player.setObjectOutput(idBasic, texB);
    player.setObjectOutput(idBlend, texB);
    const basic = player.isolatedObjects().find((e) => e.id === idBasic)!.quad.material as THREE.MeshBasicMaterial;
    const blend = player.isolatedObjects().find((e) => e.id === idBlend)!.quad.material as THREE.ShaderMaterial;
    expect(basic.map).toBe(texB);
    expect(blend.uniforms.map.value).toBe(texB);
    // colorBlendMode=7（Screen）必须落在合成这一步：CustomBlending + OneMinusDstColor
    expect(blend.blending).toBe(THREE.CustomBlending);
    expect(blend.blendSrc).toBe(THREE.OneMinusDstColorFactor);
  });

  it('帧钩子按序调用：隔离内容渲染 → bindOutputs → 主场景渲染 → advance', () => {
    const { player, mock } = makePlayer();
    const order: string[] = [];
    (mock.render as unknown as { mockImplementation: (f: (s: unknown, c: unknown) => void) => void })
      .mockImplementation((s: unknown) => { order.push(s === player.scene ? 'main' : 'isolated'); });
    player.addBackground({
      origin: [0, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 100, sceneH: 100, isolate: { width: 10, height: 10 },
    });
    player.setObjectEffectStage({
      bindOutputs: () => order.push('bind'),
      advance: () => order.push('advance'),
    });
    player.render();
    expect(order).toEqual(['isolated', 'bind', 'main', 'advance']);
  });

  it('零回归：不传 isolate 且无 stage 时，render() 只渲染主场景一次', () => {
    const { player, mock } = makePlayer();
    player.render();
    expect(mock.render).toHaveBeenCalledTimes(1);
    expect((mock.render as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toBe(player.scene);
  });

  it('resizeObjectRT 重建 RT 并同步局部相机与合成几何', () => {
    const { player } = makePlayer();
    const id = player.addBackground({
      origin: [0, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 100, sceneH: 100, isolate: { width: 10, height: 10 },
    });
    const entry = player.isolatedObjects()[0];
    const oldGeo = entry.quad.geometry;
    player.resizeObjectRT(id, 40, 20);
    expect(entry.rt.width).toBe(40);
    expect(entry.rt.height).toBe(20);
    expect(entry.localCamera.left).toBe(-20);
    expect(entry.localCamera.right).toBe(20);
    expect(entry.quad.geometry).not.toBe(oldGeo);
  });

  it('dispose 释放隔离 RT / 合成 quad / 内容', () => {
    const { player } = makePlayer();
    player.addBackground({
      origin: [0, 0, 0], size: [10, 10], scale: [1, 1, 1], texture: makeTexture(),
      sceneW: 100, sceneH: 100, isolate: { width: 10, height: 10 },
    });
    const entry = player.isolatedObjects()[0];
    const rtDispose = vi.spyOn(entry.rt, 'dispose');
    player.dispose();
    expect(rtDispose).toHaveBeenCalled();
    expect(player.isolatedObjects()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/threejs-player.test.ts --reporter=basic`
Expected: 新增 8 项 FAIL（`player.isolatedObjects is not a function` 等）；既有测试仍与基线一致。

- [ ] **Step 3: 实现 player 侧能力**

在 `src/client/threejs-player.ts` 按以下顺序改动。

**(a) 改 import 源**（第 14 行）：

```ts
import { coverRange, CAMERA_DISTANCE, materialModulation, createCompositeGeometry } from './object-range.js';
```

**(b) 在 `class ThreeScenePlayer` 之前加类型**：

```ts
// 对象隔离条目（对象级效果链）：带 effects 的对象不直接画进主场景，而是
//   ① 内容进 localScene（对象中心 = 局部原点），渲染到 rt；
//   ② 主场景放一张合成 quad 顶在对象原位置，采样「效果链输出」或「rt 原图」。
// 局部内容只保留 scale（含负值镜像），position/rotation 归零——效果因此作用在对象**自身
// 纹理空间**，旋转与位移由合成 quad 承载（spec §2.3 论据 b）。
// rtWidth/rtHeight/rtTexture 是给效果链编排器的扁平视图（免它通过 rt 再取一层）。
export interface IsolatedObject {
  id: number;
  kind: 'background' | 'particle';
  rt: THREE.WebGLRenderTarget;
  rtWidth: number;
  rtHeight: number;
  rtTexture: THREE.Texture;
  localScene: THREE.Scene;
  localCamera: THREE.OrthographicCamera;
  quad: THREE.Mesh;
  /** 合成 quad 的世界尺寸（= |对象 size/dist × scale|，未钳制幅值），resize 重建几何时用。 */
  worldW: number;
  worldH: number;
}

// 效果链编排器注入点（结构化接口，player 不 import object-effects.ts）。
export interface ObjectEffectStage {
  bindOutputs(): void;
  advance(time: number): void;
}
```

**(c) 类字段**（加在 `private nextParticleLayerId = 0;` 之后）：

```ts
  // 对象隔离条目（对象级效果链；空 Map = 本壁纸无带效果对象，帧序退化为原路径）。
  private isolated = new Map<number, IsolatedObject>();
  private objectEffectStage: ObjectEffectStage | null = null;
  // g_Time 时间原点（构造时刻），advance 传「自 player 创建起的秒数」。
  private readonly startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
```

**(d) 抽出材质构造**，供原路径与合成 quad 共用。把 `addBackground` 中现有 `let material: THREE.Material; if (cb) {...} else {...}` 整段（`:525-556`）替换为一次调用，并新增私有方法：

```ts
  // 图层材质：colorBlendMode 已实现（6/7/31）→ 预乘 ShaderMaterial + CustomBlending（复刻
  // WE 的 ApplyBlending）；否则 MeshBasicMaterial（普通 alpha 混合）。原路径与隔离对象的
  // **合成 quad** 共用本方法——隔离时混合发生在「贴回画面」这一步，语义与今天同源。
  private createLayerMaterial(
    texture: THREE.Texture | null,
    colorBlendMode: number,
    mod: { r: number; g: number; b: number; a: number },
  ): THREE.Material {
    const cb = colorBlendModeToThree(colorBlendMode);
    if (cb) {
      return new THREE.ShaderMaterial({
        uniforms: {
          map: { value: texture ?? createWhiteTexture() },
          tint: { value: new THREE.Vector3(mod.r, mod.g, mod.b) },
          opacity: { value: mod.a },
        },
        vertexShader: COLOR_BLEND_VERTEX_SHADER,
        fragmentShader: COLOR_BLEND_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.CustomBlending,
        blendEquation: cb.blendEquation,
        blendSrc: cb.blendSrc,
        blendDst: cb.blendDst,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
      });
    }
    const basic = new THREE.MeshBasicMaterial({
      map: texture ?? null,
      transparent: true,
      depthWrite: false,
    });
    basic.color.setRGB(mod.r, mod.g, mod.b);
    basic.opacity = mod.a;
    return basic;
  }
```

`addBackground` 中该段改为 `const material = this.createLayerMaterial(opts.texture ?? null, opts.colorBlendMode ?? 0, mod);`

**(e) `addBackground` 的 opts 增加字段并在 `this.scene.add(mesh)` 处分支**：

opts 类型加：`isolate?: { width: number; height: number };`

把 `mesh.position.set(...); this.scene.add(mesh);` 替换为：

```ts
    // we_to_three：origin - scene/2（y 不翻）。
    mesh.position.set(opts.origin[0] - sceneW / 2, opts.origin[1] - sceneH / 2, opts.origin[2]);
    // 对象世界尺寸（未钳制幅值）：隔离路径下用于合成 quad 的几何尺寸（缩放已并入几何，
    // quad 自身 scale 恒为 1）；非隔离路径下仅用于记录，行为不变。
    const worldW = Math.abs(w * s[0]);
    const worldH = Math.abs(h * s[1]);

    if (opts.isolate) {
      // 隔离：内容只保留 scale（含镜像），位移/旋转交给合成 quad。
      mesh.position.set(0, 0, 0);
      mesh.rotation.set(0, 0, 0);
      this.attachIsolated(id, 'background', mesh, worldW, worldH, opts.isolate, {
        x: opts.origin[0] - sceneW / 2,
        y: opts.origin[1] - sceneH / 2,
        z: opts.origin[2],
      }, [a[0], a[1], a[2]], material, mod);
    } else {
      this.scene.add(mesh);
    }
```

⚠️ `id` 目前在 `addBackground` 里是 `this.scene.add(mesh)` 之后才分配（`const id = this.nextBackgroundId++`）。实施时把 id 分配**上移到 mesh 创建之后、分支之前**，并把 `this.backgroundEntries.set(id, {...})` 保持在其后。`backgroundEntries` 记录的是对象**原始** origin/scale/angles（与今天一致），使 `update_background` 语义不变。

**(f) 新增私有方法 `attachIsolated`**（背景/粒子共用）：

```ts
  // 建立对象隔离条目：RT + 局部正交相机 + localScene + 主场景合成 quad。
  // localCamera 范围 = RT 分辨率（对象中心为原点，与场景像素 1:1）；合成 quad 用
  // createCompositeGeometry（世界尺寸含缩放、UV 按钳制窗口映射），position/rotation 承载
  // 对象在世界中的位置与朝向。
  private attachIsolated(
    id: number,
    kind: 'background' | 'particle',
    content: THREE.Object3D,
    worldW: number,
    worldH: number,
    size: { width: number; height: number },
    position: { x: number; y: number; z: number },
    angles: [number, number, number],
    material: THREE.Material,
    _mod: { r: number; g: number; b: number; a: number },
  ): void {
    const rtW = Math.max(1, Math.round(size.width));
    const rtH = Math.max(1, Math.round(size.height));
    const rt = new THREE.WebGLRenderTarget(rtW, rtH);
    const localCamera = new THREE.OrthographicCamera(-rtW / 2, rtW / 2, rtH / 2, -rtH / 2, -1000, 1000);
    localCamera.position.z = CAMERA_DISTANCE;
    const localScene = new THREE.Scene();
    localScene.add(content);
    // 合成 quad 的材质：与内容材质同构（同样承接 colorBlendMode / alpha / brightness），
    // 但 map 指向对象 RT 纹理（效果链就绪后由 setObjectOutput 换成效果输出）。
    const quadMaterial = material.clone();
    if (quadMaterial instanceof THREE.ShaderMaterial) {
      quadMaterial.uniforms.map.value = rt.texture;
    } else if (quadMaterial instanceof THREE.MeshBasicMaterial) {
      quadMaterial.map = rt.texture;
    }
    const quad = new THREE.Mesh(createCompositeGeometry(worldW, worldH, rtW, rtH), quadMaterial);
    quad.position.set(position.x, position.y, position.z);
    quad.rotation.set(angles[0], angles[1], angles[2]);
    // renderOrder 与对象原语义一致（背景 0 / 粒子 1），保证合成顺序不变。
    quad.renderOrder = kind === 'particle' ? 1 : 0;
    this.scene.add(quad);
    this.isolated.set(id, {
      id, kind, rt, rtWidth: rtW, rtHeight: rtH, rtTexture: rt.texture,
      localScene, localCamera, quad, worldW, worldH,
    });
  }
```

**(g) `addParticle` 的 `isolate`**：opts 类型加 `isolate?: { width: number; height: number };`。在 `const mesh = new THREE.Mesh(geometry, material);` 之后、`this.scene.add(mesh)`（`:765`）处分支：

```ts
    if (opts.isolate) {
      // 粒子隔离：世界位移由合成 quad 承载，故对象中心/角度在局部场景里归零
      // （粒子顶点 shader 的 worldPos = objCenter + R·(scale·(emitterOrigin+local))，
      //  见 PARTICLE_VERTEX_SHADER；objCenter=0 + angles=0 ⇒ 局部坐标即局部场景坐标）。
      const m = mesh.material as THREE.ShaderMaterial;
      (m.uniforms.objectCenter.value as THREE.Vector3).set(0, 0, 0);
      (m.uniforms.objectAngles.value as THREE.Vector3).set(0, 0, 0);
    }
```

并在 `layer` 记录之后（`return id;` 之前）调用：

```ts
    if (opts.isolate) {
      const center = opts.objectCenter ?? [0, 0, 0];
      const s3 = opts.objectScale ?? [1, 1, 1];
      const an = opts.objectAngles ?? [0, 0, 0];
      // 粒子世界尺寸由调用方（three-renderer）按 particleWorldSize 算好，这里只按内容估算兜底：
      // 以局部相机范围为准（对象 RT 尺寸即其可见范围），合成 quad 世界尺寸 = RT 分辨率 / dpr
      // —— 精确的世界尺寸由 setObjectOutput 前的 resizeObjectRT 与几何重建保证，见 three-renderer。
      this.attachIsolated(id, 'particle', mesh, opts.isolate.width, opts.isolate.height, opts.isolate,
        { x: center[0], y: center[1], z: center[2] }, [an[0], an[1], an[2]], material,
        { r: 1, g: 1, b: 1, a: 1 });
    } else {
      this.scene.add(mesh);
    }
```

⚠️ 实施要点：`addParticle` 里对 mesh 材质的 `objectCenter` / `objectAngles` uniform 赋值必须在 uniform 已创建之后（`ShaderMaterial` 构造时即创建，见 `:737-741`），且 `attachIsolated` 收到的是**同一份** material 实例（clone 发生在 attachIsolated 内部）。

**(h) 新增访问器与帧钩子**（加在 `render()` 之后）：

```ts
  // 对象级效果链的编排器注入点（null = 本壁纸无效果链，帧序退化为原路径）。
  setObjectEffectStage(stage: ObjectEffectStage | null): void {
    this.objectEffectStage = stage;
  }

  // 隔离对象条目（只读视图，供编排器拿 RT 纹理与尺寸）。
  isolatedObjects(): IsolatedObject[] {
    return [...this.isolated.values()];
  }

  // 把某个隔离对象的合成 quad 切到给定的采样纹理（效果链输出；编排器在链未就绪时
  // 不调用本方法，quad 保持采样对象 RT 原图 → 对象正常显示、无效果，不黑屏）。
  setObjectOutput(id: number, texture: THREE.Texture): void {
    const entry = this.isolated.get(id);
    if (!entry) return;
    const mat = entry.quad.material;
    if (mat instanceof THREE.ShaderMaterial) mat.uniforms.map.value = texture;
    else if (mat instanceof THREE.MeshBasicMaterial) mat.map = texture;
  }

  // 重设隔离对象的 RT 尺寸（视口/dpr 变化时由编排器调用）：同步局部相机视锥与合成几何的
  // UV 窗口（几何尺寸不变，只重算窗口映射）。
  resizeObjectRT(id: number, width: number, height: number): void {
    const entry = this.isolated.get(id);
    if (!entry) return;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (entry.rt.width === w && entry.rt.height === h) return;
    entry.rt.setSize(w, h);
    entry.localCamera.left = -w / 2;
    entry.localCamera.right = w / 2;
    entry.localCamera.top = h / 2;
    entry.localCamera.bottom = -h / 2;
    entry.localCamera.updateProjectionMatrix();
    entry.quad.geometry.dispose();
    entry.quad.geometry = createCompositeGeometry(entry.worldW, entry.worldH, w, h);
  }

  // 渲染所有隔离对象的内容到各自 RT（player 拥有 scene/camera，故渲染留在 player）。
  private renderIsolatedContents(): void {
    for (const entry of this.isolated.values()) {
      this.renderer.setRenderTarget(entry.rt);
      this.renderer.render(entry.localScene, entry.localCamera);
    }
    this.renderer.setRenderTarget(null);
  }

  // 隔离对象的帧推进时间（秒，自 player 创建起）——g_Time 语义。
  elapsedSeconds(): number {
    const now = typeof performance !== 'undefined' ? performance.now() : this.startedAt;
    return (now - this.startedAt) / 1000;
  }
```

**(i) 改帧体 `setAnimationLoop`**（`:469-483` 内），在 `this.update(dt);` 与 `this.renderer.render(...)` 之间插入两行，并在 render 之后追加 advance：

```ts
        fn?.(dt);
        this.update(dt);
        // 对象级效果链：先渲染隔离内容到各自 RT，再让编排器把合成 quad 绑到效果输出。
        if (this.isolated.size > 0) this.renderIsolatedContents();
        this.objectEffectStage?.bindOutputs();
        this.renderer.render(this.scene, this.camera);
        // 链推进是异步串行的（纹理槽可能仍在加载），不阻塞本帧；本帧贴的是上一帧输出。
        this.objectEffectStage?.advance(this.elapsedSeconds());
```

**(j) 改 `render()`**（`:487-489`）为同一序列（不带 dt）：

```ts
  render(): void {
    if (this.isolated.size > 0) this.renderIsolatedContents();
    this.objectEffectStage?.bindOutputs();
    this.renderer.render(this.scene, this.camera);
    this.objectEffectStage?.advance(this.elapsedSeconds());
  }
```

**(k) 改 `dispose()`**：在粒子图层释放之后、`this.renderer.dispose()` 之前插入：

```ts
    // 隔离对象：RT / 合成 quad / 局部场景内容一并释放（避免切壁纸后 VRAM 泄漏）。
    for (const entry of this.isolated.values()) {
      entry.rt.dispose();
      entry.quad.geometry.dispose();
      (entry.quad.material as THREE.Material).dispose();
      entry.localScene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    }
    this.isolated.clear();
    this.objectEffectStage = null;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/threejs-player.test.ts --reporter=basic`
Expected: 新增 8 项 PASS；**既有测试全部维持原结果**（这是零回归的硬证据——尤其「resize 把渲染缓冲 = 视口×dpr 钉死」「cover 相机范围」等）。

- [ ] **Step 5: 类型检查 + 提交**

Run: `npm run build`
Expected: 无错误。

```bash
git add src/client/threejs-player.ts tests/threejs-player.test.ts
git commit -m "feat(player): 对象隔离渲染能力与效果链帧钩子

改法：addBackground / addParticle 支持 isolate（内容进 localScene、对象中心即局部原点、
局部内容只保留 scale 而 position/rotation 归零），主场景放一张合成 quad 承载对象的世界
位置与朝向并采样对象 RT；新增 isolatedObjects/setObjectOutput/resizeObjectRT/
setObjectEffectStage 与 renderIsolatedContents，帧序变为
「隔离内容 → bindOutputs → 主场景 → advance」。材质构造抽出 createLayerMaterial，
原路径与合成 quad 共用（colorBlendMode 6/7/31 的 CustomBlending 因此落在贴回画面这一步）。

零回归：不传 isolate 且无 stage 时逐帧调用序列与改动前逐字相同（既有测试原样通过）。

验证：tests/threejs-player.test.ts 新增 8 项——隔离结构、粒子 uObjectCenter 归零、
setObjectOutput 双材质路径、帧序、零回归、resizeObjectRT、dispose 释放。"
```

---

### Task 4: `ObjectEffectStage` 编排实现

**Files:**
- Modify: `src/client/object-effects.ts`（在 Task 2 的纯函数之后追加编排类）
- Test: `tests/object-effects.test.ts`（追加编排测试）

**Interfaces:**
- Consumes: `EffectRunner`（`effect-runner.js`，**不改**）、`pickWriteTarget` 等既有导出、Task 2 的 `isLinearEffectChain` / `resolveObjectRtSize`、Task 3 的 player 能力（结构化）
- Produces:
  - `interface IsolatedHostView { id: number; rtWidth: number; rtHeight: number; rtTexture: THREE.Texture }`
  - `interface ObjectEffectHost { isolatedObjects(): IsolatedHostView[]; setObjectOutput(id: number, texture: THREE.Texture): void; resizeObjectRT(id: number, width: number, height: number): void; renderer: THREE.WebGLRenderer }`
  - `class ObjectEffectStage implements ObjectEffectStage`（同名接口，见 Task 2）
  - `constructor(host: ObjectEffectHost, opts: { wavelengthId: string; dpr: number; budgetWidth: number; budgetHeight: number })`
  - `setObjectChains(objId: number, chains: CompiledEffectPass[][]): void`
  - `onViewportResize(budgetWidth: number, budgetHeight: number): void`
  - `dispose(): void`
  - `rtGraphSkips(): string[]`（被跳过的链标识，供测试与诊断）

- [ ] **Step 1: 写失败测试**

在 `tests/object-effects.test.ts` 追加（node 环境，mock runner 与 host）：

```ts
import { ObjectEffectStage, resolveObjectRtSize as _resolve } from '../src/client/object-effects.js';
import * as THREE from 'three';
import { vi } from 'vitest';

// mock runner：不触碰 WebGL，只记录调用顺序与入参。
function createMockRunner() {
  const calls: Array<{ time: number; input: unknown }> = [];
  let last: THREE.Texture | null = null;
  const runner = {
    setChains: vi.fn(),
    setAudioSpectrumSource: vi.fn(),
    update: vi.fn(async (time: number, input: unknown) => {
      calls.push({ time, input });
      last = (input as THREE.WebGLRenderTarget).texture;
      return last;
    }),
    lastOutput: vi.fn(() => last),
    dispose: vi.fn(),
    _calls: calls,
  };
  return runner;
}

function createHost(entries: Array<{ id: number; rtWidth: number; rtHeight: number }>) {
  const outputs = new Map<number, THREE.Texture>();
  const resized: Array<{ id: number; w: number; h: number }> = [];
  const host = {
    renderer: {} as THREE.WebGLRenderer,
    isolatedObjects: () => entries.map((e) => ({
      id: e.id, rtWidth: e.rtWidth, rtHeight: e.rtHeight,
      rtTexture: new THREE.Texture(),
    })),
    setObjectOutput: (id: number, tex: THREE.Texture) => { outputs.set(id, tex); },
    resizeObjectRT: (id: number, w: number, h: number) => { resized.push({ id, w, h }); },
    _outputs: outputs,
    _resized: resized,
  };
  return host;
}

describe('ObjectEffectStage', () => {
  it('setObjectChains 为线性链创建 runner，并把对象 chains 展平后交给它', () => {
    const host = createHost([{ id: 1, rtWidth: 100, rtHeight: 50 }]);
    const stage = new ObjectEffectStage(host as never, {
      wavelengthId: 'w', dpr: 1, budgetWidth: 1920, budgetHeight: 1080,
    });
    const chains = [[pass()], [pass()]];
    stage.setObjectChains(1, chains);
    const runners = stage.debugRunners();
    expect(runners.size).toBe(1);
    const runner = runners.get(1)!;
    expect(runner.setChains).toHaveBeenCalledTimes(1);
    const [passedChains, id, opts] = runner.setChains.mock.calls[0];
    expect(passedChains).toEqual(chains);
    expect(id).toBe('w');
    expect(opts).toEqual({ width: 100, height: 50 });
  });

  it('RT 图链整条跳过并只告警一次（按 effect 标识去重）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const host = createHost([{ id: 1, rtWidth: 100, rtHeight: 50 }]);
    const stage = new ObjectEffectStage(host as never, {
      wavelengthId: 'w', dpr: 1, budgetWidth: 1920, budgetHeight: 1080,
    });
    stage.setObjectChains(1, [[pass({ target: '_rt_a' })]]);
    stage.setObjectChains(1, [[pass({ target: '_rt_a' })]]);
    expect(stage.rtGraphSkips()).toEqual(['_rt_a']);
    const rtGraphWarns = warn.mock.calls.filter((c) => String(c[0]).includes('具名 RT'));
    expect(rtGraphWarns).toHaveLength(1);
    expect(stage.debugRunners().has(1)).toBe(false);
    warn.mockRestore();
  });

  it('纯 RT 图链的对象不建 runner，bindOutputs 不调用 setObjectOutput（quad 保持对象 RT 原图）', () => {
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }]);
    const stage = new ObjectEffectStage(host as never, {
      wavelengthId: 'w', dpr: 1, budgetWidth: 1920, budgetHeight: 1080,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stage.setObjectChains(1, [[pass({ bind: [{ name: 'previous', index: 0 }] })]]);
    stage.bindOutputs();
    expect(host._outputs.size).toBe(0);
    warn.mockRestore();
  });

  it('bindOutputs：链未就绪（lastOutput 为 null）→ 不切输出；就绪 → 切到效果输出', () => {
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }]);
    const stage = new ObjectEffectStage(host as never, {
      wavelengthId: 'w', dpr: 1, budgetWidth: 1920, budgetHeight: 1080,
    });
    // 手工注入一个可控 runner
    const runner = createMockRunner();
    stage.debugInjectRunner(1, runner as never);
    stage.bindOutputs();
    expect(host._outputs.size).toBe(0); // lastOutput 为 null
    runner.lastOutput.mockReturnValue(new THREE.Texture());
    stage.bindOutputs();
    expect(host._outputs.size).toBe(1);
  });

  it('advance 串行：同一 runner 的第二次 update 在第一次完成后才发起', async () => {
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }]);
    const stage = new ObjectEffectStage(host as never, {
      wavelengthId: 'w', dpr: 1, budgetWidth: 1920, budgetHeight: 1080,
    });
    let resolveFirst: (() => void) | null = null;
    const order: string[] = [];
    const runner = {
      setChains: vi.fn(), setAudioSpectrumSource: vi.fn(), dispose: vi.fn(),
      lastOutput: () => null,
      update: vi.fn(() => {
        order.push('start');
        if (!resolveFirst) {
          return new Promise<void>((res) => { resolveFirst = () => { order.push('end'); res(); }; });
        }
        return Promise.resolve();
      }),
    };
    stage.debugInjectRunner(1, runner as never);
    stage.advance(1);
    stage.advance(2);
    expect(order).toEqual(['start']); // 第二次未发起（串行）
    resolveFirst!();
    await Promise.resolve();
    await Promise.resolve();
    stage.advance(3);
    expect(order).toEqual(['start', 'end', 'start']);
  });

  it('onViewportResize 按新预算等比重设 RT 尺寸', () => {
    const host = createHost([{ id: 1, rtWidth: 100, rtHeight: 50 }]);
    const stage = new ObjectEffectStage(host as never, {
      wavelengthId: 'w', dpr: 2, budgetWidth: 1920, budgetHeight: 1080,
    });
    // 世界尺寸 = RT 像素 / dpr = 50×25；新预算 400×400 @dpr2 → 100×50 不超预算 → 不变
    stage.onViewportResize(400, 400);
    expect(host._resized).toEqual([]);
    // 新预算 20×20 @dpr2 → cap 20 → 等比 s = min(20/100, 20/50) = 0.2 → 20×10
    stage.onViewportResize(20, 20);
    expect(host._resized).toEqual([{ id: 1, w: 20, h: 10 }]);
  });

  it('dispose 释放全部 runner', () => {
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }]);
    const stage = new ObjectEffectStage(host as never, {
      wavelengthId: 'w', dpr: 1, budgetWidth: 1920, budgetHeight: 1080,
    });
    const runner = createMockRunner();
    stage.debugInjectRunner(1, runner as never);
    stage.dispose();
    expect(runner.dispose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/object-effects.test.ts --reporter=basic`
Expected: FAIL —— `ObjectEffectStage is not a constructor`。

- [ ] **Step 3: 实现编排**

在 `src/client/object-effects.ts` 末尾追加：

```ts
import { EffectRunner } from './effect-runner.js';

// 编排器看到的隔离对象视图（player 的 isolatedObjects() 结构性满足它）。
export interface IsolatedHostView {
  id: number;
  rtWidth: number;
  rtHeight: number;
  rtTexture: THREE.Texture;
}

// player 的最小宿主接口（player 不需要 import 本模块）。
export interface ObjectEffectHost {
  renderer: THREE.WebGLRenderer;
  isolatedObjects(): IsolatedHostView[];
  setObjectOutput(id: number, texture: THREE.Texture): void;
  resizeObjectRT(id: number, width: number, height: number): void;
}

// 单个隔离对象的链状态。
interface ObjectChainEntry {
  runner: EffectRunner | null;
  /** 原始链定义：resize 时用同一份链 + 新尺寸重新 setChains（EffectRunner 只在尺寸变化时重建 RT）。 */
  chains: CompiledEffectPass[][];
  /** 世界尺寸（场景像素，未乘 dpr）——resize 时用它按新预算重算 RT 像素尺寸。 */
  worldW: number;
  worldH: number;
}

export class ObjectEffectStage implements ObjectEffectStageLike {
  private entries = new Map<number, ObjectChainEntry>();
  private skips = new Set<string>();
  /** 串行链：同一时刻只允许一个 runner 触碰 renderer 的 RT/绑定状态。 */
  private chain: Promise<void> = Promise.resolve();
  private pendingChains = new PendingChainStore<CompiledEffectPass[][]>();
  private readonly wallpaperId: string;
  private readonly dpr: number;
  private budgetWidth: number;
  private budgetHeight: number;
  private disposed = false;

  constructor(
    private readonly host: ObjectEffectHost,
    opts: { wavelengthId: string; dpr: number; budgetWidth: number; budgetHeight: number },
  ) {
    this.wallpaperId = opts.wavelengthId;
    this.dpr = opts.dpr > 0 ? opts.dpr : 1;
    this.budgetWidth = opts.budgetWidth;
    this.budgetHeight = opts.budgetHeight;
  }

  /** 世界尺寸（场景像素）：resize 时按新预算重算 RT 像素尺寸的唯一来源。
   *  调用顺序契约：three-renderer 先 setWorldSize 再 setObjectChains（后者不覆盖前者）。 */
  setWorldSize(objId: number, worldW: number, worldH: number): void {
    if (this.disposed) return;
    const entry = this.entries.get(objId);
    if (entry) {
      entry.worldW = worldW;
      entry.worldH = worldH;
      return;
    }
    this.entries.set(objId, { runner: null, chains: [], worldW, worldH });
  }

  /** 挂载某对象的效果链（对象条目可能尚未出现 → 暂存，见 PendingChainStore）。 */
  setObjectChains(objId: number, chains: CompiledEffectPass[][]): void {
    if (this.disposed) return;
    // 逐条链分类：保留线性链，跳过具名 RT 图链（整链，不硬跑）。
    const usable: CompiledEffectPass[][] = [];
    for (const one of chains) {
      if (isLinearEffectChain(one)) {
        usable.push(one);
      } else {
        const label = one.find((p) => p.target)?.target ?? one.find((p) => p.bind.length > 0)?.bind[0]?.name ?? '(具名 RT)';
        this.warnSkip(label);
      }
    }
    if (usable.length === 0) {
      this.pendingChains.applyIfReady(objId, [], false);
      return;
    }
    const view = this.host.isolatedObjects().find((o) => o.id === objId);
    if (!view) {
      this.pendingChains.applyIfReady(objId, usable, false);
      return;
    }
    this.mount(objId, usable, view.rtWidth, view.rtHeight);
  }

  /** 视口/预算变化：按新预算重算每个对象的 RT 像素尺寸，并用同一份链重挂（runner 内部 RT 跟随）。 */
  onViewportResize(budgetWidth: number, budgetHeight: number): void {
    this.budgetWidth = budgetWidth;
    this.budgetHeight = budgetHeight;
    for (const [id, entry] of this.entries) {
      if (!entry.runner) continue;
      const size = resolveObjectRtSize(entry.worldW, entry.worldH, this.dpr, budgetWidth, budgetHeight);
      const view = this.host.isolatedObjects().find((o) => o.id === id);
      if (!view || (view.rtWidth === size.width && view.rtHeight === size.height)) continue;
      this.host.resizeObjectRT(id, size.width, size.height);
      entry.runner.setChains(entry.chains, this.wallpaperId, { width: size.width, height: size.height });
    }
  }

  bindOutputs(): void {
    for (const view of this.host.isolatedObjects()) {
      const entry = this.entries.get(view.id);
      const out = entry?.runner?.lastOutput() ?? null;
      if (out) this.host.setObjectOutput(view.id, out);
    }
  }

  advance(time: number): void {
    if (this.disposed) return;
    for (const view of this.host.isolatedObjects()) {
      const entry = this.entries.get(view.id);
      const runner = entry?.runner;
      if (!runner) continue;
      runner.setAudioSpectrumSource(null); // three 主路径无音频源（spec §5.4），保持全零
      this.chain = this.chain
        .then(() => runner.update(time, view.rtTexture))
        .catch((e) => console.warn('[wallpaper-engine] 对象效果链更新失败:', e));
    }
  }

  rtGraphSkips(): string[] {
    return [...this.skips];
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) entry.runner?.dispose();
    this.entries.clear();
    this.pendingChains.clear();
  }

  // ── 测试/诊断钩子（不参与生产路径） ──
  debugRunners(): Map<number, EffectRunner> {
    const out = new Map<number, EffectRunner>();
    for (const [id, e] of this.entries) if (e.runner) out.set(id, e.runner);
    return out;
  }
  debugInjectRunner(id: number, runner: EffectRunner): void {
    const view = this.host.isolatedObjects().find((o) => o.id === id);
    this.entries.set(id, {
      runner,
      worldW: view ? view.rtWidth / this.dpr : 1,
      worldH: view ? view.rtHeight / this.dpr : 1,
    });
  }

  private warnSkip(label: string): void {
    if (this.skips.has(label)) return;
    this.skips.add(label);
    console.warn(
      `[wallpaper-engine] 效果需要具名 RT（P2 未实现），跳过: ${label}`,
    );
  }

  private mount(objId: number, chains: CompiledEffectPass[][], rtW: number, rtH: number): void {
    let entry = this.entries.get(objId);
    if (!entry) {
      entry = { runner: null, chains, worldW: rtW / this.dpr, worldH: rtH / this.dpr };
      this.entries.set(objId, entry);
    }
    // setWorldSize 可能已先建条目（three-renderer 的顺序是 setWorldSize → setObjectChains），
    // 此时保留其世界尺寸，不被 RT 尺寸/dpr 反推覆盖。
    entry.chains = chains;
    if (!entry.runner) {
      entry.runner = new EffectRunner(this.host.renderer, rtW, rtH);
    }
    entry.runner.setChains(chains, this.wallpaperId, { width: rtW, height: rtH });
  }
}
```

收尾清理：
- 删除 Task 2 留下的占位 `export type EffectTexture = THREE.Texture;`（它只是为避免未使用类型 import 而留）；
- 文件顶部**保持 `import type * as THREE from 'three';`**——本模块只用 THREE 作为类型（`WebGLRenderer` / `Texture` / `WebGLRenderTarget`）；若 `tsc` 报错则以报错为准；
- `debugInjectRunner` 注入的 entry 三个字段都要填（含 `chains: []`），否则 `onViewportResize` 读到 `undefined`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/object-effects.test.ts --reporter=basic`
Expected: 全绿（Task 2 的 13 项 + 全库回归 + 本任务 7 项）。

- [ ] **Step 5: 提交**

```bash
git add src/client/object-effects.ts tests/object-effects.test.ts
git commit -m "feat(effects): ObjectEffectStage 编排（每对象一个 runner + 串行推进 + 降级）

改法：新增 ObjectEffectStage——按对象挂链（PendingChainStore 处理链先于条目的竞态）、
每对象一个 EffectRunner（RT 尺寸 = 对象 RT 尺寸）、advance 用 promise 链串行推进
（并发交错会抢 renderer 的 RT 绑定 → 黑屏/闪烁）、bindOutputs 在链未就绪时不动输出
（quad 保持对象 RT 原图，不黑屏）、onViewportResize 按新预算等比重设 RT。

降级：具名 RT 图链整条跳过并按标识去重告警（rtGraphSkips 可查），绝不用线性执行器硬跑
（产物是错画面）。

验证：tests/object-effects.test.ts 新增 7 项编排断言（挂链/降级去重/未就绪回退/串行/
resize/dispose），含一个「第二次 advance 在第一次完成前不发起」的串行性断言。"
```

---

### Task 5: `three-renderer.ts` 装配 effects

**Files:**
- Modify: `src/client/three-renderer.ts`
- Test: `tests/three-renderer.test.ts`（追加：装配决策的纯函数部分）

**Interfaces:**
- Consumes: Task 2 `isLinearEffectChain` / `resolveObjectRtSize` / `ObjectEffectStage`；Task 3 player 的 `isolate` / `setObjectEffectStage`；既有 `resolveEffectChain`、`objectCameraRange`、`particleObjectRange`、`particleWorldSize`
- Produces:
  - `type SceneAssets` 增加 `isolate?: Map<number, { width: number; height: number }>`
  - `three-renderer.ts` 内部：`collectObjectEffectChains(id, desc, loadFile)`（导出供测试）

- [ ] **Step 1: 写失败测试**

在 `tests/three-renderer.test.ts` 追加：

```ts
import { collectObjectEffectChains } from '../src/client/three-renderer.js';

describe('collectObjectEffectChains（effects 解析与分类）', () => {
  it('按对象收集 effects 并解析为链；无效对象（无 effects / text）被跳过', async () => {
    const desc = {
      camera: { center: [0, 0, 0], eye: [0, 0, 0], up: [0, 1, 0] },
      orthogonal: { width: 100, height: 100 },
      objects: [
        { kind: 'image', id: 1, name: 'a', origin: [0, 0, 0], scale: [1, 1, 1], image: 'x', effects: [{ file: 'effects/w/effect.json' }] },
        { kind: 'image', id: 2, name: 'b', origin: [0, 0, 0], scale: [1, 1, 1], image: 'y' },
      ],
    } as never;
    const files = new Map<string, Uint8Array>();
    files.set('effects/w/effect.json', new TextEncoder().encode(JSON.stringify({
      passes: [{ material: 'materials/effects/w.json' }],
    })));
    files.set('materials/effects/w.json', new TextEncoder().encode(JSON.stringify({
      passes: [{ shader: 'effects/w', blending: 'normal' }],
    })));
    files.set('shaders/effects/w.vert', new TextEncoder().encode('void main(){ gl_Position = vec4(position, 1.0); }'));
    files.set('shaders/effects/w.frag', new TextEncoder().encode('void main(){ gl_FragColor = texture2D(g_Texture0, uv); }'));
    const out = await collectObjectEffectChains(desc, async (n) => files.get(n) ?? null);
    expect(out.size).toBe(1);
    expect(out.get(1)![0].length).toBe(1);
    expect(out.has(2)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/three-renderer.test.ts --reporter=basic`
Expected: FAIL —— `collectObjectEffectChains is not a function`。

- [ ] **Step 3: 实现**

在 `src/client/three-renderer.ts` 中：

**(a) 增加 import**：

```ts
import {
  groupEffectsByObject, objectCameraRange, particleObjectRange, particleWorldSize,
} from './object-range.js';
import { ObjectEffectStage, resolveObjectRtSize } from './object-effects.js';
import { resolveEffectChain, type CompiledEffectPass } from './shader/effect-chain.js';
```

**(b) 导出解析函数**：

```ts
// 收集并解析「带效果对象」的链（spec §2.3：按 scene.json objects 顺序，每对象保留自身
// effects，不展平）。text 对象不在范围（SceneTextObject 无 effects 字段）；解析失败的链
// 过滤掉并 warn（该对象回退无效果显示，不黑屏）。
export async function collectObjectEffectChains(
  desc: SceneDescription,
  loadFile: (name: string) => Promise<Uint8Array | null>,
): Promise<Map<number, CompiledEffectPass[][]>> {
  const out = new Map<number, CompiledEffectPass[][]>();
  for (const group of groupEffectsByObject(desc.objects)) {
    const chains: CompiledEffectPass[][] = [];
    for (const fx of group.effects as Array<{ file?: string; passes?: unknown[] }>) {
      if (typeof fx?.file !== 'string') continue;
      const chain = await resolveEffectChain({ file: fx.file, passes: fx.passes }, loadFile);
      if (!chain) {
        console.warn('[wallpaper-engine] 效果链解析失败，跳过:', fx.file);
        continue;
      }
      chains.push(chain);
    }
    if (chains.length > 0) out.set(group.obj.id, chains);
  }
  return out;
}
```

**(c) 在 `render()` 内解析 + 计算 isolate 尺寸**。在对象循环（`:133-161`）之前插入：

```ts
        // ── 对象级效果链：解析 + 隔离尺寸预算（spec §5.2）────────────────────────────
        const loadFile = async (name: string): Promise<Uint8Array | null> => {
          const r = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(name)}`);
          if (!r.ok) return null;
          return new Uint8Array(await r.arrayBuffer());
        };
        const effectChains = await collectObjectEffectChains(desc, loadFile);
        const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
        const budgetW = Math.floor(vw * dpr);
        const budgetH = Math.floor(vh * dpr);
        const isolate = new Map<number, { width: number; height: number }>();
        const worldSizes = new Map<number, { w: number; h: number }>();
        for (const obj of desc.objects) {
          if (!effectChains.has(obj.id)) continue;
          if (obj.kind === 'image') {
            const tex = backgroundTextures.get(obj.id);
            const texW = (tex?.image?.width as number | undefined) ?? obj.size?.[0] ?? 1;
            const texH = (tex?.image?.height as number | undefined) ?? obj.size?.[1] ?? 1;
            const world = { w: Math.abs((obj.size?.[0] ?? texW) * obj.scale[0]), h: Math.abs((obj.size?.[1] ?? texH) * obj.scale[1]) };
            const range = objectCameraRange([obj.size?.[0] ?? texW, obj.size?.[1] ?? texH], [obj.scale[0], obj.scale[1]]);
            worldSizes.set(obj.id, world);
            isolate.set(obj.id, resolveObjectRtSize(range.w, range.h, 1, budgetW, budgetH));
          } else if (obj.kind === 'particle') {
            const p = particles.get(obj.id);
            if (!p) continue;
            let spec: { distanceMax?: number } = {};
            try { spec = JSON.parse(p.specJson) as { distanceMax?: number }; } catch { /* 缺省 distanceMax */ }
            const world = particleWorldSize(spec, [obj.scale[0], obj.scale[1]]);
            const range = particleObjectRange(spec, [obj.scale[0], obj.scale[1]]);
            worldSizes.set(obj.id, world);
            isolate.set(obj.id, resolveObjectRtSize(range.w, range.h, 1, budgetW, budgetH));
          }
        }
        // ⚠️ 该段必须放在下面的「组装 SceneAssets」循环**之后**（依赖 backgroundTextures/particles），
        //    实施时把它整体置于对象循环结束、loadSceneToThree 调用之前。
```

⚠️ 实施顺序要点：`backgroundTextures` / `particles` 的填充循环（`:133-161`）必须**先**执行；上面的解析段放在其后。`resolveObjectRtSize` 的第三参传 `1`（`range` 已是场景像素、且 `objectCameraRange` 已按 4096 钳制），最终像素尺寸 = 预算收口后的值；dpr 通过 `budgetW/budgetH` 参与（预算 = 视口 × dpr），因此 RT 与贴屏分辨率一致。

**(d) 把 `isolate` 传给 `loadSceneToThree`**：`SceneAssets` 加字段并在 `loadSceneToThree` 的对象循环里使用。

`threejs-player.ts` 的 `SceneAssets` 类型加：`isolate?: Map<number, { width: number; height: number }>;`，并在 `addBackground` / `addParticle` 调用处传 `isolate: assets.isolate?.get(obj.id)`。

**(e) 装配 stage**。`loadSceneToThree` 返回后：

```ts
        let stage: ObjectEffectStage | null = null;
        if (effectChains.size > 0) {
          stage = new ObjectEffectStage(result.player, {
            wavelengthId: id, dpr, budgetWidth: budgetW, budgetHeight: budgetH,
          });
          // 顺序契约：先 setWorldSize（尺寸唯一来源），再 setObjectChains（不覆盖世界尺寸）。
          for (const [objId, size] of worldSizes) stage.setWorldSize(objId, size.w, size.h);
          for (const [objId, chains] of effectChains) stage.setObjectChains(objId, chains);
          result.player.setObjectEffectStage(stage);
          currentStage = stage;
        }
```

`setWorldSize` 已在 Task 4 的 `ObjectEffectStage` 类中实现（无需在此新增）；`currentStage` 是模块闭包变量，声明方式见 (g)。

**(f) window.resize 时同步预算**：在 `onWindowResize` 里追加：

```ts
          stage?.onViewportResize(Math.floor(width * dpr), Math.floor(height * dpr));
```

**(g) teardown 释放**：

```ts
  let currentStage: ObjectEffectStage | null = null;   // 模块内闭包持有，供 teardown 释放
```

```ts
    currentStage?.dispose();
    currentStage = null;
```

- [ ] **Step 4: 跑测试 + 构建**

Run: `npx vitest run tests/three-renderer.test.ts --reporter=basic`
Expected: 新增 1 项 PASS；既有结果与基线一致。

Run: `npm run build && npm run build:client`
Expected: 均无错误（`build:client` 产出新的 `dist/client.js`）。

- [ ] **Step 5: 提交**

```bash
git add src/client/three-renderer.ts src/client/threejs-player.ts tests/three-renderer.test.ts
git commit -m "feat(effects): three 主路径装配对象级效果链

改法：three-renderer 不再丢弃 scene.json 的 effects——collectObjectEffectChains 按对象
解析链（loadFile 走既有 /wallpapers/scene/<id>/asset 路由），按 objectCameraRange /
particleObjectRange 算对象 RT 尺寸预算并下发 isolate，装配 ObjectEffectStage
（先 setWorldSize 再 setObjectChains），窗口 resize 时同步预算。

验证：tests/three-renderer.test.ts 覆盖 effects 解析与无效对象跳过；build + build:client 通过。"
```

---

### Task 6: 端到端验证与文档回写

**Files:**
- Create: `research/verify-object-effects.mjs`
- Modify: `AGENT.md`（§5.10 的 `OBJECT_RT_MAX` 订正、§7.1 据实改写）
- Modify: `docs/superpowers/specs/2026-09-14-three-object-effects-pipeline-design.md`（状态改为「已实施（P1）」并回写实现偏差）

**Interfaces:**
- Consumes: 前五个任务的全部产出 + `lib/`（`npm run build` 产物）
- Produces: 可复跑的端到端证据脚本

- [ ] **Step 1: 写端到端脚本**

创建 `research/verify-object-effects.mjs`，沿用 `research/verify-colorblend.mjs` 的模式：自起 http server 托管 `lib/` 与壁纸素材，用 esbuild 把 harness 打包，headless Edge 打开页面，逐像素判定。脚本必须输出三项判定：

```js
// 判定 1「效果确实在动」：2683211654（单对象 waterwaves）连拍两帧，差分非零像素占比 > 1%；
// 判定 2「对象级（本特性核心判据）」：1429403119 之类多对象壁纸，效果对象包围盒**外**的
//        采样点在两帧间不变（逐像素差 < 2/255），盒内变化——全屏展平实现必然在这一条失败；
// 判定 3「降级可见」：3765967112（blurprecise 具名 RT 链）页面无 console error，
//        且 console 中出现「效果需要具名 RT（P2 未实现），跳过」告警。
```

实施要点（照抄 `verify-colorblend.mjs`）：`createServer` + `esbuild.build({ entryPoints: ['research/harness-object-effects-entry.mjs'], bundle: true, format: 'esm' })`；Edge 用 `--headless=new --disable-gpu-sandbox`；截图用 CDP `Page.captureScreenshot`；像素比较用既有 `research/png-diff.mjs` 或脚本内联实现。**harness 必须 import `lib/client/threejs-player.js` / `lib/client/three-renderer.js`（生产编译产物），不得 import `src/`。**

- [ ] **Step 2: 跑端到端**

Run: `node research/verify-object-effects.mjs`
Expected: 三项判定全部 PASS，输出形如：

```
[1] 效果在动: 2683211654 帧间差分 3.7% > 1%  PASS
[2] 对象级:   盒外最大差 1/255（不变）, 盒内最大差 88/255（变化）  PASS
[3] 降级:     无 console error; 出现 1 条具名 RT 跳过告警  PASS
```

若判定 2 失败（盒外也在变），说明效果被整屏执行——回到 Task 3/5 检查合成 quad 是否进了隔离路径。

- [ ] **Step 3: 全库效果壁纸逐个目视验证**

在 DSH Web GUI（`dsh web`）里切换全库 17 张带效果壁纸，逐张确认：画面正常、无白屏、无 console error；带 `blurprecise`/`blur`/`godrays` 的壁纸出现具名 RT 跳过告警且其余效果正常。

记录结果（壁纸 id → 观察到的效果 / 告警）供 Step 4 使用。

- [ ] **Step 4: 回写 AGENT.md 与 spec**

`AGENT.md` §5.10：把「对象 RT 尺寸逐轴钳制 `[1, 2048]`」改为 `[1, 4096]`（代码实际值，`scene-renderer.ts:53`）。

`AGENT.md` §7.1 按实测改写：原「未实现对象效果链（effects）」条改为记录 **P1 已达成**（对象级管线 + 106/130 条线性链生效）与 **P2 遗留**（24 条具名 RT 图链：blur/blurprecise/godrays/bloom/shine/localcontrast/bokeh_blur，整条跳过 + 告警），并保留音频响应效果「效果在、不随频谱动」的如实标注。同时在 §2.1 的渲染路径说明里补一句对象级效果链的接线位置（`object-effects.ts` + player 隔离能力）。

spec 顶部状态行改为「已实施（P1；P2 待做）」，并在 §5.1 的降级小节下补一行「实测：17 张壁纸逐个验证结果见 `AGENT.md` §7.1」。

- [ ] **Step 5: 跑全量测试并与基线对比**

Run: `npm test 2>&1 | Select-String -Pattern "Tests|Test Files"`

Expected: 失败数与基线一致（15 项既有失败）。若多于基线，先 `git stash` 对比确认是否本次引入。

- [ ] **Step 6: 提交**

```bash
git add research/verify-object-effects.mjs AGENT.md docs/superpowers/specs/2026-09-14-three-object-effects-pipeline-design.md lib dist
git commit -m "test(effects): 对象级效果链端到端验证 + 文档回写

验证：research/verify-object-effects.mjs（自起 server + headless Edge + esbuild harness，
跑 lib/ 生产代码）三项判定——① 效果确实在动（帧差分 > 1%）；② 对象级（效果对象盒外像素
不变、盒内变化，全屏展平实现必然失败）；③ 具名 RT 链跳过有明确告警且无 console error。

文档：AGENT.md §5.10 订正 OBJECT_RT_MAX 为代码实际值 4096（原记 2048）；§7.1 据实改写为
「P1 达成（对象级管线 + 106/130 线性链）」与「P2 遗留（24 条具名 RT 图链）」；
spec 状态更新为已实施（P1）。

产物：lib/ 与 dist/ 随本次改动更新入库（AGENT.md §3.2 的发布要求）。"
```

---

## Self-Review

**1. Spec coverage**

| spec 章节 | 覆盖任务 |
|---|---|
| §1 概述（对象级、复用、分期） | Task 2/3/4 |
| §2.2 pass 分类 | Task 2（含全库回归钉数字） |
| §2.3 对象级语义 | Task 3（隔离结构与 quad 承载旋转）、Task 6 判定 2 |
| §2.4 复用既有实现 | Task 1（纯函数移入唯一实现）、Task 4（原样复用 `EffectRunner`） |
| §3 模块划分与依赖方向 | Task 1/2/3/4/5 的文件划分 |
| §4.1 隔离语义 + 合成 quad 混合承接 | Task 3（含 `setObjectOutput` 双材质测试） |
| §4.2 帧序 | Task 3 Step 3(i)(j) |
| §4.3 P1 不加 sceneRT | Task 3（帧体直接渲染主场景，未引入全屏 RT） |
| §4.4 粒子坐标修正 | Task 3（`uObjectCenter` 归零 + 专项测试） |
| §5.1 线性判定与降级 | Task 2 + Task 4（去重告警、`rtGraphSkips`） |
| §5.2 RT 尺寸预算（等比） | Task 2（含 8192×4608 用例）、Task 5（预算下发）、Task 4（resize） |
| §5.3 加载期编译 / 串行 / 失败隔离 / 释放 | Task 4（串行、dispose）、Task 3（dispose）、Task 5（加载期解析） |
| §5.4 音频不接（如实标注） | Task 4（`setAudioSpectrumSource(null)`）、Task 6（文档标注） |
| §6 错误处理表 | Task 2/4（解析失败、RT 图链、编译失败、退化为 null stage） |
| §7.1 单测 | Task 1/2/3/4/5 的测试步骤 |
| §7.2 jsdom 隔离模式 + 零回归 | Task 3 Step 1 |
| §7.3 端到端三项判定 | Task 6 Step 1-2 |
| §7.4 性能门槛 | Task 6 Step 3（GUI 实测，记录 FPS） |
| §7.5 验收清单 6 条 | Task 6 Step 2-5 |
| §9 非目标（RT 图链 / text / 音频 / 指针） | Task 2/4 的跳过逻辑 + Task 6 文档 |
| §10 遗留（`EffectRunner` 零覆盖、显存、SwiftShader、refraction 待验、AGENT 文档不符） | Task 6 Step 3-4（refraction 与显存实测记录）、Step 4（订正文档） |

**2. Placeholder scan**：计划内所有代码步骤均给出可直接写入的完整代码，或用精确的「源文件 + 行号 + 符号名」移动指令（仅 Task 1 的纯搬移属后者，其源位置唯一且可逐字核对）。自审已修掉三处内部不一致（`onViewportResize` 误用 `_chainsForResize`、`ObjectChainEntry` 缺 `chains` 字段、`isolatedObjects()` 返回类型缺 `rtWidth/rtHeight/rtTexture`），现无 TBD / TODO / 「与 Task N 相同」式引用。

**3. Type consistency**：
- `ObjectEffectStage` 接口在 Task 2 定义（`bindOutputs` / `advance`）、Task 3 在 player 内**同形再定义**（结构化匹配，无循环依赖）、Task 4 实现 —— 三者签名一致。
- `IsolatedObject`（player 导出，Task 3）含 `rtWidth` / `rtHeight` / `rtTexture` 三个扁平字段，与 `IsolatedHostView`（stage 消费，Task 4）逐字段对齐；`attachIsolated` 在 Task 3 Step 3(f) 里已写入这三个字段，`isolatedObjects()` 直接返回 Map 值即可。
- `setChains(chains, wallpaperId, { width, height })` 与 `EffectRunner`（`effect-runner.ts:147`）签名一致。
- `resolveObjectRtSize(worldW, worldH, dpr, budgetW, budgetH)` 在 Task 2 定义、Task 4/5 调用的参数顺序一致。
- 调用顺序契约（跨任务）：`three-renderer` 必须先 `setWorldSize` 再 `setObjectChains`；`mount` 保留既有 entry 的世界尺寸（Task 4 Step 3 已实现）。
- `Task 5 Step 3(c)` 的注释标明了该解析段必须位于纹理/粒子装配循环**之后**；实施时把整段放到 `loadSceneToThree` 调用之前。
