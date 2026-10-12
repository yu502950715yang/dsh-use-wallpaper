# 隔离对象 RT 分辨率（背景清晰度）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让走隔离路径的对象（内容 → 对象 RT → 效果链 → 合成 quad → 屏幕）按「源纹理尺寸（收口 4096）」渲染，把「魔兽之门」这类整屏背景从锐度 0.55 提到 ≥0.80（桌面 WE = 1.00），同时只对铺满整屏的对象生效并关掉其无用的 MSAA。

**Architecture:** 尺寸决策收敛到一个纯函数（`object-range.ts`），挂载期（`three-renderer` 建 isolate 表）与 resize 期（`object-effects.onViewportResize`）调同一个函数；MSAA 与 mipmap 在 `threejs-player.attachIsolated` 按「是否铺满整屏 / RT 是否大于屏占位」就地决定；源尺寸未知（视频未就绪、精灵表、异常）一律回退屏占位；显存总预算超限时把「升级幅度」等比收窄，下限锁死在屏占位（只升不降）。

**Tech Stack:** TypeScript、three.js r170、vitest、headless Edge（真 GPU e2e）

**Spec:** `docs/superpowers/specs/2026-10-12-isolated-object-rt-resolution-design.md`

## Global Constraints

- **只升不降**：任何路径（含预算降级、源尺寸未知、异常）都不得让对象 RT 小于现状屏占位口径。
- **同源**：挂载期与 resize 期必须调用同一个纯函数、同一份输入（§5.15 ② 的教训：口径不一致会让整层模糊）。
- `OBJECT_RT_MAX = 4096` 不变；等比收口，**不得**逐轴独立截断（会破坏依赖 aspect 的效果与几何）。
- 局部相机范围仍 = **未钳制世界尺寸**（§5.15 ② 不变量）；渲染进 RT 仍只走 `rt-render.ts` 唯一入口（§5.22）。
- 帧内**不得**建 RT（§5.11）：尺寸只在挂载期/重挂期决定，运行期复用既有 `resizeObjectRT`。
- **不改**纹理过滤/anisotropy、效果链语义（pass/mask/混合/具名 RT 规则）、非隔离对象路径（粒子、文字层、直渲背景）。
- 新增常量：`ISOLATED_RT_BUDGET_BYTES = 384_000_000`、`ISOLATED_RT_BYTES_PER_PX = 28`（v1 走常量，不加设置面板控件 —— §5.39 的面板 DOM 钩子被测试锁定）。
- 测试命令 `npx vitest run <file>`；提交信息标题一行 + 正文最多 3 行；文档、注释、提交一律简体中文。
- **开工前工作树必须干净**：本轮 A/B 的实验补丁已回滚，`git status` 只允许出现实验前就存在的 `?? .research-mpkg*/`。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/client/object-range.ts`（改） | 新增纯函数：`sourcePixelsFromTexture` / `isolatedRtLongEdge` / `isolatedRtSize` / `fitIsolatedBudget` + 两个常量；导出 `SourcePixels` 类型 |
| `src/client/three-renderer.ts`（改） | 挂载期：对象源尺寸提取（视频/精灵表/异常回退）→ 调 `isolatedRtSize`；预算汇总 → `fitIsolatedBudget`；`webglcontextlost` 回退 preview |
| `src/client/object-effects.ts`（改） | `setWorldSize` 增加 `source` 参数；`onViewportResize` 改用同一纯函数 |
| `src/client/threejs-player.ts`（改） | `attachIsolated`：满屏对象 `samples: 0`、RT 大于屏占位时开 mipmap |
| `src/client/wallpaper-controller.ts`（改） | 把 `onContextLost` 回调接到 `layer.showImage(previewUrl)` |
| `e2e/harness/harness-text-clock-entry.mjs`（改） | 暴露 `window.__fpsProbe(ms)`（rAF 计数）与 `window.__isoInfo()`（隔离 RT 实况） |
| `e2e/verify/verify-text-clock-layer.mjs`（改） | 打印 FPS 与隔离 RT 实况（复用现成 server/CDP 管线） |
| `e2e/verify/verify-isolated-rt-sharpness.mjs`（新增） | e2e 验收：分块锐度比阈值 + 外科性断言 + FPS 门槛 |
| `tests/object-range.test.ts`（改） | 纯函数单测（三态、收口、预算、同源） |
| `tests/threejs-player.test.ts`（改） | MSAA 分型 / mipmap 开关（mock renderer 读 rt 参数） |
| `tests/object-effects.test.ts`（改） | resize 期同源 / RT 不变小 |
| `tests/three-renderer.test.ts`（改） | 源尺寸提取与回退、`webglcontextlost` 回退 |
| `AGENT.md` / `TESTING.md`（改） | §5.15 ② 口径修订、§7.12 归因订正、新增 e2e 命令 |

---

### Task 1: FPS 采集能力 + 基线数字（前置证据门槛）

**Files:**
- Modify: `e2e/harness/harness-text-clock-entry.mjs`（在文件末尾 `window.__ready = true;` 之前追加）
- Modify: `e2e/verify/verify-text-clock-layer.mjs:317`（`await sleep(600);` 之后、`await step('normal', false);` 之前）
- Test: 无单测（e2e 基建）；判据是能打印出两组真实数字

**Interfaces:**
- Produces: 页面侧 `window.__fpsProbe(ms: number): Promise<{ fps: number; frames: number; ms: number }>`

- [ ] **Step 1: 在 harness 页面入口加 rAF 帧率探针**

```js
// [perf] 帧率探针：统计 ms 毫秒内真实 rAF 回调次数（壁纸帧循环就是 rAF 驱动的）
window.__fpsProbe = (ms = 5000) => new Promise((resolve) => {
  let frames = 0;
  const t0 = performance.now();
  const tick = () => {
    frames++;
    const dt = performance.now() - t0;
    if (dt >= ms) resolve({ fps: Math.round((frames / dt) * 1000 * 10) / 10, frames, ms: Math.round(dt) });
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
```

- [ ] **Step 2: 在 verifier 里打印基线与 A′ 的 FPS**

在 `await step('normal', false);` 前插入：

```js
  // [perf] 1080p FPS 门槛（AGENT.md P1）——先采基线，实现后再比一次
  try { console.log('  [perf]', await evalJs('JSON.stringify(await window.__fpsProbe(5000))')); }
  catch (e) { console.log('  [perf] 采集失败:', String(e).slice(0, 120)); }
```

- [ ] **Step 3: 采集基线数字（当前未改动的实现）**

```bash
node e2e/verify/verify-text-clock-layer.mjs --id=1922570576 --gpu 2>&1 | Select-String '\[perf\]'
node e2e/verify/verify-text-clock-layer.mjs --id=3743126786 --gpu 2>&1 | Select-String '\[perf\]'
```

Expected: 两组都打印出 `{"fps":…}`。**把这两个数字记进本任务提交信息与 spec §5**；若基线已 < 30，先停下与人类讨论（这时提高分辨率需先解决性能）。

- [ ] **Step 4: 提交**

```bash
git add e2e/harness/harness-text-clock-entry.mjs e2e/verify/verify-text-clock-layer.mjs
git commit -m "test(e2e): 增加 rAF 帧率探针并采隔离 RT 基线 FPS"
```

---

### Task 2: 尺寸策略纯函数（`isolatedRtSize`）

**Files:**
- Modify: `src/client/object-range.ts`（文件末尾追加，紧跟 `objectRtSize` 之后）
- Test: `tests/object-range.test.ts`（追加 describe）

**Interfaces:**
- Produces:
  - `type SourcePixels = { width: number; height: number }`
  - `isolatedRtLongEdge(occLongEdge: number, sourceLongEdge: number, cap = OBJECT_RT_MAX): number`
  - `isolatedRtSize(worldW: number, worldH: number, density: number, source: SourcePixels | null, opts?: { cap?: number; budgetScale?: number }): { width: number; height: number; upgraded: boolean }`

- [ ] **Step 1: 写失败测试**

```ts
import { isolatedRtLongEdge, isolatedRtSize } from '../src/client/object-range.js';

describe('隔离对象 RT 尺寸（方案 A′）', () => {
  it('源纹理比屏占位大 → 提到源纹理（受 4096 收口）', () => {
    // 魔兽之门 harness 实测：密度 0.375、世界 5000×2400 → 屏占位 1875×900
    const rt = isolatedRtSize(5000, 2400, 0.375, { width: 5000, height: 2400 });
    expect(rt).toEqual({ width: 4096, height: 1966, upgraded: true });
  });
  it('源纹理比屏占位小 → 保持屏占位（只升不降护栏，1968789468 #13 那例）', () => {
    const rt = isolatedRtSize(1920, 1063, 1.097, { width: 1920, height: 1063 });
    expect(rt.upgraded).toBe(false);
    expect(rt.width).toBe(Math.round(1920 * 1.097));
    expect(rt.height).toBe(Math.round(1063 * 1.097));
  });
  it('源纹理未知 → 保持屏占位', () => {
    const rt = isolatedRtSize(3840, 2160, 0.5, null);
    expect(rt).toEqual({ width: 1920, height: 1080, upgraded: false });
  });
  it('等比收口：长边到 4096，另一轴按比例（不逐轴截断）', () => {
    expect(isolatedRtLongEdge(1000, 7430, 4096)).toBe(4096);
    expect(isolatedRtSize(7430, 4147, 0.25, { width: 7430, height: 4147 }))
      .toEqual({ width: 4096, height: 2286, upgraded: true });
  });
  it('budgetScale 只收紧升级幅度，不跌破屏占位', () => {
    const full = isolatedRtSize(5000, 2400, 0.375, { width: 5000, height: 2400 });
    const cut = isolatedRtSize(5000, 2400, 0.375, { width: 5000, height: 2400 }, { budgetScale: 0.5 });
    expect(cut.width).toBeLessThan(full.width);
    expect(cut.width).toBeGreaterThanOrEqual(1875);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/object-range.test.ts`
Expected: FAIL —— `isolatedRtSize is not a function`

- [ ] **Step 3: 实现纯函数**

```ts
/** 源纹理像素尺寸（隔离对象 RT 的上限来源）。 */
export interface SourcePixels { width: number; height: number }

/** 隔离对象 RT 的长边：max(屏占位, min(源纹理长边, cap))；budgetScale ∈ (0,1] 只压缩升级幅度。 */
export function isolatedRtLongEdge(occLongEdge: number, sourceLongEdge: number, cap = OBJECT_RT_MAX): number {
  const occ = Number.isFinite(occLongEdge) && occLongEdge > 0 ? occLongEdge : 1;
  const src = Number.isFinite(sourceLongEdge) && sourceLongEdge > 0 ? sourceLongEdge : 0;
  const limit = Number.isFinite(cap) && cap > 0 ? cap : OBJECT_RT_MAX;
  return Math.max(occ, Math.min(src, limit));
}

/** 隔离对象 RT 像素尺寸：等比（两轴同一比例）+ 4096 收口；下限恒为屏占位（只升不降）。 */
export function isolatedRtSize(
  worldW: number, worldH: number, density: number,
  source: SourcePixels | null,
  opts: { cap?: number; budgetScale?: number } = {},
): { width: number; height: number; upgraded: boolean } {
  const occ = objectRtSize(worldW, worldH, density, opts.cap ?? OBJECT_RT_MAX);
  const occLong = Math.max(occ.width, occ.height);
  const srcLong = source ? Math.max(source.width, source.height) : 0;
  const scale = Number.isFinite(opts.budgetScale) && opts.budgetScale! > 0 && opts.budgetScale! < 1
    ? opts.budgetScale! : 1;
  // 升级幅度（超出屏占位的部分）按 budgetScale 收窄
  const targetLong = Math.max(occLong, occLong + (isolatedRtLongEdge(occLong, srcLong, opts.cap) - occLong) * scale);
  if (targetLong <= occLong + 1e-6) return { ...occ, upgraded: false };
  const k = targetLong / Math.max(Math.abs(worldW), Math.abs(worldH));
  return {
    width: Math.max(1, Math.round(Math.abs(worldW) * k)),
    height: Math.max(1, Math.round(Math.abs(worldH) * k)),
    upgraded: true,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/object-range.test.ts`
Expected: PASS（含既有用例）

- [ ] **Step 5: 提交**

```bash
git add src/client/object-range.ts tests/object-range.test.ts
git commit -m "feat(client): 隔离对象 RT 尺寸改为「源纹理收口 4096、只升不降」"
```

---

### Task 3: 源尺寸提取（含视频/精灵表/异常回退）

**Files:**
- Modify: `src/client/object-range.ts`（追加）
- Test: `tests/object-range.test.ts`（追加 describe）

**Interfaces:**
- Produces: `sourcePixelsFromTexture(tex: { image?: { width?: number; height?: number; videoWidth?: number; videoHeight?: number } | null; userData?: { sprite?: unknown } } | null | undefined): SourcePixels | null`
- Consumes: Task 2 的 `SourcePixels`

- [ ] **Step 1: 写失败测试**

```ts
describe('sourcePixelsFromTexture（源尺寸提取与回退）', () => {
  it('普通图像纹理 → image 尺寸（不是 NPOT padding 的 textureWidth/Height）', () => {
    expect(sourcePixelsFromTexture({ image: { width: 5000, height: 2400 } })).toEqual({ width: 5000, height: 2400 });
  });
  it('视频纹理未就绪（videoWidth=0）→ null（回退屏占位）', () => {
    expect(sourcePixelsFromTexture({ image: { width: 0, height: 0, videoWidth: 0, videoHeight: 0 } })).toBeNull();
  });
  it('视频就绪 → videoWidth/videoHeight', () => {
    expect(sourcePixelsFromTexture({ image: { width: 1, height: 1, videoWidth: 1920, videoHeight: 1080 } }))
      .toEqual({ width: 1920, height: 1080 });
  });
  it('精灵表 → null（图集尺寸 ≠ 对象分辨率）', () => {
    expect(sourcePixelsFromTexture({ image: { width: 4096, height: 4096 }, userData: { sprite: { frames: 64 } } })).toBeNull();
  });
  it('缺失/NaN → null', () => {
    expect(sourcePixelsFromTexture(null)).toBeNull();
    expect(sourcePixelsFromTexture({ image: { width: NaN, height: NaN } })).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/object-range.test.ts`
Expected: FAIL —— `sourcePixelsFromTexture is not a function`

- [ ] **Step 3: 实现**

```ts
/** 从 three 纹理取「源尺寸」；视频未就绪、精灵表、缺失/非法一律 null → 调用方回退屏占位。 */
export function sourcePixelsFromTexture(tex: TexLike | null | undefined): SourcePixels | null {
  if (!tex || !tex.image) return null;
  if (tex.userData && tex.userData.sprite) return null; // 精灵表：图集尺寸 ≠ 对象分辨率
  const img = tex.image as { width?: number; height?: number; videoWidth?: number; videoHeight?: number };
  const vw = Number(img.videoWidth), vh = Number(img.videoHeight);
  if (Number.isFinite(vw) && vw > 0 && Number.isFinite(vh) && vh > 0) return { width: vw, height: vh };
  const w = Number(img.width), h = Number(img.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { width: w, height: h };
}
```

（`TexLike` 接口按 Step 1 的入参形状声明，`videoWidth` 存在即视为视频纹理。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/object-range.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/object-range.ts tests/object-range.test.ts
git commit -m "feat(client): 源纹理尺寸提取与视频/精灵表回退"
```

---

### Task 4: 显存预算等比降级（`fitIsolatedBudget`）

**Files:**
- Modify: `src/client/object-range.ts`（追加）
- Test: `tests/object-range.test.ts`（追加 describe）

**Interfaces:**
- Produces:
  - `ISOLATED_RT_BUDGET_BYTES = 384_000_000`、`ISOLATED_RT_BYTES_PER_PX = 28`
  - `fitIsolatedBudget(items: Array<{ worldW: number; worldH: number; source: SourcePixels | null }>, density: number, budgetBytes?: number, bytesPerPx?: number): number`（返回 `budgetScale ∈ (0,1]`）

- [ ] **Step 1: 写失败测试**

```ts
describe('fitIsolatedBudget（预算越界只压缩升级幅度）', () => {
  const items = [{ worldW: 5000, worldH: 2400, source: { width: 5000, height: 2400 } }];
  it('预算充足 → 1（不动）', () => {
    expect(fitIsolatedBudget(items, 0.375, 384_000_000, 28)).toBe(1);
  });
  it('预算不足 → 返回 (0,1) 的比例', () => {
    const s = fitIsolatedBudget(items, 0.375, 60_000_000, 28);
    expect(s).toBeGreaterThan(0); expect(s).toBeLessThan(1);
  });
  it('预算再小也不低于屏占位（scale 不会压到 0）', () => {
    const s = fitIsolatedBudget(items, 0.375, 1_000, 28);
    expect(s).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/object-range.test.ts`
Expected: FAIL —— `fitIsolatedBudget is not a function`

- [ ] **Step 3: 实现**

```ts
export const ISOLATED_RT_BUDGET_BYTES = 384_000_000; // v1 常量：覆盖实测最重单张（GTR 285 MB）并留余量
export const ISOLATED_RT_BYTES_PER_PX = 28;          // RGBA8 + 深度，含 ping-pong 与具名 RT 分摊

/** 超预算时返回 <1 的比例，用来收窄「升级幅度」；下限保证任何对象都不低于屏占位。 */
export function fitIsolatedBudget(
  items: Array<{ worldW: number; worldH: number; source: SourcePixels | null }>,
  density: number,
  budgetBytes = ISOLATED_RT_BUDGET_BYTES,
  bytesPerPx = ISOLATED_RT_BYTES_PER_PX,
): number {
  const budget = Number.isFinite(budgetBytes) && budgetBytes > 0 ? budgetBytes : ISOLATED_RT_BUDGET_BYTES;
  const px = (scale: number) => items.reduce((sum, it) => {
    const rt = isolatedRtSize(it.worldW, it.worldH, density, it.source, { budgetScale: scale });
    return sum + rt.width * rt.height;
  }, 0);
  if (px(1) * bytesPerPx <= budget) return 1;
  let lo = 1e-4, hi = 1;   // px 随 scale 单调不减 ⇒ 二分
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (px(mid) * bytesPerPx <= budget) lo = mid; else hi = mid;
  }
  return lo;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/object-range.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/object-range.ts tests/object-range.test.ts
git commit -m "feat(client): 隔离 RT 显存预算与等比降级"
```

---

### Task 5: 挂载期接线（`three-renderer`）

**Files:**
- Modify: `src/client/three-renderer.ts:534-600`（`screenScale` 计算与 `isolate` 表构建）
- Test: `tests/three-renderer.test.ts`（追加用例，沿用该文件既有的 mock 装配）

**Interfaces:**
- Consumes: `sourcePixelsFromTexture` / `isolatedRtSize` / `fitIsolatedBudget`（Task 2-4）
- Produces: `isolate` 表的 `rtWidth/rtHeight` 按新口径；`ObjectEffectStage` 的 `screenScale` 语义不变（仍是密度，不是像素）

- [ ] **Step 1: 写失败测试**（断言「有源纹理的隔离对象 RT = min(源纹理, 4096) 收口后的尺寸」）

```ts
it('隔离对象 RT 按源纹理收口 4096（不再是屏占位）', async () => {
  // 复用本文件既有的 mock 场景装配（scene.json 5000×2400、image 对象 size=5000×2400、纹理 image=5000×2400）
  const iso = capturedIsolate.get(13)!;
  expect(Math.max(iso.rtWidth, iso.rtHeight)).toBe(4096);
});
it('无源尺寸的对象回退屏占位（只升不降）', async () => {
  const iso = capturedIsolate.get(246)!; // 该对象纹理未就绪 → source=null
  expect(iso.rtWidth).toBe(Math.round(1920 * density));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/three-renderer.test.ts`
Expected: FAIL —— 实际长边仍是屏占位

- [ ] **Step 3: 实现（替换 isolate 表构建里的尺寸计算）**

```ts
        const screenScale = screenScalePx(desc.orthogonal.width, desc.orthogonal.height, vw, vh, dpr);
        // ── 隔离对象尺寸：源纹理收口 4096、只升不降；再按显存预算等比收窄升级幅度 ──
        const isolateItems = desc.objects
          .filter((o) => o.kind === 'image' && !isStaticallyHidden(o.visible, userProps)
            && (effectChains.get(o.id)?.length ?? 0) > 0)
          .map((o) => {
            const s = o.scale; const w = Math.abs((o.size?.[0] ?? 1) * s[0]); const h = Math.abs((o.size?.[1] ?? 1) * s[1]);
            return { objId: o.id, worldW: w, worldH: h, source: sourcePixelsFromTexture(backgroundTextures.get(o.id)) };
          });
        const budgetScale = fitIsolatedBudget(isolateItems, screenScale);
        const sizeOf = new Map(isolateItems.map((it) => [it.objId,
          isolatedRtSize(it.worldW, it.worldH, screenScale, it.source, { budgetScale })]));
```

（随后 `isolate.set(obj.id, { objectId, rtWidth: sizeOf.get(obj.id)!.width, rtHeight: sizeOf.get(obj.id)!.height, worldW, worldH })`；粒子分支保持原样。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/three-renderer.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/three-renderer.ts tests/three-renderer.test.ts
git commit -m "feat(client): 挂载期按源纹理尺寸建隔离对象 RT"
```

---

### Task 6: resize 期同源（`object-effects`）

**Files:**
- Modify: `src/client/object-effects.ts:145-206`（`setWorldSize` / `onViewportResize`）
- Modify: `src/client/three-renderer.ts`（`setWorldSize` 调用点补 source 参数，与 Task 5 同一份数据）
- Test: `tests/object-effects.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 2-4
- Produces: `setWorldSize(objId: number, worldW: number, worldH: number, source?: SourcePixels | null): void`

- [ ] **Step 1: 写失败测试**

```ts
it('视口变化后 RT 仍按源纹理口径（不被 resize 打回屏占位）', () => {
  stage.setWorldSize(13, 5000, 2400, { width: 5000, height: 2400 });
  stage.onViewportResize(0.375);
  expect(Math.max(...host.resized.at(-1)!)).toBe(4096);
});
it('resize 不会把 RT 缩到小于屏占位（只升不降）', () => {
  stage.setWorldSize(13, 5000, 2400, null);
  stage.onViewportResize(0.375);
  const [w, h] = host.resized.at(-1)!;
  expect(w * h).toBeGreaterThanOrEqual(Math.round(5000 * 0.375) * Math.round(2400 * 0.375));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/object-effects.test.ts`
Expected: FAIL —— `setWorldSize` 不接受第 4 个参数（或 RT 被打回屏占位）

- [ ] **Step 3: 实现**

```ts
  setWorldSize(objId: number, worldW: number, worldH: number, source: SourcePixels | null = null): void {
    if (this.disposed) return;
    const entry = this.entries.get(objId);
    if (entry) { entry.worldW = worldW; entry.worldH = worldH; entry.source = source; return; }
    this.entries.set(objId, { runner: null, chains: [], plan: null, worldW, worldH, source });
  }
  onViewportResize(screenScale: number): void {
    if (this.disposed) return;
    this.screenScale = screenScale;
    // 预算随视口重算（同一纯函数、同一份输入 ⇒ 与挂载期同源）
    const budgetScale = fitIsolatedBudget(
      [...this.entries].map(([objId, e]) => ({ objId, worldW: e.worldW, worldH: e.worldH, source: e.source })),
      this.scale());
    for (const [id, entry] of this.entries) {
      const size = isolatedRtSize(entry.worldW, entry.worldH, this.scale(), entry.source, { budgetScale });
      /* 其余逻辑保持不变：与 view.rtWidth/rtHeight 比较 → resizeObjectRT → 重挂计划 */
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/object-effects.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/object-effects.ts src/client/three-renderer.ts tests/object-effects.test.ts
git commit -m "fix(client): resize 期与挂载期同源复用隔离 RT 尺寸口径"
```

---

### Task 7: MSAA 分型 + 合成 mipmap（`threejs-player`）

**Files:**
- Modify: `src/client/threejs-player.ts:1116-1192`（`attachIsolated`）
- Test: `tests/threejs-player.test.ts`（追加用例）

**Interfaces:**
- Produces: `attachIsolated` 内部按 `isFullscreen` 决定 `samples`；RT 大于屏占位时 `generateMipmaps: true` + `minFilter: LinearMipmapLinearFilter`

- [ ] **Step 1: 写失败测试**

```ts
it('铺满整屏的对象关 MSAA，贴片保持 4', () => {
  player.setSceneSize(5000, 2400);
  player.attachIsolated(13, 'background', content, 5000, 2400, { width: 4096, height: 1966 }, pos, [0, 0, 0], 0);
  player.attachIsolated(246, 'background', content2, 1920, 1080, { width: 1086, height: 399 }, pos, [0, 0, 0], 0);
  expect(player.isolatedObjects().find((o) => o.id === 13)!.rt.samples).toBe(0);
  expect(player.isolatedObjects().find((o) => o.id === 246)!.rt.samples).toBe(4);
});
it('RT 大于屏占位时开 mipmap（合成是缩小采样）', () => {
  player.resize(1600, 900);
  player.attachIsolated(13, 'background', content, 5000, 2400, { width: 4096, height: 1966 }, pos, [0, 0, 0], 0);
  const rt = player.isolatedObjects()[0].rt;
  expect(rt.texture.generateMipmaps).toBe(true);
  expect(rt.texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/threejs-player.test.ts`
Expected: FAIL —— samples 恒为 4、mipmap 未开

- [ ] **Step 3: 实现**

```ts
    // 满屏背景（世界尺寸 ≥ 0.98×场景）= 一整块盖满 RT 的 quad，MSAA 结构性无效（实测 MAD=0.0000）
    const isFullscreen = Math.abs(worldW) >= this.sceneWidth * 0.98 && Math.abs(worldH) >= this.sceneHeight * 0.98;
    // RT 大于屏占位 ⇒ 合成那一步是缩小，必须开 mipmap 才能避免高频走样
    const occLong = Math.max(Math.abs(worldW), Math.abs(worldH)) * this.screenScalePx();
    const minifying = Math.max(rtW, rtH) > occLong + 0.5;
    const rt = new THREE.WebGLRenderTarget(rtW, rtH, {
      samples: isFullscreen ? 0 : 4,
      generateMipmaps: minifying,
      minFilter: minifying ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
    });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/threejs-player.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/threejs-player.ts tests/threejs-player.test.ts
git commit -m "feat(client): 满屏隔离对象关 MSAA，RT 放大时开 mipmap"
```

---

### Task 8: `webglcontextlost` 回退 preview

**Files:**
- Modify: `src/client/three-renderer.ts`（`render(id, fg)` 内对 `fg` 注册监听）
- Modify: `src/client/wallpaper-controller.ts:161-200`（scene 分支传入 `onContextLost` 回调）
- Test: `tests/three-renderer.test.ts`（追加用例）

**Interfaces:**
- Produces: `createThreeSceneRenderer(opts?: { onContextLost?: (wallpaperId: string) => void })`；渲染器在 `webglcontextlost` 时 `preventDefault()` + 停帧循环 + 回调一次

- [ ] **Step 1: 写失败测试**

```ts
it('webglcontextlost 时停循环并回调一次（供上层回退 preview）', async () => {
  const seen: string[] = [];
  const r = createThreeSceneRenderer({ onContextLost: (id) => seen.push(id) });
  await r.render('1922570576', canvas);
  canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  expect(seen).toEqual(['1922570576']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/three-renderer.test.ts`
Expected: FAIL —— 回调未被调用

- [ ] **Step 3: 实现**

```ts
  // 上下文丢失（显存耗尽/驱动重置）→ 停渲染并交给上层回退 preview（比留一块空白好）
  const onLost = (e: Event) => {
    e.preventDefault();
    try { teardown(); } catch { /* 释放失败不掩盖回退 */ }
    console.warn(`[wallpaper-engine] WebGL 上下文丢失，已回退 preview（壁纸 ${id}）`);
    opts?.onContextLost?.(id);
  };
  fg.addEventListener('webglcontextlost', onLost, { once: true });
```

（`wallpaper-controller` 侧：`opts.sceneRenderer = createThreeSceneRenderer({ onContextLost: () => { if (currentInfo?.previewUrl) layer.showImage(currentInfo.previewUrl, !currentInfo.hasPreviewGif); } })`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/three-renderer.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/three-renderer.ts src/client/wallpaper-controller.ts tests/three-renderer.test.ts
git commit -m "feat(client): WebGL 上下文丢失时回退壁纸 preview"
```

---

### Task 9: e2e 验收脚本（锐度 + 外科性 + FPS）

**Files:**
- Create: `e2e/verify/verify-isolated-rt-sharpness.mjs`
- Modify: `package.json`（scripts 增加 `"e2e:isolated-rt": "node e2e/verify/verify-isolated-rt-sharpness.mjs"`）
- Modify: `e2e/harness/harness-text-clock-entry.mjs`（追加 `window.__isoInfo()` 返回隔离 RT 实况）

**Interfaces:**
- Consumes: `e2e/config.mjs` 的 `argOf/flagOf/httpPort/cdpPort/resolveEdgePath/OUT_DIR/WE_WORKSHOP`、`e2e/lib/png-stats.mjs` 的 `decodePng`
- Produces: 退出码 0/1 + `e2e/.out/isolated-rt/` 下的截图与 `metrics.json`

- [ ] **Step 1: 在 harness 页面暴露隔离 RT 实况**

```js
window.__isoInfo = () => {
  const p = window.__player;
  if (!p || !p.isolated || typeof p.isolated.values !== 'function') return null;
  return [...p.isolated.values()].map((o) => ({
    obj: o.id, rt: [o.rtWidth, o.rtHeight], samples: o.rt ? o.rt.samples : null,
    mip: o.rt && o.rt.texture ? !!o.rt.texture.generateMipmaps : null,
  }));
};
```

- [ ] **Step 2: 写验收脚本（结构如下，复用 `verify-text-clock-layer.mjs` 的 server/CDP 骨架）**

```js
// 每张壁纸跑两个 arm（base / current），用逐块「梯度/对比度」比判收益，用 __isoInfo 判外科性
const CASES = [
  { id: '1922570576', minGain: 1.45, note: '魔兽之门：0.55 → ≥0.80（相对桌面口径另测）' },
  { id: '3743126786', minGain: 1.20, note: 'GTR' },
  { id: '3765967112', minGain: 1.20, note: 'Crimson' },
  { id: '2911105183', minGain: 1.20, note: 'Subway' },
  { id: '1429403119', minGain: 1.05, note: 'Orange' },
];
// 1) 同页渲染 → Page.captureScreenshot → decodePng
// 2) blockMetric(img, 96) 逐 96×96 块算 p99 梯度 / (p98−p2)，与基线 arm 的对应块比
// 3) 断言：每个 id 的有效块中位数 ≥ minGain；非满屏对象的 rt/samples 与基线逐字相同
// 4) 打印 __fpsProbe(5000) 的 FPS，断言 ≥ 30（1080p）
```

判据（任一不过 → 退出码 1）：
- 5 张壁纸的锐度比中位数 ≥ `minGain`（**A2 起缺省清单为 8 张**；本行是当时的清单口径，现行见 `TESTING.md` §2.5）；
- 非满屏隔离对象的 `rt`/`samples` 与基线**逐字相同**（外科性）；
- 满屏隔离对象 `samples === 0`、`mip === true`（当 RT > 屏占位）；
- FPS ≥ 30；无新增 `console.warn` 里的 `[wallpaper-engine]` 效果链失败/超限告警。

- [ ] **Step 3: 跑验收**

```bash
npm run e2e:isolated-rt
```
Expected: 全部 PASS，退出码 0；`e2e/.out/isolated-rt/metrics.json` 里能看到 5 组锐度比与 FPS。

- [ ] **Step 4: 交叉验证（反向）**

```bash
git stash            # 撤掉本次实现
npm run e2e:isolated-rt
git stash pop
```
Expected: 撤掉实现后判据**变红**（锐度比 ≈1.0 < minGain）——证明脚本真的在守这条性质。

- [ ] **Step 5: 提交**

```bash
git add e2e/verify/verify-isolated-rt-sharpness.mjs e2e/harness/harness-text-clock-entry.mjs package.json
git commit -m "test(e2e): 隔离 RT 清晰度/外科性/FPS 验收脚本"
```

---

### Task 10: 文档与归因回写

**Files:**
- Modify: `AGENT.md` §5.15 ②（口径改为「≥ 屏占位、源纹理收口 4096」）、§7.12（把「RT 对而贴屏映射错」订正为「分辨率不足」这一实测结论）、§5 新增一条（MSAA 对满屏隔离对象的实测无效性 + 省下多少显存）
- Modify: `TESTING.md`（新增 `npm run e2e:isolated-rt` 与 FPS 探针用法）
- Modify: `docs/superpowers/specs/2026-10-12-isolated-object-rt-resolution-design.md`（状态改为「已实现」+ 实测数字）
- Modify: `docs/fixes/` 对应归档（把 A/B 数据搬进去，AGENT.md 只留结论与指针）

- [ ] **Step 1: 回写文档**（按仓库约定：注释/文档从简，实测数据进 `docs/fixes/`）
- [ ] **Step 2: 全量测试**

```bash
npm test
```
Expected: 全绿（`scripts/known-failures.json` 基线为空，只对新增失败判红）

- [ ] **Step 3: 提交**

```bash
git add AGENT.md TESTING.md docs/superpowers/specs/2026-10-12-isolated-object-rt-resolution-design.md docs/fixes
git commit -m "docs(agent): 记录隔离 RT 分辨率口径与实测数据"
```

---

## Self-Review

**1. Spec coverage**

| Spec 章节 | 覆盖任务 |
|---|---|
| §3.1 尺寸策略（只升不降 + 4096 收口） | Task 2、Task 5、Task 6 |
| §3.2 MSAA 分型 | Task 7 |
| §3.3 合成 mipmap | Task 7 |
| §3.4 源尺寸回退（视频/精灵表/异常） | Task 3、Task 5 |
| §3.5 显存预算与降级 | Task 4、Task 5、Task 6 |
| §3.6 context lost 回退 | Task 8 |
| §4 验收判据（单测/e2e/FPS/零回归） | Task 2-8（单测）、Task 9（e2e+FPS） |
| §5 未验证项（FPS） | Task 1（基线）、Task 9（门槛） |
| §7 后续（档位化、视频重设） | 明确不在本轮 |

**2. Placeholder scan**：无 TBD/TODO；每个代码步骤给出可执行代码；e2e 脚本给出结构与精确判据（复用既有骨架，未展开的部分是 410 行的 server/CDP 样板，实现时按 `verify-text-clock-layer.mjs` 复制裁剪）。

**3. Type consistency**：`SourcePixels`、`isolatedRtSize`、`isolatedRtLongEdge`、`sourcePixelsFromTexture`、`fitIsolatedBudget`、`ISOLATED_RT_BUDGET_BYTES`、`ISOLATED_RT_BYTES_PER_PX` 在 Task 2-6 中命名一致；`attachIsolated` 签名不变（内部增加 `isFullscreen` / `minifying`），`setWorldSize` 新增第 4 个可选参数，调用点在 Task 6 内同步更新。
