# 更新日志

`@dsh-use/wallpaper-engine` 的对外可见变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

- **0.1.0–0.8.2** 的历史记录见 GitHub Releases 与 git tag（其中 4 个早期 tag 未建 Release），本文件从 0.9.0 起逐版本记录。
- 单次发布的用户文案（GitHub Release）按 [`.github/RELEASE_NOTES_TEMPLATE.md`](./.github/RELEASE_NOTES_TEMPLATE.md) 写；本文件面向长期回溯，按「破坏性变更 / 新增 / 变更 / 修复 / 移除」归类。
- 兼容性、已知限制与素材边界的**现状**以 README「使用前请了解」与 [`AGENT.md`](./AGENT.md) §7 为准，本文件不重复维护。

## [Unreleased] — 目标版本 1.0.0（未发布）

> **发布收口工作稿（2026-11-10，基准 v0.13.1）**：1.0.0 尚未打 tag。打 tag 前请按 `git log v0.13.1..HEAD` 复核一遍，并把标题改为 `## [1.0.0] - YYYY-MM-DD`、更新文末链接。
>
> 1.0.0 本身**不新增渲染能力**，重点是契约声明、可观测性与发布工程；v0.9.0 以来的用户可见能力见下方各版本条目与「v0.9.0 → 1.0.0 能力汇总」。

### 破坏性变更（Breaking）

- **最低 DSH 版本抬升**：`package.json` 新增 `engines.dsh = ">=0.2.0-rc.1 <0.3.0"`（此前无任何 DSH 版本约束）。DSH 0.1.x 全线不再支持；DSH 0.2.1 起会按该字段做安装/加载兼容检查。
- **删除 DSH ≤0.1.6 的旧设置适配层**：设置只认 profile `cordis.patch.yml` 中条目 `dsh-wallpaper-engine` 的 `config`；`$DSH_HOME/settings.yaml` 旧路径、旧 `settings.register` 分支与 `wallpaper-engine` 短名候选均已移除。仍在 DSH 0.1.x 上的用户请停留在 `0.13.1`。
- **声明平台为 `win32`**：`dsh.bundle.platforms = ["win32"]`。macOS / Linux 从未实测，DSH 在其它平台会跳过本插件并报告原因（自行安装时自动探测、媒体集成、系统音频不可用）。
- **声音默认行为与 0.12 及更早不同**：视频壁纸与开机动画自 0.13.0 起默认出声（面板可关）。这不是 1.0 的新变化，但升级跨度较大时容易误判为故障。
- 设置字段、localStorage 键、数据目录结构**无重命名、无删除**；从 0.13.1 升级不需要手工迁移（步骤见下方「从 0.x 升级到 1.0」）。

### 新增（Added）

- 面板「关于」显示插件版本，并提供「复制诊断信息」：把版本、环境（WebGL2 / WE 目录是否配置）、当前壁纸与健康快照一键复制进 issue；**不含本地路径、媒体标题与封面**。
- 「实时渲染」卡新增环境自检提示：WebGL2 不可用、WE 引擎目录未配置、web 壁纸失败无回退，三类只提示原因与自救建议，不自动修复。
- 发布工程：`.github/workflows/release.yml`（tag 触发，publish 前跑发布门禁）；npm 包启用 provenance（GitHub Actions OIDC + `npm publish --provenance`）；`scripts/check-release.mjs` 发布前检查；`scripts/gen-wasm-manifest.mjs` + `dist/static/WASM_BUILD.json` 记录 wasm 三件产物的 sha256 / 构建工具版本 / 源码 commit。
- 协作与合规文件：`CHANGELOG.md`、`CONTRIBUTING.md`、`SECURITY.md`、`THIRD-PARTY-NOTICES.md`、`.github/ISSUE_TEMPLATE/`、`icon.svg`；`package.json` 的 `files` 同步收录。
- README 新增「支持矩阵」「数据与隐私」「升级」与卸载清理章节（平台、DSH 版本、浏览器、WE 依赖一句可得）。
- `package.json` 补齐 `types`、`engines.node = ">=20"`、`icon` / `dsh.icon`。

### 变更（Changed）

- 发布说明模板与发布 checklist 升级为 1.x 语义：breaking → major、新增用户可见能力 → minor、修复 → patch；定义废弃窗口与 DSH 兼容策略（抬上界 = minor，抬下界 / 删旧适配 = major）。
- `index.json` 修正历史 `publishTimestamp` 时区偏差（0.9.0 差 26s、0.12.0 早 16h、0.13.0 早 8h）；新版本条目按 npm `time` 的真实时间填写。
- 最低 DSH 版本声明统一：README 兼容段与 `package.json` 的 `engines.dsh` 都是 `>=0.2.0-rc.1 <0.3.0`；发布后补 `index.json` 的 1.0.0 条目时同步该值（历史 0.x 条目保留当时的 `>=0.1.5-rc.3` 声明）。
- 面板「关于」区从纯链接扩展为版本 + 诊断入口（Star / 反馈 / 文档三个链接保留）。

### 修复（Fixed）

- `cargo test` 从 exit 101 恢复：`wasm/tests/particle_stagger_test.rs` 的 `include_str!` 夹具从 gitignore 的 `research/` 移入 `wasm/tests/fixtures/` 入库；`override_rate_keeps_duty_cycle` 的期望值订正。
- 粒子自旋轴序改为 WE 的 `Rz·Rx·Ry`（此前 `Rz·Ry·Rx`）：只影响多于一个轴的旋转，单轴（z-only）逐像素等价；对象 `angles` 路径不受影响。
- 类型错误棘轮收紧已修复的 2 个键（`synthetic-library.test.ts|TS2339`、`verify-real-library.test.ts|TS2339`）；新增类型错误仍判红。

### 安全（Security）

- **web 壁纸沙箱加固**（2026-11-10，全项目安全审查发现）：
  - 开机动画的 `/wallpapers/boot/local-video` 与 `/wallpapers/boot/probe` **不再接受任意 `?path=`**，只读设置里配置的那一个路径（`bootAnimationLocalPath`）。此前 web 壁纸 iframe 与插件路由同源，可借它把用户磁盘上**任意本地视频**读成字节并外传。
  - `/wallpapers/web/*` 拒绝「已知 GUI 页面 Host」的请求：阻断壁纸 iframe 自我导航回 GUI origin、取回「GUI origin + 壁纸 HTML」组合后访问 `parent.document` / `localStorage` 的逃逸路径。
  - `.html` / `.svg` / `.js` / `.xml` 等危险后缀在 scene / media 资产下载时强制 `application/octet-stream` + `Content-Disposition: attachment`；所有 `/wallpapers/*` 响应带 `X-Content-Type-Options: nosniff`；系统媒体封面 MIME 只放行 `image/*`。

### 移除（Removed）

- DSH ≤0.1.6 旧设置路径相关代码与测试：`src/client/settings.ts` 的旧命名空间候选回退阶梯、`src/host/index.ts` 的旧 `settings.register` 分支、只为旧路径保留的非 volatile schema，以及 `tests/host-apply.test.ts` / `tests/client-settings.test.ts` 的 legacy 用例。

### 从 0.x 升级到 1.0（迁移步骤）

1. 先把 DSH 升级到 **`>=0.2.0-rc.1 <0.3.0`**；仍在 DSH 0.1.x 的请继续用 `0.13.1`。
2. 按安装方式升级插件（npm / GitHub / 桌面版插件页 / 插件市场索引，见 README「升级」）。
3. **设置无需迁移**：字段名与默认值未变。若你曾在 DSH ≤0.1.6 的 `~/.dsh/settings.yaml` 里手写过壁纸配置，1.0 不再读取该文件——把值抄进 profile `cordis.patch.yml` 的 `dsh-wallpaper-engine` 条目 `config`（字段名见 README「配置项」）。
4. 桌面版 App 必须**完全退出再启动**（client bundle 在启动时快照）；`dsh web` 重启命令、浏览器刷新页面即可。
5. 回滚：重装 `@dsh-use/wallpaper-engine@0.13.1`。0.13.1 没有 `engines.dsh` 约束，在 DSH 0.2.x 上通常仍可用，但该组合未按 1.0 口径验收；若回滚后异常，把 DSH 一并降回 0.1.x。

### v0.9.0 → 1.0.0 能力汇总

- **v0.9.0**：用户属性面板全类型、父可见性继承、自定义 visualizer 家族、浏览器模式系统音频、WE 预设壁纸。
- **v0.10.0**：开机动画（全屏层 + 接管 DSH 启动页）、Windows SMTC 媒体集成 + 时间线属性动画、设置面板设计系统。
- **v0.11.0**：首次安装引导（素材目录一张卡 + 一次性入口提示）。
- **v0.12.0**：视频壁纸可观测性（播放健康采样 + Range 路由）。
- **v0.13.0**：壁纸声音全面可控（视频音轨 / 音量 / web 壁纸声音 / 开机动画声音）。
- **v0.13.1**：人物动画与清晰度修复（puppet 骨骼动画、对象级效果链、shimmer 编译、云/雾 tint）。

## [0.13.1] - 2026-11-09

### 修复（Fixed）

- **puppet 骨骼动画**：「影之刃零1」（`3828798871`）等人物在桌面有动画、这里静止——按真实素材的 MDLS/MDLA 布局重写 `.mdl` 解析与骨骼绑定，角色蒙皮动画恢复。
- **绑定姿势**：改回 MDLS 骨骼矩阵链（`frame0` 只是播放起点，不是蒙皮 bind），修正人物姿态歪斜与运动方向偏移。
- **披风 / 衣摆 / 刀鞘飘带**：puppet 对象级效果链改为贴图空间合成，布料的水波、摆动效果重新生效。
- **效果链 v 约定**：修正贴图坐标方向，波动不再落到盔甲/脸/刀等错误部位，上方红衣人物同样生效。
- **人物清晰度**：puppet 效果链的中间画布按贴图源分辨率渲染，不再被隔离预算降采样；人物区锐度回到桌面水平（e2e Laplacian 5.60 → 7.32，WE 真机同相位 7.16）。
- **云 / 雾偏亮**：`colorBlendMode ≠ 0` 的静态作者色照常烘进 tint，云与雾回到桌面质感（雾带亮度 55.3 → 45.4，WE 48.8）。
- **shimmer 等水波/闪光效果**：修复 shader 方言的 HLSL 隐式向量截断与 sampler `default` 默认资产（本机 294 个 effect shader 中命中 1 个 shimmer，另 29 处默认槽位）。

### 变更（Changed）

- 4K 贴图的 puppet 效果链按源分辨率渲染，显存上升（单人物约 +100MB）；低显存机器卡顿可回退旧版本。
- 多动画层模型仍只应用第一条可见层（如 leon 壁纸的 4 条动画层只播第一条）。

## [0.13.0] - 2026-11-04

### 新增（Added）

- 视频壁纸音轨可播放（此前一律静音）；无音轨素材在面板提示「当前视频壁纸没有音轨」。
- 新增音量滑杆（default 100%）：scene 音效与视频壁纸共用，拖动即时生效。
- web 壁纸页内 `<audio>/<video>` 跟随同一个「声音」开关与音量；页面脚本自己改静音也会被兜住。
- 开机动画独立「播放声音」开关与音量（默认开启 100%）；片头播放期间壁纸声音自动静音，播完按设置恢复。

### 变更（Changed）

- 「壁纸音效」从「性能与省电」移出，独立成「声音」卡（开关 + 音量 + 无音轨提示）。
- **默认行为变化**：升级后视频壁纸与开机动画默认出声，不想听可在「声音」卡关闭。

### 修复（Fixed）

- 开机动画播放期间仍能听到壁纸声音（片头与壁纸层同时起播）。
- 关闭「壁纸音效」后个别 web 壁纸仍出声（声音 shim 增加播放时兜底与启动期重发）。
- 高级区卡片头右侧说明文字未对齐到折叠箭头前。

## [0.12.0] - 2026-11-03

### 新增（Added）

- 视频壁纸播放期间，「实时渲染」卡新增状态行：分辨率、实测 FPS、近 1 秒丢帧与最近循环停顿。
- 新增排查入口 `window.__wallpaperEngine.videoHealth()`，返回同一份视频健康快照。

### 修复（Fixed）

- 视频壁纸的媒体出口支持 Range / HEAD（206 / 416）：循环回绕与进度拖动不再依赖整文件全量响应，大文件不再同步整读阻塞宿主事件循环。
- 视频健康采样在缺少播放质量接口的环境按 0 处理并继续播放，不抛错。

## [0.11.0] - 2026-11-02

### 新增（Added）

- 首次安装引导：空壁纸库时「素材目录」卡默认展开（引导说明 + 两个目录 + 自动探测 + 保存路径 + 帮助），探测结果只显示一次，点「采用」即写入设置并自动刷新列表。
- 未配置素材目录时，右下角一次性入口提示（15 秒淡出、可关闭、localStorage 只提示一次）。
- 快捷导航新增「素材目录」锚点；空库时隐藏搜索/筛选工具栏。

### 变更（Changed）

- 首版的「独立引导卡 + 素材目录卡」合并为一张卡（原实现里探测结果、输入框、帮助各出现两次）。

### 修复（Fixed）

- 采用探测路径后，卡片右侧仍显示「未配置」。
- 采用后列表为空时无任何反馈（现在说明可能原因与期望路径）。

## [0.10.0] - 2026-10-30

### 新增（Added）

- **开机动画**：设置页新增独立 tab（与日常壁纸互不影响、默认关闭）；素材可用 WE 库的视频/图片壁纸或本地视频文件（桌面端系统文件选择器）；四种展示方式；固定播放策略（每次会话只播一次、8 秒未就绪静默跳过、点击/按键/Esc 跳过、30 秒硬上限）；DSH 启动加载页显示期间持续接管，主界面就绪后淡出。
- **媒体集成（Windows SMTC）**：壁纸的专辑封面 / 歌名 / 歌手 / 主色与播放状态实时联动；仅内存、不落盘、面板可关；新增时间线属性动画运行时与 SceneScript media 事件。
- **设置面板设计系统**：单入口 + 顶部 tab（日常壁纸 / 开机动画）；统一设计 token（浅色与深色两套）；开机动画面板重设计；素材区改可视化网格（含标题搜索与当前选中高亮）；「当前壁纸」hero 彩色化。

### 修复（Fixed）

- 安全加固（开机动画本地视频路由）：仅回环来源 + `Host` 头双闸门（防 DNS rebinding），拒绝 UNC / 混合分隔符网络路径（防 SMB/NTLM 泄露），扩展名白名单，Range/HEAD 语义对齐既有资源路由。
- 开机动画启动时序与启动页覆盖竞态、重复试播的旧 Promise 悬挂、probe 语义与 MIME 对齐（`.mov` / `.m4v` / `.ogv`）。
- 切到非 scene 壁纸后不再重播旧场景音频。
- 媒体：封面方向翻转与 bitmap 生命周期、集成开关恢复、白框残留、面板状态与颜色回归、SMTC watcher 封面缓存 / rev / 错误处理。
- scene：文本锚点偏移刷新、alpha 脚本守卫。
- UI：选中态可辨性（accent 描边 + 浅 accent 底 + ✓ 角标 + 标题加粗）。

## [0.9.0] - 2026-10-27

### 新增（Added）

- 用户属性面板覆盖全部类型（bool / slider / color / combo）：condition 不满足时禁用并标灰、支持恢复默认、slider/color 300ms 防抖提交。
- 父可见性继承：对象可见性沿父链继承（修复 `3812518176` 两套时钟叠字、`2911105183` 三态时钟叠加）。
- 自定义 visualizer 家族：按脚本参数（条数 / 间距 / 最小高度 / 条纹理）代建音频条，静音也显示最小高度。
- 系统音频（浏览器模式）：面板授权 `getDisplayMedia` 捕获系统音频驱动可视化；桌面 App 受宿主权限限制不可用，面板提示改用浏览器。
- WE 预设壁纸：`dependency` 预设项按依赖的主壁纸渲染并套用预设参数，类型筛选新增 PRESET。

### 修复（Fixed）

- 用户属性颜色按 shader 的 0–1 语义解析并修正写回时的双重归一。
- 「恢复默认」不再误删旧全局键；颜色提交防抖。
- 类型筛选选项统一为 SCENE / VIDEO / WEB / IMAGE / PRESET。

[Unreleased]: https://github.com/yu502950715yang/dsh-use-wallpaper/compare/v0.13.1...HEAD
[0.13.1]: https://github.com/yu502950715yang/dsh-use-wallpaper/releases/tag/v0.13.1
[0.13.0]: https://github.com/yu502950715yang/dsh-use-wallpaper/releases/tag/v0.13.0
[0.12.0]: https://github.com/yu502950715yang/dsh-use-wallpaper/releases/tag/v0.12.0
[0.11.0]: https://github.com/yu502950715yang/dsh-use-wallpaper/releases/tag/v0.11.0
[0.10.0]: https://github.com/yu502950715yang/dsh-use-wallpaper/releases/tag/v0.10.0
[0.9.0]: https://github.com/yu502950715yang/dsh-use-wallpaper/releases/tag/v0.9.0
