# DSH 壁纸渲染全部问题修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 dsh-wallpaper-engine 与 open-wallpaper-engine 逻辑对比暴露的全部渲染问题：白色粒子伪影（P0）、对象效果链全屏错误（P1）、wasm 动画缺失（P2）、脚本/音频/text 对象缺失（P3）、次要字段差异（P4）。

**Architecture:** 五个独立 Phase，各自可独立测试与提交。P0 为粒子 alpha 属性链（JS + wasm 双渲染器补齐 `alpharandom`/寿命衰减），P1 推翻 Ruling 5 全屏展平、改为对象级效果链（每带效果对象独立 RT + 局部效果链 + 贴回合成，对齐 open-wallpaper-engine 的 Layer/CompositeTarget 语义），P2 先让 wasm 检测到效果链即回退 JS 渲染器（动画不再 STATIC）、wasm 内后处理管线列为后续独立计划，P3 补音频输入（Web Audio 频谱）、WE 脚本内置模式识别（Simple Visualizer/VHS）、text 对象渲染，P4 补 alignment/visible/color 等字段。

**Tech Stack:** TypeScript strict ESM、Three.js（WebGL2）、Rust wasm-bindgen + wgpu、vitest（node + jsdom）、wasm-pack `--target web`。

**Spec:**
- `docs/superpowers/specs/2026-08-18-dsh-wallpaper-engine-effects-design.md`（现有效果链设计，本文 P1 推翻其 Ruling 5 全屏展平与 §9"对象级局部 RT 非目标"）
- `docs/superpowers/specs/2026-08-19-we-scene-wasm-renderer-design.md`（wasm 渲染器设计）
- `research/open-wallpaper-engine/src/Scene/Pkg/Parse/Particle/ParticleParser.cpp`（粒子 alpha 属性链参考实现）
- `research/open-wallpaper-engine/src/Scene/VulkanRender/SceneToRenderGraph.cpp`（对象级效果链参考实现）
- 根因分析：2026-08-21 会话（白色伪影=粒子 alpha 忽略；动画缺失=wasm 无效果链+无脚本+无音频；效果错误=效果链全屏展平）

## Global Constraints

- 注释、提交信息、文档使用简体中文；代码/命令/文件名保留原文。
- **坐标约定（AGENT.md §2.3，勿再翻转）**：WE 左下原点 y 向上；`three.x = we.x - vw/2`、`three.y = we.y - vh/2`；禁止 `scale.y` 取负（负 scale.y 的镜像语义由 P4.4 专门处理）。
- TDD：每个任务先写失败测试 → 确认失败 → 最小实现 → 确认通过 → 提交。
- 单测：`npx vitest run`（包目录）；wasm native：`cargo test`（wasm/ 目录，无 render feature）。
- 构建：`npm run build` + `npm run build:client`；wasm：`wasm-pack build --target web --release --features render`（必须 `--target web`，AGENT.md §5.1）。
- 集成：改完代码后按 AGENT.md §3.1 复制构建产物到 profile，刷新 `http://127.0.0.1:3080`；host 侧（`lib/`）需重启 dsh web。
- 全库回归：`tests/verify-real-library.test.ts`（24 个 scene 壁纸解析零失败）+ `node research/verify-wasm-render.mjs`（WebGPU/JS 双模式）。
- 粒子 WASM uniform 布局（std140）：修改 `EmitterParams` 时必须同步 Rust `particle_pass.rs` 与两个 wgsl（`particle_compute.wgsl`/`particle_render.wgsl`）三处，并保持 16 字节对齐。
- 每个 Phase 结束提交一次（含测试）；Phase 内每个 Task 独立提交。

---

## Phase 0：粒子 alpha 属性链（修复白色三角形伪影）

**问题根因：** WE 粒子系统支持 `alpharandom`（fog1=0.15-0.2）与 `alphafade` 操作符（参考实现 `ParticleParser.cpp` 的 `AlphaRandomProgram`/`AlphaFadeOperator`）；dsh 的 JS 粒子（`particles.ts`/`scene-renderer.ts`）与 wasm 粒子（`particle.rs`/`particle_compute.wgsl`/`particle_render.wgsl`）**均无 alpha 字段**，粒子 alpha 恒为 1（JS 的 `vLife = 1.0` 硬编码）→ 大尺寸白色雾粒子（1000-2200px × scale 2.15）渲染为不透明白块，屏幕裁剪后呈三角形/扇形伪影。

**验收标准：** 2937346640/2597392171 等雾粒子壁纸左侧白色伪影消失；粒子呈半透明雾状（Fog alpha≈0.15-0.2 随寿命淡出）。

### Task 0.1：JS 粒子规格解析 alpha（scene-assets.ts）

**Files:**
- Modify: `src/client/scene-assets.ts`（`particlesFromSpec`）
- Modify: `src/client/particles.ts`（`ParticleInitializerSpec`、`Particle`、`spawn`、`syncBuffers`）
- Test: `tests/particles.test.ts`

**Interfaces:**
- Produces: `ParticleInitializerSpec` 新增 `alphaMin?: number; alphaMax?: number`；`Particle` 新增 `alpha: number`（初始 alpha）与 `initialAlpha: number`（寿命衰减基准）

- [ ] **Step 1: 写失败测试**（`tests/particles.test.ts` 追加）

```ts
import { particlesFromSpec } from '../src/client/scene-assets.js';

it('解析 alpharandom → alphaMin/alphaMax', () => {
  const spec = particlesFromSpec(JSON.parse(JSON.stringify({
    emitter: [{ rate: 1.5 }],
    initializer: [
      { name: 'lifetimerandom', min: 3, max: 5 },
      { name: 'alpharandom', min: 0.15, max: 0.2 },
    ],
  })));
  expect(spec?.init.alphaMin).toBe(0.15);
  expect(spec?.init.alphaMax).toBe(0.2);
});

it('无 alpharandom 时 alpha 缺省 1', () => {
  const spec = particlesFromSpec({ emitter: [{ rate: 1 }], initializer: [] });
  expect(spec?.init.alphaMin).toBeUndefined();
});
```

- [ ] **Step 2: 运行确认失败** — `npx vitest run tests/particles.test.ts`
  Expected: FAIL（`alphaMin` 为 undefined）

- [ ] **Step 3: 最小实现**

`src/client/particles.ts`：
```ts
export interface ParticleInitializerSpec {
  // …现有字段…
  alphaMin?: number; alphaMax?: number;
}
interface Particle {
  // …现有字段…
  initialAlpha: number; alpha: number;
}
// spawn() 内：
const amn = init.alphaMin ?? 1, amx = init.alphaMax ?? 1;
// …push({…, initialAlpha: randIn(amn, amx), alpha: randIn(amn, amx)})
```
`src/client/scene-assets.ts` `particlesFromSpec`：
```ts
const alpha = inits.find((i: any) => i.name === 'alpharandom');
// init 返回对象追加：
alphaMin: alpha ? Number(alpha.min ?? 1) : undefined,
alphaMax: alpha ? Number(alpha.max ?? 1) : undefined,
```

- [ ] **Step 4: 运行确认通过** — `npx vitest run tests/particles.test.ts`
  Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-wallpaper-engine/src/client/scene-assets.ts packages/dsh-wallpaper-engine/src/client/particles.ts packages/dsh-wallpaper-engine/tests/particles.test.ts
git commit -m "feat: 粒子规格解析 alpharandom(alphaMin/Max)"
```

### Task 0.2：JS 粒子渲染 alpha（scene-renderer.ts）

**Files:**
- Modify: `src/client/scene-renderer.ts`（`addParticleSystem` 的 BufferGeometry 与 ShaderMaterial）
- Test: `tests/particles.test.ts`（衰减纯函数）

**Interfaces:**
- Consumes: Task 0.1 的 `Particle.initialAlpha`/`alpha`
- Produces: 粒子几何新增 `aAlpha`（Float32Array，每帧 = `initialAlpha * (life/maxLife)`）；shader 顶点输出 `vLife = aAlpha`

- [ ] **Step 1: 写失败测试**（`tests/particles.test.ts` 追加：抽取寿命衰减纯函数）

```ts
// 导出纯函数（便于 node 测试）：alphaAt(initialAlpha, life, maxLife) = initialAlpha * clamp(life/maxLife, 0, 1)
import { alphaAt } from '../src/client/particles.js';
it('alpha 随寿命线性衰减', () => {
  expect(alphaAt(0.2, 4, 5)).toBeCloseTo(0.16, 5);
  expect(alphaAt(0.2, 0, 5)).toBe(0);
});
```

- [ ] **Step 2: 运行确认失败** — `npx vitest run tests/particles.test.ts`

- [ ] **Step 3: 最小实现**

`src/client/particles.ts` 导出：
```ts
export function alphaAt(initialAlpha: number, life: number, maxLife: number): number {
  return initialAlpha * Math.max(0, Math.min(1, life / Math.max(1e-6, maxLife)));
}
```
`syncBuffers()` 追加 `alphas` 缓冲写入（`alphaAt(p.initialAlpha, p.life, p.maxLife)`）。

`src/client/scene-renderer.ts` `addParticleSystem`：
- `geometry.setAttribute('aAlpha', new THREE.BufferAttribute(system.alphas(), 1))`（`system.alphas()` 返回 Float32Array，仿照 `sizes()`）
- 顶点着色器：`attribute float aAlpha; varying float vLife; … vLife = aAlpha;`（替换硬编码 `vLife = 1.0`）
- 帧循环 `frame()` 内：`ps.points.geometry.attributes.aAlpha.needsUpdate = true;`

- [ ] **Step 4: 运行确认通过** — `npx vitest run tests/particles.test.ts`
  Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-wallpaper-engine/src/client/particles.ts packages/dsh-wallpaper-engine/src/client/scene-renderer.ts packages/dsh-wallpaper-engine/tests/particles.test.ts
git commit -m "fix: JS 粒子 alpha 渲染(alpharandom + 寿命衰减，消除白色雾块)"
```

### Task 0.3：wasm 粒子 alpha（Rust 解析 + uniform + 双 wgsl）

**Files:**
- Modify: `wasm/src/particle.rs`（`InitSpec` 增 `alpha_min/alpha_max`；`parse_particle_spec` 解析 `alpharandom`）
- Modify: `wasm/src/render/particle_pass.rs`（`EmitterParams` 布局重排：`dt` 后加 `alpha_min/alpha_max`，补 pad 至 176B；`from_spec` 填充；`PARTICLE_BYTES` 复核）
- Modify: `wasm/src/shaders/particle_compute.wgsl`（uniform 增字段；`Particle` 增 `alpha: f32`@40；spawn 生成 alpha；存活衰减）
- Modify: `wasm/src/shaders/particle_render.wgsl`（uniform 增字段；`v_life_alpha = clamp(life/max_life,0,1) * part.alpha`）
- Test: `wasm/tests/`（native cargo test）

**Interfaces:**
- Consumes: Task 0.1 语义（`alpharandom` min/max，缺省 1.0）
- Produces: `EmitterParams` 新布局（176B，11×vec4：`origin/scale`、`rate…elapsed`、`directions+pad`、`life/size`、`vel_min+pad`、`vel_max+pad`、`color_min+pad`、`color_max+pad`、`dt/max_particles/alpha_min/alpha_max`→实为 3 f32 + pad）；`Particle` WGSL 结构 stride 保持 64（`alpha`@40，`color: vec3f`@48）

- [ ] **Step 1: 写失败测试**（`wasm/tests/` 下新增或追加 native 测试）

```rust
// tests/particle_alpha_tests.rs（或 wasm/src 内 #[cfg(test)] 模块）
#[test]
fn parse_alpha_random() {
    let json = r#"{"emitter":[{"rate":1.5}],"initializer":[
        {"name":"alpharandom","min":0.15,"max":0.2}]}"#;
    let spec = crate::particle::parse_particle_spec(json);
    assert!((spec.init.alpha_min - 0.15).abs() < 1e-6);
    assert!((spec.init.alpha_max - 0.2).abs() < 1e-6);
}
#[test]
fn emitter_params_layout_176() {
    assert_eq!(std::mem::size_of::<crate::render::particle_pass::EmitterParams>(), 176);
}
```

- [ ] **Step 2: 运行确认失败** — `cargo test`（wasm/ 目录）
  Expected: FAIL（`alpha_min` 不存在 / 布局 160 ≠ 176）

- [ ] **Step 3: 最小实现**

`particle.rs`：
```rust
pub struct InitSpec {
    // …现有字段…
    pub alpha_min: f32,
    pub alpha_max: f32,
}
// parse 内：
let alpha = inits.iter().find(|i| i.name.as_deref() == Some("alpharandom"));
// InitSpec { … alpha_min: alpha.and_then(|i| i.min.as_ref()).map(|v| scalar(v, 1.0)).unwrap_or(1.0), … }
```

`particle_pass.rs` `EmitterParams` 尾部改为：
```rust
pub dt: f32,
pub max_particles: u32,
pub alpha_min: f32,
pub alpha_max: f32,
pub _pad8: u32,
```
（Rust 侧 52 f32 + 2 u32 布局 → repr(C) 对齐后 176B；`from_spec` 从 `init.alpha_min/alpha_max` 填充）

`particle_compute.wgsl`：
```wgsl
// uniform struct 尾部：
dt: f32, max_particles: u32, alpha_min: f32, alpha_max: f32,
struct Particle { pos: vec3f, vel: vec3f, life: f32, max_life: f32, size: f32, alpha: f32, color: vec3f }
// spawn 分支：
alpha: p.alpha_min + rand(seed+13u) * max(p.alpha_max - p.alpha_min, 0.0),
// 存活衰减（cur 写入前）：
cur.alpha = clamp(cur.life / max(cur.max_life, 0.0001), 0.0, 1.0) * cur.alpha;
// 注意：cur.alpha 需存 initial alpha；衰减写法：先按当前 life 比例衰减，但初始 alpha 会随帧递减——
// 正确做法：Particle 增加 initial_alpha 或每帧用 max_life 重算。推荐：spawn 时 alpha 存初始值，
// 渲染侧计算 life 比例。compute 不衰减 alpha（避免累积误差）。
```

`particle_render.wgsl`：
```wgsl
// Particle 结构同步加 alpha@40（stride 仍 64）
out.v_life_alpha = clamp(part.life / max(part.max_life, 0.0001), 0.0, 1.0) * part.alpha;
```

- [ ] **Step 4: 运行确认通过** — `cargo test`
  Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-wallpaper-engine/wasm/src/particle.rs packages/dsh-wallpaper-engine/wasm/src/render/particle_pass.rs packages/dsh-wallpaper-engine/wasm/src/shaders/particle_compute.wgsl packages/dsh-wallpaper-engine/wasm/src/shaders/particle_render.wgsl
git commit -m "fix: wasm 粒子 alpha(alpharandom + 寿命衰减，对齐 JS 版)"
```

### Task 0.4：Phase 0 全库回归

**Files:**
- Run: `npx vitest run`（包目录全量）
- Run: `node research/verify-wasm-render.mjs` 与 `--no-webgpu`（需浏览器环境，见注意事项）

- [ ] **Step 1: 全量单测** — `npx vitest run`
  Expected: 全部 PASS（含 `verify-real-library.test.ts` 24 壁纸解析零失败）
- [ ] **Step 2: 构建 + 同步 profile** — `npm run build && npm run build:client`，按 AGENT.md §3.1 复制 `lib/` 与 `dist/` 到 profile（wasm 构建见 Global Constraints）
- [ ] **Step 3: 浏览器验证** — 刷新 GUI 切到 2937346640，目检左侧白色伪影消失、雾呈半透明；`verify-wasm-render.mjs`（如环境可跑）判定 2937346640/2597392171 无异常
- [ ] **Step 4: 提交**（如有调整个别文件）

```bash
git add -A
git commit -m "test: Phase 0 粒子 alpha 全库回归"
```

---

## Phase 1：对象级效果链（消除全屏摇晃/错误效果）

**问题根因：** `renderScene` 把所有对象 effects `flatMap` 展平、`EffectRunner` 在**全屏 RT** 上 ping-pong 执行（Ruling 5）。open-wallpaper-engine（`SceneToRenderGraph.cpp`）中每个带 Layer 的对象渲染到**自己的中间 RT**，效果链输入 `_rt_xxx` = 对象自身输出，最终合成到场景。dsh 全屏执行导致：foliagesway（对象级植物摆动）全屏位移 → 整屏摇晃；godrays 的 `target:_rt_HalfCompoBuffer*` 半分辨率 + `bind` 语义丢失 → 体积光错误；iris 全屏执行。

**设计决策（本 Phase 推翻了 spec §9"对象级局部 RT 非目标"）：**
1. 每个带效果的 image 对象：渲染到**对象 RT**（分辨率 = `min(对象像素尺寸×scale, 2048)` 上限，防 6144px 巨纹理爆显存）→ 执行该对象自己的效果链（输入 = 对象 RT，输出 ping-pong）→ 结果以 quad 贴回场景（场景坐标 = 对象中心，尺寸 = 对象尺寸×scale）。
2. **对象 RT 相机**：正交，范围 = 对象尺寸×scale（中心原点），对象 quad 恰好铺满 RT → 效果链的 UV 0-1 与 mask 纹理（foliagesway_mask/iris_mask）对齐对象局部空间。
3. **EffectRunner 改造**：`update(time, inputTexture, outTexture?)` 参数化（不依赖内部场景 RT）；链按对象分组执行，共享 ping-pong RT 池。
4. 粒子对象带效果：粒子在局部相机下渲染到对象 RT（复用粒子 Points，相机范围 = 对象 bbox）→ 效果 → 贴回。
5. 背景层（bg canvas）：渲染对象级效果后的完整场景（cover），保持模糊填充语义。
6. 无效果对象路径不变（直接进场景 RT）。

**验收标准：** 1429403119（Orange，24 效果）不再整屏摇晃/模糊，各对象效果只作用于自身区域；2937346640 的 foliagesway 仅植物区域摆动、iris 仅眼部区域。

### Task 1.1：EffectRunner 输入/输出参数化

**Files:**
- Modify: `src/client/effect-runner.ts`（`update`、`lastOutput`、`setChains`）
- Test: `tests/effect-runner.test.ts`

**Interfaces:**
- Consumes: `CompiledEffectPass`（effect-chain.ts，不变）
- Produces: `update(time: number, input: THREE.WebGLRenderTarget | THREE.Texture): THREE.Texture | null`；`setChains(chains, id, opts?: { width?: number; height?: number })`（对象 RT 尺寸）

- [ ] **Step 1: 写失败测试**（`tests/effect-runner.test.ts`；纯逻辑断言 `resolveTextureSlotPath` 等已有；本任务测试 `update` 的输入参数化无法在 jsdom 跑 WebGL → 抽出纯函数）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — `update(time, input)` 接受任意纹理（首 pass `g_Texture0` = input）；RT 尺寸由 `setChains` 的 opts 决定；`lastOutput()` 语义保留（最近完成输出）
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** — `git commit -m "refactor: EffectRunner 输入输出参数化(支持对象级 RT)"`

### Task 1.2：对象 RT 渲染与局部相机

**Files:**
- Modify: `src/client/scene-renderer.ts`（新增对象 RT 渲染路径）
- Test: `tests/scene-renderer.test.ts`（局部相机范围纯函数）

**Interfaces:**
- Produces: `objectCameraRange(objSize: [number,number], scale: [number,number]): {w,h}`（正交范围 = size×scale）；`createObjectRenderTarget(w,h): THREE.WebGLRenderTarget`

- [ ] **Step 1: 写失败测试** — 断言 `objectCameraRange([4,4],[2.36,2.36])` → `{w:9.44,h:9.44}`；尺寸上限钳制 2048
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — `renderScene` 中带效果 image 对象走对象 RT 渲染：局部正交相机（范围 = size×scale，中心原点）+ 单对象渲染到对象 RT；无效果对象保持场景 RT 路径
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 对象级 RT 渲染与局部相机(尺寸钳制 2048)"`

### Task 1.3：对象级效果链执行 + 贴回合成

**Files:**
- Modify: `src/client/scene-renderer.ts`（`renderScene` 效果链分组；贴回 quad）
- Test: `tests/scene-renderer.test.ts`（效果分组纯函数 `groupEffectsByObject`）

**Interfaces:**
- Consumes: Task 1.1 的 `update(time, input)`、Task 1.2 的局部相机
- Produces: `groupEffectsByObject(objects): { obj, effects }[]`（过滤空 effects；保持对象顺序）

- [ ] **Step 1: 写失败测试** — 断言 `groupEffectsByObject` 对 2937346640 结构（主图 4 效果、其余无）返回 1 组；效果顺序不展平
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — 每带效果对象：`effectRunner.update(time, 对象RT)` → 输出纹理贴到场景 quad（世界坐标 = 对象中心，尺寸 = size×scale，UV 局部）；共享一个 runner 实例 + 每对象 `setChains` 后立即 `update`（对象链短，异步纹理槽加载沿用 `updateInFlight` 串行化）；背景层渲染对象级效果后的完整场景
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 对象级效果链执行与贴回合成(替换全屏展平)"`

### Task 1.4：粒子对象效果支持

**Files:**
- Modify: `src/client/scene-renderer.ts`（粒子对象带效果路径）
- Test: `tests/scene-renderer.test.ts`

**Interfaces:**
- Consumes: Task 1.2 局部相机（粒子对象用 bbox 范围）
- Produces: 粒子对象效果与 image 对象同路径（粒子渲染到对象 RT → 效果 → 贴回）

- [ ] **Step 1: 写失败测试** — 断言粒子对象带 effects 时走对象 RT 分支（可测的调度纯函数）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — `addParticleSystem` 结果在对象 RT 上渲染（局部相机），效果链输出贴回场景
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 粒子对象级效果链支持"`

### Task 1.5：Phase 1 回归与目检

- [ ] **Step 1:** `npx vitest run` 全绿
- [ ] **Step 2:** 构建 + 同步 profile（含 wasm 重建）
- [ ] **Step 3:** 浏览器目检：1429403119 无整屏摇晃（各对象效果局部生效）；2937346640 foliagesway 仅植物摆动；2911105183 waterwaves 正常
- [ ] **Step 4:** `verify-wasm-render.mjs` 双模式无回归（OK 壁纸不转 BLACK）
- [ ] **Step 5:** 提交 — `git commit -m "test: Phase 1 对象级效果链回归"`

---

## Phase 2：wasm 动画支持

**问题根因：** wasm 渲染器只有静态图片 quad + GPU 粒子，**无效果链执行器**（AGENT.md §2.1 已知局限）→ godrays/foliagesway/iris 等动画壁纸在 wasm 下 STATIC。

**设计决策：** 分两步。**第一步（本 Phase）务实方案**：wasm-renderer 检测场景含效果链 → 返回 false → controller 重建 canvas 走 JS 渲染器（Phase 1 后 JS 已对象级正确）→ 动画壁纸自动获得效果链动画；纯静态/纯粒子壁纸继续走 wasm（性能优势保留）。**第二步（后续独立计划）**：wasm 内 WGSL 后处理管线（需把 WE GLSL 方言翻译为 WGSL，工作量与 Phase 1 同级，不在本计划展开）。

**验收标准：** 2937346640 在 WebGPU 浏览器下不再 STATIC（走 JS 渲染器出动画）；1968789468/2236329190/3743126786/3760200530（waterwaves/shake/waterflow 壁纸）同样出效果。

### Task 2.1：wasm 效果链检测 → 回退 JS

**Files:**
- Modify: `src/client/wasm-renderer.ts`（`render` 内检测）
- Test: `tests/wasm-renderer.test.ts`

**Interfaces:**
- Consumes: `parseSceneJson`（scene-json.ts）的 `desc.objects[].effects`
- Produces: `hasEffectChains(desc): boolean`（任一对象 `effects?.length > 0`）

- [ ] **Step 1: 写失败测试** — `hasEffectChains` 对含 effects 的对象返回 true；对无 effects 返回 false
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — `render()` 拉取 scene.json 解析后先 `if (hasEffectChains(desc)) return false;`（在创建 `WeScene` 之前，避免绑定 WebGPU canvas；组合层已有 canvas 重建回退逻辑）
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: wasm 检测效果链回退 JS 渲染器(动画壁纸不再 STATIC)"`

### Task 2.2：Phase 2 回归

- [ ] **Step 1:** `npx vitest run` 全绿
- [ ] **Step 2:** 构建 + 同步 profile
- [ ] **Step 3:** 浏览器验证 WebGPU 路径下 2937346640/1429403119 有效果动画；纯静态壁纸（2212665284/2859263090）仍走 wasm
- [ ] **Step 4:** 提交 — `git commit -m "test: Phase 2 wasm 回退链回归"`

---

## Phase 3：脚本 + 音频 + text 对象

**问题根因：** WE 场景对象可携带脚本（`visible.script`/`text.script`，JS API：`createLayer`/`registerAudioBuffers`/`scriptProperties`）与音频（`sound` 字段）；dsh 完全无脚本引擎、无音频输入、text 对象被当作空粒子跳过 → Simple Visualizer（64 个音频驱动条）、VHS Time and Date（实时时钟文本）、壁纸音乐全部缺失。

**设计决策：**
1. **音频**：新增 `audio-input.ts`，用 Web Audio 播放壁纸自带 `sound` 音频 + `AnalyserNode` 频谱（64 bin）→ 每帧喂给 EffectRunner 的 `g_AudioSpectrum*` 数组（替换全零静音）。
2. **脚本**：不做通用 JS 引擎，**内置模式识别**——解析 `visible.script`/`text.script` 源码特征：
   - `registerAudioBuffers` + `createLayer('models/bar.json')` → 识别为 Simple Visualizer 模式：引擎直接创建 N 个 bar image 对象（复用 bar.json 材质），每帧按音频电平更新 `scale.y`/`origin`；
   - `new Date()` + 月份数组 → 识别为时钟文本模式：每帧用 JS `Date` 生成文本。
3. **text 对象**：新增 `text-object.ts`：`CanvasTexture` 渲染文本（font/pointsize/align/color）→ quad（尺寸 = `size` 字段）。

**验收标准：** 2937346640 左下角出现音频驱动的可视化条（随壁纸音乐跳动）、右上角出现 VHS 风格时间日期、壁纸音乐可播放；音频可视化壁纸（`Simple_Audio_Bars`×3）频谱驱动。

### Task 3.1：text 对象渲染（VHS 时间日期基础）

**Files:**
- Create: `src/client/text-object.ts`（`renderTextObject(tex 工厂)`、`createTextTexture(text, opts): THREE.CanvasTexture`）
- Modify: `src/client/scene-renderer.ts`（`renderScene` 增加 text 分支——需 `scene-json.ts` 先识别 text 对象）
- Modify: `src/client/scene-json.ts`（`SceneTextObject` 归类：有 `text` 字段的对象 → `kind:'text'`，保留 `font`/`pointsize`/`size`/`alignment`）
- Modify: `src/shared/types.ts`（新增 `SceneTextObject`）
- Test: `tests/scene-json.test.ts`、`tests/text-object.test.ts`（jsdom 可测 CanvasTexture 创建）

**Interfaces:**
- Produces: `SceneTextObject { kind:'text'; text: string; font?: string; pointsize?: number; … }`；`createTextTexture(text, {font,size,color,width,height}): THREE.CanvasTexture`

- [ ] **Step 1: 写失败测试** — `parseSceneJson` 将 2937346640 的 id=182（含 `text` 字段）归为 `kind:'text'`；`createTextTexture` 返回宽高正确的 CanvasTexture（jsdom + canvas mock）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — scene-json 归类 + text-object 纹理生成 + renderScene 渲染 text 对象 quad（静态文本：`text.value` 直用）
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: text 对象渲染(静态文本)"`

### Task 3.2：音频输入管线（频谱驱动）

**Files:**
- Create: `src/client/audio-input.ts`（`createAudioAnalyzer()`：AudioContext + AnalyserNode + 频谱缓冲）
- Modify: `src/client/effect-runner.ts`（`g_AudioSpectrum*` uniform 从全零改为实时频谱）
- Test: `tests/audio-input.test.ts`（jsdom 下 AudioContext mock 断言缓冲结构）

**Interfaces:**
- Produces: `createAudioAnalyzer(): { context: AudioContext; analyser: AnalyserNode; freqData: Uint8Array; update(): void } | null`（无 AudioContext 返回 null）
- Consumes: EffectRunner 的音频 uniform（`g_AudioSpectrum{N}Left/Right`，长度按 combo `RESOLUTION`）

- [ ] **Step 1: 写失败测试** — mock `AudioContext`/`AnalyserNode` 断言 `update()` 填充 64 bin 频谱缓冲；无 AudioContext 返回 null
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — audio-input + EffectRunner 每帧注入 `freqData`（归一化 0-1）到音频 uniform；无音频源时保持全零（不回归）
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 音频频谱输入(EffectRunner 音频 uniform 实时化)"`

### Task 3.3：Simple Visualizer 模式识别（脚本内置实现）

**Files:**
- Create: `src/client/script-patterns.ts`（`detectScriptPattern(scriptSrc): 'visualizer' | 'clock' | null`；`parseScriptProperties(src): Record<string, unknown>`）
- Modify: `src/client/scene-renderer.ts`（visualizer 模式：创建 N bar 对象 + 音频驱动更新）
- Modify: `src/client/scene-json.ts`（解析 `visible`/`text` 的 `script` 字段与 `scriptproperties`）
- Test: `tests/script-patterns.test.ts`（用 2937346640 真实脚本 fixture 断言识别 + 属性解析）

**Interfaces:**
- Consumes: Task 3.2 频谱数据；`ParticleInitializerSpec` 等现有解析
- Produces: `detectScriptPattern(src): 'visualizer' | 'clock' | null`；`visualizerSpec`（bar 数=音频缓冲数 64、scriptproperties.barWidth/originX/scaleY）

- [ ] **Step 1: 写失败测试** — 2937346640 的 Simple Visualizer 脚本 → `'visualizer'` 且解析出 `barWidth=0.83/originX=12.67/scaleY=23.89`；VHS 时间脚本 → `'clock'`
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — 模式识别 + visualizer 内置：`renderScene` 遇 `'visualizer'` 对象创建 64 条（几何 = bar.json 材质纹理），每帧 `scale.y = freq[i] * scaleY`、`origin.x += originX`（对齐脚本语义；alignment 锚点见 Phase 4.1）；clock 模式：每帧更新 text 纹理
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: Simple Visualizer/时钟脚本模式内置实现(音频驱动)"`

### Task 3.4：壁纸音频播放（sound 字段）

**Files:**
- Modify: `src/client/scene-json.ts`（解析 `sound` 字段 → `SceneDescription.sounds: string[]`）
- Modify: `src/client/audio-input.ts`（`playWallpaperSound(url)`：fetch + AudioBufferSourceNode + 接 Analyser）
- Modify: `src/client/scene-renderer.ts`（`renderScene` 调 `playWallpaperSound`）
- Test: `tests/scene-json.test.ts`、`tests/audio-input.test.ts`

**Interfaces:**
- Consumes: Task 3.2 的 `createAudioAnalyzer`
- Produces: `playWallpaperSound(url, analyzer)`：加载音频、播放、频谱接入（失败静默，不阻断渲染）

- [ ] **Step 1: 写失败测试** — `parseSceneJson` 解析 `sound` 数组（2937346640 id=35 → `['sounds/yutaka hirasaka - acro.flac']`）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — scene-json 解析 + 播放接入（autoplay 被拦 → 用户手势后尝试恢复）
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 壁纸音频播放接入频谱"`

### Task 3.5：Phase 3 回归与目检

- [ ] **Step 1:** `npx vitest run` 全绿
- [ ] **Step 2:** 构建 + 同步 profile
- [ ] **Step 3:** 浏览器目检 2937346640：左下可视化条随音乐跳动、右上 VHS 时间走字、音乐可播；音频可视化壁纸频谱驱动
- [ ] **Step 4:** 提交 — `git commit -m "test: Phase 3 脚本/音频/text 回归"`

---

## Phase 4：次要字段差异

**问题根因：** dsh 忽略 WE 对象字段：`alignment`（origin 锚点）、`visible` 用户/脚本绑定、对象级 `color/alpha/brightness`、负 `scale.y`（镜像）。参考实现：`ImageObject.cpp`（alignment/color/alpha/brightness）、`SceneObjectExpansion.cpp`（可见性绑定解析）。

**验收标准：** Simple Visualizer 位置正确（bottomright 锚点）；依赖用户属性可见性的对象遵循设置；对象着色/透明度正确；负 scale 镜像（2460786246 Lightning cloud）。

### Task 4.1：alignment 锚点

**Files:**
- Modify: `src/client/scene-json.ts`（`alignment` 字段 → `SceneImageObject.alignment`）
- Modify: `src/client/scene-renderer.ts` 与 `wasm/src/render/mod.rs`/`wasm-renderer.ts`（origin 锚点偏移：`center = origin - alignmentOffset * size`，9 种 WE 对齐）
- Test: `tests/scene-json.test.ts`、`wasm/src/coords.rs` native 测试

- [ ] **Step 1: 写失败测试** — `alignmentOffset('bottomright')` → `[-0.5,-0.5]`（场景像素偏移量 = size×offset）；scene-json 解析 2937346640 id=61 → `'bottomright'`
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — 渲染器按 alignment 计算锚点偏移（JS + wasm 双路径）
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 对象 alignment 锚点支持(9 种对齐)"`

### Task 4.2：可见性绑定（user/script）

**Files:**
- Modify: `src/client/scene-json.ts`（`visible` 解析：`{user,value}` / `{script,value}` → `SceneObject.visible`）
- Modify: `src/client/scene-renderer.ts`（user 绑定 → 读取插件设置；script 绑定 → Phase 3 模式识别后求值）
- Test: `tests/scene-json.test.ts`

**Interfaces:**
- Consumes: `src/client/settings.ts`（用户属性值）
- Produces: `resolveVisibility(obj, userProps): boolean`

- [ ] **Step 1: 写失败测试** — `visible:{user:'timeand',value:true}` 解析为 user 绑定；无绑定默认可见
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — 解析 + 渲染前过滤不可见对象（user 绑定读设置；脚本绑定先按 Phase 3 识别）
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 对象可见性绑定(user/script)"`

### Task 4.3：对象 color/alpha/brightness 调制

**Files:**
- Modify: `src/client/scene-json.ts`（`color`/`alpha`/`brightness` → `SceneImageObject`）
- Modify: `src/client/scene-renderer.ts`（MeshBasicMaterial 的 color/opacity 调制）
- Modify: `wasm/src/shaders/image.wgsl` 与 `wasm/src/render/mod.rs`（ImageUniform 增调制系数）
- Test: `tests/scene-json.test.ts`、`wasm` native 布局测试

**Interfaces:**
- Produces: `SceneImageObject.color?: [n,n,n]; alpha?: number; brightness?: number`；调制 = 纹理 × color × brightness、α × alpha（WE 语义：alpha 0-1 或 0-100 归一化）

- [ ] **Step 1: 写失败测试** — 解析字段 + 归一化（`NormalizeLayerAlpha`：>1 除 100）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — JS/wasm 双路径材质调制
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 对象 color/alpha/brightness 调制"`

### Task 4.4：负 scale.y 镜像

**Files:**
- Modify: `src/client/scene-renderer.ts` 与 `wasm/src/coords.rs`（`particle_scale`/`image_ndc` 处理负 scale.y 镜像）
- Test: `tests/particles.test.ts`、`wasm` native 测试

**Interfaces:**
- Produces: 负 scale.y → 渲染镜像（UV y 翻转或 quad 顶点翻转），不改变坐标映射约定

- [ ] **Step 1: 写失败测试** — `image_ndc` 对 `scale.y=-0.18` 输出 y 镜像标记
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — shader UV y 翻转（JS：`texture.flipY` 或 UV 翻转；wasm：vs 输出 y 取反 + uv 调整）
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 负 scale.y 镜像渲染"`

### Task 4.5：Phase 4 全库回归

- [ ] **Step 1:** `npx vitest run` + `cargo test` 全绿
- [ ] **Step 2:** 构建 + 同步 profile（含 wasm）
- [ ] **Step 3:** 浏览器目检 2937346640（visualizer 位置/时钟/雾透明度）与 2460786246（Lightning cloud 镜像）
- [ ] **Step 4:** 提交 — `git commit -m "test: Phase 4 次要字段回归"`

---

## 全局验收（所有 Phase 完成后）

- [ ] `npx vitest run`（包目录）全量 PASS（含 `verify-real-library.test.ts` 24 壁纸解析零失败、效果链解析 100%）
- [ ] `cargo test`（wasm/）全绿
- [ ] `node research/verify-wasm-render.mjs` 与 `--no-webgpu` 双模式：无 BLACK 回归；动画壁纸不再 STATIC（回退 JS 后 diff>0）
- [ ] GUI 目检清单：
  - 2937346640：无白色伪影、foliagesway 局部摆动、iris 局部动画、可视化条音频驱动、VHS 时间走字、壁纸音乐可播
  - 1429403119（Orange）：无整屏摇晃/模糊
  - 1968789468/3743126786：waterwaves 等动画生效
- [ ] 更新 `AGENT.md`（§2.1 双渲染器说明、§5.3 已知问题状态、§5 坑位新增粒子 alpha/对象级效果链记录）并提交
- [ ] 最终提交：`git commit -m "docs: AGENT.md 更新渲染能力说明(粒子 alpha/对象级效果链/音频)"`

## 已知风险与缓解

- **P1 对象级效果链**：大纹理对象（6144×3072）对象 RT 钳制 2048 会损失细节——先钳制，后续按需放大；效果链 mask UV 对齐依赖对象 RT 与对象 quad 的 UV 约定一致（Task 1.3 必须目检 foliagesway 摆动区域）。
- **P2 wasm 回退**：动画壁纸全部走 JS 渲染器 → 大壁纸帧率下降（JS 无 wasm 粒子性能）——可接受（正确性优先），wasm 内后处理管线列为后续计划。
- **P3 音频自动播放**：浏览器 autoplay 策略可能拦截壁纸音频——首次用户手势后尝试 `resume()`，拦截时可视化退化为静态（不阻断）。
- **P3 脚本**：不做通用脚本引擎（安全与工作量），内置模式识别覆盖全库已知脚本（scan 确认 Simple_Audio_Bars×3 与时钟类）；未识别脚本对象保持静态。
- **验证环境**：本机 headless Edge CDP 无法启动（`--remote-debugging-port` 不监听）——`verify-wasm-render.mjs` 需在可跑 CDP 的环境执行；本地以 GUI 目检为主。
