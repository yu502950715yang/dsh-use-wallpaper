// tests/shader/effect-chain.test.ts
// Task A：解耦出 pass 元数据（原始 shader 源 + combos），供 wasm 路径消费。
// 重点断言：编译 pass 的 rawVert/rawFrag 是**未预处理**的原始 WE 方言源
// （attribute 声明 / #include / gl_FragColor 等原样保留），而 vertSrc/fragSrc
// 仍是供 three 用的预处理后 GLSL3（combo 注入、头展开、attribute 改写）。
import { describe, expect, it, vi } from 'vitest';
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

// ── combo 派生（2026-09-14，真机对照桌面 WE 时发现）──────────────────────────────
// WE 语义：shader 里 sampler 声明带 `"combo":"X"` 时，**该槽被绑定（scene.json 的 textures
// 对应项非 null）即置 X=1**。典型是 mask / 方向图槽——`#if MASK` 的局部作用分支不启用时，
// 效果会**全图**生效（真机现象：GTR 整屏抖动而不是只抖排气管、整屏脉冲而不是只有脸部反光）。
// 另：textures[i] → g_Texture(i)（WE 官方 wpdoc/scenejson.md:22），**不是** g_Texture(i+1)——
// 曾整体错位一个槽，使 mask 落到别的 sampler 上、shader 采到默认纹理（flowmask 采白 ⇒
// flowMask≈1.0 ⇒ 全图位移）。
const comboFiles = new Map<string, Uint8Array>([
  ['effects/combo/effect.json', encoder.encode(JSON.stringify({
    version: 1,
    passes: [{ material: 'materials/effects/combo.json' }],
  }))],
  ['materials/effects/combo.json', encoder.encode(JSON.stringify({
    passes: [{ shader: 'effects/combo', blending: 'normal' }],
  }))],
  ['shaders/effects/combo.vert', encoder.encode('void main() { gl_Position = vec4(position, 1.0); }')],
  ['shaders/effects/combo.frag', encoder.encode(
    'uniform sampler2D g_Texture0; // {"hidden":true}\n' +
    'uniform sampler2D g_Texture2; // {"mode":"opacitymask","combo":"MASK"}\n' +
    'uniform sampler2D g_Texture3; // {"mode":"flowmask","combo":"FLOW","default":"util/noflow"}\n' +
    '#if MASK\nfloat masked() { return 1.0; }\n#endif\n' +
    'void main() { gl_FragColor = texSample2D(g_Texture0, vec2(0.0)); }',
  )],
]);
const loadCombo = async (name: string) => comboFiles.get(name) ?? null;

describe('combo 派生：sampler 注释带 combo 且该纹理槽被绑定 → 置 1', () => {
  it('textures[2] 有纹理 → MASK=1；未提供的槽（textures[3]）不派生；槽数组原样保留', async () => {
    const chain = await resolveEffectChain({
      file: 'effects/combo/effect.json',
      passes: [{ textures: [null, null, 'masks/m.tex'] }],
    }, loadCombo);
    expect(chain).not.toBeNull();
    expect(chain![0].combos.MASK).toBe(1);
    expect(chain![0].combos.FLOW).toBeUndefined();
    expect(chain![0].textureSlots).toEqual([null, null, 'masks/m.tex']);
  });

  it('槽为 null → 不派生该 combo（走 #if 未启用的降级分支）', async () => {
    const chain = await resolveEffectChain({
      file: 'effects/combo/effect.json',
      passes: [{ textures: [null, null, null] }],
    }, loadCombo);
    expect(chain![0].combos.MASK).toBeUndefined();
  });

  it('scene.json 的显式 combos 优先于派生结果', async () => {
    const chain = await resolveEffectChain({
      file: 'effects/combo/effect.json',
      passes: [{ combos: { MASK: 0 }, textures: [null, null, 'masks/m.tex'] }],
    }, loadCombo);
    expect(chain![0].combos.MASK).toBe(0);
  });
});

// ── samplerModes（空槽语义的唯一依据：sampler 注释里的 mode 标注）────────────────
// scene.json 的 textures 数组**没给到**某个槽（长度不够，或该位为 null）时，执行器按这个
// mode 决定空槽绑什么常量纹理：opacitymask → 全 0（黑，乘法遮罩读到 0 ⇒ 效果不作用）、
// flowmask → 中灰（零位移）。无 mode 的槽不出现（⇒ 执行器不改其既有行为）。
// ⚠️ 必须从**未预处理的原始源**（rawVert/rawFrag）里取：preprocessWeShader 会把
// `uniform sampler2D x; // {...}` 整行抽出来前置到文件头，处理后再扫拿不到注释标注。
const modeFixtures = (frag: string, vert = 'void main() { gl_Position = vec4(position, 1.0); }') =>
  new Map<string, Uint8Array>([
    ['effects/mode/effect.json', encoder.encode(JSON.stringify({
      version: 1,
      passes: [{ material: 'materials/effects/mode.json' }],
    }))],
    ['materials/effects/mode.json', encoder.encode(JSON.stringify({
      passes: [{ shader: 'effects/mode', blending: 'normal' }],
    }))],
    ['shaders/effects/mode.vert', encoder.encode(vert)],
    ['shaders/effects/mode.frag', encoder.encode(frag)],
  ]);

// 真实 clouds.frag 的 sampler 声明（原样抄自
// `<WE>/assets/effects/clouds/shaders/effects/clouds.frag`）：
// g_Texture1 只有 default（无 mode —— 它是 albedo 不是遮罩），g_Texture2 才是 opacitymask。
const CLOUDS_SAMPLERS =
  'uniform sampler2D g_Texture0; // {"hidden":true}\n'
  + 'uniform sampler2D g_Texture1; // {"label":"ui_editor_properties_albedo","default":"util/clouds_256"}\n'
  + 'uniform sampler2D g_Texture2; // {"label":"ui_editor_properties_opacity_mask","mode":"opacitymask","combo":"MASK","paintdefaultcolor":"0 0 0 1"}\n'
  + 'void main() { gl_FragColor = vec4(1.0); }';
// 真实 shake.frag 的 sampler 声明：g_Texture1 = flowmask（方向图）、g_Texture2/3 = opacitymask。
const SHAKE_SAMPLERS =
  'uniform sampler2D g_Texture0; // {"hidden":true}\n'
  + 'uniform sampler2D g_Texture1; // {"label":"ui_editor_properties_shake_direction_map","mode":"flowmask","default":"util/noflow"}\n'
  + 'uniform sampler2D g_Texture2; // {"label":"ui_editor_properties_time_offset","mode":"opacitymask","default":"util/black","combo":"TIMEOFFSET"}\n'
  + 'uniform sampler2D g_Texture3; // {"label":"ui_editor_properties_opacity","mode":"opacitymask","combo":"MASK"}\n'
  + 'void main() { gl_FragColor = vec4(1.0); }';

describe('samplerModes：sampler 注释的 mode 标注（空槽纹理选择依据）', () => {
  it('真实 clouds.frag 片段：g_Texture2 → opacitymask；无 mode 的槽（g_Texture0/1）不出现', async () => {
    const chain = await resolveEffectChain(
      { file: 'effects/mode/effect.json', passes: [{ textures: [null, 'util/clouds_256'] }] },
      async (n) => modeFixtures(CLOUDS_SAMPLERS).get(n) ?? null,
    );
    expect(chain).not.toBeNull();
    expect(chain![0].samplerModes).toEqual({ g_Texture2: 'opacitymask' });
    // textureSlots 仍是 scene.json 原样的长度 2 —— 槽数不够由执行器按 samplerModes 补齐
    expect(chain![0].textureSlots).toEqual([null, 'util/clouds_256']);
  });

  it('真实 shake.frag 片段：g_Texture1 → flowmask、g_Texture2/3 → opacitymask', async () => {
    const files = modeFixtures(SHAKE_SAMPLERS);
    const chain = await resolveEffectChain(
      { file: 'effects/mode/effect.json', passes: [{ textures: [null, 'masks/shake_mask'] }] },
      async (n) => files.get(n) ?? null,
    );
    expect(chain![0].samplerModes).toEqual({
      g_Texture1: 'flowmask',
      g_Texture2: 'opacitymask',
      g_Texture3: 'opacitymask',
    });
  });

  it('vert 侧声明的 sampler 同样被扫（合并 vert + frag；同名以 frag 为准）', async () => {
    const files = modeFixtures(
      'uniform sampler2D g_Texture1; // {"mode":"opacitymask","combo":"MASK"}\n'
      + 'void main() { gl_FragColor = vec4(1.0); }',
      'uniform sampler2D g_Texture1; // {"mode":"flowmask","default":"util/noflow"}\n'
      + 'uniform sampler2D g_Texture2; // {"mode":"opacitymask"}\n'
      + 'void main() { gl_Position = vec4(position, 1.0); }',
    );
    const chain = await resolveEffectChain({ file: 'effects/mode/effect.json' }, async (n) => files.get(n) ?? null);
    // g_Texture1 两侧都有 → frag（g_Texture2 之外的那个）胜出；g_Texture2 仅 vert 声明 → 也收进来
    expect(chain![0].samplerModes.g_Texture1).toBe('opacitymask');
    expect(chain![0].samplerModes.g_Texture2).toBe('opacitymask');
  });

  it('无任何 mode 标注 → samplerModes 为空对象（执行器不改既有回退行为）', async () => {
    const files = modeFixtures('uniform sampler2D g_Texture1; // {"hidden":true}\nvoid main() { gl_FragColor = vec4(1.0); }');
    const chain = await resolveEffectChain({ file: 'effects/mode/effect.json' }, async (n) => files.get(n) ?? null);
    expect(chain![0].samplerModes).toEqual({});
  });
});

// ── samplerNames（槽预建范围的依据：全部 sampler 声明，不只带 mode 的槽）────────────
// 回归（壁纸 2937346640 id=44 godrays_combine 近黑）：该 pass 的 sampler 全 `"hidden":true`（无 mode）
// ⇒ samplerModes 为空；若槽预建范围只依赖 samplerModes，g_Texture1 就不会进 material.uniforms，
// 而 three 的 uniformsList 只在换 program 时重算（探针渲染已冻住）⇒ bindSlot 之后补的槽永不上传。
// 故这里记录**全部** sampler 声明名（含无 mode 的），执行器据此取最大 `g_Texture<N>` 下标 + 1。
describe('samplerNames：全部 sampler 声明（槽预建范围的依据）', () => {
  it('真实 godrays_combine.frag 片段：g_Texture2/0/1 全记录，samplerModes 仍为空', async () => {
    const frag =
      'uniform sampler2D g_Texture2; // {"hidden":true,"default":"_rt_FullFrameBuffer"}\n'
      + 'uniform sampler2D g_Texture0; // {"hidden":true}\n'
      + 'uniform sampler2D g_Texture1; // {"hidden":true}\n'
      + 'void main() { gl_FragColor = vec4(1.0); }';
    const chain = await resolveEffectChain(
      { file: 'effects/mode/effect.json' },
      async (n) => modeFixtures(frag).get(n) ?? null,
    );
    expect(chain![0].samplerNames).toEqual(['g_Texture2', 'g_Texture0', 'g_Texture1']);
    expect(chain![0].samplerModes).toEqual({}); // mode 语义不变：只收带 mode 注解的槽
  });

  it('非 sampler 的 uniform 不入列；vert 侧声明的 sampler 同样收录', async () => {
    const files = modeFixtures(
      'uniform float strength;\nuniform sampler2D g_Texture1; // {"mode":"opacitymask"}\n'
      + 'void main() { gl_FragColor = vec4(1.0); }',
      'uniform sampler2D g_Texture2;\nvoid main() { gl_Position = vec4(position, 1.0); }',
    );
    const chain = await resolveEffectChain({ file: 'effects/mode/effect.json' }, async (n) => files.get(n) ?? null);
    expect(chain![0].samplerNames).toEqual(['g_Texture2', 'g_Texture1']);
  });
});

// ── combo 跨 stage 合并（2026-09-15，task-8c）───────────────────────────────────
// WE 语义：combo 宏整 pass 共用（lwe ShaderUnit.cpp:694-714 / WE layerd WPSceneParser.cpp:1643-1644）。
// `[COMBO] default` 常只写在一侧时，另一侧会兜底 `#define X 0` ⇒ 两侧注入不同 ⇒ 链接失败（wasm 路径的
// glsl-to-naga.passCombos 早已合并，本组用例锁 three 路径同口径）。
const stageFixtures = (vert: string, frag: string) => new Map<string, Uint8Array>([
  ['effects/stage/effect.json', encoder.encode(JSON.stringify({
    version: 1,
    passes: [{ material: 'materials/effects/stage.json' }],
  }))],
  ['materials/effects/stage.json', encoder.encode(JSON.stringify({
    passes: [{ shader: 'effects/stage', blending: 'normal' }],
  }))],
  ['shaders/effects/stage.vert', encoder.encode(vert)],
  ['shaders/effects/stage.frag', encoder.encode(frag)],
]);

/** 取预处理后源码里注入的 `#define X V` 数值（同名以先出现的为准）。 */
function injectedDefine(src: string, name: string): string | undefined {
  const m = new RegExp(`^#define\\s+${name}\\s+(\\S+)\\s*$`, 'm').exec(src);
  return m?.[1];
}

describe('combo 跨 stage 合并：同一 pass 的 vert 与 frag 得到同一套宏值', () => {
  // 真实 godrays_downsample2 / shine_downsample2 形态：frag 有 [COMBO] NOISE default 1，
  // vert 只用 `#if NOISE == 1` 门控 v_NoiseTexCoord（frag 直接采它 ⇒ 两侧不一致即链接失败）。
  const downsample2Vert = [
    'attribute vec3 a_Position;',
    'attribute vec2 a_TexCoord;',
    'varying vec4 v_TexCoord;',
    '#if NOISE == 1',
    'varying vec4 v_NoiseTexCoord;',
    '#endif',
    'void main() {',
    '\tgl_Position = vec4(a_Position, 1.0);',
    '\tv_TexCoord = a_TexCoord.xyxy;',
    '#if NOISE == 1',
    '\tv_NoiseTexCoord.xy = a_TexCoord;',
    '#endif',
    '}',
  ].join('\n');
  const downsample2Frag = [
    '// [COMBO] {"material":"noise","combo":"NOISE","type":"options","default":1}',
    'varying vec4 v_TexCoord;',
    'uniform sampler2D g_Texture0;',
    '#if NOISE == 1',
    'varying vec4 v_NoiseTexCoord;',
    'uniform sampler2D g_Texture2;',
    '#endif',
    'void main() {',
    '#if NOISE',
    '\tvec4 n = texSample2D(g_Texture2, v_NoiseTexCoord.xy);',
    '#else',
    '\tvec4 n = vec4(1.0);',
    '#endif',
    '\tgl_FragColor = texSample2D(g_Texture0, v_TexCoord.xy) * n;',
    '}',
  ].join('\n');

  it('downsample2：frag 的 [COMBO] NOISE 默认合并进 vert（两侧 #define NOISE 一致 = 1）', async () => {
    const files = stageFixtures(downsample2Vert, downsample2Frag);
    const chain = await resolveEffectChain({ file: 'effects/stage/effect.json' }, async (n) => files.get(n) ?? null);
    expect(chain).not.toBeNull();
    const pass = chain![0];
    expect(injectedDefine(pass.fragSrc, 'NOISE')).toBe('1');
    // 修复前：vert 走 `#if` 裸标识符兜底 → '0'（两侧不一致 ⇒ 链接失败）
    expect(injectedDefine(pass.vertSrc, 'NOISE')).toBe('1');
    expect(injectedDefine(pass.vertSrc, 'NOISE')).toBe(injectedDefine(pass.fragSrc, 'NOISE'));
  });

  // 真实 shine_gaussian 形态：frag 有 [COMBO] KERNEL default 1，两侧的 varying 数组尺寸由
  // `#if KERNEL` 决定（vec2[7] vs vec2[13]）——与 NOISE 同因，不能只特判 NOISE。
  const gaussianVert = [
    'attribute vec3 a_Position;',
    'attribute vec2 a_TexCoord;',
    '#if KERNEL == 0',
    'varying vec2 v_TexCoord[13];',
    '#else',
    'varying vec2 v_TexCoord[7];',
    '#endif',
    'void main() { gl_Position = vec4(a_Position, 1.0); v_TexCoord[0] = a_TexCoord; }',
  ].join('\n');
  const gaussianFrag = [
    '// [COMBO] {"material":"kernel","combo":"KERNEL","type":"options","default":1,"options":{"13x13":0,"7x7":1}}',
    '#if KERNEL == 0',
    'varying vec2 v_TexCoord[13];',
    '#else',
    'varying vec2 v_TexCoord[7];',
    '#endif',
    'uniform sampler2D g_Texture0;',
    'void main() { gl_FragColor = texSample2D(g_Texture0, v_TexCoord[0]); }',
  ].join('\n');

  it('gaussian：frag 的 [COMBO] KERNEL 默认合并进 vert（两侧 #define KERNEL 一致 = 1）', async () => {
    const files = stageFixtures(gaussianVert, gaussianFrag);
    const chain = await resolveEffectChain({ file: 'effects/stage/effect.json' }, async (n) => files.get(n) ?? null);
    const pass = chain![0];
    expect(injectedDefine(pass.vertSrc, 'KERNEL')).toBe('1');
    expect(injectedDefine(pass.vertSrc, 'KERNEL')).toBe(injectedDefine(pass.fragSrc, 'KERNEL'));
    // 数组尺寸随之一致（修复前 vert 取 13、frag 取 7 ⇒ inter-stage 不匹配）
    expect(/varying vec2 v_TexCoord\[7\]/.test(pass.vertSrc)).toBe(true);
    expect(/varying vec2 v_TexCoord\[7\]/.test(pass.fragSrc)).toBe(true);
  });

  it('scene.json 覆写仍优先于 [COMBO] 注释默认（合并不改优先级）', async () => {
    const files = stageFixtures(downsample2Vert, downsample2Frag);
    const chain = await resolveEffectChain(
      { file: 'effects/stage/effect.json', passes: [{ combos: { NOISE: 0 } }] },
      async (n) => files.get(n) ?? null,
    );
    expect(injectedDefine(chain![0].vertSrc, 'NOISE')).toBe('0');
    expect(injectedDefine(chain![0].fragSrc, 'NOISE')).toBe('0');
  });
});

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

// ── varying 声明兼容接入（用户实测：3789452668 的 color_grading 链接失败）──────────────
// 真实形态：vert `varying vec4 v_TexCoord;` / frag `varying vec2 v_TexCoord;`，frag 内全是 `.xy`
// 用法 ⇒ three 路径应把 frag 声明提升为 vec4；未预处理的 rawFrag 必须保持原始 vec2（wasm 路径在用）。
describe('varying 声明兼容接入', () => {
  const varyingFiles = new Map<string, Uint8Array>([
    ['effects/varying/effect.json', encoder.encode(JSON.stringify({
      version: 1,
      passes: [{ material: 'materials/effects/varying.json' }],
    }))],
    ['materials/effects/varying.json', encoder.encode(JSON.stringify({
      passes: [{ shader: 'effects/varying', blending: 'normal' }],
    }))],
    ['shaders/effects/varying.vert', encoder.encode(
      'attribute vec2 a_TexCoord;\n'
      + 'varying vec4 v_TexCoord;\n'
      + 'void main() { gl_Position = vec4(a_Position, 1.0); v_TexCoord = vec4(a_TexCoord, 0.0, 1.0); }',
    )],
    ['shaders/effects/varying.frag', encoder.encode(
      'varying vec2 v_TexCoord;\n'
      + 'uniform sampler2D g_Texture0;\n'
      + 'void main() { gl_FragColor = texSample2D(g_Texture0, v_TexCoord.xy); }',
    )],
  ]);
  const loadVarying = async (name: string) => varyingFiles.get(name) ?? null;

  it('frag 声明被提升为 vec4（语义等价、无告警），rawFrag 保持原始 vec2', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const chain = await resolveEffectChain({ file: 'effects/varying/effect.json' }, loadVarying);
      expect(chain).not.toBeNull();
      const pass = chain![0];
      expect(pass.fragSrc).toContain('varying vec4 v_TexCoord;');
      expect(pass.fragSrc).not.toContain('varying vec2 v_TexCoord;');
      expect(pass.vertSrc).toContain('varying vec4 v_TexCoord;');
      expect(pass.rawFrag).toContain('varying vec2 v_TexCoord;');  // raw 不被污染
      expect(pass.rawVert).toContain('varying vec4 v_TexCoord;');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
