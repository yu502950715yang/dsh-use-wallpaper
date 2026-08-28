// tests/shader/glsl-to-naga.test.ts
// Task B：WE 方言 → naga desktop GLSL 转换层（glsl-to-naga）。
// 断言规则①-⑨：include 展开、combo/#if 宏注入、precision 去除、varying/attribute 改写、
// gl_FragColor、uniform layout(binding=N)、纹理函数改写、#version 450。
import { describe, expect, it } from 'vitest';
import { glslToNagaGlsl, glslToNagaPass } from '../../src/client/shader/glsl-to-naga.js';
import type { CompiledEffectPass } from '../../src/client/shader/effect-chain.js';

function makePass(
  overrides: Partial<Pick<CompiledEffectPass, 'rawVert' | 'rawFrag' | 'combos' | 'uniforms' | 'textureSlots' | 'blendMode'>>,
): CompiledEffectPass {
  return {
    vertSrc: '',
    fragSrc: '',
    rawVert: overrides.rawVert ?? '',
    rawFrag: overrides.rawFrag ?? '',
    combos: overrides.combos ?? {},
    uniforms: overrides.uniforms ?? new Map(),
    textureSlots: overrides.textureSlots ?? [],
    blendMode: overrides.blendMode ?? 'normal',
  };
}

describe('glslToNagaPass WE 方言 → naga desktop GLSL', () => {
  it('fragment 全量转换：include 展开 / precision 去除 / varying→in / gl_FragColor / uniform binding / 纹理函数 / #if 宏 / #version', () => {
    const pass = makePass({
      rawFrag: [
        '#include "common.h"',
        'varying vec2 v_TexCoord;',
        'uniform sampler2D g_Texture0;',
        'uniform float g_Alpha;',
        'uniform vec3 g_Tint;',
        'void main() {',
        '    vec4 col = texSample2D(g_Texture0, v_TexCoord);',
        '    gl_FragColor = col * g_Alpha + vec4(g_Tint, 0.0);',
        '#if USE_MASK',
        '    gl_FragColor.a = 0.0;',
        '#endif',
        '}',
      ].join('\n'),
      uniforms: new Map([['g_Alpha', 0.5]]), // g_Tint 缺值 → vec3 默认 [0,0,0]
      textureSlots: ['tex.png', null],
      blendMode: 'adder',
    });
    const desc = glslToNagaGlsl(pass);

    // ⑨ 头部
    expect(desc.fragGlsl.startsWith('#version 450')).toBe(true);
    // ① include 展开（不留 #include，注入 common.h 标记）
    expect(desc.fragGlsl).not.toContain('#include');
    expect(desc.fragGlsl).toContain('#define M_PI ');
    // ③ #if 未定义宏 USE_MASK → #define USE_MASK 0
    expect(desc.fragGlsl).toContain('#define USE_MASK 0');
    // ④ 无 precision 残留
    expect(desc.fragGlsl).not.toMatch(/\b(?:highp|mediump|lowp)\b/);
    // ⑤ varying → in
    expect(desc.fragGlsl).toContain('in vec2 v_TexCoord;');
    expect(desc.fragGlsl).not.toContain('varying ');
    // ⑥ gl_FragColor → o_Color（声明 + 引用替换）
    expect(desc.fragGlsl).toContain('layout(location=0) out vec4 o_Color;');
    expect(desc.fragGlsl).not.toContain('gl_FragColor');
    expect(desc.fragGlsl).toContain('o_Color = col * g_Alpha + vec4(g_Tint, 0.0);');
    // ⑦ uniform：sampler 独立 layout(binding=N)；非不透明 uniform 合并进 std140 block（binding=block 编号）
    expect(desc.fragGlsl).toContain('layout(binding=0) uniform sampler2D g_Texture0;');
    expect(desc.fragGlsl).toContain('layout(std140, binding=1) uniform Params {');
    expect(desc.fragGlsl).toContain('float g_Alpha;');
    expect(desc.fragGlsl).toContain('vec3 g_Tint;');
    // ⑧ texSample2D( → texture(
    expect(desc.fragGlsl).toContain('texture(g_Texture0, v_TexCoord)');
    // uniforms 与 layout(binding=N) 对应：sampler 无 offset/size；block 成员带 offset/size/blockName
    expect(desc.uniforms[0]).toEqual({ name: 'g_Texture0', type: 'sampler2D', value: null, binding: 0 });
    expect(desc.uniforms[1]).toMatchObject({ name: 'g_Alpha', type: 'float', value: 0.5, binding: 1, offset: 0, size: 4, blockName: 'Params' });
    expect(desc.uniforms[2]).toMatchObject({ name: 'g_Tint', type: 'vec3', value: [0, 0, 0], binding: 1, offset: 16, size: 12, blockName: 'Params' });
    // 直接透传
    expect(desc.textureSlots).toEqual(['tex.png', null]);
    expect(desc.blendMode).toBe('adder');
  });

  it('vertex 转换：attribute→in、varying→out、uniform 也注入 binding，且隐式前置 common.h', () => {
    const pass = makePass({
      rawVert: [
        'attribute vec3 a_Position;',
        'varying vec2 v_TexCoord;',
        'uniform mat4 g_ModelViewProjectionMatrix;',
        'void main() {',
        '    v_TexCoord = a_Position.xy;',
        '    gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);',
        '}',
      ].join('\n'),
    });
    const desc = glslToNagaGlsl(pass);

    expect(desc.vertGlsl.startsWith('#version 450')).toBe(true);
    // ⑤ vertex：attribute→in、varying→out
    expect(desc.vertGlsl).toContain('in vec3 a_Position;');
    expect(desc.vertGlsl).not.toContain('attribute');
    expect(desc.vertGlsl).toContain('out vec2 v_TexCoord;');
    expect(desc.vertGlsl).not.toContain('varying ');
    // ⑦ uniform：mat4 非不透明 → std140 block
    expect(desc.vertGlsl).toContain('layout(std140, binding=0) uniform Params {');
    expect(desc.vertGlsl).toContain('mat4 g_ModelViewProjectionMatrix');
    // ① 未显式 include → 隐式前置 common.h（mul/frac 由头提供）
    expect(desc.vertGlsl).toContain('vec4 mul');
    // 顶点只有这一处 uniform（block 成员，带 offset/size/blockName）
    expect(desc.uniforms[0]).toMatchObject({
      name: 'g_ModelViewProjectionMatrix',
      type: 'mat4',
      binding: 0,
      offset: 0,
      size: 64,
      blockName: 'Params',
    });
    expect(desc.uniforms[0].value).toBeInstanceOf(Array);
    expect(desc.uniforms[0].value).toHaveLength(16);
    // 顶点仍沿用 gl_Position（内建输出，不改写）
    expect(desc.vertGlsl).toContain('gl_Position');
  });

  it('combo 宏注入：pass.combos 优先于 [COMBO] 注释 default；#if 未定义者兜底 0', () => {
    const pass = makePass({
      rawFrag: [
        '#include "common.h"',
        '// [COMBO] {"combo":"BLENDMODE","default":12}',
        'uniform float g_Alpha;',
        'void main() {',
        '#if BLENDMODE == 12',
        '    gl_FragColor = vec4(g_Alpha);',
        '#else',
        '    gl_FragColor = vec4(1.0);',
        '#endif',
        '}',
      ].join('\n'),
      combos: { MASK: 1, BLENDMODE: 9 },
      uniforms: new Map([['g_Alpha', 0.25]]),
    });
    const desc = glslToNagaGlsl(pass);

    // pass.combos 覆盖 [COMBO] default：BLENDMODE=9（而非 12）
    expect(desc.fragGlsl).toContain('#define BLENDMODE 9');
    expect(desc.fragGlsl).not.toContain('#define BLENDMODE 12');
    // combo 里的 MASK 未出现在 #if，也一并注入（沿用 preprocessWeShader 行为）
    expect(desc.fragGlsl).toContain('#define MASK 1');
    // g_Alpha 取自 pass.uniforms（block 成员）
    expect(desc.uniforms[0]).toMatchObject({ name: 'g_Alpha', type: 'float', value: 0.25, binding: 0, offset: 0, size: 4, blockName: 'Params' });
    // 无 `#if X ==` 之外的裸标识符需兜底（BLENDMODE/MASK 已定义）
    expect(desc.fragGlsl).toContain('layout(std140, binding=0) uniform Params {');
  });

  it('uniform value 缺失时给缺省（number→0、vec→全 0 数组），binding 编号仍正确', () => {
    const pass = makePass({
      rawFrag: [
        'uniform float g_Intensity;',
        'uniform vec2 g_Offset;',
        'uniform sampler2D g_Texture0;',
        'void main() { gl_FragColor = texture(g_Texture0, g_Offset) * g_Intensity; }',
      ].join('\n'),
      // g_Intensity、g_Offset、g_Texture0 均缺值
    });
    const desc = glslToNagaGlsl(pass);

    // g_Intensity + g_Offset → std140 block（binding 0）；g_Texture0 sampler → binding 1。
    expect(desc.uniforms[0]).toMatchObject({ name: 'g_Intensity', type: 'float', value: 0, binding: 0, offset: 0, size: 4, blockName: 'Params' });
    expect(desc.uniforms[1]).toMatchObject({ name: 'g_Offset', type: 'vec2', value: [0, 0], binding: 0, offset: 8, size: 8, blockName: 'Params' });
    expect(desc.uniforms[2]).toEqual({ name: 'g_Texture0', type: 'sampler2D', value: null, binding: 1 });
    expect(desc.fragGlsl).toContain('layout(std140, binding=0) uniform Params {');
    expect(desc.fragGlsl).toContain('layout(binding=1) uniform sampler2D g_Texture0;');
  });

  it('跨 stage binding 全局唯一：vert+frag 各带 uniform 时合并 uniforms 无重复 binding', () => {
    const pass = makePass({
      rawVert: [
        'attribute vec3 a_Position;',
        'varying vec2 v_TexCoord;',
        'uniform mat4 g_ModelViewProjectionMatrix;',
        'void main() {',
        '    v_TexCoord = a_Position.xy;',
        '    gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);',
        '}',
      ].join('\n'),
      rawFrag: [
        '#include "common.h"',
        'varying vec2 v_TexCoord;',
        'uniform sampler2D g_Texture0;',
        'void main() { gl_FragColor = texSample2D(g_Texture0, v_TexCoord); }',
      ].join('\n'),
    });
    const desc = glslToNagaGlsl(pass);

    // 合并 uniforms 的 binding 全局唯一（因 frag/vert 各自从 0 编号而碰撞的场景）；
    // 且 task-16：vert 从 **frag 拆分后的 binding 上限** 继续（frag 有 1 个 sampler2D → split 后占
    // 0(texture)+1(sampler) 两槽），故 vert 的 MVM block 在 binding=2（而非旧 bug 的 1——若为 1 会与
    // frag 拆分后的 sampler binding=1 碰撞，导致 bind group layout `binding index 被前一 entry 指定`）。
    const bindings = desc.uniforms.map((u) => u.binding);
    expect(new Set(bindings).size).toBe(desc.uniforms.length);
    // frag 先编号 [0..n)，vert 接着从 n 继续（n = frag 拆分后实际槽数 = 2*#sampler + #block）
    const tex0 = desc.uniforms.find((u) => u.name === 'g_Texture0');
    const mvp = desc.uniforms.find((u) => u.name === 'g_ModelViewProjectionMatrix');
    expect(tex0?.binding).toBe(0);
    expect(mvp?.binding).toBe(2);
    // GLSL 里注入的 layout(binding=N) 与 UniformBindingDesc.binding 一一对应
    expect(desc.fragGlsl).toContain('layout(binding=0) uniform sampler2D g_Texture0;');
    expect(desc.vertGlsl).toContain('layout(std140, binding=2) uniform Params {');
  });

  it('sampler/uniform 声明前置：include common_blur.h + 后置 g_Texture0 声明，断言声明先于引用', () => {
    const pass = makePass({
      rawFrag: [
        '#include "common_blur.h"',
        'varying vec2 v_TexCoord;',
        'uniform sampler2D g_Texture0;',
        'void main() {',
        '    gl_FragColor = blur13a(v_TexCoord, vec2(0.1, 0.1));',
        '}',
      ].join('\n'),
    });
    const desc = glslToNagaGlsl(pass);

    // common_blur.h 已展开（blur13a 进入输出）
    expect(desc.fragGlsl).toContain('blur13a');
    // sampler 声明被前置到 blur13a 函数体（引用 g_Texture0）之前，避免 naga "undeclared identifier"
    const declIdx = desc.fragGlsl.indexOf('layout(binding=0) uniform sampler2D g_Texture0;');
    const refIdx = desc.fragGlsl.indexOf('texture(g_Texture0');
    expect(declIdx).toBeGreaterThanOrEqual(0);
    expect(refIdx).toBeGreaterThan(declIdx);
    // 声明生效后，blur13a 引用可正常解析（无残留 #include）
    expect(desc.fragGlsl).not.toContain('#include');
  });

  it('glslToNagaPass 产出合法 SPIR-V bytes（含 sampler2D 组合采样的 WE 方言 shader）', async () => {
    const pass = makePass({
      rawVert: [
        'attribute vec3 a_Position;',
        'varying vec2 v_TexCoord;',
        'void main() {',
        '    v_TexCoord = a_Position.xy;',
        '    gl_Position = vec4(a_Position, 1.0);',
        '}',
      ].join('\n'),
      rawFrag: [
        '#include "common.h"',
        'varying vec2 v_TexCoord;',
        'uniform sampler2D g_Texture0;',
        'uniform float g_Alpha;',
        'void main() {',
        '    vec4 c = texSample2D(g_Texture0, v_TexCoord);',
        '    gl_FragColor = c * g_Alpha;',
        '}',
      ].join('\n'),
      uniforms: new Map([['g_Alpha', 0.5]]),
      textureSlots: ['tex.png'],
      blendMode: 'normal',
    });
    const spv = await glslToNagaPass(pass);
    // SPIR-V 魔数 0x07230203（little-endian 前 4 字节），vert/frag 均非空
    expect(spv.vertSpv.length).toBeGreaterThan(0);
    expect(spv.fragSpv.length).toBeGreaterThan(0);
    expect(new DataView(spv.fragSpv.buffer, spv.fragSpv.byteOffset).getUint32(0, true)).toBe(0x07230203);
    // uniforms（含 sampler 的 binding）/textureSlots/blendMode 透传
    expect(spv.uniforms).toContainEqual({ name: 'g_Texture0', type: 'sampler2D', value: null, binding: 0 });
    const alpha = spv.uniforms.find((u) => u.name === 'g_Alpha');
    expect(alpha).toMatchObject({ type: 'float', value: 0.5, binding: 1, offset: 0, size: 4, blockName: 'Params' });
    expect(spv.textureSlots).toEqual(['tex.png']);
    expect(spv.blendMode).toBe('normal');
  });
});

