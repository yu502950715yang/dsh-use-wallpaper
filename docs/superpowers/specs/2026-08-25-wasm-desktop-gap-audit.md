# Wasm 渲染器 vs 桌面版 WE —— 差距清单与路线

- 日期：2026-08-25
- 目的：系统性审计 wasm 渲染器（当前主路径）与桌面版 WE 之间的**全部渲染差距**，给出每项的**优先级**与**可行性**，并推荐实施路线。
- 资料来源：
  - `research/audit-desktop-pipeline.md`（桌面版 open-wallpaper-engine C++/Vulkan 渲染管线，~102 环节）
  - `research/audit-wasm-capabilities.md`（我们 wasm 渲染器现状，10 维度）
  - `research/audit-scene-fields.md`（scene.json 渲染字段语义与桌面版用法）
  - `docs/superpowers/specs/2026-08-25-wasm-object-effect-chains-design.md`（对象级效果链设计蓝图，含 naga 卡点）
  - 自查：`wasm/src/shaders/image.wgsl`（纯静态贴图）、`wasm/src/render/camera.rs`（仅 contain/cover 范围）

---

## 0. 核心结论

**当前 wasm 渲染器是一个「静态场景渲染器」**：渲染场景图片 quad + GPU 粒子 + contain/cover 基本相机。它**缺失**桌面版渲染管线的大部分"视觉灵魂"环节。用户观察到的"与桌面不一致"，主要来自以下差距。

差距按**视觉影响强度**排序如下（编号即优先级）。

---

## 1. 差距清单（按视觉影响 / 优先级排序）

### ★ P0 — 对象级效果链（Object-level Shader Effects）【未实现】

- **影响**：WE 大量高质量壁纸靠对象级 effects（waterwaves 水波 / godrays 光晕 / foliagesway 植被摇曳 / shake 震动 / iris / 泛光类后处理 pass）制造动态与光感。这是"和桌面不一致"的**最大**因素（Orange 13 个效果对象、Subway Station 17 个、Crimson Horizon 5 个都缺）。
- **现状**：wasm 已在 `SceneObject.effects` 解析并保留字段，但 `render_frame` **从不消费**它 → 带 effects 壁纸渲染成 STATIC（静态图+粒子）。
- **参考蓝图**：`wasm-object-effect-chains-design.md` —— 对象级 Layer/CompositeTarget（对象 RT + 局部 2×2 相机 + ping-pong 效果链 pass + 合成 quad + UV 窗口）。
- **可行性**：**高难度，引擎级，但可增量**。已设计完整（对象 RT、局部相机、每 pass ping-pong、blendMode 映射、`g_Texture0..N`/`g_Time`/`g_TextureNResolution`）。**卡点**：naga 的 GLSL frontend 无法编译 WE 方言的某些构造（sampler2D uniform、`NotImplemented("variable qualifier")`、需 desktop GLSL 450 + binding/location 前置转换）。这需要 `glsl-to-naga` 前置转换 + naga（或改用 tint/shaderc 的 wasm 编译链）。
- **成本**：大（M1-M5 里程碑，含 naga 前置转换适配）。**建议作为分阶段大目标**。

### ★ P1 — 图层合成与混合模式【未实现】

- **影响**：桌面版支持对象级 `composite_target` RT + 混合模式（Disable/Normal/Translucent/Additive/AlphaToCoverage），以及特殊合成纹理（`_rt_imageLayerComposite` 等）。wasm 无图层/混合概念，逐对象直出 → 半透明/叠加层表现错误。
- **参考**：`SceneNodeLayer.cpp:44-158`、`PassCommon.cppm:12-33`（open-wallpaper-engine）。
- **可行性**：**中**——与效果链管线共享"对象 RT + 合成"基础，做完 P0 后承接。

### ★ P2 — bloom 全局后处理【未实现】

- **影响**：`general.bloom` + `bloomstrength/bloomthreshold/bloomhdr*`。发光/霓虹氛围的核心（赛博朋克/霓虹壁纸）。wasm 无任何后处理 pass。
- **参考**：`ScenePostProcess.cpp:132-225`（hdr 决定 HDR/LDR bloom 路径）。
- **可行性**：**低成本独立项**——一个全屏 blur + 加权 combine 的后期 pass。做完 P0 的对象 RT 基础后可快速补。优先级：高且独立。

### ★ P3 — 相机视差 + 鼠标反馈【未实现】

- **影响**：`cameraparallax*` + `parallaxDepth` + 鼠标 influence → 2.5D/视差壁纸的动态立体感（多层前后移动）。wasm 连 `camera.center/eye/up` 都没用（只读 orthogonalprojection）。
- **参考**：`UniformSource.cpp:236-247, 393-416, 527-535`。
- **可行性**：**中低**——需要相机模型（LookAt/透视）+ parallax 传播 + 鼠标位置反馈。与 P0/P1 独立。

### ★ P4 — 粒子系统完整模拟【部分实现】

- **影响**：wasm 粒子只有 emitter[0] + 5 种 initializer + 无 operator 系统（movement 不生效、alphafade 硬编码三角波），无 renderer 类型（sprite/ropetrail/spritetrail），无 controlpoint（link_mouse 鼠标跟随、audio）。复杂粒子（粒子拖尾、鼠标粒子）与桌面差异明显。
- **参考**：`ParticleProgram.cppm:34-95`、`ParticleRuntime.cpp:538-627`。
- **可行性**：**中**——wasm 已有 GPU 粒子基础，补 operator 系统 + renderer 类型 + controlpoint。细化推进。

### ★ P5 — 文本渲染【未实现】

- **影响**：text 对象在 wasm 完全**不渲染**（落入空粒子兜底）。时钟文本、标题、字幕壁纸无文字。wasm-renderer 只处理 image/particle。
- **参考**：桌面版 FreeType + glyph atlas + TextLayouter 排版。
- **可行性**：**中低**——需要在 wasm 加文本纹理渲染（离屏 canvas 或 glyph atlas + 排版）。wasm 现在没有文本管线；JS 侧 `text-object.ts` 已有蓝本。

### ★ P6 — 光照 / ambient / skylight【未实现】（两个渲染器都缺）

- **影响**：`ambientcolor`/`skylightcolor` 是受光材质的环境光/天光底色。桌面版也只是部分支持（六组光照全局 uniform + 阴影 atlas；仍无真正 tonemap）。
- **现状**：wasm 的图像 shader 是无光照直通。**注意**：JS 渲染器（scene-renderer.ts）同样无光照 → 这个不是"wasm 相对 JS"的缺口，而是整体渲染内核都缺。
- **可行性**：**中**——需要光照 uniform + 材质 shader 受光。与场景深度相关，非首选。

### ★ P7 — 平面反射 / 阴影 / 卡通材质等细项【未实现】

- 平面反射（水面/镜面）、阴影（directional shadow atlas）、以及 Puppet 骨骼（桌面版自身也未实现，wasm 不必强求）。
- **可行性**：低优先级（不是场景普遍需求）。

### ★ P8 — 颜色空间 / sRGB / 色调管理【未实现】

- wasm 色彩管线是"非 sRGB 直通"（`texture.rs:15-25`）。桌面版 LDR8 直出、sRGB 管理也不强 → 这是长期视觉对齐隐患，但**桌面版自身也弱**，wasm 不必现在就补。

---

## 2. 实施路线建议

按"视觉回报 / 成本"权衡，推荐的推进顺序：

1. **P0 对象级效果链**（最高视觉回报，但最高成本、有 naga 卡点）——已有一份完整设计，建议先用 spike 验证能否用 tint/shaderc 的 wasm 编译绕过 naga sampler2D 卡点，再决定是否投入。这决定"和桌面一致"的最大一块。
2. **P2 bloom**（低成本独立，补霓虹/发光氛围）——做完 P0 的对象 RT 基础后可快速加。
3. **P1 图层混合**（与 P0 共享基础，承接）。
4. **P4 粒子完善**（中成本，wasm 已有 GPU 粒子基础，补 operator/renderer/controlpoint）。
5. **P3 相机视差**（中低，需相机模型 + 鼠标反馈）。
6. **P5 文本**（中低，需文本管线）。

**关键判断**：用户近期观察到的"Crimson Horizon / DK WOTLK 与桌面不一致"，主因是 **P0（效果链）+ P4（粒子完整度）**（DK WOTLK 无效果链，是粒子/色调；Orange 是效果链）。**单个桌面的精确对齐**往往需要 P0 效果链，而那是引擎级大工程。

---

## 3. 已可落地的小改进（非效果链）

- ✅ **粒子数量偏多**已修复：wasm 现优先用粒子 spec 的 `maxcount`（commit `99cbc16`），而非 `rate×寿命+64` 估算。Crimson Horizon 的 Fireflies（maxcount=20）数量已接近桌面版。
- ⏳ **色调差异**（青暗 vs 白亮）：DK WOTLK 的 `clearcolor=0.7 0.7 0.7` + `ambientcolor=0.3`（光照）——wasm 无光照模型、且 cover 前景铺满（清屏色被覆盖），色调与桌面有差。补齐光照/色调是 P6/P8（不优先）。

---

## 4. 待确认 / 需用户决策

- **主攻方向**：是否投入 P0 效果链（引擎级大工程）？还是先做 P2 bloom + P4 粒子完善（中成本、能改善多数壁纸的动态感）？
- 从"让壁纸更接近桌面"角度，**P0 效果链回报最大但成本/风险最高**；P2 + P4 是更稳健的增量。
