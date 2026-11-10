# P0 发布工程完成记录（1.0.0）

> 任务：task-7「P0 发布工程：release workflow + 1.0 语义 + wasm 溯源 + cargo 修复」。
> 执行者：release-ops；日期 2026-11-10。本文件只记录本轮改动、命令结果与交接清单，发布流程的权威文档是
> `.github/RELEASE_NOTES_TEMPLATE.md`（已升级到 1.x 语义）。

## 状态摘要

| # | 交付物 | 状态 | 证据 |
| - | ------ | ---- | ---- |
| 1 | `.github/workflows/release.yml`（tag 触发 → 全量门禁 → npm publish --provenance） | ✅ 新增 | PyYAML `safe_load` 解析通过；结构断言见「命令与结果」 |
| 2 | `.github/RELEASE_NOTES_TEMPLATE.md` 升级 1.x 语义 | ✅ 重写关键节 | 版本语义表 + 破坏性变更/升级步骤必选节 + checklist 11 步 |
| 3 | `scripts/check-release.mjs` + `scripts/gen-wasm-manifest.mjs` + `dist/static/WASM_BUILD.json` | ✅ 新增 | 脚本实跑：②③ 两项在干净/当前树上均 PASS；①④ 见下方说明 |
| 4 | `wasm/tests` cargo 修复（fixture 入库 + duty_cycle 定性） | ✅ `cargo test` exit 0 | 见「cargo 修复」 |
| 5 | `scripts/known-type-errors.json` 收紧 2 键 | ✅ | HEAD 干净树复验：495 条 / 33 键、无新增、exit 0 |

## 1. `.github/workflows/release.yml`（新增）

- 触发：`on: push: tags: ['v*']` + `workflow_dispatch`（手动演练；**branch 上的手动触发只跑门禁**，
  publish job 用 `if: startsWith(github.ref, 'refs/tags/v')` 拦住）。
- 平台/工具链：`windows-latest`、Node 22、pnpm 9（与 `ci.yml` 一致）；动作主版本沿用 ci.yml 的
  node24 运行时钉法（`checkout@v5` / `pnpm/action-setup@v5` / `setup-node@v5`）。
- **gate job**（只读权限）：checkout（`fetch-depth: 0`，wasm 溯源要读提交历史）→ `pnpm install
  --frozen-lockfile` → `verify-arch` → `tsc --noEmit` → **lib/ 产物新鲜度**（重跑 tsc + `git add -A`
  + `git diff --cached`）→ **dist/client.js 新鲜度**（先删再构建 + `git diff`）→
  `check-known-type-errors` → `pnpm test`（**发布不吞已知失败基线**）→ Edge 解析 + `e2e colorblend`
  → `node scripts/check-release.mjs`。
- **publish job**：`needs: gate`、`environment: npm`、`permissions: { contents: read, id-token: write }`、
  校验 tag 与 `package.json` 版本一致 → `npm publish --provenance --tag latest`（OIDC 可信发布，
  无长期 NPM_TOKEN）。
- 未验证项：workflow 未在 GitHub 上实际运行（本地无法跑 Actions）。语法已用 PyYAML 全量解析；
  语义结构已逐 job/step 断言（见命令清单）。**首次 tag 发布前建议先 `workflow_dispatch` 演练 gate**。

## 2. `.github/RELEASE_NOTES_TEMPLATE.md`（1.x 语义）

- **新增「版本语义（1.x，1.0.0 起生效）」小节**，替换原「0.x 阶段 / 不引入 major」：
  - breaking → major、新增用户可感知能力 → minor、修复/微调 → patch；
  - **1.x 内不允许破坏**的清单（设置字段/默认值/降级链/localStorage/数据目录/host 路由/exports/files/DSH 最低版本）；
  - 「什么算用户可感知」（设置面板控件与文案、默认值、降级链行为、e2e 判据语义、市场索引/安装方式；
    纯内部重构/注释/测试不算）；
  - 废弃窗口（先 minor 标 deprecated 并打日志，至少保留一个 minor，下一个 major 才删）；
  - DSH 兼容策略（`engines.dsh` **抬上界 = minor**；**抬下界/删旧适配 = major**；两处声明必须一致）；
  - 预发布通道（`-rc.N` + `--tag next` → 冷却后晋升 latest）与回滚（dist-tag 回退，不删已发布版本）。
- **模板正文新增必选节**：`## ⚠️ 破坏性变更（0.x → 1.0）`（1.0.0 必选；后续 major 改名为「破坏性变更（X → Y）」；
  minor/patch 不出现）与 `## 升级步骤`（必选；替代原「升级说明」，含 npm/桌面版/配置迁移/回滚四类动作）。
- **发布 checklist 重写为 11 步**（原 10 步），新增/强化：`pnpm run verify:local` 一条命令验收
  （含 `check:release`）、**tag 必须打在 CI 已绿的 SHA 上且等 Release workflow 绿**、发布后
  **从 npm 全新 profile 安装冒烟**、`index.json` 官方 `parseMarketIndex` 校验与 engines 一致性、
  CI OIDC 发布 + 手工兜底路径。历史 Release 明确「不回填、不改写」。

## 3. wasm 溯源 + 发布前检查（新增脚本）

### `scripts/gen-wasm-manifest.mjs`（生成溯源清单）

生成入库的 `dist/static/WASM_BUILD.json`，记录：`wasm/src`+`wasm/Cargo.{toml,lock}` 最后 commit 与
是否脏、rustc/cargo/wasm-pack 版本、三件分发产物（`we_scene_wasm.js`、`we_scene_wasm_bg.wasm`、
`quickjs.wasm`）的 sha256/大小、构建命令、quickjs 源包版本与源文件哈希。
**wasm 产物重建后必须重跑**（`pnpm run gen:wasm-manifest`）；清单已生成并待随 dist 提交。

### `scripts/check-release.mjs`（发布前单命令检查，四类，一次失败非零退出）

1. **产物新鲜度**：重跑 `tsc` 后 `lib/` 与 git 零差异（`git add -A -- lib/` 覆盖新增/删除产物）；
   删掉入库副本重建 `dist/client.js` 后零差异 —— 即「tag 必须构建自干净工作树」的可执行版。
2. **wasm 溯源**：三件产物 sha256/大小与 `WASM_BUILD.json` 一致；quickjs.wasm 与 node_modules 源哈希一致
   （依赖漂移会抓到）；`wasm/src`/`Cargo.*` 未在清单之后改动、清单记录时源码不脏。
3. **npm pack 断言**：`npm pack --dry-run --json` → tarball ≤ 2.5 MiB、无 `*.tex`、无 `src|tests|docs`、
   wasm 三件 + 清单齐全、pack 版本 == `package.json` 版本。
4. **发布元数据**：`package.json` 必须有 `engines.dsh`；`index.json` 若已有当前版本条目则 `engines.dsh`
   必须逐字一致；**若索引尚未收录当前版本**（发布前常态：流程是 npm 发布后补索引）→ 只 WARN 不判红。
   索引收录后用同一命令复验会转严格比较。

已实测的行为（干净 worktree / 当前主工作树）：②③ 稳定 PASS；④ 在「`package.json` 已改 engines 但
`index.json` 0.13.1 旧条目未同步」时正确判红；① 在「工作树有未提交 src 改动或未提交产物」时正确判红
（当前主工作树正处此状态，属预期，见下）。

## 4. cargo 修复（`wasm/`）

### 4.1 编译失败：`include_str!` 引用 gitignore 的 research/

- 根因：`wasm/tests/particle_stagger_test.rs:19` 用
  `include_str!("../../research/2851992662-particles-presets-leaves5.json")`，而 `research/` 在
  `.gitignore:6`；本机 `research/` 也没有该 JSON（delta 报告已核实），干净克隆必然编不过。
- 修复：从本机 WE 壁纸库 `D:\steam\steamapps\workshop\content\431960\2851992662\scene.pkg`
  的 `particles/presets/leaves5.json` 提取（2063 B，`Particle#PkgReader`）→ 入库到
  `wasm/tests/fixtures/2851992662-particles-presets-leaves5.json`，引用改为
  `include_str!("fixtures/2851992662-particles-presets-leaves5.json")`。
  （提取脚本是临时 research/ 工具，未入库；要复现可从 pkg 重新提取，fixture 本身已入库。）

### 4.2 `override_rate_keeps_duty_cycle` 定性：**测试期望错，实现无误**

- 实现（`wasm/src/particle/sim.rs:795-824`）：`sdt = dt × override_spec.rate`，同一 `sdt` 同时用于
  ① 发射累积 `emission_timer += sdt × emitter.rate × count` ② 寿命衰减 `p.life -= sdt`
  ③ 算子时间 ④ `time += sdt`。这正是 OWE `ParticleSubSystem::Tick = Advance(frame_time × Rate(), …)`
  与 lwe `rate = emitter.rate × override.rate` 的语义：发射率 ×rate、寿命 ÷rate ⇒ 连续极限下占空比不变。
- 原测试参数（lifetime=0.1s、真实 dt=0.05s、emitter.rate=1000/s）在**离散采样**下不成立：
  - 更新顺序是「先发射、后扣寿命」⇒ 粒子出生当帧即被扣一帧寿命，0.1s 寿命只能活 1 帧；
    rate=1 稳态 = 单帧发射量 = 50（不是连续极限 rate×lifetime=100）⇒ `assert!(base > 50)` 必假；
  - rate=4 时有效步长 `sdt = 0.2s > lifetime` ⇒ 粒子出生即超龄、稳态 0 个 ⇒ `assert_eq!(base, fast)` 必假。
  - 即：任何符合 OWE 语义的实现都无法同时满足原断言 —— 是测试参数选择（寿命/步长分辨率）错误。
  - 与 AGENT.md §7.42⑤「待另开任务订正测试期望」、`docs/release-1.0/release-engineering.md` 的建议一致。
- 修复（只改测试，不动渲染实现）：参数放大到寿命 ≫ 步长（lifetime=1.0s、dt=0.01s、rate=1000/s、
  maxcount=4000、400 帧），离散偏差 = rate×dt（990 vs 960，3%），断言 `base > 900` 且
  `|base − fast| ≤ 10%×base`；保留原回归意图（若只乘发射率不缩寿命，fast ≈ 4×base，必然超差被抓）。

### 4.3 类型债收紧

- 从 `scripts/known-type-errors.json` 移除两个已修复键：`tests/synthetic-library.test.ts|TS2339: 3`、
  `tests/verify-real-library.test.ts|TS2339: 2`（基线 35 → 33 键）。
- **没有直接跑 `--update` 的原因**：执行时主工作树有 Lead 并行未提交改动，`--update` 会把当时的
  中间态类型错误（`tests/dom/settings-section.dom.test.tsx|TS2493`，由 `src/client/settings-section.tsx`
  改动引起）一起写进基线，掩盖真实回归。改用精确手工收紧；在 HEAD 干净树（临时 worktree）复验：
  **495 条 / 33 键、无新增、exit 0**。主工作树当前仍红是上述并行改动未收尾，提交后会转绿。

## 命令与结果（可复跑）

| 命令 | 结果 |
| ---- | ---- |
| `cd wasm && cargo test` | **exit 0**（全部 target 通过；`particle_override_test` 8 passed、`particle_stagger_test` 6 passed） |
| `node scripts/gen-wasm-manifest.mjs` | exit 0；写入 `dist/static/WASM_BUILD.json`（wasm 源码基线 `1b7a306…`、rustc/cargo 1.96.0、wasm-pack 0.15.0、三件 sha256） |
| `node scripts/check-release.mjs`（干净 worktree，含本任务新文件） | ① 因 worktree 的 node_modules junction 导致 esbuild 模块路径变成 `../../node_modules/…` 而伪红（归一化后与 HEAD 逐字节一致：`1666580 chars` 完全相同）；②③ PASS；④ 因该 worktree 的 HEAD `package.json` 无 `engines.dsh` 而红（预期） |
| `node scripts/check-release.mjs`（主工作树，Lead 并行改动未提交） | ① 红（lib/ 未提交，正确判红）、② PASS、③ PASS（tarball 2.00 MiB / 202 files）、④ 红（`index.json` v0.13.1 旧 engines `>=0.1.5-rc.3` ≠ 新 `>=0.2.0-rc.1 <0.3.0`） |
| `node scripts/check-known-type-errors.mjs`（HEAD 干净树 + 收紧后基线） | **exit 0**：495 条 / 33 键、无新增 |
| `python -c "yaml.safe_load(release.yml)"` | 解析成功；`on.push.tags=['v*']`、`on.workflow_dispatch` 存在；jobs = `gate`(14 steps)/`publish`(4 steps)；publish `needs=gate`、`if=startsWith(github.ref,'refs/tags/v')`、`environment=npm`、`permissions.id-token=write` |

## 需要 Lead 处理/确认的清单

### `package.json`（**不要在本任务外重复改**；Lead 已加的部分已核对）

- [x] `scripts.check:release` = `node scripts/check-release.mjs`（已存在，脚本已就绪）
- [x] `scripts.gen:wasm-manifest` = `node scripts/gen-wasm-manifest.mjs`（已存在）
- [x] `engines.dsh` = `">=0.2.0-rc.1 <0.3.0"`（已存在；check-release ④ 校验它）
- [ ] （建议）`scripts.verify:local` 指向的 `scripts/verify-local.mjs` 里**加一条 gate**：
      `node scripts/check-release.mjs`（发布前检查），使「一条命令验收」覆盖发布段。本任务按约束未改
      `verify-local.mjs`，由 Lead 决定落地位置。

### `index.json`

- [ ] bump 到 1.0.0 后：新版本条目的 `engines.dsh` 必须与 `package.json` **逐字一致**
      （`>=0.2.0-rc.1 <0.3.0`）；历史条目保持原样。
- [ ] 发布后补索引条目并跑一次 `pnpm run check:release`（此时 ④ 转为严格比较）+ 官方
      `@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex` 校验。
- 注：当前 `index.json` v0.13.1 条目仍是旧的 `>=0.1.5-rc.3`，与 `package.json` 新 engines 不一致 ——
  这是 check-release ④ 现在判红的直接原因；**bump 到 1.0.0 后按「发布后补条目」流程即可消除**。

### GitHub / npm 仓库配置（release.yml OIDC 发布的前置条件）

- [ ] npmjs 上配置 **Trusted Publisher**：repo `yu502950715yang/dsh-use-wallpaper`、
      workflow 文件名 `release.yml`、environment `npm`。
- [ ] 仓库 Settings → Environments 建 `npm` environment（可选：加 required reviewers 作为发布审批）。
- 否则 publish job 会在 `npm publish` 处 401/404（gate 仍会正常跑）。

### 其他

- [ ] `dist/static/WASM_BUILD.json` 是待提交的新文件；**若 Lead 重建 wasm 产物，必须重跑
      `pnpm run gen:wasm-manifest` 再提交**，否则 check-release ② 会红。
- [ ] 本机/沙箱 `wasm-pack build` 曾在安装 wasm-bindgen 时 `os error 5`（权限），本轮未重建 wasm；
      清单记录的是「当前入库产物 ↔ 当前 wasm 源码基线」，首次重建后请以重建时的工具链为准。
- [ ] 双 lockfile（`package-lock.json` 仍在）属 B.4/P1-4 范畴，本次未处理；release workflow 只用 pnpm。

## 已知状态（截至交付时）

- `cargo test`：**exit 0**（本轮目标达成）。
- `check-release.mjs`：脚本逻辑四类全部实跑过；②③ 通过；①④ 在主工作树的红是**真实的未完成发布准备**
  （未提交产物、index engines 未对齐），不是脚本缺陷。
- `typecheck:tests`：HEAD 干净树 + 收紧基线 = exit 0；主工作树当前红来自 Lead 并行改动的中间态
  （`tests/dom/settings-section.dom.test.tsx|TS2493` 新增），收尾后应绿。
