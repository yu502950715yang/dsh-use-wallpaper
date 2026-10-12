# `fxRes` 改为各分支实际上传尺寸实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `g_TextureNResolution`（`tex.userData.fxRes`）报告**纹理实际上传的宽高**，而不是 mip0 记录尺寸；四分量仍保持同值（`.z/.x === 1` 不得被破坏）。

**Architecture:** `withSprite()` 增两个参数 `(w, h)`，由四个产出纹理的分支各自传入「即将上传的宽高」；raw 走 `cropRowsToMap` 的返回、DXT 走 `cropCompressedToMap` 的返回（块对齐）、编码图像用解码 bitmap 尺寸、视频用 `video.videoWidth/Height`。分支外的语义一律不动。

**Tech Stack:** TypeScript + three.js r170 + vitest（node/jsdom）+ Playwright/headless Edge（e2e，`--gpu`、串行）。

**Spec:** `docs/superpowers/specs/2026-10-12-fxres-actual-upload-size-design.md`（事实依据：`.superpowers/sdd/2026-10-12-plugin-hygiene/a1-research.md`）

## Global Constraints

- **四分量必须同值**：每个分支只报一个 `(w,h)` 对；任何分支若报出不同值的四分量，遮罩会再次错位 —— 判据①（e2e 所有槽 `z/x === 1`）是硬约束。
- **不改 RT 回退口径**：`g_Texture0` 绑 pass 输入 RT 时仍走 `resolveTextureResolution4` 的无 `fxRes` 回退 `(w,h,w,h)`。
- **不做真 padding 上传**；不建模粒子世界尺寸。
- 注释中文、一行说清、最多 2 行；提交标题一行 + 正文最多 3 行。
- 测试：`npx vitest run <file>`；全量 `npm test`（进入本计划前基线 = 卫生批收尾后的值，见 Task 1 实跑）。
- e2e 必须 `--gpu` 且**串行**；`--selftest` 为纯函数自检。
- 不得 `git add` `.research-mpkg*/`、`.superpowers/`、`output/`、`e2e/.out/`；不改 `master`；不 merge/push。
- `lib/`、`dist/` 只在最后一步（Task 4）重建，需用户确认时机。

## File Structure

| 文件 | 职责 | 改动 |
|---|---|---|
| `src/client/tex-loader.ts` | `fxRes` 的唯一生产者 | `withSprite(tex, w, h)` + 4 个调用点 + 注释 |
| `src/client/effect-runner.ts` | 消费口径 | `resolveTextureResolution4` 注释（逻辑不动） |
| `tests/tex-loader.test.ts` | 单测 | 补 padded-raw / DXT / 视频 3 条 |
| `e2e/verify/verify-isolated-rt-sharpness.mjs` | 验收 | `xOverTexImage` 观察量 → 判定项 |
| `AGENT.md`、`docs/fixes/conventions-details.md`、两份设计文档 | 口径记录 | 事实订正 |

---

### Task 1: `withSprite` 增参 + 4 个调用点 + 单测

**Files:**
- Modify: `src/client/tex-loader.ts`（`withSprite` 约 `:470-478`；调用点约 `:513`（视频）、`:544`（编码图像）、`:567`（raw）、`:619`（DXT））
- Test: `tests/tex-loader.test.ts`

**Interfaces:**
- Produces: `withSprite(tex: THREE.Texture, w: number, h: number): THREE.Texture`，写 `ud.fxRes = [w, h, w, h]`
- Consumes: `cropRowsToMap(...)`、`cropCompressedToMap(...)` 的 `{width, height}`（既有返回）

- [ ] **Step 1: 写失败测试**（三条，放 `tests/tex-loader.test.ts` 的 fxRes describe 内）

```ts
it('padded-raw：alloc 256×128 / image 100×50 / mip 256×128 ⇒ 报实际裁剪后的 [100,50,100,50]', async () => {
  // 与既有 NPOT 用例同构，但断言「上传尺寸」而非「mip0 记录尺寸」——
  // 载荷为 raw RGBA8888（imageFormat 非 13/2），走 cropRowsToMap 行裁剪分支
  // …（用 tests/fixtures/make-tex.js 造：textureWidth/Height 256×128、imageWidth/Height 100×50、mip 256×128、format=RGBA8888）
  expect((tex!.userData as { fxRes: number[] }).fxRes).toEqual([100, 50, 100, 50]);
});

it('DXT 块对齐：60×30 ⇒ 上报 ceil4 的 [60,32,60,32]', async () => {
  // 复用 tests/tex-loader.test.ts:798-812 的 DXT fixture（60×30）
  expect(fxRes).toEqual([60, 32, 60, 32]);
});

it('视频：mip0 记录 ≠ 视频尺寸时以视频尺寸为准', async () => {
  // 复用既有视频用例的构造方式（dom 测试里已有 VideoTexture 路径）
  expect(fxRes).toEqual([videoW, videoH, videoW, videoH]);
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run tests/tex-loader.test.ts -t fxRes`
Expected: padded-raw 与 DXT 两条 FAIL（现口径报 `[256,128,256,128]` / `[64,32,64,32]` 之类），视频那条视构造而定。

- [ ] **Step 3: 最小实现**

```ts
const withSprite = (tex: THREE.Texture, w: number, h: number): THREE.Texture => {
  const ud: Record<string, unknown> = { ...(tex.userData ?? {}) };
  if (info.sprite) ud.sprite = info.sprite;
  // g_TextureNResolution 四分量一律同值 = **实际会上传的宽高**：效果 shader 用 `.z/.x`
  // 缩放遮罩 UV，比值必须为 1；报 mip0 记录尺寸会在裁剪类纹理上偏 分配/内容（见 AGENT.md §5.17）。
  ud.fxRes = [w, h, w, h];
  tex.userData = ud;
  return tex;
};
```
4 个调用点分别传入：视频 `video.videoWidth/videoHeight`；编码图像解码后的 `bitmap.width/height`；raw `cropRowsToMap(...)` 的 `{width,height}`；DXT `cropCompressedToMap(...)` 的 `{width,height}`。

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/tex-loader.test.ts tests/dom/tex-loader-video.dom.test.ts` → 全绿（含既有 3 条 `z/x === 1`）
Run: `npm test` → 贴总数（应 = 基线 + 3）

- [ ] **Step 5: 提交**

```bash
git add src/client/tex-loader.ts tests/tex-loader.test.ts
git commit -m "fix(client): fxRes 改为各分支实际上传尺寸（四分量仍同值）"
```

---

### Task 2: e2e 观察量升级为判据

**Files:**
- Modify: `e2e/verify/verify-isolated-rt-sharpness.mjs`（`xOverTexImage` 聚合处约 `:824-833`）

**Interfaces:**
- Consumes: `window.__fxResProbe()` 的 `{x, texImage}` 行
- Produces: 新判据「`x / texImage[0]` 偏离 1 的槽数 === 0」（不可比行——`texImage` 为 `null` 或 `x <= 0`——按既有规则排除，并在 detail 里报「可比槽 N」）

- [ ] **Step 1: 加判据**：沿用 `add(name, ok, detail)` 惯例，阈值仍用 `1e-6`；`metrics.json` 里保留原观察量字段（供诊断）。
- [ ] **Step 2: 跑真机（串行）**：`node e2e/verify/verify-isolated-rt-sharpness.mjs --gpu` ⇒ 期望 **8/8、0 FAIL、exit 0**，新判据 PASS 且 detail 显示偏离槽数 **0**（A1 前 `1429403119` 为 21/56）。
- [ ] **Step 3: 反向验证**：`git checkout <本计划前的 HEAD> -- src/client/tex-loader.ts` ⇒ 期望新判据 **FAIL**（21/56）、exit 1；`git checkout HEAD -- src/client/tex-loader.ts` 恢复 ⇒ exit 0，`git diff --stat` 为空。
- [ ] **Step 4: 提交**

```bash
git add e2e/verify/verify-isolated-rt-sharpness.mjs
git commit -m "test(e2e): fxRes 上传尺寸观察量升级为判据（偏离 1 必须为 0）"
```

---

### Task 3: 文档与注释订正

**Files:**
- Modify: `AGENT.md`（§5.17、§7.37）、`docs/fixes/conventions-details.md`（§5.17）、`docs/superpowers/specs/2026-10-12-fxres-actual-upload-size-design.md`（状态 → 已实现）、`docs/superpowers/specs/2026-10-12-isolated-object-rt-resolution-design.md`（§7/R32 若涉及）、`src/client/effect-runner.ts`（注释）

- [ ] **Step 1**：`AGENT.md §5.17` —— 口径改为「四分量同值 = **实际上传尺寸**」；sprite 隐患句收紧为「sprite + **mip0 记录 > image** ⇒ 本机库 0 实例」（实测 sprite + alloc≠image 有 2 例，但载荷无 padding）。
- [ ] **Step 2**：`AGENT.md §7.37` 改写为「已实现」+ 三条事实（当前库内数值影响 0：B/C/D 类用法全在 slot 0 的 RT 回退；DXT `ceil4` 是唯一代码层第三类、本机库 0 实例；四分量同值不变量）。
- [ ] **Step 3**：`docs/fixes/conventions-details.md §5.17` 归档本次实测数字（变更集 51 纹理 / 8 张壁纸；`xOverTexImage` 21/56 → 0）；`effect-runner.ts` 注释同步；视频 1×1 兜底加「故意不带 `fxRes`」一行。
- [ ] **Step 4**：验证 `npm test` 全绿 + `--selftest` 16/16 + `git diff --stat` 范围；提交 `docs(agent): 回写 fxRes 实际上传尺寸口径与影响面`。

---

### Task 4（单独确认后执行）：重建产物与目视

- [ ] **Step 1**：用户确认时机 → `npm run build && npm run build:client`
- [ ] **Step 2**：`grep -c` 校验 `lib/client/tex-loader.js` 的 `ud.fxRes = [w, h, w, h]` 形态（不再是 `[mip.width,…]`）
- [ ] **Step 3**：`npm test` 全绿后提交 `chore(build): 重建 lib/ 与 dist/ 产物（fxRes 口径）`
- [ ] **Step 4**：真机目视魔兽之门 / GTR（DXT）/ In the Mountains（sprite）⇒ **预期无差异**（本改动当前无可观测影响）

## Self-Review

- **Spec coverage**：设计 §1 的差异表 → Task 1 逐分支；§4 验收 1/2 → Task 1、3 → Task 2、4 → Task 1/2、5 → Task 4；§5 边界与文档 → Task 3。无缺口。
- **Placeholder scan**：无 TBD；测试与实现均给出具体取值（`[100,50,100,50]`、`[60,32,60,32]`）。
- **Type consistency**：`withSprite(tex, w, h)` 在 Task 1 内定义并消费；e2e 判据名与既有 `add()` 惯例一致。
