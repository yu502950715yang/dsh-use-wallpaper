# DSH Wallpaper Engine 竞品分析与功能路线图

> **日期**：2026-10-19（GitHub 数据为当日快照，stars/版本会继续变化）
> **对象**：本项目 `@dsh-use/wallpaper-engine` v0.7.1（[yu502950715yang/dsh-use-wallpaper](https://github.com/yu502950715yang/dsh-use-wallpaper)）
> **配套调研**（同目录）：
> - [DSH 插件生态竞品调研](./competitive-2026-10-19/dsh-ecosystem.md)
> - [第三方 WE scene 渲染器技术对标](./competitive-2026-10-19/renderers.md)
> - [WE 官方能力与成熟壁纸产品功能基线](./competitive-2026-10-19/we-product.md)
> **口径**：✓ 官方 README/文档明确支持；△ 部分支持或有限；✗ 明确不支持；「未核实」= 本轮没有直接证据，不当作结论。竞品数字均为 2026-10-19 快照。

---

## 0. 结论先行

1. **这个赛道已经很卷，头部已经形成。** DSH 生态里带「壁纸/背景/换肤」的仓库有 150+ 个（GitHub 检索 `wallpaper+dsh` 277、`dsh-plugin+wallpaper` 162，见附录 B），但真正实时渲染 Wallpaper Engine scene 的只有三条线：**elysia395/dsh-wallpaper-engine**（1568★，事实标准）、**XHR666 的 WEwebLoader 路线**（GPL-3.0，需另装），以及**本项目**（自研 three.js + Rust/WASM）。其余绝大多数是图片/视频/换肤，或拿工坊预览图冒充「场景」。
2. **头部的 scene 引擎不是自研的。** elysia 的场景/网页渲染来自**随包 npm 依赖 `webwallgl ^3.0.0`**（[oneincase/webwallgl](https://github.com/oneincase/webwallgl)，MIT，13★），它自己做的是产品层：5 级降级链、壁纸库、上传、轮播、液态玻璃、系统音频、三平台、i18n。**这既是它跑得快的原因，也是它最大的单点依赖。**
3. **我们的长板在「引擎与正确性」，短板在「产品化与降级链」。** 本项目自研 scene 渲染，WE 语义细粒度（对象 RT、具名 RT 图链、段渲染帧快照、混合模式、坐标/行序等）有成体系文档和逐像素 e2e；但普通用户第一眼看到的是：不能轮播、不能上传、不能搜索/隐藏、没有属性面板、scene 失败只剩一张预览图、视频 HEVC 黑屏无提示。
4. **最大的感知差距是「降级链」。** 我们是 1 级（scene → preview 图），elysia 是 5 级（实时渲染 → 作者内嵌 MP4 → GPU 抓帧 → 自定义画面 → 空态+失败原因），并带失败记忆、按包大小算首帧预算、载荷账本、抓帧几何校验。这一项性价比最高，应进下一版。
5. **渲染广度差距真实存在。** 对照 WebWallGL / OWE / we-layerd：我们在 puppet 全栈（真实蒙皮、attachments、masks、MDMP morph、骨骼模拟）、3D 模型、相机 zoom/shake/path、`copybackground`、`colorBlendMode` 全集、壁纸级 bloom/PBR 上仍是缺项或「只有合成夹具覆盖、无真实素材验收」。
6. **不要跟跑「液态玻璃/吉祥物/字体预设」军备竞赛。** elysia 的大量 issue 来自对宿主 DOM/CSS-module 的深度改造；该路线收益递减、回归面大。我们的差异化应押在「**独立引擎、可验证的桌面级还原、轻量不侵入宿主**」。
7. **建议下一版（v0.8）做 6 件事**：多级降级链、视频编码兜底、显示效果面板补齐、播放列表/轮播、壁纸库搜索/收藏/隐藏、用户属性面板。预期覆盖 80% 的「产品不完整」体感，且不依赖重写渲染器。
8. **「是否接入 WebWallGL」建议不作为默认路线。** 接入等于和头部用同一颗引擎，差异化消失；保留自研 + 借鉴其行为结论更符合项目资产。若未来证明渲染广度是硬需求，可评估「可选后端」而非替换。

---

## 1. 调研范围与方法

- **直接竞品**：DSH 插件生态中所有壁纸/背景/换肤类插件（重点深挖 elysia395）。
- **技术竞品**：不依赖 WE 官方运行时、能渲染 WE scene 的开源实现（浏览器端 + 原生）。
- **产品基线**：Wallpaper Engine 官方能力 + 成熟动态壁纸产品（Lively、skwd-wall、Loomscreen 等）。
- **本项目现状**：只读核对 `README.md`、`AGENT.md` §5/§7、`docs/technical-notes.md`、`src/`（未改动任何源码）。
- **证据**：全部结论带 URL；未核实项在正文与各调研文件末尾集中标注。GitHub API 未认证限流（search 10 次/分、core 60 次/时），原始抓取与检索式见附录 B。
- **本轮不做**：不改代码、不跑构建/测试、不做 git 操作。本报告是调研交付物，不是实施计划。

---

## 2. 竞品全景

### 2.1 直接竞品：DSH 壁纸插件

| 插件 | ★（快照） | 最近 push | scene 实时渲染 | 产品化程度 | 许可 |
|---|---|---|---|---|---|
| [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine) | **1568** | 2026-10-18 | ✓ **内嵌 WebWallGL** + 5 级降级链 | 六页签设置、壁纸库、上传、轮播、属性面板、液态玻璃、系统音频、i18n、三平台 | MIT |
| **本项目** `@dsh-use/wallpaper-engine` | 5 | 2026-10-19 | ✓ **自研** three.js + Rust/WASM | 单页设置面板（目录/壁纸网格/Glow/省电/文字可读性/健康） | MIT |
| [XHR666/dsh-mpkg-wallpaper](https://github.com/XHR666/dsh-mpkg-wallpaper) | 10 | 2026-10-13 | △ 需另装 GPL 渲染器（刻意不内嵌） | `.mpkg`/视频/web/图片、多时段、轮播、Now Playing | MIT |
| [XHR666/wallpaper-engine-web-loader](https://github.com/XHR666/wallpaper-engine-web-loader)（引擎本体） | 1 | 2026-10-16 | ✓ scene.pkg/.mpkg/workshop 目录 | 242 项回归 + 静态闸门 | **GPL-3.0-or-later** |
| [nishuoyang/dsh-wallpaper-bg](https://github.com/nishuoyang/dsh-wallpaper-bg) | 7 | 2026-10-17 | △ 「场景模式」= 工坊预览图 | 三来源 + 播放队列 + 亮度/模糊 | MIT |
| [AppliedYuu/dsh-WallpaperAndCost](https://github.com/AppliedYuu/dsh-WallpaperAndCost) | 3 | 2026-10-17 | △ 离线解析 scene.pkg 出静态图 | 费用面板 + 背景 | 未核实 |
| [YRN-playmaker/dsh-wallpaper_share](https://github.com/YRN-playmaker/dsh-wallpaper_share) | 32 | 2026-10-18 | △ 同步 WE 当前壁纸（实现方式未核实） | WE 状态联动、多显示器 | GPL-3.0 |
| [Y1X1n/we-for-vscode](https://github.com/Y1X1n/we-for-vscode)（VS Code 同类形态） | 4 | 2026-10-09 | ✓ WebGL 实时渲染 | 液态玻璃面板 + 整窗背景 | 未核实 |
| 换肤/图片/视频类头部：[RevolutionLA/dsh-dream-skin](https://github.com/RevolutionLA/dsh-dream-skin) 253★、[SLin-code/dsh-custom-skin](https://github.com/SLin-code/dsh-custom-skin) 101★、[starsstreaming/beautiCode](https://github.com/starsstreaming/beautiCode) 91★ 等 | 91–253 | 2026-09/10 | ✗ | 换肤/壁纸/主题包，不做 scene | MIT 等 |

**观察**：

- **头部极尖**：elysia 1568★，第二名（同品类真实场景）只有个位数星级；壁纸/换肤类第二名是 253★ 的 dream-skin。
- **真正渲染 scene 的只有三条线**：elysia（WebWallGL）、XHR666（WEwebLoader，GPL）、本项目（自研）。差异化的技术门槛真实存在，但市场教育已被头部完成。
- **GPL 分叉信号**：XHR666 的 `dsh-mpkg-wallpaper` 明确「不内嵌、不 import」WEwebLoader 以隔离 GPL —— 说明「MIT 项目不想被 GPL 渲染器污染」是生态里的真实约束，反过来也是我们自研 MIT 引擎的卖点。

### 2.2 技术竞品：浏览器端 WE 渲染核心

| 项目 | ★ | 许可 | 能力 | 与我们的关系 |
|---|---|---|---|---|
| [oneincase/webwallgl](https://github.com/oneincase/webwallgl) | 13 | MIT（npm v3.0.0） | scene/web/video；图层/效果/粒子/模型/SceneScript/用户属性/音频可视化；**自带 scene 编辑器 + 导出官方 scene.pkg**；被 elysia 作为引擎 | **最重要对标**：能力面比我们广，且背后站着头部插件 |
| [XHR666/wallpaper-engine-web-loader](https://github.com/XHR666/wallpaper-engine-web-loader) | 1 | GPL-3.0-or-later | scene.pkg/.mpkg/workshop；TEX/MDL/蒙皮/动画/附件/效果链/SceneScript/音频频段；242 项回归；无 GPU 回退 CPU | 行为参照；**许可红线不可借代码** |
| [lucaschnabel42/wallgl](https://github.com/lucaschnabel42/wallgl) | 0 | 无 | README 404，不可用 | 忽略 |
| **本项目** | 5 | MIT | 自研 three.js + Rust/WASM；scene 语义深度好；无编辑器/3D 模型/属性面板 | — |

### 2.3 参考实现：原生/平台 WE 渲染器

| 项目 | ★ | 许可 | 平台/后端 | 值得注意的能力 |
|---|---|---|---|---|
| [Almamu/linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) | 4666 | GPL-3.0 | Linux，C++/OpenGL 3.3 | Linux 事实标准；组件/效果/puppet 静态网格/SceneScript/FFTW 音频/bloom；**本项目 README 已声明语义对齐自它** |
| [waywallen/open-wallpaper-engine](https://github.com/waywallen/open-wallpaper-engine) | 253 | GPL-2.0 | Linux，C++/Vulkan + render graph | Feature list 明确：ColorBlendMode / PBR / Global bloom / Camera zoom·shake·path / Puppet attachments·masks / Audio visualization / 3D model / User Properties；bone sim 与 MDMP 未实现 |
| [Aromatic05/we-layerd](https://github.com/Aromatic05/we-layerd)（含渲染子模块） | 140 | **无 LICENSE**；子模块 GPL-2.0-only | Linux/Wayland，Rust + C++ | 能力面最全：puppet 蒙皮/多段动画/attachments/MDMP 解析、copybackground、HDR bloom、SceneScript、多输出、64-bin 音频频谱、user properties GUI；每输出独立 renderer worker |
| [Paradox07127/macos-wallpaperengine](https://github.com/Paradox07127/macos-wallpaperengine)（Loomscreen） | 64 | MIT | macOS，Swift/Metal | 原生 Metal 渲染 scene；puppet-warp 动画、audio-reactive、cursor effects；App 层有播放列表/时段槽位/资源条/快捷键/5 语言 |
| [NixaXI/AnisPaper](https://github.com/NixaXI/AnisPaper) | 37 | GPL-3.0+ | KDE Plasma 6，静态链接 lwe 核心 | 多显示器可用，1080p scene 约 58 FPS |
| [UnhingedSoftware/kirie](https://github.com/UnhingedSoftware/kirie) | 3 | AGPL-3.0+ | Rust/wgpu，Linux/macOS | scene 预烘焙 bundle 缓存；与 WE 逐张对拍兼容清单 |
| [RainyPixel/wallpaper-engine-kde-plugin](https://github.com/RainyPixel/wallpaper-engine-kde-plugin) | 80 | GPL-2.0 | KDE，Vulkan | Scene(2D)/Web/Video；原仓 catsout 2700★ 已归档 |
| [pySam1459/wallpaper-kit](https://github.com/pySam1459/wallpaper-kit) | 1 | MIT | Windows，Rust/D3D11 | 早期阶段；puppet 变形/动画层明确不支持 |
| [liixini/skwd-wall](https://github.com/liixini/skwd-wall) | 1083 | MIT | Linux/Wayland 前端 | 不自己渲染，scene 委托 lwe；产品功能丰富（标签/收藏/每屏/随机/Wallhaven/Steam 浏览） |

**许可证红线**（决定「能不能借代码」）：MIT 阵营 = 本项目 / WebWallGL / elysia / Loomscreen / wallpaper-kit / skwd-wall；GPL-3 = WEwebLoader / lwe / AnisPaper；GPL-2 = OWE / KDE 插件 / we-layerd 渲染子模块；AGPL-3 = kirie；we-layerd 宿主无许可证。**GPL/AGPL/无许可项目只能做行为对照，不得复制或逐行翻译。**

### 2.4 产品基线：WE 官方与成熟壁纸产品

官方能力（[wallpaperengine.io](https://www.wallpaperengine.io/en)、[help.wallpaperengine.io](https://help.wallpaperengine.io/)，已核实项）：scene/video/web/图片、播放列表（按间隔/时段/登录/启动应用切换）、多显示器与超宽屏、游戏/最大化自动暂停、按应用规则、user properties、音频可视化、专辑封面/媒体数据（Now Playing）、屏保、Android 伴侣、Steam 创意工坊、LED 联动、场景编辑器/SceneScript。

**可迁移到「浏览器内 Web GUI 插件」的**：壁纸类型覆盖、播放列表/轮播/时段切换、用户定制项、音频可视化、媒体信息、性能与画质档位、页面可见性替代的暂停规则、库浏览/搜索。
**不可迁移或明确不做的**：多显示器每屏独立（单页架构，需 DSH 多窗口）、按前台应用规则、屏保/锁屏、移动伴侣、LED、工坊上传、场景编辑器。

成熟产品基线（Lively 19855★ GPL-3.0、skwd-wall 1083★、Loomscreen 64★）共同具备、而本项目普遍缺失的功能：**轮播/播放列表、收藏/隐藏/搜索/标签、本地导入、每屏独立、暂停规则、音频响应、资源占用 HUD、快捷键、i18n、适配/裁剪**。

---

## 3. 与头部竞品 elysia395/dsh-wallpaper-engine 的逐项对比

### 3.1 基本盘

| 维度 | elysia395/dsh-wallpaper-engine | 本项目 |
|---|---|---|
| 版本 / 分发 | npm `dsh-plugin-wallpaper-engine` **1.3.3**（2026-10-15）；GitHub Releases 11 条；应用内市场 | npm `@dsh-use/wallpaper-engine` **0.7.1**；npm + GitHub 安装 |
| Stars / 社区 | **1568★ / 62 fork / 35 open issues**；贡献者十余人；QQ/抖音群 | 5★ / 0 fork / 1 open issue |
| 运行要求 | Node ≥18；DSH ≥0.1.5-rc.1；桌面端另有版本线 | DSH 0.1.5-rc.3 / 0.1.6 / 0.1.7 已实测；Node 无 engines |
| scene 引擎 | **内嵌 `webwallgl ^3.0.0`**（第三方 MIT 引擎，随包依赖） | **自研** three.js 场景图 + Rust/WASM CPU 粒子模拟 |
| scene 覆盖自述 | 「90% 以上的场景效果」（官方自述，无第三方复测） | 未宣称全库支持；§7 如实列边界，逐像素验收过样本 |
| 支持类型 | scene / web / video / 自定义图片视频；**Application 不支持** | scene / video / web / image；**Application 不支持**（共识边界） |
| 三平台 | Windows / macOS / Linux 同一包；各平台媒体链 | 仅 Windows 实测；macOS 未测 |
| 设置存储 | 宿主端 `~/.dsh-wallpaper-engine/config.json` + 十余个环境变量 + 目录迁移 | DSH profile `cordis.patch.yml` + 面板字段（双版本适配） |
| zero-token | 不注册工具/不注入提示文本 | 同样不注册工具（README 未明文承诺，可补） |
| 许可 | MIT | MIT |

### 3.2 架构差异：套壳引擎 vs 自研引擎

- **elysia**：`webwallgl` 负责解析/渲染/脚本/音频/指针；它自己保留渲染页适配、宿主路由、降级链、产品 UI。优点：引擎能力跟上游升级即可获得；缺点：**渲染保真度和 bug 修复节奏受上游约束**，且「与头部同引擎」意味着任何后来者都能获得同等渲染能力。
- **本项目**：从 PKGV 解包、TEX 解码、场景图、效果链、粒子、puppet、SceneScript 到 Glow 全部自己实现；优点：**技术资产自有、许可干净、可按 WE 语义逐项打磨、可做逐像素对拍**；缺点：能力广度推进慢，缺编辑器/3D 模型/属性面板等。
- **结论**：这不是「谁先进」的问题，而是两种路线。我们的护城河应建立在「自研引擎 + 可验证的还原」上；如果改为接入 WebWallGL，等于放弃这条护城河去和头部拼产品化，胜率更低。

### 3.3 最值得借鉴的一环：多级出图/降级链

elysia 的权威顺序（[HOW-IT-WORKS](https://github.com/elysia395/dsh-wallpaper-engine/blob/main/docs/HOW-IT-WORKS.md)，代码在 `lib/routes/scene-frame.js`）：

| 级 | 出图来源 | 关键工程点 |
|---|---|---|
| ① | 实时渲染 iframe（`sceneLive`，默认开） | 首帧预算按 `scene.pkg` 大小现算；载荷账本轮询「字节还在涨」就重置计时；隐藏/未播放实例不拉载荷 |
| ② | 场景**作者内嵌 MP4**（`sceneVideo`） | 硬件解码 `<video>`；真实探测到才给 URL |
| ③ | **实时抓帧**（GPU PNG） | 首帧确认后客户端回填；视口宽高比偏差 >2% 自动清除重抓；空帧门禁（近全黑/无对比度判废） |
| ④ | 自定义画面 | 用户导入的截屏，显式 pin 不被抓帧顶掉 |
| ⑤ | 空态 | 404 + 可判定原因（不猜图） |

另有：失败记忆（只有真不出帧/失联才落盘，重开开关可清空）、传输未完成 = 会话内软失败 + 冷却重试、`scene.pkg` ETag 条件请求缓存、loopback 媒体源避免与 DSH 主框架抢带宽。

**本项目现状**：只有「scene 渲染失败 → preview 图 + Ken Burns」一级。`render-health.ts` 已有硬/软失败分级、重试与失败记忆，但没有「抓帧/内嵌 MP4/自定义画面」这几级，也没有首帧预算与载荷账本。**这是投入产出比最高的一项。**

### 3.4 产品功能矩阵（elysia vs 本项目）

| 能力 | elysia | 本项目 |
|---|---|---|
| scene 实时渲染 | ✓ WebWallGL | ✓ 自研 |
| 不需要 WE 进程在后台 | ✓ | ✓ |
| 是否仍需要本机 WE 安装（素材） | 未核实（提供 `DSH_WE_ASSETS_DIR` 覆盖；mac/Linux 可用项目目录） | **需要**（缺素材时粒子退化纯色圆点，画面仍在） |
| video / web / image 壁纸 | ✓ / ✓ / ✓ | ✓ / ✓（沙箱 + 指针 shim）/ ✓ |
| 场景多级降级链 | ✓ 5 级 + 失败记忆 + 首帧预算 | △ 仅 preview 图 + Ken Burns |
| 视频编码兜底 / 帧率上限转码 | ✓ ffmpeg 15/30/60 fps 转码缓存 | ✗（HEVC 在 Edge 黑屏且无提示/无回退） |
| 壁纸库搜索 / 类型筛选 / 隐藏恢复 | ✓（含内容分级、虚拟滚动） | ✗（仅缩略图网格 + 刷新） |
| 播放列表 / 轮播 / 过场 | ✓（间隔/顺序随机/失败跳过/7 种过场） | ✗ |
| 自定义上传（图片/视频/适配模式） | ✓（存储目录可迁移、去重、缩略图） | ✗（只读 workshop） |
| 壁纸属性（user properties）面板 | ✓（按壁纸保存、可恢复默认） | △ 只读注入（`getUserPropertyValue`），无面板/无写入入口 |
| 显示效果面板（透明度/模糊/取景） | ✓ | △ 字段有、面板无（README 自认 `overlayOpacity` / `blur*` / `kenBurns` 无控件；Glow/文字颜色/描边有） |
| 液态玻璃 / 主题 / 字体 / 外观预设 | ✓ 全套 + 7 套预设 | ✗（仅输入框半透明玻璃底 + 文字颜色/描边） |
| 包内音频 / 音频驱动效果 | ✓（默认静音，音量控制） | ✓（`soundEnabled` 默认开；频谱驱动 effect uniform） |
| 系统音频回环频谱 / Now Playing / 在线歌词 | ✓（WASAPI/GSMTC、MediaRemote、MPRIS） | ✗ |
| 音频可视化柱状层 | ✓（WebWallGL） | ✗（README 自认） |
| FPS 上限 / 遮挡暂停 / 电池暂停 | ✓（含 3s 低频复核） | △（`paused` / `pauseOnHidden` / qualityScale） |
| 三平台 / i18n | ✓ / ✓（跟随 DSH locale） | ✗ / ✗ |
| 公开 API / 健康面板 | 部分（面板内重抓/清帧） | ✓（`window.__wallpaperEngine` + 实时渲染健康卡片） |
| scene 渲染广度（puppet 全栈/3D/相机等） | ✓（WebWallGL 自述） | △/✗（见 §4） |
| 逐像素对拍 / 回归门禁 | 未核实（有 `verify`/`smoke`/文档闸门） | ✓（headless Edge e2e、A/B 对拍、known-failures/type-errors 棘轮） |
| 对宿主 DOM 的侵入面 | 大（设置窗/侧栏/标题栏/浮层玻璃全面接管） | 小（仅背景层 + 设置页） |
| 许可证 | MIT | MIT |

### 3.5 工程与验证体系

| 维度 | elysia | 本项目 |
|---|---|---|
| 文档规模 | CHANGELOG 2078 行、12 份 ADR、ROUTE-INDEX 生成、HOW-IT-WORKS、CODE-STRUCTURE | AGENT.md（约 248 行硬约束/遗留）+ technical-notes + `docs/superpowers/` 设计/计划/修复归档 |
| 自动化验证 | `verify` / `smoke` / `verify:docs` / i18n 双向对账 / 客户端行为级判据 / 变异验证 | vitest（node + jsdom）+ headless Edge 逐像素 e2e + CI（tsc/产物新鲜度/vitest 新增失败/Windows 渲染 e2e） |
| 工程风险 | 产品宽度带来的回归面大（issue 中大量玻璃/侧栏/宿主 DOM 兼容问题） | 渲染语义深水区维护成本高；产品面缺失导致「可用性」被拉开 |
| 迭代速度 | 近 30 天至少 4 个版本 | 本仓库 master 近两周多次提交，但产品向 PR 少 |

### 3.6 差异总结

**我们更强的地方**

1. **自研渲染引擎，无第三方渲染依赖**：技术资产自有、许可干净、可逐项对照 WE 语义打磨；elysia 的 scene 能力依赖上游 WebWallGL。
2. **WE 语义细粒度工程化**：`colorBlendMode` 读帧缓冲混合语义、对象 RT 屏占位预算、具名 RT 图链、段渲染 + `_rt_FullFrameBuffer` 帧内快照、坐标/行序/采样不变量都有文档与单测。
3. **逐像素对拍与零回归门禁**：`e2e:compare` 判据「最大差 ≤1 且差≥2 像素为 0」，这是竞品公开材料里没有的（未核实其内部是否有）。
4. **轻量、不侵入宿主 DOM**：只做背景层 + 设置页；回归面远小于玻璃/字体/吉祥物体系。
5. **失败看护与如实文档**：硬/软失败分级记忆、重试入口、`§7` 明确列边界，不虚标「全库支持」。

**我们更弱的地方**

1. **产品化**：库管理、轮播、上传、属性面板、显示效果面板、i18n、三平台、设置存储工程化——这些决定普通用户是否用得下去。
2. **降级链**：只有 1 级，竞品 5 级且有失败记忆/首帧预算/抓帧几何校验。
3. **视音频联动**：无系统音频回环、无 Now Playing、无频谱柱。
4. **渲染广度**：puppet 全栈、3D 模型、相机系统、copybackground、bloom/PBR 等。
5. **分发与社区**：1568★ vs 5★，版本 1.3.3 vs 0.7.1，应用内市场/公告/社区群 vs 基本没有运营。

---

## 4. 渲染技术对标（vs WebWallGL / 原生实现）

状态：**有** / **部分** / **无**（来源见 [renderers.md](./competitive-2026-10-19/renderers.md)）

| 能力 | 本项目 | WebWallGL | OWE / we-layerd / lwe |
|---|---|---|---|
| 图层（image/composition/fullscreen） | 有 | 有 | 有 |
| 文本（含时钟/日期） | 有 | 有 | 有 |
| 效果链（多 pass / FBO / 具名 RT） | 有 | 有 | 有 |
| 粒子（emitter/initializer/operator/子粒子/音频响应） | 有 | 有 | 有 |
| puppet 蒙皮 | 部分（有 SkinnedMesh 路径，本机无真实蒙皮样本） | 有（细节未核实） | OWE/we-layerd 有；lwe 部分 |
| puppet 骨骼动画（多段/blend） | 部分（只应用第一条可见层，blend/additive 未混合） | 有 | OWE/we-layerd 有 |
| puppet attachments（MDAT）/ masks | 无 | 未核实 | OWE 有 attachments+masks |
| MDMP morph / 骨骼模拟 | 无 | 未核实 | OWE 明确无；we-layerd 解析 MDMP（消费未核实） |
| 3D 模型（obj/glTF 等） | 部分（仅 WE `.mdl` 静态网格） | 有（编辑器全格式导入） | OWE 有；lwe 部分 |
| SceneScript | 有（QuickJS 沙箱 + 降级） | 有 | 有 |
| user properties | 部分（注入 + 读取，无面板） | 有（绑定可见/透明度等） | OWE 有；we-layerd 有 GUI |
| 相机 zoom / shake / path | 部分（仅基础相机 + cover） | 部分 | OWE 三项全有 |
| 音频 loop/random | 有 | 有 | 有 |
| 音频可视化/频谱 | 部分（驱动 uniform；柱状层无） | 有 | OWE/lwe 有 |
| 鼠标交互 | 有（视差 + web 指针转发） | 有 | 有 |
| colorBlendMode 全集 | 部分（仅 6/7/31） | 未核实 | OWE 有；we-layerd 有完整 plan |
| copybackground | 无 | 未核实 | we-layerd 有 |
| 壁纸级 bloom/HDR、PBR | 部分（应用级 Glow；`general.bloom` 无；PBR 无） | 有（场景设置 bloom/HDR） | OWE/lwe/we-layerd 有 |
| 视频后处理 | 无（Glow 仅 scene） | 有（视频层/转码） | 部分 |
| 多显示器/多输出 | 无（单 canvas，架构限制） | 未核实 | 原生实现普遍有 |
| 编辑器 / 导出 scene.pkg | 无 | **有（独有护城河）** | 无 |

**结论**：

- 本项目在「WE 玩法细节的工程化正确性」上是竞品里做得最深的之一，但**能力广度明显落后**；WebWallGL 和 we-layerd 是能力面最全的两个参照。
- **编辑器/导出**只有 WebWallGL 有，且它本身也是 MIT 可嵌入——这块不建议追（工程量级完全不同），但可以在 README 里明确「播放器定位，不做编辑器」。
- 渲染深水区优先级建议：**puppet 真实素材验证与 attachments → copybackground → colorBlendMode 全集 → 壁纸级 bloom/PBR → 相机 path/shake**。每项都应先找到真实壁纸样本与桌面 WE/原生实现对照，再动手；无验收素材的投入容易变成「只有夹具覆盖」。

---

## 5. 功能缺口清单与优先级

> 成本：**S** ≤1 人日；**M** 2–3 人日；**L** ≥5 人日（含验收）。估算不含真机素材验证的不确定性。
> 「依据」= 哪个竞品/产品已有，用于判断这是不是 table stakes。

### 5.1 P0：下一版（v0.8）应做，直接决定「产品是否完整」

| # | 功能 | 依据 | 现状 | 价值 | 成本 | 依赖 / 风险 |
|---|---|---|---|---|---|---|
| P0-1 | **多级出图降级链**：scene 实时 → 作者内嵌 MP4 → 抓帧静图 → 自定义画面 → 预览图/空态+原因 | elysia 5 级链 | 只有 preview + Ken Burns | 用户感知稳定性最高；直接解决「黑一下/糊一下就没」 | M | 抓帧要 canvas→blob→宿主路由缓存、几何校验、空帧门禁；MP4 需从 project.json/scene 资源真实探测；HMR teardown |
| P0-2 | **视频编码兜底**：`canPlayType` / `error` / `loadeddata` + 首帧超时 → 回退 preview + 明确提示（HEVC 黑屏不再无声） | 浏览器宿主必然补丁；WE 桌面端用系统解码 | HEVC 在 Edge 黑屏、无提示、不退回封面 | 真实投诉点；成本低、收益立竿见影 | S–M | 不引入 host ffmpeg 转码（L 成本/许可/Windows-only），只做检测/提示；阈值要区分解码慢与坏文件 |
| P0-3 | **显示效果面板补齐**：`overlayOpacity` / `blurEnabled` / `blurRadius` / `kenBurns` 控件；补适配模式（cover/contain/stretch） | README 自认字段有、面板无；Lively/WE 有适配 | 只有 Glow/文字颜色/描边/省电 | 消除「文档与实现不符」；低成本提升观感可调 | S（控件） / M（适配模式） | 模糊高分辨率有 GPU 成本，默认保持关/低；web 适用性按类型禁用 |
| P0-4 | **播放列表 / 自动轮播**：间隔、顺序/随机、就绪后切换、失败跳过、暂停联动 | elysia、WE、Loomscreen、skwd-wall | 只有单个 `selectedWallpaperId` | 日常使用最高频需求；「会动的壁纸」升级为「会换的壁纸」 | M | scene 每次切换重建 player，4K 有卡顿/闪黑 → 复用 renderer + fade 过渡；轮播与手动选择/软失败重试的竞态；页面隐藏/暂停停表；设置写入别每 tick 落盘 |
| P0-5 | **壁纸库最小产品化**：搜索 + 类型筛选 + 收藏/隐藏/恢复 + 最近使用排序 | elysia、skwd-wall、Loomscreen、WE | 纯缩略图网格 | 壁纸一多就不可用；纯前端即可 | M | 隐藏/收藏放 localStorage（勿写 DSH 低频配置）；大库虚拟滚动/懒加载；同 origin 限制（§7.38 口径） |
| P0-6 | **用户属性（user properties）面板**：聚合可定制 key → bool/slider/color/combo 控件；写入 `we:userprop:<key>` | WE 官方卖点；elysia 已做；we-layerd GUI | 只读注入、无面板/无写入 | WE 热门壁纸大量依赖可定制项；竞品已有 | M（先 spike） | **schema 未核实**：先做 host 侧聚合小样（`scene.json` 的 `visible:{user,value}` 绑定 + `project.json` 属性表）；类型推断可能出错；改属性后重装配 vs 就地生效 |

> 补充：**P0-1 之前应先做一个验证任务** —— 核实 elysia 在未安装 WE 的机器上能否实时渲染 scene。它的 README 只承诺「不需要 WE 在后台运行」，同时提供 `DSH_WE_ASSETS_DIR` 覆盖；mac/Linux 无 WE 客户端时用项目目录/上传。如果它确实不依赖 WE 素材，那我们「必须本机装 WE」就是结构性门槛；如果也依赖，只是降级表现不同，则差距缩小为降级链。**在未核实前，不把「免装 WE」写成我们的承诺。**

### 5.2 P1：v0.9（有它才像完整产品）

| # | 功能 | 依据 | 成本 | 备注 / 风险 |
|---|---|---|---|---|
| P1-1 | 本地图片/视频上传（host 写盘、白名单/大小限制、去重、缩略图、适配模式） | elysia、Lively、Loomscreen | M–L | 路径穿越/扩展名白名单；DSH 桌面版与 web 数据目录差异；上传视频同样有编码问题 |
| P1-2 | 时段/日程切换（按时段/日历，复用 P0-4 调度器） | WE 官方、Loomscreen | M | 时区/夏令时；页面长期不刷新时用 wall-clock 重算而非累加 |
| P1-3 | i18n（中/英，跟随 DSH locale；README 双语） | elysia、WE、Loomscreen | S–M | slot label 是字符串注册，需动态文案；文案量机械 |
| P1-4 | 性能档位产品化：`qualityScale` 扩到 0.25、目标 FPS 上限、性能 HUD（渲染 FPS/帧时间/RT 显存估算）、自动降级 | WE 性能设置、Loomscreen | S–M | 浏览器拿不到 GPU 占用/温度，只能给渲染侧指标；别宣称「资源监控」 |
| P1-5 | 暂停规则增强：`document.fullscreenElement`、电池、低频复核（防 confirm 丢 focus） | WE、Loomscreen、elysia | S | `getBattery` 非标准/隐私模式可能拒绝；只反映本页全屏，不是其他应用全屏 |
| P1-6 | 宿主端设置存储工程化：单一 `config.json` + 数据/缓存/上传目录可迁移 + 环境变量覆盖 | elysia | M | 与 DSH settings 系统兼容策略要先定（项目现在走 profile `cordis.patch.yml`，新版 DSH 设置只认 volatile 字段） |
| P1-7 | 公开 API/快捷键扩展：`next/prev/pause/random/current`；页面内快捷键默认关 | Loomscreen、skwd-wall、WE CLI | S | DSH 输入框会抢键；无系统级全局热键；HMR teardown 要移除监听 |
| P1-8 | web 壁纸失败回退 + WE API shim（`wallpaperPropertyListener` / `wallpaperRegisterAudioListener`） | elysia、WebWallGL | M | 跨源 iframe 拿不到子帧错误；白屏可能漏判；shim 注入顺序要早于壁纸脚本 |

### 5.3 P2：差异化 / 后续（按素材与用户反馈推进）

| # | 方向 | 依据 | 备注 |
|---|---|---|---|
| P2-1 | **puppet 真实素材验证**：找带 MDLS/MDLA/MDAT 的壁纸，对齐蒙皮、attachments、masks、多段动画 blend | OWE/we-layerd/WebWallGL/WEwebLoader | 本机唯一 `.mdl` 是静态族 ⇒ 目前蒙皮/动画只有合成夹具；必须补真实素材验收 |
| P2-2 | **3D 模型**（WE 模型对象 / obj/glTF） | OWE/WebWallGL | 先确认 WE scene 的模型对象 schema 与真实样本 |
| P2-3 | `copybackground` | we-layerd | 读背景副本做倒影/涟漪的场景会缺内容 |
| P2-4 | `colorBlendMode` 全集 | OWE/we-layerd | 现在只有 6/7/31，其余回退 alpha；全库非零样本少，按需推进 |
| P2-5 | 壁纸级 `general.bloom` / PBR / 视频后处理 | OWE/lwe/we-layerd | Glow 现在只覆盖 scene；video/image/web 亮部与桌面有差 |
| P2-6 | 相机系统 zoom/shake/path | OWE | 现在只有基础相机 + cover 取景 |
| P2-7 | `{animation}` 关键帧轨道 | 本仓 §7.16 | 轨道驱动的位移/缩放/旋转仍不生效 |
| P2-8 | 音频频谱可视化（壁纸音效 FFT 柱状） | WE/Lively/WebWallGL | `audio-input.ts` 已有链路；系统音频需 `getDisplayMedia`（用户手势+权限，隐私敏感） |
| P2-9 | 系统音频回环 / Now Playing | elysia、WE、Loomscreen | 浏览器能力有限，先做可行性 spike，别写进承诺 |
| P2-10 | 主题跟随壁纸（schemeColor / preview 取色 → DSH 主题服务） | elysia、skwd-wall、Loomscreen | 需要 DSH 主题服务/变量；先确认宿主接口 |
| P2-11 | 大包首帧预算 / 载荷账本 / ETag 缓存 | elysia | 现在场景资源 `Cache-Control: no-store`；需要区分「可缓存资源」与「改资源即生效」两种需求 |
| P2-12 | 场景编辑器 / 导出 scene.pkg | WebWallGL 独有 | **不建议做**（工程量级不同）；README 明确播放器定位 |

### 5.4 明确不做（写进路线图，防反复讨论）

- Application（应用）壁纸：双方共识边界（要启动第三方可执行程序，与插件/沙箱边界冲突）。
- Steam 工坊浏览/订阅/下载/上传：需要 Steam 凭据或 steamcmd/API，ToS 与凭据安全风险；保持「读本机目录」的正确边界。
- 场景编辑器 / 壁纸制作工具：WE 官方编辑器复刻，超出「播放器」范围。
- 每屏独立壁纸（WE 式）：浏览器单页无法按显示器分区渲染；需 DSH 多窗口/多实例，属宿主能力。
- 屏幕保护 / 锁屏 / 开机自启 / CLI / 系统级全局热键：浏览器宿主拿不到。
- Android 伴侣 / LED 联动 / 移动端：无对应通道。
- host 侧视频转码（近期）：需要 ffmpeg 依赖 + CPU/磁盘 + Windows-only + 许可与体积；先用 P0-2 的检测/提示兜底。

---

## 6. 路线图建议

> v0.8 的实施计划与设计已产出：[实施计划](./superpowers/plans/2026-10-19-v0.8-productization.md)、[设计 spec](./superpowers/specs/2026-10-19-v0.8-productization-design.md)。

| 版本 | 范围 | 目标 |
|---|---|---|
| **v0.8（建议 1–2 周）** | P0-1 降级链、P0-2 视频兜底、P0-3 显示效果面板、P0-4 轮播、P0-5 库搜索/收藏/隐藏、P0-6 属性面板（先 spike） | 消除「产品不完整」的最大体感差距；不依赖重写渲染器 |
| **v0.9（2–4 周）** | P1-1 上传、P1-2 时段、P1-3 i18n、P1-4 性能 HUD/FPS、P1-7 快捷键、P1-8 web 回退/shim | 补齐「完整产品」要素，进入可推荐状态 |
| **v1.0（按素材）** | P2-1 puppet 真实素材、P2-3/4/5 渲染深水区、可验证还原 benchmark、README 对比页、分发（npm/awesome-dsh-plugin PR/社区） | 把「独立引擎 + 可验证还原」做成公开差异化资产 |

**版本策略**：竞品已 1.3.3 且日更；本项目 0.x 可以走「小而快」——每 1–2 周一个 0.x，配 GitHub Release + npm，优先把 P0 变成用户可见的更新。**不要等「渲染全做完」再发版**，产品化缺口会持续吃掉渲染优势。

**文档一致性（顺手修）**：README/AGENT 中已自认的缺口（`overlayOpacity`/`blur`/`kenBurns` 无面板控件、视频 HEVC 黑屏、频谱柱状未支持）在 P0 完成后要同步更新，避免「文档与实现不符」被竞品对比页抓住。

---

## 7. 战略定位与「是否接入 WebWallGL」

**推荐定位**：**独立自研引擎、可验证的桌面级还原、轻量不侵入宿主**。

- 对外叙事：不套壳第三方渲染引擎；与桌面 WE 逐像素对拍/可复现 benchmark；只做背景层，不动宿主设置窗/侧栏/标题栏；MIT、零运行时下载、隐私友好。
- 目标用户：Windows + 大量 scene 壁纸的重度用户、在意还原度/性能/干净安装的用户、开发者/贡献者。
- 不跟跑：液态玻璃全套、字体系统、吉祥物/头像/3D 转盘、外观预设分享。这些是 elysia 的护城河，也是它 issue 的主要来源；跟随投入产出比低。

**是否接入 WebWallGL（MIT，可商用/可嵌入）**

| 选项 | 收益 | 代价/风险 | 建议 |
|---|---|---|---|
| A. 继续自研（主线） | 技术资产、许可干净、可验证还原、轻量 | 渲染广度推进慢；产品化仍需补 | **推荐**：P0 先做产品化，P2 按素材补渲染 |
| B. 用 WebWallGL 替换场景渲染 | 立刻获得 editor/模型/puppet/属性等广度；与头部同引擎 | 差异化消失；依赖上游版本；包体/启动链路变大；与自研语义/验收体系冲突 | 不作为默认路线 |
| C. WebWallGL 作为「可选后端」 | 广度兜底；保留自研为「高保真模式」 | 双引擎维护成本高；两条语义/测试线；用户选择困惑 | 仅在「渲染广度被证明是硬需求」时评估，且先做 spike |
| D. 把自研渲染器做成可复用库（对外） | 把「引擎」变成独立资产，错位竞争 | 需要长期 API/文档投入；与 DSH 插件耦合需拆分 | 可作 v1.x 探索方向 |

**结论**：v0.8/v0.9 不做引擎替换；先把 P0/P1 产品化补齐，同时以 P2 逐项推进渲染深水区。若半年后广度仍是主要差评来源，再评估 C。

---

## 8. 风险与未核实项

**风险**

1. **竞品迭代速度**：elysia 近 30 天至少 4 个版本，且 star/市场曝光有正反馈；产品功能差会继续拉大。
2. **上游引擎进化**：WebWallGL 若继续提升保真度，「自研引擎」的技术叙事窗口会收窄；我们必须在「可验证还原 + 轻量」上持续产出公开证据。
3. **GPL 渲染器普及**：若 WEwebLoader 被更多插件采用，可能形成「免费场景渲染」事实标准，挤压自研/闭源路线。
4. **浏览器能力边界**：系统音频、前台应用、GPU 温度、全局热键都拿不到；不要把不可得能力写成承诺。
5. **HMR/生命周期**：所有新增定时器、监听、RAF 必须走既有 teardown 模式，否则重挂载会泄漏（本仓踩过「背景层叠 9 层」的坑）。
6. **数据时效**：本报告是 2026-10-19 快照，引用前复核关键数字与版本。

**未核实项（禁止当结论使用）**

1. elysia 的 scene 实时渲染是否强依赖本机安装 WE（素材）；mac/Linux 无 WE 时素材从哪来。
2. WebWallGL 源码级细节（copybackground、colorBlendMode 全集、PBR、多显示器、渲染回归测试）。
3. elysia「90% 以上场景效果」的测试口径与样本量（官方自述，无第三方复测）。
4. elysia 是否有公开的逐像素对拍门禁（本仓有；其文档未见）。
5. WEwebLoader 的实际渲染质量/性能与已知限制（README 有 known-issues，未细读）。
6. `media-bridge` 独立仓库地址与许可证。
7. 部分薄 README 竞品（kdzhang-hub、li8476295-bot、TianYa-DAO、sakuraaa667 等）的真实能力。
8. 各竞品 npm 实际下载量与用户规模。
9. `we-layerd` 宿主无许可证、渲染子模块 GPL-2.0-only —— 只能行为对照（本轮已核实到 LICENSE 缺失，但未逐文件确认边界）。
10. WE 官方 Steam 商店页两次抓取失败；本报告只引用官方产品页与帮助站已核实内容。

---

## 附录 A：来源索引（关键）

**直接竞品 / 生态**
- elysia395/dsh-wallpaper-engine：<https://github.com/elysia395/dsh-wallpaper-engine>
  - README：<https://github.com/elysia395/dsh-wallpaper-engine/blob/main/README.md>
  - 工作原理：<https://github.com/elysia395/dsh-wallpaper-engine/blob/main/docs/HOW-IT-WORKS.md>
  - 变更记录：<https://github.com/elysia395/dsh-wallpaper-engine/blob/main/docs/CHANGELOG.md>
  - ADR-0001（WebWallGL 内置）：<https://github.com/elysia395/dsh-wallpaper-engine/blob/main/docs/adr/0001-webwallgl-in-tree-live-renderer.md>
- WebWallGL：<https://github.com/oneincase/webwallgl>
- XHR666/wallpaper-engine-web-loader：<https://github.com/XHR666/wallpaper-engine-web-loader>
- XHR666/dsh-mpkg-wallpaper：<https://github.com/XHR666/dsh-mpkg-wallpaper>
- awesome-dsh-plugin 列表：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>

**渲染器参考**
- Almamu/linux-wallpaperengine：<https://github.com/Almamu/linux-wallpaperengine>
- waywallen/open-wallpaper-engine：<https://github.com/waywallen/open-wallpaper-engine>
- Aromatic05/we-layerd：<https://github.com/Aromatic05/we-layerd>
- Paradox07127/macos-wallpaperengine：<https://github.com/Paradox07127/macos-wallpaperengine>
- NixaXI/AnisPaper：<https://github.com/NixaXI/AnisPaper>
- UnhingedSoftware/kirie：<https://github.com/UnhingedSoftware/kirie>
- RainyPixel/wallpaper-engine-kde-plugin：<https://github.com/RainyPixel/wallpaper-engine-kde-plugin>
- pySam1459/wallpaper-kit：<https://github.com/pySam1459/wallpaper-kit>
- liixini/skwd-wall：<https://github.com/liixini/skwd-wall>

**产品基线**
- Wallpaper Engine 官方：<https://www.wallpaperengine.io/en>、<https://help.wallpaperengine.io/>
- Lively Wallpaper：<https://github.com/rocksdanister/lively>（跳转 lively-community/lively）
- Loomscreen：<https://github.com/Paradox07127/macos-wallpaperengine>

**本项目**
- 仓库：<https://github.com/yu502950715yang/dsh-use-wallpaper>
- npm：<https://www.npmjs.com/package/@dsh-use/wallpaper-engine>

## 附录 B：调研产物与检索式

- 本报告配套调研（已归档到 `docs/competitive-2026-10-19/`）：
  - [dsh-ecosystem.md](./competitive-2026-10-19/dsh-ecosystem.md)：DSH 插件竞品、elysia 深挖、功能矩阵、差距清单
  - [renderers.md](./competitive-2026-10-19/renderers.md)：第三方 WE 渲染器能力矩阵、许可证、逐项依据
  - [we-product.md](./competitive-2026-10-19/we-product.md)：WE 官方能力、成熟产品基线、缺口 checklist
- 本地原始抓取（`research/` 为 gitignore，不入库）：`research/competitive-2026-10-19/raw/`（elysia README/HOW-IT-WORKS/CHANGELOG/package.json 快照、WebWallGL README、仓库元数据）
- GitHub 检索式与结果数（2026-10-19 快照，`sort=stars`）：`wallpaper engine dsh` 52；`wallpaper+dsh` 277；`dsh-plugin+wallpaper` 162；`topic:dsh-plugin+wallpaper` 150；`wallpaper engine scene renderer` 13；`wallpaper engine linux` 167。
- 说明：本报告与三份调研文件均为只读调研，未改动仓库源码、未跑构建/测试、未做 git 操作。
