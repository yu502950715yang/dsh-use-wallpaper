# Agent Note: CI 门禁只对「新增」判红，存量用基线棘轮

Status: implemented

## Problem

CI 要在这个仓库上做门禁，撞上三个现实：

1. **存量失败不是回归**。当时全量测试里有 15 项既有失败（死路径的测试、陈旧的钳制期望、素材漂移的计数快照）。要求"零失败"就等于让 CI 长期红灯 —— 真人会开始无视红灯，或者干脆把碍事的测试删掉。
2. **有些数字会随素材漂移**。全库计数类断言依赖本机 Steam 壁纸库，库一变数字就变，红线与代码质量无关。
3. **产物入了库**。`lib/` 与 `dist/client.js` **纳入版本控制**（DSH profile 用 `link:` 符号链接引用本包，构建产物直接生效），所以"改了 `src/` 却忘重建产物"会让用户装上旧代码 —— 而这个错误**编译通过、单测全绿**，没有任何常规门禁看得见。

## Decision

**门禁判据一律是"新增即红"，存量写进基线；基线之外的错误一律不可豁免。**

- **测试失败用逐项基线**：`scripts/known-failures.json` 是 allowlist（现已清空为空数组，**机制保留**用来拦将来的新失败）；`scripts/check-known-failures.mjs` 只对新失败判红。**不用整文件 exclude**：`verify-real-library` 与 `bootstrap.dom` 各只有 1 项失败，排除整文件会连带丢掉同文件里能跑的用例。
- **套件级错误与未处理异常不享受豁免**：收集期失败、`afterAll` 抛错一律 `SUITE ERROR` + exit 1。因为 vitest 2.1 的 JSON reporter **不上报未处理异常**（实测报告 `success=true`、exit 0），另加 `tests/setup/no-unhandled.ts` 把 rejection 与测试外抛错转成测试失败。
- **tests 侧类型检查用计数棘轮**：`npm run typecheck:tests` 把 `tests/**` 纳入 `tsc --noEmit`（vitest 走 esbuild 不做类型检查，测试里用字面量构造的接口改坏了本不会红）。基线 `scripts/known-type-errors.json` 按 **`(文件, TS 错误码)` 计数**：**新键或计数变大即红**，计数变小只提示；**行号不进指纹**（行号一漂就假红）；放宽必须显式 `--update`。
- **产物新鲜度是门禁**：CI 重跑 `tsc` / `build:client` 后 `git diff` 必须为零。`lib/` 用 `git add -A -- lib/` + `git diff --cached`（原 `git diff` 看不到**新增**产物）；`dist/client.js` 先删入库副本再构建，避免"构建失败 ⇒ 文件没变 ⇒ 误判同步"。
- **本地一条命令复刻全部**：`node scripts/verify-local.mjs`（= `npm run verify:local`）跑 tsc、`lib/` 与 `dist/client.js` 新鲜度、tests 类型基线、vitest + 失败基线、e2e colorblend 与仓库卫生（不得有未提交的**已跟踪**改动），逐条打印 PASS/FAIL 并以非零码退出。

## 涉及仓库

- `dsh-use-wallpaper` 分支 `master` commits `3718011` `5716d95` `48a9ac2`

## Alternatives considered

**要求零失败、把存量失败全部修掉再上 CI。** 理由：最干净，判据也最好解释 —— 不用维护基线机制。不用它是因为修存量失败与本次改动无关，会无限期挡住 CI 上线；而且"零失败"一旦成为口号，遇到真正难修的红线时最容易的动作是删测试。基线机制把"存量"与"新增"分开，是更诚实的口径。

**tests 类型检查直接要求零错误。** 理由：棘轮要维护基线文件，零错误则不需要任何机制。不用它是因为存量类型错误会阻塞**每一次**改动，而修它们的收益与风险不成比例；棘轮让"存量不动、新增不许"，把成本压在真正引入新错误的那个改动上。

**基线指纹带行号（或文件哈希）。** 理由：定位更精确，能区分"同一个错误挪了位置"。不用它是因为行号漂移会假红，假红会训练人 `--update`，棘轮随即失效 —— 判别力不如"计数变大即红"这条粗但稳的规则。

**不把产物入库，改成发布时构建。** 理由：仓库干净，也不会再有"src 与产物不同步"。不用它是因为 DSH profile 用 `link:` 符号链接引用本包、HMR 直接读 `dist/`，产物必须在工作树里就位；既然必须入库，"同步"就只能靠门禁守。

## Consequences

**收益：** 新回归立刻红，存量不阻塞；"src 改了忘重建产物"这种编译通过、测试全绿的错误被机械抓住；本地不必等 CI 就能复现三门禁的结论。

**代价：** 棘轮有**两处已知盲区**（已写进 `AGENT.md` §3.3）：① `vi.fn()` / `Mock<any>` 造的桩不受接口约束 ⇒ 这类测试桩改坏接口不会红；② 同文件同码"计数守恒的位置互换"会漏判（指纹不含行号也不含消息）。另外全库计数类断言随素材漂移，**只能按实测刷新、不要改成区间或阈值**（它们的作用是钉住"没静默漏收集"）。CI 环境本身也有三个只在真实 runner 上才暴露的坑（动作运行时 Node 24、`pnpm-workspace.yaml` 必须有 `packages` 字段、`windows-latest` 的 Edge 探测），排查过程见 [验证、CI 与测试基线的历史](../../../../docs/fixes/verification-ci-history.md)。

e2e 那一路门禁（harness 入库、判据非零退出码、哪些脚本能进 CI）见 [e2e 验证收进仓库并成为 CI 门禁](../testing/2026-09-22-e2e-verification-in-repo.md)；CI 设计原文见 [端到端验证入库 + CI 设计](../../../../docs/superpowers/specs/2026-09-22-e2e-harness-and-ci-design.md)。

**既有问题（本次未修，2026-10-16 建笔记时发现）**：门禁口径在文档里已经漂了 —— `TESTING.md` 写 DSH GUI 是 `http://127.0.0.1:3080`、profile 依赖路径含 `packages/dsh-wallpaper-engine`（该目录自单包化后不存在），`docs/dev-setup.md` 仍要求"浏览器支持 WebGPU"（实际实现是 three.js/WebGL2）并称本项目是 pnpm workspace（`AGENT.md`/`README` 一律 npm）。照这些文档配环境会得到错误预期；`scripts/verify-local.mjs` 内部用 `pnpm exec`，文档与 CI 用 npm/pnpm 混杂 —— 本机装了 pnpm 所以跑得通，换机器要留意。
