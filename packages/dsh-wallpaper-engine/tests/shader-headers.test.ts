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
});
