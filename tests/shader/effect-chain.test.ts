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

describe('resolveEffectChain 保留 RT 图信息（target/bind/fbos，阶段1 RT 图执行器）', () => {
  // blur 风格：多 pass + 具名中间 RT（_rt_QuarterCompoBuffer1/2）+ fbos 降采样 scale:4。
  const blurFiles = new Map<string, Uint8Array>([
    ['effects/blur/effect.json', encoder.encode(JSON.stringify({
      version: 1,
      fbos: [
        { name: '_rt_QuarterCompoBuffer1', scale: 4, format: 'rgba8888' },
        { name: '_rt_QuarterCompoBuffer2', scale: 4, format: 'rgba8888' },
      ],
      passes: [
        { material: 'materials/effects/blur_downsample4.json', target: '_rt_QuarterCompoBuffer1', bind: [{ name: 'previous', index: 0 }] },
        { material: 'materials/effects/blur_gaussian_x.json', target: '_rt_QuarterCompoBuffer2', bind: [{ name: '_rt_QuarterCompoBuffer1', index: 0 }] },
        { material: 'materials/effects/blur_gaussian_y.json', target: '_rt_QuarterCompoBuffer1', bind: [{ name: '_rt_QuarterCompoBuffer2', index: 0 }] },
        { material: 'materials/effects/blur_combine.json', bind: [{ name: '_rt_QuarterCompoBuffer1', index: 0 }, { name: 'previous', index: 2 }] },
      ],
    }))],
    ['materials/effects/blur_downsample4.json', encoder.encode(JSON.stringify({ passes: [{ shader: 'effects/blur_downsample4', blending: 'normal' }] }))],
    ['materials/effects/blur_gaussian_x.json', encoder.encode(JSON.stringify({ passes: [{ shader: 'effects/blur_gaussian', blending: 'normal' }] }))],
    ['materials/effects/blur_gaussian_y.json', encoder.encode(JSON.stringify({ passes: [{ shader: 'effects/blur_gaussian', blending: 'normal' }] }))],
    ['materials/effects/blur_combine.json', encoder.encode(JSON.stringify({ passes: [{ shader: 'effects/blur_combine', blending: 'normal' }] }))],
    ['shaders/effects/blur_downsample4.vert', encoder.encode('attribute vec3 a_Position;\nattribute vec2 a_TexCoord;\nvarying vec2 v_TexCoord;\nvoid main(){ gl_Position = vec4(a_Position,1.0); v_TexCoord = a_TexCoord; }')],
    ['shaders/effects/blur_downsample4.frag', encoder.encode('varying vec2 v_TexCoord;\nvoid main(){ gl_FragColor = vec4(1.0); }')],
    ['shaders/effects/blur_gaussian.vert', encoder.encode('attribute vec3 a_Position;\nattribute vec2 a_TexCoord;\nvarying vec2 v_TexCoord;\nvoid main(){ gl_Position = vec4(a_Position,1.0); v_TexCoord = a_TexCoord; }')],
    ['shaders/effects/blur_gaussian.frag', encoder.encode('varying vec2 v_TexCoord;\nvoid main(){ gl_FragColor = vec4(1.0); }')],
    ['shaders/effects/blur_combine.vert', encoder.encode('attribute vec3 a_Position;\nattribute vec2 a_TexCoord;\nvarying vec4 v_TexCoord;\nvoid main(){ gl_Position = vec4(a_Position,1.0); v_TexCoord = vec4(a_TexCoord,0.0,0.0); }')],
    ['shaders/effects/blur_combine.frag', encoder.encode('varying vec4 v_TexCoord;\nvoid main(){ gl_FragColor = v_TexCoord; }')],
  ]);
  const blurLoad = async (name: string) => blurFiles.get(name) ?? null;

  it('多 pass 链：每个 pass 保留 target 与 bind（具名 RT 引用）', async () => {
    const chain = await resolveEffectChain({ file: 'effects/blur/effect.json' }, blurLoad);
    expect(chain).not.toBeNull();
    // blur_combine 是最后 pass，无 target（= 最终输出）
    expect(chain![0].target).toBe('_rt_QuarterCompoBuffer1');
    expect(chain![1].target).toBe('_rt_QuarterCompoBuffer2');
    expect(chain![3].target).toBeNull();
    // blur_combine 同时引用模糊结果(_rt_QuarterCompoBuffer1)与 previous(原始内容, index 2)
    expect(chain![3].bind).toEqual([
      { name: '_rt_QuarterCompoBuffer1', index: 0 },
      { name: 'previous', index: 2 },
    ]);
  });

  it('fbos 降采样表：name → scale 正确解析（无 fbos 缺省 scale 1）', async () => {
    const chain = await resolveEffectChain({ file: 'effects/blur/effect.json' }, blurLoad);
    expect(chain![0].fboScale).toEqual({
      _rt_QuarterCompoBuffer1: 4,
      _rt_QuarterCompoBuffer2: 4,
    });
  });

  it('scene.json pass 可覆写 target（场景指定目标 RT 优先于 effect.json）', async () => {
    const chain = await resolveEffectChain({
      file: 'effects/blur/effect.json',
      passes: [{ target: '_rt_SceneOverride' }],
    }, blurLoad);
    expect(chain![0].target).toBe('_rt_SceneOverride');
  });
});
