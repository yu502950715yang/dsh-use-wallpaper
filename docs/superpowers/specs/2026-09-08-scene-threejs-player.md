# WE 场景 → three.js 播放器（思路 1）设计

- 日期：2026-09-08
- 状态：待用户评审（brainstorming → 待实现）
- 范围：three.js 渲染，WE `scene.pkg` 内容转换（非重写渲染器）。①背景图层 + ②粒子系统；③Scene 脚本动画 / 效果链 → 后续。

## 背景

此前在 wasm 里逐像素复刻 WE 粒子渲染器（简化近似 + 逐行对齐 lwe）效果仍不对——根本原因是 WE 是完整闭源渲染器，重写工程量大且不确定。换**思路 1**：复用成熟 Web 渲染引擎 **three.js**，把 WE 场景**转换成 three.js 可渲染内容**（数据映射，非重写 GPU 管线）。硬性要求：网页 + 尽量接近 Windows。

## 目标（成功标准）

1. **背景图层**（图片/视频、对象 origin/scale/对齐）在 three.js 正确显示（复用现有 scene-json 解析与 we_to_three 坐标）。
2. **粒子系统**在 three.js 用**引擎粒子能力**渲染，把 WE spec（emitter/initializer/operator/材质/多帧/blend）映射为引擎参数，黑神话花瓣/光柱/雪片**可见、飘动、形状/材质接近 Windows**。
3. 四壁纸（黑神话/EVA/DK/Crimson）**背景不破坏**；粒子可见且**会动**（这是此前未达成的关键）。
4. `cargo test`（保留现有 wasm 复用部分）+ 浏览器/截图回归（四壁纸）。

## 架构（three.js）

```
scene.json(scene.pkg) ─▶ 解析层(复用现有 scene-json.js / particle spec / tex / we_to_three)
                          ├─ ① 背景图层：three.js Sprite/Mesh（对象 origin/scale/对齐，we_to_three 中心）
                          └─ ② 粒子系统：three.js Points/BufferGeometry + ShaderMaterial
                                · 把 WE 粒子 spec 映射为引擎参数（emitter 发射位置/方向/数量、
                                  initializer size/velocity/color/lifetime、operator movement/alphafade/angular、
                                  材质 blend、多帧纹理 uv、softness）
                          └─ ③（后续）Scene 脚本动画 / 效果链：three.js 近似 + 现有 effect-chain 解析
```

### 关键点
- **复用**：现有 `scene-json.js`（解析 scene.json）、particle spec 解析（emitter/initializer/operator）、`we_to_three`（坐标、y 不翻、与背景一致）、材质/TEXV0005 纹理解码、`scene-renderer.js`（对象相机/范围）。
- **粒子（three.js）**：
  - `THREE.Points`/`BufferGeometry`（每粒子顶点：position/size/uv/lifetime）+ `ShaderMaterial`（billboard、多帧 uv 切片、additive/alpha 混合、softness、颜色）——映射 WE spec。
  - 或 `THREE.PointsMaterial`/`Sprite`（更简单，多帧/混合受限时可降级）。
  - **CPU 模拟复用**：直接用前面已实现的 `SceneParticleSim`（emitters/initializers/operators/寿命）作为**逻辑模拟**，把 `build_vertices` 输出喂给 three.js `BufferGeometry`（`position/size/uv/color`）——**渲染交给 three.js，模拟用已有 CPU 代码**。这是关键：不重写模拟，只换渲染引擎。
- **坐标/投影**：we_to_three（scene、y 不翻）+ three.js 正交相机（cover），与背景一致；黑神话发射点顶部偏左（origin×scale）。
- **渲染循环**：`requestAnimationFrame` → `sim.update(dt)` → 更新 `BufferGeometry` → `renderer.render(scene, camera)`。
- **错误处理**：spec 缺失/纹理缺失 → 默认值/白兜底；单对象失败不影响其他；绝不白屏。

## 复用 vs 新写
- **复用（保留现有）**：scene.json 解析、particle spec 解析、坐标 `we_to_three`、材质/纹理解码、CPU `SceneParticleSim`（模拟）、效果链/SceneScript 解析（后续用）。
- **新写**：three.js 渲染层（背景 Sprite 挂载、粒子 BufferGeometry + ShaderMaterial、渲染循环、相机）。

## 测试与回归
- 保留现有 `cargo test`（解析/模拟复用部分）。
- 浏览器/截图回归：四壁纸——背景不破坏；粒子可见 + 飘动；黑神话花瓣（顶部偏左、单帧、渐入渐出、自旋）。
- 对比 Windows（用户提供的 DK 实机截图）：粒子稀疏、纹理形状、半透明、不遮背景。

## 非目标（后续）
- ③ Scene 脚本动画 / 对象级效果链完整（three.js 近似 + 现有解析，后续）。
- 逐像素完全一致（three.js 引擎能力映射，还原到引擎可达到的接近程度）。

## 参考（复用）
- `src/client/scene-json.js`、`scene-renderer.js`、`scene-script.js`、`shader/effect-chain.js`、`effect-runner.js`、`alignment.js`、`visibility.js`；`wasm/src/coords.rs`（we_to_three）；`wasm/src/particle/sim.rs`（SceneParticleSim 模拟）；`research/` 四壁纸 scene 提取。
