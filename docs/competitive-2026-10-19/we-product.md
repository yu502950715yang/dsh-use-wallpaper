# Wallpaper Engine 官方能力 + 成熟壁纸产品功能基线

- 调研人：we-product-scout（Team Lead 的调研 teammate，任务 task-3）
- 日期：2026-10-19
- 用途：作为 `@dsh-use/wallpaper-engine` 后续路线图的「产品级功能基线」直接输入
- 口径：先说竞品「有」什么，再说本项目「没有什么」，最后给分层 checklist（必做/P1/P2/可选）与成本/依赖/风险
- 约束：仓库源码只读；不跑构建/测试/git；网络抓取量已控制

> **核实状态约定**：`已核实` = 本次用 web_fetch 抓到原文；`仅标题级` = 只抓到官方帮助站的文章标题/导航，正文未抓到；`未核实` = 抓取失败或只有二手描述；`任务输入` = 来自任务描述、未独立验证。
> **抓取失败记录**：① Steam 商店页 `store.steampowered.com/app/431960/` 两次 `web_fetch` 均返回 `TypeError: fetch failed`，故商店页文案一律不引用、不猜测；② 帮助站部分正文页（如 `/en/videos/notplaying.html`）返回的是索引页回落内容，正文未抓到；③ `jagrat7/linux-wallpaper-engine` 的 raw README 在 `main` 分支返回 404（默认分支名未知），只拿到 GitHub 描述级信息。

---

## 1. Wallpaper Engine 官方能力基线

来源：官方产品页 <https://www.wallpaperengine.io/en>（已核实，本次抓取到完整功能文案 + FAQ）、官方帮助站 <https://help.wallpaperengine.io/>（已核实导航结构；部分正文页抓取回落）、Steam 商店页 <https://store.steampowered.com/app/431960/Wallpaper_Engine/>（**抓取失败，未核实**）。

| # | 官方能力 | 官方事实（原文要点 / 状态） | 对本项目的含义 |
|---|---|---|---|
| 1 | 壁纸类型：scene / video / web / 图片 | 官方原文「Animate your own images or import videos and websites to create new wallpapers」；scene 由内置编辑器制作（已核实） | 本项目已覆盖 scene/video/web/图片四类渲染路径 |
| 2 | 场景编辑器 | 编辑器把静态图变成动画场景；内置素材/效果库、社区素材、粒子系统编辑器、SceneScript（已核实） | 本项目是**播放器**而非编辑器，不应复刻编辑器 |
| 3 | 用户定制 user properties | 「Give users the ability to further customize your creations by making individual parts of your wallpapers configurable with a few clicks」（已核实） | 本项目只「读」用户属性（localStorage），**无切换 UI**（见 §3） |
| 4 | 播放列表 / 轮播 / 幻灯 | 「Create playlists that change your wallpaper at set intervals or times of day, when you sign in, or when you launch a specific app.」（已核实） | 本项目 **0 轮播**（见 §4） |
| 5 | 多显示器 / 超宽屏 | 「supports a wide range of resolutions and aspect ratios, including ultrawide displays, and handles complex multi-monitor setups with ease」（已核实）；帮助站另有「不同分辨率显示器居中」「刷新率异常」等条目（仅标题级） | 本项目是浏览器内单页背景层，**没有多显示器概念**；产品上需重新定义（见 §4 风险） |
| 6 | 性能设置 / 自动暂停 | 「pauses your wallpaper automatically while you play games or use maximized apps」；FAQ：「detects running games and maximized apps... Stopping wallpapers while a game runs unloads them from memory entirely」；笔记本切电池自动暂停；性能设置页可调（已核实） | 本项目只有「页面切后台暂停 + 手动暂停 + 画质倍率」，**无游戏/全屏应用检测、无 FPS 上限、无内存卸载**（浏览器侧不可比） |
| 7 | 应用规则（按应用切换） | 「Adjust performance settings and create rules for specific apps.」（已核实）；帮助站有「Select wallpapers per application」「Fix issues with specific apps or games」条目（仅标题级） | 浏览器页面拿不到前台应用：**能力不可移植**，只能做「页面内可见性/全屏 API」替代 |
| 8 | 屏幕保护 | FAQ：「You can set any wallpaper as your Windows screensaver」（已核实）；帮助站「Screensavers with Wallpaper Engine」（仅标题级） | 插件宿主是浏览器，**不做** |
| 9 | Android 伴侣 | 免费 Android App：无线把壁纸传到手机/平板、可定制、可建播放列表、可调功耗（已核实） | **不做**（无移动端宿主） |
| 10 | Steam 创意工坊 | 壁纸免费、以「订阅」形式从 Workshop 下载；Steam 只用于下载/上传/更新，核心功能无需 Steam 在后台（已核实） | 本项目只读本机 workshop 目录，**无浏览/订阅/下载/上传**（且不应做上传） |
| 11 | 音频：壁纸音效 + 音频可视化 | 帮助站音频分类含「Audio visualizers do not work / no sound detected」「Limiting audio visualizers to music players」等（仅标题级）；官方页未逐条展开收音/频谱的细节 | 本项目有壁纸音效与「随声音变化的效果」（README），**无频谱柱状可视化**；系统音频捕获未实现 |
| 12 | 专辑封面 / 媒体数据（Now Playing 类） | 帮助站正文已核实：壁纸可读取封面、歌名、专辑名；需 Windows 10+、设置里开「Media integration support」、播放器向 Windows 媒体浮层提供数据；有 Media blocklist 排除浏览器等干扰应用 | 本项目 **无 Now Playing / 媒体信息层**（可参考 Media Session API，见 §5 P1） |
| 13 | LED 硬件联动 | 支持 Corsair iCUE、Razer Chroma，灯光随壁纸（已核实） | **不做**（浏览器无此通道） |
| 14 | RGB/锁屏/导出/编辑已下载壁纸/命令行控制/开机自启 | 帮助站导航分别有对应文章（仅标题级）：`/en/functionality/*`、`/en/steam/*`、`/en/general/lockscreen.html` | 导出 GIF/视频、CLI 等属于桌面端 OS 集成，插件范围外 |
| 15 | 视频编码支持（HEVC/H.264 等） | **未核实**：Steam 商店页两次抓取失败；帮助站 `/en/videos/notplaying.html` 正文抓取回落成索引页。可确认的是帮助站存在「Videos Black / Not Playing Properly」「Video wallpapers look wrong」「Video freezes / stuttering」分类（仅标题级） | 本项目 README 实测：视频交给浏览器 `<video>` 解码，**HEVC 在 Edge 黑屏、Chrome 正常**，无检测/兜底（见 §4） |
| 16 | 安全模式 / 鼠标交互 / FPS 上限 / 移动配对细节 | **未核实**（商店页抓不到；官方产品页只说「interactive effects」「performance settings」，未给具体项） | 不写进基线表，只在 checklist 里以「竞品/官方存在但本项目按浏览器能力重新定义」处理 |

**官方能力中可迁移到「浏览器内 Web GUI 插件」的**：壁纸类型覆盖、播放列表/轮播/时段切换、用户定制项、音频可视化/媒体信息、性能与画质档位、暂停规则（页面可见性替代）、收藏/搜索（官方 App 内也有库浏览，见帮助站界面分类「仅标题级」）。
**不可迁移或价值低的**：多显示器每屏独立（浏览器单页）、按前台应用规则、屏保、移动伴侣、LED、工坊上传、场景编辑器。

---

## 2. 成熟替代产品功能基线（README/release 级）

| 产品 | 平台 / 形态 | 许可证 / Stars（来源与状态） | 关键产品能力（README 原文提炼） |
|---|---|---|---|
| **Lively Wallpaper**（`rocksdanister/lively`，GitHub 现跳转 `lively-community/lively`） | Windows 10/11，C# + WinUI 3 / WPF | GitHub API：**19,855★**、1,390 forks、`license: GPL-3.0`、默认分支 `core-separation`（已核实）。⚠️ README 正文仍写「Microsoft Public License (Ms-PL)」，与 API 的 GPL-3.0 **冲突**，未进一步核实 | 视频（mp4/mkv/webm/avi/mov，硬件加速、可外挂 LAV 等解码包）、GIF、网页/HTML（WebGL/JS）、GLSL shader、Shadertoy、Unity/Godot 游戏、部分外部应用；**音频响应壁纸**；网页壁纸实时定制；拖拽导入；Lively-zip 分享/内置 creator；**多显示器：跨屏一张 / 全部复制 / 每屏不同**；全屏应用/游戏时**完全暂停（~0% CPU/GPU）**；可选「仅桌面显示时播放」；**应用规则**（如开 Photoshop 就暂停）；按显示器分别暂停；库浏览与预览；多语言翻译项目；全开源无付费墙 |
| **skwd-wall**（`liixini/skwd-wall`） | Linux（Wayland：Hyprland/Sway/Niri/KDE Plasma 等；不支持 GNOME），Quickshell/Qt6 | MIT（README 已核实）；**1083★（任务输入，未独立核实）**；README 顶部声明 V2 正在用 Rust 重写、V1 为当前代码 | 图片/视频/WE scene 统一管理；**按色相饱和度分 13 组**；Matugen 取色主题 + 主题脚本钩子 + 后处理命令占位符；**标签系统 + Ollama 自动打标**；启动恢复上次壁纸；过滤（类型/颜色/最近/标签/收藏）；**Wallhaven.cc 与 Steam Workshop 内置浏览**（steamcmd/Steam 客户端，可选）；三种展示样式（平行四边形/网格/六边形）；图片优化（转 webp、按最大分辨率下采样、保留原件）；视频转 HEVC（WIP）；**快捷键**；**随机壁纸（可每 X 秒随机）**；**不同显示器不同壁纸** |
| **Loomscreen / macos-wallpaperengine**（`Paradox07127/macos-wallpaperengine`） | macOS 14.6+，Swift/Metal；Lite + Pro 双版本 | MIT（README 已核实）；Pro 需 Apple Silicon | 「概览」按真实桌面排列查看每块屏；**每屏独立控制**（也可跨屏），拖拽/按名应用；**播放列表与调度（随机、轮播间隔、时段槽位）** + 书签库一键换；**菜单栏全局开关/每屏播放暂停/上一张下一张 + 实时 CPU/GPU/RAM/温度条**；覆盖层画布（11 种 widget、时钟、音乐）；12 种粒子效果与天气联动；切换动画；**音乐层 Spotify/Apple Music + 封面 + 可选同步歌词**；Pro 支持**系统音频驱动的视觉效果**；macOS 26+ 可把视频发布为系统壁纸；电源感知（全屏/遮挡/电池/低电量）；**8 个可绑定全局快捷键**；书签/喜欢/方案（scheme）与配置备份；**5 种界面语言**；自适应帧率、每屏渲染线程；本地 WE scene 渲染与 Workshop 浏览/下载（Pro） |
| **jagrat7/linux-wallpaper-engine** | Linux；WE 壁纸管理 GUI | 许可证未核实（raw README 404）；GitHub 描述：「browse, preview, scan for compatibility, and apply wallpapers」（**仅描述级，未核实**） | 浏览、预览、兼容性扫描、应用 WE 壁纸（管理器/前端定位） |
| **Almamu/linux-wallpaperengine** | Linux，开源 WE scene 渲染后端 | **未核实**（本次未直接抓取；由 skwd-wall README 引用为依赖） | 被 skwd-wall 等前端复用做 WE scene 渲染；本项目 README 也把格式语义对齐到该实现 |

### 2.1 共同功能（跨产品提炼，作为「产品级基线」）

| 基线功能 | Lively | skwd-wall | Loomscreen | WE 官方 | 本项目现状 |
|---|---|---|---|---|---|
| 库浏览 / 缩略图网格 / 预览 | ✅ | ✅（3 种展示） | ✅ 壁纸架 + 统一库 | ✅ | ✅ 网格（仅 title + preview 图） |
| 轮播 / 播放列表 / 定时/随机切换 | 部分（库+规则，README 未强调播放列表） | ✅ 随机 + 每 X 秒随机 | ✅ 播放列表 + 时段槽位 | ✅ 间隔/时段/登录/启动应用 | ❌ |
| 收藏 / 隐藏 / 搜索 / 标签 / 排序 | 库浏览 | ✅ 标签/过滤/收藏/颜色分组 | ✅ 书签/喜欢/过滤 | 界面有搜索/排除（仅标题级） | ❌ |
| 每屏不同 / 跨屏 | ✅ | ✅ | ✅ | ✅ | ❌（架构不适用，需重定义） |
| 暂停规则（全屏应用/游戏/电池/遮挡） | ✅ | — | ✅ | ✅ | 部分（页面隐藏暂停 + 手动暂停） |
| 音频响应 / 音频可视化 | ✅ | —（未提） | ✅（Pro 系统音频） | ✅（visualizer 文章） | 部分（音效 + 声音驱动效果；无频谱 UI） |
| 性能/画质档位、掉帧自适应 | 有性能选项 | 强调低占用 | ✅ 自适应帧率 | ✅ 性能设置页 | 部分（qualityScale 0.5–1，无 FPS/自适应） |
| 资源占用显示 | — | 强调 RAM 占用 | ✅ CPU/GPU/RAM/温度条 | 任务管理器外无内置 HUD（未核实） | ❌（有装配/首帧健康数据，非资源监控） |
| 快捷键 / CLI | — | ✅ keybinds | ✅ 8 个全局快捷键 | ✅ CLI（仅标题级） | ❌ |
| 多语言 i18n | ✅ 翻译项目 | — | ✅ 5 语言 | ✅ 30+ 语言 | ❌（全中文硬编码） |
| 本地文件导入（上传/拖拽） | ✅ 拖拽 | 按目录扫描 | ✅ 导入本地工程/文件 | ✅ 导入 | ❌（只读 workshop，无上传） |
| 适配/裁剪（cover/contain/拉伸、位置） | 有适配选项 | 图片优化 | 每屏/跨屏排布 | 有（未逐条核实） | 部分（预览图 Ken Burns；无 cover/contain 面板） |
| 用户定制项 UI | 网页壁纸定制 | 大量设置项 | 场景自定义设置（Pro） | ✅ user properties | ❌（只读存储，无 UI） |

---

## 3. 本项目现状盘点（只读代码/文档，逐条给证据）

证据文件：`README.md`（能力/配置/自认缺口）、`AGENT.md §7`（遗留边界）、`src/host/routes.ts`、`src/client/settings.ts`、`src/client/settings-section.tsx`、`src/client/index.ts`（均为本次实际读取）。

### 3.1 已具备（产品可用）

| 能力 | 现状 | 证据 |
|---|---|---|
| scene 实时渲染 | 唯一 scene 路径：three.js 播放器（背景 Mesh + 粒子 billboard），失败/零可见对象回退 preview 图 + Ken Burns | README「能做什么」；`src/client/index.ts:158-166` |
| video / web / image 壁纸 | `<video>` 循环、沙箱 iframe、图片 + 缓慢缩放 | README；`index.ts:223-259` `show()` |
| 纹理/效果/文本 | DXT/RGBA/R8/RG88、sprite 帧、效果链（水波/云/模糊/泛光等）、时间日期文本 | README；AGENT §7 边界 |
| 省电与画质 | `paused`、`pauseOnHidden`（visibilitychange）、`qualityScale` 0.5–1、应用级 Glow（scene） | `settings.ts:14-25`；`index.ts:87-100`；面板「性能与省电」`settings-section.tsx:309-350` |
| 壁纸音效 | `soundEnabled`，关掉即时停声并释放 AudioContext | README 配置表；`index.ts:96` |
| 自动探测 | 注册表 + libraryfolders.vdf + 常见路径，多 Steam 库 | README「环境要求」；`routes.ts` `/wallpapers/probe`（L356） |
| 设置持久化 | DSH `remote.settings` 读写 + 双版本命名空间候选（`dsh-wallpaper-engine` / `wallpaper-engine`） | `settings.ts:12-99` |
| 面板控件 | 当前壁纸/刷新/取消、壁纸库网格、显示效果（Glow 开关 + 阈值/强度滑杆）、性能与省电、文字可读性、目录 + 探测、实时渲染健康（重试/清记忆） | `settings-section.tsx` 各 section |
| 公开 API | `window.__wallpaperEngine = { mount, teardown, select, health, retryLive, clearRenderFailures, show }` | `index.ts:207-260` |
| 渲染看护 | 失败记忆（localStorage）、软失败冷却自动重试、面板状态行 | AGENT §7.38；`index.ts:36-78` |
| 用户属性读取 | `getUserPropertyValue` 从 localStorage `we:userprop:<key>` 读取；注释明确「插件设置不含壁纸级用户属性存储，未来 picker/设置面板可按同一键写入」 | `settings.ts:101-119` |

### 3.2 产品级缺口（按「竞品普遍有、本项目没有」排序）

| # | 缺口 | 本项目现状（证据） | 竞品谁有 |
|---|---|---|---|
| G1 | **无播放列表 / 轮播 / 定时切换** | `settings.ts` 只有单个 `selectedWallpaperId`；无定时器/调度器；无随机/上一张/下一张 | WE 官方、Loomscreen、skwd-wall（随机） |
| G2 | **壁纸库无管理能力**（收藏/隐藏/搜索/排序/最近使用/标签） | 列表接口仅 `/wallpapers/list`（`routes.ts:140`），面板只渲染 title + previewUrl 网格，无过滤/排序/收藏 | skwd-wall（标签/收藏/颜色组/过滤）、Loomscreen（书签/喜欢/过滤）、WE（搜索/排除） |
| G3 | **显示效果字段有、面板没有** | README 自认：「`overlayOpacity` / `blurEnabled` / `blurRadius` / `kenBurns` 目前只有设置字段，设置面板里没有对应控件」（README L176）；面板「显示效果」只有 Glow | Lively / Loomscreen 均有显示适配设置 |
| G4 | **无适配模式/裁剪** | 无 cover/contain/stretch 面板；图片仅 preview + Ken Burns；video 用 `<video>` 默认铺满 + 壁纸自身 CSS（AGENT §7.35 记录某壁纸写死 `object-fit:cover` 裁边） | Lively、WE（分辨率/宽高比适配） |
| G5 | **视频编码无兜底**（HEVC 黑屏） | README 自认：HEVC/H.265 缺系统解码扩展时「停在黑背景（不报错、也不退回封面图）」；代码无 `canPlayType`/error 监听/首帧超时回退 | 桌面端交给 DirectShow/LAV；本项目只能靠浏览器 |
| G6 | **用户属性（user properties）无面板** | `getUserPropertyValue` 只读；无写入入口、无 key 枚举、无动态控件 | WE（官方卖点）、Loomscreen（Pro 场景自定义设置） |
| G7 | **无音频频谱可视化** | README：「壁纸音效默认播放…随声音变化的效果也会跟着动；**频谱柱状可视化尚未支持**」 | WE（audio visualizer）、Lively（audio reactive）、Loomscreen（Pro 系统音频） |
| G8 | **无 Now Playing / 媒体信息层** | 无任何媒体信息读取/展示代码 | WE（专辑封面/歌名/专辑名 + Media blocklist） |
| G9 | **无多显示器/每屏独立**（架构性） | 单背景层 `createBackgroundLayer` + `document.body.prepend`；同一浏览器页面跨屏时无法按屏渲染 | WE、Lively、Loomscreen、skwd-wall |
| G10 | **无资源监控/性能 HUD** | 面板有装配耗时/首帧（`render-health`），无 FPS/帧时间/显存估算 | Loomscreen（CPU/GPU/RAM/温度条） |
| G11 | **无快捷键 / CLI / 命令入口** | 只有 `window.__wallpaperEngine` 手动调用（Console/脚本） | WE（CLI）、Loomscreen（8 快捷键）、skwd-wall（keybinds） |
| G12 | **无 i18n** | 面板/README/错误文案全中文硬编码；slot label 固定「Wallpaper 壁纸」 | WE 30+ 语言、Loomscreen 5 语言、Lively 翻译项目 |
| G13 | **无本地文件导入/上传** | 只扫描 workshop 目录；无上传入口、无 `/wallpapers/upload` 路由；`routes.ts` 无写操作 | Lively（拖拽）、Loomscreen（导入本地工程） |
| G14 | **无按应用/时段规则** | 只有 visibilitychange（页面切后台）；无前台应用、无时段、无全屏 API 检测 | WE（应用规则/时段/登录时）、Loomscreen（时段槽位/电源规则） |
| G15 | **web 壁纸失败无回退、resize 重建** | AGENT §7.32：跨源 iframe 拿不到错误 ⇒ 失败停空白而非 preview；resize 靠重建 iframe，dpr 变化不触发、重建后动画从头开始 | Lively 网页壁纸由宿主 Chromium 控制，无此限制 |
| G16 | **失败记忆/看护不跨 origin、不同步**（次要） | AGENT §7.38：localStorage 同 origin 共享，另一 origin 不共享 | 不适用竞品 |
| G17 | **无多平台探测** | 仅 Windows（README「仅 Windows 实测，macOS 未测试」；`steam-paths.ts` Windows 注册表/Steam 库） | Linux 系竞品各自适配 |

> 另有一批**渲染层**遗留（非产品功能缺口，但影响「产品级观感」）：Glow 只覆盖 scene、video/image/web 无 postprocessing（§7.30）；`copybackground` 未实现、`colorBlendMode` 仅 6/7/31（§7.31）；`{animation}` 轨道未实现（§7.16）；text 对象效果链跳过（§7.1）。这些不属于本次产品基线，但路线图排期时应知道它们会持续产生用户观感投诉。

---

## 4. 分层功能 checklist（路线图直接输入）

**成本口径**：S = 相对本仓约 ≤1 人日；M = 2–3 人日；L = ≥5 人日（含验收）。估算不含真机素材验证的不确定性。
**风险口径**：只写这个项目真正会踩的坑（浏览器宿主限制、scene 重装配成本、DSH 设置/HMR 生命周期、版权与安全）。

### 4.1 必做（不做就不算「产品级」）

| 项 | 竞品谁有 | 本项目现状 | 实现成本 / 依赖 | 风险 |
|---|---|---|---|---|
| **B1. 播放列表 / 轮播（顺序 + 随机 + 间隔，切换不闪、暂停同步）** | WE 官方、Loomscreen；skwd 有随机定时 | ❌ 只有单个 `selectedWallpaperId` | **M**。依赖：新增 `playlist`/`rotationIntervalMs`/`rotationMode` 设置字段（`settings.ts` DEFAULTS + `ClientSettings`）；`index.ts` 内加调度器（沿用 teardown 清理模式，避免 HMR 泄漏定时器）；切换走现有 `controller.select`；面板加「轮播」段。 | ① scene 每次切换重建 player，4K 壁纸切换有卡顿/闪黑；需复用 renderer + 过渡（fade）验收；② 自动切换与用户手动选择/软失败自动重试的竞态；③ 轮播在页面隐藏/暂停时应停表（复用 `applyRuntimeSettings`）；④ 播放列表要持久化（DSH settings 写入频率低，别做成每次 tick 都写） |
| **B2. 显示效果面板补齐（overlayOpacity / blur / kenBurns）** | Lively / Loomscreen 均有显示适配 | ❌ 字段有、UI 无（README 自认） | **S**。依赖：`settings-section.tsx` 现有 `wss-slider` 模式；`index.ts` 的 `applySettingsToLayer` 已接好 | 模糊在高分屏/大分辨率下有 GPU 成本，默认保持 false/低半径；改设置要即时生效（已有链路） |
| **B3. 壁纸库管理：搜索 + 收藏 + 隐藏 + 排序（最近使用）** | skwd-wall（标签/收藏/过滤）、Loomscreen（书签/喜欢/过滤）、WE（搜索） | ❌ 纯网格 | **M**。依赖：`/wallpapers/list` 已含 title/preview（`routes.ts:140`；`settings-section.tsx:245-250` 用 `w.previewUrl`/`w.title`）；仅前端过滤 + localStorage 收藏/隐藏集合（注意：**不要**塞进 DSH settings，避免每次收藏都写配置） | ① 列表规模大时网格卡顿 → 需要虚拟滚动或懒加载（现已有 `loading="lazy"`）；② 收藏/隐藏仅本 origin 有效（与 §7.38 同源限制一致）；③ 「隐藏」要能恢复，否则用户找不到入口 |
| **B4. 视频兼容兜底（黑屏检测 → 回退预览图 + 明确提示）** | WE 桌面端用系统解码/LAV；本项是浏览器宿主的必然补丁 | ❌ 黑屏无提示无回退（README） | **S–M**。依赖：`canPlayType` + `<video>` 的 `error`/`loadeddata` 事件 + 首帧超时（如 1.5s 无 `playing`）；回退走 `controller` 的 preview 路径；面板状态行提示「该壁纸编码浏览器不支持，换 Chrome 或转码」 | ① 不引入 host 侧 ffmpeg 转码（L 成本、Windows-only、许可与 CPU 问题），只做检测/提示；② 首帧超时阈值要能区分解码慢与坏文件；③ 不要误伤「慢盘首帧」 |
| **B5. 用户属性（user properties）面板** | WE 官方卖点、Loomscreen（Pro 场景设置） | ❌ 只读 localStorage，无入口 | **M**。依赖：host 侧需新增接口聚合可定制 key（scene.json 的 `visible:{user,value}` 绑定 + 可能的 `project.json` 属性表，**具体 schema 未核实**，需先做 host 解析小样）；面板按类型生成 bool/slider/color/combo；写回 `we:userprop:<key>`（`settings.ts` 已定义键） | ① 属性可能分散在 scene.json 多层/多个对象，聚合规则要防重复 key；② 类型推断可能出错（数值/颜色/字符串）；③ 改属性后需要重装配还是就地生效，取决于现有 `resolveVisibility` 读值时机——可能要接受「切换后生效」 |
| **B6. 适配模式（cover/contain/stretch + 位置/缩放）** | Lively、WE、Loomscreen | 部分（图片仅 Ken Burns；video 依赖自身 CSS） | **M**。依赖：`background-layer.ts` 的 element/iframe 样式；image/video 分支加 `object-fit`/`transform`；web 分支改 iframe 尺寸（注意 AGENT §7.32：web resize 靠重建 iframe） | ① 与 overlayOpacity/blur 叠加后的观感；② web 壁纸重建成全屏尺寸可能重置其内部状态；③ 「位置」对 scene 无意义（scene 自己按 cover 视锥算），面板需按类型禁用 |
| **B7. 公开 API + 快捷键扩展（next/prev/pause/random/current）** | Loomscreen 快捷键、skwd keybinds、WE CLI | 只有 select/show/health 等 | **S**。依赖：`window.__wallpaperEngine` 已有对象；快捷键可挂 `keydown`（可配置开关，避免和 DSH 输入冲突） | ① DSH 页面有输入框/编辑器，快捷键必须默认关闭或限定组合键；② 无全局快捷键（浏览器拿不到系统级热键），只能页面内；③ HMR teardown 要移除监听 |
| **B8. 性能档位产品化（qualityScale 扩到 0.25 + 目标 FPS 上限）** | WE 性能设置、Loomscreen 自适应帧率 | 部分：`qualityScale` 0.5–1，无 FPS 控制 | **S–M**。依赖：`three-renderer` 的渲染循环（需节流 `requestAnimationFrame`）；面板加「目标帧率 30/60/不限制」 | ① 浏览器 rAF 与 DSH 页面动画相互竞争，限帧可能反而抖动；② 视频壁纸不受 rAF 控制（`<video>` 独立解码），限帧只对 scene 有意义 |

> 为什么不把「多显示器/每屏独立」列必做：本项目是**同一个浏览器页面里的背景层**，页面跨屏时 CSS 无法按显示器分区渲染；唯一可行方向是 DSH 支持多窗口/多实例，属于宿主能力，不是插件内能补的。列入 P2「需产品定义」，并明确「不要承诺 WE 式每屏壁纸」。

### 4.2 P1（有它才像完整产品，可在下一版本排）

| 项 | 竞品谁有 | 本项目现状 | 实现成本 / 依赖 | 风险 |
|---|---|---|---|---|
| P1-1 时段/日程切换（按时段、日出日落、登录时） | WE（时段/登录时）、Loomscreen（time-of-day slots） | ❌ | **M**，依赖 B1 的调度器 + 系统时钟/时区（浏览器 `Intl`） | 时区/夏令时；跨天边界；页面长时间不刷新时的定时漂移（用 wall-clock 重算而非 `setInterval` 累加） |
| P1-2 音频频谱可视化（壁纸音效 FFT 柱状 / 可选系统音频） | WE、Lively、Loomscreen（Pro） | 部分：音效播放 + 声音驱动效果已有，README 明确无频谱柱状 | **M**。依赖：`src/client/audio-input.ts` 已有的音频输入链路（需确认它当前覆盖壁纸音效还是系统音频）+ `AnalyserNode`；渲染用 canvas/CSS bar | ① 系统音频在浏览器必须 `getDisplayMedia`（用户手势 + 权限，不能静默捕获），隐私敏感；② 无音效的壁纸没有信号源；③ 与 `soundEnabled=false`、暂停态的联动 |
| P1-3 Now Playing / 媒体信息层（可选浮层） | WE（专辑封面/媒体数据）、Loomscreen（音乐层） | ❌ | **M–L**。依赖：浏览器 Media Session API（只读有限元数据）或 DSH 侧宿主能力（未核实）；展示用 DOM 浮层 | ① 浏览器拿不到系统级媒体信息（WE 靠 Windows 媒体浮层），大概率只能读页面内 `<audio>`/Media Session，价值有限；需先做可行性 spike，别直接排期 |
| P1-4 本地文件导入（图片/视频拖拽或选择） | Lively（拖拽）、Loomscreen（导入） | ❌ 只读 workshop | **M–L**。依赖：host 新增 `/wallpapers/upload`（写本地插件数据目录）+ scanner 合并自建条目 + 列表类型扩展；面板加拖拽区 | ① 写盘安全（路径穿越、大小限制、扩展名白名单）；② DSH 桌面版/Web 版数据目录差异；③ 隐私与版权（用户自担）；④ 视频导入后同样有 G5 编码问题 |
| P1-5 i18n（中文 + 英文，跟随 DSH locale） | WE 30+、Loomscreen 5、Lively 翻译项目 | ❌ 全中文硬编码 | **S–M**。依赖：面板文案集中成字典；README 双语可后置 | ① DSH 设置 slot label 是字符串注册，多语言要能动态；② 文案量大但机械 |
| P1-6 性能 HUD（FPS/帧时间/纹理与 RT 显存估算） | Loomscreen（CPU/GPU/RAM/温度条） | ❌ 只有装配/首帧健康数据 | **S–M**。依赖：`render-health.ts` 扩展采样 + `THREE.WebGLRenderer.info.memory`/自建 RT 尺寸统计 | ① 浏览器无 GPU 占用/温度，只能给渲染侧指标，别宣称「资源监控」；② HUD 本身要能关，避免遮壁纸 |
| P1-7 web 壁纸失败回退 + dpr resize（修 AGENT §7.32） | Lively 宿主 Chromium 无此限制 | 已知缺陷 | **M**。依赖：iframe `load` 事件 + 超时 + 跨源限制下的「白屏探测」不可行 ⇒ 只能做到「超时/导航失败回退」；dpr 变化用 `matchMedia('(resolution)')` 或 resize 阈值触发重建 | ① 跨源拿不到子帧错误，白屏仍可能漏判；② 重建 iframe 从头播放（壁纸侧快照视口），过渡需处理 |
| P1-8 暂停规则增强（页面全屏 API、遮挡、低电量） | WE、Loomscreen、Lively | 只有 visibilitychange + 手动 | **S**。依赖：`document.fullscreenElement`、`navigator.getBattery()`（Chromium 支持）、`IntersectionObserver` | ① `getBattery` 非标准/隐私模式可能拒绝；② 全屏 API 只反映本页全屏，不是「其他应用全屏」；③ 规则过多会让用户困惑，需面板默认值清晰 |

### 4.3 P2（差异化/锦上添花，视用户反馈）

| 项 | 竞品谁有 | 本项目现状 | 实现成本 / 依赖 | 风险 |
|---|---|---|---|---|
| P2-1 收藏/播放列表导入导出（JSON） | skwd（配置）、Loomscreen（方案备份） | ❌ | S–M，依赖 B1/B3 | 格式兼容性；导入数据校验 |
| P2-2 壁纸元数据（作者/标签/文件大小/时长） | skwd（标签 + Ollama）、WE 工坊页 | ❌ 列表基本只有 title/preview | M，host 解析 `project.json` 等（需素材验证字段） | 字段不一定存在；解析失败要静默跳过 |
| P2-3 主题色提取（从当前壁纸取色生成 DSH 皮肤/强调色） | skwd（Matugen）、Loomscreen（主题化） | ❌ | M–L，需要 DSH 皮肤/主题系统配合（未核实 DSH 是否暴露主题变量） | 依赖宿主能力；取色代表性与可读性 |
| P2-4 多窗口/多实例（每窗口不同壁纸） | WE/Lively/Loomscreen/skwd | ❌（单页单层） | **L**，必须 DSH 宿主支持多窗口或多 profile | 插件无法单独完成；需和 DSH 团队确认 |
| P2-5 鼠标交互增强（点击/hover 触发 SceneScript 或视差增强） | WE 交互壁纸、Lively 网页交互 | 部分：视差已有（`pointer-input.ts`） | M，依赖 `scene-script-vm` 的能力边界 | ① 点击会被 DSH UI 抢走/误触；② web 壁纸在沙箱 iframe 里无法跨源转发事件 |
| P2-6 自动性能降级（持续掉帧自动降 qualityScale/关 Glow） | Loomscreen 自适应帧率 | ❌ | M，依赖 P1-6 采样 + 现有 `setQualityScale`/`setGlow` | 自动降档会让用户觉得「变糊」，需提示与可关闭 |
| P2-7 手动安全模式（一键停 scene 全部回预览图） | WE 有「安全模式」（**未核实**具体行为） | 部分：失败自动回退 + 重试 + 清失败记忆 | S，依赖现有 health store | 与 `paused` 语义区分；别做成隐藏功能 |
| P2-8 通知/状态提示（切换失败、编码不支持、显存不足） | Loomscreen 菜单栏状态 | 部分：面板状态行 | S | DSH 无通用 toast 组件（未核实），可能要自绘 |

### 4.4 可选 / 明确不做（写进路线图「排除项」，防反复讨论）

| 项 | 判断 | 理由 |
|---|---|---|
| Steam Workshop 浏览/订阅/下载 | **不做** | 需要 Steam 凭据/steamcmd/API key（skwd 的做法），有 ToS 与凭据安全风险；本项目已有「读本机目录」的正确边界 |
| 上传/分享壁纸到工坊 | **不做** | 版权 + Steam 账号 + 与插件定位无关 |
| 场景编辑器 / 壁纸制作工具 | **不做** | WE 官方编辑器的复刻，超出「DSH 壁纸播放器」范围 |
| 每屏独立壁纸（WE 式） | **不做（除非 DSH 支持多窗口）** | 浏览器单页无法按显示器分区；列入 P2-4 的前提讨论 |
| 屏幕保护 / 锁屏壁纸 / 开机自启 | **不做** | 宿主是浏览器页面，无 OS 集成 |
| Android 伴侣 / 移动端 | **不做** | 无移动宿主 |
| LED（iCUE/Chroma）联动 | **不做** | 浏览器无硬件通道 |
| host 侧视频转码（HEVC→H.264/WebM） | **不做（远期可议）** | 需要 ffmpeg 依赖 + CPU/磁盘 + Windows-only + 许可与体积问题；B4 的检测/提示足够覆盖大多数用户 |
| 在线图源（Wallhaven 等）浏览 | **可选，不在近期** | 网络依赖、内容审查、版权与 CORS；与「本机壁纸」定位冲突 |
| AI 自动打标（Ollama） | **可选，不在近期** | 成本 L、收益偏个人向；本仓没有标签体系可挂 |

---

## 5. 结论：产品级缺口 Top 5 与建议顺序

1. **G1 播放列表/轮播**——竞品与官方都把「会动的壁纸」升级为「会换的壁纸」，这是当前最大的产品级落差；B1 应在下一版本做（依赖最小、复用现有 select/teardown 链路）。
2. **G3+G4 显示效果控件与适配模式**——README 自己承认字段有 UI 无；补齐成本最低（S/M），直接消除「文档与实现不符」的信任问题。
3. **G2 壁纸库管理**——收藏/隐藏/搜索/排序是「壁纸多起来」后的刚需；纯前端可实现，不新增 host 依赖，但必须先定好存储位置（localStorage，勿写 DSH 配置）。
4. **G5 视频编码兜底**——HEVC 黑屏是真实用户投诉点（README 专门写了说明）；检测 + 回退 + 提示成本 S–M，收益立竿见影。
5. **G6 用户属性面板**——WE 生态里大量热门壁纸依赖 user properties；先做 host 侧 key 聚合小样验证 schema，再上动态控件（是本清单里不确定性最高的一项，建议先 spike）。

**建议下一版本（v0.8）范围 = B1 + B2 + B5(B4 兜底) + B3 最小集（搜索/收藏）**；P1 中的时段切换（P1-1）、i18n（P1-5）、性能 HUD（P1-6）放 v0.9；P1-3 Now Playing、P1-4 上传需先做可行性 spike 再决定是否立项。P2/可选一律不进 roadmap 主干，等用户反馈。

**风险总提醒**：① 所有「切换类」功能都要复测 scene 重装配的卡顿/显存（本仓已知 4K 单张数百 MB 显存，README）；② 所有新增定时器/监听必须走 `index.ts` 的 teardown 模式，否则 HMR 重载会泄漏（本仓已踩过「层数累计到 9」的坑）；③ 不要把浏览器拿不到的能力（系统音频、前台应用、GPU 占用、全局热键）写成承诺；④ 新增存储谨慎：DSH settings 是低频配置，收藏/标签/播放列表历史等高频数据放 localStorage 并接受同 origin 限制（AGENT §7.38 同款口径）。

---

## 6. 来源清单（含核实状态）

**官方**
- Wallpaper Engine 官方产品页（功能项、FAQ）：<https://www.wallpaperengine.io/en> — 已核实
- Wallpaper Engine 官方帮助站索引（分类/文章标题）：<https://help.wallpaperengine.io/> — 已核实（导航）
- 帮助站「Album Cover & Media Data Feature」：<https://help.wallpaperengine.io/en/audio/mediaintegration.html> — 已核实（正文）
- 帮助站视频分类（Videos Black / Not Playing / performance / artifacts）：<https://help.wallpaperengine.io/en/videos/notplaying.html> 等 — 仅标题级（正文抓取回落到索引页）
- 帮助站其他文章（屏幕保护、按应用规则、CLI、导出、锁屏、Linux/Mac、音频可视化、性能）：<https://help.wallpaperengine.io/en/functionality/screensaver.html>、<https://help.wallpaperengine.io/en/functionality/wallpaperperapp.html>、<https://help.wallpaperengine.io/en/functionality/cli.html>、<https://help.wallpaperengine.io/en/functionality/export.html>、<https://help.wallpaperengine.io/en/general/lockscreen.html>、<https://help.wallpaperengine.io/en/functionality/linuxmacos.html>、<https://help.wallpaperengine.io/en/audio/audiodetection.html>、<https://help.wallpaperengine.io/en/performance/gpu.html> — **仅标题级**（未逐篇抓正文）
- Steam 商店页：<https://store.steampowered.com/app/431960/Wallpaper_Engine/> — **抓取失败（两次 `fetch failed`），未核实**，本报告不引用其文案
- 创作者文档（编辑器/SceneScript/粒子）：<https://docs.wallpaperengine.io> — 未抓取（官方产品页已覆盖其存在性）

**竞品**
- Lively Wallpaper：<https://github.com/rocksdanister/lively>（现跳转 <https://github.com/lively-community/lively>）— README 已核实；仓库元数据（19,855★ / GPL-3.0 / 默认分支 `core-separation`）来自 <https://api.github.com/repos/rocksdanister/lively>（重定向到 lively-community/lively，已核实）；README 与 API 许可证不一致（Ms-PL vs GPL-3.0），**未核实**
- skwd-wall：<https://github.com/liixini/skwd-wall> — README 已核实（MIT、V2 Rust 重写声明、功能列表）；**1083★ 为任务输入、未独立核实**；README 原文 <https://raw.githubusercontent.com/liixini/skwd-wall/main/README.md>
- Loomscreen（macos-wallpaperengine）：<https://github.com/Paradox07127/macos-wallpaperengine> — README 已核实（MIT、macOS 14.6+、Lite/Pro 功能矩阵）
- jagrat7/linux-wallpaper-engine：<https://github.com/jagrat7/linux-wallpaper-engine> — **仅 GitHub 描述级**（raw README 在 `main` 返回 404，默认分支名未核实）
- Almamu/linux-wallpaperengine：<https://github.com/Almamu/linux-wallpaperengine> — **未直接核实**（功能定位引用自 skwd-wall README 的依赖说明；本项目 README 也把它列为格式语义对齐来源）

**本项目（只读）**
- `README.md`（能力、配置表、自认缺口 L176、已知限制 L199-217）
- `AGENT.md §7`（遗留边界：§7.16/30/31/32/33/34/35/38 等）
- `src/host/routes.ts`（路由：`/wallpapers/{list,media,scene,static,web,particle-texture,probe}`）
- `src/client/settings.ts`（DEFAULTS 字段、用户属性 localStorage 读取）
- `src/client/settings-section.tsx`（面板 section 与控件）
- `src/client/index.ts`（公开 API、设置下发、teardown、轮播缺失的直接证据）
