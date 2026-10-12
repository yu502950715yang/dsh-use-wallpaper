# 效果遮罩 UV 口径修复（NPOT padding）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `g_TextureNResolution` 的 `.z/.w` 取**同值**（= mip0 记录尺寸）⇒ `.z/.x` 恒为 1，使效果遮罩（水面波动等）回到作者指定的位置。

**Architecture:** **本机库内不存在**按 `.tex` 头 padding 分配的纹理（`createImageBitmap` 解出即上传；原始像素载荷类经 `cropToMap` 裁到内容宽高后上传），但「mip0 记录尺寸 == 实际上传尺寸」**不是全称** —— 原始像素载荷类（`mip0 记录 == 分配`，51 个）上传的是 `cropToMap` 裁出的内容宽高，其 `.x/.y` 与真实纹理尺寸仍差约 1.6×（follow-up，见设计 §7）。把 `tex-loader` 写入 `userData.fxRes` 的 `.zw` 从 `.tex` 头里的分配尺寸改为 mip0 记录尺寸（**四分量同值**），即可让所有 `uv * z/x` 形式的遮罩 UV 缩放退化为恒等；`resolveTextureResolution4` 的既有回退（RT 与无 `fxRes` 纹理返回 `{x:w,y:h,z:w,w:h}`）本就是这一口径，无需改逻辑。

**Tech Stack:** TypeScript + three.js r170 + vitest（jsdom/node 双环境）+ Playwright/headless Edge（e2e，`--gpu`）。

**Spec:** `docs/superpowers/specs/2026-10-12-mask-uv-npot-design.md`（根因证据、全库 shader 审计、影响面、方案取舍）。

## Global Constraints

- `OBJECT_RT_MAX = 4096`、隔离 RT「只升不降」等既有不变量**不得**变动：本计划只改 `g_TextureNResolution` 的口径。
- **不得**改任何 shader（shader 来自壁纸包，属 WE 官方实现）；**不得**改 `resolveTextureResolution4` 的逻辑（只订正注释）。
- **不得**为观测新增生产导出/接口：e2e 探针只加在 `e2e/harness/*.mjs`，利用 TS `private` 在运行期可读（与既有 `__isoInfo` 同法）。
- 注释中文、一行说清「是什么/为什么」，最多 2 行；提交信息标题一行 + 正文最多 3 行。
- 测试：`npx vitest run <file>`；全量 `npm test`（当前基线 **55 files / 1109 通过**）。
- e2e 必须 `--gpu` 且**串行**（harness 端口固定 9813）。
- 不得 `git add` `.research-mpkg*/`、`.superpowers/`、`output/`；不改 `master`；不 merge/push。
- **构建产物（`lib/`、`dist/`）单独一步**：profile 是符号链接到本仓库，重建会经 client-hmr 影响正在运行的会话 ⇒ 需用户确认时机，不并入本计划的提交。

## File Structure

| 文件 | 职责 | 改动 |
|---|---|---|
| `src/client/tex-loader.ts` | `.tex` → three 纹理；`fxRes` 的唯一生产者 | `:471-473` 取值改为四分量同值（= mip0 记录尺寸）+ 注释订正 |
| `src/client/effect-runner.ts` | `g_TextureNResolution` 的 vec4 口径 | `:315-321` 注释订正（逻辑不动） |
| `tests/tex-loader.test.ts` | tex-loader 单测 | 新增 3 条用例 |
| `tests/effect-runner.test.ts` | 效果运行器单测 | 新增 1 条口径一致性用例 |
| `e2e/harness/harness-text-clock-entry.mjs` | e2e 页面入口（只读探针） | 新增 `window.__fxResProbe()` |
| `e2e/verify/verify-isolated-rt-sharpness.mjs` | 隔离 RT e2e 验收脚本 | 新增遮罩槽口径判据 |
| `AGENT.md` | 仓库工程约定 | §5.17 订正 + §7 新增遗留 |
| `docs/fixes/conventions-details.md` | §5 条目的实测归档 | 新增审计数据 |
| `docs/superpowers/specs/2026-10-12-mask-uv-npot-design.md` | 本设计 | 状态改「已实现」 |

---

### Task 1: `fxRes` 改为「四分量同值（= mip0 记录尺寸）」口径

**Files:**
- Modify: `src/client/tex-loader.ts:471-475`
- Test: `tests/tex-loader.test.ts`（文件末尾追加 describe）

**Interfaces:**
- Consumes: `textureFromTex(info: TexInfo, opts?): Promise<THREE.Texture | null>`（既有）；`tests/fixtures/make-tex.js` 的 `makeTex`（既有）
- Produces: `tex.userData.fxRes: [number, number, number, number]`，语义固定为「**四分量一律同值（= mip0 记录尺寸）**」⇒ `[w, h, w, h]`（w/h = mip0 记录尺寸；所有纹理路径共用。对「`mip0 记录 == 分配`」的那一类它是分配尺寸、不是上传尺寸 —— follow-up 见设计 §7）

- [x] **Step 1: 写失败测试**

在 `tests/tex-loader.test.ts` 末尾追加（`makeTex`/`parseTex`/`textureFromTex`/`TEX_FORMAT` 已在文件头 import）：

```ts
describe('fxRes：四分量一律同值（mip0 记录尺寸）⇒ 遮罩 UV 缩放为 1', () => {
  const npot = () => makeTex({
    format: TEX_FORMAT.RGBA8888,
    flags: 2,
    textureWidth: 256, textureHeight: 128,   // 分配（.tex 头）
    imageWidth: 100, imageHeight: 50,        // 内容（mip0 载荷）
    images: [[{ width: 100, height: 50, data: new Uint8Array(100 * 50 * 4) }]],
  });

  it('NPOT：分配 256×128 / 内容 100×50 ⇒ fxRes = [100,50,100,50]', async () => {
    const tex = await textureFromTex(parseTex(npot())!);
    expect((tex!.userData as { fxRes: number[] }).fxRes).toEqual([100, 50, 100, 50]);
  });

  it('2 的幂：分配 == 内容 ⇒ fxRes 不变', async () => {
    const buf = makeTex({
      format: TEX_FORMAT.RGBA8888, flags: 2,
      textureWidth: 64, textureHeight: 64, imageWidth: 64, imageHeight: 64,
      images: [[{ width: 64, height: 64, data: new Uint8Array(64 * 64 * 4) }]],
    });
    const tex = await textureFromTex(parseTex(buf)!);
    expect((tex!.userData as { fxRes: number[] }).fxRes).toEqual([64, 64, 64, 64]);
  });

  it('遮罩 UV 缩放因数 z/x 与 w/y 恒为 1（waterripple.vert 口径）', async () => {
    const fx = (await textureFromTex(parseTex(npot())!))!.userData as { fxRes: number[] };
    expect(fx.fxRes[2] / fx.fxRes[0]).toBe(1);
    expect(fx.fxRes[3] / fx.fxRes[1]).toBe(1);
  });
});
```

- [x] **Step 2: 跑测试确认红**

Run: `npx vitest run tests/tex-loader.test.ts -t fxRes`
Expected: 第一条 FAIL —— `expected [ 100, 50, 256, 128 ] to deeply equal [ 100, 50, 100, 50 ]`（第三条同样 FAIL）

- [x] **Step 3: 最小实现**

`src/client/tex-loader.ts:471-475` 改为（下列 2 行即**实际提交**的注释；口径 =「四分量一律同值（= mip0 记录尺寸）」，见设计 §5.1）：

```ts
    // g_TextureNResolution 四分量一律同值（mip0 记录尺寸）：效果 shader 用 `.z/.x` 缩放
    // 遮罩 UV，比值必须为 1，否则 NPOT padding 会把遮罩按 分配/内容 挤向画面左上（见 AGENT.md §5.17）。
    ud.fxRes = [mip.width, mip.height, mip.width, mip.height];
```

- [x] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/tex-loader.test.ts`
Expected: PASS（含既有 `parseTex`/采样/精灵表用例）；特别确认 `tests/dom/tex-loader-video.dom.test.ts:135` 的 `[1280,720,1280,720]` 仍绿

- [x] **Step 5: 全量回归并提交**

Run: `npm test`
Expected: 55 files / 1112 passed（1109 + 新增 3）

```bash
git add src/client/tex-loader.ts tests/tex-loader.test.ts
git commit -m "fix(client): 效果纹理的 g_TextureNResolution 四分量同值（= mip0 记录尺寸）"
```

---

### Task 2: `resolveTextureResolution4` 口径注释 + 一致性用例

**Files:**
- Modify: `src/client/effect-runner.ts:315-321`（仅注释）
- Test: `tests/effect-runner.test.ts`（追加）

**Interfaces:**
- Consumes: `resolveTextureResolution4(tex, fallbackW, fallbackH): {x,y,z,w}`（既有，签名不动）
- Produces: 无新接口；用例固定「RT/无 `fxRes` 回退」与「`fxRes` 四分量同值（= mip0 记录尺寸）」两种来源**同口径**

- [x] **Step 1: 写失败测试**

在 `tests/effect-runner.test.ts` 追加（该文件已 import 目标函数；若未 import 则补 `resolveTextureResolution4`）：

```ts
describe('g_TextureNResolution 口径（未 padding 上传）', () => {
  it('RT / 无 fxRes 的纹理回退为 (w,h,w,h)，与带 fxRes 的四分量同值口径一致', () => {
    const rt = resolveTextureResolution4({ image: { width: 4096, height: 1966 } }, 1, 1);
    expect(rt).toEqual({ x: 4096, y: 1966, z: 4096, w: 1966 });
    const tex = resolveTextureResolution4(
      { image: { width: 2500, height: 1200 }, userData: { fxRes: [2500, 1200, 2500, 1200] } }, 1, 1);
    expect(tex).toEqual(rt === tex ? tex : { x: 2500, y: 1200, z: 2500, w: 1200 });
    expect(tex.z / tex.x).toBe(1);
    expect(tex.w / tex.y).toBe(1);
  });
});
```

- [x] **Step 2: 跑测试确认红/绿边界**

Run: `npx vitest run tests/effect-runner.test.ts -t g_TextureNResolution`
Expected: Task 1 之后即 PASS；若把 Task 1 的 `.zw` 临时改回 `info.textureWidth/textureHeight`，则 `tex.z / tex.x` 变 1.6384 ⇒ 该断言 FAIL（这就是它的判别力）

- [x] **Step 3: 订正注释（逻辑不动）**

`src/client/effect-runner.ts:315-321` 注释改为：

```ts
// g_TextureNResolution 的 **vec4 分量**：四分量一律同值（= 纹理 mip0 记录尺寸）。WE 效果 shader
// 用 `.z/.x` 缩放遮罩 UV（waterripple/shake），比值必须为 1，否则 NPOT padding 会按 分配/内容
// 把遮罩挤向画面左上（见 AGENT.md §5.17）；RT 与未带 `fxRes` 的纹理走下方回退，同口径。
```

- [x] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/effect-runner.test.ts tests/tex-loader.test.ts`
Expected: 全绿

- [x] **Step 5: 提交**

```bash
git add src/client/effect-runner.ts tests/effect-runner.test.ts
git commit -m "docs(client): 订正 g_TextureNResolution 的 vec4 口径注释并钉住一致性"
```

---

### Task 3: e2e 真机口径判据（含反向验证）

**Files:**
- Modify: `e2e/harness/harness-text-clock-entry.mjs`（在 `__isoInfo` 之后追加探针）
- Modify: `e2e/verify/verify-isolated-rt-sharpness.mjs`（在结构性判据段之后追加判据）

**Interfaces:**
- Produces: `window.__fxResProbe(): Array<{ obj, slot, x, y, z, w, texImage }> | null`（e2e 专用只读探针）
- Consumes: `__player.objectEffectStage.entries`（Map: objId → entry）与 `entry.runner.materials`（Map: key → `THREE.ShaderMaterial`），均按 TS `private` 运行期可读处理

- [x] **Step 1: 加探针**

`e2e/harness/harness-text-clock-entry.mjs` 的 `__isoInfo` 之后追加：

```js
/** 只读观测：各隔离对象 pass 材质里 g_TextureNResolution 的实况（判据：未 padding ⇒ z/x === 1）。 */
window.__fxResProbe = () => {
  const stage = window.__player && window.__player.objectEffectStage;
  if (!stage || !stage.entries || typeof stage.entries[Symbol.iterator] !== 'function') return null;
  const out = [];
  for (const [objId, entry] of stage.entries) {
    const mats = entry && entry.runner && entry.runner.materials;
    if (!mats || typeof mats.values !== 'function') continue;
    for (const m of mats.values()) {
      for (const name of Object.keys(m.uniforms || {})) {
        const mm = /^g_Texture(\d)Resolution$/.exec(name);
        if (!mm) continue;
        const slot = Number(mm[1]);
        const t = m.uniforms['g_Texture' + slot];
        const v = m.uniforms[name] && m.uniforms[name].value;
        const img = t && t.value && t.value.image;
        out.push({
          obj: objId, slot,
          x: v ? v.x : null, y: v ? v.y : null, z: v ? v.z : null, w: v ? v.w : null,
          texImage: img ? [img.width, img.height] : null,
        });
      }
    }
  }
  return out;
};
```

- [x] **Step 2: 加判据**

`e2e/verify/verify-isolated-rt-sharpness.mjs` 的结构性判据段之后追加（该脚本已有 `evalJs` 与 `add(name, ok, detail)` 惯例）：

```js
  // 遮罩 UV 口径：未 padding 上传 ⇒ g_TextureNResolution 的 z/x 与 w/y 恒为 1（否则遮罩错位）
  const fx = await evalJs('JSON.stringify(window.__fxResProbe ? window.__fxResProbe() : null)');
  const rows = fx ? JSON.parse(fx) : null;
  if (rows && rows.length) {
    const bad = rows.filter((r) => r.x && r.z && Math.abs(r.z / r.x - 1) > 1e-6);
    add('遮罩槽分辨率口径 z/x === 1', bad.length === 0,
      bad.length ? `${bad.length}/${rows.length} 处异常，例：obj=${bad[0].obj} slot=${bad[0].slot} z/x=${(bad[0].z / bad[0].x).toFixed(4)}`
        : `${rows.length} 个槽全部为 1`);
    const mask = rows.find((r) => r.texImage && r.texImage[0] === 2500 && r.texImage[1] === 1200);
    add('魔兽之门遮罩已绑定且口径为 1', !!mask && Math.abs(mask.z / mask.x - 1) < 1e-6,
      mask ? `slot=${mask.slot} tex=${mask.texImage} z/x=${(mask.z / mask.x).toFixed(4)}` : '未找到 2500×1200 遮罩槽');
  }
```

- [x] **Step 3: 跑一次确认绿（真 GPU，串行）**

Run: `node e2e/verify/verify-isolated-rt-sharpness.mjs --id=1922570576 --gpu`
Expected: 既有判据全 PASS + 新增 2 条 PASS；`metrics.json` 里能看到遮罩槽 `z/x = 1`

- [x] **Step 4: 反向验证（判据有牙）**

```bash
git checkout 7ba4eca -- src/client/tex-loader.ts   # 修复前版本（任务已提交，git stash 是 no-op）
node e2e/verify/verify-isolated-rt-sharpness.mjs --id=1922570576 --gpu   # 期望 exit 1，报 z/x=1.6384
git checkout HEAD -- src/client/tex-loader.ts      # 恢复；git diff 应为空
node e2e/verify/verify-isolated-rt-sharpness.mjs --id=1922570576 --gpu   # 期望 exit 0
```

- [x] **Step 5: 提交**

```bash
git add e2e/harness/harness-text-clock-entry.mjs e2e/verify/verify-isolated-rt-sharpness.mjs
git commit -m "test(e2e): 钉住遮罩槽分辨率口径 z/x === 1"
```

---

### Task 4: 文档回写

**Files:**
- Modify: `AGENT.md`（§5.17 口径订正 + §7 新增遗留）
- Modify: `docs/fixes/conventions-details.md`（归档审计数据）
- Modify: `docs/superpowers/specs/2026-10-12-mask-uv-npot-design.md`（状态 → 已实现）

**Interfaces:**
- Consumes: Task 1–3 的最终代码与 e2e 实测数字
- Produces: 无代码接口

- [x] **Step 1: 订正 §5.17**

`AGENT.md` §5.17 的**旧口径表述**（lwe 约定：四分量分别取 mip0 与 header 尺寸）改为（下列即现文）：

```
§5.17 g_TextureNResolution 四分量一律同值（= 纹理 mip0 记录尺寸）；效果 shader 用 `.z/.x`
缩放遮罩 UV，比值必须为 1。插件不按 .tex 头做 padding 分配，故填头里的分配尺寸会让 NPOT 纹理的
遮罩按 分配/内容 挤向画面左上（真机：湖水波动跑到树上）。细节见 docs/fixes/conventions-details.md。
```

- [x] **Step 2: 新增 §7 遗留条目**

```
§7.37 `g_TextureNResolution` 只保证「四分量同值 ⇒ `.z/.x` 为 1」，**不保证取到实际上传尺寸**：
原始像素载荷类（`mip0 记录 == 分配`）上传前经 `cropToMap` 裁到 image 尺寸，故其 `.x/.y` 与真实
纹理尺寸仍差约 1.6×，凡把 `.x/.y`/`.z/.w` 当 texel 步长用的用法仍偏小。要彻底对齐需让 `fxRes`
等于各分支最终上传尺寸（独立行为变更，需单独 A/B 验证）。
```

- [x] **Step 3: 归档审计数据**

在 `docs/fixes/conventions-details.md` 为 §5.17 追加小节：遮罩几何验算表（v 0.78–0.86 → 0.46–0.51）、**库级口径（`type.lower() == "scene"`）**的表达式分类表（40 种 / 471 行；旧 28 张口径 32 种 / 376 行）、影响面（218 `.tex` 中 95 个 NPOT、23 张壁纸；旧口径 175 / 88 / 21）、审计脚本路径（`output/blur-analysis/{mask_placement,mask_scope,shader_audit,tex_padding_scope}.py`）。
**注意**：`output/` 被 gitignore，数据需以文字/表格形式进文档，不能只留路径。

- [x] **Step 4: 跑全量测试与 e2e**

Run: `npm test` → 期望 55 files / 1112 passed
Run: `node e2e/verify/verify-isolated-rt-sharpness.mjs --gpu` → 期望 5/5 张、含新增判据全 PASS、exit 0

- [x] **Step 5: 提交**

```bash
git add AGENT.md docs/fixes/conventions-details.md docs/superpowers/specs/2026-10-12-mask-uv-npot-design.md
git commit -m "docs(agent): 回写遮罩 UV 的四分量同值口径与审计数据"
```

---

### Task 5（单独确认后执行）：重建产物

**合并 / 发布边界（勿误判「合并即修复」）：** 本分支 `fix/mask-uv-npot` **从 `feat/isolated-object-rt-resolution` 切出**（切出点 = 该特性 HEAD `22e6fb4`）⇒ **合并本分支即同时并入该特性**（相对 `master` 领先 **特性 24 + 本分支 13 = 37 个提交**；另有设计与计划提交 `7ba4eca` 1 个 ⇒ `git rev-list --count master..HEAD` 实测 **38**）。**合并本身不改变运行时行为**（`lib/`、`dist/` 是提交进仓库的构建产物）—— 必须执行本任务的两条构建命令并**真机复看「湖面波动 / 树线不波动」**才算修复生效。

**Files:**
- Modify: `lib/**`、`dist/client.js(.map)`（构建产物）

- [x] **Step 1: 用户确认时机**（profile 符号链接到本仓库，重建会经 client-hmr 重挂正在运行的会话）
- [x] **Step 2:** `npm run build && npm run build:client`，两次 exit 0
- [x] **Step 3:** `grep -c "mip.width, mip.height, mip.width, mip.height" lib/client/tex-loader.js` = 1（`dist/client.js` 同为 1）；`grep -c "info.textureWidth, info.textureHeight" lib/client/tex-loader.js` = 0
- [x] **Step 4:** `npm test` 全绿后提交 `chore(build): 重建 lib/ 与 dist/ 产物（遮罩 UV 口径修复）`
- [x] **Step 5: 真机确认**：壁纸「魔兽之门」湖面出现波动、树线不再波动

---

## Self-Review

**1. Spec coverage**
- 根因（§2）→ Task 1（取值 + 注释）；口径注释（§5 理由 1）→ Task 2；审计结论（§3）→ Task 4 Step 3 归档；影响面（§4）→ Task 4 Step 3；验收（§6）1/2 → Task 1+2（单测 + 判别力）、3 → Task 3、4 → Task 5 Step 5；边界（§7）→ Task 4 Step 2。无缺口。

**2. Placeholder scan**
- 无 TBD/TODO；每个代码步骤给了可粘贴的代码；测试断言为具体数值（`[100,50,100,50]`、比值 1、真实遮罩 2500×1200）。

**3. Type consistency**
- `fxRes` 语义在 Task 1（生产）、Task 2（消费 + 断言）、Task 3（e2e 探针）三处一致：`[w,h,w,h]`。
- 探针字段 `{obj, slot, x, y, z, w, texImage}` 在 Task 3 的两个步骤之间一致。
- 判据名与阈值（`z/x === 1`，容差 1e-6）在 Task 3 Step 2/4 一致。

**已知风险**
- 原始像素载荷类（`mip0 记录 == 分配`，51 个）上传的是 `cropToMap` 裁出的内容宽高，其 `.x/.y` 与实际上传尺寸仍差约 1.6×（follow-up 见设计文档 §7）。
- e2e 探针依赖 TS `private` 运行期可读（既有 `__isoInfo` 已用同一手法）；若上游改名，探针返回 `null` 会跳过判据 —— Task 3 Step 2 已做 `rows && rows.length` 守卫，需在 Task 3 Step 3 确认**判据真的出现**（不是被跳过）。
