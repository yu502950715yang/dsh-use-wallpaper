# 插件卫生清理（零风险那批 deferred）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把前两轮特性（隔离 RT 分辨率、效果遮罩 UV 口径）审查中判为「Minor / 可延后」的**零风险**项清掉：不改行为、不放宽判据、不引入新功能。

**Architecture:** 两批互不重叠的文件范围。批一 = 生产代码的注释/死代码/隐式依赖 + 对应单测；批二 = e2e 脚本可读性 + 文档措辞与 locator。每批一次实现 + 一次任务审查。

**Tech Stack:** TypeScript + three.js r170 + vitest（node/jsdom）+ Playwright/headless Edge（e2e，`--gpu`、串行）。

**Spec:** 两项特性的设计与台账：`docs/superpowers/specs/2026-10-12-isolated-object-rt-resolution-design.md`、`docs/superpowers/specs/2026-10-12-mask-uv-npot-design.md`；deferred 清单见 `.superpowers/sdd/2026-10-12-isolated-object-rt-resolution/progress.md` 与 `.superpowers/sdd/2026-10-12-mask-uv-npot-fix/progress.md`。

## Global Constraints

- **零行为变化**：除明确列出的「把 console.warn 提前」外，不得改变任何运行期语义；不得改判据阈值/容差/作用域。
- **不放宽测试**：只允许加强断言（钉具体值、补缺失路径），不得删除或弱化既有断言；删死代码时随之删除其专有测试（唯一例外，需在报告里点名）。
- 注释中文、一行说清「是什么/为什么」，最多 2 行；提交标题一行 + 正文最多 3 行。
- 测试：`npx vitest run <file>`；全量 `npm test`（基线 **55 files / 1115 通过**）。
- e2e 必须 `--gpu` 且**串行**（端口固定）；`node e2e/verify/verify-isolated-rt-sharpness.mjs --selftest` 为纯函数自检（秒级）。
- 不得 `git add` `.research-mpkg*/`、`.superpowers/`、`output/`、`e2e/.out/`；不改 `master`；不 merge/push。
- **不碰** `lib/`、`dist/`（构建产物留到发布步骤）。

## File Structure

| 批次 | 文件 | 内容 |
|---|---|---|
| 批一 | `src/client/three-renderer.ts` | `fg.dataset.wpId` → 闭包变量；`if (!id)` 早退不再吞掉 warn；准入谓词去重与 `if (!sized) continue` 语义注释；粒子路径注释 |
| 批一 | `src/client/effect-runner.ts` | 删死导出 `resolveTextureResolution`（`src/` 无调用方） |
| 批一 | `src/client/object-range.ts` | 二分迭代次数命名；`:318` 注释「本模块不 import three」订正 |
| 批一 | `src/client/object-effects.ts` | `:69` / `:179` / `:192` 注释措辞与指针订正 |
| 批一 | `tests/{three-renderer,threejs-player,object-range,object-effects,effect-runner}.test.ts` | 补 R27 复位用例、`resizeObjectRT` 尺寸分支断言、缺 size 兜底用例、拆 `it`、加强不等式断言、spy 掉 console.warn、jsdom 显式注入测光函数、删死导出的测试 |
| 批二 | `e2e/verify/verify-text-clock-layer.mjs` | 渲染器行双重 JSON 编码；`__glRendererInfo` 取不到 ext 时显式告警 |
| 批二 | `docs/superpowers/specs/2026-10-12-isolated-object-rt-resolution-design.md` 等文档 | FPS/告警的术语一致化、`1.604` locator、`§5` 指针、`屏占位` 标量/尺寸对混用 等措辞 |

---

### Task 1: 生产代码卫生 + 单测加强

**Files:** 见上表「批一」。

- [ ] **Step 1**：`three-renderer.ts` —— 把 `fg.dataset.wpId` 改为闭包变量（`contextLostId`），去掉对调用方 canvas 的 DOM 写入与「dataset 先于注册」的隐式次序；`onContextLost` 里 `if (!id) return` 改为**先 warn 再早退**（丢失不得完全静默）。
- [ ] **Step 2**：`three-renderer.ts` —— 准入谓词去重（`:547-550` / `:575-580`）与 `if (!sized) continue` 的语义注释（漂移时不得「悄悄不隔离」）。
- [ ] **Step 3**：删 `effect-runner.ts:304` 的 `resolveTextureResolution` 及其在 `tests/effect-runner.test.ts` 的专有用例（**唯一允许的删除**）；`object-range.ts` 二分迭代次数命名（如 `BUDGET_BISECT_STEPS`）、`:318` 注释订正为「本类型不依赖 three」。
- [ ] **Step 4**：`object-effects.ts` 的 `:69`/`:179`/`:192` 注释与指针订正；`threejs-player.ts` 粒子路径（`:602-603`）注明「粒子不进预算、仍用屏占位」。
- [ ] **Step 5**：单测加强（全部只加不减）：R27「上下文丢失 → 复位 → 再 render 仍成功」；`resizeObjectRT` 尺寸变化分支的标志重估；`three-renderer` 缺 size 走纹理像素兜底；`object-effects` 用例①钉精确值、预算用例钉实际收窄值；`object-range` 六条挤一 `it` 拆分；3 条新用例的 `console.warn` 用 spy 收口；控制器 jsdom describe 显式注入 `measurePreviewLuma: async () => null`。
- [ ] **Step 6**：`npx vitest run tests/<各文件>` 全绿 + `npm test` **55 files / ≥1115 通过**（删死代码用例后总数可能为 1110 左右 —— 如实报告差值），`npx tsc --noEmit` exit 0；提交 `chore(client): 清理隔离 RT 相关卫生项（注释/死导出/隐式依赖）`。

### Task 2: e2e 可读性 + 文档措辞/locator

**Files:** 见上表「批二」。

- [ ] **Step 1**：`verify-text-clock-layer.mjs` 渲染器行去掉双重 `JSON.stringify`；`__glRendererInfo` 在拿不到 `WEBGL_debug_renderer_info` 或命中 `SwiftShader|Software|llvmpipe` 时**显式告警**（不改判据）。
- [ ] **Step 2**：文档订正：FPS ≥30 与「无失败类告警」在 `TESTING.md`/脚本头/设计文档里的术语统一；`design:158` 的「全图平均梯度 1.604，见文末」改为指向 `task-9-report.md`；`design:205` 的「（见 §5）」改为 `AGENT.md §7.36①`；`AGENT.md:128` 的「屏占位」尺寸对/标量混用订正；`conventions-details:286`「摘一个还没挂上的监听」措辞订正；`spec §4:159` 的陈旧句订正。
- [ ] **Step 3**：验证：`npm test` 全绿；`node e2e/verify/verify-isolated-rt-sharpness.mjs --selftest` 16/16；`node e2e/verify/verify-text-clock-layer.mjs --id=1922570576 --gpu` 11 项 PASS；提交 `chore(e2e): 清理 e2e 可读性与文档措辞（卫生批）`。

## Self-Review

- **Spec coverage**：两批覆盖台账里全部「零风险」条目；需要决策的（A1 `fxRes` = 实际上传尺寸、A3 低显存压力用例）**不在本计划**。
- **Placeholder scan**：无 TBD；每步都有具体文件与验收命令。
- **Type consistency**：本计划不新增接口；删除的 `resolveTextureResolution` 在 src 内零调用方（已 `git grep` 核实）。
