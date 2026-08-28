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
import { extractIfIdentifiers, extractComboDefaults, normalizeFloatIntLiterals, floatifyIntVarUses, relaxGlsl3Strictness } from './shader-preprocessor.js';
import type { CompiledEffectPass } from './effect-chain.js';
import type { UniformValue } from './uniform-binder.js';
import * as glslangNS from '@webgpu/glslang';

export interface UniformBindingDesc {
  name: string;
  type: string;
  value: unknown;
  binding: number;
  /// std140 block 布局描述（仅非不透明 uniform 有；sampler/独立声明无）。
  /// offset/size 为字节；blockName 为所属 uniform block 名（block 成员共用）。
  /// JS 侧据此生成 `layout(binding=N) uniform sampler2D ...`（sampler，无 offset）或
  /// `layout(std140, binding=B) uniform <blockName> { ... };`（非不透明 block 成员）。
  offset?: number;
  size?: number;
  blockName?: string;
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

// 用户可变接口（vertex 的 in/out、fragment 的 in）需要 layout(location=N)（glslang Vulkan 硬性要求：
// "SPIR-V requires location for user input/output"。内置 gl_Position/gl_FragCoord 不声明，无此列）。
// 顶点 in（attribute，来自 a_Position/a_TexCoord）与 out（varying）分属不同接口 space，各自从 0 编号；
// 片元 in（varying）从 0 编号。顶点 out 与片元 in 都按声明顺序编号，且在有效果 shader 中 varyings
// 的 vert/frag 声明顺序一致，故同名 varying 得到相同 location（vertex 输出 ↔ fragment 输入匹配）。
// 已带 layout(location=...) 的声明（如 o_Color）跳过。另支持数组 varying/attribute：
// `varying vec2 v_TexCoord[4];`（WE 效果 shader 的 blur/downsample 多用，名字后有 `[N]`）。
const DECL_IO_RE = /^(\s*)(in|out)\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\w+)(\s*\[\s*\d+\s*\])?\s*;(.*)$/;

function assignInterfaceLocations(src: string, stage: Stage): string {
  const out: string[] = [];
  let fragInLoc = 0;
  let vertInLoc = 0;
  let vertOutLoc = 0;
  for (const line of src.split('\n')) {
    const hasLayout = /layout\s*\(\s*location\s*=/.test(line);
    const m = DECL_IO_RE.exec(line);
    if (m && !hasLayout) {
      const [, indent, io, type, name, arr, rest] = m;
      const decl = `${indent}layout(location=`;
      if (stage === 'frag') {
        // fragment 的 in = varying；out 只有 o_Color（已带 layout，不重排）。
        if (io === 'in') out.push(`${decl}${fragInLoc++}) in ${type} ${name}${arr ?? ''};${rest}`);
        else out.push(line);
      } else {
        if (io === 'in') out.push(`${decl}${vertInLoc++}) in ${type} ${name}${arr ?? ''};${rest}`);
        else out.push(`${decl}${vertOutLoc++}) out ${type} ${name}${arr ?? ''};${rest}`);
      }
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

// WE 方言纹理包装函数（common.h 提供）。规则⑧会把 texSample2D/texSample2DLod/texture2D
// 全局改写为内建 texture/textureLod——若不先移除包装（其名会被改写为 texture），会与
// GLSL 内建 texture 重复定义冲突。包装改写后成死代码，安全移除。
const TEX_WRAPPER_2DLOD_RE = /vec4\s+texSample2DLod\s*\([^)]*\)\s*\{\s*return\s+textureLod\s*\([^)]*\)\s*;\s*\}/g;
const TEX_WRAPPER_2D_RE = /vec4\s+texSample2D\s*\([^)]*\)\s*\{\s*return\s+texture2D\s*\([^)]*\)\s*;\s*\}/g;

// GLSL 4.50（Vulkan）要求 max/min/clamp 操作数同维度；WE 效果 shader 沿用 HLSL 标量广播
// 习惯（`max(0, albedo.rgb)`），desktop GLSL 编译报 "no matching overloaded function"。
// 此处把 max/min/clamp 中**标量字面量实参**广播为同维度构造（`vecN(标量)`）。仅处理能由
// .swizzle 明确判定 2/3/4 维的实参（如 albedo.rgb/.rgba/.xy）；无法判定维度的（裸变量/
// 嵌套表达式/纯标量 max(0.001, weight)）跳过，避免误伤合法标量调用。
function broadcastScalarOperand(src: string): string {
  const swizzleDim = (expr: string): number | null => {
    const m = expr.match(/\.(rgba|xyzw|rgb|xyz|rg|xy)$/);
    if (!m) return null;
    return m[1].length === 4 ? 4 : m[1].length === 3 ? 3 : 2;
  };
  const vecOf = (dim: number) => `vec${dim}`;
  return src
    // max|min|clamp( <数字> , <ident.swizzle> )：把数字广播成向量
    .replace(/\b(max|min|clamp)\(\s*(-?\d+(?:\.\d+)?)\s*,\s*([A-Za-z_]\w*\s*\.\s*(?:rgba|xyzw|rgb|xyz|rg|xy))\s*\)/g,
      (m, fn, num, exp) => {
        const dim = swizzleDim(exp);
        return dim ? `${fn}(${vecOf(dim)}(${num}), ${exp})` : m;
      })
    // max|min|clamp( <ident.swizzle> , <数字> )
    .replace(/\b(max|min|clamp)\(\s*([A-Za-z_]\w*\s*\.\s*(?:rgba|xyzw|rgb|xyz|rg|xy))\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g,
      (m, fn, exp, num) => {
        const dim = swizzleDim(exp);
        return dim ? `${fn}(${exp}, ${vecOf(dim)}(${num}))` : m;
      });
}

// GLSL 不允许 vec4→vec3/vec2 隐式降维，但 WE 效果 shader 沿用 HLSL 习惯直接
// `vec3 c = texSample2D(...)`（隐式丢 alpha）。转换后成为 `vec3 c = texture(...)`，glslang
// 报 "cannot convert from vec4 to vec3"。仅当 RHS 为**完整的纯 texture(...) 调用**（以 ')' 结尾，
// 未带 .swizzle / 后续运算）时补 swizzle（vec3→.rgb、vec2→.xy）；`texture(...).xyz * 2 - 1`
// 之类 RHS 已是表达式（结果已定维）不碰，避免把 .rgb 误接到数字/标识符上。
function fixVectorAssignFromTexture(src: string): string {
  return src.replace(/\b(vec3|vec2)\s+(\w+)\s*=\s*(texture\([^;]*);/g, (m, type, name, call) => {
    if (!/\)\s*$/.test(call)) return m;
    const swizzle = type === 'vec3' ? 'rgb' : 'xy';
    return `${type} ${name} = ${call}.${swizzle};`;
  });
}

// WE 方言：标量字面量后跟 .rgb/.rgba/.rg 表示广播成向量（如 `1.0.rgb` = vec3(1.0)，
// 常见于 `* 2.0 - 1.0.rgb` 之类）。GLSL 对 float 值 .rgb 报 "vector swizzle out of range"。
// 用 lookbehind 排除变量名（x.rgb 是合法 swizzle），仅对纯数字字面量展开为 vecN(标量)。
function broadcastFloatSwizzle(src: string): string {
  return src.replace(/(?<![A-Za-z0-9_])(-?\d+(?:\.\d+)?)\s*\.\s*(rgba|rgb|rg)\b/g,
    (m, num, sw) => `vec${sw.length}(${num})`);
}



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
  const arr = type.match(/^[A-Za-z_][A-Za-z0-9_]*\[(\d+)\]$/);
  if (arr) return new Array(Number(arr[1])).fill(0);
  if (type.startsWith('sampler')) return null;
  return 0;
}

// =====================================================================
// std140 布局（glslang Vulkan 目标硬性要求：非不透明 uniform 必须包进 uniform block，
// 且 block 按 std140 对齐）。JS 侧只算 **偏移/size**（生成 block 声明 + 给 wasm 的布局描述）；
// 实际的逻辑 value→字节铺位打包在 wasm `pack_std140_block`（见 effect.rs）。std140TypeInfo 的
// align/size 与 glslang 实测一致（research/glslang-spike/dump_std140.cjs）。
// 规则（GLSL 4.60 §4.5.7.2）：float/int/bool align 4/size 4；vec2 align 8/size 8；
//   vec3 align 16/size 12；vec4 align 16/size 16；matN align 16/size N*16（列 pitch 恒 16B）count=N²；
//   数组元素 stride = roundup(elem_size,16) = max(elem_size,16) ⇒ size=N*stride（**用 elem_size，
//   矩阵元素 size>16；mat4[2]=128B**）；block size = roundup(max(offset+size),16)。
// =====================================================================

/// 单个 std140 字段的类型信息：align/size（字节）/count（逻辑 float 数，即 value 数组长度）。
export interface Std140TypeInfo {
  align: number;
  size: number;
  count: number;
}

export function std140TypeInfo(typeStr: string): Std140TypeInfo | null {
  // 数组：查 `[` 前缀再递归（覆盖 float/int/uint/bool/vec/mat 的 `[N]`）。元素 stride =
  // roundup(elem_size,16) = max(elem_size,16)——必须用 elem_size 而非 elem_align（矩阵元素
  // size>16，mat4[2] 应为 2*64=128B 而非 2*16=32B，reviewer Important #1）。
  const arrBase = typeStr.indexOf('[');
  if (arrBase >= 0) {
    const elem = std140TypeInfo(typeStr.slice(0, arrBase));
    if (!elem) return null;
    const elemStride = Math.max(elem.size, 16);
    const n = Number(typeStr.slice(arrBase + 1, typeStr.length - 1));
    return { align: 16, size: n * elemStride, count: n * elem.count };
  }
  const vec = typeStr.match(/^vec([234])$/);
  if (vec) {
    const n = Number(vec[1]);
    return { align: n === 2 ? 8 : 16, size: n === 3 ? 12 : n * 4, count: n };
  }
  if (typeStr === 'float' || typeStr === 'int' || typeStr === 'uint' || typeStr === 'bool') {
    return { align: 4, size: 4, count: 1 };
  }
  const mat = typeStr.match(/^mat([234])$/);
  if (mat) {
    const n = Number(mat[1]);
    return { align: 16, size: n * 16, count: n * n };
  }
  return null;
}

// JS 侧只保留 `std140TypeInfo` 供 block 偏移计算（convertStage 内联使用）。实际的 value→字节铺位
// 打包在 wasm `pack_std140_block`（注意：JS 侧删除了重复的 std140WritePlan/packStd140* 孤儿副本，
// 避免与 Rust 维护两份且再次引入 mat[N] stride bug，reviewer Minor #3）。

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
): { glsl: string; binds: UniformBindingDesc[]; nextBinding: number } {
  // ① 展开 WE 内置头 include；未显式 include common.h 则隐式前置（WE 引擎对效果 shader 隐式提供）。
  // 先统一行尾（WE 安装目录 shader 为 CRLF，`\r` 会让 `(.*)$`/`$` 类正则锚点失配——JS `.` 不匹配 `\r`）。
  const hadExplicitCommon = src.includes('#include "common.h"');
  let s = expandIncludes(src.replace(/\r\n?/g, '\n'));
  if (!hadExplicitCommon) s = WE_HEADERS['common.h'] + '\n' + s;

  // 移除 WE 纹理包装（见 TEX_WRAPPER_* 注释），再全局改写为内建。
  s = s.replace(TEX_WRAPPER_2DLOD_RE, '').replace(TEX_WRAPPER_2D_RE, '');

  // 去掉旧 #version（若原始源有）；④ 去 precision 语句与限定符。
  s = s.replace(/^\s*#version\s+\d+\s*(?:es)?\s*\n/gm, '');
  s = s.replace(/^\s*precision\s+[A-Za-z_][A-Za-z0-9_]*\s+[A-Za-z_][A-Za-z0-9_]*\s*;\s*\n/gm, '');
  s = s.replace(/\b(?:highp|mediump|lowp)\s+/g, '');

  // ④' WE 方言严格模式修正（复用 three 路径 shader-preprocessor 的成熟三连）。wasm 编译链
  // 此前漏跑这组修正，导致真实 WE 效果 shader 在 glslang(Vulkan/desktop GLSL 4.50) 报
  //  - `sample` 保留字 → `unexpected SAMPLE`（godrays_cast/pulse/shine 等）；
  //  - `max(0, vec3)` 之类 int/float 字面量混用 → `no matching overloaded`（nitro 等）；
  //  - `const float x = <运行期表达式>` → const 降级（common_blur/blending 等）；
  //  - int 变量/字面量参与浮点运算 → desktop 也需显式转换（1.0/sampleCount 等）。
  //  顺序：normalize 补 .0 → floatify 包 float()（依赖 .0 已补）→ relax 去 const/改保留字。
  s = normalizeFloatIntLiterals(s);
  s = floatifyIntVarUses(s);
  s = relaxGlsl3Strictness(s);

  // ④'' WE 自定义 sampler 类型 → Desktop/Vulkan 标准名。`sampler2DComparison` 是
  // WE 的深度比较采样类型（GLSL 3.30 方言名），Vulkan GLSL 无此名（应 sampler2DShadow），
  // 效果链仅需取其采样值，降级为 sampler2D 采样原深度图（fluidsimulation_combine 等）。
  s = s.replace(/\bsampler2DComparison\b/g, 'sampler2D');

  // ⑤ 插值/属性改写：fragment 的 varying→in，vertex 的 varying→out；attribute→in。
  // 支持数组 varying/attribute（`varying vec2 v_TexCoord[4];`，blur/downsample 效果用）。
  const varyingKw = stage === 'vert' ? 'out' : 'in';
  s = s.replace(/\bvarying\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\w+)(\s*\[\s*\d+\s*\])?\s*;/g, (m, type, name, arr) => `${varyingKw} ${type} ${name}${arr ?? ''};`);
  s = s.replace(/\battribute\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\w+)(\s*\[\s*\d+\s*\])?\s*;/g, (m, type, name, arr) => `in ${type} ${name}${arr ?? ''};`);

  // ⑤' 用户可变接口 location（glslang Vulkan 硬性要求，见 assignInterfaceLocations 注释）。
  s = assignInterfaceLocations(s, stage);

  // ⑥ gl_FragColor（仅 fragment）→ o_Color，引用替换。
  if (stage === 'frag') s = s.replace(/gl_FragColor/g, 'o_Color');

  // ⑦ uniform：分类为非不透明（进 std140 block）与不透明 sampler（独立声明），并**前置**到 shader 主体前。
  //  glslang（Vulkan 目标）硬性要求非不透明 uniform 必须包进 uniform block（否则报
  //  "non-opaque uniforms outside a block"）。sampler/image 为不透明，可独立 `layout(binding=N) uniform sampler2D`。
  //  naga glsl frontend 要求声明先于引用——common_blur.h 的 blur13a/7a/3a 引用 g_Texture0，
  //  while WE shader 常把声明放 #include 后；不前置会报 "undeclared identifier"。
  //  规则⑦（std140 block，无实例名→成员全局可见，shader 体引用无需改前缀）：
  //    layout(std140, binding=B) uniform Params { <type> <name>; ... };   // 非不透明，block 成员
  //    layout(binding=N) uniform sampler2D <name>;                       // sampler，独立
  //  binding 按声明顺序编号：sampler 各自递增；非不透明首现时分配 block binding（block 全体共用）。
  //  uniforms Map 只存值（number | number[]）；type 从 GLSL 声明推导；缺失给缺省。
  //  非 block 成员额外产出 offset/size/blockName（std140 布局描述），供 wasm 按同一布局打包。
  const binds: UniformBindingDesc[] = [];
  let bind = bindingOffset;
  // samplerCount：本 stage 的 sampler（组合采样器）个数。spirv-webgpu-transform 拆组合采样器时
  // 每个 sampler2D 合法消费 **2 个** binding 槽（1 texture + 1 sampler），而非本函数编号用的 1 个。
  // 故 `nextBinding = bind + samplerCount`（= offset + 2*#sampler + #block）才是该 stage 拆分后的
  // 实际 binding 上限——下游 stage（vert 从 frag.nextBinding 继续）以此错开，避免跨 stage 因
  // transform 扩展而 binding 碰撞（task-16 根因）。
  let samplerCount = 0;
  const decls: { type: string; name: string; arrSize?: string }[] = [];
  s = s.replace(UNIFORM_LINE_RE, (m, indent, type, name, arrSize) => {
    decls.push({ type, name, arrSize });
    return '\n';
  });
  if (decls.length) {
    const opaqueLines: string[] = [];
    const nonOpaque: { type: string; name: string; arrSize?: string; typeStr: string; offset: number; size: number }[] = [];
    let blockBinding: number | null = null;
    let blockOffset = 0;
    for (const d of decls) {
      const typeStr = d.arrSize ? `${d.type}[${d.arrSize}]` : d.type;
      if (d.type.startsWith('sampler')) {
        samplerCount++;
        const binding = bind++;
        const rawValue = uniforms.has(d.name) ? uniforms.get(d.name) : undefined;
        binds.push({
          name: d.name,
          type: typeStr,
          value: rawValue === undefined ? defaultValueForType(typeStr) : rawValue,
          binding,
        });
        opaqueLines.push(`layout(binding=${binding}) uniform ${d.type} ${d.name}${d.arrSize ? `[${d.arrSize}]` : ''};`);
      } else {
        // 非不透明 → std140 block 成员（无实例名，成员全局可见）。按声明顺序排布，offset 增量计算
        // （与 glslang std140 一致，见 std140TypeInfo）；block 首个成员分配 block binding（全体共用）。
        if (blockBinding === null) blockBinding = bind++;
        const info = std140TypeInfo(typeStr);
        const align = info?.align ?? 16;
        const size = info?.size ?? 0;
        blockOffset = (blockOffset + align - 1) & ~(align - 1);
        const offset = blockOffset;
        blockOffset += size;
        const rawValue = uniforms.has(d.name) ? uniforms.get(d.name) : undefined;
        binds.push({
          name: d.name,
          type: typeStr,
          value: rawValue === undefined ? defaultValueForType(typeStr) : rawValue,
          binding: blockBinding,
          offset,
          size,
          blockName: 'Params',
        });
        nonOpaque.push({ type: d.type, name: d.name, arrSize: d.arrSize, typeStr, offset, size });
      }
    }
    if (nonOpaque.length) {
      const blockName = 'Params';
      const memberLines = nonOpaque.map((m) => `${m.type} ${m.name}${m.arrSize ? `[${m.arrSize}]` : ''};`);
      opaqueLines.unshift(`layout(std140, binding=${blockBinding}) uniform ${blockName} {\n${memberLines.join('\n')}\n};\n`);
    }
    // 前置：std140 block + sampler 声明 → 主体前（声明先于引用）。无实例名，成员全局可见。
    if (opaqueLines.length) s = `${opaqueLines.join('\n')}\n${s}`;
  }

  // ⑧ WE 方言纹理函数 → 内建（mul/saturate/frac 等方言函数由 WE_HEADERS 提供，不改写）。
  s = s.replace(/\btexSample2D\s*\(/g, 'texture(');
  s = s.replace(/\btexSample2DLod\s*\(/g, 'textureLod(');
  s = s.replace(/\btexture2D\s*\(/g, 'texture(');

  // ⑧' 标量-向量广播（desktop GLSL 4.50 硬性要求，见 broadcastScalarOperand 注释）。
  s = broadcastScalarOperand(s);

  // ⑧'' 标量字面量 .rgb/.rgba/.rg 广播（1.0.rgb = vec3(1.0)，见 broadcastFloatSwizzle）。
  s = broadcastFloatSwizzle(s);

  // ⑧''' vec4→vec3/2 隐式降维（shimmer 等：vec3 c = texture(...)），见 fixVectorAssignFromTexture。
  s = fixVectorAssignFromTexture(s);

  // ②③ combo/#if 宏注入（须在头与正文之前，使 #if 表达式起效）。
  const defines = buildDefines(s, combos);

  // ⑨ 头部 #version 450；fragment 额外声明输出 o_Color。
  const defBlock = defines.length ? `${defines.join('\n')}\n` : '';
  const oColor = stage === 'frag' ? 'layout(location=0) out vec4 o_Color;\n' : '';
  const glsl = `#version 450\n${defBlock}${oColor}${s}`;

  return { glsl, binds, nextBinding: bind + samplerCount };
}

// WE 方言 → desktop GLSL pass 描述（同步；仅做规则①-⑨ 翻译，不编译 SPIR-V）。
// 供单测断言规则 / 调试；生产 wasm 路径用 glslToNagaPass（含 glslang SPIR-V 编译）。
// 规则①-⑨ 对 rawVert/rawFrag 各自执行；layout(binding=N) 编号跨 stage 全局唯一
// （frag 先编号 [0..n)，vert 从 frag.nextBinding（下一个空闲 binding）继续，合并 uniforms 无重复 binding）。
export function glslToNagaGlsl(pass: CompiledEffectPass): NagaPassDesc {
  const frag = convertStage(pass.rawFrag, 'frag', pass.combos, pass.uniforms, 0);
  const vert = convertStage(pass.rawVert, 'vert', pass.combos, pass.uniforms, frag.nextBinding);
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
  const vert = convertStage(pass.rawVert, 'vert', pass.combos, pass.uniforms, frag.nextBinding);
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
