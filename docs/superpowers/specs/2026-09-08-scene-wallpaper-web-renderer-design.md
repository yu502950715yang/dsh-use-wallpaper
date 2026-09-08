# Scene 壁纸网页渲染器（核心可上线版）设计

- 日期：2026-09-08
- 状态：待用户评审（brainstorming → 待实现）
- 范围：B（核心可上线版）

## 背景与问题

现有 dsh-use-wallpaper 的 wasm 渲染器能加载 WE scene 壁纸，但**粒子渲染是 GPU compute 简化近似**（坐标、相机、emitter、算子与 Wallpaper Engine 完整语义不一致），导致：
- 黑神话片花瓣位置/方向/大小与 Windows 实机不符；
- 我逐步"打补丁"修复时破坏了其他壁纸（EVA/DK 等粒子位置/左边错误）；
- 坐标与相机反复在「该不该 Y 翻 / 怎么缩放」之间打转——底层定义不一致。

用户目标是**产品**：在网页上渲染 WE scene 壁纸（当前市场空白）。用户接受**重新开发**，确认范围 B（先做核心：稳定 scene 背景图层 + 完整 WE 语义的粒子系统），效果链/SceneScript 后续迭代。

## 目标（成功标准）

1. **scene 背景图层**正确显示（图片/视频、对象 origin/scale/对齐与 WE 一致）。
2. **粒子系统**按 WE 完整语义（坐标、emitter、initializer、operator）在网页正确渲染：黑神话花瓣**从上面向下飘、大小混合、位置不偏**；不再出现"改坏其他壁纸"。
3. **稳定**：失败只丢单个对象（绝不白屏/崩）；`cargo test`（单元）+ token 截图回归（black / EVA / DK / Crimson）全部通过。
4. 非目标（本版不做，留待 B+）：对象级效果链（effects）、SceneScript 脚本动画、多显示器/高级混合。

## 架构（方案 B：CPU 模拟 + GPU 渲染 + 图层系统）

```
scene.json ─▶ 场景加载器(wasm)
                ├─ ① 图片图层（现有 set_image，坐标对齐 WE）
                └─ ② 粒子模拟器 SceneParticleSim（wasm CPU，照 linux-wallpaperengine CParticle）
                      │ 每帧 update(dt)：emitter 生成 + operator 积分
                      │ build_vertices() 输出 billboard 顶点(pos/size/uv/color/alpha/life)
                      ▼
                ③ 粒子渲染 ParticleRenderPass（wgpu，正交投影 + 纹理帧 + 按材质混合）
                      ▼
                canvas（背景图层先、粒子后叠加）
```

## 组件

### 1. `wasm/src/particle/sim.rs`（新）—— 粒子模拟器（CPU）
- `SceneParticleSim` 持有 `Vec<SimParticle>`（CPU 状态：pos/vel/rot/size/alpha/life/color/frame）。
- 按 linux `CParticle` 完整语义：
  - **emitter**：sphererandom（3D 球壳 cosθ + cbrt 半径 ×directions）/ boxrandom（体积±翻 ×directions）；`rate` 累积发射（`emissionTimer += dt*rate`），`maxcount` 封顶。
  - **initializer**：sizerandom（`(min+t^exp*(max-min))/2`，exponent）、lifetime、velocityrandom（`vel.y=-vel.y` 可开关）、colorrandom、rotation、angularvelocityrandom、turbulentvelocityrandom。
  - **operator**：movement（`pos+=vel*dt; vel+=(gravity−vel*drag)*dt`）、angularmovement（`rot+=ω*dt`）、alphafade（`fadein/fadeout` 梯形）。
- `update(dt)` 推进每粒子；`build_vertices()` 输出 billboard 顶点；`maxcount/rate` 精确照 spec。

### 2. `wasm/src/render/particle_render.rs`（新）—— GPU billboard 渲染
- 每帧上传 billboard 顶点；正交投影（scene 相机宽高 cover 尺寸）；sprite 顶点（position + half_px*size）+ 纹理采样（sprite 帧 randomframe）+ 材质混合（translucent/additive 按材质，非硬编码）。

### 3. 场景加载器（沿用 + 补粒子）
- `load_scene` 已有 image 图层；新增：解析 `particle` 对象（spec）→ 建 `SceneParticleSim`；`update_particles(dt)`（JS 每帧调）；`draw` 顺序（背景图层 → 粒子）。

### 4. 坐标层（`coords` 重写映射）
- WE 屏幕坐标（y 向下）→ 中心原点（`h/2-y`）；对象 origin + emitter.origin + 正交（一次对齐 WE）。

**复用**：材质/纹理解码（TEXV0005）、图片图层、wasm-bindgen 接缝、scene.json 解析。

## 坐标与投影（之前位置错的根因）

1. **对象变换（世界）**：`transformedOrigin = (obj.x - viewW/2, viewH/2 - obj.y)`（Y 翻，WE 屏幕 y 向下 → 中心 y 向上）。
2. **发射点**：`spawnOrigin = transformedOrigin + emitter.origin`，`emitter.origin.y = -emitter.origin.y`（局部偏移 Y 翻）；**不乘对象 scale**（WE `RenderPosition` 无 scale——之前 EVA 被放大成巨块的根因）。
3. **粒子位置（CPU）**：`p.position = spawnOrigin + localOffset`（localOffset 由 emitter / 每帧运动产生）。
4. **投影（NDC）**：`NDC = p.position / (viewW/2, viewH/2)`，viewW/H = **视口 cover 尺寸**（`cover(sceneW,sceneH,canvasAspect)`，保持场景不变形、超出裁剪）——照 linux `ortho(-w/2..w/2) + model`；**非**固定 scene 3840。

## 数据流（每帧）

1. JS（raf）→ `wasm.update_particles(dt)`。
2. `SceneParticleSim::update(dt)`（emitter 生成 + operator 积分）。
3. `build_vertices()` → `ParticleRenderPass.draw()`（上传顶点 → 正交投影 → 纹理帧 → 材质混合 → canvas）。
4. 绘制顺序：背景图层（image）→ 粒子。

## 错误处理（绝不白屏/崩溃，失败只丢该对象）

- 粒子 spec 缺失字段/解析失败 → 默认值（默认 emitter/initializer/operator）。
- 纹理缺失（TEXV0005 解码失败）→ 1×1 白兜底（纯色粒子）。
- 材质 blending 缺失 → 默认 additive。
- `maxcount/rate` 异常（负/NaN）→ clamp/跳过。
- GPU 缓冲/上传失败 → 该粒子 pass 跳过（log warning），其余图层继续。
- **对象级效果链（effects/SceneScript）不在 B 范围**：此类对象走"原始内容"共享路径（不应用链），留待 B+。

## 测试与回归

- **单元（`cargo test`）**：emitter 球壳/box 分布（半径/directions 统计）、运动积分（pos/vel 收敛）、fade 梯形、坐标 Y 翻（black 原点 → 上面）、`maxcount/rate` 估算。
- **渲染回归（token 截图）**：
  - black：花瓣**从上面向下飘**、大小混合、位置不偏右；
  - **EVA / DK WOTLK / Crimson**（含之前"粒子左边不对"）专项验证粒子**位置正确、不破坏**——本产品第一版最重要的回归。

## 成功标准

- `cargo test` + token 截图（black/EVA/DK/Crimson）全部通过。
- 黑神话：上面向下飘、大小混合、位置不偏右。
- EVA/DK/Crimson：粒子位置正确（不再"左边不对"）。
- 单对象失败不影响其他图层渲染。
