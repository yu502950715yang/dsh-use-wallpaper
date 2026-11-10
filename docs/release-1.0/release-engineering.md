# 从 v0.13.0 到 1.0.0：发布工程与质量门禁审计

- 审计对象：`@dsh-use/wallpaper-engine` v0.13.0（HEAD `0056109`，2026-11-04 14:39:02 +0800）→ 拟发布 1.0.0
- 审计日期：2026-11-06
- 审计方式：**全部结论以本次实测为准**，不采信文档自述；11 条必测命令全部执行并记录 exit code，另补 5 项交叉核验
- 审计约束：只读分析 + 运行命令；未修改源码 / `package.json` / 配置；未做 git tag/commit/push；未执行 `npm publish`；唯一写入文件为本报告
- 环境：Windows（pwsh）、Node `v22.22.1`、pnpm `12.16.1`、npm `10.9.4`、cargo `1.96.0`、wasm-pack `0.15.0`、gh `2.96.0`（已登录 `yu502950715yang`）、`dsh --version` = `0.2.0-rc.1`、Edge 可用（e2e 实际跑通）
- 工作区恢复确认：审计开始与结束时 `git status --short` 除另一位团队成员产出的 `docs/release-1.0/`（未跟踪）外无变化；`lib/`、`dist/` 每次构建后已 `git checkout -- lib dist` 恢复，最终 `git diff -- lib dist` 为空；临时日志在系统临时目录，e2e 截图在 gitignore 的 `e2e/.out/`

---

## 结论摘要

**三道 CI 门禁本身是绿的，且本地一条命令（`pnpm run verify:local`）8/8 复现通过；但「v0.13.0 → 1.0.0 发布」在工程上还没准备好。** 最关键的 5 条：

1. **DSH 兼容声明完全缺失且已过时**：`package.json` 无 `engines.dsh`、无 `@deepseek-ai/dsh*` peer ⇒ DSH（已核验 0.2.2-rc.1 源码）对插件**不施加任何版本约束**；README 仍声称只验证过 `0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-alpha.2`（2026-09-23），而 DSH 已发到 `0.2.2-rc.1`（本机 CLI `0.2.0-rc.1`），0.2.x **零验证记录**；`index.json` 的 `engines.dsh: ">=0.1.5-rc.3"` 无上界、与实测版本不符。
2. **发布动作没有任何 CI 门禁**：CI 只由 `push master` / PR / 手动触发，**tag 推送不跑 CI**；无 release/publish workflow；`master` 分支**未做保护**（无 required checks）；`npm publish` 从工作树手工执行且无 `prepublishOnly` 门禁 ⇒ 「发布的字节」与「门禁验证过的字节」之间没有机械绑定。
3. **Rust 侧实测红**：`cargo test` 在干净克隆下**根本编译不过**（`particle_stagger_test.rs` 用 `include_str!` 引用 gitignore 的 `research/` 文件），且 AGENT.md §7.42⑤ 记录的既有失败 `override_rate_keeps_duty_cycle` 仍然失败（7 passed / 1 failed）；cargo **不在 CI 门禁内**，`wasm/src → dist/static/*.wasm` 也没有新鲜度守卫。
4. **1.0 的发布语义尚未定义**：发布 checklist 明确写「不引入 major」（`.github/RELEASE_NOTES_TEMPLATE.md:72`），没有 breaking change 定义、废弃窗口、支持窗口、预发布通道；项目至今 25 个 npm 版本**从未发过预发布**（0 个 `-rc`），却以约 3 天一个版本的节奏推进——1.0 的「稳定承诺」与现状不匹配。
5. **测试质量债会被 1.0 固化成基线**：`scripts/known-failures.json` 已空（✅ 机制可留），但 `scripts/known-type-errors.json` 实测仍有 **495 条类型错误 / 33 个键**（基线 35 键 / 500 条），其中 **418 条集中在 `tests/three-renderer.test.ts` 一个文件**；1.0 若不清零，等于对「测试是类型安全的」这一承诺开口子。

**建议路径**：先发 `1.0.0-rc.1`（`next` dist-tag）做 0.2.x 真机矩阵 + 全量手工验收，同时把下列 P0 项做完；P0 全绿后再发 `1.0.0` 正式版。若坚持「1.0 = 稳定承诺」，更稳妥的是**等 DSH 0.2.x 出正式版再发 1.0.0**（当前 DSH 最新仍是 `0.2.2-rc.1`）。

---

## A. 门禁现状表

### A.1 实测总表

> 判定口径：🟢 = 与 CI 同口径实测通过；🟡 = 命令成功但结论需要 1.0 治理；🔴 = 实测失败；⚪ = 无法运行/未覆盖。「是否 1.0 阻塞」按「1.0 正式版 tag 之前是否必须解决」判定。

| # | 门禁 | 实测命令 | 本次实测结果 | 失败详情 / 关键数字 | 是否 1.0 阻塞 |
|---|---|---|---|---|---|
| 1 | 架构边界 | `pnpm run verify:arch` | 🟢 PASS，exit 0 | 自检 6 条规则 / 15 份红测样本通过；扫描 92 个 `src` 文件全部合规 | 否 |
| 2 | tsc strict + `lib/` 产物新鲜度 | `pnpm run build` → `git status --short` | 🟢 PASS，exit 0 | tsc 无输出；构建后工作区 **零差异**（等价 CI 的 `tsc` + `git add -A -- lib/` + `git diff --cached`） | 否 |
| 3 | `dist/client.js` 产物新鲜度 | `node scripts/build-client.mjs` → `git status --short -- dist/` | 🟢 PASS，exit 0 | 写出 `client.js`（1,684,411 B）+ `.map`（4,075,936 B）；复制 `we_scene_wasm*` 与 `quickjs.wasm`（503,134 B）成功；`dist/` **零差异** | 否 |
| 4 | tests 侧 tsc 棘轮 | `pnpm run typecheck:tests` | 🟢 PASS，exit 0 | 类型错误 **495 条 / 33 个 (文件,码) 键**；基线 500 条 / 35 键；2 个键「已修复未收紧」（`synthetic-library.test.ts|TS2339`、`verify-real-library.test.ts|TS2339`） | **是（建议）**：门禁绿但存量大，见 B.7 |
| 5 | 全量 vitest | `pnpm test` | 🟢 PASS，exit 0 | **106 个测试文件 / 2161 项，全部通过**（0 失败、0 跳过），12.35s；含本机全库回归（41 个 `scene.json`、206 套效果链零失败） | 否 |
| 6 |「只对新增失败判红」 | `vitest run --reporter=json` + `node scripts/check-known-failures.mjs .vitest-report.json` | 🟢 PASS，exit 0 | `总计 2161，通过 2161，失败 0（基线内 0）`；known-failures 基线为空数组，机制有效 | 否 |
| 7 | 渲染 e2e（headless Edge 逐像素） | `pnpm run e2e:colorblend` | 🟢 PASS，exit 0 | 5/5 判据 PASS（mode=7 / mode=0 / 跨模式亮度对比 / 背景不受影响）；截图 `e2e/.out/colorblend`；本机无需 GPU（SwiftShader 档） | 否 |
| 8 | 发布包内容 | `npm pack --dry-run --json` | 🟡 可运行，需治理 | exit 0；**191 entries**；tarball **2,054,152 B**、unpacked **7,923,877 B**；`lib` 182 文件 + `dist` 5 文件 + `cordis.patch.yml`；**wasm 3 个产物齐全**（171,799 / 11,281 / 503,134 B）；无第三方 `.tex` 泄漏；但 `dist/client.js.map` 占 unpacked 的 **52%**、`lib/client`（tsc 产物，1.26 MB/144 文件）是否必要待确认（见 B.3/B.9） | 否（有优化空间） |
| 9 | GitHub CI / Release 记录 | `gh run list --limit 60`；`gh run view`；`gh release list` | 🟢/⚠️ 混合 | 近 60 次 run：**52 成功 / 8 失败**，8 次失败全部集中在 **2026-10-10**（CI 落地当天 + 同日 Dependabot 交叉 PR，失败点是当时尚未生效的 e2e 步骤/动作版本）；此后全绿。最新 run `41786937891` 的 `typecheck`/`test`/`e2e` 三个 job 均 success。**21 个 Release**，最新 v0.13.0（2026-11-04）；**4 个 tag 无 Release**（v0.1.0 / v0.2.0 / v0.3.0 / v0.3.1，历史遗留） | 否（历史记录可补/可忽略） |
| 10 | 版本口径与发布节奏 | `git tag --list`；`git log -1 --date=iso`；`npm view … versions/time/dist-tags` | 🟢 一致 | 25 个 tag（v0.1.0→v0.13.0）；npm 25 个已发布版本、**0 个预发布**、dist-tags 只有 `latest=0.13.0`；`index.json` 最新版本 0.13.0 且 `publishTimestamp` 与 npm `time[0.13.0]` 一致（1793745339）；`git tag` 与 `package.json` 版本一致；HEAD 之后仅 1 个 index 回填提交。节奏：v0.1.0（2026-08-24）→ v0.13.0（2026-11-04）= **72 天 25 个版本（≈2.9 天/版）**，最近 4 个版本集中在 6 天内 | 否（节奏策略见 B.1） |
| 11 | Rust 测试 | `cargo test`（`wasm/`）；`cargo test --test particle_override_test` | 🔴 RED | `cargo test` **exit 101**：`tests/particle_stagger_test.rs:19` 的 `include_str!("../../research/2851992662-particles-presets-leaves5.json")` 引用的文件是 **gitignore 的 `research/` 内容且本机不存在** ⇒ 干净克隆/CI 无法编译该 test target；定向 `cargo test --test particle_override_test` **exit 101**：7 passed / 1 failed，`override_rate_keeps_duty_cycle` 报 `基准稳态应有粒子，got 50`（与 AGENT.md §7.42⑤ 记录一致）。**cargo 不在 CI 门禁内** | **是**（若 1.0 声称 Rust 测试可用；至少修复编译失败，见 B.7/B.9） |
| 12 | 本地综合门禁（补充核验） | `pnpm run verify:local` | 🟢 PASS，exit 0 | 8/8 PASS：架构 / tsc / `lib/` 新鲜度 / `dist/client.js` 新鲜度 / tests 类型基线 / vitest+失败基线 / e2e colorblend / 工作树卫生；结论「全部通过 ✅」 | 否 |
| 13 | 插件市场索引合法性（补充核验） | 用官方 `@deepseek-ai/dsh-plugin-market-index@0.2.1-alpha.4` 的 `parseMarketIndex(index.json, …)` | 🟢 PASS | `VALID format-1 index`；插件版本 0.9.0→0.13.0 五条，均 `engines={"dsh":">=0.1.5-rc.3"}`（**无上界、与 0.2.x 无关**）；**该校验不在 CI 中**，README 只声称「已用官方包校验」 | 索引格式不阻塞；`engines` 口径阻塞（B.5） |
| 14 | 双 lockfile 一致性（补充核验） | `npm ci --dry-run` | 🔴 RED，exit 1 | `npm error Invalid: lock file's @deepseek-ai/cosmokit@1.8.2 does not satisfy @deepseek-ai/cosmokit@1.9.0`；另实测 `package-lock.json` 根依赖与 `package.json` 有 **3 处差异**：`@deepseek-ai/schemastery`（pkg `^3.18.4` / lock `^3.18.1`）、lock 里仍留着已删除的 `@deepseek-ai/dsh-settings@^0.1.0-rc.6` 与 `@webgpu/glslang@^0.0.15`。`pnpm-lock.yaml` 与 package.json 同步（pnpm 12 依赖校验 + CI 冻结安装均通过）。两个 lockfile 同时入库 | 否（CI 走 pnpm）但发布工程须收口（B.4/B.6） |

### A.2 门禁结论之外、但直接影响 1.0 可信度的实测发现

1. **「门禁绿」≠「发布绿」**：上述 8 条绿全部验证的是**工作树里已提交的产物**；由于 `lib/`、`dist/`、`dist/static/*.wasm` 都入库，而 tag 不触发 CI、publish 无 `prepublishOnly`，发布时完全可能出现「tag 指向未跑过 CI 的提交」或「本地忘了重建产物」——后者被 `lib`/`dist` 新鲜度守卫覆盖，**wasm 未被覆盖**。
2. **DSH 兼容检查机制已实测**（用 npm 上 `@deepseek-ai/dsh-app-boot@0.2.2-rc.1` 源码核验，非猜测）：
   - `lib/index.js:1096-1112`：清单声明 `engines.dsh` 时**只由该范围决定**（忽略 peer）；否则检查 `peerDependencies` 中 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的每个范围；**两者都未声明时不施加版本约束**；`satisfies()` 用 `semver.satisfies(..., { includePrerelease: true })`，**预发布版本参与匹配**。
   - 本项目 `package.json` 两个都**没有**（peer 只有 `@deepseek-ai/cordis ^4.0.1`）⇒ DSH 目前**不会拦任何版本**，包括未来不兼容版本。`index.json` 的 `engines.dsh` 只进市场索引（官方校验器只检查它是合法 SemVer range，明确「不检查生成器义务」），**运行时不读它**。
   - 同一份 DSH 源码（0.2.2-rc.1）还提供平台声明机制：`dsh.bundle.platforms`（Node 平台名数组，如 `["win32"]`；省略 = 允许所有平台）；Host 不受支持时启动器会跳过整个组合包层并在 `skippedBundles` 报告原因。本项目 `dsh.bundle` 只有 `patch`，**未声明平台**。
3. **README 兼容声明已过期**：README `:218` 称「同时支持 0.1.5-rc.3 / 0.1.6-alpha.2 与 0.1.7-alpha.2（三版均真机验证）」，日期 2026-09-23。而 DSH `0.2.0-rc.1` 发布于 **2026-09-28**、最新 `0.2.2-rc.1` 发布于 **2026-11-04**（与本项目 0.13.0 同日），本机 CLI 已是 **0.2.0-rc.1**；仓库里除 README `:161` 提到「DSH 0.2.1 起可加索引源」外，**没有任何 0.2.x 兼容验证记录**（`git grep '0\.2\.[0-9]'` 无实质验证文档）。AGENT.md §7.34 的触发条件（README 最低支持版本 ≥ `0.1.7-alpha.1`）在 1.0 场景下应当重新裁定。
4. **分支保护实测缺失**：`gh api repos/…/branches/master/protection` 返回 **404 Branch not protected**；仓库 `delete_branch_on_merge=false`、公开、9 stars。发布流程完全依赖人工纪律。
5. **发布产物无 provenance**：`npm view @dsh-use/wallpaper-engine@0.13.0 dist` 只含 registry `signatures`（发布者身份），**无 `attestations` 字段** ⇒ 未用 `npm publish --provenance`，1.0 若想做供应链声明需要改发布通道。
6. **文档漂移（1.0 对外承诺的一部分）**：`docs/dev-setup.md:17` 仍称「本项目是 pnpm workspace」，`:69` 仍要求「支持 WebGPU 的浏览器」（实现早已是 three.js/WebGL2）；`TESTING.md:3` 仍写 DSH GUI `http://127.0.0.1:3080`、Node ≥ 18（CI 用 Node 22）、前置条件仍描述 profile `package.json` + `pnpm install` 的旧多包形态；`.agents/notes` 的 2026-09-22 笔记已把这类漂移记为「既有问题（本次未修）」，至今未修。
7. **历史全量测试日志**：`.vitest-full.log` 存在（2026-10-30 13:14，**96 文件 / 2010 项全过**，11.19s），是 0.12.0 时代快照（`*.log` 被 gitignore，不入库）；当前为 106 文件 / 2161 项。它不能替代 1.0 RC 的实测，只作趋势参考。

---

## B. 1.0.0 发布工程缺口清单

> 每条格式：**实测现状** → **1.0 要求** → **具体动作**。优先级：P0 = 1.0 正式版前必须做；P1 = 强烈建议在 1.0 前做；P2 = 1.0 之后可做但需登记。

### B.1 版本语义（0.x 语义 vs 1.0 语义）

**实测现状**
- `.github/RELEASE_NOTES_TEMPLATE.md:67-72` 的「定版本号」只有两条规则：新增用户可见能力 → minor；修复/微调 → patch；**「不引入 major」**；唯一性以 npm 为准。
- 25 个 npm 版本、25 个 tag、0 个预发布；发布节奏 ≈2.9 天/版（v0.1.0 2026-08-24 → v0.13.0 2026-11-04）。所有版本从 `latest` 直接发布，没有 RC/`next` 通道。
- 没有定义「什么算破坏性变更」，也没有废弃窗口、支持窗口、回滚/撤回策略。

**1.0 要求**
1. 明确 **1.0.0 承载破坏性变更**，把 0.x 阶段不便做的清理一次做完（至少包含：抬高 DSH 最低支持版本并删除 ≤0.1.6 旧适配层；补 `engines.dsh` 门禁；补平台声明；可能收窄包内容）。**1.0.0 之后**：breaking → 2.0.0；新增能力 → 1.x.0；修复 → 1.x.y；不允许在 1.x 内破坏（含设置字段重命名/删除、默认值改变、localStorage/数据目录键变更、host HTTP 路由契约变更、`exports`/`files` 收窄、DSH 最低版本抬高）。
2. 定义**什么算「用户可感知」**（用于 minor/patch 判定）：面板控件与文案、设置默认值、降级链行为、e2e 判据语义、索引/安装方式。纯内部重构、注释、测试不计。
3. 定义**废弃窗口**：计划删除的能力先用一个 minor 在 README/发布说明标「deprecated」（并打日志），下一个 major 才删。
4. 定义**DSH 兼容策略**（与 B.5 联动）：插件 1.x 的 `engines.dsh` 上界如何随 DSH 升级调整——若 DSH 自身升到不兼容版本，插件必须发 2.0.0 还是允许在 1.x 内抬 `engines.dsh` 上界（推荐：**抬上界属于 minor，抬下界/删旧适配属于 major**）。
5. 引入**预发布通道**：`1.0.0-rc.N` → `npm publish --tag next` + GitHub Pre-release；RC 冷却期（建议 ≥3 天或至少覆盖 1 次 DSH 0.2.x 真机全量验收）后 `npm dist-tag add @dsh-use/wallpaper-engine@1.0.0 latest` 晋升。
6. 明确**发布节奏承诺**：现状 3 天/版不适合 `1.0 = 稳定` 的预期。建议 1.0 后改为「patch 随修随发、minor 按月聚合」，或至少在 README 声明「1.x 可能高频发布 patch，但遵循 semver」。

**动作**：把上述写成 `.github/RELEASE_NOTES_TEMPLATE.md` 里的「版本语义」小节 + 一份 `docs/release-1.0/versioning-policy.md`（本报告不改模板，仅给出待落文案要点）。**验收**：任意一次版本号选择能从规则表机械推导出来；发布说明里能区分「破坏性/新增/修复」。

### B.2 发布流程 checklist 需改写的地方

**实测现状**（`.github/RELEASE_NOTES_TEMPLATE.md:67-82`，10 步）
- 第 1 步是 0.x 语义（见 B.1）；第 2 步用 `npm version`（但仓库实际用 pnpm 构建，且存在两个 lockfile，`npm version` 只动 `package-lock.json`）；第 3 步构建 + 门禁是**手工串联**命令，没有产物「已恢复干净」的断言；第 4 步只要求提交版本号/README/索引；第 5 步 tag 之后直接 push，**不等 CI**；第 6-7 步写说明并建 Release；第 8 步 npm 发布（手写临时 `.npmrc` token）；第 9 步索引回填；第 10 步只验证 npm/GitHub/tag 存在。
- 模板里 0.x 的历史格式仍在用（v0.10.0 标题无主题、v0.11.0 标题超长），说明模板约束靠人记。

**1.0 要求 + 动作**
1. 第 1 步替换为 B.1 的 1.0 语义表；明确「1.0.0 必须带迁移说明」。
2. 第 2 步统一包管理器：删除陈旧 `package-lock.json` 或明确只维护 pnpm；bump 用 `pnpm version --no-git-tag-version`（或手工改 + 两处 lockfile 同步检查），并断言 `git status` 只含预期文件。
3. 第 3 步改为「一条命令验收」：`pnpm run verify:local`（已实测 8/8 绿）+ 新增 wasm 一致性检查（B.9）+ `npm pack --dry-run` 内容/体积快照 + **结束后 `git status` 必须干净**（含 `lib/`、`dist/`、`dist/static/`）。
4. 第 4 步补：CHANGELOG（B.8）、迁移文档、README 兼容矩阵与「npm registry 当前最新」行、`package.json` 的 `engines.dsh`/`dsh.bundle.platforms` 变更都要在**同一个 release commit** 里。
5. 第 5 步补：**tag 必须打在 CI 已绿的 SHA 上**；push 后要求 tag 触发的 workflow（新增）成功，否则不得发布；记录 run URL。
6. 第 6 步模板补两个 1.0 专用小节：`## ⚠️ 破坏性变更（0.x → 1.0）`（必选）与升级步骤；标题规则允许 major 主题。
7. 第 7 步：RC 阶段用 `--prerelease`；正式版确认 `gh release view` 的 `isPrerelease=false` 且为 latest。
8. 第 8 步：RC 用 `npm publish --tag next`；正式版 `--tag latest`；优先在 CI 用 OIDC `--provenance`（当前 CI `permissions: contents: read`，需要新增 `id-token: write` 的 release job）；token 方式保留但要求一次性 token + 2FA + 发布后立即清 `.npmrc`。
9. 第 9 步：发布后**跑官方 `parseMarketIndex` 校验**（本次已实测可通过，见 A.1-13）并把 `engines.dsh` 与 peer 范围对齐；等 npm `time[version]` 落定后再写 `publishTimestamp`（现有做法正确）；push 后抓一次 jsDelivr URL 确认 CDN 生效。
10. 第 10 步补「安装冒烟」：在**全新 DSH profile** 里 `dsh plugin add @dsh-use/wallpaper-engine@X.Y.Z` + `dsh web`，验证设置页出现、选中壁纸、刷新恢复；这是从 npm 消费真实包的唯一验收，当前流程没有。

**验收**：checklist 每一步都能对应到可执行命令与「通过判据」；一次演练（dry-run，不真发）能在 checklist 上走通。

### B.3 包内容 / files / exports

**实测现状**（`npm pack --dry-run --json` + `npm view`）
- tarball **2,054,152 B**、unpacked **7,923,877 B**、**191 files**；发布内容 = `lib/`（182 文件）+ `dist/`（5 文件）+ `cordis.patch.yml` + npm 自动带上的 `README.md`/`LICENSE`/`package.json`。
- 包含 3 个运行时二进制：`dist/static/we_scene_wasm_bg.wasm`（171,799 B）、`we_scene_wasm.js`（11,281 B）、`quickjs.wasm`（503,134 B）——**未漏**；无第三方 `.tex`（历史上曾因 245 文件/33.5 MB 的 `ptex-*.tex` 撑大包体，现机制靠 `.gitignore` + 构建脚本注释，**无自动断言**）。
- 大头：`dist/client.js.map` **4,075,936 B**（unpacked 的 52%）、`dist/client.js` 1,684,411 B、`lib/client` **1,261 KB / 144 文件**（tsc 产出的浏览器侧代码；运行时 client 由 `dist/client.js` 提供，`exports` 里没有任何路径指向 `lib/client`）。
- `package.json` **没有** `types` 字段、`exports` 里没有 `types` 条件（`lib/host/index.d.ts` 实际存在）；无 `publint`/`attw` 校验、无 pack 内容快照测试；未随包提供第三方许可声明（bundle 里含 three.js MIT、lz4js、quickjs（MIT）等）。

**1.0 要求 + 动作**
1. **确认 `lib/client` 是否被 DSH 运行时读取**（`dsh.client.platform` 的组合包加载路径可能按约定读 `dist/`；本次未把 DSH 装机拆到能证明的粒度）。若否：`files` 收窄为 `lib/host`、`lib/shared`、`dist/client.js`、`dist/client.js.map`（按决策）、`dist/static`、`cordis.patch.yml`，预计 unpacked 减少 ~1.26 MB。
2. **决策 sourcemap 是否随包发布**：保留 = 用户可在 DevTools 调试；去掉 = unpacked 立减 52%。建议保留但写入「包体积预算」。
3. 增加 `"types": "./lib/host/index.d.ts"` 与 `exports` 的 `types` 条件；跑 `publint`（及 `@arethetypeswrong/cli`）确认。
4. 增加第三方许可清单（`THIRD-PARTY-NOTICES` 或 README 段落），覆盖打包进去的 three.js / lz4js / quickjs-emscripten —— 1.0 对外发布时的合规最低要求。
5. 把 `npm pack --dry-run --json` 的关键指标（entryCount / size / static 产物存在 / 不含 `*.tex` / 不含 `src|tests|docs`）做成 CI 断言，阈值用「相对基线 ±10%」或白名单；1.0 前把基线写进脚本。
6. 若改 `files`/`exports`，必须重跑「全新 profile 从 npm 安装 + 启动」冒烟（B.2-10）。

**优先级**：P1（包体 2.05 MB 尚可接受，但 1.0 应有预算与自动断言）。

### B.4 依赖与 peerDependencies 版本范围

**实测现状**
- `peerDependencies`：仅 `@deepseek-ai/cordis: ^4.0.1`。
- `dependencies`：`@deepseek-ai/schemastery ^3.18.4`、`lz4js ^0.2.0`、`quickjs-emscripten ^0.32.0`、`three ^0.170.0`。
- `devDependencies` 含 `react/react-dom ^18.3.1`、`@types/react ^18.3.0`、esbuild、vitest、TypeScript 等；构建时 `react`、`react-dom`、`react/jsx-runtime` 被 esbuild 标为 external，运行时由 DSH 的 `window.__ModuleLoader__` 提供。
- 本机 DSH `0.2.0-rc.1` 自身依赖 `@deepseek-ai/cordis ~4.0.4`、`@deepseek-ai/schemastery ~3.18.4`；插件 peer `^4.0.1` 能接受 4.0.4；插件 dependency `^3.18.4` 与 DSH 的 `~3.18.4` **范围不一致**（若 3.19 发布，插件会装 3.19 而 DSH 用 3.18.x，出现双实例风险）。
- 无 `engines`（node 也不声明）；无 `packageManager`；无 `@deepseek-ai/dsh*` peer；无 `os`/`cpu`。
- DSH 0.2.2-rc.1 的 `dsh.bundle.platforms` 机制可用于声明平台（见 A.2-2）。

**1.0 要求 + 动作**
1. **加 `engines.dsh`**：按 1.0 实测矩阵写成有下界+上界的范围（例：`">=0.2.0-rc.1 <0.3.0"`，DSH 用 `includePrerelease: true` 判定，预发布参与匹配）。**不要只依赖 `index.json`**（运行时只读包清单）。
2. 决定是否保留 `@deepseek-ai/dsh*` peer：既然声明了 `engines.dsh`，peer 会被忽略（DSH 0.2.2-rc.1 语义），不要重复声明以免歧义；`@deepseek-ai/cordis` peer 保留（DSH 对非 dsh 前缀 peer 不做版本门禁，但安装器可能用它做 peer 解析）。
3. 对齐 `schemastery` 范围到 DSH 的 `~3.18.4`（或改为 peer）并实测 `.volatile()` 行为；避免双实例。
4. 加 `packageManager: "pnpm@<CI 版本>"`，并把 CI（pnpm 9）与本机（pnpm 12.16.1）统一；同时加 `engines.node`（CI 用 22；README/TESTING 现在写 ≥18，需一致）。若决定 1.0 只支持 Node ≥22，这是文档口径变化而非代码破坏。
5. 平台声明：`dsh.bundle.platforms: ["win32"]`（若 1.0 不为 macOS/Linux 背书，见 B.5）；或者不声明、但在 README/索引声明「Windows only, best-effort elsewhere」。推荐前者——它让不被支持的 Host 在启动时就被 DSH 跳过并报告原因，而不是装上了才坏。
6. 记录运行时共享依赖风险：external 的 `react` 由 DSH 提供，当前本机无法从 asar 外核验 DSH 0.2.x 实际 React 主版本（DSH 包装在 app.asar 内）；1.0 RC 前必须在 0.2.x 真机确认组件渲染无版本告警。devDeps 的 React 18 只影响本地测试，不影响产物。

**优先级**：P0（1-2、5）、P1（3、4、6）。

### B.5 DSH 兼容矩阵

**实测现状**
- README `:218-232`：声称同时支持 `0.1.5-rc.3` / `0.1.6-alpha.2` / `0.1.7-alpha.2`（三版均「真机验证」，日期 2026-09-23），并写「旧版兼容层是过渡性的，待 DSH 新版本稳定后按迁移文档 §9 清理」。
- AGENT.md §7.34 给出触发条件：README 声明最低 DSH 版本 ≥ `0.1.7-alpha.1` 即可删旧适配层；清理清单在 （历史计划已清理；结论并入 AGENT §5.34）（A 可删 / B 可简化 / C **必须保留的 0.1.7 适配**）。
- 旧适配层代码仍在：
  - `src/client/settings.ts`：`NS_CANDIDATES = ['dsh-wallpaper-engine', 'wallpaper-engine']`（0.1.7 条目 id + ≤0.1.6 短名回退）；
  - `src/host/index.ts`：`settings.register(...)` 旧分支（`typeof settings?.register === 'function'`）；
  - `src/host/settings.ts`：非 volatile 的 `WallpaperSettingsSchema`（只为旧路径保留）；
  - `src/client/styles.ts`：`:where(...)` 低具体度 z-index 技巧（为不覆盖旧版 DSH 的 40）；
  - 测试：`tests/host-apply.test.ts`（`SettingsMode = 'legacy' | 'modern' | 'none'`、旧路径用例）、`tests/client-settings.test.ts`（旧短名/回退阶梯用例）、`tests/styles.test.ts`（具体度断言）。
- **0.2.x 无验证记录**；DSH 已从 0.1.7（2026-09-22）走到 0.2.2-rc.1（2026-11-04），期间 7 次插件发布都没有更新兼容声明。
- 声明机制实测（A.2-2）：`engines.dsh` / dsh peer 二者皆无 ⇒ 运行时不拦版本；索引 `engines.dsh=">=0.1.5-rc.3"` 无上界、且不参与运行时判定。

**1.0 要求 + 动作**
1. **把 0.2.x 纳入矩阵并真机验证**：至少 `0.2.0-rc.1`（本机 CLI 版本）与 `0.2.2-rc.1`（当前 latest）；验证项：安装、设置页列表/读写、选中壁纸刷新自动恢复、右栏四态样式、媒体/声音功能（Windows SMTC）、无 console 报错。矩阵同时列 Edge/Chrome（WebGL2）与 Windows 版本。
2. **把删除旧适配层作为 1.0 的破坏性变更**（推荐）：执行迁移文档 §9 的 A/B 清单 + 配套测试删改 + 文档更新，**只保留 §9.C 的 0.1.7 适配**。判据：`git grep 'wallpaper-engine'` 只剩 0.1.7 命名空间；`tests/host-apply.test.ts` 的 legacy 模式删除；README 兼容段改为新矩阵。收益：降低双路径维护面（本报告已实测这些代码与测试仍在）。
3. **声明 `engines.dsh`**（B.4-1）：若删除 ≤0.1.6 适配，下界至少 `0.1.7`；若同时把 0.2.x 定为唯一支持线，下界写 `0.2.0-rc.1`。上界 `<0.3.0`（或按 DSH 后续节奏）。该声明会让旧 DSH 用户安装被拦——**这正是 1.0 的 breaking 点，必须写进发布说明/迁移文档**。
4. 更新 `index.json`：新版本条目的 `engines.dsh` 与 `package.json` 保持一致（有上界）；历史条目保持原样（不改历史）。
5. 删除或改写 README `:232` 的「旧版兼容层是过渡性的」段，改为「0.x → 1.0 迁移说明」链接。

**优先级**：P0（1-3）、P1（4-5）。

### B.6 CI / platform 覆盖

**实测现状**
- `.github/workflows/ci.yml`：3 个 job（typecheck / test / e2e），**全部 `windows-latest`**、Node 22、pnpm 9（`pnpm/action-setup@v5 version: 9`）；`on: push branches [master] / pull_request / workflow_dispatch`（**无 tag 触发**）；`permissions: contents: read`；`concurrency cancel-in-progress`。
- 覆盖内容：`tsc --noEmit`、`lib/` 与 `dist/client.js` 新鲜度、tests 类型棘轮、vitest+已知失败基线、**仅 1 条** e2e（colorblend）。
- 未覆盖：cargo test / wasm 构建与产物一致性；`npm pack`/安装冒烟；index.json 校验；docs/README 一致性；任何发布/发布后验证；macOS/Linux（**且 README 声明仅 Windows 实测**）。
- 其余 e2e（`e2e:card`、`hidpi`、`isolated-rt`、`media`、`media-perf`、`textclock`、`web-pointer`、`compare`、`verify-v081`、`verify-v082`）需要本机 WE 壁纸库 / DSH `app.asar` / 真 GPU，**长期只在人工验收时跑**（AGENT.md §3.1 已如实标注）。
- 工具链漂移：本机 **pnpm 12.16.1**（有「Verifying lockfile against supply-chain policies」等新行为），CI 固定 **pnpm 9**；`pnpm-workspace.yaml` 里有 `allowBuilds: esbuild`（pnpm 10+/11 的构建脚本批准机制，pnpm 9 忽略）。`package.json` 无 `packageManager`。
- 本地 8 条门禁一键复现（`verify:local`）已实测 8/8 绿，但没有接进任何 CI 或 git hook。
- CI 历史：近 60 次 run 52 绿 8 红，红全部集中在 2026-10-10 落地当天（不是当前代码的问题）；之后无红。**tag 推送不触发 CI**（实测 `gh run list` 中无 tag 事件运行、近期 release commit 的 CI 只来自 `push master`）。

**1.0 要求 + 动作**
1. **新增 `release.yml`**（P0）：`on: push tags: ['v*']` 或 `workflow_dispatch`，跑 `verify:local` + 新增的 wasm/打包断言；成功后才允许发布（publish job 加 `environment: npm` 保护 + `id-token: write` 用 `npm publish --provenance`）。
2. **分支保护**（P0）：`master` 开 required checks（typecheck/test/e2e）、禁止直推、tag 保护（`v*` 只允许 release 流程创建）。
3. **补 CI 缺口**（P1）：cargo test（修好 B.7 的编译问题后加 job，windows-latest 有 Rust 还是需 setup；至少 `cargo test --lib` + 指定测试）；`npm pack` 内容断言；`parseMarketIndex(index.json)` 校验；`package.json` 与 `index.json` 的 `engines.dsh` 一致性检查。
4. **统一工具链**（P1）：`packageManager` + `.node-version`/`engines.node`；CI 与本地 pnpm 大版本对齐（升 CI 到 pnpm 11/12 需处理 `allowBuilds` 批准）。
5. **平台支持矩阵**（P1）：1.0 对外声明「Windows 10/11 + Edge/Chrome（WebGL2）+ DSH 0.2.x（Windows）」，并在 `package.json` 用 `dsh.bundle.platforms: ["win32"]` 声明；若希望保留 macOS/Linux 的「best-effort」，则不开 platforms、但 README 明确「不支持、不修」。**不声明 = 当前默认的行为，属于 1.0 应改掉的模糊状态。**
6. **双 lockfile 收口**（P1）：二选一（推荐 pnpm），删除 `package-lock.json` 或把它纳入 CI 校验；当前 `npm ci` 已被实测证伪（A.1-14）。
7. **发布冒烟放进 CI 或至少脚本化**（P1）：从 npm 拉取刚发布的版本 → 全新 profile 安装 → 启动 → 断言设置 section 出现。

**优先级**：P0（1、2）、P1（3-7）。

### B.7 测试基线清零

**实测现状**
- `scripts/known-failures.json`：**空数组**（2026-09-22 归零后一直保持）；本次实测 2161/2161 全过。**结论：这份基线不需要「清零」，应保持为空并保留机制**（它是「新增失败即红」的 allowlist，删机制反而丢防线）。
- `scripts/known-type-errors.json`：**35 个键 / 500 条**基线；本次 `tsc -p tsconfig.tests.json` 实测 **495 条 / 33 键**（2 键已修复但未 `--update` 收紧）。分布高度集中：
  - `tests/three-renderer.test.ts`：TS2339 ×216、TS2345 ×101、TS2722 ×93、TS7006 ×5、TS2349 ×3 = **418 条（占 84%）**
  - `tests/tex-loader.test.ts` TS18048 ×10；`tests/threejs-player.test.ts` 合计 23；其余分散在 19 个文件。
- `cargo test`：**整体编译失败**（`include_str!` 引用 gitignore 的 `research/` 文件，干净克隆必红），外加 AGENT.md §7.42⑤ 记录的既有失败 `particle_override_test::override_rate_keeps_duty_cycle`（本次实测仍失败）。
- 覆盖盲区已如实记录：`vi.fn()` 桩不受接口约束、同文件同码计数守恒位移会漏判（AGENT.md §3.3）。
- 全库回归 `tests/verify-real-library.test.ts` 依赖本机壁纸库，CI 上走 `skipIf`（= 不跑），本机实测 9 项全过（41 scene / 108 image / 193 particle / 206 效果链零失败）。

**1.0 要求 + 动作**
1. **known-type-errors 建议在 1.0 前清零**（判断：**应当清零，至少清零 84% 的集中部分**）。理由：1.0 是「质量承诺」版本，而 495 条的 84% 在单文件，修它的边际成本最低；剩余的分散错误可按文件分批。若时间不够，最低要求：
   - 先 `node scripts/check-known-type-errors.mjs --update` 收紧已修复的 2 个键；
   - 把「基线冻结」写进 1.0 release notes（明确 known limitation：tests 侧 tsc 仍有 N 条历史错误，门禁只防新增）；
   - 在 CI 加「基线条数不得增长」的显式断言（现在天然满足，但需要文件锁）。
2. **修复 cargo 编译失败**：把 `wasm/tests/particle_stagger_test.rs` 的 `include_str!` 改为入库的 `wasm/tests/fixtures/` 夹具，或把该测试标 `#[ignore]`；修复后 cargo 才可能进 CI。
3. **处置已知失败** `override_rate_keeps_duty_cycle`：先判定是「测试期望错」还是「实现错」（AGENT.md 说待订正期望）；1.0 前必须红转绿或加入显式基线并写进文档。
4. 把 `cargo test` 纳入 CI（Windows runner 需装 Rust/设置 target；成本低）。
5. RC 阶段跑一遍 `TESTING.md` §2.1–2.19 的手工验收清单（当前最后一批人眼验收日期为 2026-10-23 / 2026-11-04，**不是 1.0 RC 的提交**），逐项打勾并归档截图/日志。

**优先级**：P0（2、3）、P1（1、4、5）。

### B.8 CHANGELOG / 发布说明 / 索引源

**实测现状**
- **没有 `CHANGELOG.md`**（仓库根无此文件）；历史靠 21 个 GitHub Release 承载，但 **4 个 tag 无 Release**（v0.1.0–v0.3.1），且早期标题格式不统一（v0.10.0 无主题；v0.11.0 标题长）。
- `RELEASE_NOTES_TEMPLATE.md` 是 0.x 语义（五节固定分组），**没有「破坏性变更」必选节**、没有迁移步骤节。
- `index.json`：format-1 **合法**（官方解析器实测通过），`plugins[0].versions` 只含 0.9.0→0.13.0（早期版本未收录）；`engines.dsh` 全部 `>=0.1.5-rc.3`（无上界、无 0.2.x 语义）；`screenshots.json`（2 张宣传图路径）在仓库中**无任何引用**（只在 2026-09-23 的提交里声明，索引/README/CI 都不用）——1.0 前应确认其用途或删除。
- 索引更新是发布后的手工 commit（流程第 9 步），本次核对 `publishTimestamp` 与 npm `time` 一致（说明人工纪律目前靠得住，但无自动校验）。

**1.0 要求 + 动作**
1. 建 `CHANGELOG.md`（Keep a Changelog 风格或「按 GitHub Release 汇总」），至少包含 **0.x 阶段里程碑汇总 + 0.13.0→1.0.0 完整条目**；此后每个 release 必须更新（可写进 checklist + CI 检查文件是否变更）。
2. 模板补：`## ⚠️ 破坏性变更（0.x → 1.0）` 必选节（列出 DSH 最低版本抬高、旧适配层删除、平台声明、包内容变化）、`## 升级步骤`（含 npm/pnpm/profile 操作与回滚命令）、标题规则允许 major 主题。
3. 历史 4 个无 Release 的 tag：要么补建（低成本、可自动化），要么在 1.0 发布说明里说明「早期版本无 Release」，避免用户困惑。
4. `index.json`：1.0 条目 `engines.dsh` 与 peer/包清单对齐；把官方校验写进 CI；发布后抓 CDN URL 验证；`screenshots.json` 确认用途（若为市场截图素材，转成索引正式字段或写入文档；否则删）。
5. 索引历史版本是否补 0.1.0–0.8.2：非必须（市场只展示可安装版本），但 1.0 发布说明里应说明「索引自 0.9.0 起收录」。

**优先级**：P1（1-4；其中破坏性变更节为 P0 内容）。

### B.9 npm 包体积与 wasm 产物入库策略

**实测现状**
- wasm 产物**入库**：`dist/static/we_scene_wasm_bg.wasm`（171,799 B）、`we_scene_wasm.js`（11,281 B）、`quickjs.wasm`（503,134 B，来自 `node_modules/@jitl/quickjs-wasmfile-release-sync`）；`wasm/pkg/` 是 **gitignore**；`wasm/target/` 也是 gitignore。
- 构建链：`build:wasm`（wasm-pack `--no-opt --target web --release --features cpu-sim`）→ `build:client` 时复制 `wasm/pkg/*` → `dist/static/`。本机 wasm-pack `0.15.0` 可用；`wasm/Cargo.lock` 入库；Rust 源码最后一次改动与 `dist/static/we_scene_wasm_bg.wasm` 最后一次提交是**同一个 commit**（`1b7a306`，2026-10-20，「fix(particle): starttime 预推进按 override.rate 换算」）——当前产物与源码同步，但**同步只是纪律，不是门禁**。
- **无任何 wasm 新鲜度守卫**：CI 不构建 wasm、不比对 `dist/static/*.wasm` 与 `wasm/src` 的对应关系；`lib`/`dist/client.js` 有守卫，wasm 是盲区。若某次只改 Rust 不改 wasm，客户端会静默用旧模拟器（编译、单测可能全绿）。
- 打包体积：wasm 合计 686,214 B（约 0.65 MB），占 tarball 2.05 MB 的约 1/3 压缩前比例合理；真正的体积大头是 sourcemap 与未用的 `lib/client`（B.3）。
- 可复现性风险：`rustup target list --installed` 只列出 `x86_64-pc-windows-msvc`，但 `rustlib` 目录下**存在** `wasm32-unknown-unknown`（状态不一致，需在干净环境复核）；本报告**未重跑 `build:wasm`**（避免污染 gitignore 产物与时间成本），也未验证跨机 wasm 字节可复现。

**1.0 要求 + 动作**
1. **建立 wasm 产物溯源**（P0，最省成本的强保障）：在 `dist/static/` 放一个入库的 `WASM_BUILD.json`（`wasm/src` 的 commit sha + wasm-pack/rustc/cargo 版本 + 产物 sha256 + 构建命令），并在 `build:client` / CI 里校验清单与现有产物一致；任何 wasm 源码变更必须同步更新清单（可人工，但可被 CI 比对发现）。
2. **CI 增加 wasm 构建一致性 job**（P1）：`wasm-pack build` 后比较产物 sha256 与入库值。若跨机不可复现（wasm-bindgen 版本、路径嵌入等），退化为「构建成功 + 产物大小/导出符号一致」的软断言，并把差异记录进文档。
3. 明确 wasm 发布策略（入库二进制 vs 发布时构建）：现状「入库」支持 `link:`/HMR 与免构建安装，1.0 维持入库，但**必须补门禁**；`dist/static/quickjs.wasm` 与 node_modules 版本绑定（lockfile 已固定），在溯源文件里也记录其版本。
4. 决定 sourcemap 与 `lib/client` 的取舍（B.3），给 tarball 设预算（如 ≤ 2.5 MB；当前 2.05 MB 达标）。
5. 记录 wasm 重跑前置条件到 README/AGENT：`wasm-pack`、`rustup target add wasm32-unknown-unknown`、`--no-opt` 原因（本机 wasm-opt 权限）、构建顺序铁律（先 wasm 后 client，已在 AGENT §3.1）。

**优先级**：P0（1）、P1（2-5）。

### B.10 缺口优先级汇总

| 优先级 | 缺口 | 对应小节 | 粗估工作量 |
|---|---|---|---|
| P0 | 声明 `engines.dsh` + `dsh.bundle.platforms`（或明确只支持 win32） | B.4/B.5/B.6 | 0.5–1 d（含验证） |
| P0 | DSH 0.2.x 真机兼容矩阵（至少 0.2.0-rc.1 / 0.2.2-rc.1） | B.5 | 1–2 d |
| P0 | 删除 ≤0.1.6 旧适配层（按迁移文档 §9 A/B，保留 C） | B.5 | 1–2 d |
| P0 | tag 触发 release workflow + `master` 分支保护 + publish 前门禁 | B.2/B.6 | 1 d |
| P0 | 修复 `cargo test` 编译失败 + 处置既有失败 | B.7 | 0.5 d |
| P0 | 1.0 版本语义/破坏性变更/迁移文档 + 发布说明模板改版 | B.1/B.2/B.8 | 1 d |
| P1 | 收紧/清零 known-type-errors（优先 three-renderer.test.ts 418 条） | B.7 | 2–4 d |
| P1 | wasm 产物溯源/一致性门禁 | B.9 | 0.5–1 d |
| P1 | 包内容治理（types 条件、lib/client、sourcemap、publint、第三方许可） | B.3 | 1 d |
| P1 | 双 lockfile 收口 + packageManager/engines.node 统一 | B.4/B.6 | 0.5 d |
| P1 | CHANGELOG + index 校验进 CI + screenshots.json 处置 | B.8 | 0.5 d |
| P1 | RC 全量手工验收（TESTING §2.1–2.19） | B.7 | 1 d |
| P2 | 4 个历史 tag 补 Release、索引补早期版本、docs 漂移（dev-setup/TESTING）修正 | B.8/A.2 | 0.5 d |

---

## C. 发布执行清单（从 bump 到 npm publish 到索引更新到验证）

> 每步给出**通过判据**。命令假设在仓库根、Windows/pwsh、已登录 npm 与 gh。`<X.Y.Z>` 对 1.0.0 填 `1.0.0`（先跑 RC 时用 `1.0.0-rc.1`）。

### C.0 一次性前置（1.0 正式版之前完成，非发布日动作）

- [ ] P0 项全部完成（B.10）；`pnpm run verify:local` 8/8 绿且 `git status` 干净。
- [ ] `release.yml` 存在且能在 tag 上跑通（先 `workflow_dispatch` 演练一次）。
- [ ] `master` 分支保护开启（required checks: typecheck/test/e2e）。
- [ ] `engines.dsh`、`dsh.bundle.platforms`、`packageManager`、`engines.node` 已定稿并真机验证。
- [ ] 1.0 迁移文档、CHANGELOG、发布说明草稿已写完并 review。

### C.1 发布日步骤

| # | 步骤 | 命令 / 动作 | 验收判据 |
|---|---|---|---|
| 1 | 预检工作区 | `git status --short`、`git fetch --tags`、`git log -1` | 只允许已知未跟踪文件；HEAD 是计划发布的 commit；本地与 `origin/master` 同步 |
| 2 | 跑全量门禁 | `pnpm run verify:local` | 8/8 PASS、exit 0、工作树仍干净；记录耗时 |
| 3 | 验证包内容 | `npm pack --dry-run --json` + wasm 溯源校验 | 191 左右 entries / tarball ≤ 预算 / wasm 3 件齐全 / 无 `*.tex` / `WASM_BUILD.json` 一致 |
| 4 | bump 版本 | `pnpm version <X.Y.Z> --no-git-tag-version`（或手工改 package.json + 同步 lockfile） | 仅 `package.json`（+lockfile）变化；无 `package-lock.json` 漂移（若保留则同步） |
| 5 | 更新发布文件 | CHANGELOG、README「npm 当前最新」、兼容矩阵、`index` 版本不含（索引在发布后）、迁移文档链接 | `git diff` 只含预期文件；文档渲染无坏链 |
| 6 | release commit | `git add -A` → `git commit -m "chore(release): v<X.Y.Z>"`（中文正文 ≤3 行） | 提交内不含功能改动；`git show --stat` 与预期一致 |
| 7 | 重建产物并复查 | `pnpm run build && pnpm run build:client` → `git status --short` | 产物零差异（守卫通过）；无新增未跟踪文件 |
| 8 | 打 tag | `git tag -a v<X.Y.Z> -m "v<X.Y.Z>"` | tag 指向 release commit；`git show v<X.Y.Z>` 正确 |
| 9 | push 并等 CI | `git push origin master && git push origin v<X.Y.Z>`；等 `release.yml`/CI | tag 对应 workflow run **success**；记录 run URL；若红则停止，不得发布 |
| 10 | 写发布说明 | 按模板（含破坏性变更/迁移节）存 `e2e/.out/release-notes-v<X.Y.Z>.md` | 五节结构合规；破坏性变更节非空（1.0 必选）；版本号只出现在允许位置 |
| 11 | 建 GitHub Release | RC：`gh release create v<X.Y.Z> --title … --notes-file … --verify-tag --prerelease`；正式：去掉 `--prerelease` | `gh release view v<X.Y.Z>` 的 `isPrerelease`/latest 状态正确；tag 已存在 |
| 12 | npm 发布 | RC：`npm publish --tag next [--provenance 若走 CI]`；正式：`npm publish --tag latest` | `npm view <pkg>@<X.Y.Z> dist.integrity` 存在；退出码 0；`.npmrc` 临时文件已删除 |
| 13 | 验证 npm 元数据 | `npm view <pkg> version dist-tags versions --json` | `version=<X.Y.Z>`；正式版 `dist-tags.latest=<X.Y.Z>`；RC 时 `next` 指向 RC 且 `latest` 不动 |
| 14 | 安装冒烟（关键） | 全新 profile：`dsh plugin --profile audit add "@dsh-use/wallpaper-engine@<X.Y.Z>"` → `dsh plugin --profile audit install` → `dsh web --profile audit`（或按当前 CLI 语法） | 插件出现在 profile；设置页「壁纸」section 渲染；选择壁纸后刷新自动恢复；console 无未处理异常 |
| 15 | 更新市场索引 | npm `time[<X.Y.Z>]` 取真实秒数 → 写 `index.json` 的 `plugins[0].versions`（`engines.dsh` 与包清单一致）→ 官方 `parseMarketIndex` 校验 → commit `chore(release): 插件市场索引补 <X.Y.Z>` → push | 校验器 VALID；`publishTimestamp` == npm time；jsDelivr URL 抓取返回新内容；index commit 的 CI 绿 |
| 16 | 发布后验证 | `gh release list --limit 3`、`git ls-remote origin refs/tags/v<X.Y.Z>`、README 链接可达 | 三处一致；Release 为 latest（正式版）；tag 与远端一致 |
| 17 | 公告/记录 | 在 release notes/README 标注 1.0 的 DSH 兼容范围；记录本次 run URL、`npm` integrity、tag SHA 到决策笔记 | 一份可追溯的发布记录（建议 `.agents/notes/implemented/process/<date>-release-1.0.md`） |

### C.2 回滚预案（发布前先写进 checklist，发布后才可用）

1. dist-tag 回指：`npm dist-tag add @dsh-use/wallpaper-engine@<上一版本> latest`（RC 阶段只需 `npm dist-tag rm … next`）。
2. 若已发正式版且必须弃用：`npm deprecate @dsh-use/wallpaper-engine@1.0.0 "…原因与替代版本…"`（不删包，保留可追溯）。
3. GitHub Release：改 `--draft` 或标记 `--prerelease`，避免用户按 Latest 安装；issue 置顶说明。
4. 索引：revert index commit（`git revert`）并 push，等 CDN 生效；旧版本条目不动。
5. 用户侧：DSH 0.2.x 的版本不兼容可用 `dsh plugin allow-version … --accept-risk` 作为临时豁免（写进排障文档，不要默认推荐）。
6. 记录时间线：从发现到回滚的每步时间/DRI/版本，作为 2.0 前的流程改进输入。

---

## D. 风险清单（1.0 发布最可能翻车的 3 件事 + 预防）

### D.1 DSH 版本不兼容：装上了/升级后才坏（概率最高）

- **为什么**：README 承诺停在 0.1.x 时代；插件目前**没有任何机器可读的 DSH 版本约束**（实测 DSH 0.2.2-rc.1：无 `engines.dsh`、无 dsh peer ⇒ 不施加约束）；0.2.x 无真机验收记录；1.0 若同时删旧适配层，等于把「未验证的 0.2.x」变成唯一支持线。
- **预防**：
  1. 1.0 前完成 0.2.0-rc.1 / 0.2.2-rc.1 真机矩阵（B.5）；
  2. 包清单加 `engines.dsh`（有上下界）+ `dsh.bundle.platforms: ["win32"]`，index 同步（B.4/B.5/B.8）；
  3. 先发 `1.0.0-rc.1`（`next` tag）给至少一台真实 DSH 0.2.x + 一位外部用户试用 3 天；出问题只撤 `next`；
  4. 迁移文档写明「0.1.x → 不再支持；0.2.x 为最低」与回滚到 0.13.0 的方法。

### D.2 「发布的字节」≠「门禁验证过的字节」

- **为什么**：`lib/`、`dist/`、`dist/static/*.wasm` 全部入库、手工构建；tag 不触发 CI；`master` 无保护；`npm publish` 无 `prepublishOnly`；wasm 无新鲜度守卫；发布 checklist 是人工串联。任何一次「改完忘了重建/在错误 commit 上 tag/本机工作树有未提交改动」都会让 1.0 带着旧产物发布，而且**现有 CI 抓不到**。
- **预防**：
  1. 新增 tag 触发 release workflow：从 tag 构建 + 全量门禁 + wasm 溯源校验 + `npm pack` 断言，通过才 publish（B.6）；
  2. `master` 保护 + required checks；tag 只允许 release 流程创建；
  3. `npm publish` 改成「CI 内 OIDC + `--provenance`」或至少 `prepublishOnly` 跑 `verify:local` 并断言工作树干净；
  4. release commit 步骤固定「重建产物 → `git status` 零差异」并记录产物 sha256 到发布记录。

### D.3 1.0 被质量债「打脸」：文档承诺稳定，仓库里还躺着红/脏

- **为什么**：`cargo test` 实测无法编译；1 个 Rust 已知失败仍在；tests 侧 495 条类型错误（84% 集中在单文件）；文档漂移（dev-setup 的 WebGPU/workspace、TESTING 的 3080/Node 18）；历史 4 个 tag 无 Release。1.0 用户/贡献者会以「稳定版」标准审视这些，任何一条被翻出来都会损害发布可信度。
- **预防**：
  1. 按 B.10 先清 P0（cargo 编译、已知失败、版本语义/迁移文档、兼容声明），P1 的质量债要么清零要么在 1.0 release notes 的「已知限制」**主动披露**（含数量与影响面）；
  2. 1.0 release notes 增加「质量基线」段：三门禁实测结论 + 手工验收覆盖清单（TESTING §2.x 逐项）+ 已知边界（来自 AGENT §7）；
  3. RC 阶段跑一遍 `TESTING.md` 全量手工验收并归档证据；
  4. 发布后 1 周内主动收集 issue，准备好 1.0.1/1.0.2 的快速修复通道。

### D.4 观察项（未进 Top 3，但需盯）

- **包体积/sourcemap 策略反复**：`files` 调整后必须重跑安装冒烟，避免「瘦身成功、安装失败」。
- **供应链**：npm token 手工配置（一次性 `.npmrc`）有泄漏风险；优先 CI OIDC；`dist/static/quickjs.wasm` 来自 node_modules（lockfile 已固定，但需在溯源文件里记录版本）。
- **DSH 自身节奏**：DSH 仍是 `0.x-rc` 且 4 天前刚发 `0.2.2-rc.1`；若 1.0 发布后 DSH 又破坏性变更，插件需要快速 2.0.0 或弃用声明。建议发布说明里写「DSH 兼容窗口：0.2.x，DSH 0.3 需插件 2.0」。

---

## 附录 E. 未能运行 / 未覆盖项（如实）

| 项 | 状态 | 原因 |
|---|---|---|
| DSH 0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-alpha.2 复验 | ⚪ 未运行 | 本机只装了 `dsh 0.2.0-rc.1`；旧版需另装 profile/全局包，超出本次只读范围 |
| DSH 0.2.x 真机 GUI 验证 | ⚪ 未运行 | 需要另起 profile + GUI 交互；本报告只核验了 DSH npm 源码的兼容判定逻辑与版本数据 |
| `pnpm run build:wasm` 重建 | ⚪ 未运行 | 会写 gitignore 的 `wasm/pkg/`（不影响仓库），但耗时/污染风险高且非本次必测；改用「源码/产物同 commit」与溯源建议替代 |
| macOS / Linux 运行验证 | ⚪ 无法运行 | 项目只支持 Windows；无对应环境 |
| `npm publish` / `git tag` / `gh release create` | ⚪ 禁止执行 | 审计约束明确禁止；改为验证「发布前状态」与「发布后判据」 |
| 真实 GPU 渲染性能（FPS） | ⚪ 未测 | 无量化要求；AGENT.md 已如实记录真机人眼验收结论（2026-10-23） |
| 浏览器端 DSH 共享 React 主版本 | ⚪ 未核实 | DSH client bundle 在 `app.asar` 内，本机无法解包外读取；列为 RC 前验证项（B.4-6） |

## 附录 F. 本次实测命令与退出码汇总

| 命令 | exit code | 关键输出摘要 |
|---|---|---|
| `node --version` / `pnpm -v` / `npm -v` | 0 | v22.22.1 / 12.16.1 / 10.9.4 |
| `cargo --version` / `wasm-pack --version` | 0 | 1.96.0 / 0.15.0 |
| `gh auth status` | 0 | 已登录 `yu502950715yang`（scopes: gist, read:org, repo, workflow） |
| `dsh --version` | 0 | 0.2.0-rc.1 |
| `pnpm run typecheck:tests` | 0 | 495 条 / 33 键（基线 35 键 / 500 条），2 键可收紧 |
| `pnpm run verify:arch` | 0 | 6 规则自检通过；92 文件合规 |
| `pnpm run build` | 0 | tsc 无输出；`git status` 零差异 |
| `node scripts/build-client.mjs` | 0 | client.js + map 写出；wasm/quickjs 复制成功；`dist/` 零差异 |
| `pnpm test` | 0 | 106 文件 / 2161 项全过；12.35s |
| `vitest run --reporter=json …` + `node scripts/check-known-failures.mjs` | 0 / 0 | 总计 2161 / 通过 2161 / 失败 0 |
| `pnpm run e2e:colorblend` | 0 | 5/5 判据 PASS |
| `npm pack --dry-run --json` | 0 | 191 entries；tarball 2,054,152 B；unpacked 7,923,877 B |
| `gh run list --limit 60` / `gh run view …` | 0 | 52 成功 / 8 失败（均在 2026-10-10）；最新 run 3 job success |
| `gh release list --limit 100` | 0 | 21 个 Release；最新 v0.13.0；4 个 tag 无 Release（v0.1.0–v0.3.1） |
| `git tag --list` / `git log -1 --date=iso` | 0 | 25 个 tag；HEAD `0056109` 2026-11-04；839 commits |
| `cargo test`（wasm/） | 101 | `particle_stagger_test.rs` `include_str!` 引 `research/` 缺失 → 编译失败 |
| `cargo test --test particle_override_test` | 101 | 7 passed / 1 failed：`override_rate_keeps_duty_cycle`（`基准稳态应有粒子，got 50`） |
| `pnpm run verify:local` | 0 | 8/8 PASS |
| `npm view …`（插件/DSH 元数据） | 0 | 插件 25 版本 / 0 预发布 / latest 0.13.0；DSH latest 0.2.2-rc.1，0.2.0-rc.1 发布于 2026-09-28 |
| `parseMarketIndex(index.json)`（官方包 0.2.1-alpha.4） | 0 | VALID format-1 |
| `npm ci --dry-run` | 1 | lock 与 package.json 不一致（cosmokit + 3 处根依赖差异） |
| `gh api repos/…/branches/master/protection` | 1（HTTP 404） | Branch not protected |
| `rustup target list --installed` | 0 | 只列 `x86_64-pc-windows-msvc`（但 rustlib 下有 wasm32-unknown-unknown，状态待复核） |

日志位置：`%TEMP%\release-audit-*.log`（vitest / e2e / cargo / verify:local 原始输出）；e2e 截图：`e2e/.out/colorblend`（gitignore）。

---

**审计结论重申**：当前 v0.13.0 的三道 CI 门禁与本地综合门禁均为**真实绿**；但 1.0.0 的发布工程缺 P0 项 6 类（兼容声明与 0.2.x 矩阵、旧适配层处置、发布 workflow/分支保护/产物绑定、版本语义与迁移文档、cargo 编译与已知失败、wasm 新鲜度守卫），P1 项 7 类。按 B.10 完成 P0 后，以 `1.0.0-rc.1 → 冷却 → 1.0.0` 两阶段发布是可执行的；若目标是把 1.0 作为「长期稳定承诺」，建议同时等 DSH 0.2.x 正式版后再把 RC 晋升为正式版。
