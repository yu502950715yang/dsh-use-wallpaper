# wasm 场景脚本动画（SceneScript 驱动对象动起来）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 wasm 渲染路径支持对象级 `IThisPropertyObject` 动画——每个带脚本的 image 对象在每帧执行 `update(dt)`，脚本改 `this.origin`/`this.scale`/`this.image.alpha`，宿主读回并灌入 Rust 渲染器，从而让场景"动起来"。

**Architecture:** 脚本引擎放 JS 侧（quickjs-emscripten，wasm 化 QuickJS，不编进 Rust）。JS 每帧执行 `SceneScript.update(dt)` → 读回 `this.origin/scale/image.alpha` → 调 `Scene.update_image(...)` → 更新 Rust `SceneImage` 字段。关键杠杆：`render_frame` 每帧已从 `SceneImage` 字段重算 uniform，故 shader 与 `render_frame` 零改动。

**Tech Stack:** Rust/wgpu 24 + wasm-bindgen（渲染层）；quickjs-emscripten（JS 脚本引擎）；TypeScript/esbuild（client 构建）；vitest（node 环境默认 + `tests/dom/**` jsdom）。

**Spec:** `docs/superpowers/specs/2026-08-25-wasm-scenescript-animation-design.md`

## Global Constraints

- 构建顺序：改 Rust → `npm run build:wasm`（`cd wasm && wasm-pack build --target web --release --features render`）→ `npm run build:client`。dist/static 复制的是 wasm/pkg 产物，缺 pkg 产物会报错退出。
- 测试：`npm test`（vitest run）。默认环境 node；`tests/dom/**` 用 jsdom。
- MVP 只处理 **image 对象** 的脚本动画；text/particle/util 不处理。
- 读回规则：优先 `this.image.alpha`/`this.image.brightness`，兜底顶层 `this.alpha`。
- Rust `update_image`：`Option` 语义 = JS `undefined` = "保持现状"。
- 坐标：脚本 `this.origin` 与 scene.json origin 同一 WE 场景像素语义，无需坐标换算。
- 脚本错误隔离：单对象脚本抛错 → 该对象停止动画，其余不受影响。
- 无 WebGPU / quickjs 加载失败 → 整个场景走无动画路径（零回归）。

---

## File Structure

- **Create** `wasm/src/render/mod.rs` 内：`update_image(&mut self, asset_id, origin, scale, alpha, brightness)` 方法。修改 `SceneImage` 对应字段。
- **Create** `wasm/src/lib.rs` 内：`WeScene::update_image` wasm-bindgen 导出方法。
- **Create** `src/client/scene-script.ts`：`SceneScriptRuntime` 主模块（quickjs 绑定 + 纯逻辑）。
- **Modify** `src/client/wasm-renderer.ts`：对象加载循环收集脚本对象；帧循环每帧调 `update` 并灌回。
- **Tests**：`wasm/tests/render_update_test.rs`（native）；`tests/wasm-renderer.test.ts`（追加）；`tests/scene-script.test.ts`（新增，node 环境 pure-logic 部分）。

---

### Task 1: Rust `update_image` 更新 SceneImage 字段

**Files:**
- Modify: `wasm/src/render/mod.rs`（在 `set_image` 附近新增 `update_image` 方法；`SceneImage` 已有 `asset_id/origin/scale/tint_alpha/tint_brightness` 字段）
- Test: `wasm/tests/render_update_test.rs`（新建）

**Interfaces:**
- Produces: `render::Renderer::update_image(&mut self, asset_id: u32, origin: Option<[f32;3]>, scale: Option<[f32;3]>, alpha: Option<f32>, brightness: Option<f32>)`。`None` = 保持现状。按 `asset_id` 找到 `SceneImage` 更新；找不到 no-op。

- [ ] **Step 1: 写失败的单测**

```rust
// wasm/tests/render_update_test.rs
// native `cargo test`（无 render feature）只能测不依赖 wgpu 的纯逻辑。
// SceneImage 在 mod.rs 非门控区（struct 定义在 #![cfg(feature="render")] 之外），
// 但 Renderer 含 wgpu 类型，native 无 render feature 不能构造 Renderer。
// 因此本单测针对「SceneImage 字段可按 update_image 语义更新」的辅助逻辑。
//
// 实现：在 mod.rs 给 SceneImage 加一个 `apply_update(...)` 方法（不依赖 wgpu），
// 供 update_image 调用；本测试直接测 `SceneImage::apply_update`。
```

```rust
// 测试：apply_update 按传入更新，None 保持
#[test]
fn apply_update_replaces_fields() {
    let mut img = SceneImage {
        asset_id: 3,
        tex: unimplemented!(),          // 不构造 wgpu::Texture，改测另一个不含 Tex 的辅助
        // ...
    };
}
```

> **注意**：`SceneImage` 含 `wgpu::Texture`/`BindGroup`，native 无 render feature 时类型不可用。**修正方案**：把「字段应用」抽成纯函数 `apply_image_update(state: &mut ObjectState, origin, scale, alpha, brightness)`，其中 `ObjectState` 是普通结构体（只含 origin/scale/tint_alpha/tint_brightness），不依赖 wgpu。`update_image` 从 `SceneImage` 取出可变引用后调用它。测试只测纯函数。

**重写 Step 1（用纯函数，native 可测）：**

- [ ] **Step 1: 写失败的单测（纯函数 `apply_image_update`）**

```rust
// wasm/tests/render_update_test.rs
use we_scene_wasm::render::{apply_image_update, ObjectState};

#[test]
fn apply_update_replaces_origin() {
    let mut s = ObjectState { origin: [1.0, 2.0, 3.0], scale: [1.0, 1.0, 1.0], tint_alpha: None, tint_brightness: None };
    apply_image_update(&mut s, Some([9.0, 8.0, 7.0]), None, None, None);
    assert_eq!(s.origin, [9.0, 8.0, 7.0]);
    assert_eq!(s.scale, [1.0, 1.0, 1.0]); // 保持
}

#[test]
fn apply_update_none_keeps() {
    let mut s = ObjectState { origin: [1.0, 2.0, 3.0], scale: [1.0, 1.0, 1.0], tint_alpha: Some(0.5), tint_brightness: Some(2.0) };
    apply_image_update(&mut s, None, Some([2.0, 2.0, 2.0]), None, None);
    assert_eq!(s.origin, [1.0, 2.0, 3.0]);
    assert_eq!(s.scale, [2.0, 2.0, 2.0]);
    assert_eq!(s.tint_alpha, Some(0.5));
}

#[test]
fn apply_update_replaces_alpha_brightness() {
    let mut s = ObjectState { origin: [0.0, 0.0, 0.0], scale: [1.0, 1.0, 1.0], tint_alpha: None, tint_brightness: None };
    apply_image_update(&mut s, None, None, Some(0.3), Some(1.5));
    assert_eq!(s.tint_alpha, Some(0.3));
    assert_eq!(s.tint_brightness, Some(1.5));
}
```

需要 `ObjectState` 与 `apply_image_update` 在 `render` 模块 non-gated 区可被测试访问（`pub`）。

- [ ] **Step 2: 运行，确认编译失败**

Run: `cargo test --manifest-path wasm/Cargo.toml render_update`（或 `cargo test --manifest-path wasm/Cargo.toml`）
Expected: FAIL——`ObjectState`/`apply_image_update` 不存在（编译错误）。

- [ ] **Step 3: 实现 `ObjectState` + `apply_image_update`（纯函数）+ `Renderer::update_image`**

在 `wasm/src/render/mod.rs` 加（non-gated 区，`Render` 模块顶部、`SceneImage` 定义附近）：

```rust
/// 图片对象的动态状态（每帧可更新；与 wgpu 解耦，native 可测）。
/// 用于约束「update_image 一次更新应改哪些 SceneImage 字段」，便于 native 单测。
#[derive(Debug, Clone, PartialEq)]
pub struct ObjectState {
    pub origin: [f32; 3],
    pub scale: [f32; 3],
    pub tint_alpha: Option<f32>,
    pub tint_brightness: Option<f32>,
}

/// 把一次动态更新应用到对象状态（None = 保持现状）。
/// Renderer::update_image 对每个匹配的 SceneImage 做同样字段更新。
/// 拆成纯函数以便 native 测试（SceneImage 含 wgpu 类型，native 不可构造）。
pub fn apply_image_update(
    state: &mut ObjectState,
    origin: Option<[f32; 3]>,
    scale: Option<[f32; 3]>,
    alpha: Option<f32>,
    brightness: Option<f32>,
) {
    if let Some(o) = origin { state.origin = o; }
    if let Some(s) = scale { state.scale = s; }
    if let Some(a) = alpha { state.tint_alpha = Some(a); }
    if let Some(b) = brightness { state.tint_brightness = Some(b); }
}
```

在 `Renderer`（render feature 区，`set_image` 附近）加：

```rust
/// 每帧更新一个图片对象的状态（origin/scale/alpha/brightness）。
/// None = 保持现状；asset_id 找不到 → no-op（防御对象未注册/已卸载）。
/// 字段更新语义与 apply_image_update 完全一致（后者是 native 可测的纯函数版本）。
pub fn update_image(
    &mut self,
    asset_id: u32,
    origin: Option<[f32; 3]>,
    scale: Option<[f32; 3]>,
    alpha: Option<f32>,
    brightness: Option<f32>,
) {
    if let Some(img) = self.images.iter_mut().find(|im| im.asset_id == asset_id) {
        if let Some(o) = origin { img.origin = o; }
        if let Some(s) = scale { img.scale = s; }
        if let Some(a) = alpha { img.tint_alpha = Some(a); }
        if let Some(b) = brightness { img.tint_brightness = Some(b); }
    }
}
```

（`apply_image_update` 供 native 单测验证字段更新语义；生产入口 `update_image` 直接对 `SceneImage` 字段做相同操作，避免临时构造/写回 `ObjectState` 的借用与冗余。二者字段语义始终保持一致。）

- [ ] **Step 4: 运行，确认通过**

Run: `cargo test --manifest-path wasm/Cargo.toml`
Expected: PASS（`apply_image_update` 三个测试通过；既有 scene/effect 测试不破坏）。

- [ ] **Step 5: Commit**

```bash
git add wasm/src/render/mod.rs wasm/tests/render_update_test.rs
git commit -m "feat(wasm): 新增 apply_image_update 纯函数与 Renderer::update_image 对象动态状态入口"
```

---

### Task 2: `WeScene::update_image` wasm-bindgen 导出

**Files:**
- Modify: `wasm/src/lib.rs`（`WeScene` impl 内加方法）
- Test: 复用 `wasm/tests/`（无新增；wasm-bindgen 导出在本步骤只能靠编译通过验证）

**Interfaces:**
- Consumes: `Renderer::update_image`（Task 1）
- Produces: JS 侧 `scene.update_image(assetId, origin?, scale?, alpha?, brightness?)`，`origin/scale` 为 `Float32Array | undefined`，`alpha/brightness` 为 `number | undefined`。

- [ ] **Step 1: 在 `WeScene` impl 加导出方法**

```rust
#[wasm_bindgen]
impl WeScene {
    // ...现有 create/resize/set_cover/load_scene/load_image/add_particle/step/render...

    /// 每帧更新一个图片对象的状态（origin/scale/alpha/brightness）。
    /// Option 语义：JS 传 undefined（wasm-bindgen 对 Option 接受 undefined/null）=
    /// 保持现状。asset_id = 对象数组索引（与 load_image/add_particle 一致）。
    pub fn update_image(
        &mut self,
        asset_id: u32,
        origin: Option<Vec<f32>>,
        scale: Option<Vec<f32>>,
        alpha: Option<f32>,
        brightness: Option<f32>,
    ) {
        let o = origin.map(|v| arr3(&v));
        let s = scale.map(|v| arr3(&v));
        self.renderer.update_image(asset_id, o, s, alpha, brightness);
    }
}
```

（`arr3` 是 mod.rs 已有 helper，转 Vec<f32>→[f32;3]。`renderer` 字段已有。）

- [ ] **Step 2: 构建，确认编译通过**

Run: `npm run build:wasm`
Expected: 成功（wasm/pkg 产物更新；`we_scene_wasm.d.ts` 出现 `update_image` 签名）。

- [ ] **Step 3: Commit**

```bash
git add wasm/src/lib.rs
git commit -m "feat(wasm): 导出 WeScene::update_image 到 wasm-bindgen"
```

---

### Task 3: JS `SceneScriptRuntime` 纯逻辑层

**Files:**
- Create: `src/client/scene-script.ts`（本任务先写纯逻辑部分）
- Test: `tests/scene-script.test.ts`（新建，node 环境）

**Interfaces:**
- Produces: `ObjectState` 装配函数 + `Readback` 规范化函数（纯函数，供 Task 4 的 quickjs 绑定层与 Task 5 的 wasm-renderer 消费）。

**设计：** 纯逻辑层不 import quickjs。它定义：
- `buildInitialObjectState(origin, scale, alpha, brightness): ObjectState` —— 从 scene.json 解析值构造 QuickJS 可注入的 `{ origin, scale, image:{alpha,brightness}, alpha }`。
- `normalizeReadback(raw): Readback` —— 从 QuickJS 读回的 `{ origin, scale, imageAlpha, imageBrightness }` 规范化（clamp alpha 0-1、缺省保留、仅当发生了真实变化才输出）。

```ts
// src/client/scene-script.ts —— 纯逻辑部分（与 quickjs 解耦，node 可测）

export interface ScriptObjectState {
  origin: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  alpha: number;
  image: { alpha: number; brightness: number };
}

export interface ScriptReadback {
  origin?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
  imageAlpha?: number;
  imageBrightness?: number;
}

export function buildInitialObjectState(
  origin: [number, number, number],
  scale: [number, number, number],
  alpha: number,
  brightness: number,
): ScriptObjectState {
  return {
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    scale: { x: scale[0], y: scale[1], z: scale[2] },
    alpha,
    image: { alpha, brightness },
  };
}

// 规范化读回：clamp alpha 0-1；仅有值字段输出；origin/scale 缺省保留
export function normalizeReadback(raw: {
  origin?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
  imageAlpha?: number;
  imageBrightness?: number;
}): ScriptReadback {
  const rb: ScriptReadback = {};
  if (raw.origin) rb.origin = { x: raw.origin.x, y: raw.origin.y, z: raw.origin.z };
  if (raw.scale) rb.scale = { x: raw.scale.x, y: raw.scale.y, z: raw.scale.z };
  if (raw.imageAlpha !== undefined) rb.imageAlpha = Math.max(0, Math.min(1, raw.imageAlpha));
  if (raw.imageBrightness !== undefined) rb.imageBrightness = raw.imageBrightness;
  return rb;
}
```

- [ ] **Step 1: 写失败的单测**

```ts
// tests/scene-script.test.ts
import { describe, it, expect } from 'vitest';
import { buildInitialObjectState, normalizeReadback } from '../src/client/scene-script.js';

describe('buildInitialObjectState', () => {
  it('构造 origin/scale/image.alpha 嵌套状态', () => {
    const s = buildInitialObjectState([1, 2, 0], [2, 2, 1], 0.5, 1.5);
    expect(s.origin).toEqual({ x: 1, y: 2, z: 0 });
    expect(s.scale).toEqual({ x: 2, y: 2, z: 1 });
    expect(s.alpha).toBe(0.5);
    expect(s.image.alpha).toBe(0.5);
    expect(s.image.brightness).toBe(1.5);
  });
});

describe('normalizeReadback', () => {
  it('clamp imageAlpha 到 0-1', () => {
    const rb = normalizeReadback({ imageAlpha: 1.7 });
    expect(rb.imageAlpha).toBe(1);
    const rb2 = normalizeReadback({ imageAlpha: -0.2 });
    expect(rb2.imageAlpha).toBe(0);
  });

  it('仅输出有值的字段（origin 缺省保留 undefined）', () => {
    const rb = normalizeReadback({ imageAlpha: 0.4 });
    expect(rb.origin).toBeUndefined();
    expect(rb.imageAlpha).toBe(0.4);
  });

  it('origin/scale 原样保留', () => {
    const rb = normalizeReadback({ origin: { x: 1, y: 2, z: 0 }, scale: { x: 3, y: 3, z: 1 } });
    expect(rb.origin).toEqual({ x: 1, y: 2, z: 0 });
    expect(rb.scale).toEqual({ x: 3, y: 3, z: 1 });
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/scene-script.test.ts`
Expected: FAIL——`buildInitialObjectState`/`normalizeReadback` 不存在。

- [ ] **Step 3: 实现纯逻辑**

把上方 `src/client/scene-script.ts` 的纯逻辑部分写入。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/scene-script.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/client/scene-script.ts tests/scene-script.test.ts
git commit -m "feat(client): SceneScript 对象状态装配与读回规范化纯逻辑"
```

---

### Task 4: JS `SceneScriptRuntime` quickjs 绑定层

**Files:**
- Modify: `src/client/scene-script.ts`（追加 quickjs 绑定层：bind/tick/dispose）
- Modify: `package.json`（`dependencies` 加 `quickjs-emscripten`）
- Test: `tests/scene-script.test.ts`（追加，node 环境测 quickjs 同步 wasm）

**Interfaces:**
- Consumes: `buildInitialObjectState`/`normalizeReadback`（Task 3）；quickjs-emscripten（quickjs `getQuickJS`/`RELEASE_SYNC`）。
- Produces: `SceneScriptRuntime` 类，`bind(script, initialState): BoundScript | null`；`BoundScript.update(dt): ScriptReadback | null`；`SceneScriptRuntime.dispose()`。
- Consumes（Task 5）: `wasm-renderer` 用它创建 runtime + 收集 binding。

```ts
// src/client/scene-script.ts —— quickjs 绑定层（追加）

import { getQuickJS, RELEASE_SYNC } from 'quickjs-emscripten';
import { buildInitialObjectState, normalizeReadback, ScriptObjectState, ScriptReadback } from './scene-script.js';
// （buildInitialObjectState/normalizeReadback 已在同文件，无需重复 import）

export interface BoundScript {
  update(dt: number): ScriptReadback | null;
}

export class SceneScriptRuntime {
  private ctx: any;
  private runtime: any;
  private bounds: Array<{ instance: any; updateFn: any; state: ScriptObjectState }> = [];

  private constructor(ctx: any, runtime: any) {
    this.ctx = ctx;
    this.runtime = runtime;
  }

  /** 初始化（异步：quickjs wasm 懒加载）。失败返回 null，调用方退化无动画路径。 */
  static async create(): Promise<SceneScriptRuntime | null> {
    try {
      const QuickJS = await getQuickJS();
      const runtime = QuickJS.newRuntime();
      const ctx = runtime.newContext();
      // 预注册宿主基类 IThisPropertyObject（脚本 class extends 它）
      const base = ctx.evalCode(`
        class IThisPropertyObject { constructor() {} init() {} update(dt) {} }
        globalThis.__IThisPropertyObject = IThisPropertyObject;
        true;
      `);
      if (base.error) { base.error.dispose(); ctx.dispose(); runtime.dispose(); return null; }
      base.value.dispose();
      return new SceneScriptRuntime(ctx, runtime);
    } catch {
      return null;
    }
  }

  /** 为一个对象绑定脚本。initial 来自 scene.json 解析值。返回 null = 脚本不可用（静态渲染）。 */
  bind(script: string, initial: {
    origin: [number, number, number];
    scale: [number, number, number];
    alpha: number;
    brightness: number;
  }): BoundScript | null {
    if (!script || typeof script !== 'string') return null;
    const ctx = this.ctx;
    const state = buildInitialObjectState(initial.origin, initial.scale, initial.alpha, initial.brightness);
    // 宿主构造 this 对象（origin/scale/image 嵌套）
    const thisObj = ctx.newObject();
    // origin
    const originObj = ctx.newObject();
    ctx.setProp(originObj, 'x', ctx.newNumber(state.origin.x));
    ctx.setProp(originObj, 'y', ctx.newNumber(state.origin.y));
    ctx.setProp(originObj, 'z', ctx.newNumber(state.origin.z));
    ctx.setProp(thisObj, 'origin', originObj);
    // scale
    const scaleObj = ctx.newObject();
    ctx.setProp(scaleObj, 'x', ctx.newNumber(state.scale.x));
    ctx.setProp(scaleObj, 'y', ctx.newNumber(state.scale.y));
    ctx.setProp(scaleObj, 'z', ctx.newNumber(state.scale.z));
    ctx.setProp(thisObj, 'scale', scaleObj);
    // image 子对象
    const imageObj = ctx.newObject();
    ctx.setProp(imageObj, 'alpha', ctx.newNumber(state.image.alpha));
    ctx.setProp(imageObj, 'brightness', ctx.newNumber(state.image.brightness));
    ctx.setProp(thisObj, 'image', imageObj);
    ctx.setProp(thisObj, 'alpha', ctx.newNumber(state.alpha));

    // 实例化脚本：脚本源码是 class 声明，宿主用「吞掉 export/类名」的最小包装执行，
    // 取最后一个 class 作为脚本类。为稳妥：脚本通常形如
    // `export class Xxx extends IThisPropertyObject { ... }`，我们剥掉 export 再 eval。
    // 简化：将源码里的 `export class` → `class`，`extends IThisPropertyObject` 已有基类。
    // 若源码本身是个表达式/函数（非 class），回退：包装成对象含 update。
    const sanitized = script.replace(/\bexport\s+class\b/g, 'class').replace(/\bexport\s+default\b/g, '');
    const wrapped = `
      (function() {
        ${sanitized}
        // 取全局最后注册的类名作为脚本类（扫描 __scriptClass）
        return globalThis.__scriptClass || null;
      })()
    `;
    // 更稳：脚本类名未知。改成：expect 源码里 extends IThisPropertyObject，
    // 用正则抓取类名，然后 `new <Class>()`。
    const classMatch = /class\s+([A-Za-z0-9_]+)\s+extends\s+IThisPropertyObject/.exec(sanitized);
    const cname = classMatch ? classMatch[1] : null;

    let instance: any;
    if (cname) {
      const run = ctx.evalCode(`(function(){ ${sanitized}; return new ${cname}(); })()`);
      if (run.error) { run.error.dispose(); return null; }
      instance = run.value;
    } else {
      // 非 class 形式：包装成对象（bound update 直接调源码函数）
      const run = ctx.evalCode(`(function(){ ${sanitized}; return { update: (typeof update === 'function') ? update : (()=>{}) }; })()`);
      if (run.error) { run.error.dispose(); return null; }
      instance = run.value;
    }

    // 装配：把宿主 this 对象的状态注入实例（引擎绑定 this）
    const assign = ctx.evalCode(`(function(inst, hostThis){ for (const k of Object.keys(hostThis)) inst[k] = hostThis[k]; return inst; })`);
    if (assign.error) { assign.error.dispose(); instance.dispose(); return null; }
    const assignFn = assign.value;
    const bound = ctx.callFunction(assignFn, ctx.undefined, instance, thisObj);
    if (bound.error) { bound.error.dispose(); assignFn.dispose(); instance.dispose(); return null; }
    bound.value.dispose();
    assignFn.dispose();

    // 调 init
    const initFn = ctx.getProp(instance, 'init');
    const initR = ctx.callFunction(initFn, instance);
    if (initR.error) initR.error.dispose();
    initR.value.dispose();
    initFn.dispose();

    const updateFn = ctx.getProp(instance, 'update');
    this.bounds.push({ instance, updateFn, state });
    return {
      update: (dt: number): ScriptReadback | null => this.runUpdate(updateFn, instance, dt, thisObj),
    };
  }

  private runUpdate(updateFn: any, instance: any, dt: number, thisObj: any): ScriptReadback | null {
    try {
      const r = this.ctx.callFunction(updateFn, instance, this.ctx.newNumber(dt));
      if (r.error) { r.error.dispose(); return null; }  // 单对象抛错 → 停动画
      r.value.dispose();
      // 读回 this.image.alpha / this.image.brightness（优先），兜底顶层 this.alpha
      const image = this.ctx.getProp(thisObj, 'image');
      let imageAlpha: number | undefined;
      let imageBrightness: number | undefined;
      const imgAlpha = this.ctx.getProp(image, 'alpha');
      imageAlpha = this.ctx.getNumber(imgAlpha);
      const imgBright = this.ctx.getProp(image, 'brightness');
      imageBrightness = this.ctx.getNumber(imgBright);
      // 顶层 origin/scale 读回
      const origin = this.ctx.getProp(thisObj, 'origin');
      const scale = this.ctx.getProp(thisObj, 'scale');
      const raw = {
        origin: {
          x: this.ctx.getNumber(this.ctx.getProp(origin, 'x')),
          y: this.ctx.getNumber(this.ctx.getProp(origin, 'y')),
          z: this.ctx.getNumber(this.ctx.getProp(origin, 'z')),
        },
        scale: {
          x: this.ctx.getNumber(this.ctx.getProp(scale, 'x')),
          y: this.ctx.getNumber(this.ctx.getProp(scale, 'y')),
          z: this.ctx.getNumber(this.ctx.getProp(scale, 'z')),
        },
        imageAlpha,
        imageBrightness,
      };
      image.dispose(); origin.dispose(); scale.dispose();
      return normalizeReadback(raw);
    } catch {
      return null;
    }
  }

  /** 每帧对所有绑定调用 update（Task 5 的 wasm-renderer 逐对象调 BoundScript.update，此方法可选）。 */
  tick(dt: number): void {
    for (const b of this.bounds) {
      try {
        this.runUpdate(b.updateFn, b.instance, dt, b.getInstanceThis());
      } catch { /* 隔离 */ }
    }
  }

  dispose(): void {
    for (const b of this.bounds) this.bounds.length = 0;
    try { this.ctx.dispose(); } catch { /* noop */ }
    try { this.runtime.dispose(); } catch { /* gc 断言可忽略 */ }
  }
}
```

> **重要**：quickjs-emscripten 的 `RELEASE_SYNC` 导出用于 `getQuickJS()`（其内部用 RELEASE_SYNC 变体）。`bind` 里 `thisObj` 需在 `BoundScript.update` 闭包继续持有（上面 `runUpdate` 用了闭包捕获的 `thisObj`）。上面 `BoundScript` 的 `update` 闭包捕获 `thisObj`——需把 `thisObj` 传进闭包。其实现已通过闭包捕获。

> **Node 可测性**：quickjs-emscripten 同步 wasm 在 node 可加载（spike 已验证）。vitest 默认 node 环境可跑。但 vitest 的 esbuild 需处理 quickjs 的 ESM/CJS——本项目用 `esbuild`（build-client），vitest 用 vite 的 esbuild，通常能处理。`tests/scene-script.test.ts` 追加 quickjs 绑定层测试。

- [ ] **Step 1: 追加依赖**

```bash
npm install quickjs-emscripten
```

（写入 `package.json` dependencies；`git add package.json package-lock.json`。）

- [ ] **Step 2: 追加测试（quickjs 绑定层，真实脚本驱动）**

```ts
// tests/scene-script.test.ts 追加
import { describe, it, expect, afterEach } from 'vitest';
import { SceneScriptRuntime } from '../src/client/scene-script.js';

const BREATH_SCRIPT = `
  export class BreathingImage extends IThisPropertyObject {
    init() { this.__t = 0; this.baseAlpha = 0.8; }
    update(dt) {
      this.__t += dt;
      this.origin.x = Math.sin(this.__t) * 60;
      this.image.alpha = this.baseAlpha + 0.2 * Math.sin(this.__t * 3);
      this.scale.x = 1 + 0.05 * Math.sin(this.__t * 2);
    }
  }
`;

describe('SceneScriptRuntime (quickjs)', () => {
  let rt: InstanceType<typeof SceneScriptRuntime> | null = null;
  afterEach(() => { if (rt) rt.dispose(); rt = null; });

  it('bind + update 读回脚本改写的 origin/image.alpha/scale（逐帧演变）', async () => {
    rt = await SceneScriptRuntime.create();
    expect(rt).not.toBeNull();
    const bound = rt!.bind(BREATH_SCRIPT, { origin: [0, 0, 0], scale: [1, 1, 1], alpha: 1, brightness: 1 });
    expect(bound).not.toBeNull();
    const r1 = bound!.update(1 / 60);
    const r2 = bound!.update(1 / 60);
    expect(r1?.origin).toBeDefined();
    expect(r1?.imageAlpha).toBeDefined();
    // 两帧 origin.x 应都非 0（sin 驱动），且基本在小值区间
    expect(Math.abs(r1!.origin!.x)).toBeGreaterThan(0);
    expect(r1!.imageAlpha).toBeGreaterThanOrEqual(0);
    expect(r1!.imageAlpha).toBeLessThanOrEqual(1);
    // 二级帧继续演变（时间推进）
    expect(r2!.origin!.x).not.toBeCloseTo(r1!.origin!.x, 5);
  });

  it('空 script → bind 返回 null（静态渲染）', async () => {
    rt = await SceneScriptRuntime.create();
    expect(rt!.bind('', { origin: [0, 0, 0], scale: [1, 1, 1], alpha: 1, brightness: 1 })).toBeNull();
  });

  it('无效脚本（语法错误）→ bind 返回 null，不抛错', async () => {
    rt = await SceneScriptRuntime.create();
    expect(rt!.bind('class { syntax !!!}', { origin: [0, 0, 0], scale: [1, 1, 1], alpha: 1, brightness: 1 })).toBeNull();
  });

  it('脚本抛错 → 该对象 update 返回 null（隔离，不抛给宿主）', async () => {
    rt = await SceneScriptRuntime.create();
    const bad = `export class Bad extends IThisPropertyObject { update(dt) { throw new Error('boom'); } }`;
    const bound = rt!.bind(bad, { origin: [0, 0, 0], scale: [1, 1, 1], alpha: 1, brightness: 1 });
    expect(bound).not.toBeNull();
    expect(bound!.update(1 / 60)).toBeNull(); // 隔离：返回 null
  });
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run tests/scene-script.test.ts`
Expected: 后续实现前，quickjs 绑定层测试 FAIL（`SceneScriptRuntime` 未实现/绑定失败）。

- [ ] **Step 4: 实现 quickjs 绑定层**

把上方 `SceneScriptRuntime.create/bind/runUpdate/dispose` 写入 `src/client/scene-script.ts`。注意 `bind` 要正确 `evalCode` 脚本类——见上方实现（剥 export、抓类名、`new <Class>()`、宿主 this 装配）。若 `evalCode` 里 class 声明无法在同一段内被 `new`，用 `(function(){ ...; return new C(); })()` 包裹。

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run tests/scene-script.test.ts`
Expected: PASS（纯逻辑 + quickjs 绑定层全部通过）。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/client/scene-script.ts tests/scene-script.test.ts
git commit -m "feat(client): SceneScriptRuntime quickjs 绑定层（bind/update/dispose + 对象状态桥）"
```

---

### Task 5: `wasm-renderer.ts` 接入（脚本收集 + 帧循环灌回）

**Files:**
- Modify: `src/client/wasm-renderer.ts`（`render()` 内对象加载循环 + `loop`）
- Test: `tests/wasm-renderer.test.ts`（追加 jsdom 集成测试）

**Interfaces:**
- Consumes: `SceneScriptRuntime`（Task 4）；`Scene.update_image`（Task 2 wasm 导出）。
- Produces: `wasm-renderer` 的 `render()` 在成功路径启动帧循环，并对带脚本的 image 对象每帧调 `update_image`。

**设计（关键 `bind` 只对 image 对象 + 有 script 时）：**

```ts
// wasm-renderer.ts 内，对象遍历 image 分支里（load_image 成功后）：
import { SceneScriptRuntime } from './scene-script.js';

// render() 内：
let scriptRuntime: SceneScriptRuntime | null = null;
const scriptBindings: Array<{ assetId: number; bound: NonNullable<ReturnType<SceneScriptRuntime['bind']>> }> = [];
// 在 image 分支 load_image 后：
if (obj.script && obj.script.trim()) {
  scriptRuntime ??= await SceneScriptRuntime.create(); // 懒初始化（失败保持 null = 无动画）
  const bound = scriptRuntime?.bind(obj.script, {
    origin: obj.origin, scale: obj.scale,
    alpha: obj.alpha ?? 1, brightness: obj.brightness ?? 1,
  });
  if (bound) scriptBindings.push({ assetId: i, bound });
}
// loop 里：
const loop = () => {
  scene.step(1 / 60);
  for (const { assetId, bound } of scriptBindings) {
    const rb = bound.update(1 / 60);
    if (rb) {
      scene.update_image(
        assetId,
        rb.origin ? Float32Array.from([rb.origin.x, rb.origin.y, rb.origin.z]) : undefined,
        rb.scale ? Float32Array.from([rb.scale.x, rb.scale.y, rb.scale.z]) : undefined,
        rb.imageAlpha,
        rb.imageBrightness,
      );
    }
  }
  scene.render();
  if (fg.isConnected) raf = requestAnimationFrame(loop);
};
```

**注意**：`wasm-renderer.ts` 的 `render()` 是 async 函数；`SceneScriptRuntime.create()` 也是 async（await）。对象遍历是 `for` 循环，可在循环内 `await`。但 `SceneScriptRuntime.create()` 应在**循环外**只初始化一次（惰性 via `scriptRuntime ??=`）。脚本 `bind` 是同步的（quickjs 同步 wasm）。

**assetId 约定**：`load_image` 用 `i`（对象索引）；脚本 binding 也用 `i`；`update_image` 匹配。注意**可见性过滤**（`resolveVisibility(obj, {})` false 时 `continue` 跳过）——被跳过的对象 `i` 不产生 image，但其 `i` 仍是原索引（assetId 用原索引，与 load_image 一致）。

- [ ] **Step 1: 修改 wasm-renderer.ts**

按上述在 `render()` 里加 `scriptRuntime`/`scriptBindings` 收集 + loop 内灌回。

- [ ] **Step 2: 追加 jsdom 集成测试**

```ts
// tests/wasm-renderer.test.ts 追加（jsdom，复用既有 mock scene）
it('带脚本 image 对象：绑定脚本并每帧调用 update_image（读回 origin 变化）', async () => {
  vi.stubGlobal('navigator', { gpu: {} });
  const scene = {
    set_cover: vi.fn(), load_scene: vi.fn(), load_image: vi.fn(), add_particle: vi.fn(),
    step: vi.fn(), render: vi.fn(), update_image: vi.fn(),
  };
  const sceneJson = JSON.stringify({
    camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
    general: { orthogonalprojection: { width: 2400, height: 1555 } },
    objects: [
      {
        id: 12, name: 'anim', image: 'models/m.json', origin: '100 200 0', scale: '1 1 1', size: '400 300',
        visible: { script: `export class A extends IThisPropertyObject { update(dt) { this.origin.x += 5; } }`, value: true },
      },
    ],
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('name=scene.json')) return jsonResp(sceneJson);
    if (url.includes('m.json')) return jsonResp({ material: 'materials/mat.json' });
    if (url.includes('mat.json')) return jsonResp({ passes: [{ textures: ['tex'] }] });
    if (url.includes('tex.tex')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
    return { ok: false, status: 404, json: async () => ({}) } as any;
  }));
  const r = createWasmSceneRenderer({ loadWasm: async () => ({ default: vi.fn(), WeScene: { create: async () => scene } } as any) });
  const fg = document.createElement('canvas');
  await expect(r!.render('1', fg)).resolves.toBe(true);
  await vi.waitFor(() => {
    expect(scene.update_image).toHaveBeenCalled();
  });
  const [assetId] = scene.update_image.mock.calls[0];
  expect(assetId).toBe(0); // 原索引
});
```

- [ ] **Step 3: 运行，确认失败（当前 wasm-renderer 无脚本逻辑）**

Run: `npx vitest run tests/wasm-renderer.test.ts`
Expected: 新测试 FAIL（`update_image` 未被调用）。

- [ ] **Step 4: 实现 wasm-renderer 接入**

按上面的设计实现。注意 import `SceneScriptRuntime` 且不破坏既有无 WebGPU 回退测试。

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run tests/wasm-renderer.test.ts`
Expected: PASS（既有全部测试 + 新脚本动画测试通过）。

- [ ] **Step 6: Commit**

```bash
git add src/client/wasm-renderer.ts tests/wasm-renderer.test.ts
git commit -m "feat(wasm-renderer): 接入 SceneScriptRuntime，每帧执行脚本并灌回对象状态"
```

---

### Task 6: 全链路构建 + 集成验证

**Files:**
- 无新增（构建验证 + 手动浏览器回归）

**Interfaces:**
- Consumes: Task 1-5 的全部实现。

- [ ] **Step 1: 构建 wasm + client**

```bash
npm run build:wasm
npm run build:client
```

Expected: 成功。`dist/static/we_scene_wasm.js`/`_bg.wasm` 更新（含 `update_image`）；`dist/client.js` 含 `SceneScriptRuntime` 与 quickjs。

- [ ] **Step 2: 运行全部测试**

```bash
npm test
```

Expected: 全绿（含 native cargo test）。

- [ ] **Step 3: 浏览器集成回归（手动）**

用 headless Edge 加载一个带脚本动画的 scene 壁纸，确认对象逐帧运动；加载一个无脚本壁纸确认零回归（与改造前一致）。此步用项目既有验证方式。

- [ ] **Step 4: Commit（若有构建产物变更）**

```bash
git add wasm/pkg dist
git commit -m "build: wasm/client 产物更新（含 SceneScript 动画支持）"
```

---

## Self-Review

**Spec 覆盖检查**：
- §4.1 `SceneScriptRuntime`（bind/tick/dispose）→ Task 3（纯逻辑）+ Task 4（quickjs 绑定）。
- §4.2 `update_image` → Task 1（Renderer::update_image + apply_image_update 纯函数）+ Task 2（wasm 导出）。
- §4.3 `wasm-renderer.ts` 接入 → Task 5。
- §5 数据流 → Task 5 loop 内代码体现。
- §6 坐标/缩放约定 → 无坐标换算（脚本 origin 即 WE 场景像素），Task 5 直接灌入。
- §7 错误处理 → Task 4 `runUpdate` try/catch 返回 null；`bind` 失败返回 null；Task 5 `scriptRuntime?.bind` 失败 path。
- §8 测试 → Task 1/3/4/5 各含测试。
- §9 依赖 → Task 4 `npm install quickjs-emscripten`。
- §10 验收 → Task 6 集成验证 + 手动浏览器回归。

**占位符扫描**：无 TBD/TODO；每个代码步骤给出实际代码。`apply_image_update` 在 Task 1 保留为 native 可测纯函数，`update_image` 直接字段操作并保持一致语义（已说明，避免借用复杂化）。Task 4 的 quickjs 绑定层用了 `thisObj` 闭包捕获（`BoundScript.update` 闭包捕获 `thisObj`）——已在注释中说明。

**类型一致性**：
- `apply_image_update(state, origin, scale, alpha, brightness)` 在 Task 1 定义，Task 1 的 `update_image` 与 Task 2 的 `WeScene::update_image` 使用同名/同参。
- `SceneScriptRuntime.bind` 的 `initial` 参数类型 `{ origin; scale; alpha; brightness }` 在 Task 4 定义 → Task 5 调用处一致。
- `ScriptReadback`/`ScriptObjectState` 类型在 Task 3 定义 → Task 4 `normalizeReadback`/`buildInitialObjectState` 使用，Task 5 消费 `rb.origin/scale/imageAlpha/imageBrightness`。
- `scene.update_image` JS 侧签名（`Float32Array | undefined` 等）在 Task 2/3 一致。

**备注（实现者需注意）**：
- `SceneScriptRuntime.bind` 内 `thisObj` 必须在 `BoundScript.update` 闭包中持续有效（project 用 quickjs handle，`getProp`/`getNumber` 每次新建句柄需 dispose——spike 里简化，正式实现建议用 `Scope` 或即时 dispose，避免句柄泄漏触发 gc 断言。`canUseEmit` 不适用，按 quickjs-emscripten 惯例处理。）
- Task 4 的实现参考 `research/scenescript-spike/spike2.mjs`（已验证的宿主注入 this + 嵌套属性桥）。该 spike 产物标记为 throwaway，实际代码以计划为准。
