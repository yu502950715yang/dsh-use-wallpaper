# 应用级 Glow（全屏后处理）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 scene 壁纸加一个作用在最终合成帧上的应用级全屏 Glow（bright-pass → 三级降采样模糊 → 加法回叠），弥合与桌面 WE 的亮部光晕差异。

**Architecture:** 新增 `src/client/glow-stage.ts`（自带 RT 池、4 个 shader、pass 链、composite），`threejs-player` 只加一个可选 hook `setGlowStage`：装配了 stage 就 `stage.apply(renderer, scene, camera)`，否则走今天那条 `renderer.render(scene, camera)`（逐字零回归）。`three-renderer` 按设置装配 / 拆除，与既有 `ObjectEffectStage` 同构。

**Tech Stack:** TypeScript（ESM、strict）、three.js r170（WebGL2、`ShaderMaterial`）、vitest（node + mock renderer）、esbuild（client 打包）、headless Edge + 真 GPU（`--use-angle=d3d11`）端到端验证。

**Spec:** `docs/superpowers/specs/2026-09-20-app-level-glow-design.md`（本计划从该 spec 推导；执行者需同时阅读两者）

## Global Constraints

- 回复、注释、文档、提交信息一律**简体中文**；代码 / 命令 / 文件名 / 技术术语保留原文。
- 注释**从简**：一行说清是什么 / 为什么，最多 2 行；根因与实测数字写 `AGENT.md` / `docs/`。
- 提交信息：标题一行 `type(scope): 中文标题`；正文可选、**最多 3 行**（改了什么 / 关键点 / 怎么验证）。每个 Task 独立 commit。
- **帧内禁止编译 / 建 RT / 建 shader**（`AGENT.md` §5.11）：全部发生在装配期与 resize 期；参数变更只改 uniform。
- 渲染进任何 RenderTarget **必须走 `renderIntoRenderTarget()`**（透明清屏，`AGENT.md` §5.22）。
- RT 纹理保持 `ClampToEdgeWrapping`（`AGENT.md` §5.19），`generateMipmaps = false`。
- **零回归**：`glowEnabled === false` 时**不建任何 RT / shader**，帧序与输出与今天逐字相同。
- **颜色空间对齐（正确性关键）**：离线实验的 `threshold = 0.65` 标定在 **sRGB 字节域**，而主场景渲染进 RT 是**线性**值 ⇒ Glow shader 内必须「线性 → 手工转 sRGB → 算 luma / 阈值 / 模糊 → composite 后转回线性」（spec §3.4）。
- 绝不白屏：运行期 Glow 失败 ⇒ 捕获、`console.warn`、**永久降级为直渲**，不中断壁纸、不触发 preview 回退。
- 默认参数：`glowEnabled = true`、`glowThreshold = 0.65`、`glowStrength = 1.0`（离线实验 A 档）。
- 测试命令：单文件 `node node_modules/vitest/vitest.mjs run tests/<file> --reporter=basic`；类型检查 `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`。
- 构建：`npm run build`（tsc → `lib/`）+ `npm run build:client`（esbuild → `dist/`）；**`lib/`、`dist/` 必须一并提交**。
- **测试基线**：全量有 **15 项既有失败**（`wasm-renderer` 7 / `scene-renderer` 6 / `verify-real-library` 1 / `dom/bootstrap.dom` 1），不得当成本次回归（逐项对照见 `AGENT.md` §7.11）。
- 端到端验证需**完整权限**（受限沙箱下 headless Edge 因命名管道 FATAL，见 `AGENT.md` §5.13）：`node research/verify-object-effects.mjs --gpu`。
- `research/` 是 gitignored；其中的脚本与日志不入库，但**结论必须回写 `AGENT.md` / `docs/`**。

---

## File Structure

**新增**
- `src/client/glow-stage.ts` — Glow 的全部实现：参数纯函数、4 个 shader、RT 池、pass 链、composite、失败降级。唯一职责 = "把一帧变成带 Glow 的一帧"。
- `tests/glow-stage.test.ts` — 纯函数（node）+ 生命周期（mock renderer）。
- `docs/superpowers/plans/2026-09-20-app-level-glow.md` — 本计划。

**修改**
- `src/client/types.ts` — `ClientSettings` 加 3 个字段。
- `src/client/settings.ts` — `DEFAULTS` 加 3 个默认值。
- `src/host/settings.ts` — host 侧 schema 加 3 个字段（使 profile `config` 可覆盖）。
- `src/client/settings-section.tsx` — 加一个「光晕」开关（只写 `glowEnabled`）。
- `src/client/threejs-player.ts` — 加 `setGlowStage()` hook、帧体分支、`resize()` 同步、`dispose()` 拆除。
- `src/client/three-renderer.ts` — 按设置装配 / 更新 / 拆除 stage。
- `tests/threejs-player.test.ts`、`tests/three-renderer.test.ts`、`tests/client-settings.test.ts`、`tests/settings.test.ts`、`tests/dom/settings-section.dom.test.tsx` — 对应测试。
- `research/verify-object-effects.mjs` — 加 `[7]` 段（Glow 开 / 关的 p99、零回归、性能）。
- `AGENT.md`、`docs/technical-notes.md`、`README.md` — 落地后回写。
- `lib/`、`dist/` — 构建产物。

---

### Task 1: `glow-stage.ts` 的参数纯函数

**Files:**
- Create: `src/client/glow-stage.ts`
- Test: `tests/glow-stage.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `GLOW_DEFAULTS: { threshold: 0.65; strength: 1.0 }`
  - `normalizeGlowOptions(opts?: GlowOptions): Required<GlowOptions>`
  - `glowLevelSizes(width: number, height: number): Array<{ w: number; h: number }>`（返回 L1 / L2 / L3 三级，逐级取半、最小 1）
  - `interface GlowOptions { threshold?: number; strength?: number }`

- [ ] **Step 1: 写失败测试**

创建 `tests/glow-stage.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { GLOW_DEFAULTS, normalizeGlowOptions, glowLevelSizes } from '../src/client/glow-stage.js';

describe('normalizeGlowOptions（参数 clamp：越界 / 非法一律收敛，不抛）', () => {
  it('缺省 = 离线实验 A 档 (0.65 / 1.0)', () => {
    expect(normalizeGlowOptions()).toEqual({ threshold: 0.65, strength: 1.0 });
    expect(GLOW_DEFAULTS).toEqual({ threshold: 0.65, strength: 1.0 });
  });

  it('threshold 上界收敛到 0.99（不允许 1，否则除零）', () => {
    expect(normalizeGlowOptions({ threshold: 1 }).threshold).toBe(0.99);
    expect(normalizeGlowOptions({ threshold: 5 }).threshold).toBe(0.99);
  });

  it('threshold 负值收敛到 0', () => {
    expect(normalizeGlowOptions({ threshold: -0.5 }).threshold).toBe(0);
  });

  it('strength 收敛到 [0, 4]', () => {
    expect(normalizeGlowOptions({ strength: -1 }).strength).toBe(0);
    expect(normalizeGlowOptions({ strength: 99 }).strength).toBe(4);
  });

  it('NaN / 非数字回退缺省（不把 NaN 灌进 uniform）', () => {
    expect(normalizeGlowOptions({ threshold: NaN, strength: NaN })).toEqual({ threshold: 0.65, strength: 1.0 });
    expect(normalizeGlowOptions({ threshold: 'x' as unknown as number }).threshold).toBe(0.65);
  });

  it('区间内的值原样保留', () => {
    expect(normalizeGlowOptions({ threshold: 0.5, strength: 2 })).toEqual({ threshold: 0.5, strength: 2 });
  });
});

describe('glowLevelSizes（三级降采样尺寸：逐级取半、最小 1px）', () => {
  it('常规视口 1280×720 → 640×360 / 320×180 / 160×90', () => {
    expect(glowLevelSizes(1280, 720)).toEqual([
      { w: 640, h: 360 },
      { w: 320, h: 180 },
      { w: 160, h: 90 },
    ]);
  });

  it('3440×1440 → 1720×720 / 860×360 / 430×180', () => {
    expect(glowLevelSizes(3440, 1440)).toEqual([
      { w: 1720, h: 720 },
      { w: 860, h: 360 },
      { w: 430, h: 180 },
    ]);
  });

  it('极窄视口不会出现 0（最小 1px）', () => {
    expect(glowLevelSizes(4, 4)).toEqual([{ w: 2, h: 2 }, { w: 1, h: 1 }, { w: 1, h: 1 }]);
    expect(glowLevelSizes(1, 1)).toEqual([{ w: 1, h: 1 }, { w: 1, h: 1 }, { w: 1, h: 1 }]);
  });

  it('非 2 的幂尺寸向下取整', () => {
    expect(glowLevelSizes(1921, 1081)).toEqual([{ w: 960, h: 540 }, { w: 480, h: 270 }, { w: 240, h: 135 }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/glow-stage.test.ts --reporter=basic`
Expected: FAIL —— 模块不存在（`Failed to resolve import "../src/client/glow-stage.js"`）

- [ ] **Step 3: 写最小实现**

创建 `src/client/glow-stage.ts`：

```ts
// src/client/glow-stage.ts
// 应用级 Glow（全屏后处理）：bright-pass → 三级降采样 box blur → composite 加法回叠。
// 语义来源是 WE 的应用级设置（general.user.postprocessing），不属于任何壁纸字段。
// 设计：docs/superpowers/specs/2026-09-20-app-level-glow-design.md。
export interface GlowOptions {
  threshold?: number;
  strength?: number;
}

/** 离线实验 A 档（最贴桌面）：见 spec §2.2。 */
export const GLOW_DEFAULTS = { threshold: 0.65, strength: 1.0 } as const;

const THRESHOLD_MAX = 0.99; // 不允许 1：bright-pass 的分母是 (1 - t)
const STRENGTH_MAX = 4;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 参数归一：缺省 / NaN / 越界一律收敛到合法区间，绝不把非法值灌进 uniform。 */
export function normalizeGlowOptions(opts?: GlowOptions): Required<GlowOptions> {
  const t = Number(opts?.threshold);
  const s = Number(opts?.strength);
  return {
    threshold: Number.isFinite(t) ? clamp(t, 0, THRESHOLD_MAX) : GLOW_DEFAULTS.threshold,
    strength: Number.isFinite(s) ? clamp(s, 0, STRENGTH_MAX) : GLOW_DEFAULTS.strength,
  };
}

/** 三级降采样 RT 尺寸（L1 = 1/2、L2 = 1/4、L3 = 1/8），逐级取半且不小于 1px。 */
export function glowLevelSizes(width: number, height: number): Array<{ w: number; h: number }> {
  const out: Array<{ w: number; h: number }> = [];
  let w = Math.max(1, Math.floor(width));
  let h = Math.max(1, Math.floor(height));
  for (let i = 0; i < 3; i++) {
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
    out.push({ w, h });
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/glow-stage.test.ts --reporter=basic`
Expected: PASS（12 项）

- [ ] **Step 5: 类型检查**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
Expected: exit 0

- [ ] **Step 6: 提交**

```bash
git add src/client/glow-stage.ts tests/glow-stage.test.ts
git commit -m "feat(glow): 参数纯函数与三级降采样尺寸计划" -m "normalizeGlowOptions 收敛越界/NaN；glowLevelSizes 逐级取半、最小 1px。" -m "验证：单测 12 项 + tsc --noEmit。"
```

---

### Task 2: `GlowStage` 的 WebGL 实现（shader、RT 池、pass 链、失败降级）

**Files:**
- Modify: `src/client/glow-stage.ts`（追加实现）
- Test: `tests/glow-stage.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `GlowOptions` / `normalizeGlowOptions` / `glowLevelSizes` / `GLOW_DEFAULTS`
- Produces:
  - `interface GlowStage { apply(renderer, scene, camera): void; resize(w, h): void; setOptions(o: GlowOptions): void; dispose(): void }`
  - `createGlowStage(width: number, height: number, opts?: GlowOptions): GlowStage | null`
  - 内部不变量（供测试观测）：`(stage as any).glowFailed === boolean`、`(stage as any).rtCount === number`

> **与 spec §3.2 的两点偏离（实现期订正，理由如下）**：
> 1. `createGlowStage` **不接收 renderer** —— RT 与材质都是纯 JS 对象，不需要 GL 上下文；renderer 直到 `apply(renderer, …)` 才可用（`three-renderer` 里 `player.renderer` 是私有字段，取不到）。尺寸用**画布缓冲**尺寸（装配点用 `fg.width/height`，此时已含 dpr）。
> 2. "shader 编译失败 ⇒ 返回 null"改为：**创建期只对非法尺寸返回 null**；shader / pass 的失败在**运行期首次 `apply` 时捕获并永久降级为直渲**（仍满足"绝不白屏"）。Task 7 回写 spec 措辞。

- [ ] **Step 1: 写失败测试**

在 `tests/glow-stage.test.ts` 末尾追加：

```ts
import * as THREE from 'three';
import { createGlowStage } from '../src/client/glow-stage.js';

/** 最小 renderer mock：只记录调用，不真编译 shader（node 无 WebGL）。 */
function mockRenderer() {
  const calls = { render: 0, setRenderTarget: [] as unknown[] };
  const renderer = {
    getClearAlpha: () => 1,
    setClearAlpha: (a: number) => { void a; },
    setRenderTarget: (t: unknown) => { calls.setRenderTarget.push(t); },
    render: () => { calls.render += 1; },
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, calls };
}

const scene = new THREE.Scene();
const camera = new THREE.Camera();

describe('createGlowStage（RT 池与 pass 链）', () => {
  it('建 1 张 base RT + 6 张小 RT（三级各 ping-pong 一对）', () => {
    const { renderer } = mockRenderer();
    const stage = createGlowStage(1280, 720)!;
    expect(stage).toBeTruthy();
    expect((stage as unknown as { rtCount: number }).rtCount).toBe(7);
    stage.dispose();
  });

  it('apply：主场景先渲进 base RT，最终 composite 渲到 canvas（target = null）', () => {
    const { renderer, calls } = mockRenderer();
    const stage = createGlowStage(1280, 720)!;
    stage.apply(renderer, scene, camera);
    // 10 个 pass，其中最后一个 composite 的目标是 null（canvas）
    expect(calls.render).toBe(10);
    expect(calls.setRenderTarget[calls.setRenderTarget.length - 1]).toBeNull();
    stage.dispose();
  });

  it('resize：按新尺寸重建 RT，并按新尺寸继续 apply', () => {
    const { renderer } = mockRenderer();
    const stage = createGlowStage(1280, 720)!;
    stage.resize(1600, 900);
    const sizes = (stage as unknown as { levelSizes: Array<{ w: number; h: number }> }).levelSizes;
    expect(sizes[0]).toEqual({ w: 800, h: 450 });
    stage.apply(renderer, scene, camera);
    expect((stage as unknown as { rtCount: number }).rtCount).toBe(7);
    stage.dispose();
  });

  it('setOptions：只更新 uniform，不重建 RT', () => {
    const { renderer } = mockRenderer();
    const stage = createGlowStage(1280, 720)!;
    const before = (stage as unknown as { rtCount: number }).rtCount;
    stage.setOptions({ threshold: 0.5, strength: 2 });
    expect((stage as unknown as { rtCount: number }).rtCount).toBe(before);
    expect((stage as unknown as { options: { threshold: number; strength: number } }).options)
      .toEqual({ threshold: 0.5, strength: 2 });
    stage.dispose();
  });

  it('apply 抛错 ⇒ 永久降级为直渲（同一帧内先试再回退，之后不再尝试）', () => {
    const { renderer, calls } = mockRenderer();
    const stage = createGlowStage(1280, 720)!;
    // 让第一个 pass 的渲染抛错（模拟 shader 编译 / pass 失败）
    let thrown = false;
    (renderer as unknown as { render: () => void }).render = () => {
      calls.render += 1;
      if (!thrown) { thrown = true; throw new Error('boom'); }
    };
    stage.apply(renderer, scene, camera); // 首次：抛错 → 降级并直渲一次
    expect((stage as unknown as { glowFailed: boolean }).glowFailed).toBe(true);
    const afterFallback = calls.render;
    stage.apply(renderer, scene, camera); // 之后：直接直渲，不再跑 pass 链
    expect(calls.render).toBe(afterFallback + 1);
    stage.dispose();
  });

  it('dispose：释放 RT 与材质（再 apply 是 no-op，不抛）', () => {
    const { renderer } = mockRenderer();
    const stage = createGlowStage(1280, 720)!;
    stage.dispose();
    expect((stage as unknown as { rtCount: number }).rtCount).toBe(0);
    expect(() => stage.apply(renderer, scene, camera)).not.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/glow-stage.test.ts --reporter=basic`
Expected: FAIL —— `createGlowStage is not a function`

- [ ] **Step 3: 写实现**

在 `src/client/glow-stage.ts` 追加（顶部补 `import * as THREE from 'three'` 与 `import { renderIntoRenderTarget } from './rt-render.js'`）：

```ts
export interface GlowStage {
  apply(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void;
  resize(width: number, height: number): void;
  setOptions(opts: GlowOptions): void;
  dispose(): void;
}

// ── shader ────────────────────────────────────────────────────────────────────
// 颜色空间：主场景渲进 RT 是**线性**值，而 threshold 标定在 **sRGB 字节域**（spec §3.4）
// ⇒ bright-pass 先转 sRGB，composite 末了转回线性，交回 renderer.outputColorSpace 编码。
const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const SRGB_HELPERS = `
vec3 toSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
vec3 toLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}
`;

const BRIGHT_FRAG = `
uniform sampler2D tSrc;
uniform float uThreshold;
varying vec2 vUv;
${SRGB_HELPERS}
void main() {
  vec3 srgb = toSrgb(texture2D(tSrc, vUv).rgb);
  float luma = dot(srgb, vec3(0.299, 0.587, 0.114));
  float k = max(0.0, luma - uThreshold) / max(1e-6, 1.0 - uThreshold);
  gl_FragColor = vec4(srgb * k, 1.0);
}
`;

// 固定 9 taps + uniform 步长（GLSL ES 1.00 要求循环边界为常量表达式；半径由 uStep 表达）
const BLUR_FRAG = `
uniform sampler2D tSrc;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 9; i++) {
    float o = float(i - 4);
    sum += texture2D(tSrc, vUv + uStep * o).rgb;
  }
  gl_FragColor = vec4(sum / 9.0, 1.0);
}
`;

const COPY_FRAG = `
uniform sampler2D tSrc;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0);
}
`;

const COMPOSITE_FRAG = `
uniform sampler2D tBase;
uniform sampler2D tL1;
uniform sampler2D tL2;
uniform sampler2D tL3;
uniform float uStrength;
varying vec2 vUv;
${SRGB_HELPERS}
void main() {
  vec3 baseSrgb = toSrgb(texture2D(tBase, vUv).rgb);
  vec3 glow = (texture2D(tL1, vUv).rgb + texture2D(tL2, vUv).rgb + texture2D(tL3, vUv).rgb) / 3.0;
  vec3 outc = clamp(baseSrgb + glow * uStrength, 0.0, 1.0);
  gl_FragColor = vec4(toLinear(outc), 1.0);
}
`;

/** 离线实验的 box blur 半径（像素）：L1 / L2 / L3 = 4 / 6 / 8（spec §2.2）。 */
const BLUR_RADII = [4, 6, 8];

function rtOptions(): THREE.RenderTargetOptions {
  return {
    type: THREE.HalfFloatType, // bright-pass 后要在 sRGB 域累加，8 位会有 banding
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping, // §5.19：RT 必须 CLAMP
    wrapT: THREE.ClampToEdgeWrapping,
  };
}

export function createGlowStage(
  width: number,
  height: number,
  opts?: GlowOptions,
): GlowStage | null {
  if (!(width > 0) || !(height > 0)) return null; // 非法视口 ⇒ 调用方回退直渲
  let options = normalizeGlowOptions(opts);

  // quad + 正交相机：所有 pass 都是全屏覆盖写
  const quadScene = new THREE.Scene();
  const quadCamera = new THREE.Camera();
  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  quadScene.add(mesh);

  const brightMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: BRIGHT_FRAG, uniforms: { tSrc: { value: null }, uThreshold: { value: options.threshold } }, depthTest: false, depthWrite: false });
  const blurMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: BLUR_FRAG, uniforms: { tSrc: { value: null }, uStep: { value: new THREE.Vector2() } }, depthTest: false, depthWrite: false });
  const copyMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: COPY_FRAG, uniforms: { tSrc: { value: null } }, depthTest: false, depthWrite: false });
  const compositeMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: COMPOSITE_FRAG, uniforms: { tBase: { value: null }, tL1: { value: null }, tL2: { value: null }, tL3: { value: null }, uStrength: { value: options.strength } }, depthTest: false, depthWrite: false });

  let baseRT: THREE.WebGLRenderTarget | null = null;
  let levelRTs: THREE.WebGLRenderTarget[] = []; // [L1a, L1b, L2a, L2b, L3a, L3b]
  let levelSizes: Array<{ w: number; h: number }> = [];
  let glowFailed = false;
  let disposed = false;

  const rtCount = () => (baseRT ? 1 : 0) + levelRTs.length;

  function buildTargets(w: number, h: number): void {
    disposeTargets();
    baseRT = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), rtOptions());
    levelSizes = glowLevelSizes(w, h);
    levelRTs = [];
    for (const s of levelSizes) {
      levelRTs.push(new THREE.WebGLRenderTarget(s.w, s.h, rtOptions()));
      levelRTs.push(new THREE.WebGLRenderTarget(s.w, s.h, rtOptions()));
    }
  }

  function disposeTargets(): void {
    baseRT?.dispose();
    baseRT = null;
    for (const rt of levelRTs) rt.dispose();
    levelRTs = [];
  }

  function runPass(r: THREE.WebGLRenderer, mat: THREE.ShaderMaterial, dst: THREE.WebGLRenderTarget | null): void {
    mesh.material = mat;
    if (dst) renderIntoRenderTarget(r, dst, quadScene, quadCamera);
    else { r.setRenderTarget(null); r.render(quadScene, quadCamera); }
  }

  /** 一级：先水平后垂直各一次 9-tap box blur（ping-pong 回写 a）。 */
  function blurLevel(r: THREE.WebGLRenderer, idx: number, a: THREE.WebGLRenderTarget, b: THREE.WebGLRenderTarget): void {
    const radius = BLUR_RADII[idx];
    const size = levelSizes[idx];
    blurMat.uniforms.tSrc.value = a.texture;
    blurMat.uniforms.uStep.value.set(radius / 4 / size.w, 0);
    runPass(r, blurMat, b);
    blurMat.uniforms.tSrc.value = b.texture;
    blurMat.uniforms.uStep.value.set(0, radius / 4 / size.h);
    runPass(r, blurMat, a);
  }

  // 10 个 pass，顺序与离线实验的**链式**一致：down → blur → 作为下一级输入（spec §2.2 / 表 §3.4）
  function renderGlow(r: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const [l1a, l1b, l2a, l2b, l3a, l3b] = levelRTs;
    // 1) 主场景 → base RT（透明清屏，§5.22）
    renderIntoRenderTarget(r, baseRT!, scene, camera);
    // 2) bright-pass（含降采样）：base → L1a
    brightMat.uniforms.tSrc.value = baseRT!.texture;
    runPass(r, brightMat, l1a);
    // 3–4) L1 模糊
    blurLevel(r, 0, l1a, l1b);
    // 5) 降采样：**模糊后的** L1a → L2a
    copyMat.uniforms.tSrc.value = l1a.texture; runPass(r, copyMat, l2a);
    // 6–7) L2 模糊
    blurLevel(r, 1, l2a, l2b);
    // 8) 降采样：L2a → L3a
    copyMat.uniforms.tSrc.value = l2a.texture; runPass(r, copyMat, l3a);
    // 9) L3 模糊（H + V 两个 pass 计入上一步之后）
    blurLevel(r, 2, l3a, l3b);
    // 10) composite：base + 三级等权上采样累加 → canvas
    compositeMat.uniforms.tBase.value = baseRT!.texture;
    compositeMat.uniforms.tL1.value = l1a.texture;
    compositeMat.uniforms.tL2.value = l2a.texture;
    compositeMat.uniforms.tL3.value = l3a.texture;
    compositeMat.uniforms.uStrength.value = options.strength;
    runPass(r, compositeMat, null);
  }

  buildTargets(width, height);

  return {
    apply(r, scene, camera) {
      if (disposed) return;
      if (glowFailed) { r.setRenderTarget(null); r.render(scene, camera); return; }
      try {
        renderGlow(r, scene, camera);
      } catch (e) {
        // 绝不白屏：一次失败即永久降级为直渲（shader 编译失败 / pass 异常）
        glowFailed = true;
        console.warn('[wallpaper-engine] 应用级 Glow 失败，已降级为直渲：' + String((e as Error)?.message ?? e));
        r.setRenderTarget(null);
        r.render(scene, camera);
      }
    },
    resize(w, h) {
      if (disposed) return;
      buildTargets(w, h);
    },
    setOptions(o) {
      options = normalizeGlowOptions(o);
      brightMat.uniforms.uThreshold.value = options.threshold;
      compositeMat.uniforms.uStrength.value = options.strength;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeTargets();
      geometry.dispose();
      brightMat.dispose(); blurMat.dispose(); copyMat.dispose(); compositeMat.dispose();
    },
    // 仅供测试观测（不参与渲染语义）
    get rtCount() { return rtCount(); },
    get levelSizes() { return levelSizes; },
    get options() { return options; },
    get glowFailed() { return glowFailed; },
  } as GlowStage;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/glow-stage.test.ts --reporter=basic`
Expected: PASS（18 项）

- [ ] **Step 5: 类型检查**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
Expected: exit 0

- [ ] **Step 6: 提交**

```bash
git add src/client/glow-stage.ts tests/glow-stage.test.ts
git commit -m "feat(glow): GlowStage 的 shader、RT 池与 pass 链" -m "10 pass（bright-pass + 三级 H/V box blur + composite）；颜色空间按 spec §3.4 对齐 sRGB 域。" -m "失败一次即永久降级为直渲，绝不白屏。验证：单测 18 项 + tsc。"
```

---

### Task 3: `threejs-player` 的 `setGlowStage` hook

**Files:**
- Modify: `src/client/threejs-player.ts`（帧体 `setAnimationLoop` 与 `renderFrame` 两处、`resize()`、`dispose()`）
- Test: `tests/threejs-player.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `GlowStage`
- Produces: `ThreeScenePlayer.setGlowStage(stage: GlowStage | null): void`

- [ ] **Step 1: 写失败测试**

在 `tests/threejs-player.test.ts` 的 `describe('ThreeScenePlayer', …)` 内追加（**复用本文件既有的 `makePlayer()` 与 `createMockRenderer()`**，见该文件第 14–45 行；`mock._renders` 记录每次 `renderer.render({scene, target, clearAlpha})`）：

```ts
/** GlowStage 的最小 spy：断言 apply / resize / dispose 的调用。 */
function glowStageSpy() {
  const applied: unknown[] = [];
  const sizes: Array<[number, number]> = [];
  let disposed = false;
  return {
    stage: {
      apply: (_r: unknown, s: unknown, c: unknown) => { applied.push([s, c]); },
      resize: (w: number, h: number) => { sizes.push([w, h]); },
      setOptions: () => {},
      dispose: () => { disposed = true; },
    },
    applied, sizes, isDisposed: () => disposed,
  };
}

it('未装配 glowStage 时帧序不变（直接 renderer.render(scene, camera)）', () => {
  const { player, mock } = makePlayer();
  const before = mock._renders.length;
  player.setGlowStage(null);
  player.renderFrame();
  expect(mock._renders.length).toBe(before + 1);
  expect(mock._renders[mock._renders.length - 1].target).toBeNull(); // 渲到 canvas
});

it('装配 glowStage 时委托 apply，且不直接渲染主场景', () => {
  const { player, mock } = makePlayer();
  const g = glowStageSpy();
  const before = mock._renders.length;
  player.setGlowStage(g.stage as never);
  player.renderFrame();
  expect(g.applied.length).toBe(1);
  expect(mock._renders.length).toBe(before); // 主场景渲染被委托给 stage（spy 不真渲）
});

it('resize 时把画布缓冲尺寸同步给 glowStage', () => {
  const { player } = makePlayer();
  const g = glowStageSpy();
  player.setGlowStage(g.stage as never);
  player.resize(800, 600);
  expect(g.sizes.length).toBe(1);
  const [w, h] = g.sizes[0];
  // 传的是**画布缓冲**尺寸（≥ CSS 尺寸；jsdom 默认 dpr=1 ⇒ 相等）
  expect(w).toBeGreaterThanOrEqual(800);
  expect(h).toBeGreaterThanOrEqual(600);
});

it('dispose 时拆除 glowStage', () => {
  const { player } = makePlayer();
  const g = glowStageSpy();
  player.setGlowStage(g.stage as never);
  player.dispose();
  expect(g.isDisposed()).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/threejs-player.test.ts --reporter=basic`
Expected: FAIL —— `player.setGlowStage is not a function`

- [ ] **Step 3: 写实现**

在 `src/client/threejs-player.ts`：

(a) 顶部加类型导入与字段：

```ts
import type { GlowStage } from './glow-stage.js';
```

在类字段区（`private objectEffectStage` 附近）加：

```ts
  private glowStage: GlowStage | null = null;
```

(b) 加公开方法（放在 `setObjectEffectStage` 附近）：

```ts
  /** 装配应用级 Glow（null = 关闭）。关闭时帧序与本方法加入前逐字相同。 */
  setGlowStage(stage: GlowStage | null): void {
    this.glowStage = stage;
  }
```

(c) 把帧体抽成 `renderFrame()` 并让 `setAnimationLoop` 复用它（**两处帧序必须同源**，避免漂移）：

```ts
  /** 一帧的渲染帧序：隔离内容 → bindOutputs → 主场景（或 Glow）→ advance。 */
  renderFrame(): void {
    if (this.isolated.size > 0) this.renderIsolatedContents();
    this.objectEffectStage?.bindOutputs();
    if (this.glowStage) this.glowStage.apply(this.renderer, this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
    this.objectEffectStage?.advance(this.elapsedSeconds());
  }
```

`setAnimationLoop` 的帧体与既有 `renderFrame`（无 dt 的那个方法，若已存在同名则合并为一个）内对上述 4 行的重复实现改为调用 `this.renderFrame()`。

(d) `resize(width, height)` 末尾加（**传画布缓冲尺寸，不是 CSS 尺寸** —— 该方法内部已完成 canvas 尺寸与 dpr 设置）：

```ts
    // Glow 各级 RT 必须按画布缓冲尺寸建（与主相机 cover 口径一致）
    this.glowStage?.resize(this.renderer.domElement.width, this.renderer.domElement.height);
```

(e) `dispose()` 里（`this.renderer.dispose()` 之前）加：

```ts
    this.glowStage?.dispose();
    this.glowStage = null;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/threejs-player.test.ts --reporter=basic`
Expected: PASS（既有项 + 4 项新增，无失败）

- [ ] **Step 5: 类型检查 + 提交**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
Expected: exit 0

```bash
git add src/client/threejs-player.ts tests/threejs-player.test.ts
git commit -m "feat(glow): player 加 setGlowStage hook 与帧序分支" -m "未装配时走原 renderer.render 路径（零回归）；帧体抽为 renderFrame 供两处复用。" -m "验证：threejs-player 单测全绿（含 4 项新增）。"
```

---

### Task 4: 设置字段（types / DEFAULTS / host schema / 面板开关）

**Files:**
- Modify: `src/client/types.ts`、`src/client/settings.ts`、`src/host/settings.ts`、`src/client/settings-section.tsx`
- Test: `tests/client-settings.test.ts`、`tests/settings.test.ts`、`tests/dom/settings-section.dom.test.tsx`

**Interfaces:**
- Produces：`ClientSettings` 的 `glowEnabled: boolean`、`glowThreshold: number`、`glowStrength: number`

- [ ] **Step 1: 写失败测试**

`tests/client-settings.test.ts` 追加：

```ts
it('DEFAULTS 含 Glow 三字段（默认开启 / A 档参数）', () => {
  expect(DEFAULTS.glowEnabled).toBe(true);
  expect(DEFAULTS.glowThreshold).toBe(0.65);
  expect(DEFAULTS.glowStrength).toBe(1.0);
});
```

`tests/settings.test.ts`：该文件用的是 `WallpaperSettingsSchema`（第 2 行导入），把既有的 `applies defaults` 用例期望值扩为：

```ts
    expect(value).toMatchObject({
      selectedWallpaperId: '',
      wallpaperDir: '',
      weAssetsDir: '',
      overlayOpacity: 0.35,
      blurEnabled: false,
      blurRadius: 12,
      kenBurns: true,
      glowEnabled: true,
      glowThreshold: 0.65,
      glowStrength: 1.0,
    });
```

并追加越界用例：

```ts
  it('rejects glowThreshold outside [0, 0.99] and glowStrength outside [0, 4]', () => {
    expect(() => WallpaperSettingsSchema({ glowThreshold: 1 })).toThrow();
    expect(() => WallpaperSettingsSchema({ glowStrength: 5 })).toThrow();
  });
```

`tests/dom/settings-section.dom.test.tsx`：该文件已有渲染设置面板的用例与 `writeClientSettings` 的 mock 方式；追加一个用例 —— 渲染面板 → `screen.getByLabelText('光晕')` 拿到复选框 → `fireEvent.click` → 断言写入 `{ glowEnabled: false }`（写入断言沿用该文件既有写法）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/client-settings.test.ts tests/settings.test.ts --reporter=basic`
Expected: FAIL（`glowEnabled` 为 `undefined`）

- [ ] **Step 3: 写实现**

`src/client/types.ts` 的 `ClientSettings` 接口加：

```ts
  /** 应用级 Glow（对齐 WE 的 general.user.postprocessing）：整帧亮部发光。 */
  glowEnabled: boolean;
  /** bright-pass 阈值（sRGB 域），缺省 0.65。 */
  glowThreshold: number;
  /** 发光强度，缺省 1.0。 */
  glowStrength: number;
```

`src/client/settings.ts` 的 `DEFAULTS` 改为：

```ts
export const DEFAULTS: ClientSettings = {
  selectedWallpaperId: '', wallpaperDir: '', weAssetsDir: '',
  overlayOpacity: 0.35, blurEnabled: false, blurRadius: 12, kenBurns: true,
  glowEnabled: true, glowThreshold: 0.65, glowStrength: 1.0,
};
```

`src/host/settings.ts` 的 schema 加三个字段（沿用该文件既有的 `Schema.object({...})` 风格，缺省值与 `DEFAULTS` 一致）：

```ts
  glowEnabled: Schema.boolean().default(true),
  glowThreshold: Schema.number().min(0).max(0.99).default(0.65),
  glowStrength: Schema.number().min(0).max(4).default(1.0),
```

`src/client/settings-section.tsx` 加一个复选框（放在既有控件附近，沿用文件里的控件写法）：

```tsx
<label>
  <input
    type="checkbox"
    checked={settings.glowEnabled}
    onChange={(e) => void writeClientSettings({ glowEnabled: e.target.checked })}
  />
  光晕
</label>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/client-settings.test.ts tests/settings.test.ts tests/dom/settings-section.dom.test.tsx --reporter=basic`
Expected: PASS

- [ ] **Step 5: 类型检查 + 提交**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
Expected: exit 0

```bash
git add src/client/types.ts src/client/settings.ts src/host/settings.ts src/client/settings-section.tsx tests/client-settings.test.ts tests/settings.test.ts tests/dom/settings-section.dom.test.tsx
git commit -m "feat(glow): 设置加 glowEnabled/glowThreshold/glowStrength 与面板开关" -m "默认开启、A 档参数；面板只暴露开关，阈值/强度走 config（与既有四字段同待遇）。" -m "验证：settings 三处单测 + tsc。"
```

---

### Task 5: `three-renderer` 装配（建 / 更新 / 拆除 + resize 同步）

**Files:**
- Modify: `src/client/three-renderer.ts`（`teardown()`、render 成功路径、`resize` 监听）
- Test: `tests/three-renderer.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `createGlowStage`、Task 3 的 `setGlowStage`、Task 4 的三个设置字段
- Produces: 无新公开接口（内部接线）

- [ ] **Step 1: 写失败测试**

在 `tests/three-renderer.test.ts` 顶部**并行 mock 掉 glow-stage 模块**（与既有的 `vi.mock` 并列，见该文件第 13–25 行）：

```ts
vi.mock('../src/client/glow-stage.js', () => ({
  createGlowStage: vi.fn(() => ({
    apply: vi.fn(), resize: vi.fn(), setOptions: vi.fn(), dispose: vi.fn(),
  })),
}));
```

然后在既有 `describe('createThreeSceneRenderer', …)` 内、**复用该文件已有 render 成功用例的同样准备步骤**（`resolveImageTexture.mockResolvedValue(fakeTexture())` + 既有 fetch stub），追加：

```ts
it('glowEnabled=false ⇒ 不创建 Glow stage（零资源）', async () => {
  vi.mocked(createGlowStage).mockClear();
  await renderer.render('2851992662', document.createElement('canvas'));
  expect(createGlowStage).not.toHaveBeenCalled();
});

it('glowEnabled=true ⇒ 用画布缓冲尺寸创建 stage 并交给 player', async () => {
  vi.mocked(createGlowStage).mockClear();
  await renderer.render('2851992662', document.createElement('canvas'));
  expect(createGlowStage).toHaveBeenCalledTimes(1);
  const [, w, h] = vi.mocked(createGlowStage).mock.calls[0];
  expect(w).toBeGreaterThan(0);
  expect(h).toBeGreaterThan(0);
});

it('dispose ⇒ stage 被释放', async () => {
  await renderer.render('2851992662', document.createElement('canvas'));
  const stage = vi.mocked(createGlowStage).mock.results[0].value;
  renderer.dispose();
  expect(stage.dispose).toHaveBeenCalled();
});
```

> **执行者注意**：
> - `renderer` 指该文件既有的 `createThreeSceneRenderer()` 实例；若既有用例是就地创建（未存变量），按同样方式创建即可。
> - 设置：`createThreeSceneRenderer` 读模块内设置。若该文件已有注入设置的手段（`setSettingsCtx` 等）就沿用，**不要**新造一套。
> - 尺寸断言只校验"正数"，不校验精确值（`fg.width/height` 由 `player.resize` 按 dpr 设定，jsdom 下 dpr=1）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/three-renderer.test.ts --reporter=basic`
Expected: FAIL —— 设置未接线（`setStage` 未被调用 / 收到 `undefined`）

- [ ] **Step 3: 写实现**

`src/client/three-renderer.ts`：

(a) 导入：

```ts
import { createGlowStage, type GlowStage } from './glow-stage.js';
```

(b) 闭包内加当前 stage 引用（与 `currentStage` 并列）：

```ts
  let currentGlow: GlowStage | null = null;
```

(c) 在 render 成功装配 player 之后（`current.player` 就绪处）接线 —— **尺寸用 `fg.width/height`**（canvas 缓冲尺寸：`loadSceneToThree` 内部的 `player.resize(vw, vh)` 已按 dpr 设过）：

```ts
    // 应用级 Glow：关闭时**不建任何资源**（零回归）
    currentGlow?.dispose();
    currentGlow = settings.glowEnabled
      ? createGlowStage(fg.width, fg.height, {
          threshold: settings.glowThreshold,
          strength: settings.glowStrength,
        })
      : null;
    current.player.setGlowStage(currentGlow);
```

(d) `teardown()` 里（`currentStage?.dispose()` 附近）加：

```ts
    currentGlow?.dispose();
    currentGlow = null;
```

(e) **不要**在 `onWindowResize` 里再调 `currentGlow?.resize(...)` —— 该处第 383 行的 `current.player.resize(width, height)` **内部已经**把画布缓冲尺寸同步给了 stage（Task 3 的 (d)）。两处各算一遍正是 `AGENT.md` §5.21 那类"尺寸口径不一致 / 挂载期与 resize 期不同源"的结构性来源。

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/three-renderer.test.ts --reporter=basic`
Expected: PASS（既有项 + 3 项新增）

- [ ] **Step 5: 构建 + 类型检查 + 提交**

Run: `npm run build && npm run build:client`
Expected: 两个命令 exit 0

```bash
git add src/client/three-renderer.ts tests/three-renderer.test.ts lib dist
git commit -m "feat(glow): three-renderer 按设置装配/拆除 Glow stage" -m "关闭时不建 RT（零回归）；resize 同步 stage.resize；teardown 释放。" -m "验证：three-renderer 单测 + build/build:client。"
```

---

### Task 6: 端到端真机验收（p99 判据 + 零回归 + 性能）

**Files:**
- Modify: `research/verify-object-effects.mjs`（加 `[7]` 段；gitignored，不入库）

**Interfaces:**
- Consumes: Task 5 的装配（生产 `lib/` 产物）
- Produces: 验收结论（写进 Task 7 的文档）

- [ ] **Step 1: 加 `[7]` 段**

在 `[6]` 段之后、汇总之前插入一段（沿用该脚本既有的 `runPage` / `evalJS` / `gpuMem` / `say` / `R.checks` 设施）：

```js
  // ═══ 判定 7：应用级 Glow（真机 GPU）═══════════════════════════════════════════
  // 判据（spec §5）：开启后云区 p99 由 ~199 升至 ≥215（离线 A 档 221 / 桌面 225）；
  // 关闭时与改动前同相位帧逐像素一致；开/关的每帧提交耗时不显著退化。
  say('\n===== [7] 应用级 Glow（开/关对照 + 零回归 + 性能）=====');
  {
    const WP_GLOW = '3743126786'; // GTR：桌面 225 / 我们 199（spec §2.2 的区域口径）
    const shot = async (glowOn) => {
      // 通过 __fxSetGlow(on) 开关（本步骤同时在 harness 入口暴露该入口，见下）
      await evalJS(`window.__fxSetGlow(${glowOn ? 'true' : 'false'})`);
      await sleep(1200);
      const r = await runPage(WP_GLOW, { label: glowOn ? 'glow-on' : 'glow-off' });
      return r;
    };
    const on = await shot(true);
    const off = await shot(false);
    if (on.fail || off.fail) {
      say(`  [7] 运行失败：${on.fail ?? off.fail}`);
      R.checks.push({ name: '[7] 应用级 Glow', pass: false, why: on.fail ?? off.fail });
    } else {
      const p99 = (png) => lumaStats(decodePng(png)).p99; // lumaStats 需从 research/glow-post.mjs 导入
      const p99On = p99(on.A), p99Off = p99(off.A);
      say(`  云区口径 p99：关=${p99Off} 开=${p99On}（离线 A 档 221 / 桌面 225）`);
      const zeroRegress = diffStat(decodePng(off.A), decodePng(off.B), null).maxDelta; // 关：两帧间只剩时间相位
      say(`  关闭时帧间最大差（应只含时间相位）= ${zeroRegress}`);
      R.checks.push({ name: '[7] Glow 开启后云区 p99 ≥ 关闭时 + 15', pass: p99On - p99Off >= 15, why: `关 ${p99Off} → 开 ${p99On}` });
      R.report.judge7 = { p99On, p99Off, delta: p99On - p99Off };
    }
  }
```

同时在 `research/harness-object-effects-entry.mjs` 暴露开关入口（把设置写进页面可读的位置，并让生产装配走它）：

```js
// ★ Glow 开关（2026-09-20）：[7] 段用它在同一页面内做开/关对照。
//   生产里 glow 由插件设置驱动；harness 通过 localStorage 覆盖后重新装配 player。
window.__fxSetGlow = (on) => {
  try { localStorage.setItem('we:harness:glow', on ? '1' : '0'); } catch {}
  location.reload();
  return 'reloading';
};
```

> **执行者注意**：harness 入口读 `localStorage['we:harness:glow']` 后覆盖 `glowEnabled` 再调 `createThreeSceneRenderer()`（在既有 `WASM_NONE` 覆盖处附近加同样的 override 即可）。若这条路比预期绕，**替代方案**：直接跑两次 `verify-object-effects.mjs`，第二次用环境变量 `GLOW=0` 让脚本自身的设置注入为关闭 —— 只要开/关两帧来自**同一套生产代码**即可。

- [ ] **Step 2: 在真 GPU 上跑**

Run: `node research/verify-object-effects.mjs --gpu`（需完整权限）
Expected: `[7]` 段输出 `关=~199 开=≥215`，`PASS`；`[1]`–`[6]` 与本次改动前**逐项相同**（`[6]` 仍是 `Δ 0`）。

- [ ] **Step 3: 若 p99 未达 215：先查颜色空间，不要先调参数**

按顺序核对（spec §3.4 / §6）：
1. bright-pass 是否对 base **手工转了 sRGB**（漏了 ⇒ 阈值 0.65 等效成 sRGB 域 0.83 ⇒ 几乎不发光）；
2. composite 是否**转回线性**再交回 `outputColorSpace`；
3. 各级 RT 是否 `HalfFloatType`（8 位在 sRGB 域累加会有 banding，但不至于达不到阈值）；
4. 只有 1–3 都正确时，才考虑是否需要为"各级等权 vs WE 真实权重"调整。

- [ ] **Step 4: 记录结论**

把实测的 `p99 关/开`、帧间最大差、开/关的每帧提交耗时、显存增量写进 `research/object-effects/glow-run.log`（gitignored），供 Task 7 回写文档。

（本 Task **不提交代码**：脚本在 gitignored 的 `research/`。）

---

### Task 7: 文档回写、产物重建与基线复核

**Files:**
- Modify: `AGENT.md`、`docs/technical-notes.md`、`README.md`
- Modify: `lib/`、`dist/`（构建产物）

**Interfaces:**
- Consumes: Task 6 的实测数字
- Produces: 无

- [ ] **Step 1: 回写 `AGENT.md`**

(a) §7.1 的「**应用级后处理（WE 的「后处理 / Glow」）未实现（2026-09-16 用户实测发现，缺口）**」条：改为「**已实现（2026-09-20）**」并追加实现与实测：

```markdown
      - **已实现（2026-09-20，提交见本条的 log）**：`src/client/glow-stage.ts` + `threejs-player` 的 `setGlowStage` hook。语义、参数（A 档 `threshold 0.65` / `strength 1.0`）、pass 链与**颜色空间对齐**（threshold 标定在 sRGB 域，而 RT 里是线性值 ⇒ shader 内手工互转）见 spec `docs/superpowers/specs/2026-09-20-app-level-glow-design.md`。**默认开启**（`glowEnabled`，面板一个开关；阈值/强度走 profile config）。**实测**：GTR 云区 p99 <关→开>（填 Task 6 的实测值；离线 A 档 221 / 桌面 225）；关闭时与改动前**逐像素一致**（逐帧差分只剩时间相位）；开/关每帧提交耗时 <填实测>。**范围裁剪（如实）**：只覆盖 **scene** 壁纸 —— WE 的 postprocessing 对 video 也生效，故 **video / image / web 的亮部仍与桌面有差**。**未做**：壁纸级 `general.bloom`（全库 3 张）、HDR / 色调映射、显存 cap。
```

(b) 在 §5 新增一条（语义与踩坑，编号接 §5 末尾）：

```markdown
## 32. **应用级 Glow 的颜色空间必须手工对齐（2026-09-20）**：离线标定 `threshold` 用的是 **sRGB 字节域**（PNG 像素），而主场景渲染进 RT 得到的是**线性**值（`outputColorSpace` 只作用于渲染到 canvas 那一步）⇒ Glow shader 内必须「线性 → `toSrgb()` → 算 luma / bright-pass / 各级模糊 → composite 后 `toLinear()`」。**漏掉这一步的后果是阈值语义整体偏移**（sRGB 域 0.65 ≈ 线性域 0.83）⇒ 表现为"几乎不发光"，而不是报错。端到端判据（云区 p99 ≥ 215）就是用来抓它的。
```

- [ ] **Step 2: 回写 `docs/technical-notes.md`**

在 §4（显存与性能）追加：

```markdown
- **应用级 Glow 的显存与开销（2026-09-20 实测）**：base RT（画布缓冲尺寸）+ 6 张小 RT（三级各一对 ping-pong，约 0.66×base 面积）≈ 33 MB @3440×1440@dpr1（RGBA8 口径按 HalfFloat 翻倍）；只统计 `glowEnabled` 时占用。开/关的每帧 `renderer.render` 提交耗时与帧间隔见 `AGENT.md` §7.1 的实测行。
```

- [ ] **Step 3: 回写 `README.md`**

把「⚠️ 使用前请了解 → 画面表现」里的这条：

```
- **和桌面版 Wallpaper Engine 比，亮度略有差异**（约 15%）。
```

改为（数字按 Task 6 实测填）：

```
- **应用级光晕（Glow）已实现并默认开启**（设置 → 壁纸 → 「光晕」可关）：scene 壁纸的亮部（路灯、霓虹、云边）现在有与桌面版一致的光晕，此前"桌面更亮"的主要差异来源即它。**仅 scene 壁纸**：视频 / 图片 / 网页壁纸的亮部仍与桌面有差。
```

- [ ] **Step 4: 重建产物并复核基线**

Run:
```bash
npm run build && npm run build:client
node node_modules/vitest/vitest.mjs run tests/effect-runner.test.ts tests/glow-stage.test.ts tests/threejs-player.test.ts tests/three-renderer.test.ts tests/object-effects.test.ts --reporter=basic
node node_modules/vitest/vitest.mjs run tests/scene-renderer.test.ts tests/wasm-renderer.test.ts tests/dom/bootstrap.dom.test.ts --reporter=basic
```
Expected: 第一组全绿；第二组失败数 = **6 / 7 / 1**（与基线逐项相同）。

- [ ] **Step 5: 提交**

```bash
git add AGENT.md docs/technical-notes.md README.md lib dist
git commit -m "docs(glow): 回写应用级 Glow 的实现、实测与颜色空间约定" -m "§7.1 缺口改已实现并记录 p99 与开销；新增 §5.32 颜色空间对齐；README 订正亮度差异条目。" -m "产物重建；受影响模块单测全绿、既有 15 项失败逐项不变。"
```

---

## Self-Review

**Spec coverage**

| spec 章节 | 覆盖任务 |
|---|---|
| §3.1 架构与数据流 | Task 2（stage）+ Task 3（帧序分支）+ Task 5（装配） |
| §3.2 接口 | Task 1/2（`glow-stage.ts`）+ Task 3（`setGlowStage`） |
| §3.3 不复用 EffectRunner | 已由设计决定（无任务） |
| §3.4 pass 链 / 颜色空间 / 参数 | Task 2（10 pass + toSrgb/toLinear）+ Task 1（clamp） |
| §3.5 设置与装配 | Task 4（字段 + 面板）+ Task 5（装配 / resize / teardown） |
| §3.6 错误处理与零回归 | Task 2（失败降级）+ Task 3/5（关闭时不建资源）+ Task 6（零回归判据） |
| §4 非目标 | Global Constraints + Task 7 的文档"未做"行 |
| §5 测试与验收 | Task 1/2/3/4/5（单测）+ Task 6（端到端判据）+ Task 7 Step 4（基线） |
| §6 风险与遗留 | Task 6 Step 3（颜色空间自查）+ Task 7（文档"范围裁剪/未做"） |

**Placeholder scan**：已核对，无 TBD / TODO / "类似 Task N"；所有代码步骤均含可执行代码。文档回写模板里的 `<填 Task 6 的实测值>` 是**要求执行者回填已测得的数字**（该值在计划写作时不可能预知），已显式措辞，不属未定项。

**Type consistency**：`GlowOptions` / `GlowStage` / `createGlowStage` / `glowLevelSizes` / `normalizeGlowOptions` / `GLOW_DEFAULTS` / `setGlowStage` 在 Task 1→2→3→5 间签名一致。

**自审发现并已修正的 4 处问题**（初稿的错误，记录在此以免执行者误用旧版）：
1. **降采样顺序**（Task 2 实现）：初稿把两级降采样都放在模糊之前 ⇒ 会得到"未模糊的 L1 降采样成 L2"，与离线实验的**链式**（down → blur → 作为下一级输入，见 `glow-post.mjs` 的 `cur` 传递）不一致。已改为 `bright → L1 blur → down → L2 blur → down → L3 blur`。
2. **`createGlowStage` 的 renderer 参数**：初稿让它接收 `renderer`，但 `three-renderer` 拿不到（`player.renderer` 是私有字段），且 RT/材质是纯 JS 对象本不需要 GL 上下文 ⇒ 已改为 `createGlowStage(width, height, opts?)`，renderer 只在 `apply(renderer, …)` 时使用。
3. **测试引用的辅助名**：初稿编造了 `makePlayerWithMockRenderer` / `renderWithSettings` 等。已换成文件里的真实辅助（`createMockRenderer` / `makePlayer` / `mock._renders` / `WallpaperSettingsSchema`），其余改为"复用该文件既有准备步骤 + 明确断言"。
4. **resize 尺寸口径**：初稿在 `three-renderer` 的 `onWindowResize` 里再算一次尺寸（且易传成 CSS 尺寸）⇒ 改为**只在 `player.resize()` 内部**用 `renderer.domElement.width/height` 同步（缓冲尺寸），避免两处各算一遍。

**与 spec 的两点显式偏离**（已在 Task 2 的 Interfaces 注明，Task 7 回写 spec 措辞）：`createGlowStage` 不接收 renderer；"shader 编译失败 ⇒ null"改为"创建期只对非法尺寸返回 null + 运行期首次 apply 失败即永久降级"。
