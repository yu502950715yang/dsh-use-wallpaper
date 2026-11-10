# 1.0.0 发布前：产品体验与平台边界审计（基于 v0.13.0 工作树）

> **作者/角色**：产品与平台审计员（teammate `product-reviewer`）。
> **性质**：只读分析。未修改任何源码 / 配置 / 文档；本文件是唯一产出。
> **口径**：外部用户 / 发布者视角。所有「用户影响比例」都是**估计值**，已在表里标注依据；未做视觉验收（无浏览器上下文），UI 结论来自代码接线、DOM 契约测试与文档，不来自截图。
> **未执行**：vitest / e2e / build（由 release-engineer 负责），也未做任何真机操作。
> **数据采样**：2026-11-06；工作树干净（`git status` 0 项）；本机 `dsh --version` = **0.2.0-rc.1**；npm 最新 = **0.13.0**；GitHub = **9★ / 0 open issue / Discussions 已开 / 无 Pages**（外部 API 实测，见 §8）。

---

## 0. 给 Lead 的 5 条结论（摘要）

1. **功能不是短板，对外「契约」是短板。** v0.13 的缺口几乎都不在实现上，而在：兼容声明（全仓没有 `engines.dsh`）、支持矩阵（仅 Windows 实测，但文档没有正式的不支持声明）、升级/数据契约（无升级章节、无设置 schema 版本、无数据目录清理说明）、出问题时的自助诊断、以及发布合规文件（无 CHANGELOG / SECURITY / CONTRIBUTING / ISSUE_TEMPLATE）。这些恰好是「1.0 作为对外承诺」必须补齐的部分。
2. **最大的平台级事实：宿主 DSH 还处在 0.2.x RC 阶段，且规则刚变。** 本机 DSH 是 `0.2.0-rc.1`；DSH 从 `0.2.1-alpha.4`/`rc.1` 起明确「第三方插件兼容性优先按 `engines.dsh` 判断；未声明时沿用原有规则」，而本包 `package.json` **没有** `engines` 字段（package.json:38-46、:59-73）；README 的兼容矩阵停在 `0.1.7-alpha.2`（README.md:218），市场索引的 `engines.dsh` 只有下界 `>=0.1.5-rc.3`、无上界（index.json:60-107）。→ 1.0 必须把「支持哪些 DSH」变成**一处权威、可执行**的声明。
3. **README 已公开的限制本身不是 1.0 阻塞**（它们有声明、有降级链、大多有逃生路径），但**四条外部闭环缺失**才是阻塞：升级/数据不丢、问题可诊断、平台边界可查、发布物可追溯。已知限制里最重的仍是子粒子 / ropetrail（本机 43 张快照里约 28% 命中，README 已声明，见 §3）。
4. **「半成品 UI / 死按钮」几乎没有**：33 个设置字段里只有 `frameCacheEnabled` 无面板控件（README.md:183、:205 已自认），其余 32 个字段均有控件且接线完整；没有发现点了没反应的按钮。真正的问题是「能力缺失时的提示缺失」（WebGL2 / WE 未装 / web 壁纸失败 / 局域网访问）和「已发布但未真机验收」（媒体 M1–M8、开机动画 B1–B8、视频声音，TESTING.md:465/:481/:516/:545）。
5. **推荐 1.0 门槛 = 方案 2「标准」的裁剪版，约 15–17 人日**：定义 = **对外契约冻结 + 支持矩阵声明 + 头条功能真机验收 + 文档/合规闭环**；**不**把功能完整度、macOS/Linux 实测、i18n、用户规模当门槛。1.0.0 顺势承担唯一一次 breaking change：删除 ≤0.1.6 的 DSH 适配层（AGENT.md §7.34，L243）。详见 §C。

---

## 1. 审计方法与边界

**必读输入（已读）**

| 输入 | 用途 |
|---|---|
| README.md 全文（440 行） | 用户可见承诺：安装、配置、限制、降级链、卸载、许可 |
| AGENT.md §1/§4/§5/§7（318 行，重点 §7.32/33/34/35/38/44/45） | 已知边界的权威来源 |
| TESTING.md（631 行，重点 §2.17/2.18/2.19、§3 卸载） | 真机验收现状与文档漂移 |
| （历史产品化计划，已清理） | 产品化目标；**无 1.0 规划**（全文无 1.0 相关条目） |
| docs/promo/2026-10-27-promotion-plan.md、competitive-2026-10-19/we-product.md | 推广/竞品视角的「还差什么」 |
| docs/technical-notes.md、docs/dev-setup.md | 贡献者文档现状与漂移 |
| .agents/notes/implemented/feature/**、architecture/**、rejected/** | 功能取舍与「为什么」 |
| src/client/**、src/host/**（settings-section.tsx 1450 行、index.ts、settings.ts 等） | UI 接线、设置字段覆盖、诊断入口、平台分支 |
| index.json、package.json、cordis.patch.yml、.github/**、LICENSE | 安装/上架/发布/合规 |
| 外部：npm registry（metadata + `time` + downloads）、GitHub API、本机 `dsh --version`、docs/promo/raw/harness-releases.json（DSH 发布说明快照） | 量化与交叉核对 |

**明确未做**：视觉验收（无浏览器上下文）、运行任何测试/构建、修改任何文件、访问 DSH 宿主源码（`app.asar` 为打包文件，无法读取插件管理页/兼容 gate 的宿主实现；相关结论以 DSH 公开 release notes + 本文档推断，已标「推断」）。

---

## 2. 七个必答问题（结论 + 证据）

### Q1. 平台与兼容：仅 Windows 实测、DSH 版本矩阵、旧适配层去留

**结论：这三个问题都是 1.0 的阻塞项，但都不需要「支持 macOS」或「删除适配层」本身，而是需要「明确、可执行的声明」。**

- **仅 Windows 实测是硬事实，且渗透到实现**：README.md:278、docs/dev-setup.md:8、CI 只在 `windows-latest` 跑（.github/workflows/ci.yml:8、:37）；自动探测读 Windows 注册表（src/host/steam-paths.ts:131-147 `reg query`）且默认根是 Windows 路径（steam-paths.ts:40-44）；媒体集成只在 win32 有数据源（AGENT.md §5.54，L204-205；§7.44，L289）。macOS/Linux 理论上「手填两个路径 + 非媒体壁纸」可能可用，但**没有任何验证**，且自动探测不可用。
  - **1.0 要求**：README 增加「支持矩阵」小节（Windows 完整支持 / macOS、Linux **未测试**：可用手填路径尝试，自动探测、媒体集成、系统音频不可用或未验证），并同步到市场索引描述；**不要求**真的去支持 macOS。
- **DSH 版本声明目前是「三处不一致 + 一处缺失」**：
  - README.md:218 声明「0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-alpha.2 三版均真机验证」；
  - README.md:161 又说「**DSH 0.2.1 起**可以用索引源」；
  - README.md:113 声称「插件声明的 DSH 版本不兼容时会被拦下」——但 `package.json` **没有** `engines` 字段，本插件装上后宿主拿不到声明（index.json:60-107 的 engines 只覆盖「从市场索引安装」这一条路径，且只有下界）；
  - 本机宿主已经是 `0.2.0-rc.1`，DSH 发布说明（docs/promo/raw/harness-releases.json 中 `dsh-v0.2.1-alpha.4` 与 `dsh-v0.2.1-rc.1` 的「其他变更」段）明确要求作者检查 `engines.dsh` 声明。
  - **1.0 要求**：`package.json` 增加 `engines.dsh`（范围 = 作者能实测复验的最低版本到当前 0.2.x，例如 `>=0.2.0-rc.1 <0.3.0`，具体值由作者定）；README 用同一范围更新兼容矩阵并删掉过期的三版声明；index.json 的 engines 同步为同一区间；**不再**在文档里宣称没测过的版本。
- **旧版适配层（AGENT.md §7.34，L243）建议作为 1.0.0 的 breaking change 一并删除**：
  - 它的删除判据原文就是「README 声明的最低 DSH 版本 ≥ `0.1.7-alpha.1`」；1.0 若把最低版本抬到实测下限（建议 ≥0.2.0），判据自然满足；
  - 不删的代价是双路径长期维护 + 样式双份 + 无 CI 覆盖旧版（CI 只跑当前 Windows 版），属于「永远不验却永远背着」；
  - 工作量估计 **1.5–2 人日**（src/client/settings.ts:13 的 ns 候选、settings.ts:4-12 注释、styles.ts 的旧版侧栏规则、对应测试与文档；清单在 （历史计划已清理；结论并入 AGENT §5.34））。
  - 若作者不愿在 1.0 删：则 1.0 release notes 必须写「继续支持 DSH ≤0.1.6」并把该声明变成可复核项（当前无法复核）。

### Q2. 安装与升级闭环：npm / GitHub / 桌面插件页 / 市场索引 / 配置迁移

**结论：安装路径写得很好，升级闭环几乎为零。这是 1.0 最典型的「内部觉得没问题、外部会出事」的地方。**

- **安装**：三条路径齐全（README.md:92-143：桌面插件页 / `dsh web` 的 npm 与 GitHub / 本地 link），桌面不能走 CLI 的坑写清了（:94），本地仓库改 `dist/` 必须重启 App 也写了（:109）。这部分 1.0 可保留。
- **升级**：README **没有升级章节**（全文只有「🧹 卸载」，README.md:407-415；grep「升级/更新到/npm update」在 README 无匹配）。四条真实升级路径（npm 改版本、GitHub 拉最新、桌面插件页更新、市场索引源安装）都没有写；DSH 0.2.1 起插件页已支持「更新后依赖同步」并「显示实际安装版本 / 因冷却策略装到旧版时给说明」（DSH release notes 快照），插件文档没有跟进。**1.0 必须有「升级」小节 + 版本显示**。
- **配置迁移**：
  - 设置 schema 没有版本字段、没有迁移逻辑（src/host/settings.ts:5-63 只有 schemastery 默认值；src/client/settings.ts:15-41 DEFAULTS 直接合并）；
  - 字段是持续新增的（v0.8 加 5 个、v0.10 加 7 个、v0.13 加 2 个），目前**没有删改字段**，这是好事；但有「默认值变更」静默影响老用户观感的先例（`glowStrength` 从 1.0 → 0.35，README.md:196）；
  - 本地状态 `we:fav` / `we:hidden` / `we:recent` / `we:setup-tip`（src/client/local-store.ts:9）、`we:userprop:<id>:<key>`（src/client/settings.ts:124-141）、`we:renderfail:<id>`（src/client/render-health.ts:26）与数据目录 `~/.dsh-use-wallpaper/frames`（README.md:272）都没有「1.x 内不变」的承诺或迁移说明。
  - **1.0 要求**：写「数据与设置兼容性」小节：① 设置字段只增不改（改名/删除走 major + 迁移）；② 本地键与数据目录列表化；③ 升级后哪些要重启（client bundle 快照 / host 重启）分路径写清；④ 给「如何备份/清理」。
- **市场索引（index.json）**：
  - 结构正确、版本列表到 0.13.0（index.json:52-108），但 **publishTimestamp 手工维护且已出错**：0.12.0 比 npm 实际时间早 **16 小时**、0.13.0 早 **8 小时**（核对见 §8 表），0.10/0.11 准确；发布 checklist 也是手工「等 npm 生效后取 `time[version]` 填进去」（.github/RELEASE_NOTES_TEMPLATE.md:81）。
  - **1.0 要求**：发布脚本从 `npm view <pkg> time --json` 自动生成版本条目；至少修掉 0.12/0.13 两条；加一条校验（与 npm `time` 对齐）。
- **安装/卸载文档不一致**：TESTING.md §3 的卸载流程仍写旧 monorepo 路径 `packages/dsh-wallpaper-engine`（TESTING.md:567）、验收点写「页面无 **WP 浮动按钮**」（:606）——该按钮早已不存在；「彻底清理」清单（:617-626）**没有**插件数据目录和 localStorage 键。README 的卸载也没提这两项。→ 1.0 必须修（用户卸载后残留是实打实的体验问题）。
- **贡献者侧**：`package-lock.json`（npm）与 `pnpm-lock.yaml` 同时入库，CI/文档都用 pnpm（ci.yml:48、dev-setup.md:17），新人容易走错；建议删除 npm 锁文件或写明只支持 pnpm。

### Q3. 首跑体验：自动探测、首次引导、没装 WE / 路径错 / 无 WebGL2

**结论：首跑「引导」已闭环（v0.10/0.11 做得很好），「环境失败」未闭环。**

- 已闭环（有证据）：
  - 首次配置引导卡：空库且未配置时默认展开，探测结果只出现一次、可「采用」并自动刷新，附「怎么找这两个目录」折叠帮助；空库隐藏搜索工具栏（.agents/notes/implemented/feature/2026-11-02-first-run-setup-onboarding.md:17-24；src/client/settings-section.tsx:845-924）。
  - 一次性入口提示条（`shell.overlay`，15s 淡出、只提示一次，localStorage `we:setup-tip`）（src/client/setup-tip.tsx:40-94）。
  - 空态/筛选空态有明确文案（settings-section.tsx:837-841）。
- 未闭环：
  - **无 WebGL2**：README 说「不支持 WebGL2 时自动退回预览图」（README.md:281），代码层只有通用失败分级（`render-health.ts:6` 的 `scene-json/no-visible-objects/context-lost/exception`，`render-health.ts:179-185` 的五句通用文案），没有「浏览器不支持 WebGL2」的专门判定与提示；`index.ts:253` 的 `WebGL2RenderingContext` 只用于清理残留 canvas。用户看到的是「上次失败：装配异常（已记忆）」，无法自救。
  - **没装 WE / 引擎目录错**：粒子纹理走 host 路由、两级查找（AGENT.md §5.14，L146），缺失时粒子退化为软圆点（README.md:280 自述），面板无提示；「自动探测」只返回 `exists` 标记（settings-section.tsx:886-903），用户看不出「为什么画面比桌面版差」。
  - **web 壁纸失败**：§7.32（AGENT.md:241）明确「跨源 iframe 探不到子帧错误 ⇒ 无失败回退，失败停在空白」，README.md:80/:246 已声明，但**面板没有提示**（只有 scene 的降级链提示与视频失败提示）。
  - **局域网/隧道访问**：§7.33（AGENT.md:242）opaque origin ⇒ 依赖 WebGL 贴图的 web 壁纸空白，README 未在「使用前请了解」声明（只在 AGENT 里）。
- **1.0 要求（低成本、高收益）**：面板「实时渲染」卡增加三类环境自检提示：WebGL2 不可用、WE 引擎目录缺失/未配置、web 壁纸（跨源）失败不可回退；并把 §7.33 写进 README 的限制清单。**不要求**真的实现 web 回退或局域网方案。

### Q4. 失败可观测性：用户报 issue 的信息够不够

**结论：不够。面板有健康状态，但没有「可复制的诊断包」，也没有版本信息。**

- 已有：面板「实时渲染」卡（状态行 + 重试实时渲染 + 清除失败记忆 + 视频壁纸健康行）（src/client/settings-section.tsx:1413-1433）；健康快照 API `window.__wallpaperEngine.health()` / `.videoHealth()`（src/client/index.ts:391-409）；`formatHealthLine` 把原因翻成可读中文（render-health.ts:158-169）。
- 缺：
  - **无插件版本 / DSH 版本 / 浏览器 / WebGL2 / 路径配置 的展示**（「关于」区只有 Star/反馈/文档三个链接，settings-section.tsx:1434-1445）；
  - **无一键复制诊断**；issue 指引只在 README 内联（README.md:307-321，要求「壁纸名+ID / 现象 / 桌面对比 / 环境 / Console」），**没有**要求插件版本、DSH 版本、健康快照、`videoHealth`、配置的目录、是否 WebGL2；
  - 原因粒度粗（「装配异常」「资源加载中断」），用户与作者都要来回猜；
  - console.warn/error 共 44 处（`[wallpaper-engine]` / `[three]` / `[text-script]` / `[mdl]` 前缀混用），没有「预期降级」与「真异常」的分级，用户容易把正常降级当 bug 报。
- **1.0 要求**：新增「诊断信息一键复制」（版本、DSH 版本、UA、WebGL2、路径配置状态、当前壁纸 id/类型、health/videoHealth 快照、最近 N 条插件警告）+ 关于区显示版本 + 新增 `.github/ISSUE_TEMPLATE/bug_report.yml`（上述字段必填）。估计 1–1.5 人日，收益最高。

### Q5. UI/UX 完整度：未接线控件、文案与行为不符、无障碍/键盘/窄窗口

**结论：控件层几乎无硬伤；缺的是 i18n、版本展示与「未验功能」的标注。**

- **未接线控件**：逐字段核对 DEFAULTS（src/client/settings.ts:15-41 共 33 个字段）与两个面板的引用：只有 `frameCacheEnabled` 无控件（README.md:183、:205 已明确自认「要改只能写 profile config」），其余 32 个字段均有控件且 handler 有实际写入路径（settings-section.tsx / boot-settings-section.tsx）。**未发现死按钮或假控件**。
- **有意置灰/禁用**（不算缺陷）：条件不满足的用户属性（`data-disabled`，settings-section.tsx:935-1047）、开机动画「视频不支持平铺」（boot-settings-section.tsx:351-359）、系统音频在桌面 App 不可用（面板提示改用浏览器，settings-section.tsx:1068-1089）、媒体集成非 Windows 显示原因（:1213）。
- **文案与真实行为不符**：未发现面板文案谎报；但 README 与内部文档有 6 处漂移（见 §7），其中 README.md:113「版本不兼容会被拦下」是唯一面向用户的**不实承诺**（本包无 engines 声明，宿主没有可拦的依据）。
- **无障碍/键盘**：tab 有 WAI-ARIA 与 ←/→ 键盘切换（.agents/notes/implemented/feature/2026-10-30-panel-tabs-design.md:12）；focus-visible 样式覆盖较全（src/client/styles.ts:223-353、:617-713）；缩略图 hover 操作按钮有 `:focus-within` 兜底（styles.ts:265），键盘可达。**缺口**：全中文硬编码、无 i18n 层（settings-section.tsx:221-222 自注；render-health.ts:178-185）；「关于」没有版本号；`prefers-reduced-motion` 只关 UI 过渡动画，壁纸的持续运动不响应系统设置（styles.ts:301/:369/:755）——对动效敏感用户是已知缺口，1.0 可在 README 说明（可选实现「暂停壁纸」跟随）。
- **窄窗口**：容器查询已有（≤520px 单列，panel-tabs note:15、:32），但**真机视觉未验收**（note 自己承认「浅/深色、窄容器需人工确认」）。不做视觉验收的前提下只能记为「未验证」，不算阻塞。
- **插件在市场/插件页的呈现**：`package.json` 无 `icon`（无 icon.svg）、无本地化展示元数据；index.json 的插件项只有 title/description（index.json:25-51），没有截图/图标字段（`screenshots.json` 在仓库根但全仓无引用）。DSH 0.2.1 起「插件开发模板同步补齐本地化信息与图标」——1.0 建议补（低成本，非阻塞）。

### Q6. 文档体系：对用户与贡献者够不够；缺哪些标准文件；素材合规

- **够的部分**：README 覆盖安装/配置/限制/降级链/架构，且「使用前请了解」是罕见的诚实文档；AGENT.md 是高质量工程知识库（318 行、§5/§7 带判据）；TESTING.md 有 19 组验收清单；20+ 篇决策笔记记录「为什么/放弃了什么」。**内部文档体系是强项**。
- **缺的部分（1.0 外部必需）**：无 **CHANGELOG**、无 **CONTRIBUTING**、无 **SECURITY**、无 **THIRD-PARTY/NOTICE**、无 **.github/ISSUE_TEMPLATE**、无 **README.en.md**、无 icon；README 440 行且把「架构一览 / 构建与开发」等开发者内容放在用户文档里（promo 也提过「已 399 行、首页要 3 秒看懂」，docs/promo/2026-10-27-promotion-plan.md:209）；`docs/promo/` 被 `.gitignore` 忽略（公开仓库看不到推广/竞品依据）；**文档漂移 6 处**（§7）。
- **素材合规表述**：README.md:419-425 与 AGENT.md:146（§5.14）都说明「不重新分发第三方素材 / WE 内置纹理运行时从本机读取」；实际发布包 `files` 只有 `lib` + `dist` + `cordis.patch.yml`（package.json:92-96），`dist/static` 只有 3 个自有/构建产物（quickjs.wasm 503KB、we_scene wasm 172KB、js 11KB），**没有** WE 纹理（.gitignore 还保留 `dist/static/ptex-*.tex` 兜底规则）。做法正确，缺一个正式 **THIRD-PARTY/NOTICE** 文件把依赖（three / lz4js / quickjs-emscripten / wasm-bindgen / @deepseek-ai/schemastery）与素材边界写在一起。
- **隐私/数据**：媒体集成「只在内存、不落盘、不记日志」（AGENT.md:204）、系统音频「不落盘不上传」（AGENT.md:285）、帧缓存写本机数据目录（README.md:272）。这些散落在 README/AGENT，1.0 应集中成「数据与隐私」一节（用户会问）。

### Q7. 「1.0.0 定义」调研

→ 见 §C（三方案对比 + 推荐 + DoD）。核心判断：**项目内部从未定义过 1.0**——发布模板明确写「0.x 阶段……不引入 major」（.github/RELEASE_NOTES_TEMPLATE.md:69-72），v0.8 产品化计划通篇无 1.0 条目（（历史产品化计划，已清理）），promo 文档也只到「冲 321★」。所以 1.0 的定义必须由本次决策**新立**，不能从历史文档里找现成答案。

---

## 3. A. 用户可感知的体验 / 平台缺口表

> 「影响用户比例」全部是**估计**；依据写在同一行。比例的分母默认是「本机 43–45 张壁纸快照的画像 + 公开数据」，不是全量用户统计。

| # | 缺口 | 用户影响（估计 + 依据） | Workaround | 1.0 阻塞 | 证据 |
|---|---|---|---|---|---|
| A1 | **非 Windows 无任何官方说法**：自动探测、媒体集成、系统音频都是 Windows-only；macOS/Linux 未测 | 影响所有非 Windows 用户（**占比无法从仓库数据估计**；DSH 官方发布说明持续修 macOS 问题，说明 macOS 用户真实存在） | 手填两个目录；接受功能降级 | **阻塞（只要求声明，不要求支持）** | README.md:278；dev-setup.md:8；ci.yml:8；steam-paths.ts:40-44、:131-147；AGENT.md:204、:242 |
| A2 | **DSH 兼容声明缺失/过时**：包无 `engines.dsh`；README 矩阵停在 0.1.7；index engines 无上界；本机宿主 0.2.0-rc.1 | 所有用户（安装/升级时的兼容 gate 没有可执行依据；作者也无法声称支持 0.2.x） | 手动试装；看 README 猜 | **阻塞** | package.json:38-46、:59-73；README.md:113、:161、:218；index.json:60-107；DSH release notes（harness-releases.json，0.2.1-alpha.4/rc.1） |
| A3 | **升级路径无文档**：README 只有卸载；四条升级路径都没写；插件页能更新但用户不知道 | 所有已安装用户（升级时不知道该跑什么、要不要重启） | 自行 `dsh plugin add` 指定版本 / 插件页乱点 | **阻塞** | README.md:407-415（无升级章节）；DSH 0.2.1 release notes；RELEASE_NOTES_TEMPLATE.md:73-82 |
| A4 | **设置/本地数据/数据目录无兼容承诺**：无 schema 版本、无迁移说明；localStorage 键与 frames 目录未在用户文档登记 | 所有升级用户；一旦未来改名/删字段，收藏/属性/帧缓存可能静默丢 | 无 | **阻塞** | host/settings.ts:5-63；client/settings.ts:15-41；local-store.ts:9；render-health.ts:26；README.md:272 |
| A5 | **卸载残留**：README 只写命令与插件页；未提 `~/.dsh-use-wallpaper/frames`、localStorage 键、settings 命名空间；TESTING 的清理清单过时 | 所有卸载用户（磁盘/隐私残留，且不知道要清） | 手动猜路径 | **阻塞（文档级）** | README.md:407-415；TESTING.md:617-626、:567、:606 |
| A6 | **无诊断信息 / 无版本展示**：面板不能复制诊断；关于区无版本；issue 模板内联且不含版本/健康快照 | 出问题的用户（估计 5–15% 的 scene 用户会遇到至少一次降级；依据：README 称渲染失败「是正常可能出现的情况」，§7.38 的看护体系本身即为失败而建） | 手动翻 console | **阻塞（低成本）** | settings-section.tsx:1413-1445；render-health.ts:179-185；README.md:307-321；index.ts:391-409 |
| A7 | **无 WebGL2 / WE 缺失 / web 失败的提示** | 新用户与低端机用户；web 壁纸用户 | 换浏览器/装 WE/换壁纸 | **部分阻塞（至少提示）** | render-health.ts:6、:179-185；index.ts:253；README.md:280-281；AGENT.md:241-242 |
| A8 | **web 壁纸无失败回退 + 局域网/隧道访问空白**（已声明） | 本机 43 张快照中 web 仅 4 张（≈9%）；web 壁纸用户与远程访问用户 | 换壁纸；用回环地址/桌面壳访问 | 不阻塞（已声明；但应标「实验性」并进 README 限制） | AGENT.md:241-242；README.md:80、:246、:281；docs/fixes/library-feature-gap-audit-2026-10-20.md:4、:154 |
| A9 | **子粒子 / ropetrail 未支持（已声明）** | 本机 43 张中「子粒子」命中 12 张（≈28%），另有 ropetrail 少量（依据：2026-10-20 全库审计；v0.8.1–v0.13 未新增该能力） | 换壁纸；提 issue 记录 | 不阻塞 | README.md:63、:260；AGENT.md:233；audit:12、:85 |
| A10 | **开机动画 / 媒体集成 / 视频声音未真机验收** | 使用这几项的用户（开机动画默认关闭；媒体/系统音频依赖特定壁纸与 Windows） | 关闭功能 | **阻塞（1.0 宣称的功能必须有验收记录；否则标「实验性」）** | TESTING.md:465、:481、:516、:545；AGENT.md:289-302 |
| A11 | **i18n 缺失**：面板/提示全中文硬编码 | 非中文用户（DSH 生态有英文用户；README 无英文版） | 无（只能机翻） | 不阻塞（1.0.1/1.x 可做；但 README 至少说明「界面仅中文」） | settings-section.tsx:221-222；render-health.ts:178-185 |
| A12 | **插件页元数据不完整**：无 icon、无本地化展示信息；`screenshots.json` 未被引用 | 从「插件 → 发现」浏览的用户 | 无 | 不阻塞（建议） | package.json（无 icon）；index.json:25-51；screenshots.json |
| A13 | **市场索引时间戳错误**：0.12.0 早 16h、0.13.0 早 8h | 使用索引源的少量用户（展示/排序信息不准） | 无 | 不阻塞（发布工程必修） | index.json:86-107；§8 核对表 |
| A14 | **双锁文件**（npm + pnpm 同时入库） | 贡献者（跟文档用 pnpm 才对） | 按 README 用 pnpm | 不阻塞（建议清理） | package-lock.json、pnpm-lock.yaml、ci.yml:48 |
| A15 | **大壁纸库无分页/虚拟滚动**（产品决策，372px 内滚 + lazy） | 壁纸数百张的用户（少量） | 搜索/筛选 | 不阻塞 | AGENT.md:197（§5.51 决策）；styles.ts:258 |
| A16 | **文档漂移 6 处 + 内部数字钉死** | 贡献者与外部贡献者（信任成本） | 无 | **阻塞（至少修用户可见部分）** | 见 §7 |

**对「用户影响」的补充判断（重要）**：当前 GitHub 0 open issue、Discussions 空、9★，npm 周下载约 1,760（含镜像/爬虫，见 §8）。这说明**有真实用户但没有反馈闭环**——1.0 的收益不是拉新，而是把「支持成本」降下来（诊断/兼容/升级文档）。因此**不建议**把「用户规模/star 数」写成 1.0 门槛（见 §C.4）。

---

## 4. B. 「半成品 / 未接线 UI」清单

> 结论：**没有发现死按钮或点了没反应的控件**。下面是「有意裁剪 / 未暴露 / 缺提示」的清单，按处置建议分。

| # | 项 | 现状 | 性质 | 1.0 建议 | 证据 |
|---|---|---|---|---|---|
| B1 | `frameCacheEnabled` 无面板控件 | 默认 true，只能写 profile config | **有意**（README 自认） | 二选一：挪进「高级/性能」折叠加开关，或在 README 标注「内部字段、无 UI」并保持 | README.md:183、:205；client/settings.ts:32；host/settings.ts:45 |
| B2 | 「关于」区没有版本号 / 无诊断入口 | 只有 Star、反馈、文档三个链接 | **缺失**（不是未接线） | 加版本 + 「复制诊断信息」 | settings-section.tsx:1434-1445 |
| B3 | WebGL2 / WE 缺失 / web 失败 无环境提示 | 只在 console 有警告或静默降级 | **缺失提示** | 在「实时渲染」卡加 3 条自检文案（不改渲染） | render-health.ts:179-185；README.md:280-281；AGENT.md:241 |
| B4 | 用户属性 `text` 类型无控件、`group` 折叠不显示 | 本机 0 样本；面板按「被引用且四类型」过滤 | **有意裁剪** | 面板加一句「部分属性类型暂不支持」或不动 | AGENT.md:260-263；.agents/notes/implemented/feature/2026-10-23-user-properties-full-types.md:44 |
| B5 | 条件不满足的属性置灰禁用 | 有 title 提示「条件不满足」 | **有意** | 保持 | settings-section.tsx:935-1047 |
| B6 | 开机动画「视频不支持平铺」置灰 | 有「视频不支持」hint | **有意** | 保持 | boot-settings-section.tsx:351-359 |
| B7 | 系统音频在桌面 App 不可用、媒体集成非 Windows 不可用 | 面板有原因提示 | **平台限制** | 保持，并把支持矩阵写进 README | settings-section.tsx:1068-1089、:1202-1221；AGENT.md:285、:289 |
| B8 | 壁纸内点击/键盘/滚轮交互不转发（web 与 scene 精灵表同款） | 产品决策：背景层 `pointer-events:none`，不合成点击 | **有意**（但 README 未声明「web 壁纸的点击/键盘不可用」） | 把该边界写进 README 限制清单 | AGENT.md:184-189（§5.48）、:270（§7.42②）；README.md 未提 |
| B9 | 面板无「性能 HUD / FPS」 | 只有装配/首帧耗时与视频健康 | **未做（非 bug）** | 1.0 可不做；诊断包带上 timing 即可 | render-health.ts:158-176 |
| B10 | 插件市场/插件页无图标与本地化展示 | 包无 `icon`/本地化字段；index 有中英 title/desc | **缺失** | 1.0 建议补 icon.svg + `dsh.icon`（低成本） | package.json；index.json:25-51；DSH 0.2.1 release notes |
| B11 | `screenshots.json` 根文件未被任何代码/文档引用 | 静态产物，疑似市场提交用 | **疑似遗留** | 确认用途：要么接进 index/README，要么删除 | screenshots.json；全仓 grep 无引用 |
| B12 | 缩略图 hover 操作按钮（收藏/隐藏）默认透明 | `:focus-within` 与 `hover:none` 已兜底，键盘可达 | **有意** | 保持 | styles.ts:264-266 |

---

## 5. C. 1.0.0 定义方案对比（保守 / 标准 / 激进）

### C.1 推荐定义（一句话，供 Lead 直接采用）

> **`1.0.0` = 本插件对外契约的冻结版本，而不是功能完整版本。**
> 冻结的契约 = ① 支持的 DSH 版本范围（`engines.dsh` + README + index.json 三处一致，覆盖当前 DSH 0.2.x 实测）；② 支持平台矩阵（Windows 完整 / 其它平台明确「未测试」）；③ 设置字段、localStorage 键、数据目录在 1.x 内只增不改（破坏性变更走 major + 迁移）；④ 安装 / 升级 / 卸载 / 诊断四条闭环在文档与 UI 中都可达；⑤ 1.0 宣称为正式能力的功能，都有 Windows 真机验收记录；未验的标「实验性」；⑥ 已知限制继续按 README「使用前请了解」的标准（有声明、有降级、可逃生）。
> **功能完整度（scene 全库覆盖、多平台、i18n、在线 demo）与用户规模（star/下载）不作为 1.0 门槛。**

### C.2 方案对比表

| 维度 | 方案 1 保守（「能装、能升、能报」） | **方案 2 标准（推荐）** | 方案 3 激进（「品类第一」） |
|---|---|---|---|
| 定义 | 把对外契约的最小集补齐即发 1.0 | 契约冻结 + 支持矩阵 + 失败 UX 提示 + 头条功能真机验收 + 文档/合规闭环 | 标准 + 多平台/i18n/demo/web 回退等竞品级能力 |
| 必做项 | engines.dsh + 兼容矩阵（见 C.3-1）；CHANGELOG/发布流程/索引修正；升级章节+版本显示；诊断复制；SECURITY/CONTRIBUTING/ISSUE_TEMPLATE/THIRD-PARTY（轻量）；卸载清理文档；文档漂移修复；media/boot/video 真机验收一轮 | 方案 1 全部 + 失败 UX 三提示（WebGL2/WE/web）+ 旧兼容层删除 + 数据契约文档 + README 结构/文档纠偏 + 可选 icon | 方案 2 全部 + macOS/Linux 冒烟 + i18n zh/en + README.en + 在线 demo + web 壁纸失败回退/LAN 方案 + 大库虚拟滚动 + 功能补洞（子粒子/ropetrail 等） |
| 剩余工作量（人日，估计） | **9–12** | **15–17** | **30–40**（不含功能补洞的 10+） |
| 主要风险 | 1.0 只解决「文档」，用户仍会在升级/排查时受挫；外部感知是「换了个版本号」 | 旧兼容层删除若回归会伤到极少数旧版用户（DSH 自动更新，影响估计 <5%）；真机验收需作者亲自操作 1.5–2 天 | 2–3 个月延迟；DSH API 仍在大改（0.2.x RC）；单人维护；web 回退/局域网是跨源高风险项；收益边际递减 |
| 适合场景 | 作者本周就要发版、且能接受 1.0 只是「更诚实的 0.14」 | 作者愿意花 2–3 周把「1.0 的承诺」做实，且能安排 1–2 天真机验收 | 有外部贡献者/赞助/商业化诉求，或要冲市场排名 |
| Lead 判定建议 | 不推荐作为 1.0（名不副实风险高） | **推荐**；若真机验收做不完，降级为「1.0.0 预发布 = 0.14.0」 | 不建议在 DSH 进入 1.x 前启动 |

### C.3 三方案必须项明细

**方案 1（保守）必须项**

1. `package.json` 增加 `engines.dsh`（范围按实测）；README 兼容矩阵改写为同一范围（删「三版真机验证」旧声明）；index.json engines 同步。**约 2 人日**（含 1–2 个 DSH 版本的安装冒烟）。
2. README 新增「支持矩阵」+「升级」+「数据与隐私」+「卸载与清理」四节。**约 1.5 人日**。
3. 面板：关于区显示插件版本 + 「复制诊断信息」按钮；`.github/ISSUE_TEMPLATE/bug_report.yml`。**约 1 人日**。
4. 发布工程：CHANGELOG.md（0.9→1.0 可追溯即可）；`.github/RELEASE_NOTES_TEMPLATE.md` 增加 1.x 版本规则（semver、破坏性变更定义、索引时间戳自动生成）；修正 index.json 0.12/0.13 时间戳。**约 1 人日**。
5. 合规/协作：SECURITY.md（含本地文件路由/回环限制/无遥测的威胁模型）、CONTRIBUTING.md（构建/测试/提交/决策笔记）、THIRD-PARTY.md（依赖与素材边界）。**约 1.5 人日**。
6. 真机验收一轮：TESTING §2.17 M1–M8、§2.18 B1–B8、§2.19 视频声音、§2.8 看护。**约 1.5 人日**。
7. 文档漂移修复（用户可见部分：README 兼容性、卸载；TESTING §3；technical-notes 系统音频/CI 两处；dev-setup WebGPU）。**约 1 人日**。

**方案 2（标准）增量**

8. 失败 UX：WebGL2 / WE 缺失 / web 壁纸跨源失败 三提示 + README §7.33 声明。**约 2–3 人日**。
9. 旧兼容层删除（§7.34）：settings ns 候选、旧版样式、旧 `settings.yaml` 兼容、相关测试与文档；作为 1.0.0 唯一 breaking change。**约 1.5–2 人日**。
10. 数据契约 v1 文档化：设置字段清单（含 frameCacheEnabled 等无 UI 字段）、localStorage 键全表、数据目录内容与清理、未来变更规则。**约 1 人日**。
11. README 瘦身/使用文档：开机动画、媒体集成、系统音频的「怎么用」独立小节或 docs/usage.md；开发者内容下沉。**约 1.5 人日**。
12. 可选（可推 1.0.1）：icon.svg + `dsh.icon` + README.en.md。**约 2 人日**。

**方案 3（激进）增量**

13. macOS/Linux 冒烟（手填路径 + 非媒体壁纸；无 Mac 硬件则只能文档声明）**3–5 人日**，风险高。
14. i18n 基础（zh/en，面板文案抽 key）**2–3 人日**。
15. 在线 demo（纯前端、不含插件运行时，仅录屏/示意）**2–3 人日**（属于推广，不属于产品门禁）。
16. web 壁纸失败回退（同源代理/超时探测）与局域网 origin 方案 **3–5 人日**，跨源技术风险最高。
17. 大库虚拟滚动/分页 **约 2 人日**（与 AGENT §5.51 的既有决策冲突，需重新评估）。
18. 功能补洞（子粒子、ropetrail、`copybackground`、`clearenabled` 等）**10+ 人日**，且没有明确完成定义（WE 生态无边界）。

### C.4 推荐依据（为什么是方案 2，而不是 1 或 3）

1. **1.0 的语义是「对外的稳定承诺」，不是「功能很多」。** 本项目功能已经远超 0.x 的平均水平；真正会伤害 1.0 口碑的是「升级后壁纸没了 / 收藏没了 / 出问题没法报」这类**契约性事故**，而不是「某张壁纸的子粒子没实现」（README 已声明、且用户可换壁纸）。
2. **宿主仍处 RC，插件 1.0 的承诺必须收敛到「插件可控的边界」。** DSH 是 `0.2.0-rc.1`（本机实测），官方还在改插件兼容判定规则（`engines.dsh`）；此时把「支持所有 DSH 版本 / 所有平台」写进 1.0 是不负责任的。方案 2 用「声明范围 + 支持矩阵」把不确定性显式化。
3. **外部证据显示有用户、无反馈。** 9★、0 issue、周下载约 1,760（含镜像/爬虫）——1.0 的正确收益是把支持成本降下来（诊断/升级/兼容），**不是**拉新；因此 demo/star/功能对齐都不该进 1.0 门槛。
4. **方案 1 省下的只有 4–5 人日，但留下「失败提示缺失 + 旧层继续背 + 数据契约没写」三处会在 1.x 立刻反噬的债**；方案 3 的 web 回退/多平台/i18n 都是 1.x 可增量交付的项，且 web 回退技术上不确定，不该卡 1.0。
5. **1.0.0 是唯一自然的 breaking 窗口**：把 ≤0.1.6 适配层删除放在这里，之后 1.x 才能承诺「只增不改」；否则 1.0 之后还要再破坏一次。

### C.5 1.0.0 DoD（可直接当 Lead 的 gate checklist）

- [ ] G1 `package.json` 有 `engines.dsh`，与 README 支持矩阵、index.json engines **三处一致**，且范围覆盖作者**实际复验**过的 DSH 版本（至少当前 0.2.0-rc.1 / 0.2.1-rc.x 之一）。
- [ ] G2 README 有「支持矩阵」：OS（Windows 完整；macOS/Linux 未测试）、浏览器（Chrome/Edge + WebGL2；HEVC 差异）、宿主（dsh web / 桌面 App）、网络（局域网/隧道下 web 壁纸限制）、WE 安装要求（含「不需要 WE 运行时」的精确表述）。
- [ ] G3 README 有「升级」与「数据/设置兼容」：四条升级路径 + 重启语义 + 设置字段/localStorage 键/数据目录清单 + 1.x 不破坏承诺。
- [ ] G4 面板「关于」显示插件版本；「复制诊断信息」可用（版本/DSH/UA/WebGL2/路径配置/当前壁纸/health/videoHealth/最近警告）。
- [ ] G5 失败 UX 三提示落地：WebGL2 不可用、WE 引擎目录缺失、web 壁纸跨源失败（只提示，不要求修复）。
- [ ] G6 旧兼容层（§7.34）已删除或已在 release notes 明确「继续支持」并给出可复核方式（二选一）。
- [ ] G7 头条功能真机验收：media M1–M8、boot B1–B8、视频声音 §2.19、看护 §2.8 至少各有一轮 Windows 真机记录（TESTING 勾选记录不再是「当前未验」）。
- [ ] G8 发布物：CHANGELOG.md 存在；GitHub Release 按模板写；npm 版本 `1.0.0`；index.json 有 1.0.0 且时间戳与 `npm view time` 一致；tag 推送。
- [ ] G9 合规/协作文件：SECURITY.md、CONTRIBUTING.md、THIRD-PARTY.md、ISSUE_TEMPLATE 均存在；README 有「数据与隐私」与「卸载与清理」。
- [ ] G10 用户可见文档漂移清零：README 不实承诺（:113）、TESTING §3 卸载、dev-setup WebGPU、technical-notes 系统音频/CI 两处、AGENT §7.45 固定静音。
- [ ] G11 市场索引元数据：0.12/0.13 时间戳修正；1.0.0 条目 engines 与包一致；索引 JSON 通过官方 `@deepseek-ai/dsh-plugin-market-index` 校验。
- [ ] G12 发布后 7 天内：至少一条 issue 模板被真实用户使用（或作者自己按模板完整走一遍并把诊断包贴进 issue/Release notes 作为示例）。

> 若 G7 无法完成（作者没有时间做 1–2 天真机验收）：**建议把这次发布命名为 `0.14.0`**，把 1.0 留到下一次——这是备选路径，不是失败。因为 1.0 的承诺恰好依赖「宣称的能力已验证」。

### C.6 工作量与排期假设

- 估算口径：**单人作者、按 6h/人日**、已有强测试基建，不含等待 DSH 发版/外部反馈时间。
- 方案 2 的 15–17 人日可拆两段：第 1 周（G1–G5、G9–G11，约 9–10 人日）→ 第 2 周（G6–G8、G12 演练 + 发布，约 5–7 人日）。
- 若时间只有 1 周：走方案 1 + 失败 UX 三提示（+2 人日）+ 旧层删除（可推迟到 1.1，但 release notes 要写弃用计划），约 12 人日；此时 1.0 仍成立（契约已声明），只是「已知限制的呈现」不如方案 2 完整。

---

## 6. D. 1.0 发布前必须补的文档与合规项清单

| # | 项 | 类型 | 必须/建议 | 现状 | 估时 | 依据 |
|---|---|---|---|---|---|---|
| D1 | `engines.dsh` + README 兼容矩阵 + index engines 三处一致 | 发布元数据 | **必须** | 缺失/不一致 | 0.5d（不含复验） | package.json:38-73；README.md:113/:161/:218；index.json:60-107；DSH release notes |
| D2 | README「支持矩阵」小节 | 用户文档 | **必须** | 无（只有零散一句「仅 Windows 实测」） | 0.5d | README.md:278；dev-setup.md:8 |
| D3 | README「升级」小节（npm / GitHub / 桌面插件页 / index 源 + 重启语义） | 用户文档 | **必须** | 无 | 0.5d | README.md:407-415；DSH 0.2.1 release notes |
| D4 | README「数据与隐私」+「卸载与清理」 | 用户文档 | **必须** | 无；TESTING 清理清单过时 | 0.5d | README.md:272、:407-415；TESTING.md:617-626 |
| D5 | 「数据/设置兼容性」约定（settings 只增不改、localStorage 键表、迁移规则） | 契约文档 | **必须** | 无 | 0.5d | host/settings.ts:5-63；client/settings.ts:15-41；local-store.ts:9 |
| D6 | CHANGELOG.md（至少 0.9.0→1.0.0）+ 1.x 发布规则 | 发布文档 | **必须** | 无；模板只覆盖 0.x（「不引入 major」） | 0.5d | RELEASE_NOTES_TEMPLATE.md:69-72 |
| D7 | SECURITY.md（本地文件路由/回环限制/无遥测/报告渠道） | 合规 | **必须** | 无 | 0.5d | AGENT.md:190、:212；routes.ts:237-258、:436、:452 |
| D8 | CONTRIBUTING.md（构建/测试/提交/决策笔记/壁纸目录只读） | 协作 | **必须** | 无（规范只写在 AGENT.md §6） | 0.5d | AGENT.md:218-227；docs/dev-setup.md |
| D9 | THIRD-PARTY / NOTICE（依赖 + WE 素材边界） | 合规 | **必须** | README 有声明，无独立文件 | 0.5d | README.md:419-425；AGENT.md:146；package.json:41-46 |
| D10 | `.github/ISSUE_TEMPLATE/bug_report.yml`（含诊断必填项） | 协作/支持 | **必须** | 无 | 0.3d | README.md:307-321；.github 目录实测 |
| D11 | 面板版本展示 + 复制诊断信息 | 产品 | **必须** | 无 | 1d | settings-section.tsx:1434-1445；index.ts:391-409 |
| D12 | 失败 UX 三提示（WebGL2 / WE / web 跨源失败） | 产品 | **必须（方案 2）** | 无 | 2–3d | render-health.ts:6/:179-185；AGENT.md:241-242 |
| D13 | 旧 DSH 兼容层删除或明确弃用 | 代码/发布 | **必须（方案 2）** | 双路径仍在 | 1.5–2d | AGENT.md:243（§7.34） |
| D14 | 文档漂移修复（README:113；TESTING §3；dev-setup:69；technical-notes:101/:157；AGENT §7.45；boot note:18；panel-tabs note:32） | 文档 | **必须** | 6 处不一致 | 1d | 见 §7 |
| D15 | index.json 时间戳修正 + 自动生成脚本 | 发布工程 | **必须** | 0.12/0.13 错 16h/8h | 0.5d | index.json:86-107；§8 |
| D16 | README.en.md + icon.svg + `dsh.icon` + 本地化展示信息 | 体验/市场 | 建议（可 1.0.1） | 全部缺失 | 2d | 竞品包（.research-mpkg/package.json:8-20、:27-28）用 icon/README.en/THIRD-PARTY；DSH 0.2.1 release notes |
| D17 | 删除/说明 `package-lock.json`（与 pnpm 二选一） | 仓库卫生 | 建议 | 双锁文件 | 0.1d | 根目录实测；ci.yml:48 |
| D18 | TESTING 增补「1.0 验收清单」一页（把 G1–G12 映射成可勾项） | 测试文档 | 建议 | 无 | 0.5d | TESTING.md §2 |

---

## 7. 外部视角发现的自述盲区（文档/数据不一致）

> 这些不是代码 bug，但直接影响「1.0 文档可信度」；其中 D14 已列入必须项。

| # | 内部叙述（文档） | 外部事实 / 代码现状 | 影响 | 证据 |
|---|---|---|---|---|
| 1 | README.md:113「插件声明的 DSH 版本不兼容时会被拦下」 | `package.json` 无 `engines`，本插件没有可被拦的声明；只有 index.json 有 engines（且仅市场索引路径使用，无上界） | 用户以为有保护，实际没有 | package.json:38-73；index.json:60-107 |
| 2 | README.md:218「同时支持 0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-alpha.2（三版均真机验证）」 vs README.md:161「DSH 0.2.1 起可用索引源」 | 本机宿主为 0.2.0-rc.1；DSH 0.2.1 已改兼容判定规则 | 兼容声明自相矛盾且落后于宿主 | README.md:161/:218；`dsh --version` |
| 3 | AGENT.md:302（§7.45）「固定静音（muted + playsInline，不提供声音开关）」 | v0.13 已加 `bootAnimationSoundEnabled`/`bootAnimationVolume`（README.md:213-214；AGENT.md:216 §5.57） | 贡献者会误判边界；1.0 文档需更新 | AGENT.md:216、:302；README.md:213 |
| 4 | .agents/notes/.../2026-10-30-boot-animation.md:18「放弃项：声音开关」、2026-10-30-panel-tabs-design.md:32「开机动画面板仍固定静音」 | 同 #3，v0.13 已推翻 | 决策笔记与现状脱节（笔记本应记录「为什么」，但「放弃」已被推翻） | 两篇 note 对应行 |
| 5 | docs/technical-notes.md:101「系统音频（supportsaudioprocessing）**尚未接入**」 | v0.9 起已接入（README.md:264；AGENT.md:285 §7.42⑰） | 贡献者被误导；技术文档头部应加「本文更新到 vX」声明 | technical-notes.md:101 vs README.md:264 |
| 6 | docs/technical-notes.md:157「CI……**未在真实 GitHub runner 上跑过**」 | CI 注释已记录 2026-10-10 首次真实 run 实测绿（ci.yml:11、:63） | 同上 | technical-notes.md:157 vs ci.yml:11/:63 |
| 7 | docs/dev-setup.md:69「浏览器支持 **WebGPU** 的 Chrome/Edge（scene 壁纸动画需要）」 | WebGPU 渲染器已于 2026-09-22 删除，现为 WebGL2（AGENT.md:14/:31；README.md:281） | 新贡献者按错误前提装环境 | dev-setup.md:69 vs AGENT.md:14 |
| 8 | docs/dev-setup.md:57「约 373 个用例」 | AGENT.md:226 明令「不钉会漂的数字」；TESTING/README 均不写数字 | 文档自相矛盾（自己定的规则自己破） | dev-setup.md:57 vs AGENT.md:226 |
| 9 | TESTING.md:567/:606 卸载流程（旧 monorepo 路径 + 「WP 浮动按钮」） | 仓库根即插件包；UI 早已是设置页 section，无 WP 按钮 | 卸载文档不可执行 | TESTING.md:567、:606 vs README.md:407-415 |
| 10 | docs/promo/2026-10-27-promotion-plan.md:159「首屏两张 GIF 共 5.7 MB」 | 当前 docs/videos 两个 GIF 共约 **1.0 MB**（342KB + 675KB） | 旧数据不要对外复用（推广物料已改善） | docs/videos 文件大小实测；promo:159 |
| 11 | docs/promo/competitive-2026-10-19/we-product.md:181-191 的「Top 5 产品缺口」 | 多数已在 v0.8–v0.13 落地（轮播/设备效果/库管理/视频兜底/用户属性） | 不能直接拿来做 1.0 缺口清单，只能当历史 | we-product.md:181-191 vs README「能做什么」 |
| 12 | `docs/promo/` 被 `.gitignore` 忽略 | 公开仓库看不到推广/竞品/数据快照；README 无相关引用 | 外部贡献者无法复核「为什么这么定位」；1.0 不要引用这些路径作为对外承诺 | .gitignore（`docs/promo/`） |
| 13 | index.json:86-107 的 publishTimestamp | 0.12.0 比 npm 实际早 16h、0.13.0 早 8h（0.10/0.11 准确，0.9.0 差 26s） | 索引展示/排序信息不准；手工维护不可靠 | §8 核对表 |

---

## 8. 附录：外部数据快照与核对（2026-11-06）

### 8.1 本机 / 生态

| 项 | 值 | 来源 |
|---|---|---|
| 本机 `dsh --version` | `0.2.0-rc.1` | 本机 CLI |
| DSH 最新发布（快照 2026-10-27） | `dsh-v0.2.1-rc.3`（2026-10-23） | docs/promo/raw/harness-releases.json |
| DSH 兼容判定规则变化 | 0.2.1-alpha.4 / rc.1「第三方插件兼容性优先按 `engines.dsh` 判断」 | 同上 |
| npm 最新版本 | 0.13.0（published 2026-11-04T06:35:39Z） | registry.npmjs.org |
| npm tarball | unpackedSize 7,923,877 B；fileCount 191 | registry.npmjs.org |
| npm 周下载（2026-10-29~11-04） | 1,760（含镜像/爬虫，绝对值偏高） | api.npmjs.org |
| GitHub | 9★ / 0 fork / 0 open issue / Discussions 开 / 无 Pages / size 45,377KB / 11 topics | api.github.com/repos/yu502950715yang/dsh-use-wallpaper |
| 本机壁纸库画像（2026-10-20 审计快照） | 43 张：37 scene + 4 web + 2 video；「缺功能」30 张（scene 25 / web 3 / video 2），高 5 / 中 23 / 低 2 | docs/fixes/library-feature-gap-audit-2026-10-20.md:4、:85 |

> 注：壁纸库是本机快照、会漂移（AGENT.md:5 明确不要据此外推）；此处只作「影响面量级」依据，2026-10-20 之后 v0.8.1–v0.13 已修复多项，剩余以 AGENT.md §7 为准。

### 8.2 index.json 时间戳核对（与 npm `time` 对比）

| 版本 | index.json publishTimestamp | npm 实际时间（UTC） | 偏差 |
|---|---|---|---|
| 0.9.0 | 1793065020 | 2026-10-27T01:37:26Z | −26 秒 |
| 0.10.0 | 1793350735 | 2026-10-30T08:58:55Z | 0 |
| 0.11.0 | 1793581576 | 2026-11-02T01:06:16Z | 0 |
| 0.12.0 | 1793611514 | 2026-11-03T01:25:14Z | **−16 小时** |
| 0.13.0 | 1793745339 | 2026-11-04T06:35:39Z | **−8 小时** |

证据：index.json:52-108；`npm view @dsh-use/wallpaper-engine time --json`（本机实测）；`https://registry.npmjs.org/@dsh-use/wallpaper-engine`。

---

## 9. 交付说明

- **本文件**：`docs/release-1.0/product-platform-gaps.md`（唯一写入）。
- **对 Lead 的直接用途**：§C.5 的 G1–G12 可直接作为 1.0.0 的 gate checklist；§3 A 表与 §6 D 表可作为排期输入；§7 盲区表建议同步给维护者/文档 owner。
- **未覆盖（其他 teammate 负责）**：构建/测试/vitest/e2e 实测、渲染/场景功能缺口（render-auditor）、发布工程流水线细节（release-engineer）。本文件不重复这些结论，只在交叉处引用。
- **需要作者确认的 3 个决策**：① `engines.dsh` 最低版本到底定在哪（建议按实际复验的最低 DSH 定，宁高勿低）；② 1.0.0 是否删旧兼容层（推荐删；不删则 release notes 必须写清「继续支持」且可复核）；③ 若 G7 真机验收排不进本期，是否接受把版本号改为 0.14.0（推荐：接受，1.0 留到验证完成）。
