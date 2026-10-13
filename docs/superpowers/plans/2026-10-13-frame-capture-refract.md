# 帧内快照与粒子 REFRACT 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 DSH 的「一次性整场景渲染」改为「按 WE 对象序逐段渲染 + 消费者段边界帧内快照」，实现 `_rt_FullFrameBuffer` 并用它让 `2897292240` 的 REFRACT 雨层画出 WE 的玻璃水滴。

**Architecture:** 新增 `FrameCapture`（`copyFramebufferToTexture` 快照）；`threejs-player.render()` 在存在消费者时改为「逐段 `render` 进画布尺寸 `frameRT`（段间 `autoClear=false` 累积）→ 消费者前拍快照 → 末段合成到默认 framebuffer」；`renderOrder` 按 `scene.json objects` 下标唯一化以对齐 WE 层序；Glow 改为消费同一张 `frameRT`。**无消费者时完全走现状路径**。

**Tech Stack:** TypeScript、three r170（WebGL2）、Vitest（jsdom + mock renderer）、既有 `rt-render.ts` / `glow-stage.ts` / `object-effects.ts` 设施。

**Spec:** `docs/superpowers/specs/2026-10-13-frame-capture-refract-design.md`（本计划的权威依据；冲突以 spec 为准）

## Global Constraints

- 只改 `src/client/**` 与 `tests/**`；**本轮不重建** `lib/`、`dist/`（最后一步由用户确认时机后统一重建）。
- **无消费者时调用序列必须与现状逐字节一致**（结构性零回归）：`render()` 的 render 次数、target、`clearAlpha` 均不变。
- `renderer.autoClear` 只在段渲染范围内用 `try/finally` 临时关闭，退出即恢复原值（`rt-render.ts` 的 4 个调用点依赖默认 `true`）。
- 不引入 `preserveDrawingBuffer`，不改 `three-renderer.ts:640` 的 renderer 构造。
- `frameRT` / 快照纹理：`ClampToEdge` + `LinearFilter` + 不生成 mip + **不标 sRGB**；`frameRT` 为 `UnsignedByte`、与 Glow `baseRT` 共用。
- 段渲染清屏与现状默认 fb 一致：`clearColor` 黑、`clearAlpha` 1。
- 注释 ≤2 行中文，说清「是什么/为什么」；提交信息标题一行 + 正文最多 3 行中文。
- **不得** `git add`：`.research-mpkg*/`、`.superpowers/`、`output/`、`e2e/.out/`。
- 每个任务结束跑该任务的定向 vitest；Task 6 跑全量 `npx vitest run`（基线 **1118**）。
- REFRACT 判据只认 `passes[0].combos.REFRACT === 1`；**不得**用「alpha 全 255」这类素材启发式（会打掉 7 个 additive 材质）。

---

### Task 1: `FrameCapture` 抽象（零接入）

**Files:**
- Create: `src/client/frame-capture.ts`
- Test: `tests/frame-capture.test.ts`

**Interfaces:**
- Consumes: `THREE.WebGLRenderer`（需要 `copyFramebufferToTexture`、`getDrawingBufferSize`）
- Produces:
  ```ts
  export interface FrameCapture {
    readonly active: boolean;      // 是否已有消费者（调用方据此决定走不走段渲染）
    readonly target: THREE.WebGLRenderTarget;  // 段渲染目标（画布尺寸）
    use(): void;                   // 声明本帧有消费者（激活）
    capture(): THREE.Texture;      // 拍「当前帧已绘制内容」；首次调用前惰性零资源
    resize(width: number, height: number): void;
    dispose(): void;
  }
  export function createFrameCapture(renderer: THREE.WebGLRenderer): FrameCapture;
  ```

- [ ] **Step 1: 写失败测试**

创建 `tests/frame-capture.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createFrameCapture } from '../src/client/frame-capture.js';

function fakeRenderer(calls: string[]) {
  const copy = vi.fn(() => { calls.push('copy'); });
  return {
    copyFramebufferToTexture: copy,
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(1600, 670),
  } as unknown as THREE.WebGLRenderer;
}

describe('createFrameCapture', () => {
  it('未 use() 时惰性：active=false 且不建 RT/纹理、不调用 copyFramebufferToTexture', () => {
    const calls: string[] = [];
    const cap = createFrameCapture(fakeRenderer(calls));
    expect(cap.active).toBe(false);
    expect(calls).toEqual([]);
  });

  it('use() 后 active=true；capture() 返回纹理且复用同一张', () => {
    const calls: string[] = [];
    const cap = createFrameCapture(fakeRenderer(calls));
    cap.use();
    const t1 = cap.capture();
    const t2 = cap.capture();
    expect(cap.active).toBe(true);
    expect(t1).toBe(t2);
    expect(calls).toEqual(['copy']);
  });

  it('resize() 后 target 尺寸 = 画布缓冲尺寸，快照纹理同尺寸', () => {
    const cap = createFrameCapture(fakeRenderer([]));
    cap.use();
    cap.resize(2560, 1440);
    expect(cap.target.width).toBe(2560);
    expect(cap.target.height).toBe(1440);
    expect(cap.capture().image.width).toBe(2560);
  });

  it('dispose() 后再 capture() 抛错（调用方据此降级）', () => {
    const cap = createFrameCapture(fakeRenderer([]));
    cap.use();
    cap.capture();
    cap.dispose();
    expect(() => cap.capture()).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/frame-capture.test.ts`
Expected: FAIL（`Cannot find module '../src/client/frame-capture.js'`）

- [ ] **Step 3: 实现**

创建 `src/client/frame-capture.ts`：`FramebufferTexture`（`THREE.FramebufferTexture(w,h)`，r170）+ `WebGLRenderTarget(w,h,{ type: THREE.UnsignedByteType })`（不标 sRGB、`ClampToEdge`/`LinearFilter`/无 mip 是 three 的 RT 默认，显式设置以防后续默认变更）；`use()` 置 `active`；`capture()` 惰性 `ensure()` 后 `renderer.copyFramebufferToTexture(snapshot)` 并返回 `snapshot`；`resize()`/`dispose()` 同步两张资源。头部注释写清「语义 = WE 的 `_rt_FullFrameBuffer`（到那一刻为止已绘制的内容），由 lwe `CParticle.cpp:2069-2079` / `CScene.cpp:351-361` 对齐」。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/frame-capture.test.ts`
Expected: PASS（4 passed）

- [ ] **Step 5: 提交**

```bash
git add src/client/frame-capture.ts tests/frame-capture.test.ts
git commit -m "feat(client): 新增 FrameCapture 帧内快照抽象（未接入）" -m "语义对齐 WE _rt_FullFrameBuffer：copyFramebufferToTexture 取当前帧已绘制内容"
```

---

### Task 2: `renderOrder` 唯一化（层序对齐 WE）

**Files:**
- Modify: `src/client/threejs-player.ts`（`:962` 背景、`:1205` 隔离 quad、`:1448` 粒子）
- Modify: `src/client/three-renderer.ts`（装配循环按 `objects` 下标传入）
- Modify: `src/client/dynamic-mesh.ts:133`（动态网格跟随宿主对象序）
- Test: `tests/threejs-player.test.ts`、`tests/three-renderer.test.ts`

**Interfaces:**
- Produces: `addBackground(opts)` / `addParticle(opts)` / `attachIsolated(opts)` 新增可选 `renderOrder?: number`；**缺省值保持现状**（背景 0 / 粒子 1），因为隔离 quad 的 kind 分支仍以缺省兜底。
- Consumes: `scene.json` 的 objects 数组下标（`three-renderer.ts` 装配循环已是按序遍历）。

- [ ] **Step 1: 写失败测试**

在 `tests/threejs-player.test.ts` 追加：

```ts
it('renderOrder 按传入值唯一化，缺省仍是背景 0 / 粒子 1', () => {
  // 用既有 helper 建 player，分别以 renderOrder: 5 / 3 装配一个背景与一个粒子
  // 断言 mesh.renderOrder === 5 / 3；不传时仍是 0 / 1
});
```

在 `tests/three-renderer.test.ts` 追加：mock `player.addBackground`/`addParticle`，断言第 N 个对象的 `opts.renderOrder === N`（`2897292240` 的 fixture 或最小 scene）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/threejs-player.test.ts tests/three-renderer.test.ts`
Expected: FAIL（`renderOrder` 未生效/未传）

- [ ] **Step 3: 实现**

三处 `mesh.renderOrder = 0|1` 改为 `opts.renderOrder ?? 0|1`（`:1205` 的 quad 用 `opts.renderOrder ?? (kind === 'particle' ? 1 : 0)`）；`three-renderer.ts` 装配循环把 `objects` 下标作为 `renderOrder` 传入三处；`dynamic-mesh.ts` 的 `renderOrder = 1` 改为跟随宿主传入值（缺省 1）。注释写明依据：WE 顺序 = `scene.json objects` 数组序（lwe `CScene.cpp:94-101/262-295`，全库 34/34 一致）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/threejs-player.test.ts tests/three-renderer.test.ts tests/dynamic-mesh.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/threejs-player.ts src/client/three-renderer.ts src/client/dynamic-mesh.ts tests/threejs-player.test.ts tests/three-renderer.test.ts
git commit -m "fix(client): renderOrder 按 scene.json 对象序唯一化" -m "对齐 WE m_objectsByRenderOrder（lwe CScene.cpp:94-101/262-295）；全库 7 个 P…I 壁纸叠加次序随之变化"
```

**验收提醒**：本任务会产生**预期可见变更**（7 个「粒子在前、image 在后」的 pkg），Task 6 逐张目视确认，不得当回归。

---

### Task 3: 段渲染骨架 + `frameRT` + 末段合成 + Glow 共用

**Files:**
- Modify: `src/client/threejs-player.ts`（`render()` `:831-843`、新增 `setFrameCapture()` / `renderSegmented()` / `ensureFrameRT()` / 合成 quad、`resize()`/`dispose()`）
- Modify: `src/client/glow-stage.ts`（`apply()` 增加可选 `preRendered` 入参，跳过自渲主场景 `:298`）
- Test: `tests/threejs-player.test.ts`、`tests/glow-stage.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `FrameCapture`；`renderIntoRenderTarget`（`rt-render.ts`）
- Produces:
  ```ts
  // threejs-player.ts
  setFrameCapture(capture: FrameCapture | null): void;
  // glow-stage.ts
  apply(r, scene, camera, preRendered?: THREE.WebGLRenderTarget): void;  // 传了就用它做 bright-pass，不再自渲
  ```
- 段划分（本任务先支持"消费者 = scene.json 对象 id 集合"）：
  `private frameConsumers = new Set<number>()` + `registerFrameConsumer(objectId)`；按 `renderOrder` 升序遍历 `displayObjects`，在消费者对象**之前**切段。

- [ ] **Step 1: 写失败测试**

`tests/threejs-player.test.ts` 追加（复用既有 mock，它记录 `{scene,target,clearAlpha}`）：

```ts
it('无消费者时调用序列与现状逐字节一致（1 次 render 到默认 fb）', () => {
  const player = makePlayer();          // 既有 helper
  player.render();
  expect(renders.map((r) => r.target)).toEqual([null]);
});

it('有消费者时：段渲染进 RT、段间 autoClear=false、末段合成回默认 fb', () => {
  const player = makePlayer();
  const cap = createFrameCapture(mockRenderer);
  cap.use();
  player.setFrameCapture(cap);
  player.registerFrameConsumer(2);      // 让第 2 个对象成为消费者
  player.render();
  // 断言：≥2 次 render 到 cap.target，最后一次到 null（合成）
  // 断言：非合成段的渲染期间 renderer.autoClear === false
  // 断言：退出后 renderer.autoClear 恢复 true
});

it('段渲染期间只有本段对象 visible；结束后全部恢复原值', () => {
  // 在 mock render 回调里抓 scene.children 的 visible 快照
});
```

`tests/glow-stage.test.ts` 追加：`apply(r, scene, camera, preRendered)` 时**不再**渲染主场景（既有 `:97-114` 的 11 次 render 全序断言需按新语义更新）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/threejs-player.test.ts tests/glow-stage.test.ts`
Expected: FAIL（`setFrameCapture`/`registerFrameConsumer` 不存在）

- [ ] **Step 3: 实现**

`render()` 保持现状分支不变（`glowStage` 有 → `apply`；无 → 直渲）；**仅当** `frameCapture?.active === true` 时走新路径：

```ts
if (this.frameCapture?.active) this.renderSegmented();
else if (this.glowStage) this.glowStage.apply(this.renderer, this.scene, this.camera);
else this.renderer.render(this.scene, this.camera);
```

`renderSegmented()`：① 保存 `autoClear` 与各顶层对象的 `visible`；② `setRenderTarget(cap.target)` + `setClearColor(0x000000, 1)` + `clear()`；③ `autoClear=false`；④ 逐段（按 `renderOrder` 排序 + 消费者前切段）：只有本段对象 `visible=true`、其余 `false` → `render(scene, camera)`；消费者段渲染**前**调 `cap.capture()` 并把纹理交给该消费者；⑤ `finally` 恢复 `autoClear` 并 `setRenderTarget(null)`；⑥ 恢复所有 `visible`；⑦ Glow 关闭时**新建 `src/client/composite-quad.ts`**（单职责：把给定纹理全屏贴到当前 render target，含 `createCompositeQuad()` / `composite(renderer, texture)` / `resize()` / `dispose()`）把 `cap.target.texture` 贴到默认 fb；Glow 开启时改为 `glowStage.apply(renderer, scene, camera, cap.target)`（不建 composite-quad）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/threejs-player.test.ts tests/glow-stage.test.ts tests/rt-render.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/threejs-player.ts src/client/glow-stage.ts tests/threejs-player.test.ts tests/glow-stage.test.ts
git commit -m "feat(client): 段渲染骨架与 frameRT（无消费者时走现状路径）" -m "段间 autoClear=false 累积；消费者前拍快照；Glow 复用同一张 frameRT"
```

---

### Task 4: 粒子 REFRACT（首个真实消费者）

**Files:**
- Modify: `src/client/scene-assets.ts`（`ParticleMaterialRef` `:96-101`、`resolveParticleMaterial` `:107-138`）
- Modify: `src/client/three-renderer.ts`（槽 1 加载 + `addParticle({ refract })`）
- Modify: `src/client/threejs-player.ts`（`PARTICLE_VERTEX_SHADER` `:286-399`、`PARTICLE_FRAGMENT_SHADER` `:410-447`、uniforms `:1398-1434`、`ParticleLayer` `:49-79`、`addParticle` opts `:1285-1326`）
- Test: `tests/scene-assets.test.ts`、`tests/three-renderer.test.ts`、`tests/threejs-player.test.ts`

**Interfaces:**
- Produces（spec §4.1）：`ParticleMaterialRef` += `refract: boolean` / `normalTexUrl: string | null` / `refractAmount: number`
- Produces：`addParticle(opts)` += `refract?: { normalTex: THREE.Texture; amount: number }`
- Consumes：Task 3 的 `registerFrameConsumer(objectId)` 与段边界快照；Task 1 的 `capture()`

- [ ] **Step 1: 写失败测试（解析三态 + 护栏）**

`tests/scene-assets.test.ts`（**必须同步改写 `:44-47` 的 `toEqual` 全等断言**）：

```ts
it('REFRACT=1 + 槽1 ⇒ refract=true 且槽1 走同一条 particle-texture 路由', async () => { /* ... */ });
it('REFRACT=0 / 无 combos ⇒ refract=false（失败开放）', async () => { /* ... */ });
it('槽1 缺失 ⇒ refract=true 但 normalTexUrl=null', async () => { /* ... */ });
it('护栏：chromaticdot + additive + 无 combos ⇒ 不进 REFRACT 路径', async () => { /* ... */ });
it('refractAmount 缺省 0.05，显式值覆盖', async () => { /* ... */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scene-assets.test.ts`
Expected: FAIL（新字段不存在）

- [ ] **Step 3: 实现解析层与装配层**

`resolveParticleMaterial` 复用已有 `pass0`（`:118`）读 `combos?.REFRACT`、`textures?.[1]`、`constantshadervalues?.ui_editor_properties_refract_amount`；槽 1 走与槽 0 完全相同的 URL 拼法（**不加** `materials/`、不走 `resolveTexPath`）。`three-renderer.ts` 用 `loadTexTexture(mat.normalTexUrl)` 加载并传 `refract`；**槽 1 缺失或加载失败 ⇒ 该层 `visible=false`**（WE 的 `NORMALMAP=0` 语义），绝不回退白方块。

- [ ] **Step 4: 写失败测试（shader/uniform/帧序契约）**

`tests/threejs-player.test.ts` 追加：

```ts
it('折射层：defines.REFRACT===1、refractBg 指向快照、refractAmount===0.05', () => {
  // 取 addParticle 返回的 layer.material（或 scene.children 里的粒子 mesh）：
  //   material.defines.REFRACT === 1
  //   material.uniforms.refractAmount.value === 0.05
  //   material.uniforms.refractNormal.value === 传入的法线纹理
  // player.render() 之后：material.uniforms.refractBg.value === capture.capture() 返回的快照纹理
});
it('非折射层：defines.REFRACT===undefined、uniforms 里无 refractBg，且 render 次数与现状一致', () => { /* ... */ });
it('shader 文本契约（纯字符串断言）', () => {
  // 片元源必须包含：'#ifdef REFRACT'、'texture2D(refractNormal'、'vScreenCoord.xy / vScreenCoord.z'
  // 顶点源必须包含：'gl_Position.xyw'、'weObjectRotate(vec3(1.0, 0.0, 0.0)'
});
it('隔离层（opts.isolate 存在）不启用 REFRACT define', () => { /* ... */ });
it('槽1 缺失 ⇒ 该层不入 scene、不登记消费者（该层不可见而非白方块）', () => { /* ... */ });
it('折射层登记为消费者 ⇒ render() 走段渲染（≥2 次 render 且首段 target === capture.target）', () => { /* ... */ });
```

- [ ] **Step 5: 实现着色器与帧序**

按 spec §4.3 写 `#ifdef REFRACT` 段（顶点算 `vScreenCoord = gl_Position.xyw` 与 `vScreenTangents = refractAmount * vec4(rRight.x, rUp.x, rRight.y, rUp.y)`，`rRight/rUp` 复用既有 `weObjectRotate`；片元 `nx←nrm.a`、`ny←nrm.g`、`mask←nrm.r`、`off.y=-off.y`、`off*=mask*vParticleAlpha`、`rsUv = vScreenCoord.xy/vScreenCoord.z*0.5+0.5+off`、`rgb *= texture2D(refractBg, rsUv).rgb`）。uniform 三项默认给 1×1 白 / 0.05；`ParticleLayer` 加 `refract: boolean`；`addParticle` 在有 `refract` 时登记该对象的段边界消费者并把 `capture()` 结果写进 `refractBg`。加一条一次性诊断日志 `[three] refract layer=<id> bg=<w>x<h> amount=<a>`。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/scene-assets.test.ts tests/three-renderer.test.ts tests/threejs-player.test.ts tests/tex-loader.test.ts`
Expected: PASS

- [ ] **Step 7: 真库对照（可选，有先例）**

`tests/verify-real-library.test.ts` 追加：本机 `2897292240` 的 `materials/workshop/2446129945/particle/halo_50_1.json` ⇒ `refract=true` 且 `normalTexUrl` 非空；抽查其余壁纸的粒子材质 ⇒ `refract=false`（基线：`output/blur-analysis/refract-scan.json`）。本机素材缺失时该用例 skip（既有先例已这样处理）。

- [ ] **Step 8: 真机目视（需用户确认时机；产物改动留到 Task 6 统一提交）**

`npm run build && npm run build:client` 后加载 `2897292240`：白方块/白竖条消失、出现玻璃水滴；与 `output/blur-analysis/we-ab/` 的 WE 帧并排比对。**注意两点**：① 重建会经 client-hmr 热重载用户的在线会话，须先确认时机；② 本步产生的 `lib/`/`dist/` 改动**不要提交**，留到 Task 6 Step 7 统一重建提交。

- [ ] **Step 9: 提交（只提交源码与测试）**

```bash
git add src/client/scene-assets.ts src/client/three-renderer.ts src/client/threejs-player.ts tests/scene-assets.test.ts tests/three-renderer.test.ts tests/threejs-player.test.ts tests/verify-real-library.test.ts
git commit -m "feat(client): 粒子 REFRACT 采样背景做位移（玻璃水滴）" -m "按 genericparticle.frag:103-116 逐行对齐；槽1 缺失时该层不可见而非白方块"
```

---

### Task 5: 效果链消费者（`2597392171` godrays）

**Files:**
- Modify: `src/client/object-effects.ts`（`ObjectEffectHost` += `captureFullFrame()`；段边界同步执行 runner）
- Modify: `src/client/effect-runner.ts`（`resolveBuiltinTexture` `:68-97` 的 `_rt_` 分支、`update()` 增加 frameTexture 入参、`:723-732` 的未声明槽处理）
- Test: `tests/object-effects.test.ts`、`tests/effect-runner.test.ts`

**Interfaces:**
- Produces：`resolveBuiltinTexture(path, frameTexture?: THREE.Texture | null)` —— `_rt_FullFrameBuffer` 有捕获时返回它，否则维持 1×1 白 + 一次性告警；其它 `_rt_*` 名字不变。
- Consumes：Task 3 的段边界快照（整帧、UV 直采，**不做**对象 rect → 画布 UV 映射）。

- [ ] **Step 1: 写失败测试**

```ts
it('_rt_FullFrameBuffer 有快照时绑快照纹理（而非 1×1 白）', () => {
  // resolveBuiltinTexture('_rt_FullFrameBuffer', fakeTex) === fakeTex（同一引用）
});
it('无快照时仍返回白图并只告警一次（现状不变）', () => {
  // resolveBuiltinTexture('_rt_FullFrameBuffer') 返回 1×1 白；console.warn 只调用 1 次
});
it('其它 _rt_* 名字（_rt_Bloom / _rt_QuarterCompoBuffer1 / 派生名）保持白图', () => { /* ... */ });
it('godrays 链的 passes[4].textures[2] 绑到快照纹理（2597392171 场景 fixture）', () => { /* ... */ });
it('对象效果链在消费者段边界同帧执行（同帧快照，不落后一帧）', () => { /* object-effects */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/effect-runner.test.ts tests/object-effects.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`effect-runner.ts` 的 `_rt_` 分支改为：`_rt_FullFrameBuffer` 且有 `frameTexture` → `frameTexture`；否则现状。`object-effects.ts` 的 runner 调用纳入既有串行锁，并把 `captureFullFrame()` 透传。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/effect-runner.test.ts tests/object-effects.test.ts tests/threejs-player.test.ts`
Expected: PASS

- [ ] **Step 5: 真机目视（需用户确认时机）**

加载 `2597392171`：obj#50 `柯西` 的半透明区不再被压黑（`mix(bg, albedo, albedo.a)` 拿到真实背景）。

- [ ] **Step 6: 提交**

```bash
git add src/client/object-effects.ts src/client/effect-runner.ts tests/object-effects.test.ts tests/effect-runner.test.ts
git commit -m "feat(client): 效果链 _rt_FullFrameBuffer 绑帧快照（godrays 生效）" -m "段边界同帧执行，不落后一帧；无快照时维持白图 + 一次性告警"
```

---

### Task 6: 收口（全量测试、对拍、文档、产物）

**Files:**
- Modify: `AGENT.md`、`docs/fixes/conventions-details.md`、`docs/superpowers/specs/2026-10-13-frame-capture-refract-design.md`（回写实测与偏差）
- Modify: 必要时 `TESTING.md`（新增判据/命令）

- [ ] **Step 1: 全量单测**

Run: `npx vitest run`
Expected: 全绿；用例数 ≥ 基线 1118 + 本分支新增

- [ ] **Step 2: 零回归对拍**

`npm run build && npm run build:client`，然后用 `e2e/verify/compare-shots.mjs` 对**不含消费者**的壁纸（如 `3793620838`）改动前后逐像素对拍：`maxAbs ≤ 1` 且「差 ≥ 2 的像素数 = 0」。**改 `src/` 后必须先 build**（`verify-hidpi-object-rt.mjs:128-134` 无 src 重定向）。

- [ ] **Step 3: 7 个「粒子在前 image 在后」壁纸目视**

逐张确认叠加次序变化是改善（对齐 WE），把结论写进 spec 的执行附录。

- [ ] **Step 4: 性能记录**

记录 `2897292240` 在「段渲染开/关」下的帧时与显存（`renderer.info.memory.textures/geometries` + 帧时采样），写入 spec；若帧时退化 > 15% 则在 spec 记「半分辨率 frameRT」为后续优化项。

- [ ] **Step 5: 文档回写**

`AGENT.md`（模块职责 + 新不变量）、`docs/fixes/conventions-details.md`（段渲染/`autoClear` 约定、`_rt_FullFrameBuffer` 语义与消费点清单）、spec 回写实测数字与未闭合项。

- [ ] **Step 6: 提交**

```bash
git add AGENT.md docs/fixes/conventions-details.md docs/superpowers/specs/2026-10-13-frame-capture-refract-design.md TESTING.md
git commit -m "docs: 回写段渲染/帧快照口径与实测" -m "含零回归对拍、7 张叠加次序变化目视结论、性能数字"
```

- [ ] **Step 7: 重建产物（用户确认时机后）**

`npm run build && npm run build:client`，提交 `lib/` 与 `dist/`（会经 client-hmr 热重载用户在线会话，**必须先确认时机**）。

---

## 后续任务（本轮不做，已记入 spec §8）

1. `_rt_imageLayerComposite_*` 对象结果池（7 处）。
2. 对象材质 `BLENDMODE` 的 `_rt_FullFrameBuffer` 消费点（161 材质）。
3. JSONC 引擎 effect.json 容错（6 个文件，DSH 严格 `JSON.parse` 会让整链失效）。
4. `general.clearcolor` 消费。
5. 半分辨率 `frameRT` 与 (E) 式「无重复光栅化」的两段式渲染。
