// tests/shader/effect-chain.test.ts
// Task A：解耦出 pass 元数据（原始 shader 源 + combos），供 wasm 路径消费。
// 重点断言：编译 pass 的 rawVert/rawFrag 是**未预处理**的原始 WE 方言源
// （attribute 声明 / #include / gl_FragColor 等原样保留），而 vertSrc/fragSrc
// 仍是供 three 用的预处理后 GLSL3（combo 注入、头展开、attribute 改写）。
import { describe, expect, it } from 'vitest';
import { resolveEffectChain } from '../../src/client/shader/effect-chain.js';

const encoder = new TextEncoder();
// 独立 fixture：vert 带 WE 方言 attribute 声明、frag 带 #include 与 gl_FragColor，
// 便于区分原始源（raw*）与预处理后源（*Src）。
const files = new Map<string, Uint8Array>([
  ['effects/probe/effect.json', encoder.encode(JSON.stringify({
    version: 1,
    passes: [{ material: 'materials/effects/probe.json' }],
  }))],
  ['materials/effects/probe.json', encoder.encode(JSON.stringify({
    passes: [{ shader: 'effects/probe', blending: 'normal' }],
  }))],
  ['shaders/effects/probe.vert', encoder.encode(
    'attribute vec3 a_Position;\n' +
    'uniform mat4 g_ModelViewProjectionMatrix;\n' +
    'void main() { gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix); }',
  )],
  ['shaders/effects/probe.frag', encoder.encode(
    '#include "common.h"\n' +
    'varying vec2 v_TexCoord;\n' +
    'uniform float g_Speed;\n' +
    'void main() { gl_FragColor = vec4(g_Speed); }',
  )],
]);
const loadFile = async (name: string) => files.get(name) ?? null;

describe('resolveEffectChain 解耦出原始 shader 源与 combos', () => {
  it('每个 pass 产出非空 rawVert/rawFrag（原始 WE 方言源），combos 为对象', async () => {
    const chain = await resolveEffectChain({
      file: 'effects/probe/effect.json',
      passes: [{ combos: { MASK: 1 } }],
    }, loadFile);
    expect(chain).not.toBeNull();
    expect(chain!.length).toBeGreaterThan(0);
    for (const pass of chain!) {
      expect(pass.rawVert).toBeTruthy();
      expect(pass.rawFrag).toBeTruthy();
      expect(typeof pass.combos).toBe('object');
      expect(pass.combos).not.toBeNull();
    }
  });

  it('rawVert/rawFrag 保留未预处理特征（attribute / #include / gl_FragColor）', async () => {
    const chain = await resolveEffectChain({ file: 'effects/probe/effect.json' }, loadFile);
    const pass = chain![0];
    // 原始 vert：WE 方言 attribute 声明原样保留（预处理会删除该行）
    expect(pass.rawVert).toContain('attribute vec3 a_Position;');
    // 原始 frag：#include 未被展开、gl_FragColor 原样保留
    expect(pass.rawFrag).toContain('#include "common.h"');
    expect(pass.rawFrag).toContain('gl_FragColor');
  });

  it('vertSrc/fragSrc 仍是预处理后源：combo 注入、头展开、attribute 改写在 raw* 中不见', async () => {
    const chain = await resolveEffectChain({
      file: 'effects/probe/effect.json',
      passes: [{ combos: { MASK: 1 } }],
    }, loadFile);
    const pass = chain![0];
    // 预处理后 vert：attribute 声明行被删除（改写为 three 前缀 position），rawVert 保留
    expect(pass.vertSrc).not.toContain('attribute vec3 a_Position;');
    expect(pass.rawVert).toContain('attribute vec3 a_Position;');
    // 预处理后 frag：MASK combo 已注入、common.h 已展开（不含 #include），rawFrag 保留原样
    expect(pass.fragSrc).toContain('#define MASK 1');
    expect(pass.fragSrc).toContain('float frac');
    expect(pass.fragSrc).not.toContain('#include "common.h"');
    expect(pass.rawFrag).toContain('#include "common.h"');
    // 向后兼容：原有字段语义不变
    expect(pass.blendMode).toBe('normal');
  });

  it('combos 反映 scene.json 覆写（无覆写时为空对象）', async () => {
    const withCombo = await resolveEffectChain({
      file: 'effects/probe/effect.json',
      passes: [{ combos: { MASK: 1, BLENDMODE: 3 } }],
    }, loadFile);
    expect(withCombo![0].combos).toEqual({ MASK: 1, BLENDMODE: 3 });

    const noCombo = await resolveEffectChain({ file: 'effects/probe/effect.json' }, loadFile);
    expect(noCombo![0].combos).toEqual({});
  });
});
