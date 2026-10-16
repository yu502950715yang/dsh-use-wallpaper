# Agent Note: e2e 验证收进仓库并成为 CI 门禁

Status: implemented

## Problem

这个插件的正确性只能靠「渲染真实素材再逐像素看」，而当时**最可靠的那套验证手段全都住在被 gitignore 的 `research/` 里**（`git ls-files research` = 0，过程台账 `.superpowers/sdd/**` 同样被忽略）。后果是每次改动的验收**不可复现、不可交接、进不了 CI**：换台机器、换个人、换一个会话，就没法证明"这次改动没有回归"。

同一批脚本还有第二个问题：**判据失败时退出码仍是 0** —— 301 个脚本里只有 13 个写了 `process.exitCode`，异常分支也只 `console.error`。判据只打印不报错，就不是门禁，只是日志。

## Decision

把**最小可运行**的 e2e 集合收进 `e2e/`，并让它成为 CI 的一个 job：

- **目录与职责分离**：`e2e/config.mjs`（统一参数）、`e2e/lib/`（像素工具）、`e2e/harness/`（esbuild 打包的浏览器入口）、`e2e/verify/`（验收脚本）、`e2e/fixtures/`（零素材依赖的 fixture）。**不与 `tests/` 混**：`vitest.config.ts` 的 include 只扫 `tests/**/*.test.ts`。
- **不用 playwright/puppeteer**：脚本自己 `spawn` Edge + 手写裸 CDP（`package.json` 里没有这两个依赖）。
- **参数一律走 `e2e/config.mjs`**，机器相关项不许硬编码：`EDGE_PATH` / `WE_WORKSHOP` / `WE_ASSETS` / `PORT` / `CDP_PORT` / `TIMEOUT_MS`，未设置时给**可读错误**而不是静默失败。
- **判据失败置非零退出码**（含 `catch` 分支）；用法一律 `node e2e/verify/<name>.mjs`。这是"能上 CI"的前置条件。
- **去掉固定等待**：`sleep(6000)` 改成轮询 harness 设的 `document.title === 'ready'`，超时再落回固定上限（固定等待是 e2e 最脆的一环）。
- **用生产 `lib/` 渲染真实素材**，不依赖 DSH token；依赖本机 DSH `app.asar` 或 token 的脚本**永不进 CI**。
- **fixture 入选标准**：入库的是**壁纸包内的派生图**（`fixtures/clouds-dxt1.png`，从本机 `3743126786/scene.pkg` 解出），不是 WE 自带素材 —— 项目政策是不再分发 WE 引擎素材。

**as-built 订正（2026-10-10）**：设计里 `typecheck`/`test` 两个 job 写的是 ubuntu，实际三个 job 都跑 `windows-latest`（README 只声明 Windows 实测，Linux 行为未验证）；`test` 门禁除"新增失败"外，套件级错误与未处理异常也判红；e2e 实际入 CI 的只有 `e2e:colorblend`（`e2e:card` 要从本机 DSH 的 `app.asar` 提主题 CSS，2026-10-10 首次真实 run 红，已移除）。

## 涉及仓库

- `dsh-use-wallpaper` 分支 `master` commits `65f759c` `3718011`

## Alternatives considered

**继续把验证脚本留在 `research/`。** 理由：`research/` 体积大（含 C++/lwe 源码与截图），入库会污染仓库。不用它是因为代价不成比例 —— 验收不可复现是当时最大的工程风险，而真正需要入库的只是最小集合（参数化后的几个脚本 + 一张 fixture），不是整个 `research/`。

**装 playwright/puppeteer 起浏览器。** 理由：成熟 API 省掉手写 CDP 的活，选择器与等待原语齐全。不用它是因为手写裸 CDP 的方案**已在仓库里验证可行**，而引入 playwright 要付依赖树 + 浏览器下载，且 CI 上还要处理版本与路径 —— 收益只在写脚本时，代价在每次安装与升级。

**CI 上用整文件 exclude 处理既有失败。** 理由：`verify-real-library` 与 `bootstrap.dom` 各有 1 项失败，直接 exclude 两个文件最省事。不用它是因为会连带丢掉同文件里能跑的用例，改用逐项 allowlist（`scripts/known-failures.json`）；`verify-real-library.test.ts` 另外改成 `it.skipIf(!hasLibrary)` 并显式告警，消除"CI 恒绿"的假象。

## Consequences

**收益：** 验收从"本机某次会话的截图"变成可复现、可交接、可被 CI 判红的门禁；零素材依赖的 `e2e:colorblend` 能上标准 runner；判据取反就 exit 1（`README`/`TESTING.md` 记了这条自检），使"判据有没有生效"本身可验证。

**代价：** 依赖本机 Steam 素材、本机 DSH `app.asar` 或真 GPU 的那些脚本仍然进不了 CI（`--gpu` 档在标准 runner 上**永久不可用**，需自托管）；阈值只在本机 SwiftShader + Edge 标定过，非本机稳定性未验证；`windows-latest` 的 Edge 路径与 GPU 行为也未验证 —— 判据红了要先怀疑环境（`AGENT.md` §5.13 记了受限沙箱下 Edge 起不来的坑）。

设计与 as-built 见 [端到端验证入库 + CI 设计](../../../../docs/superpowers/specs/2026-09-22-e2e-harness-and-ci-design.md)；跑法见 `TESTING.md`。
