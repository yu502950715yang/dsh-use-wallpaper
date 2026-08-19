# 效果链（effects）渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 dsh-wallpaper-engine 的 Three.js SceneRenderer 实现 WE 效果链渲染：util 对象的 effects（着色器后处理链）通过通用 shader 方言解释器在浏览器渲染，覆盖全库 30 种效果。

**Architecture:** 场景对象渲染到离屏 RenderTarget → 效果链在 RT 上 ping-pong 逐 pass 执行（每个 pass 是预处理后的 WE 方言 shader + 绑定后的 uniform + 纹理槽）→ 最终贴屏。WE shader 是自定义 GLSL 方言（7 个内置头文件、combo 宏、`mul`/`texSample2D` 等内置函数），由 `src/client/shader/` 下的方言层转译；音频效果喂静音频谱（全零数组）。

**Tech Stack:** TypeScript 5.6（ESM，import 带 `.js` 后缀）、three 0.170（WebGL2，ShaderMaterial 自动兼容 GLSL1 语法）、vitest 2.1（node 环境，无 WebGL——WebGL 部分靠浏览器手动验证）、现有 `tex-loader.ts` 加载 `.tex` 纹理。

**Spec:** `docs/superpowers/specs/2026-08-18-dsh-wallpaper-engine-effects-design.md`

## Global Constraints

- 依赖版本：three `^0.170.0`、typescript `^5.6.0`；**不引入新依赖**（lz4js/three 已存在）
- 测试运行命令（pnpm 有 install 检查问题，直接调 vitest）：`node node_modules/vitest/vitest.mjs run <file>`
- 类型检查：`node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
- 代码注释使用中文；ESM 导入必须带 `.js` 后缀（如 `from './we-headers.js'`）
- WebGL 不可测部分：必须写明浏览器手动验证步骤，禁止以"已写代码"代替验证
- 效果失败一律跳过（console.warn），不中断画面、不触发壁纸级回退（spec §4.4/§6）
- 方言完备性由测试把关：全库 shader 用到的 include/内置函数/常量必须被子集覆盖（spec §4.2）

## File Structure

**新增：**
- `src/client/shader/we-headers.ts` — 7 个 WE 内置头文件等价物（`common.h`、`common_blending.h`、`common_perspective.h`、`common_blur.h`、`common_composite.h`、`common_fragment.h`、`common_vertex.h`），导出 `WE_HEADERS: Record<string, string>`
- `src/client/shader/shader-preprocessor.ts` — `preprocessWeShader(source, combos)`：include 展开 + combo `#define` 注入 + uniform 标注提取
- `src/client/shader/uniform-binder.ts` — `resolveUniformBindings(annotations, constants)`：uniform 静态值解析（material 映射 / default 回退 / 音频数组）
- `src/client/shader/effect-chain.ts` — `resolveEffectChain(sceneEffect, loadFile)`：effect.json/material/shader 加载 + pass 合并，产出 `CompiledEffectPass[]`
- `src/client/effect-runner.ts` — `EffectRunner`：RT ping-pong 执行、纹理缓存、g_Time 更新、错误回退
- `tests/fixtures/effects/` — 从真实壁纸提取的效果 fixture（effect.json / material json / shader）

**修改：**
- `src/client/scene-renderer.ts` — 场景渲染到 RT、效果链执行、贴屏
- `tests/verify-real-library.test.ts` — 增加效果链解析回归断言

**测试：**
- `tests/shader-headers.test.ts`、`tests/shader-preprocessor.test.ts`、`tests/uniform-binder.test.ts`、`tests/effect-chain.test.ts`

---

### Task 1: WE 内置头文件（we-headers.ts）

**Files:**
- Create: `src/client/shader/we-headers.ts`
- Create: `tests/fixtures/effects/waterwaves-shaders.txt`（真实 shader fixture，见 Step 1）
- Test: `tests/shader-headers.test.ts`

**Interfaces:**
- Produces: `export const WE_HEADERS: Record<string, string>` — key 为 include 文件名（`'common.h'` 等 7 个），value 为 GLSL 源码

- [ ] **Step 1: 提取真实 shader fixture**

Run: `node research/dump-effects.mjs shaders/effects/waterwaves.frag shaders/effects/waterwaves.vert > tests/fixtures/effects/waterwaves-shaders.txt`
Expected: 文件包含两个真实 shader 全文（用于后续 Task 2/3 的 fixture 断言）。检查输出非空。

- [ ] **Step 2: 写方言完备性失败测试**

```ts
// tests/shader-headers.test.ts
import { describe, expect, it } from 'vitest';
import { WE_HEADERS } from '../src/client/shader/we-headers.js';

describe('WE 内置头文件（方言完备性）', () => {
  it('覆盖全库 7 个 include 文件', () => {
    const required = ['common.h', 'common_blending.h', 'common_perspective.h',
      'common_blur.h', 'common_composite.h', 'common_fragment.h', 'common_vertex.h'];
    for (const name of required) {
      expect(WE_HEADERS[name], `缺少内置头文件 ${name}`).toBeDefined();
    }
  });
  it('common.h 提供方言核心函数与常量', () => {
    const h = WE_HEADERS['common.h'] ?? '';
    for (const token of ['texSample2D', 'mul', 'rotateVec2', 'mod2', 'frac', 'saturate', 'M_PI', 'M_PI_2', 'DEG2RAD']) {
      expect(h, `common.h 缺少 ${token}`).toContain(token);
    }
  });
  it('common_blending.h 提供 ApplyBlending', () => {
    expect(WE_HEADERS['common_blending.h'] ?? '').toContain('ApplyBlending');
  });
  it('common_blur.h 提供 blur13a/blur7a/blur3a', () => {
    const h = WE_HEADERS['common_blur.h'] ?? '';
    for (const fn of ['blur13a', 'blur7a', 'blur3a']) expect(h).toContain(fn);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/shader-headers.test.ts`
Expected: FAIL（`WE_HEADERS` 未定义 / 缺少头文件）

- [ ] **Step 4: 实现 we-headers.ts**

```ts
// src/client/shader/we-headers.ts
// WE 内置 GLSL 头文件等价物（全库扫描确认的 7 个 include）。
// 方言事实：texSample2D×89、mul×66、rotateVec2×20、squareToQuad×6、inverse×6、
// texSample2DLod×3、mod2×2、frac/saturate（Simple_Audio_Bars）、M_PI/M_PI_2/DEG2RAD 常量。
// three r170 WebGL2 会自动把 texture2D/texture2DLod 映射为 texture/textureLod，
// 因此这里只补 WE 方言函数与常量，不重写标准采样调用。

const COMMON_H = `
#ifndef WE_COMMON_H
#define WE_COMMON_H
#define M_PI 3.14159265358979323846
#define M_PI_2 1.57079632679489661923
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

float mod2(float x, float y) { return x - y * floor(x / y); }

vec4 texSample2D(sampler2D t, vec2 uv) { return texture2D(t, uv); }
vec4 texSample2DLod(sampler2D t, vec2 uv, float lod) { return texture2DLod(t, uv, lod); }

vec2 rotateVec2(vec2 v, float angle) {
  float c = cos(angle), s = sin(angle);
  return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}

// WE 行主序约定：gl_Position = mul(vec4(a_Position,1), g_ModelViewProjectionMatrix)
vec4 mul(vec4 v, mat4 m) { return m * v; }
vec3 mul(vec3 v, mat3 m) { return m * v; }
#endif
`;

// 高斯模糊辅助（common_blur.h）：13/7/3 tap，方向与步长由调用方经 v_TexCoord.zw 传入
const COMMON_BLUR_H = `
#ifndef WE_COMMON_BLUR_H
#define WE_COMMON_BLUR_H
vec4 blur13a(vec2 uv, vec2 dir) {
  vec4 c = texSample2D(g_Texture0, uv) * 0.2270270270;
  c += texSample2D(g_Texture0, uv + dir * 1.3846153846) * 0.3162162162;
  c += texSample2D(g_Texture0, uv - dir * 1.3846153846) * 0.3162162162;
  c += texSample2D(g_Texture0, uv + dir * 3.2307692308) * 0.0702702703;
  c += texSample2D(g_Texture0, uv - dir * 3.2307692308) * 0.0702702703;
  return c;
}
vec4 blur7a(vec2 uv, vec2 dir) {
  vec4 c = texSample2D(g_Texture0, uv) * 0.375;
  c += texSample2D(g_Texture0, uv + dir) * 0.25;
  c += texSample2D(g_Texture0, uv - dir) * 0.25;
  c += texSample2D(g_Texture0, uv + dir * 2.0) * 0.0625;
  c += texSample2D(g_Texture0, uv - dir * 2.0) * 0.0625;
  return c;
}
vec4 blur3a(vec2 uv, vec2 dir) {
  vec4 c = texSample2D(g_Texture0, uv) * 0.5;
  c += texSample2D(g_Texture0, uv + dir) * 0.25;
  c += texSample2D(g_Texture0, uv - dir) * 0.25;
  return c;
}
#endif
`;

// 图像混合（common_blending.h）：ApplyBlending(mode, src, dst, alpha)
// BLENDMODE 取值（全库实测）：0=normal、9=add、12=multiply、30/31 为高级模式
// （浏览器验证期按实际画面补充 30/31 语义；缺省回退 normal）
const COMMON_BLENDING_H = `
#ifndef WE_COMMON_BLENDING_H
#define WE_COMMON_BLENDING_H
vec4 ApplyBlending(int mode, vec3 src, vec3 dst, float alpha) {
  if (mode == 9) return vec4(dst + src * alpha, 1.0);
  if (mode == 12) return vec4(dst * mix(vec3(1.0), src, alpha), 1.0);
  if (mode == 30 || mode == 31) return vec4(mix(dst, src, alpha), 1.0); // 待浏览器验证细化
  return vec4(mix(dst, src, alpha), 1.0); // 0=normal 及未知模式
}
#endif
`;

// 透视辅助（common_perspective.h）：squareToQuad / inverse（3x3）
const COMMON_PERSPECTIVE_H = `
#ifndef WE_COMMON_PERSPECTIVE_H
#define WE_COMMON_PERSPECTIVE_H
mat3 squareToQuad(vec2 p0, vec2 p1, vec2 p2, vec2 p3) {
  vec2 d1 = p1 - p2, d2 = p3 - p2, d3 = p0 - p1 + p2 - p3;
  float a = 0.0, b = 0.0;
  if (d3.x != 0.0 || d3.y != 0.0) {
    float cross = d1.x * d2.y - d1.y * d2.x;
    if (cross != 0.0) {
      a = (d2.x * d3.y - d2.y * d3.x) / cross;
      b = (d1.x * d3.y - d1.y * d3.x) / cross;
    }
  }
  mat3 m = mat3(
    p1.x - p0.x + a * p1.x, p1.y - p0.y + a * p1.y, a,
    p3.x - p0.x + b * p3.x, p3.y - p0.y + b * p3.y, b,
    p0.x, p0.y, 1.0
  );
  return m;
}
mat3 inverse(mat3 m) {
  float d = m[0][0] * (m[1][1] * m[2][2] - m[2][1] * m[1][2])
          - m[1][0] * (m[0][1] * m[2][2] - m[2][1] * m[0][2])
          + m[2][0] * (m[0][1] * m[1][2] - m[1][1] * m[0][2]);
  if (abs(d) < 1e-9) return mat3(1.0);
  float inv = 1.0 / d;
  return mat3(
    (m[1][1] * m[2][2] - m[2][1] * m[1][2]) * inv,
    (m[2][1] * m[0][2] - m[0][1] * m[2][2]) * inv,
    (m[0][1] * m[1][2] - m[1][1] * m[0][2]) * inv,
    (m[2][0] * m[1][2] - m[1][0] * m[2][2]) * inv,
    (m[0][0] * m[2][2] - m[2][0] * m[0][2]) * inv,
    (m[1][0] * m[0][2] - m[0][0] * m[1][2]) * inv,
    (m[1][0] * m[2][1] - m[2][0] * m[1][1]) * inv,
    (m[2][0] * m[0][1] - m[0][0] * m[2][1]) * inv,
    (m[0][0] * m[1][1] - m[1][0] * m[0][1]) * inv
  );
}
#endif
`;

// 占位头（当前全库未观察到独立函数，保留空定义避免 include 失败）
const COMMON_COMPOSITE_H = `#ifndef WE_COMMON_COMPOSITE_H\n#define WE_COMMON_COMPOSITE_H\n#endif\n`;
const COMMON_FRAGMENT_H = `#ifndef WE_COMMON_FRAGMENT_H\n#define WE_COMMON_FRAGMENT_H\n#endif\n`;
const COMMON_VERTEX_H = `#ifndef WE_COMMON_VERTEX_H\n#define WE_COMMON_VERTEX_H\n#endif\n`;

export const WE_HEADERS: Record<string, string> = {
  'common.h': COMMON_H,
  'common_blending.h': COMMON_BLENDING_H,
  'common_perspective.h': COMMON_PERSPECTIVE_H,
  'common_blur.h': COMMON_BLUR_H,
  'common_composite.h': COMMON_COMPOSITE_H,
  'common_fragment.h': COMMON_FRAGMENT_H,
  'common_vertex.h': COMMON_VERTEX_H,
};
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/shader-headers.test.ts`
Expected: PASS（7 个头文件 + 核心函数断言）

- [ ] **Step 6: 提交**

```bash
git add src/client/shader/we-headers.ts tests/shader-headers.test.ts tests/fixtures/effects/waterwaves-shaders.txt
git commit -m "feat(wallpaper-engine): WE 内置 GLSL 头文件等价物（方言函数/常量/混合/模糊/透视）"
```

---

### Task 2: Shader 预处理器（shader-preprocessor.ts）

**Files:**
- Create: `src/client/shader/shader-preprocessor.ts`
- Test: `tests/shader-preprocessor.test.ts`

**Interfaces:**
- Consumes: `WE_HEADERS` from `we-headers.js`
- Produces:
  - `export interface UniformAnnotation { name: string; type: string; annotation?: Record<string, unknown> }`
  - `export function extractUniformAnnotations(source: string): UniformAnnotation[]` — 解析 `uniform <type> <name>; // {...}` 与数组 uniform `uniform float g_AudioSpectrum16Left[16];`
  - `export function preprocessWeShader(source: string, combos: Record<string, number>): string` — include 展开（仅内置头，`WE_HEADERS` 缺失的 include 原样保留）+ 顶部注入 `#define <combo> <value>`

- [ ] **Step 1: 写失败测试**

```ts
// tests/shader-preprocessor.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { preprocessWeShader, extractUniformAnnotations } from '../src/client/shader/shader-preprocessor.js';
import { WE_HEADERS } from '../src/client/shader/we-headers.js';

const waterwavesFrag = (() => {
  // 从 dump-effects 输出中提取 shader 段（Ruling 2：正则提取，避免残留 dump 头部行）
  const txt = readFileSync(new URL('./fixtures/effects/waterwaves-shaders.txt', import.meta.url), 'utf8');
  const m = txt.match(/========== shaders\/effects\/waterwaves\.frag \(\d+B\) ==========\n([\s\S]*?)(?:\n==========|$)/);
  if (!m) throw new Error('fixture 缺少 waterwaves.frag 段');
  return m[1];
})();

describe('extractUniformAnnotations', () => {
  it('解析带标注 uniform（material 映射）', () => {
    const src = 'uniform float g_Speed; // {"material":"speed","default":5}\nuniform sampler2D g_Texture0; // {"hidden":true}';
    const anns = extractUniformAnnotations(src);
    expect(anns[0]).toEqual({ name: 'g_Speed', type: 'float', annotation: { material: 'speed', default: 5 } });
    expect(anns[1].type).toBe('sampler2D');
  });
  it('解析数组 uniform（音频频谱）', () => {
    const anns = extractUniformAnnotations('uniform float g_AudioSpectrum16Left[16];');
    expect(anns[0].type).toBe('float[16]');
  });
});

describe('preprocessWeShader', () => {
  it('展开内置 include 并注入 combo 宏', () => {
    const src = '#include "common.h"\nvoid main() { float x = M_PI; }';
    const out = preprocessWeShader(src, { MASK: 1, PERSPECTIVE: 0 });
    expect(out).toContain('#define MASK 1');
    expect(out).toContain('#define PERSPECTIVE 0');
    expect(out).toContain('#define M_PI 3.14159'); // include 已展开
    expect(out).not.toContain('#include "common.h"');
  });
  it('保留真实 waterwaves.frag 全部 include 展开且无残留', () => {
    const out = preprocessWeShader(waterwavesFrag, { MASK: 1, PERSPECTIVE: 0, TIMEOFFSET: 0 });
    for (const name of ['common.h', 'common_perspective.h']) {
      expect(out).not.toContain(`#include "${name}"`);
      expect(out).toContain(WE_HEADERS[name].slice(0, 20)); // 头文件内容已展开
    }
  });
  it('未定义组合宏不注入（#if 未定义宏按 0 处理）', () => {
    const out = preprocessWeShader('void main() {}', {});
    expect(out).not.toContain('#define MASK');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/shader-preprocessor.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/client/shader/shader-preprocessor.ts
// WE shader 方言预处理：内置头 include 展开 + combo 宏注入 + 属性名改写 + uniform 标注提取。
import { WE_HEADERS } from './we-headers.js';

export interface UniformAnnotation {
  name: string;
  type: string;
  annotation?: Record<string, unknown>;
}

// uniform 声明正则：支持 sampler2D / float / vec2..4 / float[N] 数组
const UNIFORM_RE = /uniform\s+([\w]+(?:\[\d+\])?)\s+(\w+)\s*;\s*(?:\/\/\s*(\{[\s\S]*?\}))?/g;

export function extractUniformAnnotations(source: string): UniformAnnotation[] {
  const out: UniformAnnotation[] = [];
  for (const m of source.matchAll(UNIFORM_RE)) {
    let annotation: Record<string, unknown> | undefined;
    if (m[3]) {
      try { annotation = JSON.parse(m[3]); } catch { annotation = undefined; }
    }
    out.push({ name: m[2], type: m[1], annotation });
  }
  return out;
}

// 属性名改写：WE 方言 attribute 名 → three.js 几何体属性名
// （three 的 BufferGeometry 提供 position/uv，ShaderMaterial 按名字绑定；
//  PlaneGeometry(2,2) 的 position 范围 [-1,1] 正好铺满 NDC 全屏 quad）
function rewriteAttributes(src: string): string {
  return src.split('a_Position').join('position').split('a_TexCoord').join('uv');
}

export function preprocessWeShader(source: string, combos: Record<string, number>): string {
  let out = source;
  // 展开内置头 include（仅处理 WE_HEADERS 已知的头；未知 include 保留原样）
  for (const [name, header] of Object.entries(WE_HEADERS)) {
    out = out.split(`#include "${name}"`).join(header);
  }
  out = rewriteAttributes(out);
  // 注入 combo 宏（仅 scene.json 提供的值；未提供的宏在 #if 中自然为 0）
  const defines = Object.entries(combos)
    .map(([k, v]) => `#define ${k} ${v}`)
    .join('\n');
  return defines ? `${defines}\n${out}` : out;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/shader-preprocessor.test.ts`
Expected: PASS

- [ ] **Step 5: 补充属性名改写断言并重跑**

在 `preprocessWeShader` 描述块追加测试：

```ts
it('改写 WE attribute 名为 three 属性名（a_Position→position, a_TexCoord→uv）', () => {
  const src = 'attribute vec3 a_Position; attribute vec2 a_TexCoord; varying vec4 v_TexCoord; void main() { v_TexCoord = a_TexCoord.xyxy; gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix); }';
  const out = preprocessWeShader(src, {});
  expect(out).toContain('attribute vec3 position;');
  expect(out).toContain('attribute vec2 uv;');
  expect(out).not.toContain('a_Position');
  expect(out).not.toContain('a_TexCoord');
});
```

Run: `node node_modules/vitest/vitest.mjs run tests/shader-preprocessor.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/client/shader/shader-preprocessor.ts tests/shader-preprocessor.test.ts
git commit -m "feat(wallpaper-engine): WE shader 预处理器（include 展开 / combo 注入 / 属性名改写 / uniform 标注提取）"
```

---

### Task 3: Uniform 绑定器（uniform-binder.ts）

**Files:**
- Create: `src/client/shader/uniform-binder.ts`
- Test: `tests/uniform-binder.test.ts`

**Interfaces:**
- Consumes: `UniformAnnotation` from `shader-preprocessor.js`
- Produces:
  - `export type UniformValue = number | number[]`
  - `export function resolveUniformBindings(annotations: UniformAnnotation[], constants: Record<string, unknown>): Map<string, UniformValue>`
    - 绑定规则（spec §4.3）：`annotation.material` → `constants[material]`（值可为 `{user, value}` 包装，取 `value`）；缺失 → `annotation.default`；再缺失 → 0；数组类型（`float[N]`，音频频谱 `g_AudioSpectrum*`）→ 全零数组 `new Array(N).fill(0)`；`vec*` 字符串按空白切分转 number[]
  - `export function isAudioUniform(name: string): boolean` — `name.startsWith('g_AudioSpectrum')`

- [ ] **Step 1: 写失败测试**

```ts
// tests/uniform-binder.test.ts
import { describe, expect, it } from 'vitest';
import { resolveUniformBindings, isAudioUniform } from '../src/client/shader/uniform-binder.js';

describe('resolveUniformBindings', () => {
  const anns = [
    { name: 'g_Speed', type: 'float', annotation: { material: 'speed', default: 5 } },
    { name: 'g_Strength', type: 'float', annotation: { material: 'strength' } },
    { name: 'g_Direction', type: 'float', annotation: { default: 0, direction: true } },
    { name: 'g_Color', type: 'vec3', annotation: { material: 'color' } },
    { name: 'g_Unset', type: 'float', annotation: {} },
    { name: 'g_AudioSpectrum16Left', type: 'float[16]', annotation: {} },
  ];
  it('material 映射优先，{user,value} 解包，default 回退，缺失为 0', () => {
    const m = resolveUniformBindings(anns, {
      speed: 2.5,
      strength: { user: 'x', value: 0.75 },
      color: '1.0 0.5 0.0',
    });
    expect(m.get('g_Speed')).toBe(2.5);
    expect(m.get('g_Strength')).toBe(0.75);
    expect(m.get('g_Direction')).toBe(0);
    expect(m.get('g_Color')).toEqual([1.0, 0.5, 0.0]);
    expect(m.get('g_Unset')).toBe(0);
  });
  it('音频频谱 uniform 返回对应长度全零数组', () => {
    const m = resolveUniformBindings(anns, {});
    expect(isAudioUniform('g_AudioSpectrum16Left')).toBe(true);
    expect(isAudioUniform('g_Speed')).toBe(false);
    expect(m.get('g_AudioSpectrum16Left')).toEqual(new Array(16).fill(0));
  });
  it('default 为字符串时也解析为数值', () => {
    const m = resolveUniformBindings(
      [{ name: 'g_Scale', type: 'vec2', annotation: { default: '1 1' } }],
      {},
    );
    expect(m.get('g_Scale')).toEqual([1, 1]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/uniform-binder.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/client/shader/uniform-binder.ts
// uniform 静态值绑定：material 参数映射 → constantshadervalues；default 回退；音频数组置零。
import type { UniformAnnotation } from './shader-preprocessor.js';

export type UniformValue = number | number[];

export function isAudioUniform(name: string): boolean {
  return name.startsWith('g_AudioSpectrum');
}

function parseValue(raw: unknown): number | number[] | null {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (typeof raw === 'string') {
    const parts = raw.trim().split(/\s+/).map(Number);
    if (parts.some((n) => !isFinite(n))) return null;
    return parts.length === 1 ? parts[0] : parts;
  }
  if (Array.isArray(raw)) {
    const nums = raw.map(Number);
    if (nums.some((n) => !isFinite(n))) return null;
    return nums.length === 1 ? nums[0] : nums;
  }
  return null;
}

export function resolveUniformBindings(
  annotations: UniformAnnotation[],
  constants: Record<string, unknown>,
): Map<string, UniformValue> {
  const out = new Map<string, UniformValue>();
  for (const u of annotations) {
    // 纹理 uniform（sampler*）由执行器按纹理槽运行时绑定，这里跳过
    if (u.type.startsWith('sampler')) continue;
    // 音频频谱数组 → 全零（静音；spec §4.3）
    const arrMatch = u.type.match(/^float\[(\d+)\]$/);
    if (isAudioUniform(u.name) && arrMatch) {
      out.set(u.name, new Array(Number(arrMatch[1])).fill(0));
      continue;
    }
    let raw: unknown;
    const mat = u.annotation?.material;
    if (typeof mat === 'string') {
      const v = constants[mat];
      // WE 参数可能带 {user, value} 包装（值在 value 字段）
      raw = v && typeof v === 'object' && !Array.isArray(v) && 'value' in (v as object)
        ? (v as { value: unknown }).value
        : v;
    }
    if (raw === undefined && u.annotation?.default !== undefined) raw = u.annotation.default;
    const parsed = parseValue(raw);
    out.set(u.name, parsed ?? 0);
  }
  return out;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/uniform-binder.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/shader/uniform-binder.ts tests/uniform-binder.test.ts
git commit -m "feat(wallpaper-engine): uniform 绑定器（material 映射/default 回退/静音音频数组）"
```

---

### Task 4: 效果链解析（effect-chain.ts）+ 全库回归

**Files:**
- Create: `src/client/shader/effect-chain.ts`
- Modify: `tests/verify-real-library.test.ts`（追加效果链解析断言）
- Test: `tests/effect-chain.test.ts`

**Interfaces:**
- Consumes: `preprocessWeShader`、`extractUniformAnnotations`（Task 2）、`resolveUniformBindings`（Task 3）
- Produces:
  - `export interface CompiledEffectPass { vertSrc: string; fragSrc: string; uniforms: Map<string, UniformValue>; textureSlots: (string | null)[]; blendMode: string }`
  - `export async function resolveEffectChain(sceneEffect: { file: string; passes?: unknown[] }, loadFile: (name: string) => Promise<Uint8Array | null>): Promise<CompiledEffectPass[] | null>`
    - 流程（spec §5）：loadFile(effect.file) → effect.json `passes[i].material` → loadFile(material) → `passes[0].shader`（相对 `shaders/`）→ loadFile(vert/frag)；按索引合并 scene.json 覆写（`combos`/`constantshadervalues`/`textures`，缺省 `{}`/`[]`）；预处理器 + 绑定器产出 pass；`textures` 数组元素 `null` 保留，`textures[i]` → `textureSlots[i]`；任一环节失败返回 `null`
    - shader 路径拼法：material json 的 `passes[0].shader` 如 `"effects/waterwaves"` → `shaders/effects/waterwaves.vert` / `.frag`

- [ ] **Step 1: 写失败测试**

```ts
// tests/effect-chain.test.ts
import { describe, expect, it } from 'vitest';
import { resolveEffectChain } from '../src/client/shader/effect-chain.js';

const encoder = new TextEncoder();
// 最小真实结构 fixture（对应 2911105183 的 waterwaves 链）
const files = new Map<string, Uint8Array>([
  ['effects/waterwaves/effect.json', encoder.encode(JSON.stringify({
    version: 1,
    passes: [{ material: 'materials/effects/waterwaves.json' }],
    dependencies: ['materials/effects/waterwaves.json', 'shaders/effects/waterwaves.frag', 'shaders/effects/waterwaves.vert'],
  }))],
  ['materials/effects/waterwaves.json', encoder.encode(JSON.stringify({
    passes: [{ shader: 'effects/waterwaves', blending: 'normal', depthtest: 'disabled', depthwrite: 'disabled', cullmode: 'nocull' }],
  }))],
  ['shaders/effects/waterwaves.vert', encoder.encode('uniform mat4 g_ModelViewProjectionMatrix;\nvoid main() { gl_Position = mul(vec4(a_Position,1.0), g_ModelViewProjectionMatrix); }')],
  ['shaders/effects/waterwaves.frag', encoder.encode('#include "common.h"\nuniform float g_Speed; // {"material":"speed","default":5}\nvoid main() { gl_FragColor = vec4(g_Speed); }')],
]);
const loadFile = async (name: string) => files.get(name) ?? null;

describe('resolveEffectChain', () => {
  it('合并 scene.json 覆写并产出编译 pass', async () => {
    const chain = await resolveEffectChain({
      file: 'effects/waterwaves/effect.json',
      passes: [{
        id: 245,
        combos: { MASK: 1 },
        constantshadervalues: { speed: 2.5, strength: 0.5 },
        textures: [null, 'masks/waterwaves_mask_e0eafd2b'],
      }],
    }, loadFile);
    expect(chain).not.toBeNull();
    const pass = chain![0];
    expect(pass.blendMode).toBe('normal');
    expect(pass.vertSrc).toContain('g_ModelViewProjectionMatrix');
    expect(pass.fragSrc).toContain('#define MASK 1');      // combo 注入
    expect(pass.fragSrc).toContain('float frac');          // common.h 展开
    expect(pass.uniforms.get('g_Speed')).toBe(2.5);        // constantshadervalues 映射
    expect(pass.textureSlots).toEqual([null, 'masks/waterwaves_mask_e0eafd2b']);
  });
  it('无覆写时使用 default 值、textures 为空数组', async () => {
    const chain = await resolveEffectChain({ file: 'effects/waterwaves/effect.json' }, loadFile);
    const pass = chain![0];
    expect(pass.uniforms.get('g_Speed')).toBe(5);          // annotation.default
    expect(pass.textureSlots).toEqual([]);
  });
  it('effect 文件缺失返回 null', async () => {
    expect(await resolveEffectChain({ file: 'effects/missing/effect.json' }, loadFile)).toBeNull();
  });
  it('material 缺失返回 null', async () => {
    const chain = await resolveEffectChain({ file: 'effects/waterwaves/effect.json', passes: [{ material: 'x.json' }] }, loadFile);
    expect(chain).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/effect-chain.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/client/shader/effect-chain.ts
// 效果链解析：effect.json → material → shader，合并 scene.json 覆写，产出可执行 pass。
import { preprocessWeShader, extractUniformAnnotations } from './shader-preprocessor.js';
import { resolveUniformBindings, type UniformValue } from './uniform-binder.js';

export interface CompiledEffectPass {
  vertSrc: string;
  fragSrc: string;
  uniforms: Map<string, UniformValue>;   // 静态值（g_Time 由执行器运行时更新）
  textureSlots: (string | null)[];       // textures[i] → g_Texture(i+1)
  blendMode: string;                     // material json 的 blending（normal/add/...）
}

interface SceneEffectPass { combos?: Record<string, number>; constantshadervalues?: Record<string, unknown>; textures?: (string | null)[] }

export async function resolveEffectChain(
  sceneEffect: { file: string; passes?: unknown[] },
  loadFile: (name: string) => Promise<Uint8Array | null>,
): Promise<CompiledEffectPass[] | null> {
  try {
    const effectRaw = await loadFile(sceneEffect.file);
    if (!effectRaw) return null;
    const effect = JSON.parse(new TextDecoder().decode(effectRaw)) as { passes?: { material?: string }[] };
    const scenePasses = Array.isArray(sceneEffect.passes) ? sceneEffect.passes as SceneEffectPass[] : [];
    if (!Array.isArray(effect.passes) || effect.passes.length === 0) return null;

    const out: CompiledEffectPass[] = [];
    for (let i = 0; i < effect.passes.length; i++) {
      const matRef = effect.passes[i].material;
      if (typeof matRef !== 'string') return null;
      const matRaw = await loadFile(matRef);
      if (!matRaw) return null;
      const mat = JSON.parse(new TextDecoder().decode(matRaw)) as { passes?: { shader?: string; blending?: string }[] };
      const shaderName = mat.passes?.[0]?.shader;
      if (typeof shaderName !== 'string') return null;
      const vertRaw = await loadFile(`shaders/${shaderName}.vert`);
      const fragRaw = await loadFile(`shaders/${shaderName}.frag`);
      if (!vertRaw || !fragRaw) return null;

      const override = scenePasses[i] ?? {};
      const combos = override.combos ?? {};
      const constants = override.constantshadervalues ?? {};
      const textures = Array.isArray(override.textures) ? override.textures : [];

      const vertSrc = preprocessWeShader(new TextDecoder().decode(vertRaw), combos);
      const fragSrc = preprocessWeShader(new TextDecoder().decode(fragRaw), combos);
      const uniforms = resolveUniformBindings(
        extractUniformAnnotations(fragSrc).concat(extractUniformAnnotations(vertSrc)),
        constants,
      );
      out.push({
        vertSrc,
        fragSrc,
        uniforms,
        textureSlots: textures,
        blendMode: mat.passes?.[0]?.blending ?? 'normal',
      });
    }
    return out;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/effect-chain.test.ts`
Expected: PASS

- [ ] **Step 5: 扩展全库回归（verify-real-library.test.ts）**

（Ruling 1：现有 `it('scene 读取链路零失败…', () => {` 回调是**同步**的，须改为 `async () => {`；效果链解析断言在其内部、`expect(evidence).toEqual([])` 之前 await。）

在现有测试的 `for (const obj of desc.objects)` 循环内、`kind === 'util'` 分支处追加（util 对象现被跳过，需改为收集 effects 并断言可解析）：

```ts
const utilEffects: { file: string; passes?: unknown[] }[] = [];
// 原循环内：kind === 'util' 时（不再跳过，收集）
if (obj.kind === 'util') {
  if (Array.isArray(obj.effects)) {
    for (const fx of obj.effects) if (typeof fx?.file === 'string') utilEffects.push({ file: fx.file, passes: fx.passes });
  }
}
// 循环后追加（注意：utilEffects 需在 for 循环外声明；循环结束后逐条解析）：
for (const fx of utilEffects) {
  const chain = await resolveEffectChain(fx, async (name) => files.get(name) ?? null);
  if (!chain) evidence.push(`[${id}] ${magic} 效果链解析失败: ${fx.file}`);
}
```

同时：`it` 回调签名改为 `async () => {`（当前为同步）；`import { resolveEffectChain } from '../src/client/shader/effect-chain.js';` 加到文件顶部。`utilEffects` 数组声明在 `for (const id of dirs)` 循环内、`for (const obj ...)` 之前。

- [ ] **Step 6: 运行全库回归确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/verify-real-library.test.ts`
Expected: PASS，控制台汇总行 `无失败证据 ✓`（24 个 util 效果链全部可解析；若某效果链解析失败会出现在证据列表——按 Task 1 头文件/预处理覆盖补齐，或确认是真实数据问题）

- [ ] **Step 7: 提交**

```bash
git add src/client/shader/effect-chain.ts tests/effect-chain.test.ts tests/verify-real-library.test.ts
git commit -m "feat(wallpaper-engine): 效果链解析（pass 合并/编译）+ 全库效果链回归断言"
```

---

### Task 5: 效果执行器（EffectRunner）

**Files:**
- Create: `src/client/effect-runner.ts`
- Test: `tests/effect-runner.test.ts`（可测的纯逻辑部分）

**Interfaces:**
- Consumes: `CompiledEffectPass`（Task 4）、`loadTexTexture`（现有 `tex-loader.js`）
- Produces:
  - `export class EffectRunner`
    - `constructor(renderer: THREE.WebGLRenderer, width: number, height: number)`
    - `setChains(chains: CompiledEffectPass[][], wallpaperId: string): void` — 替换当前效果链（纹理槽 URL 按壁纸 id 拼 `/wallpapers/scene/:id/asset`）
    - `async update(time: number, input: THREE.WebGLRenderTarget): Promise<THREE.WebGLRenderTarget>` — 依序执行所有链（链内逐 pass ping-pong），返回最终 RT（无链时返回 input）；内部记录 `last`
    - `lastOutput(): THREE.Texture | null` — 最近一次 update 完成后的最终纹理（未完成返回 null，调用方回退场景 RT），供帧循环贴屏
    - `dispose(): void`
  - `export function blendModeToThree(mode: string): THREE.Blending` — WE blending 枚举 → three 混合（normal/add/multiply/subtract，未知回退 Normal）

**纯逻辑可测部分**：RT 交替顺序计算 `nextTargetIndex(chainPassCounts, passIndex)`（不依赖 WebGL，导出为纯函数供测试）。

- [ ] **Step 1: 写失败测试（纯逻辑）**

```ts
// tests/effect-runner.test.ts
import { describe, expect, it } from 'vitest';
import { rtAlternation } from '../src/client/effect-runner.js';

describe('rtAlternation（ping-pong RT 交替）', () => {
  it('单链两 pass：输入 rtA → pass0 写 rtB → pass1 写 rtA（返回 rtA）', () => {
    const plan = rtAlternation([2]);
    expect(plan).toEqual([
      { passIndex: 0, writeTo: 'B' },
      { passIndex: 1, writeTo: 'A' },
    ]);
  });
  it('双链各 1 pass：链0 写 B，链1 读 B 写 A', () => {
    const plan = rtAlternation([1, 1]);
    expect(plan).toEqual([
      { passIndex: 0, writeTo: 'B' },
      { passIndex: 1, writeTo: 'A' },
    ]);
  });
  it('pass 数为 0 的链跳过（扁平索引从 0 起）', () => {
    expect(rtAlternation([0, 2])).toEqual([
      { passIndex: 0, writeTo: 'B' },
      { passIndex: 1, writeTo: 'A' },
    ]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/effect-runner.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 rtAlternation + EffectRunner**

```ts
// src/client/effect-runner.ts
// 效果链执行器：逐链逐 pass 在 ping-pong RT 上执行 WE 后处理 shader。
// WebGL 部分无法在 node 测试，纯逻辑（RT 交替计划）导出为 rtAlternation 供单测。
import * as THREE from 'three';
import type { CompiledEffectPass } from './shader/effect-chain.js';
import { loadTexTexture } from './tex-loader.js';

export interface RtStep { passIndex: number; writeTo: 'A' | 'B' }

// 按链长度展开为 RT 交替计划：当前读端 A（输入），pass 写 B，下一 pass 读 B 写 A……
// 链之间的承接：上一链最终输出作为下一链输入（读端切换由执行器记录）。
export function rtAlternation(chainPassCounts: number[]): RtStep[] {
  const steps: RtStep[] = [];
  let acc = 0;
  for (const n of chainPassCounts) {
    for (let i = 0; i < n; i++) {
      steps.push({ passIndex: acc + i, writeTo: (acc + i) % 2 === 0 ? 'B' : 'A' });
    }
    acc += n;
  }
  return steps;
}

export class EffectRunner {
  private renderer: THREE.WebGLRenderer;
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  private chains: CompiledEffectPass[][] = [];
  private id = '';
  private last: THREE.Texture | null = null;   // 最近一次 update 的最终输出（帧循环贴屏用）
  private materials = new Map<string, THREE.ShaderMaterial>();   // key: `${chainIdx}:${passIdx}`
  private scenes = new Map<string, THREE.Scene>();               // 每 pass 独立场景（含全屏 quad）
  private textures = new Map<string, THREE.Texture | null>();    // 纹理槽缓存（key: `${id}:${path}`）
  private width: number;
  private height: number;

  constructor(renderer: THREE.WebGLRenderer, width: number, height: number) {
    this.renderer = renderer;
    this.width = width;
    this.height = height;
    this.rtA = new THREE.WebGLRenderTarget(width, height);
    this.rtB = new THREE.WebGLRenderTarget(width, height);
  }

  setChains(chains: CompiledEffectPass[][], wallpaperId: string): void {
    this.chains = chains;
    this.id = wallpaperId;
    this.disposeMaterials();
  }

  private disposeMaterials(): void {
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    this.scenes.clear();
  }

  private getMaterial(pass: CompiledEffectPass, key: string): THREE.ShaderMaterial | null {
    const cached = this.materials.get(key);
    if (cached) return cached;
    try {
      const uniforms: Record<string, THREE.IUniform> = {};
      for (const [name, value] of pass.uniforms) {
        uniforms[name] = { value: Array.isArray(value) ? value.slice() : value };
      }
      // 全屏 quad 在 NDC 下直接输出：模型/视图/投影矩阵取单位阵（WE 行主序 mul(v,M)=M*v）
      if (uniforms['g_ModelViewProjectionMatrix']) {
        uniforms['g_ModelViewProjectionMatrix'].value = new THREE.Matrix4();
      }
      const material = new THREE.ShaderMaterial({
        vertexShader: pass.vertSrc,
        fragmentShader: pass.fragSrc,
        uniforms,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: blendModeToThree(pass.blendMode),
      });
      this.materials.set(key, material);
      return material;
    } catch (e) {
      console.warn('[wallpaper-engine] 效果 pass 编译失败，跳过:', key, e);
      return null;
    }
  }

  private getScene(key: string, material: THREE.ShaderMaterial): THREE.Scene {
    const cached = this.scenes.get(key);
    if (cached) return cached;
    const scene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    scene.add(quad);
    this.scenes.set(key, scene);
    return scene;
  }

  private async resolveTextureSlot(path: string | null): Promise<THREE.Texture | null> {
    if (!path) return null;
    const key = `${this.id}:${path}`;
    if (this.textures.has(key)) return this.textures.get(key) ?? null;
    const tex = await loadTexTexture(`/wallpapers/scene/${this.id}/asset?name=${encodeURIComponent(path)}`);
    this.textures.set(key, tex);
    return tex;
  }

  async update(time: number, input: THREE.WebGLRenderTarget): Promise<THREE.WebGLRenderTarget> {
    const flat: CompiledEffectPass[] = this.chains.flat();
    if (flat.length === 0) return input;
    const steps = rtAlternation(this.chains.map((c) => c.length));
    const targets = { A: this.rtA, B: this.rtB } as const;
    let read = input;
    for (const step of steps) {
      const pass = flat[step.passIndex];
      const key = `${step.passIndex}`;
      const material = this.getMaterial(pass, key);
      if (!material) continue; // 编译失败 → 跳过该 pass（画面保持上一状态）
      // 纹理槽：textures[i] → g_Texture(i+1)；g_Texture0 由执行器设为读端
      for (let i = 0; i < pass.textureSlots.length; i++) {
        const tex = await this.resolveTextureSlot(pass.textureSlots[i]);
        const slot = `g_Texture${i + 1}`;
        if (material.uniforms[slot]) material.uniforms[slot].value = tex;
        const res = `g_Texture${i + 1}Resolution`;
        if (material.uniforms[res]) {
          const w = (tex?.image as { width?: number } | undefined)?.width ?? this.width;
          const h = (tex?.image as { height?: number } | undefined)?.height ?? this.height;
          material.uniforms[res].value = new THREE.Vector4(w, h, 1 / Math.max(1, w), 1 / Math.max(1, h));
        }
      }
      if (material.uniforms['g_Texture0']) material.uniforms['g_Texture0'].value = read.texture;
      if (material.uniforms['g_Time']) material.uniforms['g_Time'].value = time;
      const writeTarget = targets[step.writeTo];
      this.renderer.setRenderTarget(writeTarget);
      this.renderer.render(this.getScene(key, material), SCREEN_CAMERA);
      read = writeTarget;
    }
    this.renderer.setRenderTarget(null);
    this.last = read.texture; // 同步记录最终输出（帧循环经 lastOutput 贴屏，避免异步竞态）
    return read;
  }

  // 帧循环同步读取最近输出：update 未完成时返回 null（调用方回退场景 RT，避免首帧黑屏）
  lastOutput(): THREE.Texture | null {
    return this.last;
  }

  dispose(): void {
    this.disposeMaterials();
    this.rtA.dispose();
    this.rtB.dispose();
    this.textures.clear();
  }
}

// 全屏后处理相机：NDC 正交（PlaneGeometry(2,2) 铺满视口）
const SCREEN_CAMERA = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
SCREEN_CAMERA.position.z = 300;

// 材质 json blending → three 混合模式（WE 枚举，spec §3.2；未知回退 normal）
export function blendModeToThree(mode: string): THREE.Blending {
  switch (mode) {
    case 'add': return THREE.AdditiveBlending;
    case 'multiply': return THREE.MultiplyBlending;
    case 'subtract': return THREE.SubtractiveBlending;
    default: return THREE.NormalBlending;
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/effect-runner.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/effect-runner.ts tests/effect-runner.test.ts
git commit -m "feat(wallpaper-engine): 效果执行器（RT ping-pong / 纹理缓存 / pass 编译回退）"
```

---

### Task 6: SceneRenderer 集成 + 浏览器验证（M2）

**Files:**
- Modify: `src/client/scene-renderer.ts`
- Modify: `tests/scene-renderer.test.ts`（如涉及纯逻辑）

**Interfaces:**
- Consumes: `EffectRunner`（Task 5）、`resolveEffectChain`（Task 4）、`SceneUtilObject`（现有 `shared/types.js`）
- Produces: `renderScene` 行为变化——util 对象效果链在画面渲染后应用

- [ ] **Step 1: 改造 createSceneRenderer（离屏 RT + 贴屏）**

在 `createSceneRenderer` 内（含 `SceneRenderer` interface 增加 `setEffectChains` 声明）：

```ts
export interface SceneRenderer {
  setScene(desc: SceneDescription): void;
  setImageObject(tex: THREE.Texture | null, obj: SceneImageObject): void;
  addParticleSystem(
    spec: { emitter: ParticleEmitterSpec; init: ParticleInitializerSpec },
    opts?: { sizeAttenuation?: boolean; origin?: [number, number, number]; scale?: [number, number, number] },
  ): void;
  setEffectChains(chains: import('./shader/effect-chain.js').CompiledEffectPass[][] | null, id: string): void;
  start(): void;
  stop(): void;
}
```

函数体内新增：

```ts
// 场景渲染目标：离屏 RT（效果链输入），最终经全屏 quad 贴到 canvas
const sceneRT = new THREE.WebGLRenderTarget(1, 1);
// 贴屏相机：独立 NDC 正交相机（场景相机是 contain 范围，不能复用）
const screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
screenCamera.position.z = CAMERA_DISTANCE;
const screenScene = new THREE.Scene();
const screenQuad = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.MeshBasicMaterial({ map: sceneRT.texture }),
);
screenQuad.frustumCulled = false;
screenScene.add(screenQuad);
let effectRunner: import('./effect-runner.js').EffectRunner | null = null;
```

2. `setScene` 内：`sceneRT.setSize(vw, vh)`；相机/渲染器尺寸逻辑不变。

3. `frame()` 改造：

```ts
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  // ...粒子更新（不变）...
  // 场景渲染到离屏 RT
  renderer.setRenderTarget(sceneRT);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  // 贴屏源：有效果链时用 runner 最近完成输出（未完成回退场景 RT，避免首帧黑屏），否则 sceneRT
  const displayTex = effectRunner ? (effectRunner.lastOutput() ?? sceneRT.texture) : sceneRT.texture;
  (screenQuad.material as THREE.MeshBasicMaterial).map = displayTex;
  renderer.render(screenScene, screenCamera);
  // 效果链异步更新（纹理槽加载完成前输出=input，不阻塞帧循环）
  if (effectRunner) {
    void effectRunner.update(clock.elapsedTime, sceneRT);
  }
  if (bgRenderer && bgCamera) bgRenderer.render(scene, bgCamera);
  // ...raf 逻辑不变...
}
```

**异步竞态说明**：`effectRunner.update` 内部有异步纹理槽加载（await），但 RT 渲染在 Promise 内按序完成；帧循环经 `lastOutput()` 同步读取最近完成输出贴屏（`last` 由 Task 5 的 update 末尾记录），不会出现帧间闪烁。

4. 新增 `setEffectChains`：

```ts
setEffectChains(chains: import('./shader/effect-chain.js').CompiledEffectPass[][] | null, id: string) {
  if (!effectRunner) {
    const vw = Math.max(1, Math.round(window.innerWidth || ortho.width));
    const vh = Math.max(1, Math.round(window.innerHeight || ortho.height));
    effectRunner = new EffectRunner(renderer, vw, vh);
  }
  effectRunner.setChains(chains ?? [], id);
}
```

5. `stop()` 内：`effectRunner?.dispose(); effectRunner = null;`

- [ ] **Step 2: 改造 renderScene（收集 util 效果链并注入）**

```ts
// renderScene 内、desc 解析后（Ruling 5：所有对象的 effects 按 scene.json objects 顺序展平，
// 全库实测 122 条效果中 105 条挂在 image 对象上，仅 util 会漏掉主视觉）
const utilEffects = desc.objects
  .flatMap((o) => (Array.isArray(o.effects) ? o.effects : []))
  .filter((fx: any) => typeof fx?.file === 'string');

// 异步加载效果链（失败链 → null 过滤；加载中画面保持原样）
void (async () => {
  const chains: import('./shader/effect-chain.js').CompiledEffectPass[][] = [];
  for (const fx of utilEffects) {
    const chain = await resolveEffectChain(fx, async (name) => {
      const resp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(name)}`);
      return resp.ok ? new Uint8Array(await resp.arrayBuffer()) : null;
    });
    if (chain) chains.push(chain);
  }
  renderer.setEffectChains(chains, id);
})();
```

- [ ] **Step 3: 类型检查**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
Expected: exit 0（无类型错误）

- [ ] **Step 4: 全量测试**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: 全部 PASS（既有 102 + 新测试；WebGL 部分无 node 测试）

- [ ] **Step 5: 构建**

Run: `npm run build` 与 `node scripts/build-client.mjs`
Expected: exit 0；`dist/client.js` 生成

- [ ] **Step 6: 浏览器集成验证（M2 里程碑，手动）**

1. 确认 DSH GUI 运行（`http://127.0.0.1:3080`），重启/刷新使新 client bundle 生效；
2. 设置面板切到壁纸 **2911105183**（girl_animation 含 waterwaves + Simple_Audio_Bars 链）；
3. 预期：背景画面与一期一致（girl 图 + 粒子），**水波扰动可见**（girl_animation 区域随时间波动）、音频条渲染为静态图形（静音频谱）；Console 无报错；
4. 切到 **1429403119**（waterripple/waterwaves 密集）：水面涟漪可见；
5. 切到 **2832263418**（spin/chromatic_aberration/Simple_Audio_Bars/iris/shake）：虹彩/抖动可见；
6. 切回 EVA **1280029027**（无效果链）：画面与一期完全一致（回归）；
7. 性能：DevTools Performance 面板确认 FPS ≥ 30。
   若某效果不可见或报错：记录 console 错误 → 定位是头文件函数缺失（补 we-headers）还是预处理/绑定问题 → 修复后重验。

- [ ] **Step 7: 提交**

```bash
git add src/client/scene-renderer.ts
git commit -m "feat(wallpaper-engine): SceneRenderer 集成效果链（离屏 RT + 贴屏 + 效果执行）"
```

---

### Task 7: 全库效果验证与收尾（M3）

**Files:**
- Modify: `tests/verify-real-library.test.ts`（如需要）
- Modify: `docs/superpowers/specs/2026-08-18-dsh-wallpaper-engine-effects-design.md`（如实现与设计有出入）

- [ ] **Step 1: 全库浏览器验证**

对 17 个使用效果的壁纸逐个在 GUI 切换（列表见 spec §2.1）：记录每个壁纸效果可见性；不报错即可接受（spec §4.4 允许效果级跳过）；**黑屏/画面消失为阻断问题**必须修复。

- [ ] **Step 2: 方言完备性复查**

Run: `node research/scan-shader-dialect.mjs`
确认全库 include 集合 ⊆ `WE_HEADERS` keys；若 Task 6 浏览器验证中发现缺失函数（编译报错），补入 `we-headers.ts` 并加测试。

- [ ] **Step 3: 更新设计文档（如有偏差）**

实现与设计的偏差（如 RT 交替实现、blend 模式语义）回写 spec 的对应章节。

- [ ] **Step 4: 最终验证**

Run: `node node_modules/vitest/vitest.mjs run`（全量）→ 全 PASS；`node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` → exit 0；`npm run build` + `node scripts/build-client.mjs` → exit 0。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "docs: 效果链渲染实现收尾（验证记录/规格同步）"
```
