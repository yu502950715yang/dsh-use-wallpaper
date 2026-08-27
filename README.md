# @dsh-use/wallpaper-engine

[![dsh-plugin](https://img.shields.io/badge/GitHub%20topic-dsh--plugin-1f6feb)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-DeepSeek%20Harness-4b8bbe)](https://github.com/deepseek-ai/deepseek-harness)
![license](https://img.shields.io/badge/license-MIT-green)

把 **Wallpaper Engine 壁纸**带到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 Web GUI：扫描 Steam workshop 壁纸库，在浏览器里渲染 **scene（场景）壁纸**、播放**视频壁纸**、加载 **web 壁纸**，其余回退 **preview 图 + Ken Burns**。不依赖 Wallpaper Engine 运行时，纯浏览器原生能力 + Rust/WebGPU（wasm）渲染器。

> **当前主渲染路径 —— Scene 壁纸 wasm 渲染**：scene 壁纸由 Rust/wgpu 编译为 WebAssembly 的渲染器在浏览器里实时绘制（WebGPU 背板），覆盖 `image` 图片对象与 GPU 粒子。其余壁纸类型分别走视频 / web / preview 回退。

---

## ✨ 特性

### Scene 壁纸（wasm 渲染，主路径）

- **wasm 渲染器（Rust/wgpu，WebGPU）**：解析 Wallpaper Engine `scene.json`，逐对象渲染。`image` 对象按 `scene.pkg` 内容解码 TEXV0005 纹理（LZ4 解压，RGBA8888 / DXT / R8 / RG88）后作为图片平面；`particle` 对象走 GPU 粒子管线（emitter + initializer + operator 解析）。
- **回退链（强制 wasm，无 JS 降级）**：
  
  ```
  浏览器支持 WebGPU ──► wasm 渲染器（图片平面 + GPU 粒子）
        │ 无 WebGPU / 加载或初始化失败 / 渲染出 0 个可见对象
        ▼
  preview 图回退（Ken Burns 缓慢缩放位移，永不白屏）
  ```
  
  > 注：历史上曾有 wasm → JS(Three.js) 渲染器 → preview 的三级回退，`createFallbackSceneRenderer` 也保留了 JS 渲染器形参，但**当前策略是强制 wasm**——离开 wasm 后不再降级 JS 渲染器，而是直接回退 preview 图。JS/Three.js 渲染器、音频频谱、text/visualizer/clock 脚本等源码仍保留在仓库并有单测覆盖，但**未接入当前运行时回退链**（为后续独立计划）。**对象级效果链例外**：wasm 侧对象级效果链**渲染架构已接入**（见下方 Roadmap），接入的是 Rust/wgpu 实现（非 JS 的 EffectRunner）。
- **坐标对齐**：WE 场景系为左下原点、y 向上；映射 `three.x = we.x - vw/2`、`three.y = we.y - vh/2`（不做 y 翻转）。
- **容器/纹理解包**：host 侧读取 `PKGV0001` 容器（`pkg-reader.ts`），client/wasm 侧消费 TEXV0005 纹理字节。
- **粒子纹理**：WE 内置粒子纹理（fog/halo/light_shafts 等）由 `build:client` 从本机 WE 安装目录复制到 `dist/static/ptex-*.tex`，wasm 渲染器优先经 `/wallpapers/static/ptex-*.tex` 读取；`/wallpapers/particle-texture` 路由（从 `weAssetsDir` 实时读取）为备选。两者都不可用时粒子回退为纯色（**绝不白屏**）。

### 其余壁纸类型

- **视频壁纸**：`mp4` 循环播放。
- **Web 壁纸**：以沙箱 iframe 加载 `index.html` 及其静态资源。
- **图片壁纸**：preview 图 + Ken Burns 缩放。

### 易用性

- 壁纸目录与引擎目录**不再写死**（不默认 `D:/Steam`）：设置 → 壁纸 面板可自动探测（Steam 注册表 + `libraryfolders.vdf` + 常见路径，`/wallpapers/probe`）或手动填写，settings 热更新，无需重启 harness。
- 壁纸切换入口在 **DSH 设置对话框侧边栏「壁纸」菜单**（`settings.section` slot 注册）。
- 透明度 / 模糊 / Ken Burns 实时调节并持久化（经 DSH settings RPC）。

---

## 🗺 接下来（wasm 渲染 Roadmap）

当前主渲染路径为 **wasm（Rust/wgpu）渲染器**，目标是让 scene 壁纸在浏览器里效果**逼近 WE 真机**。以下能力在 JS/Three.js 渲染器中**已有实现并通过单测**；到 wasm 侧**对象级效果链渲染架构已接入**（下述第 1 项，编译链待联网集成），其余能力在强制 wasm 路径下**尚未接入运行时的 wasm 渲染器**——逐个移植到 Rust/wgpu 是后续的主线：

### 优先：对象级效果链（含动画效果）—— 架构已接入 wasm，编译链待联网集成

- **架构现状（已接入）**：对象级效果链**渲染架构**已接入 wasm（Rust/wgpu）——每个带效果对象独立离屏对象 RT + 局部正交相机 + `EffectChain` ping-pong 效果链 post-pass + 合成 quad（UV 窗口）贴回共享场景；`image` 与 `particle` 对象共用对象路径，`SceneScript` 并存驱动。wasm-renderer 已移除 `hasEffectChains` 拦截（强制 wasm，无 JS 降级）。
- **⚠️ 编译链待联网集成（关键状态）**：真实 WE 效果 shader 的 **GLSL→WGSL 编译链（`spirv-webgpu-transform`）尚未集成**（依赖【需联网环境】，见 `progress.md`）。原因是 naga 24/25 的 glsl frontend **无法编译含 `uniform sampler2D`（即 `g_Texture0`）的 WE shader**（报 `NotImplemented("variable qualifier")`），而几乎全部效果链 shader 都用 `g_Texture0` 采样——方案 A（naga glsl-in 直接编译 WE GLSL）对多数 shader 不成立。当前 **M5 阶段用内置演示 shader（g_Time 程序化，naga glsl-in 可编译）验证对象级管线架构**（对象 RT → 效果链 → 合成 quad 链路走通）。**真实效果壁纸的非 STATIC 目标需编译链集成后达成**；在此之前带效果壁纸仍可能呈现 STATIC 的静态内容（demo pass 会以程序化动画替代内容，见 `mod.rs` 注释）。
- **接下来（编译链）**：把 JS 侧 `effect-runner.ts` + `shader/` 方言层（GLSL→WGSL 转换、uniform 绑定、内置头）的**编译链**接入（`spirv-webgpu-transform`），把真实 WE shader 编译出的 WGSL 喂入同一 `EffectPassDesc` 管线（架构通用，仅换编译来源）。
- **对齐语义**：参考现有 JS 侧对象级效果链与 `research/open-wallpaper-engine` 的 Layer/CompositeTarget 语义。

### 后续（按序）

- **text 对象 + clock / visualizer 脚本**：把 `text-object.ts` + `script-patterns.ts` 移植到 wasm，支持静态文本、时钟文本与音频频谱条。
- **音频可视化**：把 `audio-input.ts` 的分析器移植到 wasm（频谱 → 音频粒子 / visualizer 条高 uniform）。
- **用户属性 / 视觉脚本求值**：`visible:{user,value}` 等可切换属性正确求值（wasm 侧当前恒定回退默认值）。

> 说明：以上都是"渲染内核补全"性质，非新增重做；JS 侧源码与测试可作为移植蓝本。

---

## 🚀 安装

插件为**单包仓库**，仓库根 `package.json` 声明 `dsh.bundle`（`cordis.patch.yml` 自动注册到 `dsh.profile.bundles`）与 `dsh.client`。构建产物 `lib/`、`dist/` 已随仓库提交，安装时无需本地构建。

### 方式一：本地开发调试（`file:`，推荐本地改码）

在 DSH 的 `web` profile 目录（如 `C:\Users\<user>\.dsh\profiles\web`）执行：

```bash
pnpm add "@dsh-use/wallpaper-engine@file:E:/code/dsh-use-wallpaper"
pnpm install
```

> 或用 `dsh plugin` 快捷添加（若你的 CLI 支持插件管理）：
> 
> ```bash
> dsh plugin --profile web add "@dsh-use/wallpaper-engine@file:E:/code/dsh-use-wallpaper"
> dsh plugin --profile web install
> ```

### 方式二：从 GitHub 安装（推荐分发）

```bash
dsh plugin --profile web add github:yu502950715yang/dsh-use-wallpaper
dsh plugin --profile web install
```

> `dsh plugin ... add` 会把 `github:` 规格转发给 pnpm。安装后 bundle 由 `cordis.patch.yml` 自动注册，**不要**再手动把它插入 profile 的 `cordis.patch.yml`（重复 insert 会报 `duplicate loader entry id`）。

### 方式三：npm（若后续发行到 npm registry）

```bash
dsh plugin --profile web add "@dsh-use/wallpaper-engine"
```

**改代码后刷新到 profile**：profile 以 `file:` 引用且是快照复制，pnpm 通常不会刷新。可靠方式是把构建产物复制进 profile 的 node_modules：

```powershell
$src = "E:\code\dsh-use-wallpaper"
$dst = "$env:USERPROFILE\.dsh\profiles\web\node_modules\@dsh-use\wallpaper-engine"
Copy-Item "$src\lib\*"  "$dst\lib\"  -Recurse -Force
Copy-Item "$src\dist\*" "$dst\dist\" -Recurse -Force
```

> host 侧（`lib/`）改代码需重启 `dsh web` 生效；client 侧（`dist/client.js`）刷新页面即可。

---

## 📦 前置条件

| 项               | 说明                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| 平台支持         | **当前仅适配 Windows**，macOS 尚未测试                                                                               |
| DeepSeek Harness | 需`dsh web` / `web` profile（插件面向 DSH Web GUI）                                                                  |
| Wallpaper Engine | **建议**已装上（Steam，workshop 内容目录 `workshop/content/431960`）。提供 scene / 视频 / 壁纸来源                   |
| 浏览器           | 现代浏览器（Chrome / Edge 推荐）。scene 壁纸需支持**WebGPU**；不支持时 scene 壁纸回退为 preview 图，其余类型不受影响 |
| Node             | ≥ 18（仅开发/构建时用，运行时由 DSH 宿主加载）                                                                      |

> **⚠️ 平台说明**：本插件**只在 Windows 上做过测试**，macOS 未验证。涉及本机路径（Steam 目录探测、Wallpaper Engine 安装目录、`D:` 盘默认路径假设）以及浏览器 / WebGPU 行为均以 Windows 为准。**macOS 用户请自行验证后使用**，遇到问题可通过 Issue 反馈。

---

## ⚙️ 配置

在 **设置 → 壁纸** 面板（侧边栏「Wallpaper 壁纸」菜单）：

- **壁纸目录 `wallpaperDir`**：Steam workshop 壁纸目录（自动探测候选，或手动填写）。未配置时视为未配置，列表为空。
- **引擎目录 `weAssetsDir`**：Wallpaper Engine 安装目录（供粒子纹理等 WE 内置资源读取）。
- 透明度 `overlayOpacity`、模糊 `blurEnabled` / `blurRadius`、Ken Burns 开关、选中壁纸 `selectedWallpaperId`。

优先级：用户设置 > profile `cordis.patch.yml` 的 `config` > 缺省（空）。

---

## 🖱 使用

1. 重启 `dsh web`，打开 `http://127.0.0.1:3080`。
2. 打开 DSH **设置对话框 → 侧边栏「Wallpaper 壁纸」菜单**，展开壁纸缩略图网格并选择。
3. 选择壁纸：scene 壁纸由 wasm 实时渲染、视频循环播放、图片 Ken Burns。
4. 验证：`GET /wallpapers/list` 返回 JSON 壁纸数组；DevTools Console 存在 `window.__wallpaperEngine`（`mount` / `select` / `show` 渲染 API）。

---

## 🧹 卸载

```bash
dsh plugin --profile web remove "@dsh-use/wallpaper-engine"
dsh plugin --profile web install
# 重启 dsh web
```

---

## 🛠 构建与开发

```bash
cd <本仓库根>
pnpm install
pnpm run build          # tsc -p tsconfig.json → lib/（host 编译，strict）
pnpm run build:wasm     # cd wasm && wasm-pack build --target web --release --features render → wasm/pkg/
pnpm run build:client   # node scripts/build-client.mjs → dist/client.js + 复制 wasm 与粒子纹理到 dist/static/
pnpm test               # vitest run（node + jsdom 双环境）
```

> - 构建顺序：改过 `wasm/`（Rust）必须先 `pnpm run build:wasm` 再 `pnpm run build:client`（client 复制的是 `wasm/pkg` 产物）。
> - `build:client` 会从本机 WE 安装目录（可用环境变量 `WE_ASSETS_DIR` 覆盖）复制内置粒子纹理到 `dist/static/ptex-*.tex`；这些纹理不入库，运行时缺失则粒子回退纯色。

---

## 🧩 架构一览

```
src/host/     Node 侧（Cordis 插件）：扫描壁纸目录、解包 PKGV0001、HTTP 路由、Steam 路径探测、settings
src/client/   浏览器侧（esbuild 打包为 dist/client.js）：bootstrap + 壁纸控制器、wasm 渲染胶水、settings.section 面板、背景层样式
              （另含未接入运行时回退链的 Three.js 渲染器 / 效果链 / 音频 / 文本脚本实现与单测）
src/shared/   跨 host/client 类型（WallpaperInfo、SceneDescription、SceneObject 等）
wasm/         Rust 引擎（wasm-bindgen + wgpu）：coords / scene / tex / particle / render
scripts/      build-client.mjs（esbuild 打包 + wasm/粒子纹理复制）
tests/        vitest 单测（node + jsdom 双环境）
docs/         开发环境配置（dev-setup.md）；设计文档与实施计划（superpowers/*）
```

---

## 📄 许可与致谢

- 代码：MIT。
- 壁纸、粒子纹理等素材版权归原作者 / Wallpaper Engine 所有，插件只负责在其上渲染，不重新分发第三方素材。
- 格式语义对齐自 [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) / 开源 Wallpaper Engine 逆向实现。

---

## 🔗 相关链接

- [GitHub 仓库](https://github.com/yu502950715yang/dsh-use-wallpaper)
- [dsh-plugin 主题页](https://github.com/topics/dsh-plugin)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [开发环境配置（docs/dev-setup.md）](docs/dev-setup.md) — 在新电脑上继续开发所需的工具链与构建/运行环境

