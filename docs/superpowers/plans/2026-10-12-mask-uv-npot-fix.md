# 效果遮罩 UV 口径修复（NPOT padding）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `g_TextureNResolution` 的 `.z/.w` 反映**实际上传的纹理尺寸**，使效果遮罩（水面波动等）回到作者指定的位置。

**Architecture:** 插件从不 padding 上传（`createImageBitmap` 解出即上传），所以「内容尺寸 == 分配尺寸」。把 `tex-loader` 写入 `userData.fxRes` 的 `.zw` 从 `.tex` 头里的分配尺寸改为 mip0 内容尺寸，即可让所有 `uv * z/x` 形式的遮罩 UV 缩放退化为恒等；`resolveTextureResolution4` 的既有回退（RT 与无 `fxRes` 纹理返回 `{x:w,y:h,z:w,w:h}`）本就是这一口径，无需改逻辑。

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
| `src/client/tex-loader.ts` | `.tex` → three 纹理；`fxRes` 的唯一生产者 | `:471-478` 取值改内容尺寸 + 注释订正 |
| `src/client/effect-runner.ts` | `g_TextureNResolution` 的 vec4 口径 | `:315-321` 注释订正（逻辑不动） |
| `tests/tex-loader.test.ts` | tex-loader 单测 | 新增 3 条用例 |
| `tests/effect-runner.test.ts` | 效果运行器单测 | 新增 1 条口径一致性用例 |
| `e2e/harness/harness-text-clock-entry.mjs` | e2e 页面入口（只读探针） | 新增 `window.__fxResProbe()` |
| `e2e/verify/verify-isolated-rt-sharpness.mjs` | 隔离 RT e2e 验收脚本 | 新增遮罩槽口径判据 |
| `AGENT.md` | 仓库工程约定 | §5.17 订正 + §7 新增遗留 |
| `docs/fixes/conventions-details.md` | §5 条目的实测归档 | 新增审计数据 |
| `docs/superpowers/specs/2026-10-12-mask-uv-npot-design.md` | 本设计 | 状态改「已实现」 |

---

### Task 1: `fxRes` 改为内容尺寸口径

**Files:**
- Modify: `src/client/tex-loader.ts:471-478`
- Test: `tests/tex-loader.test.ts`（文件末尾追加 describe）

**Interfaces:**
- Consumes: `textureFromTex(info: TexInfo, opts?): Promise<THREE.Texture | null>`（既有）；`tests/fixtures/make-tex.js` 的 `makeTex`（既有）
- Produces: `tex.userData.fxRes: [number, number, number, number]`，语义固定为 `[内容宽, 内容高, 内容宽, 内容高]`（所有纹理路径共用）

- [ ] **Step 1: 写失败测试**

在 `tests/tex-loader.test.ts` 末尾追加（`makeTex`/`parseTex`/`textureFromTex`/`TEX_FORMAT` 已在文件头 import）：

```ts
describe('fxRes：未 padding 上传 ⇒ 四分量一律按内容尺寸', () => {
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

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run tests/tex-loader.test.ts -t fxRes`
Expected: 第一条 FAIL —— `expected [ 100, 50, 256, 128 ] to deeply equal [ 100, 50, 100, 50 ]`（第三条同样 FAIL）

- [ ] **Step 3: 最小实现**

`src/client/tex-loader.ts:471-478` 改为（注释一并订正为「未 padding 上传」口径）：

```ts
    // 插件**从不 padding 上传**（createImageBitmap 解出即上传），内容占满整张纹理 ⇒
    // `g_TextureNResolution` 四分量一律按内容尺寸：`[w, h, w, h]`。效果 shader 的
    // `uv * .z/.x`（如水波纹遮罩）因此退化为恒等；若填 .tex 头的分配尺寸，遮罩会被
    // 按 分配/内容 的比例挤向画面左上（真机现象：湖面波动跑到湖水上方的树线上）。
    ud.fxRes = [mip.width, mip.height, mip.width, mip.height];
```

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/tex-loader.test.ts`
Expected: PASS（含既有 `parseTex`/采样/精灵表用例）；特别确认 `tests/dom/tex-loader-video.dom.test.ts:135` 的 `[1280,720,1280,720]` 仍绿

- [ ] **Step 5: 全量回归并提交**

Run: `npm test`
Expected: 55 files / 1112 passed（1109 + 新增 3）

```bash
git add src/client/tex-loader.ts tests/tex-loader.test.ts
git commit -m "fix(client): 效果纹理的 g_TextureNResolution 按内容尺寸下发"
```

---

### Task 2: `resolveTextureResolution4` 口径注释 + 一致性用例

**Files:**
- Modify: `src/client/effect-runner.ts:315-321`（仅注释）
- Test: `tests/effect-runner.test.ts`（追加）

**Interfaces:**
- Consumes: `resolveTextureResolution4(tex, fallbackW, fallbackH): {x,y,z,w}`（既有，签名不动）
- Produces: 无新接口；用例固定「RT/无 `fxRes` 回退」与「`fxRes` 内容尺寸」两种来源**同口径**

- [ ] **Step 1: 写失败测试**

在 `tests/effect-runner.test.ts` 追加（该文件已 import 目标函数；若未 import 则补 `resolveTextureResolution4`）：

```ts
describe('g_TextureNResolution 口径（未 padding 上传）', () => {
  it('RT / 无 fxRes 的纹理回退为 (w,h,w,h)，与带 fxRes 的内容尺寸同口径', () => {
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

- [ ] **Step 2: 跑测试确认红/绿边界**

Run: `npx vitest run tests/effect-runner.test.ts -t g_TextureNResolution`
Expected: Task 1 之后即 PASS；若把 Task 1 的 `.zw` 临时改回 `info.textureWidth/textureHeight`，则 `tex.z / tex.x` 变 1.6384 ⇒ 该断言 FAIL（这就是它的判别力）

- [ ] **Step 3: 订正注释（逻辑不动）**

`src/client/effect-runner.ts:315-321` 注释改为：

```ts
// g_TextureNResolution 的 **vec4 分量**：四分量一律同值（= 纹理 mip0 记录尺寸）。WE 效果 shader
// 用 `.z/.x` 缩放遮罩 UV（waterripple/shake），比值必须为 1，否则 NPOT padding 会按 分配/内容
// 把遮罩挤向画面左上（见 AGENT.md §5.17）；RT 与未带 `fxRes` 的纹理走下方回退，同口径。
```

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run tests/effect-runner.test.ts tests/tex-loader.test.ts`
Expected: 全绿

- [ ] **Step 5: 提交**

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

- [ ] **Step 1: 加探针**

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

- [ ] **Step 2: 加判据**

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

- [ ] **Step 3: 跑一次确认绿（真 GPU，串行）**

Run: `node e2e/verify/verify-isolated-rt-sharpness.mjs --id=1922570576 --gpu`
Expected: 既有判据全 PASS + 新增 2 条 PASS；`metrics.json` 里能看到遮罩槽 `z/x = 1`

- [ ] **Step 4: 反向验证（判据有牙）**

```bash
git stash push -- src/client/tex-loader.ts        # 或 git checkout HEAD~1 -- src/client/tex-loader.ts
node e2e/verify/verify-isolated-rt-sharpness.mjs --id=1922570576 --gpu   # 期望 exit 1，报 z/x=1.6384
git stash pop
node e2e/verify/verify-isolated-rt-sharpness.mjs --id=1922570576 --gpu   # 期望 exit 0
```

- [ ] **Step 5: 提交**

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

- [ ] **Step 1: 订正 §5.17**

`AGENT.md` §5.17 的 `(mip0.w, mip0.h, header.w, header.h)` 表述改为：

```
§5.17 g_TextureNResolution 四分量一律同值（= 纹理 mip0 记录尺寸）；效果 shader 用 `.z/.x`
缩放遮罩 UV，比值必须为 1。插件不按 .tex 头做 padding 分配，故填头里的分配尺寸会让 NPOT 纹理的
遮罩按 分配/内容 挤向画面左上（真机：湖水波动跑到树上）。细节见 docs/fixes/conventions-details.md。
```

- [ ] **Step 2: 新增 §7 遗留条目**

```
§7.37 未做真 padding 上传：若将来按 .tex 头的分配尺寸分配纹理，`g_TextureNResolution` 的
.z/.w 必须恢复为分配尺寸，并重新审计全部 `.z/.w` 用法（当前 33 种用法都只依赖内容尺寸）。
```

- [ ] **Step 3: 归档审计数据**

在 `docs/fixes/conventions-details.md` 为 §5.17 追加小节：遮罩几何验算表（v 0.78–0.86 → 0.46–0.51）、33 种表达式分类表、影响面（175 `.tex` 中 88 个 NPOT、21 张壁纸）、审计脚本路径（`output/blur-analysis/{mask_placement,mask_scope,shader_audit,tex_padding_scope}.py`）。
**注意**：`output/` 被 gitignore，数据需以文字/表格形式进文档，不能只留路径。

- [ ] **Step 4: 跑全量测试与 e2e**

Run: `npm test` → 期望 55 files / 1112 passed
Run: `node e2e/verify/verify-isolated-rt-sharpness.mjs --gpu` → 期望 5/5 张、含新增判据全 PASS、exit 0

- [ ] **Step 5: 提交**

```bash
git add AGENT.md docs/fixes/conventions-details.md docs/superpowers/specs/2026-10-12-mask-uv-npot-design.md
git commit -m "docs(agent): 回写遮罩 UV 的内容尺寸口径与审计数据"
```

---

### Task 5（单独确认后执行）：重建产物

**Files:**
- Modify: `lib/**`、`dist/client.js(.map)`（构建产物）

- [ ] **Step 1: 用户确认时机**（profile 符号链接到本仓库，重建会经 client-hmr 重挂正在运行的会话）
- [ ] **Step 2:** `npm run build && npm run build:client`，两次 exit 0
- [ ] **Step 3:** `grep -c "fxRes" lib/client/tex-loader.js` 命中；`dist/client.js` 命中
- [ ] **Step 4:** `npm test` 全绿后提交 `chore(build): 重建 lib/ 与 dist/ 产物（遮罩 UV 口径修复）`
- [ ] **Step 5: 真机确认**：壁纸「魔兽之门」湖面出现波动、树线不再波动

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
- 若某个 `.tex` 的 mip0 载荷尺寸与 `ImageWidth/Height` 不同（历史上见过合成 fixture 如此），`mip.width/height` 仍是**实际上传**的尺寸 ⇒ 口径仍自洽（这正是「内容占满纹理」的定义）。
- e2e 探针依赖 TS `private` 运行期可读（既有 `__isoInfo` 已用同一手法）；若上游改名，探针返回 `null` 会跳过判据 —— Task 3 Step 2 已做 `rows && rows.length` 守卫，需在 Task 3 Step 3 确认**判据真的出现**（不是被跳过）。
