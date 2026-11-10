# 贡献指南

面向想改代码、补文档或提 PR 的人。**改代码前先读 [`AGENT.md`](./AGENT.md)**（架构、硬约束、踩坑记录）与 [`docs/superpowers/specs/`](./docs/superpowers/specs/) 下对应的设计文档 —— 这一步能省掉大部分返工。

- 发现壁纸渲染不对：先看 README「使用前请了解」，仍无法解释的按 [Issue 模板](https://github.com/yu502950715yang/dsh-use-wallpaper/issues/new?template=bug_report.yml) 提 issue。
- 安全问题：**不要开公开 issue**，按 [`SECURITY.md`](./SECURITY.md) 的渠道报告。

## 1. 开发环境

| 工具 | 版本 | 用途 |
|---|---|---|
| Node.js | **22**（`engines.node >= 20`；CI 用 22） | host 侧 ESM 编译、vitest、e2e |
| pnpm | **9**（CI 用 9，本机新版亦可） | 包管理；仓库 lockfile 是 `pnpm-lock.yaml` |
| Rust + `wasm32-unknown-unknown` + wasm-pack | 最新稳定版 | 只在改 `wasm/` 时需要 |

- 本仓库是 pnpm workspace，**用 `pnpm` 而不是 `npm install`**。`package-lock.json` 是历史遗留文件，不要用 `npm ci` / `npm install` 更新依赖。
- 完整的环境初始化（Rust 镜像 403、esbuild 放行构建脚本、wasm target 手工安装等坑）见 [`docs/dev-setup.md`](./docs/dev-setup.md)。
- 当前**只在 Windows 上开发与实测**（CI 也是 `windows-latest`）；macOS / Linux 行为未验证。

```bash
pnpm install
# 把本仓库挂进 DSH web profile（必须在仓库根执行）
dsh plugin --profile web add link:E:/code/dsh-use-wallpaper
```

## 2. 构建链（铁律）

```bash
pnpm run build         # tsc -p tsconfig.json → lib/（strict）
pnpm run build:wasm    # cd wasm && wasm-pack build --no-opt --target web --release --features cpu-sim → wasm/pkg/
pnpm run build:client  # node scripts/build-client.mjs → dist/client.js + 复制 wasm 到 dist/static/
```

1. **改了 `wasm/`（Rust）必须先 `build:wasm` 再 `build:client`**。`build:client` 只复制 `wasm/pkg/` 的现成产物，顺序反了会把旧 wasm 复制进 `dist/static/`（行为不更新，且难排查）。`wasm/pkg/` 缺失时 `build:client` 会直接报错。
2. **`lib/` 与 `dist/` 入库**（`.gitignore` 不含它们），发布包 `files` = `lib` + `dist` + `cordis.patch.yml` 等。**改完源码必须重建再提交**：CI 的 typecheck job 会重跑 `tsc` / `build-client` 并断言与入库产物零差异，产物不新鲜直接判红。
3. **不要手改构建产物**（`lib/`、`dist/client.js`、`dist/client.js.map`、`dist/static/*`）—— 改源码后重建。
4. **不要提交第三方素材**：`dist/static/` 只应有自建 wasm（`we_scene_wasm.*`）、`quickjs.wasm` 与 wasm 溯源清单；WE 内置纹理（`ptex-*.tex`）永久禁止入库 / 进包（见 §5）。

## 3. 测试与门禁

| 命令 | 说明 | 是否可在无本机素材时跑 |
|---|---|---|
| `pnpm test` | 全量 vitest（node + jsdom 双环境） | ✅ |
| `pnpm run typecheck:tests` | tests 侧 `tsc --noEmit` + 类型错误棘轮 | ✅ |
| `pnpm run verify:arch` | host / client / shared 分层与环境边界守卫（规则自带红测样本） | ✅ |
| `pnpm run e2e:colorblend` | 渲染 e2e，逐像素判据；CI 里跑的就是它 | ✅（需 headless Edge） |
| `pnpm run verify:local` | 综合门禁（架构 / tsc / lib 新鲜度 / dist 新鲜度 / 测试类型基线 / vitest + 失败基线 / e2e colorblend / 工作树卫生） | ✅ |
| `cd wasm && cargo test` | Rust native 单测 | ✅（需 Rust） |
| `pnpm run e2e:hidpi` / `e2e:isolated-rt` / `e2e:media` / `e2e:web-pointer` / `e2e:compare` | 需本机 WE 壁纸库或真实素材的渲染验收 | ❌ |

- **测试基线口径**：`scripts/known-failures.json` 是 vitest 的「新增失败」基线（当前为空，套件级错误一律判红）；`scripts/known-type-errors.json` 是 tests 侧 `(文件, TS 错误码)` 计数的**棘轮**（只允许收紧，`--update` 才放宽）。**不要把已知失败当通过**。
- ⚠️ `verify:local` 的「产物新鲜度」两步会**还原入库副本**：改了 `src/` 后请先 `pnpm run build && pnpm run build:client` **再**提交；在同一轮里先跑 `verify:local` 会把刚构建的 `dist/` 还原成入库版本（提交会漏产物）。
- 渲染 / 坐标 / 粒子 / 材质语义的改动：先写失败测试（`tests/`），再改代码，最后按需跑 e2e 并记录结论；**不能只靠肉眼「看起来对了」**。
- 测试沙箱：vitest / esbuild / headless Edge 都依赖 service 子进程，受限沙箱下会报 `spawn EPERM` —— 用完整权限运行（见 `AGENT.md` §5.13）。

## 4. 提交规范

格式（与 `AGENT.md` §6 一致）：

```
type(scope): 中文标题

可选正文，最多 3 行（改了什么 / 关键根因一句 / 怎么验证）。
```

- **语言**：提交信息、注释、文档一律简体中文；代码、命令、文件名、技术术语保留原文。
- **type**：`feat` / `fix` / `docs` / `style` / `refactor` / `test` / `chore` / `release`（`perf` 并入 `fix` 或 `refactor` 均可）。
- **scope**：模块名，如 `scene` / `puppet` / `effect` / `media` / `boot` / `audio` / `host` / `client` / `ui` / `settings` / `ci` / `notes` / `release`。
- **正文从简**：不贴实验数据、不复述推理、不列文件清单 —— 细节写进 `AGENT.md` / `docs/` / 决策笔记。
- **一个提交一件事**：功能改动与 `chore(release): vX.Y.Z` 分开；发布提交只含版本号、README 版本行、索引等发布相关文件。
- 注释同样从简：默认一行说清「是什么 / 为什么」，最多 2 行；不写多段推理。

## 5. 硬约束（必须遵守）

1. **壁纸目录只读（用户明令）**：Steam 工坊目录（`steamapps/workshop/content/431960/`）里是用户自己的作品，**不得修改其中任何文件**（含 CSS / JS / HTML）。发现壁纸侧缺陷（资源 404、脚本报错、布局溢出等）**只记录 + 报告**，修复只能落在插件侧 —— 需要用户去创作源里改。
2. **不重新分发第三方素材**：WE 壁纸、纹理、shader、音视频的版权归原作者 / Wallpaper Engine。插件在运行时从**用户本机**的 WE 安装目录与 workshop 目录读取，不打包、不上传。`dist/static/` 只有自建 wasm 与 quickjs wasm；`ptex-*.tex` 等 WE 纹理永久禁止入库（`.gitignore` 有兜底规则）。
3. **`lib/`、`dist/` 与源码同步**：见 §2；提交前先重建。
4. **坐标 / 混合 / 行序 / 时长等语义先读 `AGENT.md` §5**（那是踩过的坑，不是建议）；改动渲染路径前先确认对应设计文档。
5. **不要往文档里钉会漂的数字**（测试项数、全库素材计数这类以实测输出为准）；能力未达成就在 `AGENT.md` §7 如实写明，不要宣称「全库支持」。

## 6. 决策笔记（Agent Notes）

改了**行为、架构、跨文件契约、流程与工具链、测试策略、落盘 / 网络格式、需求方向或范围**时，在 `.agents/notes/` 下新建或就地更新一篇决策笔记。

- 规则与布局见 [`.agents/notes/README.md`](./.agents/notes/README.md)；操作细节见项目技能 [`.agents/skills/intent-notes/SKILL.md`](./.agents/skills/intent-notes/SKILL.md)。
- 路径 = `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`：生命周期 `proposed` / `implemented` / `rejected` / `archived`；分类 `feature` / `bug-fix` / `simplification` / `architecture` / `process` / `testing`。
- 笔记只写**为什么**和**放弃了什么**；契约与现状写 `AGENT.md` / `docs/`，两者互链。不要建 `INDEX.md`。
- 会话开始跑一次锚点校验：`node .agents/skills/intent-notes/scripts/verify-note-anchors.ts .`
- 纯机械改动（格式化、无歧义重命名、不改行为的样式调整）不写笔记。

## 7. 不要提交什么

`.gitignore` 已覆盖，但仍请注意：

- `research/`、`.research-mpkg*/`：一次性调研 / 探针 / 参考实现源码（**未入库**，可能已被清理）。
- `e2e/.out/`、`research/**/out/`：e2e 截图与临时 Edge profile（避免上千文件 / 上百 MB）。
- `wasm/pkg/`：Rust 构建中间产物（最终 wasm 由 `build:client` 复制进 `dist/static/`）。
- `.vitest-report.json`、`*.log`：测试报告与日志。
- `docs/promo/`：推广与竞品调研物料（仅本地保留）。
- `.superpowers/`、`.playwright-cli/`、`output/`、`.pw-local/`、`.worktrees/`：本地工作目录与验证产物。
- 临时截图、导出视频、`node_modules/`、个人 profile / 壁纸路径。

## 8. PR 流程

1. **先搜 issue / PR**，避免重复；大改动先开 issue 说清动机与影响面（或先给 `docs/superpowers/specs/` 设计草案）。
2. Fork → 分支（建议 `feat/xxx`、`fix/xxx`）→ 提交。
3. 提交前本地跑：
   ```bash
   pnpm run build && pnpm run build:client   # 产物入库，先重建
   pnpm test && pnpm run typecheck:tests && pnpm run verify:arch
   pnpm run e2e:colorblend                   # 只有 Edge 即可
   pnpm run verify:local                     # 以上 + 工作树卫生；跑完产物会还原，必要时重建后再提交
   ```
4. PR 描述写清：**改了什么 / 为什么 / 怎么验证 / 影响面（壁纸类型、平台、设置字段）**，关联 issue。
5. **CI 三道门禁必须全绿**（`.github/workflows/ci.yml`，`windows-latest`）：
   - `typecheck`：`verify:arch` + `tsc --noEmit` + `lib/` 与 `dist/client.js` 产物新鲜度 + tests 类型棘轮；
   - `test`：全量 vitest，**只对新增失败判红**（基线 `scripts/known-failures.json`）；
   - `e2e`：headless Edge 跑 `e2e:colorblend` 逐像素判据（软件光栅化，不需要 GPU）。
6. 由维护者合并；合并后如涉及用户可见行为，需同步 `CHANGELOG.md` 与 README（见 §9）。不要自行改版本号、打 tag 或发布 npm。

## 9. 版本与废弃策略

发布流程与发布说明格式见 [`.github/RELEASE_NOTES_TEMPLATE.md`](./.github/RELEASE_NOTES_TEMPLATE.md)；发布前的单命令检查是 `pnpm run check:release`（产物新鲜度 / wasm 溯源 / npm pack 内容 / `engines` 一致性，任一失败非零退出）。契约变更以发布说明模板 + `CHANGELOG.md` 为准，本仓库采用 **SemVer 1.x 语义**：

- **major**：破坏性变更（删 / 改设置字段、localStorage 键、数据目录格式、降级链语义、安装方式）。
- **minor**：新增用户可见能力（面板 / 默认值 / 降级链 / 索引 / 安装体验），可含新增设置字段。
- **patch**：修复与不影响契约的体验调整。
- **DSH 兼容**：抬**上界** = minor（允许在新 DSH 上跑）；抬**下界**或删除旧适配层 = major。
- **1.x 兼容承诺**：设置字段、localStorage 键、抓帧数据目录**只增不改**；重命名 / 删除只能走 major，并在 `CHANGELOG.md` 给出迁移步骤。
- **废弃窗口**：先标记 deprecated，至少保留一个 minor 后再删除；删除时写进 `CHANGELOG.md` 的「破坏性变更」段。
- **回填规则**：每个用户可见改动都要能对应到 `CHANGELOG.md` 的一条；纯内部重构不写。

## 10. 许可

本仓库代码为 **MIT**（见 [`LICENSE`](./LICENSE)）。提交贡献即表示同意以 MIT 协议分发（inbound = outbound）。第三方依赖与素材边界见 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)；请勿提交版权不明或不允许再分发的素材。
