# WE 场景 → three.js 播放器（思路 1）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 用 three.js 渲染 WE scene（背景图层 + 粒子系统），复用已有解析/模拟（scene-json、particle spec、we_to_three、CPU SceneParticleSim），只把渲染换成 three.js。目标：四壁纸背景不破坏 + 粒子可见且飘动 + 尽量接近 Windows。

**Architecture:** three.js 渲染层（背景 Sprite/Mesh + 粒子 BufferGeometry/ShaderMaterial）+ 复用现有解析/坐标/CPU 模拟（`SceneParticleSim::build_vertices` 喂给 three.js 顶点缓冲）。渲染循环 RAF → sim.update(dt) → 更新 BufferGeometry → renderer.render。

**Tech Stack:** TypeScript / three.js / 现有 `src/client/*`（scene-json/scene-renderer/alignment/visibility/effect-chain/effect-runner）+ `wasm/src/particle/sim.rs`（SceneParticleSim）+ `wasm/src/coords.rs`（we_to_three）。

**Spec:** `docs/superpowers/specs/2026-09-08-scene-threejs-player.md`

## Global Constraints

- 复用已有解析/坐标/CPU 模拟，**不重写** GPU/粒子渲染管线。
- 背景与粒子同坐标系（we_to_three、y 不翻、与背景一致）；黑神话发射点顶部偏左（origin×scale）。
- 粒子用 three.js 渲染（BufferGeometry + ShaderMaterial：billboard、多帧 uv、additive/alpha、softness）；CPU 模拟 `SceneParticleSim` 作为逻辑。
- 四壁纸（黑神话/EVA/DK/Crimson）背景不破坏；粒子可见 + 飘动。
- ③ Scene 脚本/效果链 → 后续（先不接）。
- 回归：`cargo test`（复用部分）+ 浏览器/截图四壁纸。

---

### Task 1: 搭 three.js 场景 + 渲染循环 + 正交相机（背景/粒子共用）

**Files:**
- Modify: `src/client/threejs-player.ts`（新建，或并入现有）
- Test: `src/client/threejs-player.test.ts`（新建，若环境可测则节点跑）

**Interfaces:**
- Produces: `ThreeScenePlayer`（`create(canvas,w,h)`、`addBackground(origin,size,scale,texture)`、`addParticleSim(sim)`、`update(dt)`、`render()`）。
- 正交相机（cover，view_w/view_h 与现有 cover 一致）；RAF 循环。

- [ ] **Step 1: 写失败测试**（`create` 后 scene/camera/renderer 存在；`update`+`render` 不抛错）。
- [ ] **Step 2: 确认 FAIL**。
- [ ] **Step 3: 实现**：新建 `threejs-player.ts`——`THREE.WebGLRenderer`、正交相机（cover，`view_w/view_h`）、`renderer.setAnimationLoop`（`update(dt)` + `render`）。
- [ ] **Step 4: 确认 PASS**。
- [ ] **Step 5: 提交** `git add src/client/threejs-player.ts src/client/threejs-player.test.ts && git commit -m "feat(threejs): scene player skeleton (renderer/ortho-camera/RAF)"`。

---

### Task 2: 背景图层（Sprite/Mesh，origin/scale/对齐，we_to_three）

**Files:**
- Modify: `src/client/threejs-player.ts`（`addBackground`）
- Consumes: 现有 `we_to_three`/`image_center_ndc`/`applyAlignment`、`load_image`/`update_image`（复用）。

**Interfaces:**
- Produces: `addBackground(origin,size,scale,texture?)`——用 `we_to_three(origin, scene_w, scene_h)` 定位 Sprite/Mesh；`update_background(assetId,origin?,scale?,alpha?,brightness?)` 对齐 `update_image`。

- [ ] **Step 1: 写失败测试**（origin → Sprite position 符合 we_to_three；alpha/brightness 更新）。
- [ ] **Step 2: 确认 FAIL**。
- [ ] **Step 3: 实现**：背景 Sprite/Mesh（we_to_three 中心、scale、对齐），`update_background`。
- [ ] **Step 4: 确认 PASS**。
- [ ] **Step 5: 提交** `git add src/client/threejs-player.ts && git commit -m "feat(threejs): background sprite layer (we_to_three, alignment)"`。

---

### Task 3: 粒子系统（BufferGeometry + ShaderMaterial，接 SceneParticleSim）

**Files:**
- Modify: `src/client/threejs-player.ts`（`addParticleSim` + `updateParticles`）
- Consumes: `SceneParticleSim::build_vertices()`（`[f32;10]` 粒子流）+ `we_to_three`。

**Interfaces:**
- Produces: `addParticleSim(sim, tex?, frameCount, blend)`——建 `BufferGeometry`（position/size/uv/color）+ `ShaderMaterial`（billboard、多帧 uv、additive/alpha、softness）；`updateParticles(dt)` 每帧 `sim.update(dt)` + 刷新 geometry。

- [ ] **Step 1: 写失败测试**（`build_vertices` 输出 → geometry position/size/color count；frame 映射 uv；blend 模式）。
- [ ] **Step 2: 确认 FAIL**。
- [ ] **Step 3: 实现**：粒子 ShaderMaterial（billboard quad、多帧 uv、additive/alpha blend、softness、color）；每帧把 `sim.build_vertices()` 填入 `BufferAttribute`；`updateParticles(dt)` 调 `sim.update`。
- [ ] **Step 4: 确认 PASS**。
- [ ] **Step 5: 提交** `git add src/client/threejs-player.ts && git commit -m "feat(threejs): particle BufferGeometry + ShaderMaterial wired to SceneParticleSim"`。

---

### Task 4: 渲染循环接线（we 场景 → three 播放器）

**Files:**
- Modify: `src/client/threejs-player.ts`、现有 wasm-renderer.ts（或新建 player 入口）
- Test: `src/client/threejs-player.test.ts`

**Interfaces:**
- Produces: `loadSceneToThree(sceneJson, assets)`——解析 scene.json（现有），背景 → `addBackground`，粒子对象 → `addParticleSim`（复用 `emitter_spec_to_particle`/`SceneParticleSim`）；`startAnimationLoop()`。

- [ ] **Step 1: 写失败测试**（`loadSceneToThree` 解析黑神话 scene.json → 背景对象数 + 粒子 sim 数；无粒子 spec → 只背景）。
- [ ] **Step 2: 确认 FAIL**。
- [ ] **Step 3: 实现**：`loadSceneToThree`——把现有 scene.json 解析 + `emitter_spec_to_particle` 接到 three 播放器（背景 + 粒子）。
- [ ] **Step 4: 确认 PASS**。
- [ ] **Step 5: 提交** `git add src/client/threejs-player.ts src/client/wasm-renderer.ts && git commit -m "feat(threejs): load WE scene into three player (bg + particles)"`。

---

### Task 5: 四壁纸回归（背景不破坏 + 粒子可见飘动 + 接近 Windows）

**Files:** 无代码（验证）。

- [ ] **Step 1: 运行** `cargo test`（复用解析/模拟）+ `npm run build:client`。
- [ ] **Step 2: 浏览器/截图** 黑神话/EVA/DK/Crimson：背景不破坏；粒子可见 + 飘动；黑神话花瓣（顶部偏左、单帧、渐入渐出、自旋）。
- [ ] **Step 3: 对比 Windows DK 实机**：粒子稀疏、纹理形状、半透明、不遮背景。
- [ ] **Step 4: 不达标则** 按差异修（引擎参数映射/坐标），重跑 Steps 2-3；达标则 `git add -A && git commit -m "feat(threejs): 4-wallpaper regression passes"`。

## Self-Review

- **Spec 覆盖**：背景(2)、粒子(3)、循环/接入(1,4)、回归(5)——五节覆盖。
- **Placeholder**：无 TBD；每 task 有接口/步骤/测试。
- **类型一致**：`SceneParticleSim::build_vertices`（`[f32;10]`，Task3 消费）、`we_to_three`（Task2/3）、`addBackground`/`addParticleSim`（Task4 引用）一致。
- **范围**：背景+粒子；③ 脚本/效果链后续。
