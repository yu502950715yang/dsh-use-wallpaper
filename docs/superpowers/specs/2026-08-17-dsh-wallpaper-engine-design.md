# DSH Wallpaper Engine 壁纸背景插件 — 设计文档

- 日期：2026-08-17
- 状态：待审阅
- 项目根：`E:\code\dsh-use-wallpaper`

## 1. 概述

为 DSH Web GUI（`http://127.0.0.1:3080`，运行于 profile `web`）开发一套 Cordis 插件，使 GUI 背景可以使用本机 Wallpaper Engine 壁纸库中的壁纸。核心能力：

- **完全还原**的壁纸渲染：视频壁纸直接播放、scene 壁纸通过 Three.js 在浏览器实时渲染（粒子/着色器场景）；
- 所有壁纸类型多级回退，保证任何壁纸都有可用背景；
- 内嵌于 DSH 设置体系的壁纸选择与外观调节 UI。

## 2. 目标与边界

### 2.1 目标

1. 壁纸选择：从本地 Wallpaper Engine 创意工坊目录（`D:\Steam\steamapps\workshop\content\431960`）扫描壁纸，GUI 中可浏览缩略图并切换。
2. 动态还原：`video` 类型直接播放；`scene` 类型由 Three.js 实时渲染（优先粒子类场景）；`web` 类型通过本地服务嵌入。
3. 外观控制：透明度、背景模糊、Ken Burns 开关。
4. 零外部服务：全部由 DSH 自带 webserver 提供，不另起端口、无跨域。

### 2.2 非目标（YAGNI）

- 不做 scene 壁纸内音频播放（一期）；
- 不做鼠标/键盘交互回传（壁纸视角固定，画面实时渲染）；
- 不做 TEX→PNG 图片导出工具（WebGL 直接加载压缩纹理，见 §5.3）；
- 不做 Wallpaper Engine 实时桌面捕获推流（WorkerW 捕获 + WebRTC 推流，工作量与维护成本远超收益，列为远期备选，见 §10.4）。

## 3. 调研结论（事实基础）

以下结论均经实测验证，构成本设计的硬约束：

| # | 事实 | 验证方式 |
|---|---|---|
| 1 | 壁纸库共 26 个：`scene`×24、`video`×1、`web`×1 | 读取全部 `project.json` |
| 2 | `scene.pkg` 是专有打包格式（魔数 `PKGV0001`）：头部 16B（含条目数）+ 条目表 `nameLen(u32)+name+off(u32)+size(u32)` + 连续数据段，off 相对数据段起点 | 自写 Node 解析器验证：解出的 `scene.json` 为合法 JSON，条目连续无重叠 |
| 3 | 全部 24 个 `scene.pkg` 内部均为 `json + tex纹理 + shader(vert/frag) + 音频(mp3/flac) + 个别字体/模型`，**零视频素材** | 全库批量扫描 |
| 4 | `scene.json` 结构为 2D 场景：`camera`（center/eye/up）+ `general`（bloom/clearcolor/parallax 等）+ `objects`（image / particle / model 引用） | 解包 EVA 壁纸（1280029027）实测 |
| 5 | 粒子定义为标准粒子系统结构：`emitter` + `initializer`（生命周期/大小/速度/颜色随机）+ operator + 材质 | 解包 `particles/presets/lightshafts.json` 实测 |
| 6 | 部分壁纸（14 个）含自定义 GLSL shader（vert/frag），为 Wallpaper Engine 变体 | 全库扫描 |
| 7 | Wallpaper Engine 壁纸画面直接渲染在桌面合成层（WorkerW 窗口），**无独立可捕获窗口**；`wallpaper64` 仅有托盘/事件辅助窗口 | Win32 窗口枚举实测 |
| 8 | DSH 插件体系为 Cordis：host 侧 `apply(ctx)` 可注入 `webServer`（`register()` 挂路由、`tapIndex()` 注入 HTML）与 `settings`（持久化设置）；client 侧 `window.__ModuleLoader__.load({id, factory})` 注册浏览器模块，可注入 CSS/JS/React 组件 | 阅读 `dsh-client-ui-theme` / `dsh-host-webserver` 源码 |
| 9 | profile `web` 的插件安装入口：`package.json` 依赖 + `dsh.profile.bundles` 列表 + `cordis.patch.yml` 配置 | 阅读 `C:\Users\0009\.dsh\profiles\web` |
| 10 | 官方提供"导出壁纸为 GIF/视频"功能 | [官方文档](https://help.wallpaperengine.io/zh/functionality/export.html) |

## 4. 架构设计

### 4.1 总体结构

```
DSH Web GUI (127.0.0.1:3080, profile: web)
│
├─ host-plugin（Node 侧，cordis 插件）
│   ├─ WallpaperScanner    扫描 431960 目录 → 壁纸清单（project.json 字段）
│   ├─ PkgReader           解包 scene.pkg（PKGV0001）→ 内存文件表/字节流
│   ├─ SceneAssets         按需提取 scene 资源：scene.json、粒子 json、tex 块、shader
│   ├─ HttpRoutes          挂载 webServer 路由（见 §5.1）
│   └─ SettingsService     注册 dsh-settings 命名空间（见 §7）
│
└─ client-plugin（浏览器侧，__ModuleLoader__ 模块）
    ├─ BackgroundLayer     背景渲染容器（多级回退，见 §5.4）
    ├─ SceneRenderer       Three.js 渲染器（canvas + 粒子模拟）
    ├─ WallpaperPicker     壁纸选择 UI（缩略图列表）
    └─ SettingsUI          外观设置条目（嵌入设置面板）
```

### 4.2 渲染回退链

每个壁纸按以下优先级尝试渲染，逐级回退，**保证任何壁纸都有背景**：

```
scene 壁纸 → ① Three.js 实时渲染（SceneRenderer）
             ② 渲染失败（如复杂 shader 未适配）→ preview GIF/静态图 + Ken Burns
video 壁纸 → ① <video> 循环播放（静音、cover、object-fit）
web 壁纸   → ① 本地 HTTP 服务 + <iframe>（沙箱化，object-fit 缩放）
            ② 失败 → preview 静态图
其余情况   → preview 图 + Ken Burns 缓动（默认开启）
```

### 4.3 数据流

1. **列表**：client 首次挂载 → `GET /wallpapers/list` → host 扫描目录（缓存 30s）→ 返回 `[{id, title, type, previewUrl, hasScene, tags}]`。
2. **选中**：用户点缩略图 → client 设置 `selectedWallpaper` → 触发背景层渲染。
3. **scene 渲染**：client `GET /wallpapers/scene/:id/asset?name=scene.json` 逐个拉取资源 → PkgReader 按需解包 → SceneRenderer 构建 Three.js 场景。
4. **持久化**：设置变更写 `dsh-settings` 命名空间，下次启动自动恢复。

## 5. 模块设计

### 5.1 HTTP 路由（host）

全部挂载在 DSH webserver（同源，无 CORS 问题）：

| 路由 | 方法 | 说明 |
|---|---|---|
| `/wallpapers/list` | GET | 壁纸清单（含预览图 URL、类型、scene 资源索引） |
| `/wallpapers/media/:id/preview` | GET | 预览图（jpg/gif，`Content-Type` 按扩展名） |
| `/wallpapers/media/:id/file` | GET | video 壁纸的原始媒体文件（Range 支持，流式） |
| `/wallpapers/media/:id/web/*` | GET | web 壁纸的静态文件（目录映射，防路径穿越） |
| `/wallpapers/scene/:id/asset` | GET | scene 资源提取：`?name=scene.json` / `?name=particles/xxx.json` / `?name=*.tex`（返回原始块 + 内容类型） |

### 5.2 PkgReader（host，Node）

- 将 `research/parse-pkg.mjs` 验证过的格式实现为正式模块（TypeScript）。
- 接口：`listEntries(pkgPath): {name, offset, size}[]`；`readEntry(pkgPath, name): Buffer`。
- 缓存：按 `(路径, mtime)` 缓存文件表；条目字节流按需读，不做全量解包。
- 安全：条目名做路径规范化校验（防 `..`），仅允许包内读取。

### 5.3 TEX 纹理

- `.tex` 为 Wallpaper Engine 纹理容器：头部元信息 + 内部 DDS 块（BC1/BC2/BC3/BC5 等压缩格式，含 mipmap）。
- **策略：不做解码导出**，host 端按 `?name=*.tex` 返回原始字节，client 端用 `THREE.CompressedTextureLoader` + 自定义 `.tex` 解析（剥出 DDS 头与块数据）直接上传 GPU。
- 理由：WebGL 原生支持 BC 压缩纹理，零 CPU 解码、零内存放大，且完全保留原壁纸画质。
- 兜底：若个别 tex 为未压缩格式（RGBA），走常规纹理路径。

### 5.4 SceneRenderer（client，Three.js）

**一期能力（POC 到通用粒子场景）：**

- `scene.json` → Three.js 场景图：
  - `camera`（center/eye/up）→ `OrthographicCamera`（`general.orthogonalprojection` 给出宽高）；
  - `image` 对象 → `THREE.Mesh` + 平面几何 + 纹理（tex 或 png）；
  - `particle` 对象 → `THREE.Points` + 自定义粒子模拟（见下）；
  - `general`（bloom/clearcolor）→ 场景背景色 + 后期（一期仅 clearcolor，bloom 列为二期）。
- **粒子系统模拟器**：实现 `emitter`（方向/距离/速率）+ `initializer`（生命周期/大小/速度/颜色随机）+ 常见 operator（重力、阻尼、噪声）语义，逐帧更新 `Points` 位置/大小/透明度，渲染用 `ShaderMaterial`（点精灵、加法混合）。
- **着色器壁纸**：含 vert/frag 的壁纸一期标记为"未适配"，走回退链；二期逐个适配（见 §10.3）。
- 交互：一期无输入交互（视角固定）；性能不足时自动降级为静态图（§8）。

### 5.5 BackgroundLayer（client）

- 全屏固定定位层（`position: fixed; inset: 0; z-index: 最低`），内容按回退链注入：
  - `video`：`<video autoplay loop muted playsinline>` + `object-fit: cover`；
  - `web`：`<iframe sandbox>` 包裹在 `object-fit` 容器内（缩放策略见 §10.5）；
  - `image/gif`：`<img>` + 可选 Ken Burns CSS 动画（`transform: scale/translate` 缓动循环）；
  - scene：`<canvas>`（Three.js WebGL 渲染器）。
- 统一叠一层半透明遮罩（`--wallpaper-overlay-opacity`）保证聊天内容可读性；背景模糊（`backdrop-filter: blur()`）作为可选项。

### 5.6 WallpaperPicker 与 SettingsUI（client）

- 壁纸选择面板：缩略图网格（懒加载）、类型角标（视频/场景/Web/GIF）、当前选中高亮、刷新按钮。
- 设置项（嵌入 DSH 设置面板，参照 `dsh-client-ui-theme` 的 AppearanceRow 模式）：
  - 当前壁纸（picker 入口）；
  - 透明度滑块；
  - 背景模糊开关/强度；
  - Ken Burns 开关；
  - scene 渲染失败回退提示。

## 6. 目录结构（目标）

```
E:\code\dsh-use-wallpaper\
├─ docs/superpowers/specs/         设计文档
├─ packages/
│   └─ dsh-wallpaper-engine/
│       ├─ package.json            名称/依赖（cordis 插件元信息 + dsh.profile.bundles 声明）
│       ├─ cordis.patch.yml        插件配置（或并入 profile 层）
│       ├─ src/host/               PkgReader、Scanner、HttpRoutes、SettingsService
│       ├─ src/client/             BackgroundLayer、SceneRenderer、Picker、SettingsUI
│       ├─ src/shared/             类型定义（WallpaperInfo 等）
│       └─ tests/                  单元测试（vitest）
└─ research/                       调研产物（解析器原型、截图、扫描脚本）
```

## 7. 设置与集成

- 设置命名空间：`wallpaper-engine`（经 `dsh-settings` 注册，schema 用 `@deepseek-ai/schemastery`）。
- 字段：`selectedWallpaperId: string`、`overlayOpacity: number`（默认 0.35）、`blurEnabled: boolean`（默认 false）、`blurRadius: number`、`kenBurns: boolean`（默认 true）。
- profile 集成：将插件包加入 `C:\Users\0009\.dsh\profiles\web\package.json` 的 dependencies 与 `dsh.profile.bundles`；本地开发用 `dsh plugin --profile web <pnpm args>` 或 workspace 链接。
- 配置补丁：`cordis.patch.yml` 中注册插件实例（若 bundle 默认未启用）。

## 8. 测试策略

- **单元测试（TDD）**：
  - PkgReader：给定构造的 PKGV 二进制（含手工造包 fixture）断言条目表/字节流/越界防护；
  - 粒子模拟器：确定性输入下的粒子数量、生命周期、位置更新；
  - 路由：wallpapers API 的响应、Range 支持、路径穿越拦截；
  - 设置：schema 校验与默认值。
- **集成验证（手动）**：
  - 每个壁纸在 GUI 中切换，确认回退链正确（scene 渲染 / 视频 / GIF / 静态）；
  - 刷新页面后设置恢复；
  - 浏览器性能面板：粒子场景 FPS ≥ 30（1080p 缩放渲染，见 §10.2）。
- **验证工具**：`research/scan-all-pkgs.mjs` 保留为壁纸库回归扫描脚本。

## 9. 实施阶段划分

> 阶段间有明确的可验证里程碑；每个阶段独立可交付。

### 阶段 0：项目脚手架
- git 仓库整理（.gitignore、README）、`packages/dsh-wallpaper-engine` 包初始化（TypeScript、vitest、ESM）。
- host 插件最小骨架：注册 `webServer` 路由 `/wallpapers/list` 返回空列表，`settings` 命名空间注册。
- 在 profile `web` 中链接并启用插件，GUI 可加载（验证插件链路通）。
- **里程碑**：GUI 启动无报错，设置面板出现"壁纸引擎"条目。

### 阶段 1：基础背景层（覆盖全部壁纸，除 scene 实时渲染）
- PkgReader 正式化 + 单元测试；Scanner 扫描目录返回清单。
- BackgroundLayer：video / gif / 静态图 + Ken Burns 全链路。
- WallpaperPicker：缩略图网格 + 切换 + 刷新；设置持久化（选中壁纸/透明度/模糊/Ken Burns）。
- **里程碑**：26 个壁纸中 25 个可正确显示（24 scene 走 preview，1 video 播放，1 web 待阶段 4）。

### 阶段 2：Three.js scene 渲染 POC（EVA 壁纸 1280029027）
- SceneRenderer 骨架 + `scene.json` 解析（camera/general/objects）。
- 粒子模拟器 v1（emitter + initializer + 基础 operator）。
- tex 原始块加载 → `CompressedTextureLoader` 自定义解析。
- **里程碑**：EVA 壁纸在 GUI 中实时渲染出动态粒子背景（灰烬/光柱/雾可见）。

### 阶段 3：scene 渲染泛化
- 覆盖其余 23 个 scene 壁纸：按内部结构分类（粒子类优先），逐个适配；
- 未适配壁纸自动回退；shader 类壁纸单独跟踪（§10.3）。
- **里程碑**：≥12 个 scene 壁纸实时渲染；其余优雅回退。

### 阶段 4：web 壁纸 + 打磨
- web 壁纸静态服务 + iframe 嵌入（防穿越、沙箱）。
- 性能优化（粒子合并、渲染降级、隐藏时暂停）、bloom 后期（可选）。
- **里程碑**：全库 26 个壁纸均有合理背景，性能达标。

### 阶段 5（可选远期）：音频、交互
- scene 内 mp3/flac 背景音乐开关；鼠标视差（parallax）等。

## 10. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 粒子系统语义不完整（operator 种类多） | 部分壁纸粒子表现与原生有差异 | POC 先覆盖 EVA 常用子集；差异壁纸回退；逐个补齐 operator |
| shader 壁纸（14 个含 vert/frag）难以通用适配 | 这些壁纸无法实时渲染 | 二期按壁纸逐个翻译到 ShaderMaterial；一期回退 preview |
| 粒子数量大导致低端 GPU 掉帧 | 卡顿 | 动态降级：FPS 监测 <30 时减少粒子/降分辨率/回退静态图 |
| 壁纸库增删（订阅新壁纸） | 列表过期 | 列表缓存 30s + 手动刷新按钮 |
| tex 格式变体（个别非 BC 压缩） | 纹理加载失败 | 解析器覆盖常见 DDS 变体；失败回退 preview |
| web 壁纸依赖 Wallpaper Engine API 无法运行 | 画面空白 | iframe 沙箱 + 失败检测回退 preview；记录已知不兼容壁纸 |
| WorkerW 实时捕获（远期备选） | 复杂度高 | 明确不做，除非用户显式要求（见 §2.2） |

## 11. 验收标准（整体）

1. `dsh plugin` 装好后 GUI 无需额外服务即可选择并显示任意壁纸；
2. EVA 壁纸以 Three.js 实时渲染（粒子动态）作为核心演示；
3. 设置持久化、刷新恢复；
4. 全库壁纸均有合理背景（实时渲染或优雅回退）；
5. 1080p 下粒子场景 FPS ≥ 30。

## 12. 附：已验证的关键技术证据（可复现）

| 证据 | 位置 | 复现方式 |
|---|---|---|
| PKGV0001 解包（EVA 壁纸条目表 + scene.json 合法 JSON） | `research/parse-pkg.mjs` | `node research/parse-pkg.mjs` |
| 全库 scene.pkg 内部类型统计（24 个均无视频素材） | `research/scan-all-pkgs.mjs` | `node research/scan-all-pkgs.mjs` |
| EVA `scene.json` / `particles/presets/lightshafts.json` / `models/*.json` 内容摘录 | 见 §3 表格与 `research/` 解包输出 | `node research/parse-pkg.mjs`（扩展） |
| WorkerW 窗口枚举 + PrintWindow 捕获（桌面层渲染、无独立壁纸窗口） | `research/workerw_*.png`、枚举脚本 | PowerShell Win32 枚举（会话内已验证） |
| DSH 插件机制源码模式（theme 插件 apply/client 注册、webserver register/tapIndex） | `@deepseek-ai/dsh-client-ui-theme/lib/`、`dsh-host-webserver/lib/types/index.d.ts` | 直接阅读安装目录源码 |
| Wallpaper Engine 官方导出视频功能 | [官方文档](https://help.wallpaperengine.io/zh/functionality/export.html) | 打开文档 |
