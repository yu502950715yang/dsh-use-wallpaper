# 动态网格（createModelData / createLayer / applyData）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `3798688689` 的 `92000` 粒子与 `93000` 拖尾真正画出来 —— 脚本用 `createModelData` + 每帧 `applyData` 产出的顶点缓冲，经 three 渲染成画面上的粒子。

**Architecture:** 脚本侧只透传句柄，宿主侧一个 `DynamicMeshRegistry` 管 `BufferGeometry`/`Mesh` 生命周期与每帧顶点写入；材质由 `materials/**/*.json` 解析成 three 材质（纹理复用 `tex-loader`）。

**Tech Stack:** TypeScript、vitest（node + jsdom）、three.js r170、quickjs-emscripten 0.32

**Spec:** `docs/superpowers/specs/2026-09-22-dynamic-mesh-design.md`

## Global Constraints

- **不改一期模块的既有语义**（`scene-script-host.ts` / `layer-state.ts` / `scene-anim.ts` 的对外行为不变）；本计划只**扩展** prelude 与装配
- 顶点格式**本期只支持** `[POSITION, UV, COLOR]`（= `[0,1,2]`，stride 9 floats/顶点）；其他组合 → 跳过该 mesh 并 warn 一次
- 每帧上传**只标记实际使用区间**：`attr.addUpdateRange(0, count × 分量数)` + `needsUpdate`，并 `setDrawRange(0, count*6)`
- 材质缺失/纹理缺失 → **白图兜底材质**（不整场失败）；上传异常 → 丢该帧，不抛进帧循环
- 无动态网格的壁纸（25/29 张）**完全不进新代码路径**（零回归）
- 提交信息：标题一行 + 正文最多 3 行；注释一行说清"是什么/为什么"

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/client/dynamic-mesh.ts`（新增） | 顶点布局解析 + `count` 推断（纯逻辑）+ `DynamicMeshRegistry`（three 网格生命周期与每帧写入） |
| `src/client/mesh-shaders.ts`（新增） | 内置 shader 源：`we2d_particle_mesh`（颜色层，pkg 内缺）与 `we2d_particle_alpha` 的兜底副本 |
| `src/client/mesh-material.ts`（新增） | `materials/**/*.json` → three 材质（blending/side/depth + shader 选择 + 纹理槽） |
| `src/client/scene-script-vm.ts`（改） | prelude 的 `createModelData`/`createLayer`/`engine.registerAsset` 换成真实桥；新增 5 个宿主原语 |
| `src/client/three-renderer.ts`（改） | 装配期建 registry、解析材质资产、teardown 释放 |
| `tests/dynamic-mesh.test.ts`、`tests/mesh-material.test.ts`（新增） | 单测 |

---

### Task 1: 顶点布局解析与 `count` 推断（纯逻辑）

**Files:**
- Create: `src/client/dynamic-mesh.ts`
- Test: `tests/dynamic-mesh.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface VertexLayout { stride: number; position: number; uv: number; color: number; }
  export function resolveVertexLayout(vertexFormat: number[]): VertexLayout | null;
  export function inferQuadCount(buffer: Float32Array, layout: VertexLayout, capacity: number): number;
  ```

- [ ] **Step 1: 写失败测试**

```ts
// tests/dynamic-mesh.test.ts
import { describe, it, expect } from 'vitest';
import { resolveVertexLayout, inferQuadCount } from '../src/client/dynamic-mesh.js';

const LAYOUT = { stride: 9, position: 0, uv: 3, color: 5 };

describe('resolveVertexLayout', () => {
  it('支持 [POSITION(0), UV(1), COLOR(2)] → stride 9', () => {
    expect(resolveVertexLayout([0, 1, 2])).toEqual(LAYOUT);
  });

  it('其他组合一律不支持（本期只做实测到的那一种）', () => {
    expect(resolveVertexLayout([0, 1])).toBeNull();       // 缺 COLOR
    expect(resolveVertexLayout([1, 0, 2])).toBeNull();    // 顺序不同
    expect(resolveVertexLayout([0, 1, 2, 3])).toBeNull(); // 多 NORMAL
    expect(resolveVertexLayout([])).toBeNull();
  });
});

describe('inferQuadCount', () => {
  it('全空 → 0', () => {
    expect(inferQuadCount(new Float32Array(36), LAYOUT, 1)).toBe(0);
  });

  it('只有第 0 个 quad 有 position → 1', () => {
    const buf = new Float32Array(2 * 36);
    buf[0] = 10; buf[1] = 20; // quad0 顶点0 的 position.xy
    expect(inferQuadCount(buf, LAYOUT, 2)).toBe(1);
  });

  it('第 1 个 quad 也有 → 2（取最后一个非空下标 +1）', () => {
    const buf = new Float32Array(3 * 36);
    buf[0] = 10; buf[1] = 20;
    buf[36] = 5; buf[37] = 6;
    expect(inferQuadCount(buf, LAYOUT, 3)).toBe(2);
  });

  it('只有 y 非零也算非空（x=0 的粒子不能被漏掉）', () => {
    const buf = new Float32Array(36);
    buf[1] = -7; // position.y 非零
    expect(inferQuadCount(buf, LAYOUT, 1)).toBe(1);
  });

  it('capacity 超过 buffer 容量时按 buffer 截断（防御）', () => {
    const buf = new Float32Array(36); // 只够 1 个 quad
    buf[0] = 1;
    expect(inferQuadCount(buf, LAYOUT, 100)).toBe(1);
  });

  it('4 个顶点都要检查（只有最后一个顶点非零也算）', () => {
    const buf = new Float32Array(36);
    buf[3 * 9] = 9; // quad0 的第 4 个顶点 position.x
    expect(inferQuadCount(buf, LAYOUT, 1)).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/dynamic-mesh.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

```ts
// src/client/dynamic-mesh.ts
// 动态网格（SceneScript 的 createModelData / createLayer / applyData）宿主侧实现。
//
// 数据形状（3798688689 实测）：vertexFormat = [POSITION, UV, COLOR]，stride = 9 floats/顶点
// （pos 3 + uv 2 + color 4），每 quad 4 顶点 = 36 floats、6 索引。

/** 顶点布局：各 attribute 在 stride 内的 float 偏移。 */
export interface VertexLayout {
  stride: number;
  position: number;
  uv: number;
  color: number;
}

/** 本期只支持实测到的那一种组合；其余返回 null（调用方跳过该 mesh 并 warn 一次）。 */
export function resolveVertexLayout(vertexFormat: number[]): VertexLayout | null {
  if (!Array.isArray(vertexFormat) || vertexFormat.length !== 3) return null;
  if (vertexFormat[0] !== 0 || vertexFormat[1] !== 1 || vertexFormat[2] !== 2) return null;
  return { stride: 9, position: 0, uv: 3, color: 5 };
}

/**
 * 推断实际使用的 quad 数。
 *
 * 脚本不告知 count，但它用 `vertices.fill(0, count*36, previous*36)` 清尾、且 quad() 不会产出
 * 「四个顶点 position 全 0」的退化 quad ⇒ 取最后一个非空 quad 的下标 + 1。
 * ⚠️ 这是本模块唯一的启发式：若将来遇到不清尾的脚本（复用旧数据），要改为按 applyData 的
 * 参数长度推断。
 */
export function inferQuadCount(buffer: Float32Array, layout: VertexLayout, capacity: number): number {
  const quadFloats = layout.stride * 4;
  if (!(buffer instanceof Float32Array) || buffer.length < quadFloats) return 0;
  const cap = Math.min(capacity, Math.floor(buffer.length / quadFloats));
  let last = -1;
  for (let i = 0; i < cap; i++) {
    const base = i * quadFloats;
    for (let v = 0; v < 4; v++) {
      const o = base + v * layout.stride + layout.position;
      if (buffer[o] !== 0 || buffer[o + 1] !== 0) { last = i; break; }
    }
  }
  return last + 1;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/dynamic-mesh.test.ts`
Expected: PASS（9 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/client/dynamic-mesh.ts tests/dynamic-mesh.test.ts
git commit -m "feat(dynamic-mesh): 顶点布局解析与 quad 数推断"
```

---

### Task 2: `DynamicMeshRegistry` —— 网格生命周期与每帧写入

**Files:**
- Modify: `src/client/dynamic-mesh.ts`
- Test: `tests/dynamic-mesh.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `resolveVertexLayout` / `inferQuadCount`
- Produces:
  ```ts
  export interface DynamicModelSpec { capacity: number; vertexFormat: number[]; materialPath: string | null; }
  export interface DynamicMeshRegistryOptions {
    parent: THREE.Object3D;
    materialFor: (materialPath: string | null) => THREE.Material;
    onWarn?: (msg: string) => void;
  }
  export class DynamicMeshRegistry {
    constructor(opts: DynamicMeshRegistryOptions);
    createModel(spec: DynamicModelSpec): number | null;   // null = 格式不支持
    createLayer(modelId: number, name: string): number;
    applyData(modelId: number, buffer: Float32Array): void;
    setVisible(layerId: number, visible: boolean): void;
    isVisible(layerId: number): boolean;
    geometryOf(modelId: number): THREE.BufferGeometry | null;
    meshOf(layerId: number): THREE.Mesh | null;
    readonly modelCount: number;
    readonly unsupportedCount: number;   // 被跳过的 mesh 数（诊断）
    dispose(): void;
  }
  ```

- [ ] **Step 1: 写失败测试**

```ts
import * as THREE from 'three';
import { DynamicMeshRegistry } from '../src/client/dynamic-mesh.js';

function mk() {
  const parent = new THREE.Scene();
  const warns: string[] = [];
  const registry = new DynamicMeshRegistry({
    parent, materialFor: () => new THREE.MeshBasicMaterial(), onWarn: (m) => warns.push(m),
  });
  return { parent, registry, warns };
}

describe('DynamicMeshRegistry', () => {
  it('createModel 建 BufferGeometry：position/uv/color(4) + 索引，容量按 quad 预算', () => {
    const { registry } = mk();
    const id = registry.createModel({ capacity: 3, vertexFormat: [0, 1, 2], materialPath: 'm.json' });
    expect(id).toBe(0);
    const g = registry.geometryOf(id!)!;
    expect(g.getAttribute('position').count).toBe(12); // 3 quad × 4 顶点
    expect(g.getAttribute('position').itemSize).toBe(3);
    expect(g.getAttribute('uv').itemSize).toBe(2);
    expect(g.getAttribute('color').itemSize).toBe(4);
    expect(g.getIndex()!.count).toBe(18);              // 3 quad × 6 索引
    expect(Array.from(g.getIndex()!.array.slice(0, 6))).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('不支持的 vertexFormat → 返回 null 并 warn 一次', () => {
    const { registry, warns } = mk();
    expect(registry.createModel({ capacity: 1, vertexFormat: [0, 1], materialPath: null })).toBeNull();
    expect(registry.createModel({ capacity: 1, vertexFormat: [0, 1], materialPath: null })).toBeNull();
    expect(registry.unsupportedCount).toBe(2);
    expect(warns.length).toBe(1); // 同因只 warn 一次
  });

  it('createLayer 建 Mesh 挂到 parent，renderOrder 在背景之上', () => {
    const { registry, parent } = mk();
    const m = registry.createModel({ capacity: 1, vertexFormat: [0, 1, 2], materialPath: null })!;
    const l = registry.createLayer(m, '发射器 1');
    const mesh = registry.meshOf(l)!;
    expect(parent.children).toContain(mesh);
    expect(mesh.renderOrder).toBe(1);
    expect(mesh.name).toBe('发射器 1');
  });

  it('applyData 写入顶点：position/uv/color 各自 updateRange，drawRange 只画使用的 quad', () => {
    const { registry } = mk();
    const m = registry.createModel({ capacity: 2, vertexFormat: [0, 1, 2], materialPath: null })!;
    const l = registry.createLayer(m, 'x');
    const buf = new Float32Array(2 * 36);
    buf[0] = 1; buf[1] = 2; buf[5] = 0.5; buf[6] = 0.25; buf[7] = 0.125; buf[8] = 0.75;
    registry.applyData(m, buf);
    const g = registry.geometryOf(m)!;
    expect(g.getAttribute('position').array[0]).toBeCloseTo(1);
    expect(g.getAttribute('uv').array[0]).toBeCloseTo(0.5);   // uv 从 stride 偏移 3 起
    expect(g.getAttribute('color').array[0]).toBeCloseTo(0.25); // color 从偏移 5 起
    expect(g.drawRange.count).toBe(6);                          // 只用 1 个 quad
    expect(g.getAttribute('position').updateRanges.length).toBeGreaterThan(0);
    expect(registry.isVisible(l)).toBe(true);
  });

  it('全空顶点 → drawRange.count = 0（不画，也不报错）', () => {
    const { registry } = mk();
    const m = registry.createModel({ capacity: 1, vertexFormat: [0, 1, 2], materialPath: null })!;
    registry.applyData(m, new Float32Array(36));
    expect(registry.geometryOf(m)!.drawRange.count).toBe(0);
  });

  it('setVisible / isVisible', () => {
    const { registry } = mk();
    const m = registry.createModel({ capacity: 1, vertexFormat: [0, 1, 2], materialPath: null })!;
    const l = registry.createLayer(m, 'x');
    registry.setVisible(l, false);
    expect(registry.meshOf(l)!.visible).toBe(false);
    expect(registry.isVisible(l)).toBe(false);
  });

  it('applyData 的 buffer 短于容量时不越界（防御）', () => {
    const { registry } = mk();
    const m = registry.createModel({ capacity: 5, vertexFormat: [0, 1, 2], materialPath: null })!;
    registry.applyData(m, new Float32Array(36));
    expect(registry.geometryOf(m)!.drawRange.count).toBe(6);
  });

  it('dispose 释放几何体，重复调用安全', () => {
    const { registry, parent } = mk();
    const m = registry.createModel({ capacity: 1, vertexFormat: [0, 1, 2], materialPath: null })!;
    registry.createLayer(m, 'x');
    expect(() => registry.dispose()).not.toThrow();
    expect(() => registry.dispose()).not.toThrow();
    expect(parent.children.length).toBe(0);
  });

  it('未知 modelId 的 applyData/createLayer 安全返回', () => {
    const { registry } = mk();
    expect(() => registry.applyData(99, new Float32Array(36))).not.toThrow();
    expect(() => registry.createLayer(99, 'x')).not.toThrow();
    expect(registry.geometryOf(99)).toBeNull();
    expect(registry.meshOf(99)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/dynamic-mesh.test.ts -t "DynamicMeshRegistry"`
Expected: FAIL —— `DynamicMeshRegistry is not a constructor`

- [ ] **Step 3: 实现**

在 `src/client/dynamic-mesh.ts` 顶部加 `import * as THREE from 'three';`，并追加：

```ts
export interface DynamicModelSpec {
  capacity: number;
  vertexFormat: number[];
  materialPath: string | null;
}

export interface DynamicMeshRegistryOptions {
  parent: THREE.Object3D;
  materialFor: (materialPath: string | null) => THREE.Material;
  onWarn?: (msg: string) => void;
}

interface ModelRecord {
  capacity: number;
  layout: VertexLayout;
  geometry: THREE.BufferGeometry;
  materialPath: string | null;
  count: number;
}

interface LayerRecord {
  modelId: number;
  mesh: THREE.Mesh;
  visible: boolean;
}

/** 运行时网格注册表：脚本 createModelData → 几何体；createLayer → Mesh；applyData → 每帧写顶点。 */
export class DynamicMeshRegistry {
  private readonly parent: THREE.Object3D;
  private readonly materialFor: (materialPath: string | null) => THREE.Material;
  private readonly onWarn: (msg: string) => void;
  private readonly models = new Map<number, ModelRecord>();
  private readonly layers = new Map<number, LayerRecord>();
  private nextModelId = 0;
  private nextLayerId = 0;
  private unsupported = 0;
  private warnedUnsupported = false;

  constructor(opts: DynamicMeshRegistryOptions) {
    this.parent = opts.parent;
    this.materialFor = opts.materialFor;
    this.onWarn = opts.onWarn ?? ((): void => { /* 生产静默 */ });
  }

  get modelCount(): number { return this.models.size; }
  get unsupportedCount(): number { return this.unsupported; }

  createModel(spec: DynamicModelSpec): number | null {
    const layout = resolveVertexLayout(spec.vertexFormat);
    if (!layout) {
      this.unsupported++;
      if (!this.warnedUnsupported) {
        this.warnedUnsupported = true;
        this.onWarn(`动态网格：不支持的 vertexFormat ${JSON.stringify(spec.vertexFormat)}，已跳过该 mesh`);
      }
      return null;
    }
    const capacity = Math.max(0, Math.floor(spec.capacity));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 4 * 3), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(capacity * 4 * 2), 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(capacity * 4 * 4), 4));
    // 每 quad 两个三角形；capacity×4 顶点上限 65535 以内用 Uint16（实测 capacity=500 ⇒ 2000）
    const IndexArray = capacity * 4 > 65535 ? Uint32Array : Uint16Array;
    const index = new IndexArray(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      const a = i * 4, j = i * 6;
      index[j] = a; index[j + 1] = a + 1; index[j + 2] = a + 2;
      index[j + 3] = a; index[j + 4] = a + 2; index[j + 5] = a + 3;
    }
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.setDrawRange(0, 0);
    const id = this.nextModelId++;
    this.models.set(id, { capacity, layout, geometry, materialPath: spec.materialPath, count: 0 });
    return id;
  }

  createLayer(modelId: number, name: string): number {
    const model = this.models.get(modelId);
    if (!model) return -1;
    const mesh = new THREE.Mesh(model.geometry, this.materialFor(model.materialPath));
    mesh.name = name;
    // 1 = 与既有粒子层同层（背景 renderOrder 0 之下先画）
    mesh.renderOrder = 1;
    mesh.frustumCulled = false; // 顶点每帧变、且可能在相机外，交给 drawRange 控制
    if (model.layout) { /* 布局已校验 */ }
    this.parent.add(mesh);
    const id = this.nextLayerId++;
    this.layers.set(id, { modelId, mesh, visible: true });
    return id;
  }

  applyData(modelId: number, buffer: Float32Array): void {
    const model = this.models.get(modelId);
    if (!model) return;
    if (!(buffer instanceof Float32Array)) return;
    const { layout, capacity, geometry } = model;
    const quadFloats = layout.stride * 4;
    const count = Math.min(inferQuadCount(buffer, layout, capacity), capacity);
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const uvAttr = geometry.getAttribute('uv') as THREE.BufferAttribute;
    const colAttr = geometry.getAttribute('color') as THREE.BufferAttribute;
    const usable = Math.min(count, Math.floor(buffer.length / quadFloats));
    // 逐 quad 解包（stride 插值）：源数据交错存放，目标 attribute 是分离的平面数组
    for (let i = 0; i < usable; i++) {
      for (let v = 0; v < 4; v++) {
        const src = i * quadFloats + v * layout.stride;
        const dst = i * 4 + v;
        (posAttr.array as Float32Array)[dst * 3] = buffer[src + layout.position];
        (posAttr.array as Float32Array)[dst * 3 + 1] = buffer[src + layout.position + 1];
        (posAttr.array as Float32Array)[dst * 3 + 2] = buffer[src + layout.position + 2];
        (uvAttr.array as Float32Array)[dst * 2] = buffer[src + layout.uv];
        (uvAttr.array as Float32Array)[dst * 2 + 1] = buffer[src + layout.uv + 1];
        (colAttr.array as Float32Array)[dst * 4] = buffer[src + layout.color];
        (colAttr.array as Float32Array)[dst * 4 + 1] = buffer[src + layout.color + 1];
        (colAttr.array as Float32Array)[dst * 4 + 2] = buffer[src + layout.color + 2];
        (colAttr.array as Float32Array)[dst * 4 + 3] = buffer[src + layout.color + 3];
      }
    }
    if (usable > 0) {
      // 只标记实际使用区间 → GPU 上传 114 KB/帧 而不是全量 1.79 MB
      markRange(posAttr, usable * 4 * 3);
      markRange(uvAttr, usable * 4 * 2);
      markRange(colAttr, usable * 4 * 4);
    }
    geometry.setDrawRange(0, usable * 6);
    model.count = usable;
  }

  setVisible(layerId: number, visible: boolean): void {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    layer.visible = visible;
    layer.mesh.visible = visible;
  }

  isVisible(layerId: number): boolean {
    return this.layers.get(layerId)?.visible ?? false;
  }

  geometryOf(modelId: number): THREE.BufferGeometry | null {
    return this.models.get(modelId)?.geometry ?? null;
  }

  meshOf(layerId: number): THREE.Mesh | null {
    return this.layers.get(layerId)?.mesh ?? null;
  }

  dispose(): void {
    for (const layer of this.layers.values()) {
      this.parent.remove(layer.mesh);
      // 材质由 materialFor 提供，可能被多个 mesh 共享 → 这里只释放几何体
    }
    this.layers.clear();
    for (const model of this.models.values()) model.geometry.dispose();
    this.models.clear();
  }
}

/** 清空并写入 updateRange（three r170：updateRanges 数组 + clearUpdateRanges）。 */
function markRange(attr: THREE.BufferAttribute, count: number): void {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count);
  attr.needsUpdate = true;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/dynamic-mesh.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add src/client/dynamic-mesh.ts tests/dynamic-mesh.test.ts
git commit -m "feat(dynamic-mesh): 网格注册表（几何体/Mesh/每帧部分上传）"
```

---

### Task 3: 材质解析与内置 shader

**Files:**
- Create: `src/client/mesh-shaders.ts`、`src/client/mesh-material.ts`
- Test: `tests/mesh-material.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // mesh-shaders.ts
  export const PARTICLE_MESH_VERT: string;
  export const PARTICLE_MESH_FRAG: string;   // 颜色层（pkg 内缺 we2d_particle_mesh → 内置）
  export const PARTICLE_ALPHA_FRAG: string;  // alpha 层兜底（pkg 内有同名源时优先用 pkg）

  // mesh-material.ts
  export interface MeshMaterialSpec {
    shader: string; texturePath: string | null;
    blending: 'additive' | 'normal'; side: THREE.Side;
    depthTest: boolean; depthWrite: boolean;
  }
  export function parseMeshMaterial(jsonText: string): MeshMaterialSpec | null;
  export function createMeshMaterial(spec: MeshMaterialSpec | null, texture: THREE.Texture | null): THREE.Material;
  ```

- [ ] **Step 1: 写失败测试**

```ts
// tests/mesh-material.test.ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { parseMeshMaterial, createMeshMaterial } from '../src/client/mesh-material.js';

describe('parseMeshMaterial', () => {
  it('解析 additive 粒子材质（3798688689 的真实形状）', () => {
    const spec = parseMeshMaterial(JSON.stringify({
      passes: [{ shader: 'we2d_particle_mesh', textures: ['source/a_4b7892c81030'], blending: 'additive',
                 cullmode: 0, depthtest: false, depthwrite: false }],
    }))!;
    expect(spec.shader).toBe('we2d_particle_mesh');
    expect(spec.texturePath).toBe('source/a_4b7892c81030');
    expect(spec.blending).toBe('additive');
    expect(spec.depthTest).toBe(false);
    expect(spec.depthWrite).toBe(false);
  });

  it('translucent → normal 混合；缺字段用安全默认', () => {
    const spec = parseMeshMaterial(JSON.stringify({ passes: [{ shader: 'x', textures: [], blending: 'translucent' }] }))!;
    expect(spec.blending).toBe('normal');
    expect(spec.texturePath).toBeNull();
    expect(spec.depthTest).toBe(true);
  });

  it('空/畸形 json → null（调用方回退白图兜底材质）', () => {
    expect(parseMeshMaterial('')).toBeNull();
    expect(parseMeshMaterial('{}')).toBeNull();
    expect(parseMeshMaterial('not json')).toBeNull();
    expect(parseMeshMaterial(JSON.stringify({ passes: [] }))).toBeNull();
  });
});

describe('createMeshMaterial', () => {
  it('additive → AdditiveBlending，且 depthWrite=false', () => {
    const spec = parseMeshMaterial(JSON.stringify({ passes: [{ shader: 'we2d_particle_mesh', textures: ['t'], blending: 'additive', depthwrite: false }] }))!;
    const mat = createMeshMaterial(spec, null) as THREE.ShaderMaterial;
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(mat.depthWrite).toBe(false);
    expect(mat.uniforms.g_Texture0).toBeTruthy();
  });

  it('spec 为 null → 白图兜底材质（不抛）', () => {
    const mat = createMeshMaterial(null, null);
    expect(mat).toBeInstanceOf(THREE.ShaderMaterial);
    expect((mat as THREE.ShaderMaterial).blending).toBe(THREE.AdditiveBlending);
  });

  it('alpha 层 shader 名走 alpha frag；其余走颜色层', () => {
    const alpha = createMeshMaterial({ shader: 'we2d_particle_alpha', texturePath: null, blending: 'additive', side: THREE.DoubleSide, depthTest: true, depthWrite: false }, null) as THREE.ShaderMaterial;
    const color = createMeshMaterial({ shader: 'we2d_particle_mesh', texturePath: null, blending: 'additive', side: THREE.DoubleSide, depthTest: true, depthWrite: false }, null) as THREE.ShaderMaterial;
    expect(alpha.fragmentShader).not.toBe(color.fragmentShader);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/mesh-material.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

`src/client/mesh-shaders.ts`：

```ts
// 动态网格的内置 shader 源。
// 顶点 shader 与 `shaders/we2d_particle_alpha.vert`（pkg 内，344 B）语义一致：标准 MVP + 直传。
// 片元 shader 的 alpha 层照抄 pkg 版；**颜色层 `we2d_particle_mesh` 在 pkg 内不存在**，
// 按 alpha 层推断实现（spec §6.2「已知偏差」）：纹理 rgb × 顶点 rgb，alpha = 纹理 a × 顶点 a。

export const PARTICLE_MESH_VERT = `
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
attribute vec4 a_Color;
uniform mat4 g_ModelViewProjectionMatrix;
varying vec2 v_TexCoord;
varying vec4 v_Color;
void main() {
  v_TexCoord = a_TexCoord;
  v_Color = a_Color;
  gl_Position = g_ModelViewProjectionMatrix * vec4(a_Position, 1.0);
}
`;

export const PARTICLE_MESH_FRAG = `
uniform sampler2D g_Texture0;
uniform vec4 g_Texture0Resolution;
varying vec2 v_TexCoord;
varying vec4 v_Color;
void main() {
  vec2 mapped = g_Texture0Resolution.zw / g_Texture0Resolution.xy;
  vec4 c = texture2D(g_Texture0, v_TexCoord * mapped);
  gl_FragColor = vec4(c.rgb * v_Color.rgb, c.a * v_Color.a);
}
`;

/** alpha 层（pkg 内有源时优先用 pkg，这里作兜底）。 */
export const PARTICLE_ALPHA_FRAG = `
uniform sampler2D g_Texture0;
uniform vec4 g_Texture0Resolution;
varying vec2 v_TexCoord;
varying vec4 v_Color;
void main() {
  vec2 mapped = g_Texture0Resolution.zw / g_Texture0Resolution.xy;
  vec4 c = texture2D(g_Texture0, v_TexCoord * mapped);
  gl_FragColor = vec4(1.0, 1.0, 1.0, c.a * v_Color.a);
}
`;
```

`src/client/mesh-material.ts`：

```ts
// materials/**/*.json → three 材质。WE 材质结构：{ passes: [{ shader, textures[], blending,
// cullmode, depthtest, depthwrite, constantshadervalues }] }。
import * as THREE from 'three';
import { PARTICLE_MESH_VERT, PARTICLE_MESH_FRAG, PARTICLE_ALPHA_FRAG } from './mesh-shaders.js';

export interface MeshMaterialSpec {
  shader: string;
  texturePath: string | null;
  blending: 'additive' | 'normal';
  side: THREE.Side;
  depthTest: boolean;
  depthWrite: boolean;
}

export function parseMeshMaterial(jsonText: string): MeshMaterialSpec | null {
  if (typeof jsonText !== 'string' || !jsonText) return null;
  let json: unknown;
  try { json = JSON.parse(jsonText); } catch { return null; }
  const passes = (json as { passes?: unknown }).passes;
  if (!Array.isArray(passes) || passes.length === 0) return null;
  const p = passes[0] as Record<string, unknown>;
  const textures = Array.isArray(p.textures) ? p.textures : [];
  const first = textures.length > 0 ? textures[0] : null;
  return {
    shader: typeof p.shader === 'string' ? p.shader : '',
    texturePath: typeof first === 'string' && first ? first : null,
    blending: /^(add|additive)$/i.test(String(p.blending ?? '')) ? 'additive' : 'normal',
    // WE 的 cullmode 取值语义未定；粒子/拖尾 quad 需要双面可见，统一 DoubleSide 最安全
    side: THREE.DoubleSide,
    depthTest: p.depthtest !== false,
    depthWrite: p.depthwrite === true,
  };
}

/** 建 three 材质。spec 为 null（材质缺失/解析失败）→ 白图兜底（不整场失败）。 */
export function createMeshMaterial(spec: MeshMaterialSpec | null, texture: THREE.Texture | null): THREE.Material {
  const s: MeshMaterialSpec = spec ?? {
    shader: 'we2d_particle_mesh', texturePath: null, blending: 'additive',
    side: THREE.DoubleSide, depthTest: true, depthWrite: false,
  };
  const isAlpha = /alpha/i.test(s.shader);
  const uniforms: Record<string, THREE.IUniform> = {
    g_Texture0: { value: texture ?? createWhiteTexture() },
    g_Texture0Resolution: { value: new THREE.Vector4(texture ? 1 : 1, texture ? 1 : 1, 0, 0) },
  };
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: PARTICLE_MESH_VERT,
    fragmentShader: isAlpha ? PARTICLE_ALPHA_FRAG : PARTICLE_MESH_FRAG,
    transparent: true,
    depthTest: s.depthTest,
    depthWrite: s.depthWrite,
    side: s.side,
    blending: s.blending === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

let whiteTex: THREE.Texture | null = null;
function createWhiteTexture(): THREE.Texture {
  if (whiteTex) return whiteTex;
  const data = new Uint8Array([255, 255, 255, 255]);
  whiteTex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  whiteTex.needsUpdate = true;
  return whiteTex;
}
```

> 注：`g_Texture0Resolution` 的 uv 修正需要纹理的真实打包尺寸 —— 一期 `tex-loader` 已解析 `TEXV0005` 的元数据，实施时把 `(w, h, padW, padH)` 传进来即可；本任务先按「无 padding」写，`mapped` 退化为 `(1,1)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/mesh-material.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/mesh-shaders.ts src/client/mesh-material.ts tests/mesh-material.test.ts
git commit -m "feat(mesh-material): 材质解析 + 动态网格 shader（颜色层为推断实现）"
```

---

### Task 4: prelude 接线（`createModelData` / `createLayer` / `registerAsset`）

**Files:**
- Modify: `src/client/scene-script-vm.ts`（prelude + `define()` 宿主原语）
- Test: `tests/scene-script-vm.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 的 `DynamicMeshRegistry`
- Produces: prelude 里 `thisScene.createModelData` / `thisScene.createLayer` / `engine.registerAsset` 变成真实桥；`SceneScriptVmOptions` 新增 `dynamicMesh?: DynamicMeshRegistry` 与 `onAsset?: (path: string) => void`

- [ ] **Step 1: 写失败测试**

```ts
import { DynamicMeshRegistry } from '../src/client/dynamic-mesh.js';
import * as THREE from 'three';

it('脚本 createModelData/createLayer/applyData 落到 DynamicMeshRegistry', async () => {
  const parent = new THREE.Scene();
  const assets: string[] = [];
  const registry = new DynamicMeshRegistry({ parent, materialFor: () => new THREE.MeshBasicMaterial() });
  const { state, anims, userProps } = setup();
  const vm = await SceneScriptVm.create({
    userProperties: userProps, state, anims, dynamicMesh: registry, onAsset: (p) => assets.push(p),
  });
  vm!.load(`export function init(){
    var mat = engine.registerAsset('materials/particles/emitter_00.json', true);
    var verts = new Float32Array(2 * 36);
    verts[0] = 100; verts[1] = 50; verts[5] = 1; verts[6] = 1; verts[7] = 1; verts[8] = 1;
    var model = thisScene.createModelData({ boundingBoxMins: new Vec3(-1,-1,-1), boundingBoxMaxs: new Vec3(1,1,1),
      shapes: [{ vertexBuffer: verts, indexBuffer: new Uint16Array(12),
                 vertexFormat: [IModelData.POSITION, IModelData.UV, IModelData.COLOR], material: mat, isVertexBufferDynamic: true }] });
    var layer = thisScene.createLayer({ model: model, name: '测试层', origin: new Vec3(0,0,0), perspective: false });
    layer.visible = true;
    model.applyData({ vertexBuffer: verts });
  }`);
  vm!.initAll();
  expect(assets).toEqual(['materials/particles/emitter_00.json']);
  expect(registry.modelCount).toBe(1);
  const g = registry.geometryOf(0)!;
  expect(g.getAttribute('position').array[0]).toBeCloseTo(100);
  expect(g.drawRange.count).toBe(6);
  vm!.dispose();
});

it('未注入 dynamicMesh 时 createModelData 仍不抛错（旧调用方/其他壁纸零影响）', async () => {
  const { state, anims, userProps } = setup();
  const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims });
  vm!.load(`export function init(){
    var m = thisScene.createModelData({ shapes: [{ vertexBuffer: new Float32Array(36), vertexFormat: [0,1,2] }] });
    var l = thisScene.createLayer({ model: m, name: 'x' });
    l.visible = false;
    m.applyData({ vertexBuffer: new Float32Array(36) });
  }`);
  expect(() => { vm!.initAll(); vm!.updateAll(); }).not.toThrow();
  vm!.dispose();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scene-script-vm.test.ts -t "DynamicMeshRegistry"`
Expected: FAIL —— `createModelData` 仍是 stub（`modelCount` 为 0）

- [ ] **Step 3: 实现**

`SceneScriptVmOptions` 加两个字段：

```ts
  /** 动态网格注册表（createModelData/createLayer/applyData 的真实落点）。缺省 = stub 行为。 */
  dynamicMesh?: DynamicMeshRegistry;
  /** engine.registerAsset 的回调（装载期用它解析材质资产）。 */
  onAsset?: (materialPath: string) => void;
```

构造函数保存它们，并在 `installPrelude` 的 `define(...)` 段新增原语：

```ts
    // ── 动态网格原语（一期 stub → 真实桥）──────────────────────────────────────────
    const mesh = opts.dynamicMesh;
    define('registerAsset', (pH) => { opts.onAsset?.(ctx.getString(pH)); });
    define('createModel', (specH) => {
      if (!mesh) return ctx.newNumber(-1);
      const spec = ctx.dump(specH) as { capacity?: number; vertexFormat?: number[]; materialPath?: string | null } | null;
      const id = mesh.createModel({
        capacity: Number(spec?.capacity ?? 0),
        vertexFormat: Array.isArray(spec?.vertexFormat) ? spec!.vertexFormat! : [],
        materialPath: typeof spec?.materialPath === 'string' ? spec.materialPath : null,
      });
      return ctx.newNumber(id === null ? -1 : id);
    });
    define('createLayer', (modelH, nameH) => {
      if (!mesh) return ctx.newNumber(-1);
      return ctx.newNumber(mesh.createLayer(ctx.getNumber(modelH), ctx.getString(nameH)));
    });
    define('applyMeshData', (modelH, bufH) => {
      if (!mesh) return;
      const ab = ctx.getArrayBuffer(bufH);
      if (ab.error) { ab.error.dispose(); return; }
      try {
        const bytes = ab.value;
        mesh.applyData(ctx.getNumber(modelH), new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4)));
      } finally {
        ab.value.dispose();
      }
    });
    define('layerVisible', (idH) => (mesh && mesh.isVisible(ctx.getNumber(idH)) ? ctx.true : ctx.false));
    define('setLayerVisible', (idH, vH) => { mesh?.setVisible(ctx.getNumber(idH), ctx.dump(vH) === true); });
```

prelude 里把三个 stub 换成真实桥：

```js
// engine
  registerAsset: function (p) { __host.registerAsset(String(p)); return { __assetPath: String(p) }; },

// thisScene
  createModelData: function (o) {
    var s = (o && o.shapes && o.shapes[0]) || {};
    var vb = s.vertexBuffer;
    var capacity = vb ? Math.floor(vb.length / 9) : 0;
    var mat = (s.material && s.material.__assetPath) ? s.material.__assetPath : null;
    var id = __host.createModel({ capacity: capacity, vertexFormat: s.vertexFormat, materialPath: mat });
    return {
      __modelId: id,
      applyData: function (d) {
        var v = (d && d.vertexBuffer) ? d.vertexBuffer : vb;
        if (v && v.buffer) __host.applyMeshData(id, v.buffer);
      }
    };
  },
  createLayer: function (o) {
    var mid = (o && o.model && o.model.__modelId !== undefined) ? o.model.__modelId : -1;
    var lid = __host.createLayer(mid, String((o && o.name) || 'anon'));
    return __mkRuntimeLayer(lid);
  },
```

并新增 `__mkRuntimeLayer`（可在 `__wrap` 兜底上建，带 `visible` 访问器）：

```js
var __rtLayerCache = {};
function __mkRuntimeLayer(id) {
  if (__rtLayerCache[id]) return __rtLayerCache[id];
  var o = {
    __layerId: id,
    alpha: 1, baseAlpha: 1, opacity: 1,
    get visible() { return __host.layerVisible(id); },
    set visible(v) { __host.setLayerVisible(id, !!v); },
    get shown() { return __host.layerVisible(id); },
    set shown(v) { __host.setLayerVisible(id, !!v); },
    getAnimation: function (n) { return __mkAnim('rtlayer:' + id, String(n)); },
    getEffect: function () { return { visible: true, setMaterialProperty: __noop, getMaterialProperty: function () { return 0; } }; },
    getModelData: function () { return __mkDummy('model'); },
    setMaterialProperty: __noop,
    getMaterialProperty: function () { return 0; },
    setParent: __noop,
    setVisible: function (v) { __host.setLayerVisible(id, !!v); return v; }
  };
  __rtLayerCache[id] = __wrap(o, 'rtlayer(' + id + ')');
  return __rtLayerCache[id];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/scene-script-vm.test.ts tests/scene-script-host.test.ts`
Expected: PASS（含既有全部用例 —— 未注入 `dynamicMesh` 时行为不变）

- [ ] **Step 5: 提交**

```bash
git add src/client/scene-script-vm.ts tests/scene-script-vm.test.ts
git commit -m "feat(scene-script-vm): createModelData/createLayer/applyData 接真实动态网格"
```

---

### Task 5: 装配与释放（`three-renderer`）

**Files:**
- Modify: `src/client/three-renderer.ts`
- Test: `tests/three-renderer.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2/3/4
- Produces: 装配期建 `DynamicMeshRegistry`（挂 `player` 的场景）、材质资产随脚本装载期解析、`teardown` 释放

- [ ] **Step 1: 写失败测试**

```ts
it('脚本用 createModelData 时装配出运行时网格，且 dispose 后清空', async () => {
  // 沿用该文件既有的 fetch/WebGL 桩；scene.json 放一个带动态网格代码的 visible.script
  // 断言：render() 之后 player 场景里出现 renderOrder=1 的 Mesh；r.dispose() 后场景 children 不含它
});
```

> 该文件已有 76 KB 的桩体系（`loadSceneToThree` mock、`createThreeSceneRenderer({loadWasm, getTextScriptRuntime})`）。**沿用既有辅助函数**，不要新造。若装配路径难直接断言，退化为「断言 `loadSceneToThree` 收到的 `assets.onFrame` 在调用后没有抛错 + console 无 warn」，但必须覆盖 dispose 后无残留。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/three-renderer.test.ts -t "运行时网格"`
Expected: FAIL

- [ ] **Step 3: 实现**

在 `render()` 装配段（`currentScriptHost = await SceneScriptHost.create({...})` 之前）加：

```ts
        // ── 动态网格（2026-09-22）：脚本 createModelData/createLayer/applyData 的真实落点 ──
        // 材质资产在装载期解析（脚本 registerAsset 时记录路径 → 这里按路径读 material json + .tex）。
        let meshRegistry: DynamicMeshRegistry | null = null;
        if (scriptSources.length > 0) {
          const materialTexts = new Map<string, string>();
          meshRegistry = null; // 由 onAsset 回调填充 materialTexts，装配后再建（纹理加载是 async）
        }
```

装配顺序（关键：`materialFor` 需要已解析的材质）：

1. 先建一个**同步可用**的 registry，`materialFor(path)` 先返回兜底材质，并在后台异步把真实材质替换进 registry 的材质缓存 —— **一期不做异步替换**，改为：`onAsset` 收集路径 → 批量 `loadFile` + `parseMeshMaterial` + `loadTexTexture` → 建 `materialFor` 闭包 → 建 registry。
2. `SceneScriptHost.create({ ..., dynamicMesh: meshRegistry, onAsset: (p) => materialPaths.add(p) })`

具体代码：

```ts
        // 收集脚本声明的材质资产路径（engine.registerAsset），装载期一次性解析
        const materialPaths = new Set<string>();
        // 先建 registry（材质可后置：materialFor 闭包读材质表）
        const materialTable = new Map<string, THREE.Material>();
        const fallbackMaterial = createMeshMaterial(null, null);
        const registry = new DynamicMeshRegistry({
          parent: result.player.scene,
          materialFor: (p) => (p ? materialTable.get(p) ?? fallbackMaterial : fallbackMaterial),
          onWarn: (m) => warnOnce(`mesh:${id}`, m),
        });
        meshRegistry = registry;
        currentMeshRegistry = registry;
        // 解析路径 → 材质（在 host 创建前完成，保证首帧就有正确材质）
        for (const p of materialPaths) {
          const raw = await loadFile(p.endsWith('.json') ? p : `${p}.json`);
          if (!raw) continue;
          const spec = parseMeshMaterial(new TextDecoder().decode(raw));
          if (!spec) continue;
          let tex: THREE.Texture | null = null;
          if (spec.texturePath) {
            const texRaw = await loadFile(`materials/${spec.texturePath}.tex`);
            if (texRaw) tex = (await loadTexTexture(URL.createObjectURL(new Blob([texRaw])))) ?? null;
          }
          materialTable.set(p, createMeshMaterial(spec, tex));
        }
```

> ⚠️ 上面 `materialPaths` 在 registry 建立**之后**才被 host 填充 ⇒ 解析循环要放在 `SceneScriptHost.create(...)` **之后**、且首帧渲染前完成；若来不及，首帧用兜底材质、次帧起换真实材质（可接受，spec §6.4 的降级语义）。实施时二选一，并在代码里写明选择。

`teardown()` 加：

```ts
    currentMeshRegistry?.dispose();
    currentMeshRegistry = null;
```

（`currentMeshRegistry` 与 `currentScriptHost` 同处声明为 `let`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/three-renderer.test.ts tests/threejs-player.test.ts`
Expected: PASS（含既有全部用例）

- [ ] **Step 5: 全量相关测试 + 类型检查**

```bash
npx vitest run tests/dynamic-mesh.test.ts tests/mesh-material.test.ts tests/scene-script-vm.test.ts tests/scene-script-host.test.ts tests/three-renderer.test.ts tests/threejs-player.test.ts tests/scene-json.test.ts
npx tsc -p tsconfig.json --noEmit
```

- [ ] **Step 6: 提交**

```bash
git add src/client/three-renderer.ts tests/three-renderer.test.ts
git commit -m "feat(three-renderer): 装配动态网格与材质资产解析"
```

---

### Task 6: e2e 验收

**Files:**
- Modify: `AGENT.md`（§7.1 第 11 条补记）
- 参考：`research/verify-hidpi-object-rt.mjs`

- [ ] **Step 1: 构建**

```bash
npm run build && npm run build:client
```

- [ ] **Step 2: 粒子是否出现**

```bash
node research/verify-hidpi-object-rt.mjs --id=3798688689 --dprs=1 --phase=5 --tag=mesh-after --out=verify-text
node research/q-diff-grid.mjs research/verify-text/lime-p5-dpr1.png research/verify-text/mesh-after-dpr1.png 8
```

Expected：画面出现粒子（与一期基线对照差异非零）；**落点与 spike 的 ASCII 分布一致**（`research/_spike-s2-render.mjs` 的图）。不设固定百分比。

- [ ] **Step 3: 零回归（A/B）**

```bash
node research/verify-hidpi-object-rt.mjs --id=3743126786 --dprs=1 --phase=5 --tag=mesh-reg-after --out=verify-text
git checkout HEAD~1 -- lib
node research/verify-hidpi-object-rt.mjs --id=3743126786 --dprs=1 --phase=5 --tag=mesh-reg-before --out=verify-text
git checkout HEAD -- lib
node research/q-diff-grid.mjs research/verify-text/mesh-reg-before-dpr1.png research/verify-text/mesh-reg-after-dpr1.png 8
```

Expected：**变化 0 px**（沿用一期方法；一期该项实测 0.00%）

- [ ] **Step 4: 性能**

在 soak 脚本（`research/_q-script-soak.mjs`）里接入 registry，跑 3000 帧记录每帧耗时。

Expected：**动态网格新增开销 < 2 ms/帧**；叠加一期 4.13 ms 后总帧时间 < 7 ms。

- [ ] **Step 5: 记录验收并提交**

把三组数字（粒子出现 / 零回归 / 性能）与未做项（util 合成层、`setParent` 真实变换、`layer.color` 不应用）写进 `AGENT.md` §7.1 第 11 条。

```bash
git add AGENT.md
git commit -m "docs(agent): 记录动态网格 e2e 验收（粒子/零回归/性能）"
```

---

## Self-Review

**1. Spec coverage**

| spec 章节 | 覆盖任务 |
|---|---|
| §4 模块（dynamic-mesh / mesh-material / mesh-shaders） | Task 1/2/3 |
| §4 改动（vm prelude / player / renderer） | Task 4/5 |
| §5 接口契约（createModelData/createLayer/applyData/setParent/visible/registerAsset） | Task 4（脚本侧）+ Task 2（宿主侧） |
| §6.1 三层顶点策略 | Task 2（`markRange` + `setDrawRange`）+ Task 4（`getArrayBuffer` 拷贝） |
| §6.2 材质与 shader（含颜色层自实现） | Task 3 |
| §6.3 可见性与 draw call | Task 2（`setVisible`）+ 脚本自身 `layer.visible` |
| §6.4 生命周期与降级 | Task 2（`dispose`/未知 id 安全）+ Task 3（白图兜底）+ Task 4（未注入时 stub） |
| §7 测试与验收 | 各任务单测 + Task 6 e2e |
| §3 不做项（util 合成层 / setParent / 音频） | 未出现在任何任务中 ✓ |

无遗漏。

**2. Placeholder scan**：Task 5 的两处（装配顺序二选一、测试退化方案）都给出了**明确的两个可选做法与取舍**，不是 TBD；其余步骤都带完整代码。

**3. Type consistency**

- `VertexLayout`（Task 1）→ Task 2 的 `ModelRecord.layout` ✅
- `resolveVertexLayout` / `inferQuadCount`（Task 1）→ Task 2 使用 ✅
- `DynamicMeshRegistry` 的 `createModel/createLayer/applyData/setVisible/isVisible/geometryOf/meshOf/dispose`（Task 2）→ Task 4 宿主原语、Task 5 装配一致 ✅
- `parseMeshMaterial` / `createMeshMaterial`（Task 3）→ Task 5 使用；`MeshMaterialSpec` 字段名（`texturePath`/`blending`/`side`/`depthTest`/`depthWrite`）在测试与实现间一致 ✅
- `SceneScriptVmOptions.dynamicMesh` / `onAsset`（Task 4）→ Task 5 装配 ✅
- `createModel` 返回 `number | null`（Task 2）→ Task 4 里 `-1` 表示不支持，prelude 用 `__modelId` ✅
