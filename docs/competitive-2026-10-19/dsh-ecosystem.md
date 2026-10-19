# DSH 插件生态壁纸竞品调研（2026-10-19）

> **范围**：DSH（DeepSeek Harness）生态中「壁纸 / 背景 / 换肤」类插件，重点深挖直接竞品 [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)，并与本项目 [`@dsh-use/wallpaper-engine`（yu502950715yang/dsh-use-wallpaper，5★）](https://github.com/yu502950715yang/dsh-use-wallpaper) 对照。
> **数据快照**：2026-10-19 10:50–11:20（UTC+8）。stars / forks / pushed_at 均为该时刻采样，之后会变。
> **口径**：`✓` = 官方 README/文档明确支持；`△` = 部分支持 / 需额外安装 / 仅有预览图等降级形态；`✗` = 明确不支持或未实现；`未核实` = 本次未找到证据，不臆测。所有数字均来自 GitHub API / raw 文件，未编造。
> **限流**：GitHub REST 未认证（core 60 次/时、search 10 次/分），本次请求按批量合并、失败即降级处理；原始数据抓取命令见 §8。

---

## 0. TL;DR（给决策者的 7 条）

1. **事实标准已形成**：[elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine) 截至采样 **1568★ / 62 fork / 35 open issues**，v1.3.3 已发 npm（2026-10-15），最近 push **2026-10-18T16:12:58Z**；从 2026-08-16 建仓到功能齐全只用了约两个月。
2. **它的 scene 渲染不是自己写的**：场景/网页走 **随包 npm 依赖 `webwallgl` ^3.0.0**（上游作者 oneincase 的 MIT 引擎，[oneincase/webwallgl](https://github.com/oneincase/webwallgl)，13★），本仓只保留适配页与降级链；video 交给浏览器 `<video>`；Application 类明确不支持。
3. **生态第二套 scene 渲染路线**是 [XHR666/wallpaper-engine-web-loader（WEwebLoader）](https://github.com/XHR666/wallpaper-engine-web-loader)，**GPL-3.0**、需另行安装；[XHR666/dsh-mpkg-wallpaper](https://github.com/XHR666/dsh-mpkg-wallpaper) 刻意「不内嵌、不 import」以隔离 GPL —— 这是本生态里唯一存在的许可分叉信号。
4. **除 elysia 外，几乎没人真正实时渲染 scene**：其余插件要么图片/视频/换肤（[RevolutionLA/dsh-dream-skin](https://github.com/RevolutionLA/dsh-dream-skin) 253★ 等），要么拿工坊预览图冒充「场景模式」（[nishuoyang/dsh-wallpaper-bg](https://github.com/nishuoyang/dsh-wallpaper-bg)），要么离线提取 scene.pkg 静态图（[AppliedYuu/dsh-WallpaperAndCost](https://github.com/AppliedYuu/dsh-WallpaperAndCost)）。
5. **本项目是少数自研 scene 引擎的插件**（three.js + Rust/WASM，渲染深度已覆盖 puppet / SceneScript / 包内音频 / 效果链，见 `docs/technical-notes.md`），**渲染技术差距不大，差距在产品化面**：壁纸库/上传/隐藏/筛选/搜索/轮播、液态玻璃外观体系、系统音频回环与 Now Playing、ffmpeg 帧率档、三平台、i18n、宿主端设置存储、完整降级链。
6. **赛道非常拥挤**：GitHub 检索 `wallpaper+dsh` **277** 仓、`dsh-plugin+wallpaper` **162** 仓、`topic:dsh-plugin+wallpaper` **150** 仓（检索式与结果数见 §8.1）——「壁纸/换肤」是 DSH 插件最卷的品类之一，但头部集中度极高（elysia 一家 1568★，第二名 253★）。
7. **竞争焦点已从「能不能渲染 scene」转向**：是否**免装 Wallpaper Engine**、三平台、外观一体化（玻璃/字体/预设）、音频联动、性能与稳定性、以及分发（npm / 插件市场 / 社区）。elysia 的护城河是**产品完整度 + 分发势能**，不是独门渲染算法。

---

## 1. 方法与可复现性

### 1.1 数据来源
| 来源 | 用途 | 备注 |
|---|---|---|
| `api.github.com/repos/<owner>/<repo>` | stars / forks / pushed_at / license / default_branch | 未认证，批量串行 + 失败跳过 |
| `api.github.com/repos/.../git/trees/<branch>?recursive=1` | elysia 全仓目录结构（383 项，未截断） | 一次请求拿全树，避免 clone |
| `raw.githubusercontent.com` | README / CHANGELOG / HOW-IT-WORKS / ADR / package.json | 不计 API 配额，优先使用 |
| `api.github.com/.../releases?per_page=100` | elysia 11 条 release 记录与正文 | 只取标签/日期/标题/摘要 |
| `api.github.com/.../issues?state=all&per_page=50` | elysia 最近 50 条 issue 标题与标签 | 只作「已知问题」证据 |
| 本仓 `research/competitor/` | elysia **v0.2.2** 旧快照（2026-08-19，只读） | 历史口径对照 |
| 本仓 `research/dsh-wallpaper-engine-v0.7.1/` | elysia **v0.7.1** scene-gl 实现参考（只读） | 本项目 puppet 解析的格式参照，见 `docs/superpowers/plans/2026-10-13-scene-parallax-puppet.md` |

### 1.2 深挖程度说明
- elysia：README（中/英/新手三份）、`docs/CHANGELOG.md`（**2078 行**）、`docs/HOW-IT-WORKS.md`、`docs/CODE-STRUCTURE.md`（摘要）、`docs/UPGRADING.md`、`docs/TROUBLESHOOTING.md`、`docs/adr/0001-webwallgl-in-tree-live-renderer.md`、`package.json`、`cordis.patch.yml`、11 条 release、50 条 issue 标题、全仓目录树。
- 其余插件：README 全文或前 45 行 + 关键字扫描（scene / 视频 / 网页 / 上传 / 轮播 / 隐藏 / 搜索 / 音频 / 取景 / 玻璃 / 多平台 / 存储 / i18n）；**未每个深挖**。
- 所有「未核实」项集中在 §7.4，后续可单独补验。

---

## 2. 深挖：elysia395/dsh-wallpaper-engine（直接竞品）

### 2.1 基本盘（2026-10-19 采样）

| 项 | 值 | 来源 |
|---|---|---|
| 仓库 | [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)（默认分支 `main`，JavaScript） | GitHub API |
| npm 包 / 版本 | [`dsh-plugin-wallpaper-engine`](https://www.npmjs.com/package/dsh-plugin-wallpaper-engine) **1.3.3**（2026-10-15 发布） | package.json + release v1.3.3 |
| Stars / Forks / Open issues | **1568 / 62 / 35** | GitHub API |
| 建仓 / 最近 push | 2026-08-16 / **2026-10-18T16:12:58Z**（持续日更） | GitHub API |
| GitHub Releases | **11 条**（v0.7.1 → v1.3.3，另有 `media-v1` 素材包） | Releases API |
| 运行要求 | Node ≥18；**DSH 内核 ≥0.1.5-rc.1**（`engines.dsh`）；官方桌面端线 ≥2.0.7 | [package.json](https://github.com/elysia395/dsh-wallpaper-engine/blob/main/package.json) |
| 核心依赖 | `webwallgl: ^3.0.0`（场景/网页实时渲染引擎）、`x11: ^4.3.1`（Linux 遮挡判定） | package.json |
| 许可证 | **MIT**（代码）；壁纸/素材版权归原作者与 Wallpaper Engine，插件不重新分发第三方素材 | [README](https://github.com/elysia395/dsh-wallpaper-engine/blob/main/README.md) |
| 安装 | `dsh plugin --profile web add dsh-plugin-wallpaper-engine`（桌面版走应用内插件市场或 `--profile desktop`），装/更新后需重启宿主 | README §安装 |
| 维护与社区 | 作者 elysia395 + 核心贡献者 YV3507 / oneincase（WebWallGL 作者）/ yuxilao（Linux scene-gl）/ Jerry（macOS 早期支持）等；QQ 群 + 抖音群 | README §致谢 |
| 市场/分发 | npm、GitHub Releases、DSH 插件市场；README 内嵌 Shields 徽章（stars/下载量/CI/贡献者）与 Star History | README |

> 对比：本项目（`@dsh-use/wallpaper-engine` v0.7.1）采样时 **5★**，pushed 2026-10-19 02:41，未上大量市场运营。elysia 在**分发与社区势能**上领先约一个数量级。

### 2.2 场景渲染引擎：内嵌 WebWallGL（关键事实）

- **引擎来源**：不是自研，也不是运行时从 CDN 下载，而是**随包 npm 依赖** `webwallgl`（`^3.0.0`），宿主从 `node_modules/webwallgl` 直接供给，`lib/webwallgl/` 只保留本仓适配页（`index.html` + `renderer.js`）与兜底页；升级引擎 = 升依赖版本。见 [ADR-0001](https://github.com/elysia395/dsh-wallpaper-engine/blob/main/docs/adr/0001-webwallgl-in-tree-live-renderer.md) 与 [HOW-IT-WORKS](https://github.com/elysia395/dsh-wallpaper-engine/blob/main/docs/HOW-IT-WORKS.md)。
- **上游引擎**：[oneincase/webwallgl](https://github.com/oneincase/webwallgl)（MIT，13★，最近 push 2026-10-14）。能力：scene.pkg / 松散工程目录、网页、视频三类壁纸；还原图层/效果/粒子/模型/SceneScript/用户属性/音频可视化；附带壁纸播放器与**场景编辑器**（可导出 WE 能加载的 scene.pkg）；npm / CDN（`webwallgl`、`@webwallgl/core`、`@webwallgl/editor`）。elysia 在 v1.2.0 同步过 WebWallGL **2.0.2**，v1.3.0 起支持松散 `scene.json`（v1.3.0 CHANGELOG 称 WebWallGL 2.1.0 原生支持）。
- **渲染页与数据面**：宿主以 `/wallpaper-engine/scene-live/` 为 base 挂载渲染页，壁纸文件经 `/scene-files/` 供给；**场景包与网页入口资源走宿主自建的 loopback 媒体源**（127.0.0.1 随机端口，懒启动），`scene.pkg` 实测见过 **336MB**，带 `ETag(size+mtime)` 条件请求省流量；网页壁纸把 WE API shim（`wallpaperRegisterAudioListener` / `wallpaperPropertyListener` 等）注入入口 HTML，iframe 强制 `sandbox="allow-scripts"`。
- **场景覆盖范围（官方口径）**：对象树重放、纹理、粒子、HLSL 转译后的 shader 效果（waterwaves / waterripple 等）、puppet 骨骼、文本对象、SceneScript 执行、鼠标视差/透视/点击交互、包内音频驱动音频反应。release v0.7.8 自述「**90% 以上的场景效果**都能完整实时呈现」，v1.0.1 称三窗口模式（兼容/增强/扩展）全兼容。**注意这是官方自述，非第三方复测**。
- **有意排除**：Application（应用）类壁纸明确不支持——「它要启动第三方可执行程序，与插件边界冲突」（ADR-0001 D4）。
- **网页壁纸**：复用同一渲染页骨架 + WE API shim；加载失败/失联后自动退回旧兼容 iframe（裸 HTML、无 WE API）。
- **历史路线更替（速度值得警惕）**：本仓 `research/competitor/` 的 **v0.2.2 快照（2026-08-19）** 在 README 里写的是「Scene 壁纸由 WE 自带 3D 引擎渲染，**不能**搬到 DSH」；v0.7.1（2026-09-03）已上 **scene-gl Linux 实时渲染管线**（PR #65）；v0.7.8 全面上线 WebWallGL。**两个月内从「公开说不做」到「90% 覆盖」**，说明其工程执行与上游引擎接入能力很强。

### 2.3 出图/降级链（本项目最值得借鉴的一环）

唯一权威顺序（代码在 `lib/routes/scene-frame.js`，文档在 [HOW-IT-WORKS](https://github.com/elysia395/dsh-wallpaper-engine/blob/main/docs/HOW-IT-WORKS.md)）：

| 顺序 | 出图来源 | 说明 |
|---|---|---|
| ① | 实时渲染 iframe | 默认路径（设置项 `sceneLive`，默认开） |
| ② | 场景**作者内嵌 MP4**（`sceneVideo`） | 用硬件解码 `<video>`；只有真实探测到内嵌 MP4 才给 URL（v0.7.4 修过「静态帧冒充内嵌 MP4」）。本项目 README 中「内嵌 MP4」即此层 |
| ③ | **实时抓帧**（`<token>_gpu.png`） | live 渲染页首帧确认后由客户端回填；带视口宽高比几何校验（偏差 >2% 自动清除重抓）与空帧门禁（近全黑/无对比度判废） |
| ④ | **自定义画面** | 用户导入的截屏，显式 pin 的来源不会被抓帧顶掉 |
| ⑤ | **空态** | 404 + 可判定原因（不猜图） |

- **首帧前不留黑屏**：垫底画面按「实时抓帧 → 作者随包预览图 → 主题色」取（`buildLivePoster`），live 首帧一到即被顶掉。
- **失败记忆与首帧预算**：首帧预算按 `scene.pkg` 包大小现算（`liveFirstFrameBudget()`），并有**载荷账本**（客户端轮询 `scene-payload-progress`，字节还在涨就重置计时）；传输未完 = 会话内软失败、自动重试有上限；只有渲染页真不出帧/失联才落盘「失败记忆」，重新打开开关可清空。
- **隐藏/未播放实例不拉载荷**（延迟赋 `src`、后台 `about:blank`），避免抢带宽与解码器。
- **没有 CPU 兜底出图**：v0.6–0.7 曾用「离线场景渲染器 / 主纹理提取 / 工坊预览图」三级兜底，全部删除（约 1 万行），裁定为「要么给真画面、要么明确留空」，避免把糊帧当成功。

> **对本项目**：我们的回退目前只有「scene 渲染失败 → preview 图 + Ken Burns」一级。elysia 这条 5 级链 + 失败记忆 + 抓帧几何校验，是低成本高感知的稳定性资产。

### 2.4 功能清单（按任务要求的维度）

#### 支持的壁纸类型
| 类型 | elysia 支持情况 | 证据 |
|---|---|---|
| Scene（场景） | **✓ 支持**，随包 WebWallGL 实时 WebGL 渲染，失败走 §2.3 降级链；不需要 WE 在后台运行 | README |
| Web（网页） | **✓ 支持**，严格沙箱 + WE API 注入；效果取决于网页/浏览器 | README、HOW-IT-WORKS |
| Video（视频） | **✓ 支持**，浏览器播放 + 转码/帧率上限/暂停控制 | README |
| Application（应用） | **✗ 明确不支持**，不进壁纸库与轮播候选 | README、ADR-0001 |
| 自定义图片 / 视频 | **✓ 上传本地 JPG / PNG / MP4**，可选存储位置与适配模式 | README |

#### UI（液态玻璃 / 壁纸库 / 隐藏 / 上传 / 裁剪取景 / 轮播）
- **设置页六个页签**：「壁纸库 / 外观 / 播放 / 系统 / 扩展 / 关于」；「选择壁纸」是**页内库视图**（非独立弹窗，v1.2.0 起改成嵌入官方侧边栏 + 侧栏快捷面板）。
- **液态玻璃**：设置窗口、对话区、侧边栏、浮层均可玻璃化；颜色/透明度/雾化/边框/左右侧栏独立参数；出厂 **7 套预设** + 用户自定义预设（最多 8 套）导入导出；第三方插件面板可用 CSS 选择器补毛玻璃（最多 8 条）。设置窗口玻璃当前**恒开**，无恢复原生纯色的总开关。
- **壁纸库**：内容分级（全部/全年龄/PG13/成人/未分级）与类型筛选、**搜索框**（v1.3.0-r2 起，300px 封顶）、隐藏/恢复（软删除，支持批量，不删源文件）、虚拟滚动（大库不卡）、分页已退役改虚拟窗口。
- **上传**：本地 JPG/PNG/MP4，存 `~/.dsh-wallpaper-engine/uploads/`，可改任意盘符并自动迁移；MP4 按需生成缩略图。
- **裁剪/取景**：无「上传后裁剪」的图片编辑器；提供画面取景（水平/垂直/缩放 + 直接数值）、自适应模式（覆盖/填充/居中/拉伸）、倍速 0.5–2x、水平翻转。
- **轮播**：播放列表、间隔 1–10 分钟、顺序/随机、**准备完成后才切换**、失败候选自动跳过；7 种切换过场（交叉淡化/推移/擦除/光圈/缩放/条带/百叶窗），系统「减少动态效果」时硬切。
- **壁纸属性面板**：读取 WE 作者定义的属性（颜色/开关/滑块），按壁纸保存，可恢复默认；侧栏也有入口。
- **其他外观**：字体自定义（角色/组件字号字重字体族、系统字体枚举、字体集导入导出）、输入光标颜色、主题随壁纸（默认关）、10 只内置吉祥物 3D 转盘 + 自定义立绘、会话头像、点击/拖尾特效、3D 视差、拉绳抽屉。

#### 音频
- **场景包内音频**（v0.7.5）：无内嵌视频的场景可播放包内 BGM/音效，效果页签有「声音」分区（音量滑块 + 总开关），**默认静音**；与内嵌 MP4 音轨互斥不双声道。
- **系统音频反应（音乐频谱律动）**：Windows 走系统音频回环（WASAPI + GSMTC），**不需要 Stereo Mix/虚拟声卡**；macOS MediaRemote、Linux MPRIS；中间件 [media-bridge](https://github.com/oneincase/media-bridge) 按需下载并用 SHA-256 校验，不可用回退内置实现。
- **Now Playing**：歌名、歌手、专辑、封面、播放进度，支持这些 WE API 的壁纸可显示。
- **在线歌词**：默认关闭；开启后本地歌词不可用时才向 [LRCLIB](https://lrclib.net) 查询（会外发歌名/歌手/专辑）。

#### 性能
- **帧率上限**：15 / 30 / 60 fps（实时渲染帧率经 iframe query 下发，改档重建图层）；视频用 **ffmpeg 抽帧转码**做上限（优先 NVENC→libx264，按「路径+mtime+上限」缓存）；ffmpeg 三档供给：显式指定 → 自动下载（npmmirror + GitHub 双源）→ 系统 PATH；拿不到 ffmpeg 时视频仍按原片播放。
- **遮挡暂停**：最小化/切页、窗口失焦、电池供电三档自动暂停；判定不只看事件，另有 3s 低频复核（防原生 confirm 导致 focus 丢失后永久停住）；实时渲染与视频解码都停。
- **其他**：隐藏/未播放实例不拉载荷；loopback 媒体源 + ETag；Edge 视频改 canvas 渲染规避浏览器悬浮工具栏（v0.4.0）；场景包大文件 304 缓存；「实时帧」面板可微缩预览/重抓/清除 GPU 帧。
- **已知性能问题**：issue [#248](https://github.com/elysia395/dsh-wallpaper-engine/issues/248)（大型 dsh-context 页面下 Scene 60fps + 液态玻璃导致 DSH 卡约 10s、全局动画低帧，禁用壁纸后恢复）；[#240](https://github.com/elysia395/dsh-wallpaper-engine/issues/240)（8K 自定义图片无缩略图管线，卡片直接加载 43MP 原图 ×24 张/页卡死）。

#### 多平台
- **同一个 npm 包支持 Windows / macOS / Linux**（npm 徽章与 README 均声明；`x11` 依赖用于 Linux 遮挡）。
- 系统媒体链路分别走 **Windows GSMTC / macOS MediaRemote / Linux MPRIS**；Linux WSL 下自动探测 `/mnt/<盘符>` Steam 库（v0.4.1）。
- **macOS 没有 WE 客户端**：通过自定义上传，或把「自定义壁纸存储位置」指向含 `project.json` 的 WE 项目目录，按类型收录（只读，不参与删除）。
- 官方口径提醒：「三平台可安装 ≠ WE 官方三平台可用」。

#### 设置存储
- 全部设置存**宿主端** `~/.dsh-wallpaper-engine/config.json`，不依赖浏览器端口；重启、换端口（含桌面端随机端口）、清浏览器数据都不丢；旧 localStorage 配置自动迁移（v0.4.0）。
- 数据目录：设置/插件数据 `~/.dsh-wallpaper-engine/`、缓存 `cache/`、上传 `uploads/`，均可经面板或环境变量（`DSH_WE_DATA_DIR` / `DSH_WE_CACHE_DIR` / `DSH_WE_UPLOAD_DIR`）改到其它盘并自动迁移；另有 `DSH_WE_STEAM_ROOT` / `DSH_WE_ASSETS_DIR` / `DSH_WE_FFMPEG*` / `DSH_WE_MEDIA_BRIDGE*` 等十余个环境变量。环境变量优先于面板设置。

#### zero-token / i18n / 其他
- **zero-token**：「不向 agent 注册工具或注入提示文本，**不增加模型 token 开销**」（README 原文）。
- **i18n**：界面接进宿主 `locale` 服务，**跟随 DSH 语言设置**（内置 zh/en，`addLanguage` 追加的语言包也跟随），切换即时生效（v1.2.0 记录）。
- **DSH 版本兼容**：`engines.dsh >=0.1.5-rc.1`；历史适配点见 §2.5；issue [#225](https://github.com/elysia395/dsh-wallpaper-engine/issues/225) 记录 DSH NEXT ≤2.0.17 的实时渲染失败（载荷传输未完成），升级 2.0.18-next 解决。
- **已知限制（README 明列）**：Application 不支持；场景渲染依赖 WebGL/显卡驱动，复杂工坊项目可能有差异；ffmpeg 不可得时无转码/帧率上限；桌面壳最小化/还原可能短白帧；`dsh-better-sidebar` 可选非必装；与其他皮肤同装需看共存说明；浏览器不支持 `backdrop-filter` 时玻璃回退实色。

### 2.5 版本演进时间线（据 [docs/CHANGELOG.md](https://github.com/elysia395/dsh-wallpaper-engine/blob/main/docs/CHANGELOG.md) 与 Releases）

| 版本 / 日期 | 里程碑 |
|---|---|
| v0.2（2026-08 上旬） | 壁纸选择弹窗、隐藏/恢复、视频倍速、水平翻转、自定义上传 |
| v0.3.x（2026-08 中旬） | 液态玻璃设置页 → 整个设置窗口玻璃化；玻璃参数统一；配色/玻璃颜色 |
| v0.4.0 / v0.4.1 | 设置持久化到宿主端 `config.json`；Edge 视频改 canvas；媒体句柄修复 + 异步扫描；WSL 支持 |
| v0.5.x | 遮挡暂停三档；ffmpeg 帧率上限转码（4K120→24fps，GPU 解码占用 ~60%→~15%） |
| v0.6.0 / v0.6.3–v0.6.8 | 纯 JS 场景渲染器完整重放（对象树/纹理/粒子/shader）；吉祥物拉绳 + 亮度/对比度/饱和度；稳定性修复 |
| **v0.7.1（2026-09-03）** | **scene-gl Linux 实时渲染管线**（PR #65）；木偶骨骼/粒子/脚本沙箱（默认关）；首个 GitHub Release |
| v0.7.2–v0.7.4 | 适配 DSH 0.1.5-rc.1；侧栏玻璃；场景静态帧修复；puppet 图集过滤；壁纸属性面板 |
| v0.7.5（2026-09-21） | 场景包内音频；透明度不再破坏玻璃模糊 |
| **v0.7.8（含在 v1.0.1）** | **接入 WebWallGL 实时渲染，90%+ 场景效果；鼠标视差/透视；粒子/水波纹/点击交互；系统音频频谱 + Now Playing；15/30/60 fps；dsh-desktop 2.0.14 适配** |
| **v1.0.1（2026-09-25）** | 里程碑：场景实时渲染全面上线；兼容/增强/扩展三窗口模式全兼容 |
| v1.1.0（2026-09-29） | 字体自定义系统；主题随壁纸；7 种换场动画；**界面多语言跟随 DSH locale** |
| v1.2.0（2026-10-02） | 全新侧栏 UI（三页签 + 壁纸属性）；玻璃配色可自定义；同步 WebWallGL 2.0.2；与 web-all 皮肤共存 |
| v1.3.0（2026-10-06） | 玻璃全面自定义（每个玻璃面独立配置 + 7 套预设快照）；自定义吉祥物与会话头像；与 web-all 共存让路逻辑 |
| v1.3.1 / v1.3.2（2026-10-06/12） | 侧栏刷新键；10 只吉祥物 3D 转盘；整机预设快照；侧栏圆角；缓存路径可搬离 C 盘 |
| **v1.3.3（2026-10-15）** | 公告外观提示；回退侧栏求星按钮；纯客户端改版 |

> ADR-0001 日期 2026-09-30，明确记录「离线静态帧路线整体移除」、改为内嵌 WebWallGL 实时渲染。**即：其 scene 渲染只有约 1 个月历史，但迭代极快。**

### 2.6 已知问题（代表性问题，取自最近 50 条 issue 标题）

| # | 标题（节选） | 状态 | 启示 |
|---|---|---|---|
| [#248](https://github.com/elysia395/dsh-wallpaper-engine/issues/248) | 大型 dsh-context 页面下 Scene 60fps + 液态玻璃导致 DSH 卡约 10s | open | 玻璃 + 实时渲染叠加有性能上限 |
| [#241](https://github.com/elysia395/dsh-wallpaper-engine/issues/241) | 壁纸插件导致 DSH 桌面端自动更新失败（Host 无法优雅退出） | open | headless/生命周期耦合风险 |
| [#240](https://github.com/elysia395/dsh-wallpaper-engine/issues/240) | 8K 自定义图片无缩略图管线，卡片直接加载原图卡死 | open | 大图资源治理 |
| [#235](https://github.com/elysia395/dsh-wallpaper-engine/issues/235) | 标题栏液态玻璃开关整块失效：宿主 CSS-module 哈希漂移（守卫因棘轮盲区恒绿） | open | 深度改写宿主 DOM 的回归风险 |
| [#237](https://github.com/elysia395/dsh-wallpaper-engine/issues/237) / [#236](https://github.com/elysia395/dsh-wallpaper-engine/issues/236) | 侧栏 1px 描边、标题栏玻璃盖住收起按钮 | open | 玻璃适配的像素级长尾 |
| [#232](https://github.com/elysia395/dsh-wallpaper-engine/issues/232) / [#231](https://github.com/elysia395/dsh-wallpaper-engine/issues/231) | 上传头像 ReferenceError、AI 会话头像被隐藏 | open | 扩展功能引入的新失败面 |
| [#230](https://github.com/elysia395/dsh-wallpaper-engine/issues/230) / [#247](https://github.com/elysia395/dsh-wallpaper-engine/issues/247) | 自动轮播无法调整时间 | open/closed | 轮播控制仍在打磨 |
| [#225](https://github.com/elysia395/dsh-wallpaper-engine/issues/225) | DSH NEXT ≤2.0.17 实时渲染失败「载荷传输未完成」，2.0.18-next 解决 | closed | 上游版本兼容敏感 |

> 结论：elysia 的**功能宽度伴随明显回归面**，大量 issue 集中在「对宿主 DOM/样式/CSS-module 哈希的深度改造」（玻璃、侧栏、标题栏）与「扩展功能（头像/吉祥物/轮播）」——这是它产品路线的固有代价，也给了我们「轻量、不碰宿主 DOM」的差异空间。

---

## 3. 横向对比

### 3.1 场景/渲染路线对比

| 插件（★ / 最近 push） | scene 实时渲染 | 视频 | Web 壁纸 | 图片来源 | 音频联动 | 多平台 | 许可 |
|---|---|---|---|---|---|---|---|
| [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)（1568★ / 10-18） | **✓ 内嵌 WebWallGL**（npm `webwallgl` ^3.0.0）+ 5 级降级链 | ✓ | ✓ | 上传 JPG/PNG/MP4 + WE 库 | ✓ 包内音频 + 系统回环频谱 + Now Playing | ✓ Win/mac/Linux | MIT |
| **本项目**（5★ / 10-19） | **✓ 自研 three.js + Rust/WASM**（粒子/效果链/puppet/SceneScript/音频），失败回退 preview | ✓ | ✓（沙箱） | WE 库（需本机装 WE 读素材） | ✓ 包内 sound + 频谱（无系统回环） | ✗ 仅 Windows 实测 | MIT |
| [XHR666/dsh-mpkg-wallpaper](https://github.com/XHR666/dsh-mpkg-wallpaper)（10★ / 10-13） | **△ 需另装 GPL 渲染器**（WEwebLoader），本包不内嵌 | ✓ | ✓ | WE `.mpkg`/工坊 + 本地库 | ✓ Now Playing 控件 | ✓ 三平台 | MIT |
| [XHR666/wallpaper-engine-web-loader](https://github.com/XHR666/wallpaper-engine-web-loader)（1★ / 10-16） | **✓ WEwebLoader 渲染器本体**（scene.pkg/.mpkg/workshop 目录，WebGL2） | ✓ | ✓ | 源目录 | 未核实 | 浏览器/Node 静态服务 | **GPL-3.0** |
| [nishuoyang/dsh-wallpaper-bg](https://github.com/nishuoyang/dsh-wallpaper-bg)（7★ / 10-17） | **△ 场景模式 = 工坊预览图**（preview.gif/jpg），明确「零本地渲染、零缓存」 | ✓ | ✓（原生 iframe） | 10 张内置 Unsplash + 上传（IndexedDB）+ WE 库（只读，配套 API 插件） | ✗ | 未核实 | MIT |
| [YRN-playmaker/dsh-wallpaper_share](https://github.com/YRN-playmaker/dsh-wallpaper_share)（32★ / 10-18） | **△ 同步 WE「当前壁纸」**，需本机 WE 运行（渲染模式/窗口跟随）；具体是否真实时渲染 scene 未核实 | ✓ | △ | WE 状态同步 | 未核实 | 未核实（含多显示器） | GPL-3.0 |
| [kdzhang-hub/dsh-wallpaper](https://github.com/kdzhang-hub/dsh-wallpaper)（4★ / 08-18） | 未核实（README 明示 npm 包不含 WE 工程/预览/视频/scene.pkg） | 未核实 | 未核实 | WE 集成 + Windows 桌面定制 | 未核实 | ✗ | Apache-2.0 |
| [AppliedYuu/dsh-WallpaperAndCost](https://github.com/AppliedYuu/dsh-WallpaperAndCost)（3★ / 10-17） | **△ 离线提取**：`scripts/extract_scene_pkg.py` 解析 scene.pkg/.tex（LZ4、DXT→PNG）出静态图 | ✓ | ✗ | 工坊目录静态提取 + 上传 | ✗ | 未核实 | 未核实 |
| [Y1X1n/we-for-vscode](https://github.com/Y1X1n/we-for-vscode)（4★ / 10-09，VS Code 同类形态） | **✓ 实时渲染（WebGL）**，scene.pkg 或散装 scene.json | ✓ | ✓ | WE 库 + 上传 | 未核实 | 未核实 | NOASSERTION |
| [oneincase/webwallgl](https://github.com/oneincase/webwallgl)（13★ / 10-14，**引擎**非插件） | **✓ 渲染核心本身**（scene/web/video + 场景编辑器） | ✓ | ✓ | 任意来源（httpSource 等） | ✓ 音频可视化 | 浏览器 | MIT |

### 3.2 产品化功能对比（DSH 插件）

| 插件 | 图片上传 | 轮播 | 隐藏 | 搜索/筛选 | 裁剪/取景 | 液态玻璃 | i18n | 设置存储 | zero-token |
|---|---|---|---|---|---|---|---|---|---|
| elysia395/dsh-wallpaper-engine | ✓ | ✓ | ✓ | ✓（分级/类型 + 搜索框） | △ 取景/适配模式（无图片裁剪） | ✓ 全套 | ✓ | 宿主端 config.json | ✓ |
| **本项目** | ✗ | ✗ | ✗ | ✗（缩略图网格 + 基础设置字段） | ✗ | △ 输入框半透明玻璃底 | ✗ | profile `cordis.patch.yml` + 面板字段 | 未核实（不注册工具，但未见明文承诺） |
| XHR666/dsh-mpkg-wallpaper | ✓ | ✓ | ✓ | 未核实（README 未见搜索） | ✓ | ✓ | ✓ | 未核实（README 提到本地库） | 未核实 |
| [nishuoyang/dsh-wallpaper-bg](https://github.com/nishuoyang/dsh-wallpaper-bg) | ✓（IndexedDB） | ✓（播放队列 1–10 分钟/张） | ✗ | 未核实 | ✓（亮度/模糊/安全缩放等四项） | △ 毛玻璃 | 未核实 | 未核实 | 未核实 |
| [RevolutionLA/dsh-dream-skin](https://github.com/RevolutionLA/dsh-dream-skin)（253★） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓（token 体系） | ✓（8 语 README） | ✓ | 未核实 |
| [SLin-code/dsh-custom-skin](https://github.com/SLin-code/dsh-custom-skin)（101★） | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ | 未核实 |
| [starsstreaming/beautiCode](https://github.com/starsstreaming/beautiCode)（91★） | ✓ | ✗ | ✗ | ✓（皮肤中心） | ✗ | ✗ | ✓ | 未核实 | 未核实 |
| [yoli-mi/dsh-client-ui-custom](https://github.com/yoli-mi/dsh-client-ui-custom)（39★） | ✗ | ✗ | ✗ | ✗ | ✓（缩放） | ✓ | ✓ | 未核实 | 未核实 |
| [YRN-playmaker/dsh-wallpaper_share](https://github.com/YRN-playmaker/dsh-wallpaper_share)（32★） | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | 未核实 | 未核实 |
| [sz1698/dsh-bg-new](https://github.com/sz1698/dsh-bg-new)（20★） | ✓ | ✗ | ✗ | ✗ | ✓（滚轮+拖动缩放定位） | ✓ | ✗ | 未核实 | 未核实 |
| [KinGao294/dsh-skin](https://github.com/KinGao294/dsh-skin)（17★） | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ | ✗ | ✓（按浏览器持久化） | 未核实 |
| [sakuraaa667/dsh-wallpaper-engine](https://github.com/sakuraaa667/dsh-wallpaper-engine)（13★） | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ | 未核实 | 未核实 |
| [li8476295-bot/dsh-plugin-wallpaper-engine](https://github.com/li8476295-bot/dsh-plugin-wallpaper-engine)（5★） | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | 未核实 |
| [TianYa-DAO/dsh-wallpaper-engine](https://github.com/TianYa-DAO/dsh-wallpaper-engine)（6★） | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | 未核实 | 未核实 |

> 说明：表格基于 README 关键词扫描 + 人工复核，`✓/✗` 只代表「README 是否明确」，不代表代码质量；部分项目 README 很薄（如 li8476295、TianYa-DAO），能力可能被低估，深挖价值低。

### 3.3 长尾清单（其余 DSH 壁纸/换肤类仓库，采样自 GitHub 搜索，stars 排序）

| 仓库 | ★ / 最近 push | 一句话（来自 GitHub description/README） |
|---|---|---|
| [RevolutionLA/dsh-dream-skin](https://github.com/RevolutionLA/dsh-dream-skin) | 253 / 10-18 | DSH 换肤/壁纸/主题包，8 套 Mirage 主题、每用户强调色、壁纸 2.0、主题包导入导出/分享、收藏随机；纯 `--dsw-*` token 实现，不改安装包 |
| [SLin-code/dsh-custom-skin](https://github.com/SLin-code/dsh-custom-skin) | 101 / 09-17 | 自定义壁纸 + 半透明皮肤（TypeScript） |
| [starsstreaming/beautiCode](https://github.com/starsstreaming/beautiCode) | 91 / 10-12 | 多客户端动态皮肤工具（DSH 插件 + Codex/Cursor/豆包等注入），皮肤中心 + 本地图片/视频导入，Windows（部分 macOS） |
| [yoli-mi/dsh-client-ui-custom](https://github.com/yoli-mi/dsh-client-ui-custom) | 39 / 09-28 | 可配置 DSH web 表面：壁纸 + 磨砂主题、强调色、快捷键、应用使用面板等，零 shell 修改 |
| [YRN-playmaker/dsh-wallpaper_share](https://github.com/YRN-playmaker/dsh-wallpaper_share) | 32 / 10-18 | 把 WE 当前壁纸同步为 DSH 背景（读 WE 状态、渲染模式/窗口跟随、眼动追踪、多显示器、专注模式） |
| [dhicoc/dsh-theme-mineradio](https://github.com/dhicoc/dsh-theme-mineradio) | 20 / 10-13 | 电影感视觉电台玻璃主题（mineradio 香槟玻璃移植） |
| [Qian-Ning/prompt-skill-armory](https://github.com/Qian-Ning/prompt-skill-armory) | 20 / 09-12 | 提示词/技能/MCP 工具 + 壁纸管理 |
| [sz1698/dsh-bg-new](https://github.com/sz1698/dsh-bg-new) | 20 / 09-11 | 侧栏「壁纸」抽屉：系统预设/纯色/渐变/图片/视频，滚轮+拖动缩放定位，毛玻璃，本地媒体伺服 |
| [KinGao294/dsh-skin](https://github.com/KinGao294/dsh-skin) | 17 / 08-18 | 皮肤切换 + 自定义壁纸，`--dsw-alias-*` 调色板，透明度/模糊，按浏览器持久化 |
| [xingyingyuzhui/dsh-liquid-glass](https://github.com/xingyingyuzhui/dsh-liquid-glass) | 14 / 08-15 | 壁纸 + 可选液态玻璃覆盖 |
| [Ayase34/wallpaper-plugin](https://github.com/Ayase34/wallpaper-plugin) | 14 / 10-17 | DSH 壁纸管理插件 |
| [LeeRolling/dsh-chat-wallpaper](https://github.com/LeeRolling/dsh-chat-wallpaper) | 13 / 10-17 | 开场视频 + 聊天底图 |
| [sakuraaa667/dsh-wallpaper-engine](https://github.com/sakuraaa667/dsh-wallpaper-engine) | 13 / 08-18 | 把 wallpaper 接入 DSH，可设置动态壁纸（视频/玻璃；无真实 scene） |
| [LeoEthanZ/dsh-beyond-glass](https://github.com/LeoEthanZ/dsh-beyond-glass) | 12 / 09-23 | 三栏玻璃 UI（安装包形态，非 fork） |
| [XHR666/dsh-mpkg-wallpaper](https://github.com/XHR666/dsh-mpkg-wallpaper) | 10 / 10-13 | WE `.mpkg` 解析 + 工坊目录 + 视频/网页/图片 + 多时段切换 + 整屏虚化 + 主题色/玻璃 + 轮换 + Now Playing；场景需另装 GPL 渲染器 |
| [Rainpomelo/dsh-liquid-glass-theme](https://github.com/Rainpomelo/dsh-liquid-glass-theme) | 8 / 10-17 | 液态玻璃主题（WebGL 物理透镜 + 动态壁纸 + 多层毛玻璃） |
| [codeMonkey-Pine/dsh-wallpaper](https://github.com/codeMonkey-Pine/dsh-wallpaper) | 7 / 08-20 | WE 壁纸联动插件 |
| [1622352030/dsh-anime-wallpaper](https://github.com/1622352030/dsh-anime-wallpaper) | 7 / 10-16 | DSH 自定义皮肤壁纸插件 |
| [nishuoyang/dsh-wallpaper-bg](https://github.com/nishuoyang/dsh-wallpaper-bg) | 7 / 10-17 | 三种来源（内置/上传/WE 库只读）+ 图片/视频/场景预览图/网页 iframe + 播放队列 + 亮度/模糊/安全缩放 |
| [SamizuHM/dsh-client-ui-theme-xp](https://github.com/SamizuHM/dsh-client-ui-theme-xp) | 7 / 08-16 | Windows XP Luna 桌面主题 + Bliss 壁纸 |
| [liceses/dsh-wallpaper-rotator](https://github.com/liceses/dsh-wallpaper-rotator) | 6 / 10-07 | 壁纸定时轮换（交叉淡化）+ 内置壁纸集 + 毛玻璃/压暗/文字阴影 |
| [Ddamage/dsh-shunshun-wallpaper](https://github.com/Ddamage/dsh-shunshun-wallpaper) | 6 / 08-27 | 壁纸插件（描述为空） |
| [lssyd20070106/dsh-ui-preset-enhance](https://github.com/lssyd20070106/dsh-ui-preset-enhance) | 6 / 08-14 | 第三方 DSH UI 增强：自定义背景/主题色/提示预设/token 可见性 |
| [TianYa-DAO/dsh-wallpaper-engine](https://github.com/TianYa-DAO/dsh-wallpaper-engine) | 6 / 08-19 | 描述不可读（「deepseek-和人生是、」），功能未核实 |
| [li8476295-bot/dsh-plugin-wallpaper-engine](https://github.com/li8476295-bot/dsh-plugin-wallpaper-engine) | 5 / 08-20 | 描述为空；README 薄，视频壁纸 + 轮播 + 隐藏 |
| [Frog755/dsh-wallpaper](https://github.com/Frog755/dsh-wallpaper) | 1 / 08-26 | 持久壁纸（透明度/模糊/固定 web origin）；README 提到视频 1080p/30fps 上限、音频被移除 |
| [kdzhang-hub/dsh-wallpaper](https://github.com/kdzhang-hub/dsh-wallpaper) | 4 / 08-18 | WE 集成 + Windows 桌面定制；npm 包不含 WE 工程/预览/视频/scene.pkg |
| [AppliedYuu/dsh-WallpaperAndCost](https://github.com/AppliedYuu/dsh-WallpaperAndCost) | 3 / 10-17 | 费用查看 + 背景；含 scene.pkg/.tex 离线提取脚本（静态图） |
| [RexCue/dsh-wallpaper](https://github.com/RexCue/dsh-wallpaper) | 4 / 08-14 | 图片背景 + 透明度/遮罩/模糊控制 |
| [Y1X1n/we-for-vscode](https://github.com/Y1X1n/we-for-vscode) | 4 / 10-09 | VS Code 同类形态：液态玻璃壁纸面板 + 整窗背景，实时 Scene/Web 渲染（WebGL） |
| [deepseek-harness-plugins-1121/dsh-wallhaven-wallpaper](https://github.com/deepseek-harness-plugins-1121/dsh-wallhaven-wallpaper) | 1 / 09-28 | 从 wallhaven.cc 搜图铺背景，宿主端取图（支持代理），零运行时依赖（原 HaydenSmith1121 仓库已转移） |
| [laoye666-6/dsh-plugin-media-wallpaper](https://github.com/laoye666-6/dsh-plugin-media-wallpaper) | 1 / 10-05 | 图片/视频/GIF/APNG/WebP/PNG/JPEG/MP4/WebM 背景，压暗/亮度/模糊/色调跟随/逐组件透明，纯客户端 |
| [MilkySnowWay123/dsh-client-ui-skin-tianlight](https://github.com/MilkySnowWay123/dsh-client-ui-skin-tianlight) | 1 / 10-18 | 天光皮肤：4K 视频/图片壁纸、本地上传与轮播、**可选 WebWallGL 场景**、液态玻璃、薄荷猫桌面伙伴 |
| [oneincase/webwallgl](https://github.com/oneincase/webwallgl) | 13 / 10-14 | **上游渲染引擎**（非 DSH 插件）：浏览器端 WE 壁纸渲染核心，scene/web/video + 场景编辑器，npm/CDN，MIT |

> 生态观察：**长尾极长、头部极尖**。150+ 相关仓库里绝大多数是「图片/视频背景 + 毛玻璃 + token 换肤」，真正碰 scene 实时渲染的只有 elysia、XHR666 两条线、Y1X1n（VS Code）与本项目。分发市场（awesome-dsh-plugin.com 徽章、dsh-plugin.org、DWP 市场）已形成，上架/运营本身是竞争力。

---

## 4. 「elysia 有而本项目没有」差距清单（按建议优先级）

> 本项目现状依据：本仓 `README.md`、`package.json`、`docs/technical-notes.md`、`docs/technical-notes.md §7`（2026-10-19 只读核对）。本项目已实现的能力（粒子/效果链/puppet/SceneScript/包内音频/text 脚本/视频纹理）**不列入差距**。

| # | 能力 | elysia 证据 | 本项目现状 | 用户影响 | 优先级 |
|---|---|---|---|---|---|
| 1 | **免装 Wallpaper Engine 的场景路径** | README 明确「不需要 WE 在后台运行」；macOS/Linux 无 WE 客户端也能用项目目录/上传；`DSH_WE_ASSETS_DIR` 可覆盖 WE 官方资源路径（**是否强依赖 WE 安装未核实**） | README 明确「需要本机装有 Wallpaper Engine：插件要从中读取内置粒子与特效素材；没装/路径没配对时粒子退化为纯色圆点」 | 直接决定「下载即用」门槛，是最大转化漏斗 | **P0** |
| 2 | **多级出图降级链 + 失败记忆/首帧预算/抓帧几何校验** | 实时 → 作者内嵌 MP4 → GPU 抓帧 → 自定义画面 → 空态；失败记忆、载荷账本、空帧门禁 | 仅「scene 失败 → preview 图 + Ken Burns」一级 | 稳定性/“永不白屏”承诺强度 | **P0** |
| 3 | **壁纸库产品化**：内容分级/类型筛选、搜索、隐藏/恢复、虚拟滚动 | README §壁纸库与自动轮播 | 仅缩略图网格 + 刷新/探测/保存目录，无筛选/搜索/隐藏 | 库大了不可用（几百张工坊壁纸是常态） | **P1** |
| 4 | **自定义上传（JPG/PNG/MP4）+ 上传目录可迁移** | 上传路由 + 存储位置切换 + 自动迁移 + MP4 缩略图 | 无上传，只能用 WE 库 | 无 WE 或想用自制图时完全不可用 | **P1** |
| 5 | **自动轮播 + 7 种切换过场 + 就绪后切换** | 播放列表/间隔/顺序随机/失败跳过/减少动态效果降级 | 无 | 日常使用高频需求 | **P1** |
| 6 | **液态玻璃外观体系 + 字体系统 + 主题随壁纸 + 外观预设分享** | 六个玻璃面独立配置、7 套出厂预设、字体集导入导出、作者配色取色、10 只吉祥物 | 仅输入框半透明玻璃底 + 光晕/模糊字段 | 审美差异化与「一键好看」传播力 | **P1（取决于产品定位）** |
| 7 | **系统音频回环频谱 + Now Playing + 在线歌词** | WASAPI/GSMTC、MediaRemote、MPRIS；media-bridge 按需下载 + SHA256；LRCLIB 默认关 | 仅壁纸包内 `sound` 播放 + 频谱驱动效果；无系统音频/Now Playing；visualizer 文本条未做（本仓文档自述） | 音乐类壁纸的完整体验；也是「壁纸与界面融合」卖点 | **P2** |
| 8 | **视频性能档：ffmpeg 转码帧率上限（15/30/60）** | 按需下载 ffmpeg（镜像双源）+ NVENC/libx264 + 缓存 | 无转码/帧率上限；仅 qualityScale（渲染像素比）与 paused | 4K120 视频的 GPU 占用与发热 | **P2** |
| 9 | **遮挡暂停三档 + 3s 复核 + 电池供电暂停** | 最小化/失焦/电池，事件之外低频复核 | 有 `paused` / `pauseOnHidden`（仅页面隐藏） | 笔记本续航与后台 CPU | **P2** |
| 10 | **Windows/macOS/Linux 同包三平台** | Windows/macOS/Linux + 各平台媒体链 + WSL Steam 探测 | README 明示「仅 Windows 实测，macOS 未测试」 | 市场覆盖天花板 | **P2（战略项）** |
| 11 | **宿主端设置存储工程化** | `~/.dsh-wallpaper-engine/config.json` + 十余个环境变量 + 数据/缓存/上传目录可迁移 + localStorage 迁移 | profile `cordis.patch.yml` + 面板字段（DSH 版本双路径适配已做） | 换端口/重启/清浏览器数据不丢设置；运维友好 | **P1** |
| 12 | **i18n 跟随 DSH 语言** | `locale` 服务、zh/en + `addLanguage` 语言包、即时切换 | 无 i18n（README/界面中文为主） | 海外用户与插件市场覆盖 | **P2** |
| 13 | **分发与运营**：npm 发布、插件市场、更新公告、求星/反馈闭环、社区 PR 流程 | npm 1.3.3、11 个 Release、应用内公告、贡献者清单、QQ/抖音群 | npm 已发布 0.7.1、有 CI/e2e；无市场运营与公告体系 | 冷启动与增长 | **P1** |
| 14 | **工程守卫规模**（参考项，非功能） | 2078 行 CHANGELOG、12 份 ADR、`verify`/`smoke`/`verify:docs`、生成式 ROUTE-INDEX、i18n 双向对账棘轮 | 有 tsc + lib 新鲜度、vitest 新增失败门禁、Windows 渲染 e2e、known-failures 基线 | 长期可维护性 | **P2（可借鉴）** |
| 15 | **Application 壁纸** | **✗ 双方都不支持** | ✗ 不支持 | 无差距（共识边界） | — |

> **注**：#1 是唯一「可能是结构性差距」的一条，必须补验——如果 elysia 确实能在未安装 WE 的机器上实时渲染 scene，本项目「必须本机安装 WE 读取素材」就是最大的用户门槛差异；若其实也依赖 WE 素材，则差距缩小为「降级表现」（它没素材时大概率也降级，具体未核实）。

---

## 5. 本项目的优势与可差异化机会（对照结论）

1. **自研引擎，无第三方场景渲染引擎依赖**：elysia 的 scene 能力来自上游 `webwallgl`（依赖版本跟进、上游维护风险由它承担）；本项目是 three.js + Rust/WASM 自研（粒子模拟、效果链、puppet、SceneScript 自实现），**技术资产自有、许可干净（MIT）、可按自己的节奏迭代**。对外叙事可打「独立实现、非套壳引擎」。
2. **逐像素对拍与回归门禁是可信度资产**：本仓 README/CI 有「桌面 WE 逐像素对拍、A/B 截图零回归验收、known-failures 基线、Windows headless 渲染 e2e」；elysia 文档未见公开的逐像素对拍门禁（未核实其内部是否有）。可把「与桌面 WE 的一致性」做成公开可复现的 benchmark。
3. **轻量、专注、不碰宿主 DOM**：elysia 大量 issue 来自对宿主 DOM/CSS-module 哈希的深度改造（玻璃/侧栏/标题栏）与扩展功能；本项目只做背景层与设置页，回归面小，适合「引擎型/开发者向」定位。
4. **包体积与安装简单**：本项目 npm 包只含 `lib` + `dist` + `cordis.patch.yml`，无玻璃/字体/吉祥物资产；启动快、审查面小。
5. **可借鉴而非照抄的项**：降级链（尤其「作者内嵌 MP4」与「GPU 抓帧」两层）、库筛选/搜索、轮播、上传、i18n、宿主端设置文件、性能档——这些都是工程化确定性收益，不必跟进玻璃/吉祥物军备竞赛。
6. **不建议的路线**：为追平外观体系而重写宿主设置窗口/侧栏玻璃。收益递减且回归风险高（elysia 的 issue 分布就是前车之鉴）；若要玻璃，只做「背景层之上的轻量遮罩/模糊」即可。

---

## 6. 上游与生态关键设施

| 设施 | 定位 | 与竞品关系 | 链接 / 许可 |
|---|---|---|---|
| **webwallgl** | 浏览器端 WE 渲染核心（scene/web/video + 场景编辑器） | **elysia 的 scene/web 引擎**（npm 依赖 ^3.0.0）；另有 `@webwallgl/core`、`@webwallgl/editor` 子包，可 CDN 直接引入 | [oneincase/webwallgl](https://github.com/oneincase/webwallgl)，MIT，13★，10-14 |
| **media-bridge** | 三平台系统媒体链路（GSMTC / MediaRemote / MPRIS）+ 频谱 + Now Playing | elysia 按需下载并 SHA-256 校验；不可用回退内置实现 | 见 elysia README/致谢（oneincase 维护）；独立仓库 URL 本次未核实 |
| **WEwebLoader / wallpaper-engine-web-loader** | 第二条浏览器端 scene 渲染路线（scene.pkg/.mpkg/workshop，WebGL2；含离线 PWA 与逐层调试门禁） | XHR666 生态的渲染器，**GPL-3.0**；dsh-mpkg-wallpaper 不内嵌只要求另装；VS Code 插件生态也有使用（未核实） | [XHR666/wallpaper-engine-web-loader](https://github.com/XHR666/wallpaper-engine-web-loader)，GPL-3.0，1★，10-16，npm 0.5.20 |
| **linux-wallpaperengine** | Linux 侧 WE 逆向实现 | elysia 的语义对齐来源（「粒子按官方 lwe 语义修正」）；本项目 README 也声明格式/行为语义对齐自它 | [Almamu/linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine)（GPL，具体许可未核实） |
| **插件市场/目录** | 分发渠道 | `awesome-dsh-plugin.com` 徽章、`dsh-plugin.org` 列表页、DWP 市场出现在各竞品 README | 各自站点；运营价值高于技术价值 |

---

## 7. 结论与待核实清单

### 7.1 竞争结论
- **短期**：elysia395/dsh-wallpaper-engine 是 DSH 壁纸品类的**事实标准**，凭「全类型 + 全外观 + 三平台 + 高频发布 + 社区运营」占位；两个月完成从「不做 scene」到「90% scene 覆盖」，执行力强。
- **中期**：其风险在**产品宽度带来的回归面**（宿主 DOM 深度改造、玻璃/侧栏适配、扩展功能）与**对上游 WebWallGL 的依赖**；若上游引擎出问题或 fidelity 停滞，是自研引擎路线的机会窗口。
- **对本项目**：渲染深度（自研引擎、puppet/SceneScript/音频/效果链、逐像素对拍）是我们的差异化资产，但**产品化缺口（P0/P1 项）决定能否被普通用户用起来**。建议资源分配：先把 #1/#2/#11（免装 WE 路径与降级链、设置存储）做成硬承诺，再补 #3/#4/#5（库/上传/轮播）三件套，最后按定位决定 #6（玻璃/字体）；**不要**在吉祥物/头像/3D 转盘等长尾外观上跟跑。
- **差异化叙事建议**：「独立引擎、可验证的桌面级还原、轻量不侵入宿主、开源可自建」——与 elysia 的「一体化外观套件」错位竞争。

### 7.2 建议本项目下一步（调研视角，供 Lead 决策）
1. **P0 验证任务**：核实 elysia 在未安装 WE 的机器上能否实时渲染 scene（可看其 issue 区/文档/源码中 `asset-paths` 的缺省行为），据此决定我们是否必须补「内置 WE 素材/降级纹理」。
2. **P0 设计**：给 scene 层补「内嵌 MP4 → GPU 抓帧 → 自定义画面 → 空态」降级链与失败记忆（可参考其 HOW-IT-WORKS 的契约，不抄代码）。
3. **P1 最小产品化**：壁纸库筛选/搜索/隐藏 + 上传 + 轮播，三件套即可覆盖 80% 日常诉求。
4. **P1 设置存储**：迁到宿主端单一数据文件 + 环境变量覆盖，解决「换端口/清浏览器数据丢设置」。
5. **P2 技术课题**：ffmpeg 转码档、系统音频回环（可独立评估 media-bridge 或自研）、三平台路线图、i18n。

### 7.3 风险
- elysia 迭代速度（近 30 天至少 4 个版本）会持续拉大产品功能差；其 star 增速与市场曝光有正反馈。
- 若 WebWallGL 上游继续提升 fidelity（其本身也支持三平台网页嵌入），「自研引擎」的技术叙事窗口会收窄。
- GPL 渲染器（WEwebLoader）生态若被更多插件采用，可能形成「免费场景渲染」的事实标准，挤压所有自研/闭源路线（含本项目）的差异化空间。
- 数据时效：本报告为 2026-10-19 快照，stars/issue/版本均会变化；引用前建议复核关键数字。

### 7.4 未核实项（禁止当成结论使用）
1. elysia 场景实时渲染是否**强依赖本机安装 WE**（README 只承诺「不需要 WE 在后台运行」，并提供 `DSH_WE_ASSETS_DIR` 覆盖；macOS/Linux 无 WE 客户端也可用，但未说明 scene 素材如何取得）。
2. `media-bridge` 的独立仓库地址与许可证（README/致谢提及 oneincase 维护，本次未抓取）。
3. elysia「90% 以上场景效果」的具体测试口径与样本量（官方自述，无第三方复测）。
4. elysia 是否公开逐像素对拍门禁（本仓有；elysia 文档未见，但未全仓检索）。
5. XHR666 两仓之间的关系与 WEwebLoader 的实际渲染质量/性能（README 自述有已知限制章节，本次未细读）。
6. YRN-playmaker/dsh-wallpaper_share「场景渲染」的实现方式（同步/窗口跟随/截图/自渲染未判定）。
7. kdzhang-hub、li8476295-bot、TianYa-DAO、sakuraaa667 等薄 README 项目的真实能力（仅按 README 关键词判）。
8. 各竞品 npm 实际下载量与用户规模（未抓 npm downloads API）。
9. `Almamu/linux-wallpaperengine` 的准确许可证（GPL 系列，未抓取确认）。
10. 各长尾项目 stars 与活跃度的相关性（部分 8 月后停更，未逐一核实 archived 状态）。

---

## 8. 附录

### 8.1 GitHub 检索式与结果数（2026-10-19 11:05 UTC+8，`sort=stars&order=desc`）

| # | 检索式 | `total_count` | 用途 |
|---|---|---|---|
| 1 | `wallpaper dsh`（默认搜 name/description/readme） | **277** | 全量发现 |
| 2 | `dsh-plugin wallpaper` | **162** | 插件命名口径 |
| 3 | `topic:dsh-plugin wallpaper` | **150** | topic 口径（去重后与 #2 高度重合） |
| 4 | `webwallgl` | **3** | 定位上游引擎（elysia、oneincase/webwallgl、MilkySnowWay123 天光皮肤） |

> 复现方式：`GET https://api.github.com/search/repositories?q=<urlencoded>&sort=stars&order=desc&per_page=30`（未认证限流 10 次/分；本报告只取了每式前 30 条中的前 25 条做名单，长尾可能仍有遗漏）。

### 8.2 elysia 精确采样值（2026-10-19 10:52 UTC+8）
```json
{"full_name":"elysia395/dsh-wallpaper-engine","stargazers_count":1568,"forks_count":62,"open_issues_count":35,"default_branch":"main","pushed_at":"2026-10-18T16:12:58Z","created_at":"2026-08-16T16:04:08Z","language":"JavaScript","archived":false}
```
- 全仓目录树：383 个 blob，未截断；关键目录：`lib/webwallgl/`（适配页）、`lib/routes/`、`src/`、`docs/adr/`（12 份 ADR）、`docs/CHANGELOG.md`（2078 行）、`test/`（verify 体系）。
- `package.json` 关键字段：`version 1.3.3`、`engines.node >=18`、`engines.dsh >=0.1.5-rc.1`、`dependencies { webwallgl ^3.0.0, x11 ^4.3.1 }`、`license MIT`、`dsh.client.immediately true`、`files` 白名单含 `lib/webwallgl/` 与大量 `lib/*`。

### 8.3 关键 URL 索引
- elysia 仓库：https://github.com/elysia395/dsh-wallpaper-engine
- elysia README（中文）：https://github.com/elysia395/dsh-wallpaper-engine/blob/main/README.md
- elysia 工作原理：https://github.com/elysia395/dsh-wallpaper-engine/blob/main/docs/HOW-IT-WORKS.md
- elysia 变更记录（2078 行）：https://github.com/elysia395/dsh-wallpaper-engine/blob/main/docs/CHANGELOG.md
- elysia ADR-0001（内嵌 WebWallGL 决策）：https://github.com/elysia395/dsh-wallpaper-engine/blob/main/docs/adr/0001-webwallgl-in-tree-live-renderer.md
- elysia 升级指南：https://github.com/elysia395/dsh-wallpaper-engine/blob/main/docs/UPGRADING.md
- elysia 排障：https://github.com/elysia395/dsh-wallpaper-engine/blob/main/docs/TROUBLESHOOTING.md
- elysia Releases：https://github.com/elysia395/dsh-wallpaper-engine/releases
- elysia Issues：https://github.com/elysia395/dsh-wallpaper-engine/issues
- elysia npm：https://www.npmjs.com/package/dsh-plugin-wallpaper-engine
- 上游引擎：https://github.com/oneincase/webwallgl
- 第二渲染路线：https://github.com/XHR666/wallpaper-engine-web-loader
- 本项目：https://github.com/yu502950715yang/dsh-use-wallpaper
- 本项目参考快照：`research/competitor/`（elysia v0.2.2，2026-08-19）、`research/dsh-wallpaper-engine-v0.7.1/`（elysia v0.7.1 scene-gl 管线）

### 8.4 本报告对项目内部的引用（只读核对）
- `README.md`（本项目能力/限制/配置项）
- `package.json`（版本 0.7.1、依赖 three/quickjs/lz4js、license MIT）
- `docs/technical-notes.md`（渲染路径、粒子、纹理、音频、puppet 边界）
- `docs/superpowers/plans/2026-10-13-scene-parallax-puppet.md`（puppet 以 WebWallGL `mdl-parse.js` 为格式参照、不 import）
- `research/competitor/README.md`（elysia v0.2.2 原文：当时明确「Scene 不能搬到 DSH」）

---

*报告结束。本文件只写本 task 负责的产物，未改动仓库源码/配置。*
