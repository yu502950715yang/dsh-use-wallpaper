// src/client/shader/shader-preprocessor.ts
// WE shader 方言预处理：内置头 include 展开 + combo 宏注入 + 属性名改写 + uniform 标注提取。
import { WE_HEADERS } from './we-headers.js';

export interface UniformAnnotation {
  name: string;
  type: string;
  annotation?: Record<string, unknown>;
}

// uniform 声明正则：支持 sampler2D / float / vec2..4 / float[N] 数组
// （GLSL 数组后缀在变量名后：uniform float g_AudioSpectrum16Left[16];）
const UNIFORM_RE = /uniform\s+([\w]+)\s+(\w+)(?:\[(\d+)\])?\s*;\s*(?:\/\/\s*(\{[\s\S]*?\}))?/g;

export function extractUniformAnnotations(source: string): UniformAnnotation[] {
  const out: UniformAnnotation[] = [];
  for (const m of source.matchAll(UNIFORM_RE)) {
    // 数组 uniform：type 输出 "float[16]" 形式（组3 为数组大小，并入类型）
    const type = m[3] ? `${m[1]}[${m[3]}]` : m[1];
    let annotation: Record<string, unknown> | undefined;
    if (m[4]) {
      try { annotation = JSON.parse(m[4]); } catch { annotation = undefined; }
    }
    out.push({ name: m[2], type, annotation });
  }
  return out;
}

// 属性改写：WE 方言 attribute 名 → three 几何体属性名。
// three 的 ShaderMaterial 前缀已声明 position/uv（WebGLProgram 自动注入），
// WE shader 的 `attribute vec3 a_Position;` 声明行必须**删除**（保留会在 GLSL 中
// 与 three 前缀重复定义 position/uv → redefinition 编译错误），
// 函数体内的 a_Position/a_TexCoord 引用改写为 position/uv 即可。
function rewriteAttributes(src: string): string {
  return src
    // 删除 WE 的 attribute 声明行（three 前缀已声明 position/uv）
    .split('attribute vec3 a_Position;').join('')
    .split('attribute vec2 a_TexCoord;').join('')
    // 引用改写：a_Position → position、a_TexCoord → uv
    .split('a_Position').join('position')
    .split('a_TexCoord').join('uv');
}

// 提取 shader 中 `#if <expr>` 表达式里出现的裸标识符（含 combo 条件宏）：
// GLSL ES 3.00 预处理器不允许 #if 中出现未定义标识符（C 语义按 0 处理，GLSL 直接报
// "unexpected token after conditional expression"），因此对 scene.json 未提供的
// combo 宏必须注入默认 `#define X 0`。跳过：数字、defined(...) 参数、已 #define 的、
// combos 已注入的、以及 #ifdef/#ifndef 引用的宏（那些语义是"是否定义"，不能注入）。
function extractIfIdentifiers(src: string): Set<string> {
  const out = new Set<string>();
  // 逐行匹配 #if 表达式（非 #ifdef/#ifndef）
  for (const m of src.matchAll(/^\s*#if\s+(.+)$/gm)) {
    const expr = m[1]
      .replace(/defined\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, '') // 去掉 defined(X)
      .replace(/\/\/.*$/, '');
    for (const id of expr.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      out.add(id[0]);
    }
  }
  return out;
}

// 提取 shader 中 `// [COMBO] {...}` 注释声明的组合宏默认值：
// WE 引擎语义——COMBO 注释（如 Simple_Audio_Bars 的
// `// [COMBO] {"combo":"BLENDMODE","default":0}`）声明了宏及其默认值，
// scene.json 未覆写时按 default 注入（BLENDMODE 只在 ApplyBlending 调用中出现、
// 不在 #if 表达式内，extractIfIdentifiers 提取不到，必须从注释兜底）。
function extractComboDefaults(src: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of src.matchAll(/\[COMBO\]\s*\{[^}]*"combo"\s*:\s*"([A-Za-z_][A-Za-z0-9_]*)"[^}]*"default"\s*:\s*(-?\d+(?:\.\d+)?)/g)) {
    out.set(m[1], Number(m[2]));
  }
  return out;
}

// GLSL ES 3.00 严格模式修正：int 字面量不能隐式参与浮点运算/赋值/函数重载
// （GLSL1 允许、GLSL3 报 "cannot convert from 'const int' to 'highp float'"、
// "wrong operand types" 或 "no matching overloaded function"）。
// 策略：先把**明确的 int 上下文**（数组下标、for 循环头、int/ivec 声明、位运算）
// 用占位符保护，再把剩余裸 int 字面量统一补 `.0`（浮点/构造/函数参数上下文），
// 最后还原保护段。全库实测覆盖：`v_TexCoord.z = 0;`、`float mask = 1;`、
// `1 - g_Rough`、`smoothstep(..., 1, ...)`、`mix(blurred.a, 1, ...)`、`vec4(1, -1, ...)`。
function normalizeFloatIntLiterals(src: string): string {
  // 占位符用不含数字的 token（避免被下方裸 int 正则二次改写）
  const protectedBlocks: string[] = [];
  let out = src;
  const protect = (m: string) => {
    const token = `__WEI_PROTECTED_${protectedBlocks.length.toString(36)}__`;
    protectedBlocks.push(m);
    return token;
  };
  // 保护 int 上下文（不补 .0）：
  //  - 预处理指令整行（#if/#elif/#define 等：表达式中数字是整数常量，
  //    `#define SHAPE 0` 补成 0.0 会让 `#if SHAPE == BOTTOM` 报浮点比较非法）
  //  - for 循环头（int 计数）：for (int i = 0; i < N; ++i)
  //  - 数组下标/数组大小：g_AudioSpectrum16Left[i * 2] / uniform float g_A[16]
  //  - int/ivec 声明与构造：int i = 0; ivec2(1, 2)
  //  - 比较运算中的整数字面量：mode == 9（ApplyBlending 的 int 比较，
  //    补 .0 后 int==float 报错）；全库无"变量与 int 比较"的 float 场景
  out = out.replace(/^\s*#(?:if|elif|ifdef|ifndef|define).*$/gm, protect);
  out = out.replace(/for\s*\([^)]*\)/g, protect);
  out = out.replace(/\[[^\]]*\]/g, protect);
  out = out.replace(/\b(?:ivec[234])\s*\([^)]*\)/g, protect);
  out = out.replace(/\bint\s+\w+\s*(?:\[[^\]]*\])?\s*(?:=|;)/g, protect);
  out = out.replace(/(?:==|!=|<=|>=|<|>)\s*-?\d+(?![\w.])/g, protect);
  // 剩余裸 int 字面量补 .0（浮点上下文；1.0 之类已有小数点的不会被匹配，
  // 因为数字前不允许 . 或字母、数字后不允许 . 或字母）
  out = out.replace(/(?<![\w.])-?\d+(?![\w.])/g, (m) => `${m}.0`);
  // 还原保护段
  protectedBlocks.forEach((block, i) => {
    out = out.replace(`__WEI_PROTECTED_${i.toString(36)}__`, block);
  });
  return out;
}

// GLSL ES 3.00 严格模式修正：
//  - `const X = <非常量表达式>`（如 `const float threshold = pow(u_t, u_g)`、
//    `const vec2 multiplier = g_TexelSize * u_radius`）：GLSL1 允许 const 用
//    运行时表达式初始化，GLSL3 只允许编译期常量 → 降级为普通变量声明。
//  - 全局变量非常量初始化：GLSL3 全局初始化器必须是编译期常量（GLSL1 允许
//    运行时表达式）。把 main() 前的 `type name = <非常量>;` 拆为声明 `type name;`
//    + main 开头 `name = <非常量>;`（保持语义，仅移动初始化时机）。函数内的
//    局部非常量初始化 GLSL3 合法，不动。
//  - 保留字 `sample`（GLSL3 保留字，GLSL1 不是）：light_map.frag 等用 `sample`
//    作变量名 → 改写为 `sample_`（语义不变，仅标识符）。
function relaxGlsl3Strictness(src: string): string {
  let out = src
    // const 非常量初始化 → 去 const（局部与全局都处理；纯字面量保持 const）
    .replace(/\bconst\s+(float|int|vec[234]|mat[234])\s+(\w+)\s*=\s*([^;]*[A-Za-z_][^;]*);/g,
      (m, type, name, expr) => {
        const trimmed = expr.trim();
        if (/^-?[\d.]+$/.test(trimmed) || /^(true|false)$/.test(trimmed)) return m;
        return `${type} ${name} = ${expr};`;
      })
    // GLSL3 保留字 → 改写下划线后缀（GLSL1 允许作标识符，GLSL3 报
    // "Illegal use of reserved word"）：sample（light_map 等 12 shader）、
    // pointer（chromatic_aberration 2 shader）。
    // 注意 \b 边界：texSample2D 中 sample 前后是单词字符，不匹配 ✓；
    // noiseSample/sampleDrop 中 sample 前后是单词字符，不匹配 ✓。
    .replace(/\b(sample|pointer)\b/g, '$1_');
  // 全局非常量初始化 → 声明留在原处、初始化移入 main() 开头。
  // 只处理**真正的全局作用域**：main() 之前且不在任何函数体 `{ }` 内
  // （squareToQuad/CreateAudioResponse 等函数的局部初始化 GLSL3 合法，不动）。
  const lines = out.split('\n');
  let mainIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*void\s+main\s*\(/.test(lines[i])) { mainIdx = i; break; }
  }
  if (mainIdx > 0) {
    const moved: string[] = [];
    let depth = 0; // 花括号深度：0 = 全局作用域
    let inComment = false;
    for (let i = 0; i < mainIdx; i++) {
      const l = lines[i];
      if (l.trim().startsWith('//')) continue;
      // 括号深度统计（忽略字符串/注释内的花括号——WE shader 简单，近似足够）
      for (const ch of l) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (depth !== 0) continue; // 函数体内 → 跳过
      const m = l.match(/^\s*(float|int|vec[234]|mat[234])\s+(\w+)\s*=\s*([^;]*[A-Za-z_][^;]*);\s*$/);
      if (!m) continue;
      const expr = m[3].trim();
      if (/^-?[\d.]+$/.test(expr) || /^(true|false)$/.test(expr)) continue; // 纯常量
      if (/^(?:CAST[234]|vec[234]|mat[234])\s*\(\s*-?[\d.]+\s*\)$/.test(expr)) continue; // 纯常量构造
      // 拆分：原位置保留 `type name;`，初始化语句插入 main 第一行后
      lines[i] = l.replace(`= ${expr};`, ';');
      moved.push(`\t${m[2]} = ${expr};`);
    }
    if (moved.length) lines.splice(mainIdx + 1, 0, ...moved);
  }
  return lines.join('\n');
}

export function preprocessWeShader(source: string, combos: Record<string, number>): string {
  // GLSL 先声明后使用：sampler uniform 声明前置。
  // common_blur.h 的 blur13a/blur7a/blur3a 引用 g_Texture0，而 WE shader 源码中
  // sampler 声明在 include 之后 → 若不前置会 "g_Texture0 : undeclared identifier"。
  const samplerDecls: string[] = [];
  const src = source.replace(/^\s*(uniform\s+sampler\w+\s+\w+\s*;.*)$/gm, (m) => {
    samplerDecls.push(m.trim());
    return '';
  });
  let out = src;
  const hadExplicitCommon = out.includes('#include "common.h"');
  // 展开内置头 include（仅处理 WE_HEADERS 已知的头；未知 include 保留原样）
  for (const [name, header] of Object.entries(WE_HEADERS)) {
    out = out.split(`#include "${name}"`).join(header);
  }
  // WE 引擎对所有效果 shader 隐式提供基础函数头（common.h）：
  // 全库实测 114/182 个 shader 无任何 include 却直接调用 mul/texSample2D/frac 等，
  // 故未显式 include common.h 的 shader 前置注入（guard 宏防止与显式 include 重复）
  if (!hadExplicitCommon) {
    out = WE_HEADERS['common.h'] + '\n' + out;
  }
  out = rewriteAttributes(out);
  out = normalizeFloatIntLiterals(out);
  out = relaxGlsl3Strictness(out);
  // 注入 combo 宏（scene.json 提供的值优先，其余按 [COMBO] 注释 default 兜底）
  const defines = new Map<string, string>();
  for (const [k, v] of Object.entries(combos)) defines.set(k, String(v));
  // [COMBO] 注释声明的宏：scene.json 未提供时按 default 注入
  // （BLENDMODE 只在 ApplyBlending 调用中出现，不在 #if 内，extractIfIdentifiers 提取不到）
  for (const [k, v] of extractComboDefaults(out)) {
    if (!defines.has(k)) defines.set(k, String(v));
  }
  // #if 裸标识符兜底：未定义 → #define X 0（GLSL ES 3.00 要求 #if 标识符已定义）
  const alreadyDefined = new Set<string>();
  for (const m of out.matchAll(/^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) alreadyDefined.add(m[1]);
  for (const id of extractIfIdentifiers(out)) {
    if (/^\d/.test(id)) continue;
    if (alreadyDefined.has(id)) continue;
    if (defines.has(id)) continue;
    defines.set(id, '0');
  }
  const defineLines = [...defines.entries()].map(([k, v]) => `#define ${k} ${v}`);
  // 前置组合：combo 宏 → sampler 声明 → shader 主体（sampler 必须在任何引用前）
  const prefix = [...defineLines, ...samplerDecls];
  return prefix.length ? `${prefix.join('\n')}\n${out}` : out;
}
