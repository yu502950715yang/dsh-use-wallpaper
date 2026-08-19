# Scene 播放修复 — 阶段 1（效果链 P0 四项）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复效果链四项 P0 根因——纹理槽路径推导、内置纹理回退、we-headers 按引擎真实实现补全、fetch 偶发失败重试——使效果链从"大量编译失败 + mask/normal 全 404"变为全链可用。

**Architecture:** 在现有渲染管线上做定向修复：新增 `fetchWithRetry` 网络工具；`effect-runner.ts` 的 `resolveTextureSlot` 增加路径推导与内置纹理回退；`we-headers.ts` 按本机 WE 客户端引擎头文件逐字转写（含 GLSL3 适配补丁）。全部为现有文件内修改，无架构重组。

**Tech Stack:** TypeScript、three r170、vitest、esbuild（client bundle）

**Spec:** `docs/superpowers/specs/2026-08-19-scene-play-fix-phase1-effects.md`
（引擎头文件权威源码：`D:\Steam\steamapps\common\wallpaper_engine\assets\shaders\`，实测证据见 `research/scene-play-research.md` §2/§4/§8）

## Global Constraints

- 效果链纹理槽推导：无 `materials/` 前缀或 `.tex` 后缀的路径 → `materials/` + path + `.tex`；`util/*`、`_rt_*` 原样透传（走内置分支）
- 内置纹理：`util/white` → 1×1 白；`util/noise`/`util/clouds_256` → 256×256 灰阶噪声（mulberry32 固定种子）；`_rt_*` → 1×1 白（A6 前近似）
- fetch 重试：仅对 fetch reject（`Failed to fetch`）重试 ≤2 次（指数退避 50ms/100ms）；4xx/5xx 确定性失败不重试
- `M_PI_2` 必须为 `6.28318530718`（2π，引擎真实值）；引擎头转写保留 `frac/saturate/texSample2D/mul/CAST*`（GLSL3 语义等价物），`#if HLSL`/`#ifdef HLSL_SM30` 分支原样保留（GLSL3 下不生效）
- 测试：node 环境（`tests/*.test.ts`），mock 全局 fetch 用 `vi.stubGlobal`，恢复用 `vi.unstubAllGlobals`
- 命令：`npx vitest run tests/<file>`（单测）、`npx vitest run`（全量）、`npx tsc --noEmit`、`npm run build`、`npm run build:client`

---

### Task 1: fetchWithRetry 工具 + 替换两处加载调用

**Files:**
- Create: `src/client/fetch-util.ts`
- Modify: `src/client/tex-loader.ts:233-239`（loadTexTexture 内部 fetch → fetchWithRetry）
- Modify: `src/client/scene-renderer.ts:274-286`（renderScene 效果链 loadFile → fetchWithRetry）
- Test: `tests/fetch-util.test.ts`

**Interfaces:**
- Consumes: 无（独立工具）
- Produces: `fetchWithRetry(url: string, retries?: number): Promise<Uint8Array | null>` —— 成功返回字节数组；4xx/5xx 或重试耗尽返回 null。Task 2 的 `resolveTextureSlot` 与后续任务复用。

- [ ] **Step 1: 写失败测试**

`tests/fetch-util.test.ts`：
```ts
import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchWithRetry } from '../src/client/fetch-util.js';

afterEach(() => vi.unstubAllGlobals());

function okBody(bytes: number[]): Response {
  return new Response(new Uint8Array(bytes), { status: 200 });
}

describe('fetchWithRetry', () => {
  it('reject 1 次后重试成功，返回字节数组', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(okBody([1, 2, 3]));
    vi.stubGlobal('fetch', fetchMock);
    const data = await fetchWithRetry('/wallpapers/scene/1/asset?name=x.json');
    expect(data).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('连续 reject 超过重试次数返回 null', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchWithRetry('/x', 2)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 次原始 + 2 次重试
  });
  it('404 确定性失败不重试，直接返回 null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchWithRetry('/missing')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/fetch-util.test.ts -v`
Expected: FAIL（`fetch-util.js` 模块不存在）

- [ ] **Step 3: 实现 fetchWithRetry**

`src/client/fetch-util.ts`：
```ts
// src/client/fetch-util.ts
// 场景资源 fetch 的失败重试：仅对 fetch reject（连接复用竞态等瞬时失败）重试，
// 4xx/5xx 确定性失败不重试（避免掩盖资源缺失问题）。
export async function fetchWithRetry(url: string, retries = 2): Promise<Uint8Array | null> {
  for (let i = 0; ; i++) {
    try {
      const resp = await fetch(url);
      return resp.ok ? new Uint8Array(await resp.arrayBuffer()) : null;
    } catch {
      if (i >= retries) return null;
      await new Promise((r) => setTimeout(r, 50 * (i + 1))); // 指数退避 50ms/100ms
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/fetch-util.test.ts -v`
Expected: PASS（3 个用例）

- [ ] **Step 5: 替换 tex-loader 与 scene-renderer 的 fetch 调用**

`src/client/tex-loader.ts` L233-239，`loadTexTexture` 内部 `fetch(url)` 改为 `fetchWithRetry(url)`，并 import：
```ts
import { fetchWithRetry } from './fetch-util.js';
// ...
export async function loadTexTexture(url: string): Promise<THREE.Texture | null> {
  const buf = await fetchWithRetry(url);
  if (!buf) return null;
  const info = parseTex(buf);
  if (!info) return null;
  return textureFromTex(info);
}
```
（删除原 `const resp = await fetch(url); if (!resp.ok) return null; const buf = new Uint8Array(await resp.arrayBuffer());` 三行）

`src/client/scene-renderer.ts` L277-280，renderScene 内效果链 `loadFile` 改为：
```ts
import { fetchWithRetry } from './fetch-util.js';
// ...
const chain = await resolveEffectChain(fx, async (name) => {
  return fetchWithRetry(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(name)}`);
});
```

- [ ] **Step 6: 跑相关测试确认无回归**

Run: `npx vitest run tests/fetch-util.test.ts tests/tex-loader.test.ts tests/scene-renderer.test.ts`
Expected: PASS（全部）

- [ ] **Step 7: Commit**

```bash
git add src/client/fetch-util.ts src/client/tex-loader.ts src/client/scene-renderer.ts tests/fetch-util.test.ts
git commit -m "fix(wallpaper-engine): 场景资源 fetch 失败重试（连接复用竞态）"
```

---

### Task 2: 效果链纹理槽路径推导 + 内置纹理回退（P0-1/P0-2）

**Files:**
- Modify: `src/client/effect-runner.ts`（新增导出 `resolveTextureSlotPath`、`resolveBuiltinTexture`；改造 `resolveTextureSlot`）
- Test: `tests/effect-runner.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `fetchWithRetry`（tex 加载经 `loadTexTexture` 已获得重试）
- Produces: `resolveTextureSlotPath(path: string): string | null`（导出供单测）；`resolveBuiltinTexture(path: string): THREE.Texture | null`（`util/white`、`util/noise`、`util/clouds_256`、`_rt_*`；其余返回 null）

- [ ] **Step 1: 写失败测试**

追加到 `tests/effect-runner.test.ts`：
```ts
import { resolveTextureSlotPath, resolveBuiltinTexture } from '../src/client/effect-runner.js';

describe('resolveTextureSlotPath（纹理槽路径推导）', () => {
  it('无前缀无后缀 → materials/ 前缀 + .tex', () => {
    expect(resolveTextureSlotPath('masks/waterwaves_mask_x')).toBe('materials/masks/waterwaves_mask_x.tex');
    expect(resolveTextureSlotPath('effects/waterripplenormal')).toBe('materials/effects/waterripplenormal.tex');
  });
  it('已完整路径不变', () => {
    expect(resolveTextureSlotPath('materials/masks/x.tex')).toBe('materials/masks/x.tex');
  });
  it('内置 util 与运行时 _rt_ 原样透传', () => {
    expect(resolveTextureSlotPath('util/white')).toBe('util/white');
    expect(resolveTextureSlotPath('_rt_FullFrameBuffer')).toBe('_rt_FullFrameBuffer');
  });
  it('空路径返回 null', () => {
    expect(resolveTextureSlotPath('')).toBeNull();
    expect(resolveTextureSlotPath(null as unknown as string)).toBeNull();
  });
});

describe('resolveBuiltinTexture（内置/运行时纹理回退）', () => {
  it('util/white → 非 null 纹理', () => {
    const tex = resolveBuiltinTexture('util/white');
    expect(tex).not.toBeNull();
    expect(tex!.image.width).toBe(1);
  });
  it('util/noise 与 util/clouds_256 → 256 噪声纹理', () => {
    for (const p of ['util/noise', 'util/clouds_256']) {
      const tex = resolveBuiltinTexture(p);
      expect(tex).not.toBeNull();
      expect(tex!.image.width).toBe(256);
    }
  });
  it('_rt_* → 白色回退', () => {
    expect(resolveBuiltinTexture('_rt_imageLayerComposite_1_a')).not.toBeNull();
  });
  it('普通路径 → null（交给 fetch）', () => {
    expect(resolveBuiltinTexture('masks/x')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/effect-runner.test.ts -v`
Expected: FAIL（`resolveTextureSlotPath`/`resolveBuiltinTexture` 未导出）

- [ ] **Step 3: 实现路径推导与内置纹理**

`src/client/effect-runner.ts` 顶部 import 区追加（THREE 已导入）：
```ts
export function resolveTextureSlotPath(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith('util/') || path.startsWith('_rt_')) return path; // 内置/运行时：走回退分支
  if (path.endsWith('.tex')) return path.startsWith('materials/') ? path : 'materials/' + path;
  return 'materials/' + path + '.tex';
}

// mulberry32（与 particles.ts 同种子算法），确定性噪声
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BUILTIN_CACHE = new Map<string, THREE.Texture>();

export function resolveBuiltinTexture(path: string | null | undefined): THREE.Texture | null {
  if (!path) return null;
  let key: string;
  if (path === 'util/white') key = 'white';
  else if (path === 'util/noise' || path === 'util/clouds_256') key = 'noise256';
  else if (path.startsWith('_rt_')) key = 'white'; // 运行时 RT 一期回退白（A6 合成层精化）
  else return null;
  const cached = BUILTIN_CACHE.get(key);
  if (cached) return cached;
  let tex: THREE.Texture;
  if (key === 'white') {
    tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
  } else {
    const size = 256;
    const data = new Uint8Array(size * size * 4);
    const rnd = mulberry32(0x51ab3e7d);
    for (let i = 0; i < size * size; i++) {
      const v = Math.round(rnd() * 255);
      data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
    }
    tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  }
  tex.needsUpdate = true;
  BUILTIN_CACHE.set(key, tex);
  return tex;
}
```

- [ ] **Step 4: 改造 resolveTextureSlot**

`src/client/effect-runner.ts` 的 `resolveTextureSlot`（现 L164-172）整体替换为：
```ts
private async resolveTextureSlot(path: string | null): Promise<THREE.Texture | null> {
  if (!path) return null;
  // 内置程序纹理 / 运行时 RT 引用：不 fetch，直接回退（P0-2）
  const builtin = resolveBuiltinTexture(path);
  if (builtin) return builtin;
  const key = `${this.id}:${path}`;
  if (this.textures.has(key)) return this.textures.get(key) ?? null;
  const resolved = resolveTextureSlotPath(path);
  if (!resolved) return null;
  const tex = await loadTexTexture(`/wallpapers/scene/${this.id}/asset?name=${encodeURIComponent(resolved)}`);
  if (!tex) console.warn('[wallpaper-engine] 纹理槽加载失败，跳过:', path, '→', resolved);
  this.textures.set(key, tex);
  return tex;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/effect-runner.test.ts -v`
Expected: PASS（blendModeToThree 原有用例 + 新增 8 个用例）

- [ ] **Step 6: 回归相关测试**

Run: `npx vitest run tests/effect-chain.test.ts tests/shader-preprocessor.test.ts`
Expected: PASS（无回归）

- [ ] **Step 7: Commit**

```bash
git add src/client/effect-runner.ts tests/effect-runner.test.ts
git commit -m "fix(wallpaper-engine): 效果链纹理槽路径推导（materials/ 前缀）+ 内置/RT 纹理回退"
```

---

### Task 3: we-headers 补全第一部分 — common.h / common_composite.h / common_blending.h（P0-3）

**Files:**
- Modify: `src/client/shader/we-headers.ts`（COMMON_H、COMMON_COMPOSITE_H、COMMON_BLENDING_H 三个常量整体替换；WE_HEADERS map 键名不变）
- Test: `tests/shader-headers.test.ts`

**Interfaces:**
- Consumes: 无（纯常量转写；`preprocessWeShader` 的 include 展开与 `#if` 兜底注入机制已存在）
- Produces: 更新后的 `WE_HEADERS`——`common.h` 含修正后的 `M_PI_2`（6.28318530718）与 `greyscale/hsv2rgb/rgb2hsv/SQRT_2/SQRT_3`；`common_composite.h` 含 `ApplyComposite/ApplyCompositeOffset` + 3 个 g_Composite* uniform；`common_blending.h` 含宏驱动 `ApplyBlending`（31 分支）+ 全部 `Blend*` 宏与 `BlendOpacity`。Task 4 不依赖本任务的导出（同一文件顺序改）。

**适配规则（转写引擎源码时必须遵守）**：
1. `#include "common.h"`、`#include "common_blending.h"`（composite 头内部）保留——preprocess 会按 WE_HEADERS 递归展开
2. `#if HLSL`、`#ifdef HLSL_SM30`、`#if COMPOSITE != 0`、`#if COMPOSITEMONO == 1`、`#if BLENDMODE == N` 原样保留——`COMPOSITE/COMPOSITEMONO/BLENDMODE` 由 combos 注入或 `#if` 裸标识符兜底 `#define X 0`
3. `CAST2/CAST3/frac/saturate/texSample2D/mul/rotateVec2` 均已在 common.h 定义，转写内容直接引用
4. 引擎 `common.h` 的 `M_PI`（3.14159265359 截断版）用现有精确值（3.14159265358979323846）替代；`M_PI_2` **必须**用引擎值 `6.28318530718`；补 `M_PI_HALF`

- [ ] **Step 1: 写失败测试**

`tests/shader-headers.test.ts` 追加：
```ts
it('M_PI_2 为 2π（引擎真实值，修复原 π/2 错误）', () => {
  const h = WE_HEADERS['common.h'] ?? '';
  expect(h).toContain('M_PI_2 6.28318530718');
  expect(h).toContain('M_PI_HALF');
});
it('common.h 提供 greyscale/hsv2rgb/rgb2hsv（引擎真实函数）', () => {
  const h = WE_HEADERS['common.h'] ?? '';
  for (const fn of ['greyscale', 'hsv2rgb', 'rgb2hsv']) expect(h).toContain(fn);
});
it('common_composite.h 提供 ApplyComposite/ApplyCompositeOffset 与 g_Composite* uniform', () => {
  const h = WE_HEADERS['common_composite.h'] ?? '';
  for (const token of ['ApplyCompositeOffset', 'ApplyComposite', 'g_CompositeAlpha', 'g_CompositeOffset', 'g_CompositeColor']) {
    expect(h).toContain(token);
  }
  expect(h).toContain('COMPOSITEMONO == 1'); // 单色分支
});
it('common_blending.h 提供宏驱动 ApplyBlending 与 BlendOpacity/BlendLinearDodge', () => {
  const h = WE_HEADERS['common_blending.h'] ?? '';
  expect(h).toContain('ApplyBlending');
  expect(h).toContain('#if BLENDMODE == 9');   // 宏驱动（非运行时 if）
  expect(h).toContain('#if BLENDMODE == 12');  // SoftLight
  expect(h).toContain('BlendOpacity');
  expect(h).toContain('BlendLinearDodge');
  expect(h).toContain('BlendSoftLight');
  expect(h).toContain('BlendTint');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/shader-headers.test.ts -v`
Expected: FAIL（现有 common.h 无 greyscale、M_PI_2 为 1.5707、composite 为空占位、blending 无宏分支）

- [ ] **Step 3: 转写 common.h**

替换 `we-headers.ts` 中 `COMMON_H` 常量（L16-60）为：
```ts
const COMMON_H = `
#ifndef WE_COMMON_H
#define WE_COMMON_H
#define M_PI 3.14159265358979323846
#define M_PI_HALF 1.57079632679489661923
#define M_PI_2 6.28318530718
#define SQRT_2 1.41421356237309504880
#define SQRT_3 1.73205080756887729352
#define DEG2RAD 0.01745329251994329576923690768489
#define DEG2PCT 0.0027777777777777777777777777777

float frac(float x) { return fract(x); }
vec2 frac(vec2 x) { return fract(x); }
vec3 frac(vec3 x) { return fract(x); }
vec4 frac(vec4 x) { return fract(x); }

float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec2 saturate(vec2 x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
vec4 saturate(vec4 x) { return clamp(x, 0.0, 1.0); }

vec4 texSample2D(sampler2D t, vec2 uv) { return texture2D(t, uv); }
vec4 texSample2DLod(sampler2D t, vec2 uv, float lod) { return textureLod(t, uv, lod); }

vec2 rotateVec2(vec2 v, float r) {
  vec2 cs = vec2(cos(r), sin(r));
  return vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}

// —— 以下为引擎真实 common.h 转写（D:\\Steam\\steamapps\\common\\wallpaper_engine\\assets\\shaders\\common.h）——
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(frac(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

vec3 rgb2hsv(vec3 RGB) {
  vec4 P = (RGB.g < RGB.b) ? vec4(RGB.bg, -1.0, 2.0/3.0) : vec4(RGB.gb, 0.0, -1.0/3.0);
  vec4 Q = (RGB.r < P.x) ? vec4(P.xyw, RGB.r) : vec4(RGB.r, P.yzx);
  float C = Q.x - min(Q.w, Q.y);
  float H = abs((Q.w - Q.y) / (6.0 * C + 1e-10) + Q.z);
  vec3 HCV = vec3(H, C, Q.x);
  float S = HCV.y / (HCV.z + 1e-10);
  return vec3(HCV.x, S, HCV.z);
}

float greyscale(vec3 color) {
  return dot(color, vec3(0.11, 0.59, 0.3));
}
// —— 引擎转写结束 ——

// WE 行主序约定：gl_Position = mul(vec4(a_Position,1), g_ModelViewProjectionMatrix)
vec4 mul(vec4 v, mat4 m) { return m * v; }
vec3 mul(vec3 v, mat3 m) { return m * v; }

vec2 CAST2(float x) { return vec2(x); }
vec3 CAST3(float x) { return vec3(x); }
vec4 CAST4(float x) { return vec4(x); }
#endif
`;
```
注意：原 `COMMON_H` 中 L34-58 的 `texSample2DLod` 保留、`DecompressNormal` **删除**（移至 Task 4 的 common_fragment.h 真实版；唯一引用者 refract.frag 已确认 include common_fragment.h）。

- [ ] **Step 4: 转写 common_composite.h**

替换 `COMMON_COMPOSITE_H` 占位（L135）为引擎 `common_composite.h` 逐字：
```ts
const COMMON_COMPOSITE_H = `
#include "common.h"
#include "common_blending.h"

uniform float g_CompositeAlpha; // {"material":"compositealpha","label":"ui_editor_properties_alpha","default":1,"range":[0.0, 2.0]}
uniform vec2 g_CompositeOffset; // {"material":"compositeoffset","label":"ui_editor_properties_offset","default":"0 0","linked":true,"range":[-10.0, 10.0]}
uniform vec3 g_CompositeColor; // {"material":"compositecolor","label":"ui_editor_properties_color","default":"1 1 1","type":"color"}

vec2 ApplyCompositeOffset(vec2 texCoords, vec2 textureResolution)
{
#if COMPOSITE != 0
	return texCoords + g_CompositeOffset / textureResolution;
#else
	return texCoords;
#endif
}

vec4 ApplyComposite(vec4 original, vec4 effect)
{
#if COMPOSITEMONO == 1
	effect.rgb = CAST3(greyscale(effect.rgb));
#endif

	effect.rgb *= g_CompositeColor;

#if COMPOSITE == 0
	return effect;
#endif

#if COMPOSITE == 1
	effect.rgb = ApplyBlending(BLENDMODE, original.rgb, effect.rgb, effect.a * g_CompositeAlpha);
	effect.a = max(effect.a * saturate(g_CompositeAlpha), original.a);
#endif

#if COMPOSITE == 2
	effect.a *= saturate(g_CompositeAlpha);
	effect = mix(effect, original, original.a);
#endif

#if COMPOSITE == 3
	effect.a *= saturate(g_CompositeAlpha);
	effect.a *= 1.0 - original.a;
#endif

	return effect;
}
`;
```

- [ ] **Step 5: 转写 common_blending.h**

替换 `COMMON_BLENDING_H`（L96-106）为引擎 `common_blending.h` 逐字（271 行，含 `Desaturate/RGBToHSL/HSLToRGB/HueToRGB/ContrastSaturationBrightness`、全部 `Blend*` 宏、`BlendHue/BlendSaturation/BlendColor/BlendLuminosity`、宏驱动 `ApplyBlending` 31 分支）。完整内容以 `D:\Steam\steamapps\common\wallpaper_engine\assets\shaders\common_blending.h` 为准**逐字复制**，仅外层包 `#ifndef WE_COMMON_BLENDING_H / #define ... / #endif` guard。复制时确认包含（已有断言）：`#if BLENDMODE == 9`、`#if BLENDMODE == 12`、`BlendOpacity` 宏定义、`BlendLinearDodge` 宏定义、`BlendSoftLight`、`BlendTint`。

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/shader-headers.test.ts -v`
Expected: PASS（原有 4 用例 + 新增 4 用例）

- [ ] **Step 7: 编译检查（确认转写无 GLSL 语法级 TS 错误）**

Run: `npx tsc --noEmit`
Expected: PASS（无类型错误；GLSL 内容在字符串内不参与 tsc）

- [ ] **Step 8: Commit**

```bash
git add src/client/shader/we-headers.ts tests/shader-headers.test.ts
git commit -m "fix(wallpaper-engine): we-headers 按引擎真实实现补全（M_PI_2 修正/ApplyComposite/greyscale/宏驱动 ApplyBlending/BlendOpacity）"
```

---

### Task 4: we-headers 补全第二部分 — common_blur.h / common_perspective.h / common_fragment.h / common_vertex.h（P0-3 续）

**Files:**
- Modify: `src/client/shader/we-headers.ts`（COMMON_BLUR_H、COMMON_PERSPECTIVE_H、COMMON_FRAGMENT_H、COMMON_VERTEX_H 四个常量替换）
- Test: `tests/shader-headers.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `COMMON_H`（`frac/saturate/texSample2D/CAST2/CAST3` 等）
- Produces: 真实语义的 `blur13a/blur7a/blur3a`（引擎权重）、`squareToQuad`（列主序 + p2/p3 交换）、`DecompressNormal`（DXT/RG88/wy 通道版）与 `FORMAT_*` 宏、`BuildTangentSpace`。Task 5 验证时全库编译失败数应显著下降（blur 链/refract 视觉正确）。

**适配规则**：`common_fragment.h` 中 `#if TEX1FORMAT >= FORMAT_ETC1_RGB8 ...` 等 `TEX0FORMAT/TEX1FORMAT` 宏由 `#if` 裸标识符兜底注入 0（走默认 wy 通道分支，GLSL3 合法）；`#ifdef HLSL_SM30` 分支不生效。

- [ ] **Step 1: 写失败测试**

`tests/shader-headers.test.ts` 追加：
```ts
it('common_blur.h 使用引擎真实权重（13-tap）', () => {
  const h = WE_HEADERS['common_blur.h'] ?? '';
  expect(h).toContain('0.1976406528809576');  // 引擎 blur13a 中心权重
  expect(h).toContain('1.4091998770852122');  // 引擎偏移系数
  expect(h).toContain('blur7a');
});
it('common_perspective.h squareToQuad 为引擎列主序实现（含 diffy2/det 分支）', () => {
  const h = WE_HEADERS['common_perspective.h'] ?? '';
  expect(h).toContain('diffy2');
  expect(h).toContain('det == 0.0');
});
it('common_fragment.h 提供真实 DecompressNormal（RG88/DXT swizzle 分支）与 FORMAT 宏', () => {
  const h = WE_HEADERS['common_fragment.h'] ?? '';
  expect(h).toContain('FORMAT_RG88');
  expect(h).toContain('FORMAT_DXT1');
  expect(h).toContain('DecompressNormalWithMask');
  expect(h).toContain('normal.wy * 2.0 - 1.0'); // 默认通道分支
});
it('common_vertex.h 提供 BuildTangentSpace', () => {
  expect(WE_HEADERS['common_vertex.h'] ?? '').toContain('BuildTangentSpace');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/shader-headers.test.ts -v`
Expected: FAIL（blur 权重不同、perspective 无 diffy2、fragment/vertex 为空占位）

- [ ] **Step 3: 转写 common_blur.h**

替换 `COMMON_BLUR_H`（L63-89）为引擎 `common_blur.h` 逐字（112 行，含 `blur13/blur7/blur3`（rgb 版）、`blur13a/blur7a/blur3a`（alpha 版）、`blurRotateVec2`、`blurRadial13a/7a/3a`），外层包 guard。完整内容以 `D:\Steam\steamapps\common\wallpaper_engine\assets\shaders\common_blur.h` 为准**逐字复制**（确认含 `0.1976406528809576` 与 `1.4091998770852122`）。

- [ ] **Step 4: 转写 common_perspective.h**

替换 `COMMON_PERSPECTIVE_H`（L111-132）为引擎 `common_perspective.h` 逐字（65 行，列主序 squareToQuad + `#if HLSL` 内的 inverse(mat3) 保留——GLSL3 下不生效），外层包 guard。**删除现有近似版实现**。

- [ ] **Step 5: 转写 common_fragment.h 与 common_vertex.h**

替换 `COMMON_FRAGMENT_H` 占位（L136）为引擎 `common_fragment.h` 逐字（132 行：`FORMAT_*` 宏、`DecompressNormal`、`DecompressNormalWithMask`、`ComputeMaterialSpecularPower/Strength`、`ComputeLight`、`ComputeLightSpecular`、`ConvertSampleR8`、`ConvertTexture0Format`、`ConvertTextureFormat`），外层包 guard。
替换 `COMMON_VERTEX_H` 占位（L137）为引擎 `common_vertex.h` 逐字（23 行：`BuildTangentSpace` 三重载），外层包 guard。

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/shader-headers.test.ts -v`
Expected: PASS（全部用例）

- [ ] **Step 7: 编译检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/client/shader/we-headers.ts tests/shader-headers.test.ts
git commit -m "fix(wallpaper-engine): we-headers 转写 blur/perspective/fragment/vertex 引擎真实实现"
```

---

### Task 5: 全量验证与安装实测

**Files:**
- Modify: 无（验证收尾）
- Test: 全量 `npx vitest run` + `npx tsc --noEmit` + `npm run build` + `npm run build:client`

**Interfaces:**
- Consumes: Task 1-4 全部产出

- [ ] **Step 1: 全量单元测试**

Run: `npx vitest run`
Expected: PASS（node + jsdom 双环境，含全库真实库验证 `tests/verify-real-library.test.ts`）

- [ ] **Step 2: 类型与构建**

Run: `npx tsc --noEmit` 然后 `npm run build` 然后 `npm run build:client`
Expected: 三者全部成功；`dist/client.js` 生成

- [ ] **Step 3: 安装新 bundle**

按 README：将 `packages/dsh-wallpaper-engine` 重新装入 `C:\Users\0009\.dsh\profiles\web`（`npm install @dsh-use/wallpaper-engine@file:...` 或复制 dist/client.js 到 profile 对应位置），重启 DSH web。

- [ ] **Step 4: headless Edge 全库实测**

Run: 启动 headless Edge（`msedge --headless=new --no-sandbox --remote-debugging-port=9222 --user-data-dir=<temp> http://127.0.0.1:3080`）后 `node research/verify-blackout.mjs`
Expected（对照 `research/scene-play-research.md` §2 基线）：
- 目标 A：所有壁纸"纹理槽加载失败"警告归零（P0-1/P0-2）
- 目标 B："效果链解析失败"警告归零（P0-4）
- 目标 C：编译失败警告显著下降（P0-3 后 vhs/clouds/blur_combine 应编译成功；记录剩余失败明细）
- 目标 D：STATIC 壁纸 2132420420/2454403969/2597392171/3765967112 转 OK（效果链生效）
- 回归：原 OK 壁纸判定不变差（diff 不显著下降、无新增 BLACK）

- [ ] **Step 5: 结果记录与收尾**

将实测结果追加到 `research/scene-play-research.md`（新节：阶段 1 修复后实测对比表），并删除不再需要的临时研究脚本（`research/scan-decompressnormal.mjs`、`research/verify-chain-fetch.mjs`、`research/verify-chain-warn.mjs`、`research/verify-fetch-reject.mjs`——根因已确认并修复，保留会陈旧）。

- [ ] **Step 6: Commit**

```bash
git add research/ docs/superpowers/
git commit -m "docs(research): 阶段 1 效果链修复后全库实测对比"
```
