# 从 v0.13.1 到 1.0.0：门禁与发布工程复测（delta 报告）

- 审计对象：`@dsh-use/wallpaper-engine` v0.13.1（tag `v0.13.1` → release commit `759422c`，2026-11-09 10:05:10 +0800；当前 HEAD `6069b26`「chore(release): 插件市场索引补 0.13.1」，2026-11-09 10:08:31 +0800）
- 对比基准：`docs/release-1.0/release-engineering.md`（2026-11-06，基于 v0.13.0 / HEAD `0056109`，392 行）
- 审计日期：2026-11-10
- 审计方式：**全部结论以本次实测为准**；13 条必测命令逐条执行并记录 exit code 与关键数字，另补 6 项交叉核验（CI 全量 run、tag 触发、锁文件根依赖差异、类型基线逐键合计、wasm 改动面、旧适配层存在性）
- 审计约束：只读分析 + 运行命令；未修改源码 / `package.json` / 配置；未做 git tag/commit/push；未执行 `npm publish`；唯一写入文件为本报告
- 环境（与上轮一致）：Windows（pwsh）、Node `v22.22.1`、pnpm `12.16.1`、npm `10.9.4`、cargo `1.96.0`、wasm-pack `0.15.0`、gh `2.96.0`（已登录 `yu502950715yang`）、本机 `dsh --version` = `0.2.0-rc.1`、Edge 可用（e2e 实际跑通）
- 工作区恢复确认：审计开始与结束时 `git status --short` 均只有 `?? docs/release-1.0/`（上轮 4 份报告，未跟踪）；`pnpm run build` / `node scripts/build-client.mjs` 后执行 `git checkout -- lib dist`，最终 `git diff -- lib dist` **为空**（`DIFF_EMPTY=True`）；临时日志只在 `%TEMP%`，e2e 截图在 gitignore 的 `e2e/.out/`

---

## 结论摘要（最关键 5 条）

1. **上轮 8 条绿门禁全部仍然是真绿**：vitest **106 文件 / 2181 项全过**（exit 0）、tests 类型棘轮 exit 0（**495 条 / 33 键**，与上轮完全相同）、verify:arch exit 0、build 后 `lib/` 零差异、build-client 后 `dist/` 零差异、`verify:local` **8/8 PASS**、e2e colorblend **5/5 PASS**。
2. **v0.13.1 没有引入新的红项，也没有发现回归**：红项仍只有上轮两条且根因逐字相同——`cargo test` exit 101（`particle_stagger_test.rs` 的 `include_str!` 引用 gitignore 的 `research/` 文件，本次确认 v0.13.0→HEAD **wasm/ 零改动**、无新增 Rust 测试）、`npm ci --dry-run` exit 1（`cosmokit@1.8.2` 不满足 `1.9.0`，锁文件仍陈旧）。新增 20 项测试全过，类型债没有加重，CI 在 v0.13.1 后新增的 run 全绿。
3. **发布工程缺口一条都没动**：`engines.dsh` / `engines.node` / `packageManager` / `dsh.bundle.platforms` / `types` 仍全部缺失；README 兼容声明仍停在 0.1.x（2026-09-23）；≤0.1.6 旧适配层代码与测试原样存在；`.github/workflows/` 仍只有 `ci.yml`（无 tag 触发、无 release workflow），`master` 保护仍 404；`cargo` 未修；1.0 版本语义仍无定义（模板仍写「0.x 阶段」「不引入 major」、无 CHANGELOG、26 个版本 0 个预发布）。
4. **上轮报告的两处数字/结论经本次实测更正**：① `index.json` 的 0.13.0 `publishTimestamp` 并非「与 npm 一致」——实测比 npm 实际早 **整 8 小时**（`1793745339` = 2026-11-03T22:35:39Z，npm = 2026-11-04T06:35:39.650Z），0.12.0 更早 **16 小时**；**新增的 0.13.1 条目本次核对为 0 偏差**（个案录对了，但仍无自动校验）。② 上轮「近 60 次 run 52 绿 8 红」：本次 `gh` 全量只返回 56 条历史 run（48 绿 / 8 红），红项集合与上轮完全一致（同为 2026-10-10 的 8 条），绿/总数与上轮文字记录对不上（详见 §0）。
5. **1.0.0 的发布条件没有实质靠近，建议路径不变**：P0 6 类仍全部未做，粗估 5.5–9 人日；且 DSH 最新仍是 `0.2.2-rc.1`（3 天无进展、无正式版），维持「先发 `1.0.0-rc.1` 走 `next` 通道 + 0.2.x 真机矩阵，P0 全绿后再发正式版」的建议。另外 v0.13.1 本身是 3 天前刚发布的 49 文件 / +2556 行 puppet/effect 大改，1.0 RC 的全量手工验收必须基于 0.13.1 重跑，且 1.0 发布说明需覆盖这批行为变更。

---

## 0. 与上轮基准的差异更正（实测纠错，逐项）

| # | 上轮报告写法 | 本次实测 | 处理 |
|---|---|---|---|
| 0-1 | A.1-9 / §F：「近 60 次 run：52 成功 / 8 失败」 | `gh run list --limit 100` 返回**全部历史 56 条**：48 success / 8 failure（master 分支 52 条 = 44 绿 + 8 红；4 条 dependabot 分支 run 全红计入 8 红）；8 条失败仍全部在 **2026-10-10**；v0.13.1 后新增 3 条 run 全绿 | **红项集合与上轮一致**；总数/绿数与上轮文字记录对不上（若上轮时点存在 60 条，则当前 GitHub 历史无法复现，故以本次全量查询为准）。不影响「无新增红」结论 |
| 0-2 | A.1-10 / B.8：「`index.json` 最新版本 0.13.0 的 `publishTimestamp` 与 npm `time[0.13.0]` 一致（1793745339）」 | 逐版本核算（unix 秒 → UTC vs npm `time` 的 ISO UTC）：**0.13.0 = −8.000h**、**0.12.0 = −16.000h**、0.11.0/0.10.0 = 0、0.9.0 = −26s（秒级取整）；**0.13.1 = −0.000h（一致）** | 上轮该项结论**错误**，本报告更正；与任务简报「0.13.0 早 8 小时、存在 8h/16h 时区误用」相互印证 |
| 0-3 | B.7：三 renderer 集中 **418 条（84%）** | 按 `scripts/known-type-errors.json` 逐键合计：`tests/three-renderer.test.ts` = TS2339×216 + TS2345×101 + TS2722×93 + TS7006×5 + TS2349×3 + TS2322×1 = **419 条**，占当前 495 条的 **84.6%** | 上轮漏计 TS2322×1；本次以逐键合计 419 为准，结论（84% 集中单文件）不变 |
| 0-4 | A.1-1：架构扫描 92 文件 / 6 规则 15 样本 | 本次同值（92 文件、6 规则、15 份红测样本） | 无差异 |
| 0-5 | 附录 F：`cargo test --lib` 未单独记录 | 本次补测：`cargo test --lib` exit 0（**43 passed**），说明编译失败只出在 `particle_stagger_test` test target，不扩散到库测试 | 补充证据 |

> 说明：以上更正只影响「上轮记录是否准确」，不改变上轮的核心判断（门禁绿但 1.0 发布工程未就绪）。

---

## ① 门禁前后对比表

> 判定口径与上轮一致：🟢 = 与 CI 同口径实测通过；🟡 = 命令成功但存在需 1.0 治理的存量；🔴 = 实测失败；⚪ = 未运行/未覆盖。本轮所有命令均在 v0.13.1 工作树（HEAD `6069b26`）上重跑。

| # | 门禁 / 实测项 | 上次（v0.13.0，2026-11-06） | 本次（v0.13.1，2026-11-10） | 变化 |
|---|---|---|---|---|
| 1 | 全量 vitest（`pnpm test`） | 🟢 exit 0；**106 文件 / 2161 项全过**，0 失败 0 跳过，12.35s | 🟢 exit 0；**106 文件 / 2181 项全过**，0 失败 0 跳过，14.41s | **+20 项测试，文件数不变**；耗时 +2.06s（负载/落盘波动，非门禁语义变化） |
| 2 | tests 侧 tsc 棘轮（`pnpm run typecheck:tests`） | 🟢 exit 0；**495 条 / 33 键**（基线 500 条 / 35 键；2 键已修复未收紧） | 🟢 exit 0；**495 条 / 33 键**（基线 35 键 / 500 条；同样 2 键可收紧：`synthetic-library.test.ts|TS2339`、`verify-real-library.test.ts|TS2339`） | **完全无变化**（v0.13.1 大改 9 个 tests 文件但未加重/减少类型债） |
| 3 | 架构边界（`pnpm run verify:arch`） | 🟢 exit 0；6 规则（15 份红测样本）；扫描 92 个 src 文件合规 | 🟢 exit 0；同样 6 规则 / 15 样本 / 92 文件 | 无变化 |
| 4 | tsc strict + `lib/` 新鲜度（`pnpm run build` → `git status --short -- lib/`） | 🟢 exit 0；tsc 无输出；构建后 `lib/` 零差异 | 🟢 exit 0；tsc 无输出；构建后 `git status --short -- lib/` **空**、`git diff --stat -- lib/` 空 | 无变化（产物与 src 同步） |
| 5 | `dist/client.js` 新鲜度（`node scripts/build-client.mjs` → `git status --short -- dist/`） | 🟢 exit 0；client.js + map 写出、wasm/quickjs 复制成功；`dist/` 零差异 | 🟢 exit 0；`client.js` **1,693,365 B**（+8,954 B）、`client.js.map` **4,105,523 B**（+29,587 B）；we_scene_wasm.js 11,281 B / bg.wasm 171,799 B / quickjs.wasm 503,134 B 与上轮完全相同；构建后 `git status --short -- dist/` **空** | 产物随 v0.13.1 源码更新且零差异；wasm 三件未变 |
| 6 | 本地综合门禁（`pnpm run verify:local`） | 🟢 exit 0；8/8 PASS | 🟢 exit 0；8/8 PASS（架构 / tsc / lib 新鲜度 / dist 新鲜度 / tests 类型基线 / vitest+失败基线 / e2e colorblend / 工作树卫生） | 无变化；内部 vitest 2181/2181、known-failures 基线为空且零失败 |
| 7 | e2e colorblend（`pnpm run e2e:colorblend`） | 🟢 exit 0；5/5 判据 PASS | 🟢 exit 0；5/5 判据 PASS（mode=7 / mode=0 / 跨模式亮度对比 ×2 / 背景不受影响） | 无变化 |
| 8 | 发布包（`npm pack --dry-run --json`） | 🟢 exit 0；**191 entries**；tarball **2,054,152 B**、unpacked **7,923,877 B**；lib 182 文件 + dist 5 文件；sourcemap 占 unpacked **52%**；wasm 3 件齐全 | 🟢 exit 0；**191 entries**；tarball **2,069,439 B**（+15,287 B / +0.74%）、unpacked **7,980,212 B**（+56,335 B / +0.71%）；lib **182 文件 / 1,453,031 B** + dist 5 文件 / 6,485,102 B；sourcemap **4,105,523 B = unpacked 的 51.4%**；wasm 3 件齐全（尺寸同上轮）；无 `*.tex` / 无 `src|tests|docs` 泄漏 | 结构不变、体积小幅增长（仍 < 2.5 MB 预算）；map 占比 52% → 51.4% |
| 9 | Rust 测试（`wasm/` 下 `cargo test`） | 🔴 exit 101；`particle_stagger_test.rs` 的 `include_str!("../../research/2851992662-particles-presets-leaves5.json")` 引用 gitignore 的 `research/` 文件（干净克隆无法编译）；定向 `cargo test --test particle_override_test` 7 passed / 1 failed（`override_rate_keeps_duty_cycle`） | 🔴 **exit 101，同一根因**：`.gitignore:6` 忽略 `research/`；本机 `research/` 目录存在但目标 JSON **不存在**（`Test-Path` = False）；`cargo test --lib` exit 0（43 passed）；`cargo test --test particle_override_test` 仍 **7 passed / 1 failed**，panic 位置 `tests/particle_override_test.rs:160`「基准稳态应有粒子，got 50」。**v0.13.0→HEAD `wasm/` 改动文件数 = 0 ⇒ 无新增 Rust 测试** | 红项同一、未恶化、未修复 |
| 10 | GitHub CI 记录（`gh run list`） | 🟡 近 60 次 run 52 绿 / 8 红（红全在 2026-10-10）；最新 run 3 job success | 🟢/🟡；`gh` 返回全部 **56 条** history run：**48 success / 8 failure**；8 条失败仍全部在 **2026-10-10**（同一批）；v0.13.1 后新增 run **全绿**：release push `42548951871`（58s）、索引 push `42549257553`（1m0s）；**tag ref 无任何 run**（headBranch 匹配 `v0.13.1` 的 run = 0） | **无新增红**；见 §0-1 计数更正 |
| 11 | `master` 分支保护（`gh api …/branches/master/protection`） | 🔴 HTTP 404 Branch not protected（exit 1） | 🔴 仍 **404 Branch not protected**（exit 1） | 未动 |
| 12 | 双 lockfile（`npm ci --dry-run`） | 🔴 exit 1：`cosmokit@1.8.2` 不满足 `1.9.0`；另 3 处根依赖差异 | 🔴 exit 1：**同一错误** `lock file's @deepseek-ai/cosmokit@1.8.2 does not satisfy @deepseek-ai/cosmokit@1.9.0`；根依赖差异仍是 3 处：`@deepseek-ai/dsh-settings`（pkg 已删 / lock 留 `^0.1.0-rc.6`）、`@webgpu/glslang`（pkg 已删 / lock 留 `^0.0.15`）、`@deepseek-ai/schemastery`（pkg `^3.18.4` / lock `^3.18.1`）；`package-lock.json` 的 `version` 字段已随 v0.13.1 更新为 `0.13.1`，但依赖仍陈旧 | 未动（package-lock 仅在 release commit 改了版本号） |
| 13 | `package.json` 发布字段 | 缺 `engines.dsh` / `engines.node` / `packageManager` / `dsh.bundle.platforms` / `types`；`files=[lib,dist,cordis.patch.yml]`；双 lockfile 并存 | **仍全部缺失**（`dsh.bundle` 只有 `patch`；`peerDependencies` 只有 `@deepseek-ai/cordis ^4.0.1`）；`files` / `exports` 未变；版本 0.13.1；**双 lockfile 仍并存**（package-lock 2026-11-09、pnpm-lock 2026-09-23） | 未动 |
| 14 | `index.json` 时间戳一致性 | 上轮记「0.13.0 与 npm 一致（1793745339）」 | 0.13.1 条目 `1794190072` = 2026-11-09T02:07:52Z，npm `time[0.13.1]` = 2026-11-09T02:07:52.465Z ⇒ **0 偏差**；历史条目仍错：**0.13.0 −8h、0.12.0 −16h**（0.11.0/0.10.0 准确、0.9.0 差 26s） | 最新条目录对了（个案），历史错误未修、无自动校验 → 机制未解决 |
| 15 | 版本 / 发布节奏（npm + GitHub Release） | 25 tag / 25 npm 版本 / 0 预发布 / 21 Release；latest 0.13.0；4 个 tag 无 Release | **26 tag / 26 npm 版本 / 0 预发布**；dist-tags 只有 `latest=0.13.1`；**22 Release**，最新 `v0.13.1`（非 prerelease，`2026-11-09T02:05:26Z`）；**4 个 tag 仍无 Release**（v0.1.0 / v0.2.0 / v0.3.0 / v0.3.1） | +1 版本、+1 Release；4 个历史缺口未补 |
| 16 | DSH 兼容面（交叉核验） | DSH latest `0.2.2-rc.1`；本机 CLI `0.2.0-rc.1`；README 仅验证到 0.1.7-alpha.2 | **DSH dist-tags 仍为 `latest=0.2.2-rc.1` / `next=0.2.2-rc.1` / `alpha=0.2.2-alpha.3`**（3 天无新版本）；本机 CLI `0.2.0-rc.1`；README 兼容段仍写 0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-alpha.2（日期 2026-09-23）；全仓 md 文档中 0.2.x 唯一提及仍是 README:161「DSH 0.2.1 起可加索引源」，**无任何 0.2.x 验证记录** | 未动 |

**A.2 其他可对比数字（本轮新增实测）**

- v0.13.1 发布范围：tag 间 `git diff v0.13.0..v0.13.1` = **18 commits / 49 文件 / +2556 −804 行**，集中在 `src/client`（8 文件：puppet、effect-runner、mdl-parser、scene-json、shader/effect-chain、shader/shader-preprocessor、three-renderer、threejs-player）+ `src/shared/types.ts`、`lib/client` 14 文件 + `lib/shared` 1 文件、9 个 tests 文件、`dist/client.js(.map)`、8 篇 `.agents/notes`、README/AGENT/TESTING/index.json/package.json/package-lock。**未触及 `wasm/`、`.github/`、`scripts/`、`src/host/`、`src/client/settings.ts`、`src/client/styles.ts`**。
- release commit `759422c` 本身只含 3 文件 / +4 −4（README 版本行、`package.json` version、`package-lock` 版本字段）。
- 本机全库回归（`tests/verify-real-library.test.ts`，本机 WE 库）：43 scene / 119 image / 199 particle / 222 效果链，**0 失败**；上轮记录为 41/108/193/206 全 0 失败——覆盖数字随本机壁纸库样本变化，两轮均零失败，不构成门禁差异（真实库测试在 CI 上 skip）。

---

## ② v0.13.1 是否引入新的红项或回归

**判定：没有新红项，没有发现回归。**

1. **逐门禁复核**：上轮所有绿项（#1–8、#10 最新 run、#15 版本一致性、#16 之外）在 v0.13.1 上重跑后仍绿；两个红项（cargo test、npm ci）的错误信息与失败点逐字相同，且 v0.13.1 **没有触碰 `wasm/`**（0 文件改动）⇒ cargo 红项不存在「新增测试导致的新失败」；typecheck 棘轮数字与上轮完全一致（495/33）⇒ 类型债未因 9 个测试文件大改而恶化。
2. **产物一致性**：release commit 已重建 `lib/`、`dist/`（本次重跑 build 与 build-client 均零差异），说明「发布的字节 = 源码构建的字节」在 v0.13.1 上成立；`dist/static/*.wasm` 三件与上轮字节数相同（源码未动，无 wasm 漂移）。
3. **CI 证据**：v0.13.1 的 release push（`42548951871`，58s）与索引 push（`42549257553`，1m0s）均 success；2026-11-07 的 Dependabot run 也 success；8 条失败全部是 2026-10-10 的历史遗留，**红项集合与上轮完全相同**。
4. **需要单独登记的「非红但需处理」变化**（不计为回归，进入 §③ 新增/风险项）：
   - v0.13.1 是 49 文件 / +2556 行的 puppet/effect 行为大改（18 commits，含绑定姿势口径回退、puppet 对象效果链、shimmer 编译、colorBlend tint、puppet RT 分辨率等），1.0 的发布说明与迁移文档必须覆盖这批用户可见行为变化；1.0 RC 的全量手工验收必须基于 0.13.1 重跑（上轮验收记录基于 0.13.0）。
   - `TESTING.md` §2.11 本次更新后自述 **P4/P5/P7「真机人眼验收待补」**（2026-11-06 已请用户在本机 GUI 复核，但文档未记为已验收）；这不是门禁红项，但属于 1.0 前的手工验收缺口。
   - 测试耗时 12.35s → 14.41s（+17%）、tarball +0.74%：均为量级内波动，未触发任何阈值，不判回归。

---

## ③ 发布工程缺口逐条现状（已解决 / 仍存在 / 新增）

> 逐条对应上轮 B.1–B.9 以及 A.2 的实测发现。**已解决：0 条**。**仍存在：全部 P0 与 P1 清单项**。**新增：无新增门禁红；新增风险/登记 2 条**（见 C.7）。

| 缺口（上轮编号） | 上轮状态 | 本次现状（v0.13.1 实测） | 判定 |
|---|---|---|---|
| B.1 1.0 版本语义（breaking 定义 / 废弃窗口 / 支持窗口） | 未定义 | `.github/RELEASE_NOTES_TEMPLATE.md` mtime 仍为 **2026-11-02**（未被 v0.13.1 触碰）：第 69 行「定版本号（0.x 阶段）」、第 72 行「不引入 major」原样；**无 `CHANGELOG.md`**；26 个 npm 版本 **0 个预发布**、dist-tags 仅 `latest`；`docs/release-1.0/` 下无 `versioning-policy.md` | **仍存在** |
| B.2 发布 checklist 改写（一条命令验收 / tag=CI 绿 SHA / 安装冒烟 / 产物恢复断言） | 未做 | 模板文件未变；v0.13.1 实际发布仍是「`pnpm` 手工串联 + push master 等 CI + 手工 publish + 发布后手工补 index」；无「发布后从 npm 全新 profile 安装冒烟」记录 | **仍存在** |
| B.3 包内容 / files / exports / types / 第三方许可 | 未做 | `types` 仍缺失、`exports` 无 types 条件；`lib/client` 仍整目录进包（lib 182 文件 / 1,453,031 B，运行时 client 由 `dist/client.js` 提供）；sourcemap 4,105,523 B 仍占 unpacked **51.4%**；**无 `THIRD-PARTY-NOTICES`**；无 publint/attw、无 pack 内容断言 | **仍存在** |
| B.4 依赖与 peer（engines.dsh / packageManager / platforms / schemastery 对齐） | 未做 | `package.json` 仍无 `engines`（dsh/node 都没有）、无 `packageManager`、`dsh.bundle` 只有 `patch`；`schemastery` 仍 `^3.18.4`；仍无 `@deepseek-ai/dsh*` peer。**`index.json` 的 0.13.1 条目 engines 仍为 `>=0.1.5-rc.3`（无上界）** | **仍存在** |
| B.5 DSH 兼容矩阵（0.2.x 真机验证 + 删旧适配层） | 未做 | README :218 仍写「同时支持 0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-alpha.2（2026-09-23 三版真机验证）」，:232 仍写旧兼容层过渡性；全仓 md **无 0.2.x 验证记录**；旧适配层原样：`src/client/settings.ts:13` `NS_CANDIDATES=['dsh-wallpaper-engine','wallpaper-engine']`、`src/host/index.ts:57` `settings.register` 旧分支、`tests/host-apply.test.ts:29` `SettingsMode='legacy'|'modern'|'none'`（v0.13.1 未改 `src/host/`、`settings.ts`、`styles.ts`，改动文件数 0） | **仍存在** |
| B.6 CI / release workflow / 分支保护 / 工具链 | 未做 | `.github/workflows/` 仍只有 `ci.yml`（mtime 2026-10-29 未变）：`on: push branches [master] / pull_request / workflow_dispatch`，**无 tag 触发**、无 `release.yml`、`permissions: contents: read`、无 cargo/npm pack/index 校验；`master` 保护 **404**；本机 pnpm 12.16.1 vs CI pnpm 9；无 `packageManager`/`engines.node` | **仍存在** |
| B.7 测试基线（known-type-errors 清零 / cargo 修复 / override 失败 / cargo 进 CI / RC 手工验收） | 未做 | 类型债 **495 条 / 33 键**（同上轮，2 键可收紧但基线文件 mtime 仍 2026-10-16 未 `--update`）；`known-failures.json` 仍空、机制有效（2181/2181）；cargo 编译失败与 `override_rate_keeps_duty_cycle` 失败**原样**；cargo 仍不在 CI；**TESTING §2.11 P4/P5/P7 真机人眼验收标注「待补」** | **仍存在** |
| B.8 CHANGELOG / 索引 / 模板破坏性变更节 / 4 个无 Release tag | 未做 | 无 CHANGELOG；模板无「破坏性变更」必选节；4 个 tag 仍无 Release；`index.json` 历史时间戳错误（0.12.0 −16h、0.13.0 −8h）未修正；0.13.1 条目正确但**无 CI 自动校验**（发布后仍手工）；`screenshots.json` 仍存在但 README/index/AGENT 中 **0 处引用** | **仍存在** |
| B.9 wasm 产物溯源 / 新鲜度门禁 | 未做 | 仍无 `dist/static/WASM_BUILD.json`、无 wasm 构建一致性 job；本次 v0.13.1 未改 wasm（0 文件）⇒ **没有新增漂移**，但「同步只是纪律」的状态不变 | **仍存在** |
| A.2-1 「门禁绿 ≠ 发布绿」（产物绑定 / tag 不跑 CI / 无 prepublishOnly） | 未做 | tag 无 CI run（本轮实测 headBranch=v0.13.1 的 run = 0）；无 release workflow；无 prepublishOnly；v0.13.1 发布仍依赖人工先 push master 再打 tag | **仍存在** |
| A.2-5 发布 provenance | 未做 | `npm view @dsh-use/wallpaper-engine@0.13.1 dist` 仍只有 registry `signatures`，**无 `attestations`**（未用 `--provenance`） | **仍存在** |
| A.2-6 文档漂移 | 未做 | `docs/dev-setup.md:17` 仍称「本项目是 pnpm workspace」、`:69` 仍要求 WebGPU；`TESTING.md:3` 仍写 DSH GUI `http://127.0.0.1:3080`（与 0.2.x 实际 GUI 端口不一致） | **仍存在** |
| B.10 P0 六类 | 未做 | 见 §④，6/6 全部未动 | **仍存在** |

**C.7 本轮新增 / 变化项（不是新门禁红）**

1. **新增风险登记（P1 级，进 1.0 发布说明与 RC 验收）**：v0.13.1 在 1.0 前 3 天以 `latest` 发布了 49 文件 / +2556 行 puppet/effect 行为变更；1.0 若从其继续，发布说明/迁移文档必须覆盖这批变化，且 RC 全量手工验收与 0.2.x 矩阵必须基于 0.13.1 重跑（上轮矩阵设计基线是 0.13.0）。
2. **个案已改善但机制未解决**：`index.json` 新条目 0.13.1 的 `publishTimestamp` 与 npm 精确一致（上轮 0.13.0 偏差 8h、0.12.0 偏差 16h），但无自动校验、历史错误未修——**不计为缺口解决**，只登记为「个案录对」。
3. 无「已解决」项：上轮 P0（6 类）与 P1（7 类）在本轮实测中 0 项落地；v0.13.1 发布内容全部是功能/渲染修复与发布例行文件（README 最新版本行、index 补条目、package 版本号）。

---

## ④ 上轮 P0 清单是否仍未动（逐项复核）

**结论：6/6 全部仍未动。** 上轮 P0 的判定条件在本轮没有任何一项被触发或部分完成；其中最容易被误认为「已做」的版本号/索引动作只是例行发布，不涉及 P0 内容。

| P0 项 | 上轮要求 | 本次核实（v0.13.1） | 仍未动？ |
|---|---|---|---|
| P0-1 `engines.dsh` + `dsh.bundle.platforms` | 声明有界 DSH 版本 + 平台（或明确仅 win32），index 同步 | `package.json` 无 `engines`、`dsh.bundle` 仅 `patch`；index 0.13.1 条目 engines 仍 `>=0.1.5-rc.3` 无上界；v0.13.1 未改这两个字段 | **是** |
| P0-2 DSH 0.2.x 兼容矩阵 | 至少 0.2.0-rc.1 / 0.2.2-rc.1 真机验证并写入 README | README 兼容段仍 0.1.x（2026-09-23）；全仓 md 无 0.2.x 验证记录；DSH latest 仍 `0.2.2-rc.1`（3 天无新版本，矩阵对象本身也未变化）；本机 CLI 仍 `0.2.0-rc.1` | **是** |
| P0-3 删 ≤0.1.6 旧适配层（保留 §9.C） | 删旧 settings 路径 + 配套测试 + 文档 | `NS_CANDIDATES` 双命名空间、`settings.register` 旧分支、`SettingsMode` legacy 用例全部原样；v0.13.1 未触碰 `src/host/`、`settings.ts`、`styles.ts`（改动 0 文件） | **是** |
| P0-4 tag 触发 release workflow + `master` 分支保护 + publish 前门禁 | 新增 `release.yml`、required checks、tag 只在 CI 绿 SHA 上 | 仍只有 `ci.yml`（无 tag 触发、无 release workflow）；`master` protection **404**；无 prepublishOnly/provenance；实测 tag ref 无 CI run | **是** |
| P0-5 修复 cargo test 编译失败 + 处置 override 已知失败 | `include_str!` 改入库夹具或标 ignore；`override_rate_keeps_duty_cycle` 红转绿或显式基线 | `cargo test` 仍 exit 101（同一 `research/` 文件缺失，该目录在 `.gitignore:6` 且目标 JSON 本机不存在）；定向测试仍 7P/1F 同一 panic；`cargo test --lib` 43 passed；**wasm/ 0 改动** | **是** |
| P0-6 1.0 版本语义 / 破坏性变更 / 迁移文档 / 模板改版 | 定义 1.0 semver、RC 通道、废弃窗口、迁移说明、模板加破坏性变更节 | 模板仍「0.x 阶段」+「不引入 major」（mtime 2026-11-02）；无 CHANGELOG；无预发布；无 `docs/release-1.0/versioning-policy.md`/迁移文档；1.0 发布说明模板未改 | **是** |

---

## ⑤ 更新后的 P0/P1 与工作量估计

> 口径与上轮 B.10 相同：P0 = 1.0.0 正式版 tag 前必须完成；P1 = 强烈建议 1.0 前完成；P2 = 1.0 后可做但需登记。合计按「1 人串行」估；2 人并行可压到约 60%（P0-1/3/5 与 P0-2/4/6 可分组并行）。

### E.1 P0（发布 1.0.0 前必须，6 项，粗估 5.5–9 人日）

| P0 | 内容（维持上轮要求，补充本轮证据） | 粗估 |
|---|---|---|
| P0-1 | `package.json` 加 `engines.dsh`（有界，如 `>=0.2.0-rc.1 <0.3.0`）+ `dsh.bundle.platforms: ["win32"]`（或 README 明确仅 Windows）；`index.json` 新条目同步上下界 | 0.5–1 d |
| P0-2 | DSH 0.2.x 真机矩阵（≥0.2.0-rc.1 / 0.2.2-rc.1）：安装、设置页读写、选中壁纸刷新恢复、四态样式、媒体/声音、console 无错；**必须基于 v0.13.1 重跑**（puppet/effect 大改后） | 1–2 d |
| P0-3 | 删除 ≤0.1.6 旧适配层（迁移文档 §9 A/B，保留 §9.C）+ 删改配套测试 + README 兼容段改写；`git grep` 判据只剩 0.1.7 命名空间 | 1–2 d |
| P0-4 | 新增 `release.yml`（tag 触发：verify:local + wasm/打包断言，成功才 publish/`--provenance`）+ `master` required checks + tag 保护 + 发布后安装冒烟脚本化 | 1.5–2 d |
| P0-5 | 修 `wasm/tests/particle_stagger_test.rs` 的 `include_str!`（入 `wasm/tests/fixtures/` 或 `#[ignore]`）；处置 `override_rate_keeps_duty_cycle`（红转绿或显式基线+文档）；把 cargo 纳入 CI | 0.5–1 d |
| P0-6 | 1.0 版本语义表（breaking/新增/修复判据、废弃窗口、DSH 兼容策略）+ RC/`next` 通道 + 迁移文档 + 模板加「破坏性变更/升级步骤」节 + CHANGELOG 起步；**1.0 发布说明覆盖 v0.13.1 行为变更** | 1–1.5 d |

### E.2 P1（7 项，粗估 5–9 人日；与上轮相比维持，另补 0.13.1 验收覆盖）

| P1 | 内容 | 粗估 |
|---|---|---|
| P1-1 | known-type-errors 清零/大幅收紧（优先 `tests/three-renderer.test.ts` 419 条 = 84.6%），先 `--update` 收紧 2 个已修复键 | 2–4 d |
| P1-2 | wasm 产物溯源（`WASM_BUILD.json`：源码 sha + 工具版本 + 产物 sha256）+ CI 一致性软/硬断言 | 0.5–1 d |
| P1-3 | 包内容治理：`types`/`exports.types`、评估 `lib/client` 是否收窄、sourcemap 策略、publint/attw、第三方许可清单、`npm pack` 关键指标 CI 断言 | 1–1.5 d |
| P1-4 | 双 lockfile 收口（推荐删 `package-lock.json`，或纳入 CI 校验）+ `packageManager`/`engines.node` 统一（CI pnpm 9 vs 本机 12） | 0.5 d |
| P1-5 | CHANGELOG + `parseMarketIndex(index.json)` 进 CI + 修正 0.12.0/0.13.0 历史时间戳错误 + `screenshots.json` 处置（转正式字段或删） | 0.5–1 d |
| P1-6 | RC 全量手工验收（TESTING §2.1–2.19，**含 v0.13.1 新增的 §2.11 P4/P5/P7 真机 puppet 动画/效果链**）并归档证据 | 1–1.5 d |
| P1-7 | 发布后安装冒烟（全新 DSH profile 从 npm 装 1.0.0-rc.N → 启动 → 设置页出现 → 选壁纸刷新恢复）纳入发布 checklist/CI | 0.5–1 d |

### E.3 P2 / 观察项

- 4 个无 Release 的 tag（v0.1.0–v0.3.1）补建或发布说明交代：0.5 d。
- 文档漂移（`docs/dev-setup.md` workspace/WebGPU、`TESTING.md` 3080/Node ≥18）：0.5 d。
- DSH 自身节奏仍是最大外部变量：DSH 已连续 3 天停在 `0.2.2-rc.1`（无正式版），若发布 1.0 后 DSH 再破坏性变更，插件需 2.0.0 或弃用声明。

### E.4 与上轮结论的差异与建议路径

- **差异**：无一项 P0/P1 状态变化；唯一变化是 v0.13.1 以 `latest` 身份再推一轮功能（+2556 行），使 1.0 RC 的验收面（尤其 puppet/effect 真机手工项）变大，P0-2/P1-6 的验收成本略增（已在估算中计入）。
- **建议路径（与上轮一致，且证据更强）**：先发 `1.0.0-rc.1`（`npm publish --tag next` + GitHub Pre-release），同时完成 P0-1/3/4/5/6；RC 冷却期覆盖「DSH 0.2.x 真机矩阵 + TESTING 全量手工验收（含 0.13.1 新增 puppet 项）+ 1 次外部用户试用」，全绿后再 `dist-tag add … latest` 晋升 `1.0.0`。若目标是「1.0 = 长期稳定承诺」，建议等 DSH 0.2.x 出正式版后再晋升——当前 DSH 仍只有 RC。
- **判定**：**1.0.0 当前仍不具备发布条件**（P0 全未动），与上轮判定一致；本轮新增的 v0.13.1 功能变更不改变该结论，但要求 1.0 的迁移/发布文档覆盖 0.13.1。

---

## 附录 F. 本次实测命令与 exit code 汇总

| 命令 | exit code | 关键输出 |
|---|---|---|
| `node --version` / `pnpm -v` / `npm -v` | 0 | v22.22.1 / 12.16.1 / 10.9.4 |
| `cargo --version` / `wasm-pack --version` / `dsh --version` | 0 | cargo 1.96.0 / wasm-pack 0.15.0 / 0.2.0-rc.1 |
| `pnpm test` | **0** | 106 文件 / **2181 项全过**；14.41s |
| `pnpm run typecheck:tests` | **0** | 495 条 / 33 键（基线 35 键 / 500 条）；2 键可收紧；无新增 |
| `pnpm run verify:arch` | **0** | 6 规则 / 15 红测样本；92 文件合规 |
| `pnpm run build` | **0** | tsc 无输出；`git status --short -- lib/` 空 |
| `node scripts/build-client.mjs` | **0** | client.js 1,693,365 B + map 4,105,523 B 写出；wasm/quickjs 复制成功；`git status --short -- dist/` 空 |
| `git checkout -- lib dist` + `git diff -- lib dist` | 0 / 空 | 恢复成功，`DIFF_EMPTY=True` |
| `pnpm run verify:local` | **0** | 8/8 PASS（含 vitest 2181/2181、e2e 5/5、工作树卫生） |
| `pnpm run e2e:colorblend` | **0** | 5/5 判据 PASS；截图 `e2e/.out/colorblend` |
| `npm pack --dry-run --json` | **0** | 191 entries；tarball 2,069,439 B；unpacked 7,980,212 B；wasm 3 件齐全；map 51.4% |
| `cargo test`（`wasm/`） | **101** | `particle_stagger_test.rs:19` include_str `research/` 文件缺失 ⇒ test target 编译失败 |
| `cargo test --lib`（`wasm/`） | **0** | 43 passed；失败只限 test target |
| `cargo test --test particle_override_test` | **101** | 7 passed / 1 failed：`override_rate_keeps_duty_cycle`「基准稳态应有粒子，got 50」 |
| `npm ci --dry-run` | **1** | `cosmokit@1.8.2` 不满足 `1.9.0`；3 处根依赖差异仍在 |
| `gh run list --limit 100 --json …` | 0 | 全量 56 条：48 绿 / 8 红（8 红全在 2026-10-10）；v0.13.1 后 run 全绿；tag ref 无 run |
| `gh api repos/…/branches/master/protection` | **1（HTTP 404）** | Branch not protected |
| `git tag --list` / `git diff --shortstat v0.13.0..v0.13.1` | 0 | 26 tag；18 commits / 49 文件 / +2556 −804 |
| `npm view … version dist-tags versions time dist` | 0 | latest 0.13.1；26 版本 / 0 预发布；0.13.1 无 attestations；fileCount 191 / unpackedSize 7,980,212 |
| `gh release list --limit 100` | 0 | 22 Release；最新 v0.13.1（非 prerelease）；4 个 tag 无 Release |
| `node` 核算 index 时间戳 | 0 | 0.13.1 = 0；0.13.0 = −8h；0.12.0 = −16h |

日志位置：`%TEMP%\release-delta-*.log`（vitest / typecheck / npm ci / cargo / e2e / verify:local）；完整 vitest 报告由 verify:local 生成后自动删除（`.vitest-report.json`）。

## 附录 G. 未能运行 / 未覆盖项（如实）

| 项 | 状态 | 原因 |
|---|---|---|
| DSH 0.2.x 真机 GUI 矩阵（0.2.0-rc.1 / 0.2.2-rc.1） | ⚪ 未运行 | 只读审计约束 + 需要另起 profile/GUI 交互；本轮只核验版本数据与 README 声明 |
| 官方 `parseMarketIndex(index.json)` 重跑 | ⚪ 未重跑 | 非本轮 13 条必测；`index.json` 仅追加一条与既有条目同构的 0.13.1 记录（上轮实测 VALID format-1），格式风险未变 |
| `pnpm run build:wasm` 重建 | ⚪ 未运行 | 会写 gitignore 的 `wasm/pkg/`，且 v0.13.1 未改 wasm/（0 文件），无重跑必要 |
| npm 安装冒烟（全新 profile） | ⚪ 未运行 | 需要 DSH profile 与 GUI 交互，超出只读范围 |
| macOS / Linux 运行验证 | ⚪ 无法运行 | 项目仅 Windows 实测，无对应环境 |
| 真实 GPU 渲染性能 / 人工视觉验收 | ⚪ 未测 | 无量化门禁；v0.13.1 新增 puppet 项（TESTING P4/P5/P7）文档自述「待补」 |
| `npm publish` / `git tag` / `git commit` / `git push` | ⚪ 禁止执行 | 审计约束明确禁止；改为验证发布前状态与判据 |

## 附录 H. 本报告相对上轮报告的关系

- 本报告为 **delta 报告**，不替代 `docs/release-1.0/release-engineering.md`（上轮完整审计，392 行）；缺口编号（B.1–B.10）、P0/P1 口径、发布执行清单（C 节）与风险清单（D 节）仍以上轮报告为准，本报告只更新其实测数字与状态。
- 本报告修正上轮 3 处记录（§0）：CI run 计数、`index.json` 0.13.0 时间戳结论、three-renderer 类型错误条数（418→419）。
- 两轮共同结论不变：**CI/本地门禁真实绿，但 1.0.0 发布工程 P0 全未动，暂不具备发布条件。**
