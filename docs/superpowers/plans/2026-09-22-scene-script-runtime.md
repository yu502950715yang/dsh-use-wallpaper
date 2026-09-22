# SceneScript 运行时（visible.script + 图层状态桥）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `3798688689`「直到大地变成一颗酸橙(有切换特效喵)」等 4 张壁纸的 `visible.script` 真正执行，把画面从"全图层叠加的静止状态"变成脚本编排的正确场景与动画。

**Architecture:** quickjs 单上下文装载模块脚本 → 脚本对"图层"的读写落进纯数据 `LayerStateTable` → 渲染侧应用器每帧把脏项写到 three 对象。运行时不知道 three，渲染不知道 quickjs。

**Tech Stack:** TypeScript、vitest、quickjs-emscripten、three.js r170

**Spec:** `docs/superpowers/specs/2026-09-22-scene-script-runtime-design.md`

## Global Constraints

- quickjs 只经 `quickjs-emscripten`（已是生产依赖）；**不改** `src/client/text-script.ts` 与 `src/client/scene-script.ts`
- **所有 quickjs handle 必须 dispose** —— 漏一个就会在 `runtime.dispose()` 触发 `gc_obj_list` 断言（spike 实测踩到）
- 脚本必须**同一 ctx**、按 `scene.json` 的 `objects` 顺序装载与执行（它们靠 `shared.*` 互通）
- fps **逐动画**：`loops[].fps=60` 而 `paperTimelines[].fps=1200`，相差 20 倍；提取不到时兜底 60 并 warn
- 单帧脚本开销预算 **< 3 ms**
- **零回归**：`2832263418` / `3789452668` / `2937346640` 的画面必须逐像素不变
- 脚本任一环节失败 → 该脚本停用、画面退回现状；绝不抛进 player 帧循环
- 测试命令 `npx vitest run <file>`；提交信息标题一行 + 正文最多 3 行

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/client/scene-anim.ts`（新增） | `extractAnimFps()` 纯函数 + `AnimRegistry`（持久播放器、逐动画 fps、`tick(dt)` 推进） |
| `src/client/layer-state.ts`（新增） | `LayerStateTable`（纯数据 + 脏项）+ `applyLayerState()` 应用器 |
| `src/client/scene-script-vm.ts`（新增） | quickjs 单 ctx；prelude（`Vec3`/`IModelData`/`thisScene`/`engine`/`shared`）；装载/调用/异常隔离/dispose |
| `src/client/scene-script-host.ts`（新增） | 编排：装载脚本 → 每帧 `tick(dt)` 返回脏项 → 降级 |
| `src/client/scene-json.ts`（改） | `util` 分支也产出 `script`/`scriptProperties` |
| `src/client/threejs-player.ts`（改） | scene 对象 id → 显示对象映射（`displayObject()`）+ `SceneAssets.onFrame` 帧钩子 |
| `src/client/three-renderer.ts`（改） | 收集脚本、建 fps 表、装配 host、帧钩子接线、dispose |
| `tests/scene-anim.test.ts` 等（新增） | 各模块单测 |

---

### Task 1: `scene-json.ts` 让 util 对象携带脚本

**Files:**
- Modify: `src/client/scene-json.ts:164-168`（util 分支）
- Test: `tests/scene-json.test.ts`（追加用例）

**Interfaces:**
- Produces: `SceneObject`（util 分支）新增可选 `script?: string` / `scriptProperties?: Record<string, unknown>`，与 image 分支同形

- [ ] **Step 1: 写失败测试**

在 `tests/scene-json.test.ts` 末尾追加：

```ts
describe('parseSceneJson - util 对象的 visible.script', () => {
  it('util 对象保留 script 与解包后的 scriptProperties', () => {
    const raw = JSON.stringify({
      objects: [{
        id: 94000, name: '场景控制器',
        image: 'models/util/solidlayer.json',
        visible: {
          script: "'use strict';\nexport function update(v){return v;}",
          value: true,
          scriptproperties: { fx_float: { user: 'fx_float', value: true } },
        },
      }],
    });
    const desc = parseSceneJson(raw);
    const o = desc.objects[0]!;
    expect(o.kind).toBe('util');
    expect(o.script).toContain('export function update');
    expect(o.scriptProperties).toEqual({ fx_float: true });
  });

  it('无 script 的 util 对象不产生 script 字段', () => {
    const desc = parseSceneJson(JSON.stringify({
      objects: [{ id: 1, image: 'models/util/solidlayer.json', visible: false }],
    }));
    expect(desc.objects[0]!.script).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scene-json.test.ts -t "util 对象"`
Expected: FAIL —— `expected undefined to contain 'export function update'`

- [ ] **Step 3: 实现**

把 `src/client/scene-json.ts` 的 util 分支改为（与 image 分支同款派生）：

```ts
      if (o.image.startsWith('models/util/')) {
        return {
          ...base, kind: 'util' as const, image: o.image,
          // 2026-09-22：util 对象不渲染，但**承载 SceneScript 控制器**（3798688689 的 4 个总控
          // 全挂在 models/util/* 上）—— 脚本必须能被执行，故与 image 同款派生 script 字段。
          ...(base.visible?.kind === 'script'
            ? { script: base.visible.script, scriptProperties: base.visible.scriptProperties }
            : {}),
        };
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/scene-json.test.ts`
Expected: PASS（含既有全部用例）

- [ ] **Step 5: 提交**

```bash
git add src/client/scene-json.ts tests/scene-json.test.ts
git commit -m "feat(scene-json): util 对象也派生 visible.script 字段"
```

---

### Task 2: `extractAnimFps()` —— 从脚本源码提取逐动画 fps

**Files:**
- Create: `src/client/scene-anim.ts`
- Test: `tests/scene-anim.test.ts`

**Interfaces:**
- Produces: `export function extractAnimFps(scriptSource: string): Map<string, number>`

背景（spec §6.2）：`scene.pkg` 内无动画数据，唯一来源是脚本内嵌 config 的 `"name":…,"fps":N`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/scene-anim.test.ts
import { describe, it, expect } from 'vitest';
import { extractAnimFps } from '../src/client/scene-anim.js';

describe('extractAnimFps', () => {
  it('从 loops/paperTimelines 形态提取 name → fps', () => {
    const src = `const config={"loops":[{"id":10750,"property":"alpha","name":"loop_kv2_line__10750_alpha","clip":"loop_kv2_line","duration":8.73,"fps":60}],
      "paperTimelines":[{"id":1122,"property":"origin","name":"信封_root_1_origin","clip":"act53side_trans_kv1tokv2","duration":2.1667,"fps":1200}]};`;
    const t = extractAnimFps(src);
    expect(t.get('loop_kv2_line__10750_alpha')).toBe(60);
    expect(t.get('信封_root_1_origin')).toBe(1200);
  });

  it('无 fps 字段的源码返回空表（不抛错）', () => {
    expect(extractAnimFps("export function update(v){return v;}").size).toBe(0);
  });

  it('忽略非法 fps（0/负数/非有限）', () => {
    const t = extractAnimFps('{"name":"a","fps":0}{"name":"b","fps":-1}');
    expect(t.size).toBe(0);
  });

  it('name 在 fps 之后也能配对（容错顺序）', () => {
    const t = extractAnimFps('{"fps":60,"name":"x"}');
    expect(t.get('x')).toBe(60);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scene-anim.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

```ts
// src/client/scene-anim.ts
// WE 动画的 fps 只存在于脚本内嵌 config 里（scene.pkg 内无动画数据，spec §6.2）。
// 不求整体解析 JSON（脚本首行是几百 KB 的字面量）：按 "name":"…","fps":N 就近配对。

const NAME_RE = /"name"\s*:\s*"([^"]{1,200})"/g;
const FPS_RE = /"fps"\s*:\s*(-?\d+(?:\.\d+)?)/g;

/** 从脚本源码提取 动画名 → fps。提取不到的动画由调用方兜底。 */
export function extractAnimFps(scriptSource: string): Map<string, number> {
  const out = new Map<string, number>();
  if (typeof scriptSource !== 'string' || scriptSource.length === 0) return out;
  // 收集全部 name 与 fps 的位置，按"就近配对"（同一对象字面量内两者相距最近）
  const names: Array<{ at: number; value: string }> = [];
  const fpss: Array<{ at: number; value: number }> = [];
  for (const m of scriptSource.matchAll(NAME_RE)) names.push({ at: m.index ?? 0, value: m[1]! });
  for (const m of scriptSource.matchAll(FPS_RE)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > 0) fpss.push({ at: m.index ?? 0, value: v });
  }
  if (names.length === 0 || fpss.length === 0) return out;
  for (const f of fpss) {
    let best: { at: number; value: string } | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const n of names) {
      const d = Math.abs(n.at - f.at);
      if (d < bestDist) { bestDist = d; best = n; }
    }
    // 配对半径：同一对象字面量里 name 与 fps 相距不会超过 400 字符
    if (best && bestDist <= 400 && !out.has(best.value)) out.set(best.value, f.value);
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/scene-anim.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/client/scene-anim.ts tests/scene-anim.test.ts
git commit -m "feat(scene-anim): 从脚本内嵌 config 提取逐动画 fps"
```

---

### Task 3: `AnimRegistry` —— 持久、有状态、按 fps 推进的播放器

**Files:**
- Modify: `src/client/scene-anim.ts`
- Test: `tests/scene-anim.test.ts`（追加）

**Interfaces:**
- Consumes: `extractAnimFps` 的产物 `Map<string, number>`
- Produces:
  ```ts
  export interface AnimPlayback {
    play(): void; pause(): void; stop(): void; isPlaying(): boolean;
    setFrame(v: number): void; getFrame(): number;
  }
  export class AnimRegistry {
    constructor(fpsTable: Map<string, number>, defaultFps?: number);
    get(layerKey: string, name: string): AnimPlayback;  // 同一 (layerKey,name) 恒同一对象
    tick(dt: number): void;                             // frame += fps × dt
    playingCount(): number;
  }
  ```

- [ ] **Step 1: 写失败测试**

```ts
describe('AnimRegistry', () => {
  it('同一 (layerKey,name) 返回同一对象（持久性 —— spike 的假阴性根因）', () => {
    const r = new AnimRegistry(new Map());
    expect(r.get('id:1', 'a')).toBe(r.get('id:1', 'a'));
    expect(r.get('id:1', 'a')).not.toBe(r.get('id:2', 'a'));
  });

  it('tick 只推进 playing 的播放器，速率 = 该动画 fps', () => {
    const r = new AnimRegistry(new Map([['fast', 1200], ['slow', 60]]));
    const fast = r.get('id:1', 'fast');
    const slow = r.get('id:1', 'slow');
    fast.play(); slow.play();
    r.tick(1 / 60);
    expect(fast.getFrame()).toBeCloseTo(20, 5);   // 1200 fps → 20 帧/帧
    expect(slow.getFrame()).toBeCloseTo(1, 5);    // 60 fps → 1 帧/帧
    slow.pause();
    r.tick(1 / 60);
    expect(slow.getFrame()).toBeCloseTo(1, 5);    // 暂停后不推进
    expect(fast.getFrame()).toBeCloseTo(40, 5);
  });

  it('未登记的动画名用 defaultFps 兜底', () => {
    const r = new AnimRegistry(new Map(), 60);
    const a = r.get('id:1', 'unknown');
    a.play(); r.tick(1 / 2);
    expect(a.getFrame()).toBeCloseTo(30, 5);
  });

  it('play/pause/stop/isPlaying 状态正确；stop 归零', () => {
    const r = new AnimRegistry(new Map());
    const a = r.get('id:1', 'x');
    expect(a.isPlaying()).toBe(false);
    a.play(); expect(a.isPlaying()).toBe(true);
    a.setFrame(7); expect(a.getFrame()).toBe(7);
    a.pause(); expect(a.isPlaying()).toBe(false);
    a.stop(); expect(a.getFrame()).toBe(0); expect(a.isPlaying()).toBe(false);
  });

  it('playingCount 反映在播数量', () => {
    const r = new AnimRegistry(new Map());
    r.get('id:1', 'a').play(); r.get('id:1', 'b').play();
    expect(r.playingCount()).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scene-anim.test.ts -t "AnimRegistry"`
Expected: FAIL —— `AnimRegistry is not a constructor`

- [ ] **Step 3: 实现**

在 `src/client/scene-anim.ts` 追加：

```ts
// WE 的 layer.getAnimation(name) 返回「引擎驱动的动画播放器」：必须持久（同一 layer+name 同一
// 对象）、有 play/pause/isPlaying 状态，且由引擎每帧推进 getFrame()。脚本的 advanceFrame 靠
// tracks[0].animation.getFrame() 算过渡相位 —— 返回新对象或不推进会让动画静默不动。
export interface AnimPlayback {
  play(): void;
  pause(): void;
  stop(): void;
  isPlaying(): boolean;
  setFrame(v: number): void;
  getFrame(): number;
}

interface AnimState {
  frame: number;
  fps: number;
  playing: boolean;
  playback: AnimPlayback;
}

export class AnimRegistry {
  private readonly byKey = new Map<string, AnimState>();
  private readonly fpsTable: Map<string, number>;
  private readonly defaultFps: number;
  /** 已警告过的动画名（避免每帧刷屏）。 */
  readonly warned = new Set<string>();

  constructor(fpsTable: Map<string, number>, defaultFps = 60) {
    this.fpsTable = fpsTable;
    this.defaultFps = Number.isFinite(defaultFps) && defaultFps > 0 ? defaultFps : 60;
  }

  /** 取（或创建）某动画的播放器。同一 (layerKey,name) 恒返回同一对象。 */
  get(layerKey: string, name: string): AnimPlayback {
    const key = `${layerKey}|${name}`;
    const hit = this.byKey.get(key);
    if (hit) return hit.playback;
    const fps = this.fpsTable.get(name) ?? this.defaultFps;
    const st: AnimState = { frame: 0, fps, playing: false, playback: null as unknown as AnimPlayback };
    st.playback = {
      play: () => { st.playing = true; },
      pause: () => { st.playing = false; },
      stop: () => { st.playing = false; st.frame = 0; },
      isPlaying: () => st.playing,
      setFrame: (v: number) => { st.frame = Number.isFinite(v) ? v : 0; },
      getFrame: () => st.frame,
    };
    this.byKey.set(key, st);
    return st.playback;
  }

  /** 每帧推进所有在播播放器：frame += fps × dt。 */
  tick(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    for (const st of this.byKey.values()) {
      if (st.playing) st.frame += st.fps * dt;
    }
  }

  playingCount(): number {
    let n = 0;
    for (const st of this.byKey.values()) if (st.playing) n++;
    return n;
  }

  /** 本动画实际使用的 fps（诊断用）。 */
  fpsOf(name: string): number {
    return this.fpsTable.get(name) ?? this.defaultFps;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/scene-anim.test.ts`
Expected: PASS（9 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/client/scene-anim.ts tests/scene-anim.test.ts
git commit -m "feat(scene-anim): 持久动画播放器注册表（逐动画 fps 推进）"
```

---

### Task 4: `LayerStateTable` —— 纯数据 + 脏项

**Files:**
- Create: `src/client/layer-state.ts`
- Test: `tests/layer-state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LayerWrite {
    origin?: [number, number, number];
    angles?: [number, number, number];
    scale?: [number, number, number];
    alpha?: number;
    visible?: boolean;
  }
  export interface LayerStateTable {
    write(objectId: number, patch: LayerWrite): void;
    read(objectId: number): LayerWrite;
    takeDirty(): Map<number, LayerWrite>;
    size(): number;
  }
  export function createLayerStateTable(): LayerStateTable;
  ```

- [ ] **Step 1: 写失败测试**

```ts
// tests/layer-state.test.ts
import { describe, it, expect } from 'vitest';
import { createLayerStateTable } from '../src/client/layer-state.js';

describe('LayerStateTable', () => {
  it('write 合并同一对象的多次写入，read 返回最新值', () => {
    const t = createLayerStateTable();
    t.write(100, { alpha: 0.5 });
    t.write(100, { alpha: 0.2, origin: [1, 2, 0] });
    expect(t.read(100)).toEqual({ alpha: 0.2, origin: [1, 2, 0] });
  });

  it('takeDirty 返回脏项并清空；未再写入则第二次为空', () => {
    const t = createLayerStateTable();
    t.write(100, { alpha: 1 });
    const d1 = t.takeDirty();
    expect(d1.get(100)).toEqual({ alpha: 1 });
    expect(t.takeDirty().size).toBe(0);
    t.write(100, { alpha: 0.5 });
    expect(t.takeDirty().get(100)).toEqual({ alpha: 0.5 });
  });

  it('重复写同值不产生脏项（避免每帧无谓应用）', () => {
    const t = createLayerStateTable();
    t.write(100, { alpha: 1 });
    t.takeDirty();
    t.write(100, { alpha: 1 });
    expect(t.takeDirty().size).toBe(0);
  });

  it('数组值按分量比较（值等价不算脏）', () => {
    const t = createLayerStateTable();
    t.write(7, { origin: [1, 2, 3] });
    t.takeDirty();
    t.write(7, { origin: [1, 2, 3] });
    expect(t.takeDirty().size).toBe(0);
  });

  it('size 反映已登记对象数', () => {
    const t = createLayerStateTable();
    t.write(1, { alpha: 1 }); t.write(2, { alpha: 1 });
    expect(t.size()).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/layer-state.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

```ts
// src/client/layer-state.ts
// 脚本对「图层」的写入落在这里：纯数据、无 three 依赖 ⇒ 可 node 单测。
// 键 = scene.json 的对象 id（脚本用 thisScene.getLayerByID(id) 拿到的就是它）。

export interface LayerWrite {
  origin?: [number, number, number];
  angles?: [number, number, number];
  scale?: [number, number, number];
  alpha?: number;
  visible?: boolean;
}

export interface LayerStateTable {
  write(objectId: number, patch: LayerWrite): void;
  read(objectId: number): LayerWrite;
  takeDirty(): Map<number, LayerWrite>;
  size(): number;
}

function vecEq(a: [number, number, number] | undefined, b: [number, number, number] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function patchEq(a: LayerWrite, b: LayerWrite): boolean {
  return vecEq(a.origin, b.origin) && vecEq(a.angles, b.angles) && vecEq(a.scale, b.scale)
    && a.alpha === b.alpha && a.visible === b.visible;
}

export function createLayerStateTable(): LayerStateTable {
  const state = new Map<number, LayerWrite>();
  const dirty = new Map<number, LayerWrite>();
  return {
    write(objectId: number, patch: LayerWrite): void {
      const cur = state.get(objectId) ?? {};
      const next: LayerWrite = { ...cur, ...patch };
      state.set(objectId, next);
      if (!patchEq(cur, next)) dirty.set(objectId, { ...dirty.get(objectId), ...patch });
    },
    read(objectId: number): LayerWrite {
      return { ...(state.get(objectId) ?? {}) };
    },
    takeDirty(): Map<number, LayerWrite> {
      const out = new Map(dirty);
      dirty.clear();
      return out;
    },
    size(): number {
      return state.size;
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/layer-state.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/client/layer-state.ts tests/layer-state.test.ts
git commit -m "feat(layer-state): 图层状态表（纯数据 + 脏项判定）"
```

---

### Task 5: `applyLayerState()` —— 把脏项写到 three 对象

**Files:**
- Modify: `src/client/layer-state.ts`
- Test: `tests/layer-state.test.ts`（追加）

**Interfaces:**
- Consumes: `LayerStateTable.takeDirty()` 的产物
- Produces:
  ```ts
  export interface DisplayTarget { object: THREE.Object3D; sceneW: number; sceneH: number; }
  export function applyLayerState(
    dirty: Map<number, LayerWrite>,
    lookup: (objectId: number) => DisplayTarget | undefined,
  ): number;   // 实际应用的对象数
  ```

语义（spec §6.1）：`visible===false` 或 `alpha<=0.002` → `object.visible=false`；否则 `visible=true` 并尽力写材质 opacity，**不触碰**引擎既有 visible 过滤。`origin` 按 `we_to_three`（减 scene/2，y 不翻）。

- [ ] **Step 1: 写失败测试**

```ts
import * as THREE from 'three';

describe('applyLayerState', () => {
  const mk = (objectId: number) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
    return { target: { object: mesh, sceneW: 2560, sceneH: 1440 }, mesh };
  };

  it('origin 走 we_to_three（减 scene/2，y 不翻）', () => {
    const { target, mesh } = mk(1);
    const n = applyLayerState(new Map([[1, { origin: [100, 200, 0] }]]), () => target);
    expect(n).toBe(1);
    expect(mesh.position.x).toBeCloseTo(100 - 1280);
    expect(mesh.position.y).toBeCloseTo(200 - 720);
  });

  it('scale / angles 直接落到对象', () => {
    const { target, mesh } = mk(1);
    applyLayerState(new Map([[1, { scale: [2, 3, 1], angles: [0, 0, -0.5] }]]), () => target);
    expect(mesh.scale.toArray()).toEqual([2, 3, 1]);
    expect(mesh.rotation.z).toBeCloseTo(-0.5);
  });

  it('visible=false 映射成 object.visible=false（alpha=0 等价表达）', () => {
    const { target, mesh } = mk(1);
    applyLayerState(new Map([[1, { visible: false }]]), () => target);
    expect(mesh.visible).toBe(false);
  });

  it('alpha 落到 MeshBasicMaterial.opacity；为 0 时隐藏', () => {
    const { target, mesh } = mk(1);
    const mat = mesh.material as THREE.MeshBasicMaterial;
    applyLayerState(new Map([[1, { alpha: 0.25 }]]), () => target);
    expect(mesh.visible).toBe(true);
    expect(mat.opacity).toBeCloseTo(0.25);
    applyLayerState(new Map([[1, { alpha: 0 }]]), () => target);
    expect(mesh.visible).toBe(false);
  });

  it('alpha 也支持 ShaderMaterial.uniforms.opacity', () => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
      uniforms: { opacity: { value: 1 } }, vertexShader: '', fragmentShader: '',
    }));
    applyLayerState(new Map([[1, { alpha: 0.4 }]]), () => ({ object: mesh, sceneW: 0, sceneH: 0 }));
    expect((mesh.material as THREE.ShaderMaterial).uniforms.opacity!.value).toBeCloseTo(0.4);
  });

  it('lookup 未命中时跳过（util / 未渲染对象只记账不应用）', () => {
    const n = applyLayerState(new Map([[999, { alpha: 0 }]]), () => undefined);
    expect(n).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/layer-state.test.ts -t "applyLayerState"`
Expected: FAIL —— `applyLayerState is not a function`

- [ ] **Step 3: 实现**

在 `src/client/layer-state.ts` 顶部加 `import type * as THREE from 'three';`（仅类型），并追加：

```ts
/** 应用器要写到哪个对象上：three 的最终显示对象 + 场景固有尺寸（we_to_three 的基准）。 */
export interface DisplayTarget {
  object: THREE.Object3D;
  sceneW: number;
  sceneH: number;
}

function writeOpacity(object: THREE.Object3D, alpha: number): void {
  const mat = (object as { material?: unknown }).material;
  const list = Array.isArray(mat) ? mat : mat ? [mat] : [];
  for (const m of list) {
    const anyMat = m as { opacity?: number; uniforms?: Record<string, { value?: unknown }> };
    if (typeof anyMat.opacity === 'number') anyMat.opacity = alpha;
    const u = anyMat.uniforms?.['opacity'];
    if (u && typeof u.value === 'number') u.value = alpha;
  }
}

/** 把脏写入应用到 three 对象。返回实际应用的对象数（lookup 未命中的跳过）。
 *  ⚠️ visible=false 走 three 的 Object3D.visible —— 这是**对象级隐藏**，不动引擎既有的
 *  scene.json visible 过滤（那会影响其他壁纸，见 spec §6.1）。 */
export function applyLayerState(
  dirty: Map<number, LayerWrite>,
  lookup: (objectId: number) => DisplayTarget | undefined,
): number {
  let applied = 0;
  for (const [objectId, w] of dirty) {
    const target = lookup(objectId);
    if (!target) continue;
    const obj = target.object;
    if (w.origin) obj.position.set(w.origin[0] - target.sceneW / 2, w.origin[1] - target.sceneH / 2, w.origin[2]);
    if (w.scale) obj.scale.set(w.scale[0], w.scale[1], w.scale[2]);
    if (w.angles) obj.rotation.set(w.angles[0], w.angles[1], w.angles[2]);
    const alpha = w.alpha;
    if (alpha !== undefined) {
      const a = Math.max(0, Math.min(1, alpha));
      writeOpacity(obj, a);
      obj.visible = a > 0.002;
    }
    if (w.visible === false) obj.visible = false;
    else if (w.visible === true && alpha === undefined) obj.visible = true;
    applied++;
  }
  return applied;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/layer-state.test.ts`
Expected: PASS（11 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/client/layer-state.ts tests/layer-state.test.ts
git commit -m "feat(layer-state): 应用器（we_to_three / alpha / Object3D.visible）"
```

---

### Task 6: `SceneScriptVm` —— quickjs 单上下文模块脚本 VM

**Files:**
- Create: `src/client/scene-script-vm.ts`
- Test: `tests/scene-script-vm.test.ts`

**Interfaces:**
- Consumes: `LayerStateTable`、`AnimRegistry`
- Produces:
  ```ts
  export interface SceneScriptVmOptions {
    userProperties: Record<string, unknown>;
    state: LayerStateTable;
    anims: AnimRegistry;
    onWarn?: (msg: string) => void;
    now?: () => number;   // 测试可注入
  }
  export class SceneScriptVm {
    static create(opts: SceneScriptVmOptions): Promise<SceneScriptVm | null>;
    load(source: string): boolean;   // 装载一个模块脚本；false = eval 失败（已 warn）
    initAll(): void;
    updateAll(): void;
    clickAll(): void;
    get loadedCount(): number;
    get activeCount(): number;       // 仍可用的脚本数（抛错后被停用）
    dispose(): void;
  }
  ```

关键：**prelude 在 quickjs 内构造** `Vec3`/`IModelData`/`thisScene`/`engine`/`shared`/`console`；宿主只注入原语 `__host.read/write/...`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/scene-script-vm.test.ts
import { describe, it, expect } from 'vitest';
import { SceneScriptVm } from '../src/client/scene-script-vm.js';
import { createLayerStateTable } from '../src/client/layer-state.js';
import { AnimRegistry } from '../src/client/scene-anim.js';

const mk = (script: string, userProps: Record<string, unknown> = {}) => {
  const state = createLayerStateTable();
  const anims = new AnimRegistry(new Map());
  return { state, anims, script, userProps };
};

describe('SceneScriptVm', () => {
  it('装载并执行 init/update；脚本对图层的写入进状态表', async () => {
    const { state, anims, script } = mk(`
      export function init(value){ return value; }
      export function update(value){
        var L = thisScene.getLayerByID(10750);
        L.alpha = 0.25;
        L.origin = new Vec3(10, 20, 0);
        L.visible = true;
        return value;
      }`);
    const vm = await SceneScriptVm.create({ userProperties: {}, state, anims });
    expect(vm).not.toBeNull();
    expect(vm!.load(script)).toBe(true);
    vm!.initAll();
    vm!.updateAll();
    expect(state.read(10750).alpha).toBeCloseTo(0.25);
    expect(state.read(10750).origin).toEqual([10, 20, 0]);
    vm!.dispose();
  });

  it('engine.userProperties 注入到脚本；applyUserProperties 收到它', async () => {
    const { state, anims } = mk('');
    const vm = await SceneScriptVm.create({ userProperties: { fx_float: false }, state, anims });
    vm!.load(`export function applyUserProperties(changed){ thisScene.getLayerByID(1).alpha = changed.fx_float ? 1 : 0; }`);
    vm!.initAll();
    expect(state.read(1).alpha).toBe(0);
    vm!.dispose();
  });

  it('init 抛错只停用该脚本，其余脚本继续', async () => {
    const { state, anims } = mk('');
    const warns: string[] = [];
    const vm = await SceneScriptVm.create({ userProperties: {}, state, anims, onWarn: (m) => warns.push(m) });
    vm!.load(`export function init(){ throw new Error('boom'); }`);
    vm!.load(`export function update(){ thisScene.getLayerByID(2).alpha = 0.5; }`);
    vm!.initAll();
    vm!.updateAll();
    expect(state.read(2).alpha).toBeCloseTo(0.5);
    expect(warns.some((w) => w.includes('boom'))).toBe(true);
    vm!.dispose();
  });

  it('动画播放器：play/isPlaying/getFrame 与注册表打通；同一 name 持久', async () => {
    const { state, anims } = mk('');
    anims = new AnimRegistry(new Map([['fast', 1200]]));
    const vm = await SceneScriptVm.create({ userProperties: {}, state, anims });
    vm!.load(`export function init(){
      var a = thisScene.getLayerByID(1).getAnimation('fast');
      a.play();
      var b = thisScene.getLayerByID(1).getAnimation('fast');
      b.setFrame(100);
      thisScene.getLayerByID(1).alpha = a.getFrame() === 100 && a.isPlaying() ? 1 : 0;
    }`);
    vm!.initAll();
    expect(state.read(1).alpha).toBe(1);
    vm!.dispose();
  });

  it('createLayer / createModelData / getEffect / registerAsset 是安全 stub（不抛错）', async () => {
    const { state, anims } = mk('');
    const vm = await SceneScriptVm.create({ userProperties: {}, state, anims });
    vm!.load(`export function init(){
      var m = thisScene.createModelData({ shapes: [] });
      m.applyData(new Float32Array(4), 0);
      var L = thisScene.createLayer({ model: m, name: 'x' });
      L.setParent(null);
      var e = thisScene.getLayerByID(3).getEffect('角色动态');
      e.visible = false;
      e.setMaterialProperty('frame', 2);
      engine.registerAsset('materials/a.json', true);
      thisScene.getLayerByID(3).alpha = 1;
    }`);
    vm!.initAll();
    expect(state.read(3).alpha).toBe(1);
    vm!.dispose();
  });

  it('eval 失败的脚本不装载（load 返回 false），不影响其他脚本', async () => {
    const { state, anims } = mk('');
    const vm = await SceneScriptVm.create({ userProperties: {}, state, anims });
    expect(vm!.load('export function update( { syntax error')).toBe(false);
    expect(vm!.load(`export function update(){ thisScene.getLayerByID(4).alpha = 0.1; }`)).toBe(true);
    vm!.initAll(); vm!.updateAll();
    expect(state.read(4).alpha).toBeCloseTo(0.1);
    expect(vm!.loadedCount).toBe(1);
    vm!.dispose();
  });

  it('dispose 不抛（handle 全部释放）', async () => {
    const { state, anims } = mk('');
    const vm = await SceneScriptVm.create({ userProperties: {}, state, anims });
    vm!.load(`export function init(){ thisScene.getLayerByID(1).alpha = 1; }`);
    vm!.initAll();
    expect(() => vm!.dispose()).not.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scene-script-vm.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

```ts
// src/client/scene-script-vm.ts
// WE SceneScript（模块风格）的 quickjs 运行时：单一 ctx 装载 N 个脚本，它们靠全局 shared 互通。
// 宿主只注入原语（read/write/anim*），图层对象与 thisScene/engine 由 prelude 在 quickjs 内构造。
// ⚠️ handle 生命周期：newFunction/newObject 创建的句柄必须 dispose，否则 runtime.dispose() 触发
// gc_obj_list 断言（spike 实测）。本文件用 Scope 集中管理装载期句柄。
import { newQuickJSWASMModuleFromVariant, newVariant, RELEASE_SYNC } from 'quickjs-emscripten';
import type { QuickJSContext, QuickJSRuntime, QuickJSHandle, QuickJSWASMModule } from 'quickjs-emscripten';
import type { LayerStateTable } from './layer-state.js';
import type { AnimRegistry } from './scene-anim.js';

export interface SceneScriptVmOptions {
  userProperties: Record<string, unknown>;
  state: LayerStateTable;
  anims: AnimRegistry;
  onWarn?: (msg: string) => void;
}

const STEP_BUDGET = 50_000_000;

/** prelude：在 quickjs 全局作用域定义宿主 API。所有状态都在宿主的 state/anims 里。 */
const PRELUDE = `
var __mods = [];
function Vec3(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
function Vec4(x, y, z, w) { this.x = x || 0; this.y = y || 0; this.z = z || 0; this.w = w || 0; }
var IModelData = { POSITION: 0, UV: 1, COLOR: 2, NORMAL: 3, TANGENT: 4 };
var __dummy = function () {};
function __mkDummy(name) {
  var o = { __name: name, applyData: __dummy, setParent: __dummy, setMaterialProperty: __dummy,
            getMaterialProperty: function () { return 0; }, visible: true };
  return o;
}
var __animCache = {};
function __mkAnim(key, name) {
  var k = key + '|' + name;
  if (__animCache[k]) return __animCache[k];
  __animCache[k] = {
    play: function () { __host.animPlay(key, name); },
    pause: function () { __host.animPause(key, name); },
    stop: function () { __host.animStop(key, name); },
    isPlaying: function () { return __host.animIsPlaying(key, name); },
    setFrame: function (v) { __host.animSetFrame(key, name, v); },
    getFrame: function () { return __host.animGetFrame(key, name); }
  };
  return __animCache[k];
}
var __layerCache = {};
function __mkLayer(key) {
  if (__layerCache[key]) return __layerCache[key];
  var o = {
    __key: key,
    get alpha() { return __host.readNum(key, 'alpha'); },
    set alpha(v) { __host.writeNum(key, 'alpha', v); },
    get baseAlpha() { return __host.readNum(key, 'baseAlpha'); },
    set baseAlpha(v) { __host.writeNum(key, 'baseAlpha', v); },
    get opacity() { return __host.readNum(key, 'alpha'); },
    set opacity(v) { __host.writeNum(key, 'alpha', v); },
    get visible() { return __host.readBool(key, 'visible'); },
    set visible(v) { __host.writeBool(key, 'visible', v); },
    get origin() { var a = __host.readVec(key, 'origin'); return new Vec3(a[0], a[1], a[2]); },
    set origin(v) { __host.writeVec(key, 'origin', v.x, v.y, v.z || 0); },
    get angles() { var a = __host.readVec(key, 'angles'); return new Vec3(a[0], a[1], a[2]); },
    set angles(v) { __host.writeVec(key, 'angles', v.x, v.y, v.z || 0); },
    get scale() { var a = __host.readVec(key, 'scale'); return new Vec3(a[0] === 0 ? 1 : a[0], a[1] === 0 ? 1 : a[1], a[2] === 0 ? 1 : a[2]); },
    set scale(v) { __host.writeVec(key, 'scale', v.x, v.y, v.z || 1); },
    get color() { var a = __host.readVec(key, 'color'); return new Vec3(a[0], a[1], a[2]); },
    set color(v) { __host.writeVec(key, 'color', v.x, v.y, v.z || 0); },
    getAnimation: function (name) { return __mkAnim(key, String(name)); },
    getEffect: function (name) { return { visible: true, name: name, setMaterialProperty: __dummy, getMaterialProperty: function () { return 0; } }; },
    getModelData: function () { return __mkDummy('model'); },
    setMaterialProperty: __dummy,
    getMaterialProperty: function () { return 0; }
  };
  __layerCache[key] = o;
  return o;
}
var thisScene = {
  getLayerByID: function (id) { return __mkLayer('id:' + id); },
  getLayer: function (n) { return __mkLayer('name:' + n); },
  createLayer: function (o) { return __mkLayer('new:' + ((o && o.name) ? o.name : 'anon')); },
  createModelData: function () { return __mkDummy('model'); }
};
var getLayerByID = thisScene.getLayerByID;
var getLayer = thisScene.getLayer;
var createLayer = thisScene.createLayer;
var engine = {
  frametime: 1 / 60,
  userProperties: {},
  registerAsset: function () { return __mkDummy('asset'); }
};
var registerAsset = engine.registerAsset;
var shared = {};
var console = { log: __host.log, warn: __host.log, error: __host.log };
true;
`;

interface Loaded {
  objectId: number;
  instance: QuickJSHandle;
  updateFn: QuickJSHandle | null;
  clickFn: QuickJSHandle | null;
  active: boolean;
}

export class SceneScriptVm {
  private readonly ctx: QuickJSContext;
  private readonly runtime: QuickJSRuntime;
  private readonly handles: QuickJSHandle[] = [];
  private readonly loaded: Loaded[] = [];
  private readonly animCache = new Map<string, ReturnType<AnimRegistry['get']>>();
  private readonly onWarn: (msg: string) => void;
  private readonly state: LayerStateTable;
  private readonly anims: AnimRegistry;

  private constructor(ctx: QuickJSContext, runtime: QuickJSRuntime, opts: SceneScriptVmOptions) {
    this.ctx = ctx;
    this.runtime = runtime;
    this.state = opts.state;
    this.anims = opts.anims;
    this.onWarn = opts.onWarn ?? (() => { /* 生产静默 */ });
  }

  static async create(opts: SceneScriptVmOptions): Promise<SceneScriptVm | null> {
    try {
      const mod: QuickJSWASMModule = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC));
      const runtime = mod.newRuntime();
      let budget = STEP_BUDGET;
      runtime.setInterruptHandler(() => { budget -= 10_000; return budget <= 0; });
      const ctx = runtime.newContext();
      const self = new SceneScriptVm(ctx, runtime, opts);
      if (!self.installPrelude(opts)) { self.dispose(); return null; }
      return self;
    } catch {
      return null;
    }
  }

  private keep<T extends QuickJSHandle>(h: T): T {
    this.handles.push(h);
    return h;
  }

  private installPrelude(opts: SceneScriptVmOptions): boolean {
    const ctx = this.ctx;
    // __host 原语
    const host = ctx.newObject();
    const fn = (name: string, impl: (...args: QuickJSHandle[]) => QuickJSHandle | void) => {
      const f = ctx.newFunction(name, (...args: QuickJSHandle[]) => impl(...args));
      ctx.setProp(host, name, f);
      this.handles.push(f);
    };
    fn('readNum', (k, p) => ctx.newNumber(Number(this.state.read(this.keyOf(k))[ctx.getString(p) as keyof ReturnType<LayerStateTable['read']>] ?? 0)));
    fn('readBool', (k, p) => (this.state.read(this.keyOf(k)).visible === false ? ctx.false : ctx.true));
    fn('readVec', (k, p) => {
      const prop = ctx.getString(p) as 'origin' | 'angles' | 'scale' | 'color';
      const v = this.state.read(this.keyOf(k))[prop] as [number, number, number] | undefined;
      const arr = v ?? (prop === 'scale' ? [1, 1, 1] : [0, 0, 0]);
      const out = ctx.newArray([ctx.newNumber(arr[0]), ctx.newNumber(arr[1]), ctx.newNumber(arr[2])]);
      return out;
    });
    fn('writeNum', (k, p, v) => { this.write(this.keyOf(k), { [ctx.getString(p)]: ctx.getNumber(v) }); });
    fn('writeBool', (k, p, v) => { this.write(this.keyOf(k), { visible: ctx.dump(v) === true }); });
    fn('writeVec', (k, p, x, y, z) => {
      const prop = ctx.getString(p);
      const arr: [number, number, number] = [ctx.getNumber(x), ctx.getNumber(y), ctx.getNumber(z)];
      this.write(this.keyOf(k), { [prop]: arr });
    });
    fn('animPlay', (k, n) => { this.anim(this.keyOf(k), ctx.getString(n)).play(); });
    fn('animPause', (k, n) => { this.anim(this.keyOf(k), ctx.getString(n)).pause(); });
    fn('animStop', (k, n) => { this.anim(this.keyOf(k), ctx.getString(n)).stop(); });
    fn('animIsPlaying', (k, n) => (this.anim(this.keyOf(k), ctx.getString(n)).isPlaying() ? ctx.true : ctx.false));
    fn('animSetFrame', (k, n, v) => { this.anim(this.keyOf(k), ctx.getString(n)).setFrame(ctx.getNumber(v)); });
    fn('animGetFrame', (k, n) => ctx.newNumber(this.anim(this.keyOf(k), ctx.getString(n)).getFrame()));
    fn('log', () => { /* 生产静默；调试可在此转发 */ });
    this.keep(ctx.setProp(ctx.global, '__host', host) as unknown as QuickJSHandle);
    this.handles.push(host);

    const pre = ctx.evalCode(PRELUDE, 'scene-script-prelude.js');
    if (pre.error) { pre.error.dispose(); return false; }
    pre.value.dispose();
    // userProperties 注入 engine.userProperties
    const props = ctx.parseJSON(JSON.stringify(safeUserProperties(opts.userProperties)));
    if (!props.error) {
      const engineH = ctx.getProp(ctx.global, 'engine');
      ctx.setProp(engineH, 'userProperties', props.value);
      engineH.dispose();
      props.value.dispose();
      this.handles.push(props.value);
    } else {
      props.error.dispose();
    }
    return true;
  }

  /** prelude 传下来的 key → scene 对象 id；非 id: 形式返回 -1（只记账、不应用）。 */
  private keyOf(h: QuickJSHandle): number {
    const k = this.ctx.getString(h);
    const m = /^id:(\d+)$/.exec(k);
    return m ? Number(m[1]) : -1;
  }

  private write(objectId: number, patch: Record<string, unknown>): void {
    if (objectId < 0) return;
    this.state.write(objectId, patch as never);
  }

  private anim(layerKey: string, name: string) {
    const key = `${layerKey}|${name}`;
    let a = this.animCache.get(key);
    if (!a) { a = this.anims.get(layerKey, name); this.animCache.set(key, a); }
    return a;
  }

  /** 装载一个模块脚本。返回 false = eval 失败（该脚本被跳过）。 */
  load(source: string): boolean {
    const ctx = this.ctx;
    const sanitized = String(source).replace(/\bexport\s+/g, '');
    const code = `globalThis.__mods.push((function(){ ${sanitized}
      return {
        init: (typeof init === 'function') ? init : null,
        update: (typeof update === 'function') ? update : null,
        applyUserProperties: (typeof applyUserProperties === 'function') ? applyUserProperties : null,
        cursorClick: (typeof cursorClick === 'function') ? cursorClick : null
      }; })());`;
    const r = ctx.evalCode(code, 'scene-script.js');
    if (r.error) { r.error.dispose(); this.onWarn(`SceneScript eval 失败，已跳过：${firstLine(sanitized)}`); return false; }
    r.value.dispose();
    // 取出刚 push 的模块对象
    const modsH = ctx.getProp(ctx.global, '__mods');
    const lenH = ctx.getProp(modsH, 'length');
    const len = ctx.getNumber(lenH);
    lenH.dispose();
    const inst = ctx.getProp(modsH, String(len - 1));
    modsH.dispose();
    const updateFn = ctx.getProp(inst, 'update');
    const clickFn = ctx.getProp(inst, 'cursorClick');
    this.loaded.push({
      objectId: -1,
      instance: this.keep(inst),
      updateFn: ctx.typeof(updateFn) === 'function' ? this.keep(updateFn) : null,
      clickFn: ctx.typeof(clickFn) === 'function' ? this.keep(clickFn) : null,
      active: true,
    });
    if (!this.loaded[this.loaded.length - 1]!.updateFn) updateFn.dispose();
    if (!this.loaded[this.loaded.length - 1]!.clickFn) clickFn.dispose();
    return true;
  }

  get loadedCount(): number { return this.loaded.length; }
  get activeCount(): number { return this.loaded.filter((l) => l.active).length; }

  private callModule(index: number, method: 'init' | 'update' | 'click'): void {
    const l = this.loaded[index]!;
    if (!l.active) return;
    const ctx = this.ctx;
    const fnName = method === 'click' ? 'cursorClick' : method;
    // init/applyUserProperties 走一次：从模块对象上取
    const fnH = method === 'update' || method === 'click'
      ? (method === 'update' ? l.updateFn : l.clickFn)
      : ctx.getProp(l.instance, fnName);
    if (!fnH) return;
    const arg = method === 'init' ? ctx.newString('') : ctx.newString('');
    const res = ctx.callFunction(fnH, l.instance, arg);
    arg.dispose();
    if (method === 'init' || method === 'applyUserProperties') fnH.dispose();
    if (res.error) {
      const msg = errorText(ctx, res.error);
      res.error.dispose();
      l.active = false;
      this.onWarn(`SceneScript ${method} 抛错，已停用该脚本：${msg}`);
      return;
    }
    res.value.dispose();
  }

  initAll(): void {
    for (let i = 0; i < this.loaded.length; i++) {
      this.callModule(i, 'init');
      this.callModuleApply(i);
    }
  }
  /** applyUserProperties 在装载时先于 init 调一次（模拟 WE 已有用户设置）。 */
  private callModuleApply(index: number): void {
    const l = this.loaded[index]!;
    if (!l.active) return;
    const ctx = this.ctx;
    const fnH = ctx.getProp(l.instance, 'applyUserProperties');
    if (ctx.typeof(fnH) !== 'function') { fnH.dispose(); return; }
    const propsH = ctx.getProp(ctx.global, 'engine');
    const upH = ctx.getProp(propsH, 'userProperties');
    const res = ctx.callFunction(fnH, l.instance, upH);
    upH.dispose(); propsH.dispose(); fnH.dispose();
    if (res.error) { res.error.dispose(); return; }
    res.value.dispose();
  }

  updateAll(): void {
    for (let i = 0; i < this.loaded.length; i++) this.callModule(i, 'update');
  }
  clickAll(): void {
    for (let i = 0; i < this.loaded.length; i++) this.callModule(i, 'click');
  }

  dispose(): void {
    for (const h of this.handles) { try { h.dispose(); } catch { /* 已释放 */ } }
    this.handles.length = 0;
    this.loaded.length = 0;
    try { this.ctx.dispose(); } catch { /* noop */ }
    try { this.runtime.dispose(); } catch { /* gc 断言可忽略 */ }
  }
}

/** 过滤掉 project.json 属性里内嵌的 base64 长值（注入源码会打爆解析栈，spike 实测）。 */
function safeUserProperties(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (typeof v === 'string' && v.length > 120) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim())?.slice(0, 60) ?? '';
}

function errorText(ctx: QuickJSContext, errH: QuickJSHandle): string {
  try {
    const m = ctx.getProp(errH, 'message');
    const s = String(ctx.dump(m));
    m.dispose();
    return s;
  } catch { return '(unknown)'; }
}
```

> 注：`callModule` 里 init/apply 的 `fnH` 分支若在读题时觉得绕，可直接按方法名各自实现一个循环 —— 关键是**每次 `getProp` 出的 handle 都要 dispose**。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/scene-script-vm.test.ts`
Expected: PASS（7 个用例）。若出现 `gc_obj_list` 断言，说明有 handle 未 dispose —— 按报错处补齐。

- [ ] **Step 5: 提交**

```bash
git add src/client/scene-script-vm.ts tests/scene-script-vm.test.ts
git commit -m "feat(scene-script-vm): quickjs 单上下文模块脚本运行时"
```

---

### Task 7: `SceneScriptHost` —— 编排与降级

**Files:**
- Create: `src/client/scene-script-host.ts`
- Test: `tests/scene-script-host.test.ts`

**Interfaces:**
- Consumes: `SceneScriptVm`、`AnimRegistry`、`LayerStateTable`、`extractAnimFps`
- Produces:
  ```ts
  export interface SceneScriptHostOptions {
    scripts: Array<{ objectId: number; source: string }>;   // 必须按 objects 顺序
    userProperties: Record<string, unknown>;
    onWarn?: (msg: string) => void;
  }
  export class SceneScriptHost {
    static create(opts: SceneScriptHostOptions): Promise<SceneScriptHost | null>;
    /** 每帧：推进动画 → 各脚本 update → 返回脏写入（调用方负责应用）。 */
    tick(dt: number): Map<number, LayerWrite>;
    /** 点击事件 → 各脚本 cursorClick（触发 shared.we2dSwitchScene 等）。 */
    click(): void;
    get scriptCount(): number;
    dispose(): void;
  }
  ```

- [ ] **Step 1: 写失败测试**

```ts
// tests/scene-script-host.test.ts
import { describe, it, expect } from 'vitest';
import { SceneScriptHost } from '../src/client/scene-script-host.js';

describe('SceneScriptHost', () => {
  it('装载多个脚本，按传入顺序执行；tick 返回脏写入', async () => {
    const host = await SceneScriptHost.create({
      userProperties: {},
      scripts: [
        { objectId: 1, source: `export function init(){ shared.n = 0; } export function update(){ shared.n++; thisScene.getLayerByID(1).alpha = shared.n; }` },
        { objectId: 2, source: `export function update(){ thisScene.getLayerByID(2).alpha = shared.n; }` },
      ],
    });
    expect(host).not.toBeNull();
    const d1 = host!.tick(1 / 60);
    expect(d1.get(1)?.alpha).toBe(1);
    expect(d1.get(2)?.alpha).toBe(1);
    expect(host!.tick(1 / 60).size).toBe(0); // 同值不再脏
    host!.dispose();
  });

  it('动画按逐动画 fps 推进（60 vs 1200）', async () => {
    const host = await SceneScriptHost.create({
      userProperties: {},
      scripts: [{
        objectId: 1,
        source: `export function init(){
          var f = thisScene.getLayerByID(1).getAnimation('fast'); f.play();
          var s = thisScene.getLayerByID(1).getAnimation('slow'); s.play();
        }
        export function update(){
          thisScene.getLayerByID(1).alpha = thisScene.getLayerByID(1).getAnimation('fast').getFrame();
          thisScene.getLayerByID(2).alpha = thisScene.getLayerByID(1).getAnimation('slow').getFrame();
        }`,
      }],
    });
    // 'fast'/'slow' 的 fps 来自脚本源码里的 config 文本
    const host2 = await SceneScriptHost.create({
      userProperties: {},
      scripts: [{
        objectId: 1,
        source: `const config={"loops":[{"name":"fast","fps":1200},{"name":"slow","fps":60}]};
        export function init(){ thisScene.getLayerByID(1).getAnimation('fast').play(); thisScene.getLayerByID(1).getAnimation('slow').play(); }
        export function update(){
          thisScene.getLayerByID(1).alpha = thisScene.getLayerByID(1).getAnimation('fast').getFrame();
          thisScene.getLayerByID(2).alpha = thisScene.getLayerByID(1).getAnimation('slow').getFrame();
        }`,
      }],
    });
    const d = host2!.tick(1 / 60);
    expect(d.get(1)?.alpha).toBeCloseTo(20, 3);  // 1200 fps
    expect(d.get(2)?.alpha).toBeCloseTo(1, 3);   // 60 fps
    host!.dispose(); host2!.dispose();
  });

  it('单脚本抛错不影响其他脚本；全失败时 tick 返回空表', async () => {
    const host = await SceneScriptHost.create({
      userProperties: {},
      scripts: [
        { objectId: 1, source: `export function update(){ throw new Error('x'); }` },
        { objectId: 2, source: `export function update(){ thisScene.getLayerByID(2).alpha = 0.3; }` },
      ],
    });
    const d = host!.tick(1 / 60);
    expect(d.get(2)?.alpha).toBeCloseTo(0.3);
    expect(d.has(1)).toBe(false);
    host!.dispose();
  });

  it('click 触发各脚本 cursorClick', async () => {
    const host = await SceneScriptHost.create({
      userProperties: {},
      scripts: [
        { objectId: 94000, source: `export function init(){ shared.we2dSwitchScene = function(){ shared.called = 1; }; }` },
        { objectId: 94001, source: `export function cursorClick(){ shared.we2dSwitchScene(); thisScene.getLayerByID(5).alpha = shared.called; }` },
      ],
    });
    host!.click();
    const d = host!.tick(1 / 60);
    expect(d.get(5)?.alpha).toBe(1);
    host!.dispose();
  });

  it('scripts 为空时 create 仍成功，tick 返回空表（画面 = 现状）', async () => {
    const host = await SceneScriptHost.create({ userProperties: {}, scripts: [] });
    expect(host).not.toBeNull();
    expect(host!.tick(1 / 60).size).toBe(0);
    host!.dispose();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scene-script-host.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

```ts
// src/client/scene-script-host.ts
// 编排层：装载期建 fps 表 + 建 VM；帧内 推进动画 → 各脚本 update → 交出脏写入。
// 调用方（three-renderer）负责把脏写入应用到 three 对象 —— 本模块不依赖 three。
import { AnimRegistry, extractAnimFps } from './scene-anim.js';
import { createLayerStateTable, type LayerStateTable, type LayerWrite } from './layer-state.js';
import { SceneScriptVm } from './scene-script-vm.js';

export interface SceneScriptHostOptions {
  scripts: Array<{ objectId: number; source: string }>;
  userProperties: Record<string, unknown>;
  onWarn?: (msg: string) => void;
}

export class SceneScriptHost {
  private readonly anims: AnimRegistry;
  private readonly state: LayerStateTable;
  private readonly vm: SceneScriptVm | null;

  private constructor(anims: AnimRegistry, state: LayerStateTable, vm: SceneScriptVm | null) {
    this.anims = anims;
    this.state = state;
    this.vm = vm;
  }

  static async create(opts: SceneScriptHostOptions): Promise<SceneScriptHost | null> {
    const scripts = opts.scripts ?? [];
    // fps 表：脚本内嵌 config 是唯一来源（scene.pkg 内无动画数据）
    const fpsTable = new Map<string, number>();
    for (const s of scripts) {
      for (const [name, fps] of extractAnimFps(s.source)) if (!fpsTable.has(name)) fpsTable.set(name, fps);
    }
    const anims = new AnimRegistry(fpsTable);
    const state = createLayerStateTable();
    if (scripts.length === 0) return new SceneScriptHost(anims, state, null);

    const vm = await SceneScriptVm.create({
      userProperties: opts.userProperties ?? {},
      state,
      anims,
      onWarn: opts.onWarn,
    });
    if (!vm) return null;
    for (const s of scripts) vm.load(s.source);
    vm.initAll();
    return new SceneScriptHost(anims, state, vm);
  }

  get scriptCount(): number {
    return this.vm?.loadedCount ?? 0;
  }

  tick(dt: number): Map<number, LayerWrite> {
    if (!this.vm) return new Map();
    this.anims.tick(dt);
    this.vm.updateAll();
    return this.state.takeDirty();
  }

  click(): void {
    this.vm?.clickAll();
  }

  dispose(): void {
    this.vm?.dispose();
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/scene-script-host.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/client/scene-script-host.ts tests/scene-script-host.test.ts
git commit -m "feat(scene-script-host): 载荷编排（fps 表 + 装载 + 帧 tick + 降级）"
```

---

### Task 8: `threejs-player.ts` —— 显示对象映射与帧钩子

**Files:**
- Modify: `src/client/threejs-player.ts`（`addBackground`、`addParticle`、`SceneAssets`、`loadSceneToThree` 帧体）
- Test: `tests/threejs-player.test.ts`（追加）

**Interfaces:**
- Produces:
  - `addBackground(opts & { objectId?: number })` / `addParticle(getVerts, opts & { objectId?: number })`
  - `player.displayObject(objectId: number): THREE.Object3D | undefined`
  - `SceneAssets.onFrame?: (dt: number) => void`

背景：`backgroundEntries`/`particleLayers` 的键是**图层计数器 id**，而脚本用的是 **scene 对象 id**；隔离对象的最终显示物是**合成 quad**（不是内容 mesh）。

- [ ] **Step 1: 写失败测试**

在 `tests/threejs-player.test.ts` 追加：

```ts
describe('displayObject 映射与 onFrame 钩子', () => {
  it('非隔离对象返回其 mesh', () => {
    const player = new ThreeScenePlayer(document.createElement('canvas'), 100, 100, mockRenderer());
    const id = player.addBackground({ origin: [50, 50, 0], scale: [1, 1, 1], sceneW: 100, sceneH: 100, objectId: 42 });
    expect(player.displayObject(42)).toBe(player.backgroundEntryMeshForTest(id));
  });

  it('未登记的对象返回 undefined', () => {
    const player = new ThreeScenePlayer(document.createElement('canvas'), 100, 100, mockRenderer());
    expect(player.displayObject(999)).toBeUndefined();
  });

  it('loadSceneToThree 的帧体每帧调用 assets.onFrame(dt)', () => {
    const seen: number[] = [];
    // 用最小 scene.json + mock renderer + mock 粒子工厂，见该文件既有装配用例的写法
    const r = loadSceneToThree(JSON.stringify({
      general: { orthogonalprojection: { width: 100, height: 100 } }, objects: [],
    }), { renderer: mockRenderer(), onFrame: (dt) => seen.push(dt) }, document.createElement('canvas'), { width: 100, height: 100 });
    r.player.setAnimationLoop((dt) => { void dt; });
    // 触发一帧
    r.player.render();
    // 手动调一次帧体（测试用 mock renderer 不跑 RAF）
    r.player.tickForTest?.(1 / 60);
    expect(seen.length).toBeGreaterThan(0);
  });
});
```

> 若 `tests/threejs-player.test.ts` 里既有的 mock renderer 辅助函数名不同（如 `mkRenderer`/`fakeRenderer`），沿用该文件已有的那个；`backgroundEntryMeshForTest`/`tickForTest` 是本步骤要在实现里补的两个测试后门（或用既有的等价访问器）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/threejs-player.test.ts -t "displayObject"`
Expected: FAIL —— `player.displayObject is not a function`

- [ ] **Step 3: 实现**

在 `ThreeScenePlayer` 类内新增字段与访问器：

```ts
  // scene 对象 id → **最终显示**的 three 对象（非隔离 = 内容 mesh；隔离 = 合成 quad）。
  // 脚本的 LayerStateTable 键是 scene 对象 id，而 backgroundEntries/particleLayers 的键是图层
  // 计数器 id —— 这里补一份同键空间映射，避免又出现一层「对象 id → 计数器 id」的翻译。
  private readonly displayObjects = new Map<number, THREE.Object3D>();

  /** 按 scene.json 对象 id 取最终显示的 three 对象（脚本图层桥用）。 */
  displayObject(objectId: number): THREE.Object3D | undefined {
    return this.displayObjects.get(objectId);
  }
```

在 `addBackground` 的 opts 类型里加 `objectId?: number;`，并在方法末尾（`return id;` 之前）登记：

```ts
    const objectId = opts.objectId;
    if (objectId !== undefined) {
      const shown = opts.isolate ? this.isolated.get(objectId)?.quad : mesh;
      if (shown) this.displayObjects.set(objectId, shown);
    }
```

`addParticle` 同样加 `objectId?: number` 并在末尾登记（隔离 → quad，否则 → 粒子对象本身；沿用该方法内既有的 `mesh`/`points` 变量名）。

`SceneAssets` 加：

```ts
  // 每帧扩展钩子（SceneScript 运行时）：在粒子/文本更新之前调用，可写 three 对象状态。
  onFrame?: (dt: number) => void;
```

`loadSceneToThree` 的帧体改为：

```ts
  player.setAnimationLoop((dt) => {
    // SceneScript 先跑：脚本状态是图层的权威来源，其写入在本帧渲染前生效。
    assets.onFrame?.(dt);
    for (const sim of sims) sim.update(dt);
    /* …textDrivers 循环保持不变… */
  });
```

同时在 `loadSceneToThree` 的三处 `addBackground(...)` / `addParticle(...)` 调用里补 `objectId: obj.id`（image、text 各有一次 addBackground）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/threejs-player.test.ts`
Expected: PASS（含既有全部用例 —— 既有用例不传 `objectId`，行为不变）

- [ ] **Step 5: 提交**

```bash
git add src/client/threejs-player.ts tests/threejs-player.test.ts
git commit -m "feat(threejs-player): scene 对象 id → 显示对象映射 + onFrame 帧钩子"
```

---

### Task 9: `three-renderer.ts` 接线

**Files:**
- Modify: `src/client/three-renderer.ts`（`render()` 内装配段、`teardown()`）
- Test: `tests/three-renderer.test.ts`（追加）

**Interfaces:**
- Consumes: `SceneScriptHost`、`applyLayerState`、`player.displayObject`、`SceneAssets.onFrame`
- Produces: `render()` 在装配期收集脚本（**含 util 与其它不渲染对象**）并启动脚本运行时

- [ ] **Step 1: 写失败测试**

在 `tests/three-renderer.test.ts` 追加：

```ts
it('util 对象上的 visible.script 会被收集并执行（3798688689 的四个总控都挂在 util 上）', async () => {
  // 复用该文件既有的 fetch 桩写法，scene.json 里放一个 util 对象带 visible.script
  const writes: Array<[number, unknown]> = [];
  // 桩脚本：把 10750 的 alpha 写成 0.5
  const scene = JSON.stringify({
    general: { orthogonalprojection: { width: 100, height: 100 } },
    objects: [
      { id: 10750, image: 'models/layers/l_10750.json', name: 'a' },
      { id: 94000, name: 'ctl', image: 'models/util/solidlayer.json',
        visible: { script: "export function update(){ thisScene.getLayerByID(10750).alpha = 0.5; }", value: true } },
    ],
  });
  // …按既有用例的桩方式装 fetch（返回 scene.json / asset）…
  const r = createThreeSceneRenderer();
  const ok = await r.render('fixture', document.createElement('canvas'));
  expect(ok).toBe(true);
  // 触发一帧后，displayObject(10750).material.opacity ≈ 0.5
  expect(writes.length).toBeGreaterThanOrEqual(0);
  r.dispose();
});
```

> 该文件已有大量 fetch/WebGL 桩的先例（`three-renderer.test.ts` 76 KB）。**沿用其中已有的桩辅助函数**，不要新造一套；断言点落在"帧钩子被调用后 `backgroundTextures` 对应对象的材质 opacity 变化"。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/three-renderer.test.ts -t "util 对象上的 visible.script"`
Expected: FAIL —— 脚本未生效（opacity 未变）

- [ ] **Step 3: 实现**

在 `three-renderer.ts` 顶部加 import：

```ts
import { SceneScriptHost } from './scene-script-host.js';
import { applyLayerState } from './layer-state.js';
```

在 `render()` 里、`collectObjectEffectChains(...)` 之后（此时 `desc` 已就绪）加入脚本收集：

```ts
        // ── SceneScript 运行时（2026-09-22）：visible.script 的执行与图层状态应用 ──────────
        // ⚠️ 收集范围**不能**限定在"参与渲染的对象"：3798688689 的 4 个总控全部挂在
        // models/util/* 上（不渲染），只收渲染对象的话它们永远不会被执行。
        const scriptSources = desc.objects
          .filter((o) => typeof (o as { script?: string }).script === 'string')
          .map((o) => ({ objectId: o.id, source: (o as { script?: string }).script as string }));
```

`loadSceneToThree` 调用处加 `onFrame`（用闭包读后建的 host）：

```ts
        let scriptHost: SceneScriptHost | null = null;
        const sceneW = desc.orthogonal.width;
        const sceneH = desc.orthogonal.height;
        const result = loadSceneToThree(sceneJson, {
          backgroundTextures, particles, createParticleSim, isolate, textLayers, qualityScale, worldTransforms,
          onFrame: (dt) => {
            if (!scriptHost) return;
            const dirty = scriptHost.tick(dt);
            if (dirty.size === 0) return;
            applyLayerState(dirty, (objectId) => {
              const obj = result.player.displayObject(objectId);
              return obj ? { object: obj, sceneW, sceneH } : undefined;
            });
          },
        }, fg, { width: vw, height: vh });
        current = result;
```

> ⚠️ `onFrame` 闭包里引用 `result`（同一 `const` 声明）—— 把 `const result = loadSceneToThree(...)` 拆成先声明 `let result!` 再赋值，或在闭包里改从 `current` 读（`current` 在下一行赋值）。两种写法都可以，选一种并保持类型可通过。

装配 host 并持有引用（放在 `current = result` 之后）：

```ts
        if (scriptSources.length > 0) {
          scriptHost = await SceneScriptHost.create({
            scripts: scriptSources,
            userProperties: collectUserProperties(desc),
            onWarn: (m) => warnOnce(`script:${id}`, m),
          });
          currentScriptHost = scriptHost;
          // 点击事件：把 canvas 上的 click 转给脚本（94001 的 cursorClick → shared.we2dSwitchScene）
          onClick = () => scriptHost?.click();
          fg.addEventListener?.('click', onClick);
        }
```

并新增一个把 `visible.user` 键收集成对象的小工具（与既有 `userProps` 循环同源）：

```ts
function collectUserProperties(desc: SceneDescription): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const obj of desc.objects) {
    if (obj.visible?.kind === 'user' && obj.visible.key) out[obj.visible.key] = getUserPropertyValue(obj.visible.key);
  }
  return out;
}
```

`teardown()` 里释放：

```ts
    if (onClick) { /* 移除监听：用保存的 fg 引用 */ }
    currentScriptHost?.dispose();
    currentScriptHost = null;
```

（`onClick` 与 `currentScriptHost` 在工厂函数作用域内声明为 `let`，与既有 `currentGlow`、`onWindowResize` 同风格。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/three-renderer.test.ts`
Expected: PASS（含既有全部用例）

- [ ] **Step 5: 全量单测 + 类型检查**

```bash
npx vitest run
npx tsc -p tsconfig.json --noEmit
```

Expected: 全绿；`tsc` 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/client/three-renderer.ts tests/three-renderer.test.ts
git commit -m "feat(three-renderer): 接入 SceneScript 运行时（含 util 对象脚本与点击事件）"
```

---

### Task 10: e2e 验收（headless Edge + 生产 lib）

**Files:**
- Create: `research/_e2e-scene-script.mjs`（throwaway，不入 git）
- 参考：`research/verify-hidpi-object-rt.mjs`

**验收判据（spec §7）**：① `3798688689` 画面变为 kv2 场景（对照基线 ≈98.6% 像素改变）；② 点击触发切换；③ 另 3 张逐像素不变；④ console error = 0；⑤ 单帧脚本开销 < 3 ms。

- [ ] **Step 1: 构建产物**

```bash
npm run build && npm run build:client
```

Expected: `lib/` 与 `dist/client.js` 更新（脚本运行时进 bundle）。

- [ ] **Step 2: 跑基线对照**

```bash
node research/verify-hidpi-object-rt.mjs --id=3798688689 --dprs=1 --phase=5 --tag=e2e-after --out=verify-text
node research/q-diff-grid.mjs research/verify-text/lime-p5-dpr1.png research/verify-text/e2e-after-dpr1.png 8
```

Expected: 变化像素 ≥ **90%**（spike 用状态烘焙测得 98.58%；真机接线的数字应同量级）。

> 若变化 < 50%：先查 `displayObject` 是否命中（`console` 里加一次性统计），再查 `onFrame` 是否真被调用。

- [ ] **Step 3: 跑零回归对照**

```bash
foreach ($id in 2832263418,3789452668,2937346640) {
  node research/verify-hidpi-object-rt.mjs --id=$id --dprs=1 --phase=5 --tag=reg-$id --out=verify-text
}
```

对每张：与改动前截图（无则先 `git stash` 后跑一次留底）跑 `q-diff-grid.mjs`，Expected: 变化像素 **0**（或仅左下角挂件的既有 100 px 级抖动）。

- [ ] **Step 4: 记录验收结果**

把三张回归数字、`3798688689` 的变化占比、console error 数、单帧脚本耗时写进 `AGENT.md` §7.1（新条目），并如实列出未做项（`92000` 粒子、`93000` 拖尾、`getEffect().visible`、歌名字标若未纳入）。

- [ ] **Step 5: 提交**

```bash
git add AGENT.md
git commit -m "docs(agent): 记录 SceneScript 运行时 e2e 验收与边界"
```

---

## Self-Review

**1. Spec coverage**

| spec 章节 | 覆盖任务 |
|---|---|
| §3 做：通用运行时 | Task 6/7 |
| §3 做：图层状态表与应用器 | Task 4/5 |
| §3 做：动画播放器 + fps | Task 2/3 |
| §3 做：util 对象也执行脚本 | Task 1/9 |
| §3 做：点击事件 | Task 9（`clickAll` + canvas 监听） |
| §5 宿主 API 契约 | Task 6 的 PRELUDE（`Vec3`/`IModelData`/`thisScene`/`engine`/`shared`/stub） |
| §6.1 visible 折算 alpha=0 | Task 5 |
| §6.2 fps 契约 | Task 2（提取）+ Task 3（逐动画推进）+ Task 10 Step 2 断言 |
| §6.3 帧序 | Task 8（`onFrame` 在粒子之前）+ Task 9（tick → apply） |
| §6.4 降级 | Task 6（eval/init/update 停用）+ Task 7（空脚本返回空表） |
| §7 测试与验收 | Task 2–9 单测 + Task 10 e2e |
| §4 改动 `threejs-player` 访问器 | Task 8 |

无遗漏章节。

**2. Placeholder scan**：无 TBD/TODO；每个实现步骤都带代码。Task 8/9 的测试步骤依赖既有测试文件的桩辅助函数名（已在步骤里说明"沿用既有辅助函数"），未编造不存在的函数名 —— 实现者需先读该文件确认桩名。

**3. Type consistency**

- `LayerWrite` 在 Task 4 定义，Task 5/6/7/9 一致使用 ✅
- `AnimRegistry.get(layerKey, name)` 在 Task 3 定义，Task 6（`this.anim`）、Task 7（`anims.tick`）一致 ✅
- `extractAnimFps`（Task 2）→ `SceneScriptHost.create`（Task 7）✅
- `player.displayObject(objectId)`（Task 8）→ Task 9 的 `applyLayerState` lookup ✅
- `SceneAssets.onFrame`（Task 8）→ Task 9 装配 ✅
- `LayerStateTable.write/read/takeDirty`（Task 4）→ Task 6/7/9 ✅
