# 动态网格（`createModelData` / `createLayer` / `applyData`）— 设计文档

- 日期：2026-09-22
- 状态：**设计已确认，待写实施计划**（用户 2026-09-22 确认：范围=通用动态网格含粒子与拖尾；验收=画面级+零回归+性能预算；架构=按骨架落 spec）
- 项目根：`E:\code\dsh-use-wallpaper`
- 关联：
  - 前序：`docs/superpowers/specs/2026-09-22-scene-script-runtime-design.md`（SceneScript 运行时，已实施）
  - spike 产物（throwaway，均在 `research/`，未提交）：`_spike-s2-mesh.mjs`、`_spike-s2-mesh.json`、`_spike-s2-render.mjs`
  - 复用：`src/client/tex-loader.ts`（`.tex` 解码）、`src/client/wasm-renderer.ts` 的 `resolveParticleMaterial` 语义、`src/client/threejs-player.ts` 的 `addParticle` 装配风格
  - AGENT.md §7.1 第 11 条（一期边界：粒子/拖尾仍不出现正是因为本设计未做）

## 1. 概述

一期让 `3798688689` 的 17 个 SceneScript 真正执行后，画面的**静态构图**已正确（对照基线 98.86% 像素改变），但**粒子与拖尾仍然不出现** —— 因为 `92000`（粒子控制器）与 `93000`（信封拖尾）不是用 WE 的粒子系统，而是**脚本自己算粒子、把顶点写进 `Float32Array`，再交给 `createModelData` 上传**。本设计实现这条动态网格路径。

这不是"某个 API 的空实现"：它是一条**新的渲染通道**（运行时创建的 mesh + 每帧顶点上传），与 scene.json 静态对象、既有 `CpuParticleSim` 粒子路径都不同。

## 2. 事实基础（spike 实测，2026-09-22）

### 2.1 规模与数据格式（S1：捕获真实脚本产出）

| 指标 | 实测 |
|---|---|
| `createModelData` 调用 | **58 个 mesh**（29 发射器 × 颜色层 + alpha 层）、`createLayer` 718 个图层 |
| 材质 asset | **58 个**（`materials/particles/emitter_00..26[_alpha].json`、`trail_*.json`） |
| 顶点格式 | `vertexFormat = [IModelData.POSITION, UV, COLOR]` → **9 floats/顶点**（pos 3 + uv 2 + color 4）、**36 floats/quad**、**6 索引/quad** |
| 每 mesh 容量 | kv2 发射器 `capacity = 500` → `Float32Array(18000)` = **72 KB** |
| **每帧在变的 mesh** | **26 / 58**（quad 数 60→59→…→51→61→62，粒子真的在生成消亡） |
| 活跃 quad（最后帧） | **808** |
| `applyData` 调用次数 | 活跃 mesh 各 **301 次**（300 帧 + init）→ 确实每帧上传 |

### 2.2 几何正确性（S2：把顶点实际光栅化）

| 检查 | 实测 | 对照 |
|---|---|---|
| 粒子尺寸 | min 0.58 / **中位 4.72** / max 9.59 场景单位 | config `size:[4,12]` ✓ |
| 顶点色 | `rgba = (1,1,1,α)`，α∈[0.0019, 0.998] | 脚本 `quad(...,1,1,1,alpha)` ✓ |
| 位置 | 中心中位 **(530, −500)** | `emitter_14` 配置中心 (536, −467) ✓ |
| 分布形态 | 星点状飘散 | 非噪声 / 非全屏 / 非单点 ✓ |

### 2.3 材质与 shader（全部在 pkg 内可解析，只有一个例外）

- 材质 json：`{passes:[{shader, textures, blending, cullmode, depthtest, depthwrite, constantshadervalues}]}`，`blending = "additive"`；纹理引用 `source/a_4b7892c81030` 是**相对 `materials/` 的路径** → `materials/source/a_4b7892c81030.tex` 存在 ✓
- 顶点 shader `shaders/we2d_particle_alpha.vert`（344 B）：标准 `mul(mul(pos, M), VP)` + 直传 uv/color
- 片元 shader `shaders/we2d_particle_alpha.frag`（577 B）：`gl_FragColor = vec4(1,1,1, tex.a * v_Color.a)`（纹理 alpha 当遮罩）
- **例外**：颜色层的 `we2d_particle_mesh` **不在 pkg 内** ⇒ 需要内置自实现（按 alpha 层推断，约 10 行）

### 2.4 传输成本（修正 S1 的初判）

顶点总量 545 112 floats（2129 KB 静态）。每帧"活跃 mesh 全量"= **1.79 MB**；"只传实际使用区间"= **114 KB**。但 1.79 MB 的真实代价是 **一次 memcpy（约 0.3 ms）+ 一次 GPU 上传**，而不是"107 MB/s 不可接受"。GPU 侧可用 `addUpdateRange` 压到 114 KB。

### 2.5 已核实的 API（不写不存在的接口）

- `QuickJSContext.newArrayBuffer(buffer: ArrayBufferLike)` / `getArrayBuffer(handle): Lifetime<Uint8Array>` —— quickjs-emscripten 0.32 ✓
- `THREE.BufferAttribute.updateRanges` / `addUpdateRange(start, count)` / `clearUpdateRanges()` —— three r170 ✓

## 3. 范围

**做**：`createModelData` / `createLayer` / `model.applyData` / `layer.setParent` / `layer.visible` 的真实实现；材质 asset 解析（json → 纹理 + blending + shader）；内置 `we2d_particle_mesh` 自实现；运行时网格的装配、每帧上传与 dispose；`92000` 粒子与 `93000` 拖尾两条消费者。

**不做（明确排除）**：

1. **util 合成层**（`500/510` 的 `video`/`spin`/`opacity` 切换特效）—— 需要 WE 的合成层语义与 `_rt_imageLayerComposite_*` 运行时 RT，是独立子系统。
2. **`setParent` 的真实父子变换**：本壁纸的 parent 全是**未渲染的 util 层**（`92001`/`92002`），没有 three 对象可挂；且顶点坐标已是场景绝对坐标（脚本 `quad()` 里做了 `x-780 / 480-y` 中心化）⇒ 一期只**记录** parent 名，不建父子关系。
3. 音频频谱驱动、`layer.getEffect().visible`（一期已列为 stub）。

## 4. 架构与模块

```
脚本 createModelData({shapes:[{vertexBuffer, indexBuffer, vertexFormat, material, isVertexBufferDynamic}]})
   │  宿主原语 __host.createModel(...)  ← 记录 capacity/格式/material 名
   ▼
DynamicMeshRegistry（新增 dynamic-mesh.ts）
   ├─ 建 BufferGeometry：position(3) / uv(2) / color(4) + index（capacity 一次分配）
   └─ createLayer({model,name,origin,perspective}) → THREE.Mesh → player.scene
脚本 model.applyData({vertexBuffer})
   │  __host.applyMeshData(meshIdx, arrayBufferHandle)
   ▼
每帧：getArrayBuffer 拷贝 → 写回 BufferAttribute → addUpdateRange(0, count*36) → needsUpdate
                                  → setDrawRange(0, count*6)
```

**新增**

| 文件 | 职责 |
|---|---|
| `src/client/dynamic-mesh.ts` | 运行时网格注册表：`BufferGeometry`/`Mesh` 的创建、每帧顶点写入（部分更新）、`visible`、`dispose`；不依赖 quickjs |
| `src/client/mesh-material.ts` | 材质 asset（`materials/**/*.json`）→ three 材质：纹理解析（复用 `tex-loader`）、`blending` 映射、`cullmode`/`depthtest`/`depthwrite` |
| `src/client/mesh-shaders.ts` | 内置 shader：`we2d_particle_mesh`（颜色层，pkg 内没有）；`we2d_particle_alpha` / `we2d_trail_*` 优先读 pkg 源 |

**改动**

| 文件 | 改动 |
|---|---|
| [scene-script-vm.ts](src/client/scene-script-vm.ts) | prelude 的 `createModelData`/`createLayer`/`engine.registerAsset` 从 stub 换成真实桥（新增宿主原语 `createModel`/`createLayer`/`registerAsset`/`applyMeshData`） |
| [threejs-player.ts](src/client/threejs-player.ts) | 运行时网格加入 `player.scene` 的入口（`renderOrder` 在背景之上、粒子同层）与 `dispose` 清理 |
| [three-renderer.ts](src/client/three-renderer.ts) | 装载期把材质资产交给 registry 解析（需要 pkg 读取：复用既有 `loadFile` 通道） |

## 5. 接口契约

| API | 实现语义 |
|---|---|
| `thisScene.createModelData({boundingBoxMins, boundingBoxMaxs, shapes})` | 取 `shapes[0]` 的 `vertexBuffer`/`indexBuffer`/`vertexFormat`/`material`；按 `vertexBuffer.length/9` 推 capacity；建 `BufferGeometry`（attribute：`position` itemSize 3、`uv` 2、`color` **4**）+ `index`；返回**模型句柄**（宿主侧对象，脚本只透传） |
| `thisScene.createLayer({model, name, origin, perspective})` | 建 `THREE.Mesh(geometry, material)`，`renderOrder` 高于背景；返回**图层句柄**（支持 `visible`/`setParent`/`setMaterialProperty`） |
| `model.applyData({vertexBuffer})` | 每帧把顶点写入 attribute（见 §6.1 三层策略）；只有 `count>0` 时才置 `needsUpdate` |
| `layer.setParent(parent, keep)` | **只记录**（§3.2），返回 undefined |
| `layer.visible = bool` | 直接映射 `mesh.visible`（脚本用它做 `count>0` 剔除） |
| `engine.registerAsset(path, bool)` | 记录 `path → asset 句柄`；装载期解析材质 json（§6.2）。失败 → 白图兜底材质 |
| `IModelData.POSITION/UV/COLOR` | 已有枚举；`vertexFormat` 决定 attribute 布局与 stride（本期只支持 `[POSITION, UV, COLOR]`，其他组合降级为"跳过该 mesh + warn"） |

## 6. 关键语义

### 6.1 顶点传输的三层策略（性能核心）

1. **quickjs → 宿主**：脚本每帧传的是**整个** `Float32Array`（脚本不会自己切片）。宿主原语需在 quickjs 内取 `vertexBuffer.buffer` —— `getArrayBuffer` 接受的是 ArrayBuffer 而非 TypedArray —— 再用 `ctx.getArrayBuffer(handle)` 一次性拷贝。每 mesh 72 KB、26 个活跃 mesh ≈ **1.79 MB/帧**（memcpy ≈ 0.3 ms）。
2. **宿主 → GPU**：只标记实际使用区间 —— `attr.addUpdateRange(0, count * 36)` + `needsUpdate = true` ⇒ 上传 **114 KB/帧**。
3. **绘制**：`geometry.setDrawRange(0, count * 6)` ⇒ 只画实际 quad。

`count` 的获取：脚本不显式告知。**从顶点数据推断** —— 检查每个 quad 的 **4 个顶点 position 是否全为 0**：脚本 `quad()` 不会产生四个顶点都落在原点的退化 quad，且 `renderParticles` 用 `vertices.fill(0, count*36, previous*36)` 清尾 ⇒ `count` = 最后一个非空 quad 的下标 + 1。扫描 500×4 次判断/mesh 可忽略。**这是实现者需要留意的唯一启发式**：若将来遇到不清尾的脚本（复用旧数据），需改为按 `applyData` 的参数长度推断，并在该处留注释说明。

### 6.2 材质与 shader

- 材质 asset 路径来自 `engine.registerAsset('materials/particles/emitter_00.json', true)`
- 解析 `passes[0]`：`blending` → `AdditiveBlending` / `NormalBlending`（复用一期 `particleBlend` 的判定口径）；`cullmode` → `side`；`depthtest`/`depthwrite` → 材质同名字段
- 纹理：`textures[0]` 形如 `source/xxx` → 拼 `materials/<path>.tex` → **复用 `tex-loader`** 解码；含 padding 时按既有 `TEXV0005` 元数据处理 uv 修正（与 `we2d_particle_alpha.frag` 的 `g_Texture0Resolution.zw/.xy` 同义）
- shader：`shaders/<name>.{vert,frag}` 存在则用其源；**`we2d_particle_mesh` 不在 pkg** ⇒ 用内置实现：
  ```glsl
  // frag: 纹理 rgb × 顶点 rgb，alpha = 纹理 a × 顶点 a（按 we2d_particle_alpha 推断）
  vec4 c = texSample2D(g_Texture0, v_TexCoord * mapped);
  gl_FragColor = vec4(c.rgb * v_Color.rgb, c.a * v_Color.a);
  ```
  **已知偏差（如实）**：这一行是推断，未与桌面 WE 对照；若颜色层明显偏色，优先怀疑此处。

### 6.3 可见性与 draw call

脚本自己维护 `layer.visible = m.count > 0`（`renderParticles` 末尾）⇒ 空 mesh 不进绘制。实测活跃 26 个 mesh × 2 层 ≈ **52 draw call**，不需要额外剔除逻辑。

### 6.4 生命周期与降级

- 网格随壁纸装配创建、随 `teardown` 释放（`geometry.dispose()` + 纹理 dispose）
- 材质解析失败 / 纹理缺失 → **白图兜底材质**（与既有粒子路径同语义），不整场失败
- `vertexFormat` 不支持 → 跳过该 mesh 并 warn 一次
- 每帧上传异常 → 丢该帧，不抛进 `player` 帧循环（沿用既有整帧 try/catch）
- 无动态网格的壁纸（25/29 张）**完全不进新代码路径**

## 7. 测试与验收

**纯逻辑单测（node）**：顶点格式解析（`vertexFormat` → attribute 布局/stride）；`count` 推断（含空尾/无空尾）；材质 json → three 材质参数（blending/side/depth）；部分更新区间计算。

**集成单测（jsdom）**：`createModelData` → `createLayer` → 多次 `applyData` → `dispose` 的完整生命周期；`visible` 映射；材质缺失时白图兜底。

**e2e（headless Edge + 生产 `lib/`）**：

1. `3798688689` 画面上**真实出现粒子**：用 harness 的「屏蔽动态网格」变体做同相位对照，差异像素非零且**粒子落点与 §2.2 的 ASCII 分布一致**（不设固定百分比 —— 粒子是半透明加性叠加，占比天然很小，写死阈值会变成自欺）；
2. **零回归**：无动态网格的壁纸（如 `3743126786`）逐像素不变 —— 用 `git checkout HEAD~1 -- lib` 做 A/B（沿用一期方法）；
3. **性能**：动态网格**新增**的单帧开销（顶点拷贝 + 部分上传）**< 2 ms**；叠加一期实测的脚本开销（4.13 ms/帧）后总帧时间 **< 7 ms**（口径说明：一期是 15 脚本空 stub 的实测值，两者相加才是真实预算）；
4. `console error = 0`。

## 8. 未验证 / 风险（如实）

1. **没有真实 three 渲染的独立证据** —— S2 是自光栅化（验证了数据形态），不是 three 路径。纹理实际解码、shader 编译、blending 观感都未验证。
2. **颜色层 shader 是推断的自实现**（§6.2），无桌面对照。
3. **拖尾（`93000`）在 spike 里 `applies = 0`** —— 它只在 transition 期间发射，本次未触发；共用机制但**无独立证据**。
4. **`count` 推断依赖"脚本用 0 清尾"**这一实现细节（§6.1）；换壁纸可能需要改判据。
5. **52 draw call 与 1.79 MB/帧 memcpy 的真实开销未测**（spike 只有估算：memcpy ≈0.3 ms）。
6. `setParent` 只记录不生效：若某壁纸的 parent 是**会渲染且带变换**的图层，粒子会错位（本壁纸不是这种情况）。
7. 一期遗留：`layer.color` 仍只记录不应用（`setButton` 亮度渐变不可见）。

## 9. 与既有设计的关系

- **与一期并存**：动态网格由 `SceneScriptHost` 的同一批脚本驱动，不新增脚本运行时；宿主 API 在同一个 prelude 里扩展。
- **不替换既有粒子路径**：`CpuParticleSim`（WE `particles/*.json` 那套）继续服务其他壁纸；本设计是**第二条**粒子渲染通道，两者互不影响。
- **为子系统 B 留口**：util 合成层若将来要做，`mesh-material.ts` 的材质解析与 `dynamic-mesh.ts` 的 mesh 管理可复用。
