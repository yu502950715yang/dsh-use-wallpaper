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
    for (const token of ['texSample2D', 'mul', 'rotateVec2', 'CAST2', 'frac', 'saturate', 'M_PI', 'M_PI_2', 'DEG2RAD']) {
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
