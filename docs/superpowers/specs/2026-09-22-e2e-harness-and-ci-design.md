# 端到端验证入库 + CI 设计（2026-09-22）

## 1. 背景与目标

`AGENT.md` §3.3 把「自起 http server + headless Edge + esbuild 打包 harness，用生产 `lib/` 渲染真实纹理并逐像素判定」列为**最可靠的渲染验证方式**，但整套手段都在被 gitignore 的 `research/` 里（`.gitignore:6`，`git ls-files research` = 0）。同一份报告链（`.superpowers/sdd/**`）也被忽略（`.gitignore:7`，跟踪数 0）。

后果：**任何改动的验收都不可复现、不可交接、无法进 CI**。这是当前最大的工程风险。

目标：把**最小可运行**的 e2e 集合收进仓库、消除机器相关硬编码、给判据补上非零退出码，并接上 CI。

## 2. 现状证据（只读调研结论）

| 事实 | 证据 |
|---|---|
| 浏览器**不是** playwright/puppeteer 起的（依赖里没有），而是 `spawn` Edge + 手写裸 CDP | `research/verify-colorblend.mjs:75`、`:86-96`；`package.json:27-46` 无 playwright |
| Edge 路径硬编码，全目录只有 1 处支持 env | `verify-colorblend.mjs:75`（无兜底）；`eva-cover-probe.mjs:16`（唯一 `EDGE_PATH`） |
| **288/301 个脚本 FAIL 时退出码仍是 0** | 只有 13 个脚本写 `process.exitCode`；`verify-colorblend.mjs:127-130`、`verify-object-effects.mjs:1928-1932` 只打印 |
| 脚本异常时也不置非零 | `verify-colorblend.mjs:131-132` 只 `console.error` |
| 素材根硬编码 | `verify-object-effects.mjs:84-85`、`verify-hidpi-object-rt.mjs:76-77` |
| `verify-colorblend.mjs` 无 DSH token 依赖，但依赖本地 fixture | `:24` `CLOUDS_PNG`（711 KB，由 `gtr-dxt1-alpha.mjs:93` 从本机 pkg 解出） |
| `verify-real-library.test.ts` 在 CI 上**静默空跑** | `:14-15` `existsSync` + `:68-71` 无库即 `return`，无断言 |
| 仓库无 CI | `Test-Path .github/workflows` = False |
| 标准 runner 无 GPU，但 e2e 默认 SwiftShader ⇒ **不需要 GPU** | `verify-object-effects.mjs:652` 缺省加 `--enable-unsafe-swiftshader` |
| `.playwright-cli/`、`.pw-local/` 与这些脚本无关 | `git check-ignore`：`.gitignore:8`、`:11`；两目录跟踪数 0 |

## 3. 方案

### 3.1 目录

`tests/` 被 vitest 扫描（`vitest.config.ts:6` include 仅 `tests/**/*.test.ts`），e2e 不混入：

```
e2e/
  config.mjs   统一参数解析（EDGE_PATH / WE_WORKSHOP / WE_ASSETS / PORT / CDP_PORT / 超时）
  lib/         png-stats.mjs  png-encode.mjs  hidpi-metrics.mjs  stub-glslang.mjs
  harness/     harness-object-effects-entry.mjs  harness-colorblend-entry.mjs
  verify/      verify-colorblend.mjs  verify-hidpi-object-rt.mjs
  fixtures/    clouds-dxt1.png
```

`stub-glslang.mjs` 是 esbuild 的 `alias` 目标（`verify-object-effects.mjs:324`），缺失则浏览器打包失败；**它随 Task A 删除 `@webgpu/glslang` 后即可一起删**。

### 3.2 参数化（抄仓库既有先例）

| 项 | 先例 | 落到 `e2e/config.mjs` |
|---|---|---|
| 浏览器 | `eva-cover-probe.mjs:16` | `EDGE_PATH ?? <默认安装路径>`，加 `existsSync` 前置报错 |
| workshop 根 | `q-rt-vram-sweep.mjs:32` | `WE_WORKSHOP ?? D:/Steam/steamapps/workshop/content/431960` |
| WE 安装目录 | `scan-tex-padding.mjs:7` | `WE_ASSETS ?? D:/Steam/steamapps/common/wallpaper_engine` |
| 端口 | `verify-hidpi-object-rt.mjs:73-74` | `PORT` / `CDP_PORT`，支持 env 覆盖 |
| 超时 | — | `TIMEOUT_MS`，CI 慢机可放宽 |

### 3.3 退出码门禁（上 CI 的前置条件）

- 判据结束设 `process.exitCode = allPass ? 0 : 1`（抄 `verify-hidpi-object-rt.mjs:519`）。
- `catch` 分支同样置 1（现状崩溃也返回 0）。
- 用法说明改为 `node e2e/verify/<name>.mjs`。

### 3.4 去掉固定等待

`verify-colorblend.mjs:102` 的 `sleep(6000)` 换为轮询 `document.title === 'ready'`（harness 在 `harness-colorblend-entry.mjs:64` 已设 title），超时落回固定上限。固定等待是 e2e 最脆的一环。

## 4. CI 设计（Task B2）

| job | runner | 内容 |
|---|---|---|
| `typecheck` | ubuntu | `tsc --noEmit` + **产物新鲜度守卫** `git diff --exit-code lib/`（`lib/` 100 个文件入库；每次功能提交都同时提交 `src/`+`lib/`+`dist/client.js`，见 `f460767`） |
| `test` | ubuntu | `vitest run` + **已知失败 allowlist**（不用整文件 exclude —— `verify-real-library` 与 `bootstrap.dom` 各只 1 项失败，exclude 会白丢覆盖） |
| `e2e` | windows-latest | 最小 e2e 集合，SwiftShader 档；`--gpu` 档**永久不可用**（标准 runner 无 GPU），需自托管 |

`tests/verify-real-library.test.ts` 改为 `it.skipIf(!hasLibrary)` 并显式告警，消除「CI 恒绿」的假象。

## 5. 验收口径

- `EDGE_PATH` / `WE_WORKSHOP` 未设置时脚本报**可读错误**而非静默失败。
- `node e2e/verify/verify-colorblend.mjs` 在本机 exit 0（不需要 WE 素材）。
- `node e2e/verify/verify-hidpi-object-rt.mjs --id 2683211654` 在本机 exit 0。
- 人为把判据取反 → 必须 exit 1（证明门禁真的生效）。

## 6. 已知边界（如实）

- 判据阈值（`verify-colorblend.mjs:117-125` 的容差 3/4/2、`verify-hidpi-object-rt.mjs:411` 的精确匹配）只在本机 SwiftShader + Edge 标定过，**非本机环境稳定性未验证**。
- `windows-latest` 上 Edge 预装路径**未验证**，脚本需 `Test-Path` + `Get-Command msedge` 兜底。
- `fixtures/clouds-dxt1.png` 是从本机 workshop `3743126786/scene.pkg` 解出的单张纹理。项目政策是**不再分发 WE 自带素材**（`.gitignore:22-26`），入库的是**壁纸包内的派生图**而非引擎素材；用例与边界需在 README/AGENT 里注明。
- `verify-object-effects.mjs`（144 KB、依赖 10 张硬编码壁纸 + WE assets）本期**不入库**，留作 `workflow_dispatch` 手动验收。
- 依赖 DSH 3080/token 的 20 个脚本（`verify-wasm-render.mjs` 等）**永不进 CI**。
