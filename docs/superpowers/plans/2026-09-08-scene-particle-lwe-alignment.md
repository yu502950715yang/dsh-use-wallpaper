# Scene 粒子完整对齐 lwe/WE（方案 A）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 把 wasm 简化粒子管线（`SceneParticleSim`+billboard）**完整对齐 linux-wallpaperengine `CParticle`**（`research/.lwe/src/WallpaperEngine/Render/Objects/CParticle.{h,cpp}`），使四壁纸（黑神话/EVA/DK/Crimson）粒子的数量/密度/尺寸/材质/纹理形状/运动对齐 Windows；不破坏背景。

**Architecture:** CPU 模拟对齐 lwe `CParticle`（`ParticleInstance` 状态 + emitters/initializers/operators 完整），GPU 渲染对齐 `renderSprites`（mvp 矩阵 + 材质 blend + 纹理 alpha 遮罩 + 多帧 + softness + 17 浮点/顶点流）。坐标/投影对齐 lwe `setup`/`update`（origin 中心化，发射点 × 对象变换）。

**Tech Stack:** Rust / wasm-bindgen / wgpu / WGSL / JS (wasm-renderer.ts)。逐行基准：`research/.lwe/.../CParticle.{h,cpp}`。

**Spec:** `docs/superpowers/specs/2026-09-08-scene-particle-lwe-alignment.md`

## Global Constraints

- 对齐 lwe 语义，不做简化近似；粒子数量/密度/尺寸/材质/纹理形状/运动对齐 Windows。
- 发射点经**对象变换**（origin × 对象 scale），黑神话 `emitter.origin=(350,750)×scale(-2.05,2.12)` → 顶部偏左。
- 坐标：`we_to_three`（scene、y 不翻、与背景一致）+ 对象变换 + `mvp = viewProj×model`；origin 中心化照 lwe `setup`。
- 每壁纸 `scene.pkg` 粒子 spec（emitter/initializer/operator/材质/纹理/多帧）完整消费；无硬编码近似。
- **不破坏背景/图层**（EVA/DK/Crimson 背景正常）——最高门禁。
- 回归用 `research/probe-live.mjs`（新 token）；`cargo test` + token 截图四壁纸。
- 非目标：rope/ropetail/trail/refract/效果链/SceneScript（四壁纸先跑通再谈）。

---

### Task 1: 坐标/矩阵对齐 lwe setup（origin 中心化 + transformedOrigin + mvp）

**Files:**
- Modify: `wasm/src/particle/sim.rs`（坐标/发射点用 lwe setup 语义）
- Modify: `wasm/src/render/particle_render.rs`（mvp = viewProj×model 传入 shader）
- Modify: `wasm/src/shaders/particle_billboard.wgsl`
- Test: `wasm/tests/particle_coords_lwe_test.rs`

**Interfaces:**
- Produces: `obj_transform(origin, scene_w, scene_h) -> [f32;3]`（lwe setup：`x-svw/2, svh/2-y` 中心化）；`spawn_pos = obj_transform + emitter.origin×obj_scale`；`mvp = ortho(view_w,view_h) × model(translate(spawn_offset))`。

- [ ] **Step 1: 写失败测试**：`we_origin_centers_like_lwe` 断言 `obj_transform([2306.34,419.77,0],3840,2160)` → `[386.34, 660.23]`（lwe `x-w/2, h/2-y`）；`spawn_pos` 用对象 scale 变换黑神话 `origin×scale` → 顶部偏左（pos.y>0 且>view_h/2 或 NDC 顶）。
- [ ] **Step 2: 运行确认 FAIL**。`cargo test --no-default-features we_origin_centers_like_lwe`。
- [ ] **Step 3: 实现**：`obj_transform`（lwe setup 中心化）+ spawn 乘对象 scale；billboard shader 接收 `mvp`（uniform `view_w,view_h` as ortho 推导），`o.clip = mvp × pos`。
- [ ] **Step 4: 运行确认 PASS**。`cargo test --no-default-features`。
- [ ] **Step 5: 提交** `git add wasm/src/particle/sim.rs wasm/src/render/particle_render.rs wasm/src/shaders/particle_billboard.wgsl wasm/tests/particle_coords_lwe_test.rs && git commit -m "feat(particle): lwe-aligned coords/object-transform/mvp"`。

---

### Task 2: emitters 完整对齐 lwe（boxrandom / sphererandom + 精确发射）

**Files:**
- Modify: `wasm/src/particle/sim.rs`（createBoxEmitter/createSphereEmitter 对齐 lwe）
- Test: `wasm/tests/particle_emitter_lwe_test.rs`

**Interfaces:**
- Produces: `EmitterFn` 闭包：`fn(particles, &mut count, dt)`——accumulate `emissionTimer += dt*rate`；`limitOnePerFrame`/`randomPeriodicEmission`/`delay` 照 lwe；box 体积±翻×directions、sphere 球壳 cosθ+cbrt×directions；`emitter.origin.y` **翻**（lwe `-y`，经对象变换）；发射 `rate` 精确、超 `maxcount` 停。

- [ ] **Step 1: 写失败测试**：box random 粒子在盒内（|local|≤dist×|dir| 半尺寸）；sphere 球壳 r∈[dist_min,dist_max]（cbrt 均匀）；`emissionTimer` 累积 + `rate` 数目。
- [ ] **Step 2: 确认 FAIL**。`cargo test --no-default-features particle_emitter_lwe_test`。
- [ ] **Step 3: 实现**（对齐 lwe `createBoxEmitter`/`createSphereEmitter`，含 `limitOnePerFrame`/`randomPeriodicEmission`/`delay`）。
- [ ] **Step 4: 确认 PASS**。`cargo test --no-default-features`。
- [ ] **Step 5: 提交** `git add wasm/src/particle/sim.rs wasm/tests/particle_emitter_lwe_test.rs && git commit -m "feat(particle): lwe-aligned box/sphere emitters"`。

---

### Task 3: initializers 完整对齐 lwe

**Files:**
- Modify: `wasm/src/particle/sim.rs`（color/size/alpha/lifetime/velocity/rotation/angularVelocity/turbulent initializers）
- Test: `wasm/tests/particle_init_lwe_test.rs`

**Interfaces:**
- Produces: `InitializerFn` 闭包 `fn(&mut ParticleInstance)`；对齐 lwe `create*RandomInitializer`：colorRandom（lerp min/max 归一）、sizeRandom（`(min+t^exp*(max-min))`，**不做 /2**）、alphaRandom、lifetimeRandom、velocityRandom（含 `y 翻`开关）、rotationRandom、angularVelocityRandom、turbulentVelocityRandom（normal/forward 基方向+速度）。

- [ ] **Step 1: 写失败测试**（sizerandom exp 幂、velocity lerp 逐分量、turbulent 用基向量）。
- [ ] **Step 2: 确认 FAIL**。
- [ ] **Step 3: 实现**（对齐 lwe 各 create*Initializer）。
- [ ] **Step 4: 确认 PASS**。`cargo test --no-default-features`。
- [ ] **Step 5: 提交** `git add wasm/src/particle/sim.rs wasm/tests/particle_init_lwe_test.rs && git commit -m "feat(particle): lwe-aligned initializers"`。

---

### Task 4: operators 完整对齐 lwe

**Files:**
- Modify: `wasm/src/particle/sim.rs`（movement/angularMovement/alphaFade/sizeChange/alphaChange/colorChange/turbulence/oscillate...）
- Test: `wasm/tests/particle_operator_lwe_test.rs`

**Interfaces:**
- Produces: `OperatorFn` 闭包 `fn(particles,&mut count,cps,time,dt)`；对齐 lwe `create*Operator`：movement（`vel+=accel*dt; pos+=vel*dt`，含 weight/drag/gravity 精确）、angularMovement（`rot+=angVel*dt`）、alphaFade（梯形 fadein/out）、sizeChange/alphaChange/colorChange（随时间）、turbulence、oscillateAlpha/Size/Position。

- [ ] **Step 1: 写失败测试**（movement 积分收敛、angularMovement rot+=ω·dt、alphaFade 梯形、turbulence 施加扰动）。
- [ ] **Step 2: 确认 FAIL**。
- [ ] **Step 3: 实现**（对齐 lwe 各 create*Operator）。
- [ ] **Step 4: 确认 PASS**。`cargo test --no-default-features`。
- [ ] **Step 5: 提交** `git add wasm/src/particle/sim.rs wasm/tests/particle_operator_lwe_test.rs && git commit -m "feat(particle): lwe-aligned operators"`。

---

### Task 5: 渲染对齐 renderSprites（材质/纹理 alpha 遮罩/多帧/softness + 17浮点顶点流）

**Files:**
- Modify: `wasm/src/render/particle_render.rs`、`wasm/src/shaders/particle_billboard.wgsl`
- Test: `wasm/tests/particle_render_lwe_test.rs`

**Interfaces:**
- Produces: 顶点流 `SPRITE_FLOATS_PER_VERTEX=17`（位置×mvp、uv、color、size 等，对齐 lwe `fillVertices`）；材质 blend（additive/alpha 按材质，`overbright`）；纹理 alpha 遮罩（lightshaft/雪片**真实形状**）；多帧（spritesheet cols/rows/frames/duration，randomframe/once/sequence）；softness。

- [ ] **Step 1: 写失败测试**（顶点流字段计数=17、mvp 变换、uv/帧映射、softness）。
- [ ] **Step 2: 确认 FAIL**。
- [ ] **Step 3: 实现**（对齐 lwe `renderSprites`/`fillVertices` + 材质/纹理/帧/softness）。
- [ ] **Step 4: 确认 PASS**。`cargo test --no-default-features`。
- [ ] **Step 5: 提交** `git add wasm/src/render/particle_render.rs wasm/src/shaders/particle_billboard.wgsl wasm/tests/particle_render_lwe_test.rs && git commit -m "feat(particle): lwe-aligned renderSprites (material/texture/frame/softness)"`。

---

### Task 6: 四壁纸对齐回归（黑神话/EVA/DK/Crimson）

**Files:** 无代码（验证）；截图靠 `research/probe-live.mjs`（新 token）。

- [ ] **Step 1: 部署** `wasm-pack build --target web --release --features render && npm run build:client` → 复制 `dist/*` 到 profile dist。
- [ ] **Step 2: 截图回归** `node research/probe-live.mjs 2851992662,1280029027,2859263090,3765967112`；逐一核对：
  - 黑神话：花瓣从**顶部偏左**向下飘、单帧、大小合适；
  - EVA：光柱（纹理遮罩形状）、非大块、不遮背景；
  - DK：雪片稀疏、纹理形状、半透明、不遮背景；Crimson 正常。
  - 全部**背景不破坏**（最高门禁）。
- [ ] **Step 3: 失败则回滚** 对应 commit（`git revert`），保留坐标/模拟，重查该壁纸 spec 差异；修复后重跑 Step 2。
- [ ] **Step 4: 提交最终**（全通过）`git add -A && git commit -m "test(scene): 4-wallpaper particle aligns Windows"`。

## Self-Review

- **Spec 覆盖**：坐标/矩阵(1)、emitters(2)、initializers(3)、operators(4)、渲染/材质(5)、四壁纸回归(6)——六节全覆盖。
- **Placeholder**：无 TBD；每 task 有具体步骤/接口/测试。
- **类型一致**：`ParticleInstance` 状态（Task2-4 引用）、`EmitterFn`/`InitializerFn`/`OperatorFn` 签名（Task2/3/4）、`SPRITE_FLOATS_PER_VERTEX=17`（Task5）一致。
- **范围**：四壁纸核心（非 rope/trail/refract/effects/SceneScript）。
