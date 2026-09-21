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
    // 注：mod2 由 Simple_Audio_Bars 自实现（避免重复定义冲突），不在 common.h
    // 注：DEG2RAD/DEG2PCT 已按 F4 删除（WE 真实 common.h 里没有这两个宏，见下）
    for (const token of ['texSample2D', 'mul', 'rotateVec2', 'CAST2', 'frac', 'saturate', 'M_PI', 'M_PI_2']) {
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
});

// ── F1/F2/F3：HLSL 方言重载与别名补全（全库扫描：mul 3 例、texSample2D 1 例、fmod/lerp 4 例）──
describe('F1 mul 重载全表（HLSL mul 的行主序约定）', () => {
  const h = WE_HEADERS['common.h'] ?? '';

  it('vecN × matN 三个方阵重载齐备且沿用既有 m * v 约定', () => {
    expect(h).toMatch(/vec2 mul\(vec2 v, mat2 m\)\s*\{ return m \* v; \}/);
    expect(h).toMatch(/vec3 mul\(vec3 v, mat3 m\)\s*\{ return m \* v; \}/);
    expect(h).toMatch(/vec4 mul\(vec4 v, mat4 m\)\s*\{ return m \* v; \}/);
  });

  it('matN × vecN 三个重载齐备（HLSL 行主序 = GLSL v * m）', () => {
    expect(h).toMatch(/vec2 mul\(mat2 m, vec2 v\)\s*\{ return v \* m; \}/);
    expect(h).toMatch(/vec3 mul\(mat3 m, vec3 v\)\s*\{ return v \* m; \}/);
    expect(h).toMatch(/vec4 mul\(mat4 m, vec4 v\)\s*\{ return v \* m; \}/);
  });

  it('matN × matN 三个重载齐备（结果转置 ⇒ b * a）', () => {
    expect(h).toMatch(/mat2 mul\(mat2 a, mat2 b\)\s*\{ return b \* a; \}/);
    expect(h).toMatch(/mat3 mul\(mat3 a, mat3 b\)\s*\{ return b \* a; \}/);
    expect(h).toMatch(/mat4 mul\(mat4 a, mat4 b\)\s*\{ return b \* a; \}/);
  });
});

describe('F2 texSample2D 的 vec3/vec4 uv 重载', () => {
  const h = WE_HEADERS['common.h'] ?? '';
  it('vec3/vec4 uv 内部取 .xy（WE 内置按前两分量取 uv）', () => {
    expect(h).toMatch(/vec4 texSample2D\(sampler2D t, vec3 uv\)\s*\{ return texture2D\(t, uv\.xy\); \}/);
    expect(h).toMatch(/vec4 texSample2D\(sampler2D t, vec4 uv\)\s*\{ return texture2D\(t, uv\.xy\); \}/);
    expect(h).toMatch(/vec4 texSample2D\(sampler2D t, vec2 uv\)\s*\{ return texture2D\(t, uv\); \}/);
  });
});

describe('F3 HLSL 名字别名 fmod→mod、lerp→mix', () => {
  const h = WE_HEADERS['common.h'] ?? '';
  it('提供 fmod/lerp 别名（宏覆盖标量/向量全部重载）', () => {
    expect(h).toMatch(/#define fmod\(a, b\) mod\(a, b\)/);
    expect(h).toMatch(/#define lerp\(a, b, t\) mix\(a, b, t\)/);
  });
});
