# DSH Wallpaper Engine Scene 渲染 — Rust/WebGPU 通用引擎（v1）

- 日期：2026-08-19
- 状态：设计中（用户已确认技术路线 R1：Rust + WebGPU、现代 Chromium 兼容、v1 范围=粒子+图片、解析全在 Rust）
- 项目根：`E:\code\dsh-use-wallpaper`
- 关联：`research/scene-play-options.md`（方案空间）、`research/wasm-port-feasibility.md`（WASM 移植否决：C++/Vulkan 不可移植；本设计为"从零写 Rust 渲染内核"，非移植）、`research/scene-play-research.md`（24 壁纸实测 + 根因清单 + 坐标数学）
- 目标：**通用插件**——分发到任意 DSH 用户机器（现代 Chromium），浏览器内渲染 Wallpaper Engine scene 壁纸，效果逼近 WE 真机。

## 1. 背景与目标

现状（路线 A：JS/Three.js WebGL 渲染器）效果与 WE 真机差距大，根因全部定位（shader 编译失败 3717 条、粒子简化、text 缺失、R8/RG88 不支持等，见 scene-play-research.md §4）。用户目标修正为**通用插件**（任意用户可用），并选定**其他语言（Rust）+ WebGPU** 路线：

- **通用性**：纯浏览器渲染（wasm 随插件分发，零本地依赖）；host 侧复用现有通用逻辑（自动扫描任意用户 WE 库）。
- **效果上限**：WebGPU 提供 compute shader（GPU 粒子模拟）与 BC/R8/RG88 原生纹理格式，消除 WebGL 版结构性债务。
- **兼容底线**：现代 Chromium（Edge/Chrome 113+，WebGPU 稳定）；Firefox/老版本不保证（回退链兜底，见 §7）。

## 2. 总体架构与数据流

```
┌─ 任意用户的 DSH Web GUI（浏览器）──────────────────────┐
│  client 胶水（JS，复用现有 fetch/回退逻辑）              │
│   ├─ fetch 资源字节流（现有 /wallpapers/scene/<id>/asset 路由）│
│   ├─ WebAssembly.instantiateStreaming → Rust 引擎       │
│   └─ wgpu 渲染到 canvas（WebGPU）                       │
└───────────────┬───────────────────────────────────────┘
                │（HTTP，host 提供字节流）
┌───────────────▼───────────────────────────────────────┐
│  host（Node/Cordis 插件，通用，现有代码直接复用）         │
│   scanner.ts 扫描任意用户 WE 库（Steam 默认路径+自定义）   │
│   pkg-reader.ts PKGV0001 解包                          │
│   routes.ts 资源路由（穿越防护 + no-store）              │
└───────────────────────────────────────────────────────┘
```

- host 侧**全复用现有代码**（通用插件自动发现任意用户壁纸库，无需改动）。
- 解析全在 Rust：scene.json / 粒子 / 纹理（LZ4/DXT）——host 只提供字节流。
- 主渲染器 = Rust/wgpu；WebGPU 不可用或 wasm 加载失败 → 回退现有 JS/WebGL 渲染器（§7）。

## 3. Rust 引擎模块划分（新 crate `we-scene-wasm`）

位于 `packages/dsh-wallpaper-engine/wasm/`（或独立 workspace crate），wasm32-unknown-unknown target，产物 `we-scene.wasm` + wasm-bindgen glue 随插件 bundle 分发。

| 模块 | 职责 | 依赖 |
|---|---|---|
| `scene/` | scene.json 解析（camera/orthogonal/objects/image/particle）+ 坐标映射 | serde_json |
| `particle/` | 粒子规格解析（emitter/initializer/operator）+ **compute shader GPU 模拟** | — |
| `tex/` | TEXV0005 容器解析（LZ4 解压 + 格式分派：RGBA8888/BC1/2/3/R8/RG88） | lz4_flex |
| `render/` | wgpu 管线：正交相机、图片平面、粒子点渲染、内置纹理（util/white、noise） | wgpu, bytemuck |
| `wasm/` | wasm-bindgen 导出 API：`init` / `setScene` / `setTexture` / `setParticle` / `step(dt)` / `resize` / `frame` | wasm-bindgen, web-sys |

**关键：wgpu 编译到 wasm32（WebGPU 后端）是官方支持路径**（与 Bevy 等生产用例相同）。

## 4. 粒子系统（compute shader，v1 核心）

- **GPU 模拟**（WGSL compute）：emitter 生成（rate/directions/distancemin/max）、initializer（lifetimerandom/sizerandom/velocityrandom）、operator（movement/alphafade，v1 至少这两个）、寿命衰减、尺寸/颜色插值全在 GPU 侧。
- 渲染：`PointList` primitive + 加法混合（保持现有混合语义）。
- 数据路径：JS/胶水把粒子规格 JSON 字节流传给 Rust → Rust 解析 → 生成 compute 管线参数。
- 坐标：沿用现有映射（`three.x = we.x - vw/2`、`three.y = vh/2 - we.y`、`scale.y` 取负，见 scene-renderer.ts 文件头注释与 README 坐标数学节）。

## 5. 纹理解码（WebGPU 结构性优势，直接兑现）

| 格式 | WebGL 版现状（债务） | WebGPU 版 |
|---|---|---|
| RGBA8888 | OK | `rgba8unorm` |
| BC1/2/3（DXT） | 需 s3tc 扩展 + 手动行翻转（P2 债务） | **原生 `texture-compression-bc` 上传，不解压** |
| R8 / RG88（mask 类） | 不支持（tex-loader 返回 null → mask 缺失） | 原生 `r8-unorm` / `rg8-unorm` |
| LZ4 解压 | JS 侧 lz4js | Rust `lz4_flex`（更快） |

- 内置纹理（效果链 v2 需要，v1 先实现）：`util/white` → 1×1 白；`util/noise` → 确定性噪声生成（mulberry32 种子，与现有 JS 一致）。

## 6. 相机与渲染

- 正交相机：contain 语义（场景完整可见、留白透明）——沿用现有 `containRange` 数学；`CAMERA_DISTANCE=300` 使点尺寸=像素尺寸。
- 离屏 RT（场景渲染目标）→ 最终全屏 quad 贴到 canvas（透明 alpha），为 v2 效果链预留输入。
- resize 处理：`renderer.setSize(vw, vh)` 等价语义。

## 7. 通用插件集成（DSH）与回退链

- wasm 产物作为插件 bundle 静态资源；client `fetch` + `WebAssembly.instantiateStreaming` 加载。
- **回退链（安全网）**：
  1. 无 WebGPU（`navigator.gpu` 不存在）→ 现有 JS/WebGL 渲染器（代码已在，零额外成本）；
  2. wasm 加载/初始化失败 → 现有 JS/WebGL 渲染器；
  3. 渲染零对象（解析失败/全部资源缺失）→ 现有 preview 图回退（controller 现有逻辑）。
- 兼容底线：现代 Chromium（Edge 113+/Chrome 113+）；`navigator.gpu` 检测 + 回退，不硬性报错。
- 用户壁纸库发现：host `scanner.ts` 现有逻辑（Steam 默认路径 `D:/Steam/steamapps/workshop/content/431960` + 自定义 `wallpaperDir`）。

## 8. 测试与验收

- **Rust 单测**（cargo test，native target 可跑逻辑测试）：scene.json 解析、坐标映射、LZ4 解压、BC 头解析、粒子参数解析。
- **浏览器实测**：headless Edge + CDP 双帧 diff（复用 `research/verify-*.mjs` 模式）。
- **v1 验收标准**：
  1. EVA（1280029027）在 DSH 由 Rust/WebGPU 渲染，效果 ≥ 现有 WebGL 版（粒子在动、坐标正确、不黑屏）；
  2. 24 壁纸 0 黑屏（回退链生效）；
  3. FPS ≥ 30（1080p，WebGPU 路径）；
  4. wasm 加载失败/无 WebGPU 时自动回退 JS 渲染（手动禁用 WebGPU 验证）。

## 9. 里程碑（v1）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 环境与骨架 | wasm target 安装（换源解决镜像 403）、crate 结构、wasm 加载进 DSH 渲染最小图形（纯色 quad） | 页面出现 wasm 渲染的 canvas |
| M2 scene.json + 图片对象 | scene.json 解析、坐标映射、图片平面渲染（EVA 主图铺满、位置正确） | EVA 主图正确铺满视口 |
| M3 纹理解码 | TEXV0005 全格式（RGBA8888/LZ4/BC1/2/3/R8/RG88）+ 内置纹理 | EVA 纹理渲染正确、mask 类纹理可加载 |
| M4 粒子系统 | compute shader 粒子（emitter/initializer/movement/alphafade） | EVA Ashes/fog 粒子动效达标（双帧 diff） |
| M5 插件集成 | 路由复用、wasm 分发、回退链、全库实测 | 验收标准 1-4 全过 |

- 效果链（v2：GLSL→WGSL 转换 + RT 链）、text（v3）、音频/交互（v3+）为后续里程碑，本 spec 不展开。

## 10. 已知风险与对策

| 风险 | 对策 |
|---|---|
| rustup 清华镜像 403（wasm target 装不上） | `RUSTUP_DIST_SERVER` 官方源/rsproxy 镜像；或手动下载 rust-std 包安装 |
| wgpu 在 wasm 的编译配置（features） | 按 wgpu wasm 标准配置（webgpu 后端，禁用 vulkan/gl 后端） |
| wasm 体积/加载时间 | release + wasm-opt；目标 ≤ 2MB；加载期间显示现有 WebGL 渲染（渐进增强） |
| WebGPU BC 纹理格式在部分 GPU 不可用 | `texture-compression-bc` 特性检测，缺失时 Rust 侧软解 DXT（自写解码，v1 后补） |
| WE 粒子/效果语义细节偏差 | 以 linux-wallpaperengine/catsout 文档为语义蓝本（scene-play-research.md §7） |

## 11. 非目标（v1 明确不做）

- 效果链（shader 后处理）——v2
- text 对象、SceneScript、音频可视化、鼠标交互——v3+
- C++/Vulkan 引擎移植（wasm-port-feasibility.md 已否决）——不采用
