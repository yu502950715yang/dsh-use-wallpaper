# P0 合规与协作文档完成记录（1.0.0）

> 任务：task-8「P0 合规文档：CHANGELOG / CONTRIBUTING / SECURITY / THIRD-PARTY / ISSUE_TEMPLATE / icon」。
> 执行者：docs-compliance；日期 2026-11-10；基准 HEAD `6069b26`（v0.13.1）+ 收口中的未提交改动。
> 本文件只记录本轮交付、数据来源、与现有文档的口径对齐点、需要 Lead 同步/拍板的引用，以及顺带发现的风险。

## 0. 状态摘要

| # | 交付物 | 状态 | 体积 | 数据来源 |
|---|---|---|---|---|
| 1 | `CHANGELOG.md` | ✅ 新建 | 14.5 KB | `gh release view v0.9.0–v0.13.1` 正文 + `git log v0.9.0..HEAD`（94 commits）+ 当前 package.json / README / AGENT §7 |
| 2 | `CONTRIBUTING.md` | ✅ 新建 | 11.3 KB | `package.json` scripts、`.github/workflows/ci.yml`、`docs/dev-setup.md`、`.agents/notes/README.md`、AGENT §3/§5/§6 |
| 3 | `SECURITY.md` | ✅ 新建 | 13.2 KB | `src/host/routes.ts` 实际路由与防护、`src/client/background-layer.ts` 沙箱逻辑、`src/client/scene-script-vm.ts` 沙箱限额、AGENT §5.30/§5.49/§5.54/§5.55、README「数据与隐私」 |
| 4 | `THIRD-PARTY-NOTICES.md` | ✅ 新建 | 7.5 KB | `node -e` 实测 `node_modules` 各包 `version`/`license`（非凭记忆）；`dist/static/` 实际内容；README「许可与致谢」 |
| 5 | `.github/ISSUE_TEMPLATE/bug_report.yml` + `config.yml` | ✅ 新建 | 5.2 + 1.0 KB | README「使用前请了解」反馈清单；`diagnostics.ts` / `settings-section.tsx` 已落地的「复制诊断信息」 |
| 6 | `icon.svg`（仓库根） | ✅ 新建 | 1.7 KB | 自绘 SVG；16/32/64/128 px + 深色底用 headless Edge 实测可读 |
| 7 | `docs/release-1.0/p0-docs-done.md` | ✅ 新建 | 本文件 | — |

未改动任何受保护文件（README / package.json / AGENT / index.json / src / tests / scripts）；未 commit / tag / publish。工作树中的其它未提交改动均来自并行 teammate。

## 1. 数据来源与核实方式（可复跑）

| 结论 | 核实命令 / 证据 |
|---|---|
| CHANGELOG 的 0.9.0–0.13.1 条目 | `gh release list --limit 30`；逐版本 `gh release view <tag> --json name,publishedAt,body`（发布日期取 GitHub Release 时间，本地时区同日）；`git log --oneline v0.9.0..HEAD` 复核 |
| 更早版本边界 | 0.1.0–0.8.2 指向 GitHub Releases 与 git tag；4 个早期 tag 未建 Release（见 `docs/release-1.0/release-engineering-delta.md` §0/①-15） |
| 1.0.0 破坏性变更 | `package.json` 实测：`version 0.13.1`（待 bump）、`engines.dsh ">=0.2.0-rc.1 <0.3.0"`、`engines.node ">=20"`、`types`、`icon`/`dsh.icon`、`dsh.bundle.platforms ["win32"]`；旧适配层已删（`src/client/settings.ts:13` 只剩 `const NS = 'dsh-wallpaper-engine'`） |
| 依赖许可证 | `node -e` 读 `node_modules/<pkg>/package.json`：three 0.170.0 **MIT**、lz4js 0.2.0 **ISC**、quickjs-emscripten 0.32.0 **MIT**、@deepseek-ai/schemastery 3.18.4 **MIT**、@deepseek-ai/cordis 4.0.1 **MIT**；变体 `@jitl/quickjs-wasmfile-release-sync` 0.32.0 **MIT**（读 `.pnpm` 下的包与 README，QuickJS 本体 `2025-09-13+f1139494`） |
| 打包内容 | `dist/client.js` 内含 three / lz4js / quickjs-emscripten-core / release-sync 变体（`dist/client.js` 子串检测为 true）；`dist/static/` = `we_scene_wasm.js` / `we_scene_wasm_bg.wasm` / `quickjs.wasm`（+ 1.0 新增 `WASM_BUILD.json`） |
| 安全边界 | `routes.ts` 逐路由读 handler：boot 两条仅回环（来源地址 + Host 双校验）、UNC/网络路径拒绝、扩展名白名单；其余路由 id/路径白名单 + 根目录前缀二次校验；frame 只写数据目录、仅 `image/png` ≤12MB；`scene-script-vm.ts` 内存 1GB / 栈 4MB / 指令预算中断；`background-layer.ts` 承载 origin 三档（transport / 另一回环主机名 / opaque） |
| 不联网无遥测 | `src/` 内 `fetch` 全部为同源 `/wallpapers/*`；host 无外网请求（只 `reg query` + SMTC PowerShell 子进程） |
| README 引用已就位 | `README.md` 的「许可与致谢」「相关链接」已链 4 个新文件；「升级」段要求 CHANGELOG 的「破坏性变更」段 + CONTRIBUTING 的废弃策略 —— 两边都已提供 |
| package.json 引用已就位 | `files` 已含 `icon.svg` + 4 个文档；`icon` 与 `dsh.icon` 都指向 `icon.svg`；`npm pack --dry-run --json` 实测 203 entries / tarball ≈2.00 MiB，上面 6 个文件 + `LICENSE`/`README` 均在包内 |
| YAML 合法 | PyYAML `safe_load` 解析通过；body item type / id 唯一性 / checkbox option 结构校验通过 |
| 相对链接有效 | 4 个 Markdown 文件的相对链接逐一 `Test-Path`：0 broken |
| icon 可读 | headless Edge 截图（128/64/32/16px + 深色底）：圆角深色底 + 暖色太阳 + 双层山脊，16px 仍能辨认，无文字（临时预览文件在 `%TEMP%`，未入库） |

## 2. 与现有文档的口径对齐（逐条）

| 事实 | 本任务文件中的写法 | 与谁对齐 |
|---|---|---|
| 不重新分发第三方素材 | THIRD-PARTY §5、SECURITY §4.1、CONTRIBUTING §5.2 | README 首屏 /「许可与致谢」、AGENT §5.14/§5.2 |
| 壁纸目录只读（用户明令） | CONTRIBUTING §5.1（不得改工坊文件，只记录+报告） | AGENT §6 |
| `lib/`、`dist/` 入库、改源码必须重建 | CONTRIBUTING §2、§8 | README「构建与开发」、AGENT §3.2 |
| DSH `>=0.2.0-rc.1 <0.3.0`；1.0 删 ≤0.1.6 旧设置路径 | CHANGELOG「破坏性变更」、README 由 Lead 同步 | README「DSH 版本兼容（1.0 起）」、task-9 |
| 1.x 兼容承诺：设置字段 / localStorage / 数据目录只增不改 | CONTRIBUTING §9（废弃策略）、CHANGELOG 破坏性变更末条 | README「升级 → 跨版本兼容承诺（1.x）」 |
| 数据与隐私：无遥测、抓帧缓存、媒体/系统音频只在内存 | SECURITY §4.4（与 README「数据与隐私」同一张表） | README「数据与隐私」 |
| 发布流程 / 发布说明格式 | CONTRIBUTING §9 指向 `.github/RELEASE_NOTES_TEMPLATE.md`；CHANGELOG 头部同样指向 | AGENT §3.2 第 85 行 |
| 依赖版本 / 许可证 | THIRD-PARTY §2（实测值，非记忆） | package.json、pnpm-lock |
| Issue 反馈要素（ID/现象/对比/环境/Console） | bug_report 必填/选填字段 + `[three]`/`[wallpaper-engine]` 日志检索提示 | README「发现壁纸有问题？」 |
| 「复制诊断信息」（1.0 起） | bug_report 顶部 markdown 说明 + 诊断信息 textarea；无该按钮时手动填 | `src/client/settings-section.tsx:630-660`、`diagnostics.ts` |

## 3. 需要 Lead 在 README / package.json / index.json 同步的引用点

1. **README 图标片段**（README 目前没有引用 icon；`package.json` 已引用，市场/插件页可用）。建议二选一：

   ```html
   <!-- ① 标题上方居中图标（推荐，96px） -->
   <p align="center"><img src="icon.svg" width="96" height="96" alt="DSH 壁纸引擎图标"></p>
   ```

   ```html
   <!-- ② 标题行内小图标（30px） -->
   # <img src="icon.svg" width="30" height="30" align="absmiddle" alt=""> @dsh-use/wallpaper-engine
   ```

   注意：**不要**把 `![](../../icon.svg)` 直接塞进 shields 徽章行（SVG 会按 64px 原始尺寸渲染，破坏徽章行高）。
2. **`index.json`**：bump 到 1.0.0 时新增条目的 `engines.dsh` 必须与 `package.json` **逐字一致**（`>=0.2.0-rc.1 <0.3.0`），历史 0.x 条目保持原声明 —— `scripts/check-release.mjs` ④ 会做严格比较（当前主工作树因 index 旧条目与 package 新 engines 不一致，该项按预期判红）。
3. **`package.json`**：`files` 已包含 4 个文档 + `icon.svg`，**无需再改**；bump 版本后 `icon`/`dsh.icon` 自动生效。`scripts.check:release` / `gen:wasm-manifest` 已就位。
4. **README 无需补的**：4 个文件的链接已在「许可与致谢」「相关链接」；升级/兼容/安全/贡献入口均已指向。若想再加一处，可在「构建与开发」末尾加一行 `参与贡献见 CONTRIBUTING.md（提交规范 / 门禁 / PR 流程）`，非必须。
5. **打 tag 前**把 CHANGELOG 的 `## [Unreleased] — 目标版本 1.0.0（未发布）` 改为 `## [1.0.0] - YYYY-MM-DD`，并把文末 `[Unreleased]: compare/v0.13.1...HEAD` 改为 `compare/v1.0.0...HEAD`、新增 `[1.0.0]: releases/tag/v1.0.0`。
6. `.github/RELEASE_NOTES_TEMPLATE.md` 的必选节「破坏性变更（0.x → 1.0）」与 CHANGELOG 破坏性变更段内容需一致（模板已由 release-ops 升级，口径已核对：DSH 下限、删旧适配、平台声明、设置无迁移）。
7. **（可选）README「数据与隐私」表可补两个键**：`we:scenescript:<id>:<key>`（壁纸脚本的 localStorage）与 `we:boot-played`（sessionStorage：本次会话是否已播过开机动画，关页面即清）—— SECURITY §4.4 已按代码实况列出；README 当前表未含这两项，不补也不构成错误（README 已声明「落盘只有两处」的主体）。

## 4. CHANGELOG `[Unreleased]` 条目 → 交付时实际状态（打 tag 前复核）

| CHANGELOG 条目 | 当前工作树证据 |
|---|---|
| `engines.dsh` / `engines.node` / `types` / `icon` / `dsh.bundle.platforms` | `package.json` 已有（version 仍 0.13.1，待 Lead bump） |
| 删除 ≤0.1.6 旧设置层 | `src/client/settings.ts:13` 只剩 `dsh-wallpaper-engine`；`src/host/index.ts`/`settings.ts`、对应 tests 已由 task-9 收口 |
| 面板版本 + 复制诊断信息 | `src/client/diagnostics.ts`、`settings-section.tsx:630-660`（`PLUGIN_VERSION` 由 `scripts/build-client.mjs` 从 package.json define 注入） |
| 环境自检（WebGL2 / WE 目录未配置 / web 无回退） | `src/client/env-check.ts`（三类判定 + 面板消费） |
| release workflow / provenance / check-release / WASM_BUILD.json | `.github/workflows/release.yml`、`scripts/check-release.mjs`、`scripts/gen-wasm-manifest.mjs`、`dist/static/WASM_BUILD.json` 均已存在（见 task-7 的 `p0-release-done.md`） |
| 文档与协作文件 | 本任务 6 类文件（`package.json` files 已含） |
| README「支持矩阵」「数据与隐私」「升级」「卸载清理」 | README 工作树改动已含 |
| index.json 历史 publishTimestamp 修正 | Lead 已改：0.9.0 +26s、0.12.0 +16h、0.13.0 +8h |
| `cargo test` 恢复 | task-7 记录 `cargo test` exit 0（fixture 入库 + duty-cycle 期望订正） |
| 粒子自旋轴序 `Rz·Rx·Ry` | `src/client/threejs-player.ts:396-427` 已改（含注释与测试）；AGENT §7.3 由 task-6 同步 |
| 类型棘轮收紧 2 键 | `scripts/known-type-errors.json` 已收紧（495 条 / 33 键） |
| 移除旧设置路径相关测试 | `tests/host-apply.test.ts` / `tests/client-settings.test.ts` 已改 |

> 注意：上表是**交付时快照**。Lead 统一重建 / 收尾后，请以 `git log v0.13.1..HEAD` 为准逐条复核一次（尤其 release workflow 与诊断信息属于本轮新代码，尚未经历一次完整发布）。

## 5. 顺带发现的风险（不属本任务写域，需 Lead 处置）

### 5.1 硬编码的 quickjs wasm 路径在 pnpm 安装布局下失效（会挡住 `pnpm run build:client`）

- 位置：`scripts/build-client.mjs:89` 与 `scripts/gen-wasm-manifest.mjs:25`/`:71` 硬编码 `node_modules/@jitl/quickjs-wasmfile-release-sync/...`。
- 现象：本机 `node_modules` 已由 pnpm（12.16.1）安装为**符号链接布局**，`node_modules/@jitl` **不存在**（`Test-Path` = False；`node -e require.resolve('@jitl/...')` = `MODULE_NOT_FOUND`），文件实际在 `node_modules/.pnpm/quickjs-emscripten@0.32.0/node_modules/@jitl/...`；`build-client.mjs` 会在复制阶段抛 `[build:client] 未找到 … 构建中止`（exit 1；此时 `dist/client.js` 已写出）。
- 影响：README/CONTRIBUTING/dev-setup 要求的「改完源码必须 `pnpm run build:client` 重建」在干净 pnpm 安装上会失败；`gen:wasm-manifest` 无法重跑。CI/release 的 1c 门禁与 `check-release` ① 只对比 `dist/client.js` 的 git diff 且容忍该 exit code，**不会拦住发布**；但 `check-release` ② 的 quickjs 源哈希校验会因 `existsSync` 为假被**静默跳过**（`scripts/check-release.mjs:109`）。
- 建议二选一（都只需一两行）：
  1. 把 `@jitl/quickjs-wasmfile-release-sync` 加进 `devDependencies`（pnpm 会在 `node_modules/@jitl` 建链接，两个脚本零改动）；
  2. 两个脚本改用 `createRequire(import.meta.url).resolve('@jitl/quickjs-wasmfile-release-sync/package.json')` 定位（或从 `require.resolve('quickjs-emscripten')` 的同级目录解析）。
- 备注：本机 `node_modules` 在 09:06 左右被 pnpm 重装（此前为 npm 扁平布局，所以 task-7 交付时该路径可用）。

### 5.2 `WASM_BUILD.json` 是待提交新文件

重建 wasm 后必须重跑 `pnpm run gen:wasm-manifest` 再提交，否则 `check-release` ② 会红（task-7 已在 `p0-release-done.md` 标注）。

### 5.3 AGENT §7.45 的描述漂移（可选顺手修）

`AGENT.md:310` 仍写开机动画「固定静音（`muted + playsInline`，不提供声音开关）」，与 0.13.0 起的独立「播放声音」开关 + 音量（AGENT §5.57）矛盾。不属本任务写域，留给 Lead 决定是否在收口时顺手改。

## 6. 本任务自检

- 新建文件恰好 7 个（6 类 + 本记录）；`git status` 中它们的形态均为 `??`（未跟踪）。
- 未修改：`README.md` / `package.json` / `AGENT.md` / `index.json` / `src/**` / `tests/**` / `scripts/**` / `.github/workflows/**` / `dist/**`（工作树内这些文件的改动均来自其它 teammate）。
- 未 commit / tag / push / publish。
- 文件语言：简体中文，技术词保留原文；无装饰性废话；结论直给。
- `icon.svg`：`viewBox="0 0 64 64"`，`role="img"` + `<title>`（无可见文字），自包含渐变（不依赖 `currentColor`，深浅主题下都可用）。
