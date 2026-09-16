// tests/shader-preprocessor.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { preprocessWeShader, extractUniformAnnotations, reconcileVaryingDeclarations } from '../src/client/shader/shader-preprocessor.js';
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
  // 回归（2026-09-15，3303428996 死亡搁浅-玛玛整屏黑）：注解里的**嵌套对象**（`"require":{...}`、
  // `"options":{...}`）会让非贪婪 `\{[\s\S]*?\}` 在内层 `}` 截断 ⇒ JSON.parse 失败 ⇒ 注解整体丢失
  // ⇒ material 映射与 default 都拿不到（uniform 落 0）。lightshafts 的 g_Point0..3 全 0 ⇒ 透视矩阵
  // 退化 ⇒ NaN ⇒ 整屏黑。sampler 上的 mode/combo 同样会被丢掉（遮罩语义失效）。
  it('注解含嵌套对象（require/options）时仍完整解析（不被内层 } 截断）', () => {
    const src = 'uniform vec2 g_Point0; // {"material":"point0","label":"p0","default":"0.67728 0.01297","require":{"DIRECTDRAW":0}}';
    const anns = extractUniformAnnotations(src);
    expect(anns[0].annotation).toEqual({
      material: 'point0', label: 'p0', default: '0.67728 0.01297', require: { DIRECTDRAW: 0 },
    });
  });
  it('sampler 注解含 require 时 mode/combo 不丢（遮罩语义依赖它）', () => {
    const src = 'uniform sampler2D g_Texture3; // {"label":"mask","mode":"opacitymask","combo":"MASK","require":{"DIRECTDRAW":0}}';
    const anns = extractUniformAnnotations(src);
    expect(anns[0].annotation).toMatchObject({ mode: 'opacitymask', combo: 'MASK' });
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
  it('int 字面量浮点化（GLSL3 禁止 int/float 混算）', () => {
    const src = 'uniform float g_T; void main() { float a = 1 - g_T; float b = 1; gl_FragColor = vec4(a, b, 0, 1); }';
    const out = preprocessWeShader(src, {});
    expect(out).toContain('1.0 - g_T');
    expect(out).toContain('float b = 1.0;');
    expect(out).not.toContain('= 1;');
    expect(out).not.toContain('1 - g_T');
  });
  it('const int 字面量声明不被补 .0（2026-08-21 修复）', () => {
    const src = 'const int N = 3;\nvoid main() { gl_FragColor = vec4(float(N)); }';
    const out = preprocessWeShader(src, {});
    expect(out).toContain('const int N = 3;'); // 保持 int，3 不被补 3.0
    expect(out).not.toContain('const int N = 3.0;');
  });
  it('int 变量参与浮点运算 → float() 包裹（GLSL3 禁止 int/float 混算）', () => {
    // godrays_cast/shine_cast 真实模式：const int 常量赋 float、循环计数器除以 float
    const src = [
      'const int sampleCount = 30;',
      'const float sampleDrop = sampleCount - 1;',
      'void main() {',
      '  float acc = 0.0;',
      '  for (int i = 0; i < sampleCount; ++i) {',
      '    acc += i / sampleDrop;',
      '  }',
      '  gl_FragColor = vec4(acc * sampleCount, 1.0 / sampleCount, 0.0, 1.0);',
      '}',
    ].join('\n');
    const out = preprocessWeShader(src, {});
    expect(out).toContain('const int sampleCount = 30;');         // 声明保持 int
    expect(out).toContain('float(sampleCount) - 1');              // const int 赋 float → float()
    expect(out).toContain('float(i) / sampleDrop');               // 循环计数器除以 float → float()
    expect(out).toContain('for (int i = 0; i < sampleCount; ++i)'); // 循环头保持 int 比较
    expect(out).toContain('acc * float(sampleCount)');            // float 运算 → float()
    expect(out).toContain('1.0 / float(sampleCount)');            // 除法右操作数 → float()
    expect(out).not.toContain('i / sampleDrop');                  // 原混合运算已转换
  });
  it('float() 显式构造内的 int 变量不重复包裹', () => {
    const src = 'int N = 3;\nvoid main() { gl_FragColor = vec4(float(N)); }';
    const out = preprocessWeShader(src, {});
    expect(out).toContain('float(N)');
    expect(out).not.toContain('float(float(N))');
  });
  it('int 函数参数声明不被使用点转换（common_blending.h ApplyBlending 场景）', () => {
    // 2026-08-21 实测：参数名 blendMode 被转成 `const int float(blendMode)` → GLSL3 'float' : syntax error
    const src = [
      'vec3 ApplyBlending(const int blendMode, in vec3 A, in vec3 B, in float opacity) {',
      '  if (blendMode == 9) return A + B * opacity;',
      '  return A;',
      '}',
      'void main() { gl_FragColor = vec4(ApplyBlending(9, vec3(1.0), vec3(0.5), 1.0), 1.0); }',
    ].join('\n');
    const out = preprocessWeShader(src, {});
    expect(out).toContain('const int blendMode');             // 参数声明原样
    expect(out).not.toContain('const int float(blendMode)');  // 无语法破坏
    expect(out).toContain('blendMode == 9');                  // int 比较保持
  });
  it('int 变量与标识符（宏/常量）比较不被包 float()（2026-09-15 修复 refraction 编译失败）', () => {
    // 实测：common_fragment.h 的 `if (format == FORMAT_RG88)` 曾被处理成 `float(format) == …`
    // ⇒ GLSL3 '==' wrong operand types ⇒ 2911105183 的 effects/refraction 整条 pass 编译失败。
    // 根因是两条单侧比较保护规则顺序错（右侧规则先吞掉运算符）。细节见 AGENT.md §7.1。
    const src = [
      '#define FORMAT_RG88 8',
      '#define FORMAT_R8 9',
      'vec4 ConvertTextureFormat(const int format, vec4 _sample) {',
      '  if (format == FORMAT_RG88) return _sample.rrrg;',
      '  if (format == FORMAT_R8) return _sample.rrrr;',
      '  return _sample;',
      '}',
      'void main() { gl_FragColor = ConvertTextureFormat(8, vec4(1.0)); }',
    ].join('\n');
    const out = preprocessWeShader(src, {});
    expect(out).toContain('format == FORMAT_RG88');   // 比较两侧都保持 int
    expect(out).toContain('format == FORMAT_R8');
    expect(out).not.toContain('float(format) ==');    // 不再产生 float/int 比较
  });
  it('int 变量与另一个 int 变量比较不被包 float()', () => {
    const src = 'int f(const int a, const int b) { if (a == b) return 1; return 0; }\nvoid main() { gl_FragColor = vec4(float(f(1, 2))); }';
    const out = preprocessWeShader(src, {});
    expect(out).toContain('a == b');
    expect(out).not.toContain('float(a) == b');
  });
  it('const 非常量初始化降级（GLSL3 只允许编译期常量）', () => {
    const src = 'uniform float u_t; uniform float u_g;\nconst float threshold = pow(u_t, u_g);\nvoid main() { gl_FragColor = vec4(threshold); }';
    const out = preprocessWeShader(src, {});
    // const 降级：不再有 const 声明；全局非常量初始化随后移入 main
    expect(out).not.toContain('const float threshold');
    expect(out).toContain('float threshold;');
    expect(out).toContain('threshold = pow(u_t, u_g);');
  });
  it('全局非常量初始化移入 main（GLSL3 全局初始化须编译期常量）', () => {
    // 多行真实格式（单行内联时按行匹配不到以分号结尾的声明）
    const src = 'uniform float u_t;\nfloat threshold = pow(u_t, 2.0);\nvoid main() { gl_FragColor = vec4(threshold); }';
    const out = preprocessWeShader(src, {});
    expect(out).toContain('float threshold;');            // 全局声明保留
    expect(out).toContain('threshold = pow(u_t, 2.0);');  // 初始化移入 main
  });
  it('GLSL3 保留字改写（sample/pointer 作标识符非法）', () => {
    const src = 'void main() { float sample = 1.0; float pointer = 2.0; gl_FragColor = vec4(sample, pointer, 0.0, 1.0); }';
    const out = preprocessWeShader(src, {});
    expect(out).toContain('float sample_ = 1.0;');
    expect(out).toContain('float pointer_ = 2.0;');
    expect(out).not.toContain('float sample ');
    expect(out).not.toContain('float pointer ');
  });
  it('sampler 声明前置（common_blur.h 引用 g_Texture0 须先声明）', () => {
    const src = '#include "common_blur.h"\nuniform sampler2D g_Texture0;\nvoid main() { gl_FragColor = blur13a(vec2(0.5), vec2(1.0, 0.0)); }';
    const out = preprocessWeShader(src, {});
    const declIdx = out.indexOf('uniform sampler2D g_Texture0');
    const blurIdx = out.indexOf('vec4 blur13a(');
    expect(declIdx).toBeGreaterThan(-1);
    expect(blurIdx).toBeGreaterThan(-1);
    expect(declIdx).toBeLessThan(blurIdx); // sampler 声明在 blur13a 定义之前
  });
  it('[COMBO] 注释 default 注入（BLENDMODE 等不在 #if 内的宏）', () => {
    const src = '// [COMBO] {"material":"blend","combo":"BLENDMODE","type":"imageblending","default":9}\nuniform int g_Mode;\nvoid main() { gl_FragColor = vec4(float(g_Mode) + float(BLENDMODE)); }';
    const out = preprocessWeShader(src, {});
    expect(out).toContain('#define BLENDMODE 9'); // scene.json 未提供时用注释 default
  });
  it('科学计数法字面量不被损坏（引擎 common.h rgb2hsv 的 1e-10）', () => {
    const out = preprocessWeShader('void main() { float x = 1e-10; float y = 1.5e-3; gl_FragColor = vec4(x, y, 0.0, 1.0); }', {});
    expect(out).toContain('1e-10');
    expect(out).toContain('1.5e-3');
    expect(out).not.toContain('1e-10.0');
    expect(out).not.toContain('1.5e-3.0');
  });
  it('嵌套 include 递归展开（common_composite.h 内层 common.h/common_blending.h 不残留）', () => {
    const out = preprocessWeShader('#include "common_composite.h"\nvoid main() { gl_FragColor = vec4(1.0); }', {});
    expect(out).not.toMatch(/#include\s*"/);
    expect(out).toContain('ApplyCompositeOffset');
    expect(out).toContain('ApplyBlending');  // 内层 common_blending.h 已展开
    expect(out).toContain('greyscale');      // 内层 common.h 已展开
  });
});

// ── varying 声明跨 stage 兼容（用户实测：壁纸 3789452668 的 color_grading）─────────────
// 作者把 vert 写成 `varying vec4 v_TexCoord;`、frag 写成 `varying vec2 v_TexCoord;`
// ⇒ linkProgram 报 "Varying 'v_TexCoord' is not linkable" ⇒ 整 pass 被跳过（调色层缺失）。
// 规则：只在「宽侧 = vert、窄侧 = frag、同为 vec 族、且 frag 内每处用法都紧跟 `.`」时把
// frag 的声明提升为 vert 的类型（语义等价）；其余一律不改 + 告警（绝不静默画错）。
describe('reconcileVaryingDeclarations（varying 声明跨 stage 兼容）', () => {
  const VERT_VEC4 = 'varying vec4 v_TexCoord;';
  const FRAG_VEC2 = 'varying vec2 v_TexCoord;';
  const vert = `attribute vec2 a_TexCoord;\n${VERT_VEC4}\nvoid main() { v_TexCoord = vec4(a_TexCoord, 0.0, 1.0); }`;

  it('真实形态（frag 窄、全 .xy 用法）→ 只提升 frag 声明，无告警', () => {
    const frag = `${FRAG_VEC2}\nuniform sampler2D g_Texture0;\nvoid main() { gl_FragColor = texSample2D(g_Texture0, v_TexCoord.xy) * v_TexCoord.xy; }`;
    const r = reconcileVaryingDeclarations(vert, frag);
    expect(r.vert).toBe(vert);                       // vert 一字不动
    expect(r.frag).toBe(frag.replace(FRAG_VEC2, VERT_VEC4));
    expect(r.frag).toContain('varying vec4 v_TexCoord;');
    expect(r.frag).not.toContain('varying vec2 v_TexCoord;');
    expect(r.warnings).toEqual([]);
  });

  it('swizzle 多分量（.x 与 .w，仍紧跟 `.`）→ 同样改写成功', () => {
    const frag = `${FRAG_VEC2}\nvoid main() { gl_FragColor = vec4(v_TexCoord.x, v_TexCoord.w, 0.0, 1.0); }`;
    const r = reconcileVaryingDeclarations(vert, frag);
    expect(r.frag).toBe(frag.replace(FRAG_VEC2, VERT_VEC4));
    expect(r.warnings).toEqual([]);
  });

  it('frag 存在整体用法 → 原样返回 + 1 条告警（提升会让类型失配）', () => {
    const frag = `${FRAG_VEC2}\nuniform sampler2D g_Texture0;\nvoid main() { gl_FragColor = texSample2D(g_Texture0, v_TexCoord); }`;
    const r = reconcileVaryingDeclarations(vert, frag);
    expect(r.vert).toBe(vert);
    expect(r.frag).toBe(frag);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('v_TexCoord');
    expect(r.warnings[0]).toContain('applyFragmentTexCoordCompatibility'); // 指出与 lwe :417 的对应关系
  });

  it('反方向（窄侧是 vert）→ 原样返回 + 1 条告警（提到 lwe 的 applyLinkedVaryingCompatibility）', () => {
    const v2 = 'attribute vec2 a_TexCoord;\nvarying vec2 v_TexCoord;\nvoid main() { v_TexCoord = a_TexCoord; }';
    const f4 = 'varying vec4 v_TexCoord;\nvoid main() { gl_FragColor = v_TexCoord; }';
    const r = reconcileVaryingDeclarations(v2, f4);
    expect(r.vert).toBe(v2);
    expect(r.frag).toBe(f4);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('v_TexCoord');
    expect(r.warnings[0]).toContain('applyLinkedVaryingCompatibility');
  });

  it('两侧不同族（vec4/float、float/vec2）→ 原样返回 + 告警', () => {
    const fragFloat = 'varying float v_TexCoord;\nvoid main() { gl_FragColor = vec4(v_TexCoord); }';
    const a = reconcileVaryingDeclarations(vert, fragFloat);
    expect(a.frag).toBe(fragFloat);
    expect(a.vert).toBe(vert);
    expect(a.warnings).toHaveLength(1);
    expect(a.warnings[0]).toContain('v_TexCoord');

    const vertFloat = 'varying float v_TexCoord;\nvoid main() { v_TexCoord = 1.0; }';
    const b = reconcileVaryingDeclarations(vertFloat, FRAG_VEC2 + '\nvoid main() { gl_FragColor = vec4(v_TexCoord.xy, 0.0, 1.0); }');
    expect(b.vert).toBe(vertFloat);
    expect(b.warnings).toHaveLength(1);
  });

  it('无关 pass 零副作用（两侧声明完全相同，含同型的多个 varying）→ 原样返回、无告警', () => {
    const v = 'varying vec2 v_TexCoord;\nvarying vec4 v_TexCoordMask;\nvoid main() { v_TexCoord = vec2(0.0); v_TexCoordMask = vec4(1.0); }';
    const f = 'varying vec2 v_TexCoord;\nvarying vec4 v_TexCoordMask;\nvoid main() { gl_FragColor = v_TexCoordMask * v_TexCoord.x; }';
    const r = reconcileVaryingDeclarations(v, f);
    expect(r.vert).toBe(v);
    expect(r.frag).toBe(f);
    expect(r.warnings).toEqual([]);
  });

  it('多个不匹配并存：只改可安全改写的那个，只对整体用法那个告警', () => {
    const v = 'varying vec4 v_Good;\nvarying vec4 v_Bad;\nvoid main() { v_Good = vec4(1.0); v_Bad = vec4(1.0); }';
    const f = 'varying vec2 v_Good;\nvarying vec2 v_Bad;\nvoid main() { gl_FragColor = vec4(v_Good.xy, v_Bad.x, 1.0); useAll(v_Bad); }';
    const r = reconcileVaryingDeclarations(v, f);
    expect(r.frag).toContain('varying vec4 v_Good;');
    expect(r.frag).not.toContain('varying vec2 v_Good;');
    expect(r.frag).toContain('varying vec2 v_Bad;');   // 有整体用法 ⇒ 不动
    expect(r.vert).toBe(v);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('v_Bad');
  });
});
