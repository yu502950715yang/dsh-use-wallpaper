// src/client/shader/glsl-to-naga.ts
// WE 方言 GLSL → SPIR-V bytes（供 wasm 编译链消费：真实 WE 效果 shader 含 `uniform sampler2D` 采样）。
// 仅消费 CompiledEffectPass 的 rawVert/rawFrag/combos/uniforms/textureSlots/blendMode，
// 不触碰 preprocessWeShader（给 three）与 effect-chain.ts 既有行为。
//
// 链路（task-8 编译链集成）：WE 方言 → （规则①-⑨ 预处理为 desktop GLSL）→ @webgpu/glslang
//   （GLSL→SPIR-V，entry_point `main`）→ wasm 侧 spirv-webgpu-transform + naga spv-in → WGSL。
// JS 侧只产 SPIR-V（transform/spv-in 在 wasm 编译期做，一次非每帧；见 brief 裁决）。
//
// 预处理规则①-⑨（naga glsl frontend 硬性要求）：
//  - 不接受 #version 300 es，需 desktop 版本（#version 450）。
//  - 每个 uniform 需 layout(binding=N)；fragment 的 out 需 layout(location=0)。
//  - precision 限定符（highp/mediump/lowp）去掉更稳。
//  - varying→in(frag)/out(vert)、attribute→in(vert)；gl_FragColor→自定义 out。
//  - texSample2D(→texture(、texSample2DLod(→textureLod(、texture2D(→texture(。
//  - #if 里的未定义宏 → #define X 0。
import { WE_HEADERS } from './we-headers.js';
import { extractIfIdentifiers, extractComboDefaults } from './shader-preprocessor.js';
import type { CompiledEffectPass } from './effect-chain.js';
import type { UniformValue } from './uniform-binder.js';
import * as glslangNS from '@webgpu/glslang';

export interface UniformBindingDesc {
  name: string;
  type: string;
  value: unknown;
  binding: number;
}

/// 桌面 GLSL 形态（规则的①-⑨ 产物，供 glslang 输入 + 单测断言规则）。
export interface NagaPassDesc {
  vertGlsl: string;
  fragGlsl: string;
  uniforms: UniformBindingDesc[];
  textureSlots: (string | null)[];
  blendMode: string;
}

/// SPIR-V pass 描述（task-8 编译链集成产出；供 wasm 效果链消费）。
export interface SpvPassDesc {
  vertSpv: Uint8Array;
  fragSpv: Uint8Array;
  uniforms: UniformBindingDesc[];
  textureSlots: (string | null)[];
  blendMode: string;
}

type Stage = 'vert' | 'frag';

// @webgpu/glslang 运行时为 CJS/Emscripten Module（`module.exports = function()`，callable）：
// `await glslangNS.default()` 返回带 `compileGLSL` 的 Glslang 实例。其 d.ts 用
// `export default function(): Promise<Glslang>`，但 NodeNext 下 CJS 默认导入被类型解析为模块
// 命名空间（`typeof import(...)`），故用显式类型桥接声明该可调用形态，避免依赖其残缺类型。
interface GlslangApi {
  compileGLSL(
    glsl: string,
    shader_type: 'vertex' | 'fragment' | 'compute',
    gen_debug: boolean,
    spirv_version?: string,
  ): Uint32Array;
}
const glslangInit = glslangNS.default as unknown as () => Promise<GlslangApi>;
let glslangPromise: Promise<GlslangApi> | null = null;
function loadGlslang(): Promise<GlslangApi> {
  // Task 9（浏览器 bundle）：web-devel 工厂的 locateFile() 经 build-client.mjs 的
  // glslang-web-patch 插件改为读 globalThis.__DSH_GLSLANG_BASE__（DSH 插件静态路由前缀），
  // 以 fetch /wallpapers/static/glslang.wasm。Node 测试（node-devel）用 fs 读 wasm，不受影响。
  if (typeof globalThis !== 'undefined') {
    (globalThis as { __DSH_GLSLANG_BASE__?: string }).__DSH_GLSLANG_BASE__ = '/wallpapers/static/';
  }
  glslangPromise ??= glslangInit();
  return glslangPromise;
}

// SPIR-V 是 little-endian 32-bit word 流；@webgpu/glslang 返回 Uint32Array → 转 Uint8Array bytes
//（wasm 侧 spirv-webgpu-transform::u8_slice_to_u32_vec 按 LE 读回 word）。
function u32ToBytes(u32: Uint32Array): Uint8Array {
  const out = new Uint8Array(u32.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < u32.length; i++) dv.setUint32(i * 4, u32[i], true);
  return out;
}

// uniform 声明（支持标量/向量/矩阵/数组与行尾注解，如 uniform float g_A[16]; // {...}）。
// 组：1=缩进，2=类型，3=变量名，4=数组大小（可选）。这里匹配整行（含行尾 // {...} 注解）
// 以便抽取后整行移除再前置——naga glsl frontend 要求声明先于引用（详见 convertStage ⑦ 注释）。
const UNIFORM_LINE_RE = /^(\s*)uniform\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\w+)(?:\s*\[(\d+)\])?\s*;[^\S\r\n]*(?:\/\/.*)?$/gm;

// WE 方言纹理包装函数（common.h 提供）。规则⑧会把 texSample2D/texSample2DLod/texture2D
// 全局改写为内建 texture/textureLod——若不先移除包装（其名会被改写为 texture），会与
// GLSL 内建 texture 重复定义冲突。包装改写后成死代码，安全移除。
const TEX_WRAPPER_2DLOD_RE = /vec4\s+texSample2DLod\s*\([^)]*\)\s*\{\s*return\s+textureLod\s*\([^)]*\)\s*;\s*\}/g;
const TEX_WRAPPER_2D_RE = /vec4\s+texSample2D\s*\([^)]*\)\s*\{\s*return\s+texture2D\s*\([^)]*\)\s*;\s*\}/g;

// 迭代展开 WE 内置头 include（头自带 #ifndef guard，迭代安全）。
function expandIncludes(src: string): string {
  let out = src;
  let prev: string;
  do {
    prev = out;
    for (const [name, header] of Object.entries(WE_HEADERS)) {
      out = out.split(`#include "${name}"`).join(header);
    }
  } while (out !== prev);
  return out;
}

// 按 GLSL 类型给缺失 uniform value 的缺省值：
// number→0、vec/mat→全 0 数组、sampler→null（运行时绑定纹理），数组→全 0 数组。
function defaultValueForType(type: string): unknown {
  const vec = type.match(/^vec([234])$/);
  if (vec) return new Array(Number(vec[1])).fill(0);
  const mat = type.match(/^mat([234])$/);
  if (mat) {
    const n = Number(mat[1]);
    return new Array(n * n).fill(0);
  }
  const arr = type.match(/^float\[(\d+)\]$/);
  if (arr) return new Array(Number(arr[1])).fill(0);
  if (type.startsWith('sampler')) return null;
  return 0;
}

// 生成 ②/③ 的宏注入：combos 值优先 → [COMBO] 注释 default 兜底 → #if 未定义裸标识符兜底 0。
// 已 #define 的宏不重复注入（沿用 preprocessWeShader 的逻辑）。
function buildDefines(source: string, combos: Record<string, number>): string[] {
  const defines = new Map<string, string>();
  for (const [k, v] of Object.entries(combos)) defines.set(k, String(v));
  for (const [k, v] of extractComboDefaults(source)) {
    if (!defines.has(k)) defines.set(k, String(v));
  }
  const alreadyDefined = new Set<string>();
  for (const m of source.matchAll(/^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) alreadyDefined.add(m[1]);
  for (const id of extractIfIdentifiers(source)) {
    if (/^\d/.test(id)) continue;
    if (alreadyDefined.has(id)) continue;
    if (defines.has(id)) continue;
    defines.set(id, '0');
  }
  return [...defines.entries()].map(([k, v]) => `#define ${k} ${v}`);
}

// 单 stage 转换：对 rawVert 用 vertex 语义、对 rawFrag 用 fragment 语义。
// bindingOffset：本 stage 的第一个 layout(binding=N) 编号。跨 stage（vert+frag）由
// glslToNagaPass 传续，保证合并 uniforms 后的 binding 全局唯一（wasm 侧据此布置单一 bind group）。
function convertStage(
  src: string,
  stage: Stage,
  combos: Record<string, number>,
  uniforms: Map<string, UniformValue>,
  bindingOffset: number,
): { glsl: string; binds: UniformBindingDesc[] } {
  // ① 展开 WE 内置头 include；未显式 include common.h 则隐式前置（WE 引擎对效果 shader 隐式提供）。
  const hadExplicitCommon = src.includes('#include "common.h"');
  let s = expandIncludes(src);
  if (!hadExplicitCommon) s = WE_HEADERS['common.h'] + '\n' + s;

  // 移除 WE 纹理包装（见 TEX_WRAPPER_* 注释），再全局改写为内建。
  s = s.replace(TEX_WRAPPER_2DLOD_RE, '').replace(TEX_WRAPPER_2D_RE, '');

  // 去掉旧 #version（若原始源有）；④ 去 precision 语句与限定符。
  s = s.replace(/^\s*#version\s+\d+\s*(?:es)?\s*\n/gm, '');
  s = s.replace(/^\s*precision\s+[A-Za-z_][A-Za-z0-9_]*\s+[A-Za-z_][A-Za-z0-9_]*\s*;\s*\n/gm, '');
  s = s.replace(/\b(?:highp|mediump|lowp)\s+/g, '');

  // ⑤ 插值/属性改写：fragment 的 varying→in，vertex 的 varying→out；attribute→in。
  const varyingKw = stage === 'vert' ? 'out' : 'in';
  s = s.replace(/\bvarying\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\w+)\s*;/g, `${varyingKw} $1 $2;`);
  s = s.replace(/\battribute\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\w+)\s*;/g, 'in $1 $2;');

  // ⑥ gl_FragColor（仅 fragment）→ o_Color，引用替换。
  if (stage === 'frag') s = s.replace(/gl_FragColor/g, 'o_Color');

  // ⑦ uniform：抽取声明、注入 layout(binding=N)，并**前置**到 shader 主体前。
  //  naga glsl frontend 要求声明先于引用——common_blur.h 的 blur13a/7a/3a 函数体引用
  //  g_Texture0，而 WE shader 常把 sampler/uniform 声明放在 #include 之后；若不前置
  //  会报 "g_Texture0 : undeclared identifier"（同 preprocessWeShader 的 samplerDecls）。
  //  声明按顺序编号，binding 从 bindingOffset 起全局唯一递增，并据此生成 UniformBindingDesc。
  //  uniforms Map 只存值（number | number[]），type 从 GLSL 声明推导；value 取对应项，缺失给缺省。
  const binds: UniformBindingDesc[] = [];
  let bind = bindingOffset;
  const uniformLines: string[] = [];
  s = s.replace(UNIFORM_LINE_RE, (m, indent, type, name, arrSize) => {
    const typeStr = arrSize ? `${type}[${arrSize}]` : type;
    const binding = bind++;
    const rawValue = uniforms.has(name) ? uniforms.get(name) : undefined;
    // Number 0 / [] 属于合法值，用 ?? 仅在 undefined 时回退缺省（has=true 但值 undefined 的兜底）。
    const value = rawValue === undefined ? defaultValueForType(typeStr) : rawValue;
    binds.push({ name, type: typeStr, value, binding });
    uniformLines.push(`${indent}layout(binding=${binding}) uniform ${type} ${name}${arrSize ? `[${arrSize}]` : ''};`);
    return '\n';
  });
  if (uniformLines.length) s = `${uniformLines.join('\n')}\n${s}`;

  // ⑧ WE 方言纹理函数 → 内建（mul/saturate/frac 等方言函数由 WE_HEADERS 提供，不改写）。
  s = s.replace(/\btexSample2D\s*\(/g, 'texture(');
  s = s.replace(/\btexSample2DLod\s*\(/g, 'textureLod(');
  s = s.replace(/\btexture2D\s*\(/g, 'texture(');

  // ②③ combo/#if 宏注入（须在头与正文之前，使 #if 表达式起效）。
  const defines = buildDefines(s, combos);

  // ⑨ 头部 #version 450；fragment 额外声明输出 o_Color。
  const defBlock = defines.length ? `${defines.join('\n')}\n` : '';
  const oColor = stage === 'frag' ? 'layout(location=0) out vec4 o_Color;\n' : '';
  const glsl = `#version 450\n${defBlock}${oColor}${s}`;

  return { glsl, binds };
}

// WE 方言 → desktop GLSL pass 描述（同步；仅做规则①-⑨ 翻译，不编译 SPIR-V）。
// 供单测断言规则 / 调试；生产 wasm 路径用 glslToNagaPass（含 glslang SPIR-V 编译）。
// 规则①-⑨ 对 rawVert/rawFrag 各自执行；layout(binding=N) 编号跨 stage 全局唯一
// （frag 先编号 [0..n)，vert 接着从 n+1 继续，合并 uniforms 无重复 binding）。
export function glslToNagaGlsl(pass: CompiledEffectPass): NagaPassDesc {
  const frag = convertStage(pass.rawFrag, 'frag', pass.combos, pass.uniforms, 0);
  const vert = convertStage(pass.rawVert, 'vert', pass.combos, pass.uniforms, frag.binds.length);
  return {
    vertGlsl: vert.glsl,
    fragGlsl: frag.glsl,
    uniforms: [...frag.binds, ...vert.binds],
    textureSlots: pass.textureSlots,
    blendMode: pass.blendMode,
  };
}

// WE 方言 → SPIR-V bytes pass 描述（异步；@webgpu/glslang 一次初始化，compileGLSL 随后同步）。
// 输出 `{ vert_spv, frag_spv, uniforms, texture_slots, blend_mode }`（替换 vert_glsl/frag_glsl）。
// glslang 产 SPIR-V 的 entry_point 恒为 `main`（wasm 侧 spv_to_wgsl/naga spv-in 亦解析为 `main`）。
// 编译失败抛错 → 调用方捕获并回退（绝不白屏）。
export async function glslToNagaPass(pass: CompiledEffectPass): Promise<SpvPassDesc> {
  const frag = convertStage(pass.rawFrag, 'frag', pass.combos, pass.uniforms, 0);
  const vert = convertStage(pass.rawVert, 'vert', pass.combos, pass.uniforms, frag.binds.length);
  const glslang = await loadGlslang();
  const vertSpv = u32ToBytes(glslang.compileGLSL(vert.glsl, 'vertex', false));
  const fragSpv = u32ToBytes(glslang.compileGLSL(frag.glsl, 'fragment', false));
  return {
    vertSpv,
    fragSpv,
    uniforms: [...frag.binds, ...vert.binds],
    textureSlots: pass.textureSlots,
    blendMode: pass.blendMode,
  };
}
