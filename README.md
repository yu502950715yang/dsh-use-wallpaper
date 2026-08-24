# @dsh-use/wallpaper-engine

[![dsh-plugin](https://img.shields.io/badge/GitHub%20topic-dsh--plugin-1f6feb)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-DeepSeek%20Harness-4b8bbe)](https://github.com/deepseek-ai/deepseek-harness)
![license](https://img.shields.io/badge/license-MIT-green)

把 **Wallpaper Engine 壁纸**带到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 Web GUI：扫描本机 Steam workshop 壁纸库，在浏览器里实时渲染 **scene（场景）壁纸**、播放**视频壁纸**、加载 **web 壁纸**，其余回退 **preview 图 + Ken Burns**。无需 Wallpaper Engine 运行时，纯浏览器原生能力 + Three.js / WebGPU。

> **核心亮点 —— Scene 壁纸实时渲染**：不只是把一张静态图铺在 DSH 背后，而是把 Wallpaper Engine 的 `scene.json` 场景当作一个**活生生的画面来跑**——图片对象、粒子系统、对象级效果链（waterwaves / shake / fade 等）全部按帧驱动，让 DSH 界面「泡」在壁纸的动画世界里。

---

## ✨ 特性

### Scene 壁纸（重点）
- **双渲染器 + 回退链**：
  ```
  WebGPU 可用 ──► Rust/WebGPU（wasm）渲染器（图片对象 + GPU 粒子，性能最强）
       │ 无 WebGPU / 初始化失败 / 检测到对象级效果链
       ▼
  JS 渲染器（Three.js，图片 + 粒子 + 对象级效果链全部支持，兼容性最好）
       │ 渲染出 0 个可见对象 / 失败
       ▼
  preview 图回退（Ken Burns 缓慢缩放位移，永不白屏）
  ```
- 解析 Wallpaper Engine `scene.json`（正交相机、`image` / `particle` / 脚本对象），逐对象渲染。
- **对象级效果链**：每个带效果的对象独立离屏渲染 + 局部相机 + `EffectRunner`，支持 waterwaves、shake、fade 等后处理动画（Phase 1/2 已完成）。
- **粒子系统**：emitter 速率 / 方向 / 距离 + 生命周期、尺寸、速度随机，`TEXV0005` 纹理解码（LZ4 / DXT / RGBA8888），支持 WE 内置粒子素材。
- **无 Wallpaper Engine 运行时**：host 侧解包 `PKGV0001` 容器、`TEXV0005` 纹理，client 侧用 WebGL/WebGPU 渲染。
- 支持音频：scene 关联的音轨经 Web Audio 接入频谱分析器，驱动音频粒子 / visualizer 条高。

### 其余壁纸类型
- **视频壁纸**：mp4 循环播放。
- **Web 壁纸**：加载 `index.html` 及其静态资源。
- **图片壁纸**：preview 图 + Ken Burns 缩放。

### 易用性
- 壁纸目录与引擎目录**不再写死**：设置 → 壁纸 面板可自动探测（Steam 注册表 / `libraryfolders.vdf` / 常见路径）或手动填写，设置热更新。
- 壁纸切换入口在 **DSH 设置对话框侧边栏「壁纸」菜单**（`settings.section` slot 注册），点右下角「WP」浮动按钮快速切换。
- 透明度 / 模糊（Ken Burns）实时调节并持久化。

---

## 🚀 安装

### 方式一：从 GitHub 安装（推荐）

插件已作为**单包仓库**发布，仓库根 `package.json` 声明 `dsh.bundle`，可直接用 `dsh plugin` 一条命令安装：

```bash
dsh plugin --profile web add github:yu502950715yang/dsh-use-wallpaper
dsh plugin --profile web install
```

> - 依赖仓库根的构建产物（`lib/`、`dist/`）已随仓库提交，**安装时无需本地构建**，也不需要 `pnpm approve-builds` / `allowBuilds`。
> - `dsh plugin ... add` 会把 `github:` 规格转发给 pnpm。若你的 pnpm 对 git 依赖严格，出现 `ignored build scripts` 提示，在 profile 目录执行 `pnpm approve-builds` 放行本包即可。
> - 安装后 bundle 由插件自带的 `cordis.patch.yml` 自动注册到 `dsh.profile.bundles`，**不要**再手动把它插入 profile 的 `cordis.patch.yml`（重复 insert 会报 `duplicate loader entry id`）。

### 方式二：本地开发调试（`file:`）

```bash
dsh plugin --profile web add "@dsh-use/wallpaper-engine@file:<本仓库根目录绝对路径>"
dsh plugin --profile web install
```

### 方式三：npm（若后续发行到 npm registry）

```bash
dsh plugin --profile web add "@dsh-use/wallpaper-engine"
```

---

## 📦 前置条件

| 项 | 说明 |
|---|---|
| DeepSeek Harness | 需 `dsh web` / `web` profile（插件面向 DSH Web GUI） |
| Wallpaper Engine | **建议**已装上（Steam，workshop 内容目录 `workshop/content/431960`）。提供 scene / 视频 / web 壁纸来源 |
| 浏览器 | 支持 WebGL 的现代浏览器（Chrome / Edge 推荐）；支持 WebGPU 时启用高性能 wasm 渲染器 |
| Node | ≥ 18（仅开发/构建时用，运行时由 DSH 宿主加载） |

> **关于 Wallpaper Engine 内置粒子纹理**：`build:client` 会把本地 WE 安装目录的粒子纹理复制到 `dist/static/ptex-*.tex` 供分发，但这些纹理**不入库**——运行时 `wasm-renderer` 会改从 `/wallpapers/particle-texture`（你本机 `weAssetsDir` 的 WE 安装）实时读取；若未装 WE 或未配置 `weAssetsDir`，相关粒子纹理**回退为纯色**，背景其余部分正常显示（**绝不白屏**）。

---

## ⚙️ 配置

在 **设置 → 壁纸** 面板（侧边栏「壁纸」菜单）：

- **壁纸目录 `wallpaperDir`**：Steam workshop 壁纸目录（自动探测候选，或手动填写）。未配置时回退默认 `D:/Steam/steamapps/workshop/content/431960`。
- **引擎目录 `weAssetsDir`**：Wallpaper Engine 安装目录（供 `/wallpapers/particle-texture` 读取内置粒子纹理）。
- 透明度 `overlayOpacity`、模糊 `blurEnabled` / `blurRadius`、Ken Burns 开关。

也可在 profile 的 `cordis.patch.yml` 中覆盖（优先级：用户设置 > config > 缺省）。

---

## 🖱 使用

1. 重启 `dsh web`，打开 `http://127.0.0.1:3080`。
2. 右下角出现「WP」浮动按钮，点击展开壁纸选择面板（缩略图网格）。
3. 选择壁纸：scene 壁纸实时渲染、视频循环播放、图片 Ken Burns。
4. 验证：`http://127.0.0.1:3080/wallpapers/list` 返回 JSON 壁纸数组；DevTools Console 存在 `window.__wallpaperEngine`。

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
npm install
npm run build          # tsc -p tsconfig.json → lib/（host 编译）
npm run build:wasm     # wasm-pack build --target web --release --features render → wasm/pkg/
npm run build:client   # esbuild 打包 client → dist/client.js + 复制 wasm 到 dist/static/
npm test               # vitest run（node + jsdom 双环境）
```

> 构建顺序：改过 `wasm/`（Rust）必须先 `npm run build:wasm` 再 `npm run build:client`（client 复制的是 `wasm/pkg` 产物）。

---

## 🧩 架构一览

```
src/host/     Node 侧（Cordis 插件）：扫描壁纸目录、解包 PKGV0001、HTTP 路由、steam 路径探测、设置
src/client/   浏览器侧（esbuild 打包为 dist/client.js）：scene 渲染（WebGPU/Three.js）、粒子、效果链、
              纹理解码、设置面板（settings.section）、控制器/回退链
src/shared/   跨 host/client 类型
wasm/         Rust 引擎（wasm-bindgen + wgpu）：coords / scene / tex / particle / render
tests/        vitest 单测（node + jsdom）
```

---

## 📄 许可与致谢

- 代码：MIT。
- 壁纸、粒子纹理等素材版权归原作者 / Wallpaper Engine 所有，插件只负责在其上渲染，不重新分发第三方素材。
- 灵感与格式语义对齐自 [linux-wallpaperengine](https://github.com/linux-wallpaperengine) / 开源 Wallpaper Engine 逆向实现。

---

## 🔗 相关链接

[GitHub 仓库](https://github.com/yu502950715yang/dsh-use-wallpaper) · [dsh-plugin 主题页](https://github.com/topics/dsh-plugin) · [deepseek1024.com 插件市场](https://deepseek1024.com) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
