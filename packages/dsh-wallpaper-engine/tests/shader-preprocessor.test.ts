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

const waterwavesVert = (() => {
  const txt = readFileSync(new URL('./fixtures/effects/waterwaves-shaders.txt', import.meta.url), 'utf8');
  const m = txt.match(/========== shaders\/effects\/waterwaves\.vert \(\d+B\) ==========\n([\s\S]*?)(?:\n==========|$)/);
  if (!m) throw new Error('fixture 缺少 waterwaves.vert 段');
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
    // frag 段实际只 include common.h（common_perspective.h 在 vert 段）
    for (const name of ['common.h']) {
      expect(out).not.toContain(`#include "${name}"`);
      expect(out).toContain(WE_HEADERS[name].slice(0, 20)); // 头文件内容已展开
    }
  });
  it('保留真实 waterwaves.vert 全部 include 展开且无残留', () => {
    const out = preprocessWeShader(waterwavesVert, { MASK: 1, PERSPECTIVE: 0, TIMEOFFSET: 0 });
    for (const name of ['common.h', 'common_perspective.h']) {
      expect(out).not.toContain(`#include "${name}"`);
      expect(out).toContain(WE_HEADERS[name].slice(0, 20)); // 头文件内容已展开
    }
  });
  it('未定义组合宏不注入（#if 未定义宏按 0 处理）', () => {
    const out = preprocessWeShader('void main() {}', {});
    expect(out).not.toContain('#define MASK');
  });
  it('改写 WE attribute 名为 three 属性名（删除声明、改写引用）', () => {
    // 浏览器集成验证实测：three ShaderMaterial 前缀自带 attribute vec3 position/uv，
    // WE 的 attribute 声明行若改写保留会重复定义（redefinition）；须删除声明行，
    // 仅函数体内 a_Position→position、a_TexCoord→uv 引用改写
    const src = 'attribute vec3 a_Position; attribute vec2 a_TexCoord; varying vec4 v_TexCoord; void main() { v_TexCoord = a_TexCoord.xyxy; gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix); }';
    const out = preprocessWeShader(src, {});
    expect(out).not.toContain('attribute vec3 a_Position');
    expect(out).not.toContain('attribute vec2 a_TexCoord');
    expect(out).toContain('mul(vec4(position, 1.0), g_ModelViewProjectionMatrix)');
    expect(out).toContain('v_TexCoord = uv.xyxy');
    expect(out).not.toContain('a_Position');
    expect(out).not.toContain('a_TexCoord');
  });
  it('无显式 include 的 shader 隐式注入 common.h（WE 引擎语义）', () => {
    const out = preprocessWeShader('void main() { gl_FragColor = mul(vec4(1.0), mat4(1.0)); }', {});
    expect(out).toContain('vec4 mul(vec4 v, mat4 m)'); // common.h 已注入
    expect(out).toContain('void main()');
  });
  it('#if 裸标识符注入默认 0（GLSL ES 3.00 要求已定义）', () => {
    const out = preprocessWeShader('#if MASK\nfloat x = 1.0;\n#endif\nvoid main() {}', {});
    expect(out).toContain('#define MASK 0');
  });
});
