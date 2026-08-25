# wasm 场景脚本动画（SceneScript 驱动对象动起来）设计

- 日期：2026-08-25
- 状态：设计评审中
- 范围：**MVP —— 对象级 `IThisPropertyObject` 动画**（让 wasm 场景像桌面版一样"动起来"）

## 1. 目标

让 wasm 渲染路径（`wasm-renderer.ts` + Rust/wgpu）能驱动场景对象**每帧运动**，对齐桌面版 WE 的 SceneScript 行为。桌面版中，每个对象脚本绑定到对象自身的 `this`（`IThisPropertyObject`），脚本在 `update(dt)` 中改写 `this.origin`/`this.scale`/`this.alpha` 等，引擎每帧读回并渲染。本项目要让这条链路在浏览器 wasm 渲染路径上成立。

### 非目标（二阶段，本期不做）

- `IEngine`/`registerAudioBuffers`（音频可视化）、`IInput`（光标跟随）、`IScene.createLayer`（动态建层）、`ITextureAnimation`、粒子脚本、`createLayerAsset`。
- 完整 WE 脚本 API 面兼容。
- THREE/WebGL 渲染路径（`scene-renderer.ts` 已各有 visualizer/clock 逻辑，本期只动 wasm 路径）。

## 2. 现状与杠杆点

wasm 渲染路径（`wasm-renderer.ts`）现有渲染循环：

```
const loop = () => {
  scene.step(1 / 60);     // GPU 粒子模拟
  scene.render();          // 清屏 + 图片 quad + 粒子层
  if (fg.isConnected) raf = requestAnimationFrame(loop);
};
```

对象 transform 在 `scene.load_image(...)` 时**一次性**写入。`scene.rs` / `render/mod.rs` 的 `SceneImage` 存了 `origin`/`scale`/`size`/`tint_*`。

**关键杠杆点**：`render_frame` 每帧已执行 `images.iter().map(|img| image_ndc(img, ...))`，即**每帧从 `SceneImage` 字段重算 ImageUniform**。因此，**只要每帧更新 `SceneImage` 的 `origin`/`scale`/`tint_alpha`/`tint_brightness` 字段，渲染就会跟着变——shader 与 `render_frame` 零改动**。这决定了"对象动态状态"接口是最小侵入的。

asset_id 约定：`wasm-renderer` 以**对象数组索引 `i`** 作为 `set_image`/`add_particle` 的 asset_id（单场景内唯一）。脚本对象沿用同一 `i`，`update_image` 按它匹配。

## 3. 架构（方案 A，已确认）

脚本引擎在 **JS 侧**（quickjs-emscripten，wasm 化 QuickJS），**不编进 Rust wasm**。JS 每帧：

```
执行 SceneScript.update(dt) → 读回 this.origin/scale/image.alpha/brightness →
调 Scene.update_image(assetId, origin, scale, alpha, brightness) → 更新 Rust SceneImage
```

分层：

```
scene.json ──parseSceneJson──▶ SceneDescription
                                │ objects[i].script / scriptProperties
                                ▼
                        SceneScriptRuntime (JS, quickjs-emscripten)
                                │ 每对象一个脚本实例 + 一个宿主 this 状态对象
                                │ 每帧: script.update(dt)
                                ▼
                        读回 this.origin / this.scale / this.image.alpha / brightness
                                │ 防抖：仅当对象有脚本（script 非空）
                                ▼
                        Scene.update_image(assetId, origin, scale, alpha, brightness)
                                │
                                ▼
                        Renderer.images[asset_id].origin/scale/tint_*  ← 每帧被 render_frame 读取
```

## 4. 组件

### 4.1 `SceneScriptRuntime`（新增，JS 侧，`src/client/scene-script.ts`）

封装 quickjs-emscripten 生命周期，对宿主提供最小接口：

```ts
interface SceneScriptRuntime {
  /** 为一个对象创建脚本实例并绑定宿主 this 状态。
   *  script: WE 脚本源码（对象 script 字段）
   *  initial: 对象初始状态（origin/scale/alpha/brightness，来自 scene.json 解析值）
   *  returns: 绑定句柄（含 update 函数引用），或 null（脚本不支持/实例化失败） */
  bind(script: string, initial: ObjectState): BoundScript | null;
  /** 每帧：对已绑定且用了脚本的对象调用 update(dt)，并读回可动画属性。 */
  tick(dt: number): void;
  dispose(): void;
}
```

其中 `ObjectState`：

```ts
interface ObjectState {
  origin: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  alpha: number;        // 对象 alpha（0-1）
  image: { alpha: number; brightness: number }; // we 脚本常用 this.image.alpha
  __t?: number;         // 脚本自维护的累加时间（脚本可自存，不作为宿主状态）
}
```

读回规则（消除歧义）：`update` 读回的 `imageAlpha`/`imageBrightness` 优先取 `this.image.alpha`/`this.image.brightness`（we 图像对象动画标准路径）；若脚本改写的是顶层 `this.alpha` 而非 `this.image.alpha`，则以顶层 `this.alpha` 作为 `imageAlpha` 的兜底来源。MVP 以 `this.image.*` 为主线，顶层作为兼容。

`BoundScript`：

```ts
interface BoundScript {
  /** 每帧调用。内部调 script.update(dt)，然后读回 this.origin / this.scale /
   *  this.image.alpha / this.image.brightness（容错缺省），返回是否发生可读变化。 */
  update(dt: number): Readback | null;
}
interface Readback {
  origin?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
  imageAlpha?: number;
  imageBrightness?: number;
}
```

实现要点：
- quickjs-emscripten 用 `RELEASE_SYNC`（同步 wasm）。**共享单例**（`getQuickJS()` 懒加载）。
- 每个对象一个 QuickJS 脚本 `class` 实例（`new <ScriptClass>()`），共享同一直 runtime/context（不每对象一个 context——开销大）。
- 宿主构造对象状态 `this`（`ctx.newObject()`，含 origin/scale/image 嵌套子对象），装配进脚本实例（spike2 已验证该桥成立）。
- 只对 `script` 非空的对象走脚本路径；无脚本对象完全不受影响（零回归）。
- **错误隔离**：单对象脚本抛错不影响其他对象与整体渲染（try/catch + 该对象停止动画）。

### 4.2 Rust `update_image`（新增，`wasm/src/render/mod.rs` + `wasm/src/lib.rs`）

wasm-bindgen 导出接口（`WeScene`）：

```rust
#[wasm_bindgen]
pub fn update_image(
    &mut self,
    asset_id: u32,
    origin: Option<Vec<f32>>,   // None/undefined = 保持现状；Some([x,y,z]) 替换
    scale: Option<Vec<f32>>,    // None/undefined = 保持现状
    alpha: Option<f32>,         // None/undefined = 保持现状；Some(0-1) 更新 tint_alpha
    brightness: Option<f32>,    // None/undefined = 保持现状
)
```

（wasm-bindgen 导出：`Option<Vec<f32>>` ↔ JS `Float32Array | undefined`；`Option<f32>` ↔ JS `number | undefined`。JS 侧传 `undefined` 即 Rust `None`，统一"未提供 = 保持现状"语义。）

`Renderer` 内部：

```rust
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

- **零改动** shader `image.wgsl` 与 `render_frame`（后者每帧读 `SceneImage` 字段）。
- 找不到 asset_id 则 no-op（防御：对象未注册或已卸载）。

### 4.3 `wasm-renderer.ts` 接入（改造）

**范围限定**：MVP 只对 image 对象（`SceneImageObject` 有 `script` 字段）驱动脚本动画。text/particle/util 对象不处理（text 既有静态/clock 路径、particle 已有 GPU 动画、util 不渲染）。这避免把 QuickJS 实例绑定到本就不走此路径的对象。

在对象加载循环后、`loop` 开始前，收集脚本对象：

```ts
// 对象遍历里（load_image 分支）额外记录
const scriptBinding = sceneScriptRuntime.bind(desc.objects[i].script ?? '', initialState);
if (scriptBinding) scriptBindings.push({ assetId: i, bound: scriptBinding });
```

`loop` 每帧追加：

```ts
const loop = () => {
  scene.step(1 / 60);
  // SceneScript 每帧驱动：对绑定脚本调用 update，读回并灌入 Rust 对象状态
  for (const { assetId, bound } of scriptBindings) {
    const rb = bound.update(1 / 60);
    if (rb) {
      scene.update_image(
        assetId,
        rb.origin ? Float32Array.from([rb.origin.x, rb.origin.y, rb.origin.z]) : undefined,
        rb.scale ? Float32Array.from([rb.scale.x, rb.scale.y, rb.scale.z]) : undefined,
        rb.imageAlpha,          // undefined = 保持现状（Rust Option<f32>::None）
        rb.imageBrightness,     // undefined = 保持现状
      );
    }
  }
  scene.render();
  if (fg.isConnected) raf = requestAnimationFrame(loop);
};
```

注意：`wasm-renderer` 是无 WebGPU 时 `createWasmSceneRenderer` 返回 null 的回退链，仅在 `navigator.gpu` 存在时进入。脚本运行时需在 `navigator.gpu` 可用时才初始化（与 wasm 一致）。

## 5. 数据流

1. `parseSceneJson(json)` → `SceneDescription`，`objects[i].script`/`scriptProperties` 已在 JS 侧可用。
2. `wasm-renderer.render()` 加载对象时，对有 `script` 的 image 对象创建 `SceneScriptRuntime.bind(script, initialState)`。
3. `loop` 每帧对每个绑定 `BoundScript.update(1/60)` → 读回 `Readback`。
4. 对读回值调用 `scene.update_image(assetId, ...)` → 更新 Rust `SceneImage.origin/scale/tint_*`。
5. `scene.render()` → `render_frame` 每帧用更新后的 `SceneImage` 字段重算 ImageUniform → 对象动起来。

## 6. 坐标与缩放约定

- WE 场景坐标：左下原点、y 向上。脚本里 `this.origin` 的语义与 scene.json 的 origin 一致（WE 场景像素）。`update_image` 传入的 origin 直接替换 `SceneImage.origin`，`image_ndc` 已是既有 WE→NDC 换算，**无需在脚本桥再做坐标换算**。
- `alpha`：0-1（脚本读回 clamp 到 0-1）。
- `brightness`：乘法系数（缺省 1），灌入 `tint_brightness`（`image_tint` 已是 纹理×color×brightness 语义）。

## 7. 错误处理

- **脚本解析/实例化失败**（如语法错误、`update` 缺失）：`bind` 返回 null，对象按静态渲染，不报错（回退为现状）。
- **单对象 update 抛错**：该对象停止动画（从 `scriptBindings` 移除），其余对象与整体渲染不受影响。`console.warn` 记录。
- **读回缺字段**：脚本只改了部分属性（如只改 alpha），其余读回用缺省 → 对应 Rust 入参传空（保持现状）。
- **无 WebGPU / quickjs 加载失败**：脚本运行时与 wasm 一致不初始化，整个场景走既有无动画路径。

## 8. 测试

- **Rust（native cargo test，无 render feature）**：
  - `update_image`：给定 `SceneImage` 字段，验证 `update_image` 按 asset_id 更新 origin/scale/tint_alpha/tint_brightness；asset_id 缺失时 no-op；`None` 入参保持现状。
  - 复用既有 image_tint 相关测试断言 tint 语义不被破坏。
- **JS（vitest，纯逻辑，不碰 WebGPU/QuickJS wasm）**：
  - `ObjectState` 装配与 `Readback` 规范化：脚本只改部分属性时其余保留缺省。
  - 脚本表达式（如 `Math.sin`）驱动的 origin/alpha 数值断言（spike1/spike2 已验证的数值，可固化为单测）。
  - `bind` 对空 script / 无效脚本返回 null。
- **集成（浏览器，headless Edge）**：手动回归——加载一个带动画脚本的 scene 壁纸，观察对象位置/透明度逐帧变化；加载无脚本壁纸确认零回归。

## 9. 依赖

- 新增 JS 依赖：`quickjs-emscripten`（npm，已有 spike 验证 0.48MB wasm + 86KB JS glue）。
- 无新 Rust crate（`update_image` 用已有类型）。

## 10. 验收标准（MVP）

1. 带对象脚本（`this` 改写 origin/scale/alpha）的 scene 壁纸，在 wasm 路径下对象**逐帧运动/变化**。
2. 无脚本对象的壁纸渲染结果与改造前**完全一致**（零回归）。
3. 单对象脚本抛错不影响整体渲染。
4. 性能：每帧脚本开销可接受（spike 实测单 update ~5µs），60fps 稳定。
