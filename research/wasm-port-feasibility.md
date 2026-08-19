# WASM 移植可行性调研（方向 B，2026-08-19）

- 背景：scene 显示效果与 WE 真机差距大；GitHub 无现成 Web 端 scene 播放器。用户选择评估「把原生 WE 渲染器移植到浏览器（WASM + WebGPU）」的可行性。
- 方法：git clone 源码做架构级审查（`Aromatic05/we-layerd` + 其 submodule `Aromatic05/wallpaper-engine-renderer`），grep 渲染 API 与依赖。
- 前置结论：`research/route-comparison.md`（路线 A 继续修复 vs 路线 B 重实现）。

## 1. we-layerd 真实架构（源码确认，推翻"Rust/wgpu 可移植"假设）

```
we-layerd (Rust, 0.2.7, crates/)
├── we-core        配置/扫描/播放列表（wallpaper.rs 仅 4KB）
├── we-renderer    FFI 桥接：会话管理 + DMA-BUF/SHM 帧呈现到 Wayland（lib.rs 867 行）
├── we-renderer-sys libloading 动态加载 C ABI 库（we_session_t / we_frame_v1）
└── third_party/wallpaper-engine-renderer   ← 真正的渲染引擎（submodule）
```

- **we-layerd 的 Rust 部分不是 wgpu 渲染器**，只是 Wayland 呈现壳（`WE_FRAME_KIND_DMABUF/SHM`，见 `crates/we-renderer/src/lib.rs`）。
- **真正的 scene 引擎是 `Aromatic05/wallpaper-engine-renderer`：C++/Vulkan，477 文件 / 114,913 行**（GOAL.md 显示由 catsout `wallpaper-scene-renderer` 迁移而来）。

## 2. C++ 引擎能力全景（远超路线 A 当前实现）

| 模块 | 内容 |
|---|---|
| `src/backend/scene/parser/` | WPSceneParser / WPParticleParser / WPShaderParser / WPSoundParser / WPTexImageParser / WPMdlParser(3D 模型) / WPSyntheticImageParser |
| `parser/effect/` | ColorBlend / FinalComposite / LegacyAtmosphere / QuadPosition |
| `src/backend/scene/` | WESceneBackend / WESceneRenderPlanBuilder / WESceneRuntimeDriver |
| `src/render/vulkan/` | Vulkan 实例/设备/交换链/纹理缓存/视频纹理（VideoTextureCache） |
| `src/render/vulkanrender/` | VulkanRender / VulkanPass / ClearPass / CopyPass / CustomShaderPass / **TextPass(文本)** / FinalOutputMsaa / SceneToRenderGraph |
| 渲染图 | `rg::RenderGraph`（Frostbite 风格渲染图） |
| 依赖 | glslang(GLSL→SPIR-V)、SPIRV-Reflect、nlohmann、Eigen、**quickjs(SceneScript 宿主)**、miniaudio(音频) |

## 3. WASM 移植可行性判定

| 层 | 可否移植 | 说明 |
|---|---|---|
| 解析/模拟（scene/particle/effect 逻辑/SceneScript/Eigen/miniaudio） | ✅ C++→WASM 可行 | 纯 CPU 逻辑，quickjs/Eigen/glslang 均有 Web 编译先例 |
| **渲染后端（Vulkan 全套 + RenderGraph）** | ❌ **必须重写** | 浏览器无 Vulkan，仅 WebGL/WebGPU；Vulkan 同步/内存/屏障/SPIR-V 子集与 WebGPU 差异巨大，`vulkanrender/`+`vulkan/`+`rg/` 无法编译到 WASM |
| Web 壁纸后端（CEF helper） | — | DSH 自身就是 Web，无需 |
| 视频壁纸 | — | 浏览器 `<video>` 原生替代 |

- **结论：WASM 移植 = 重写 11.5 万行引擎的 Vulkan 渲染后端为 WebGPU**（RenderGraph 概念相近，可映射，但实现量按周-月计），不是轻量移植。
- 收益上限高（原生语义：SceneScript/效果链/文本/3D 全支持），但**成本是路线 A 修复（~10 人日）的 10 倍以上，风险高**。

## 4. 视觉验证路径（本机受限）

- 验证「we-layerd 效果是否真优于路线 A」需要：Linux + Wayland compositor + Vulkan GPU + 编译 C++/Rust（重）。
- 本机现状：WSL 服务 E_ACCESSDENIED 不可用；Docker Desktop 引擎依赖 WSL2 后端无法就绪；无 Linux 环境。**短期内无法在本机做视觉对比验证**。

## 5. 建议

1. **放弃方向 B（WASM 移植）**：成本数周-月、风险高，且验证门槛高；收益上限虽高但路线 A 的差距根因已全部定位（`scene-play-research.md` §4：shader 编译 3717 条、粒子 A2、text、R8/RG88 mask）。
2. **回到方向 A**：按根因清单修复（P0-1 纹理槽路径已修 → P0-3 头文件已转写 → 剩余：编译失败明细、粒子 A2、text A5、RG88/R8），~8-11 人日，一次投入全库生效。
3. 若未来需要 we-layerd 级能力（SceneScript/交互），可将其 C++ 引擎作为**语义参考**（parser/effect 逻辑可对照转写），而非整体移植。

## 6. 参考仓库

- we-layerd（Rust 壳）：https://github.com/Aromatic05/we-layerd
- wallpaper-engine-renderer（C++/Vulkan 引擎）：https://github.com/Aromatic05/wallpaper-engine-renderer
- 本地克隆：`.superpowers/we-layerd-src/`（含 submodule 手动克隆至 `third_party/wallpaper-engine-renderer/`）
