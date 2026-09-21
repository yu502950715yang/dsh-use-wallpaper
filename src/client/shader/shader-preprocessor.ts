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
// 注解 JSON 可能含**嵌套对象**（`"require":{"DIRECTDRAW":0}`、`"options":{...}`），故先抓到行尾、
// 再由 takeBalancedJson 截出首个配对完整的对象（非贪婪 `\{.*?\}` 会在内层 `}` 截断，注解整体丢失）。
const UNIFORM_RE = /uniform\s+([\w]+)\s+(\w+)(?:\[(\d+)\])?\s*;\s*(?:\/\/\s*(\{[^\n]*\}))?/g;

/** 取首个配对完整的 `{...}`（容忍行尾多余字符）；无完整配对返回 null。 */
function takeBalancedJson(text: string): string | null {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(0, i + 1);
  }
  return null;
}

export function extractUniformAnnotations(source: string): UniformAnnotation[] {
  const out: UniformAnnotation[] = [];
  for (const m of source.matchAll(UNIFORM_RE)) {
    // 数组 uniform：type 输出 "float[16]" 形式（组3 为数组大小，并入类型）
    const type = m[3] ? `${m[1]}[${m[3]}]` : m[1];
    let annotation: Record<string, unknown> | undefined;
    if (m[4]) {
      const json = takeBalancedJson(m[4]);
      if (json) {
        try { annotation = JSON.parse(json); } catch { annotation = undefined; }
      }
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
// 导出供 glsl-to-naga（wasm 路径）复用（Task B；导出不改变既有行为）。
export function extractIfIdentifiers(src: string): Set<string> {
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
// 导出供 glsl-to-naga（wasm 路径）复用（Task B；导出不改变既有行为）。
export function extractComboDefaults(src: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of src.matchAll(/\[COMBO\]\s*\{[^}]*"combo"\s*:\s*"([A-Za-z_][A-Za-z0-9_]*)"[^}]*"default"\s*:\s*(-?\d+(?:\.\d+)?)/g)) {
    out.set(m[1], Number(m[2]));
  }
  return out;
}

// varying 声明跨 stage 一致化：只在「宽侧 vert / 窄侧 frag / 同为 vec 族 / frag 内全是 swizzle 用法」时把 frag 声明提升为 vert 类型（语义等价），其余不改 + 告警。
// 对应 lwe ShaderUnit.cpp:379 applyLinkedVaryingCompatibility（反方向：改写顶点侧赋值）与 :417 applyFragmentTexCoordCompatibility（frag 整体用法补 .xy），本库均未实现。
const VARYING_DECL_RE = /^[ \t]*varying[ \t]+(vec[234]|float|mat[234])[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*;/gm;
// 分量数排序：float=1 < vec2=2 < vec3=3 < vec4=4；mat2=4 < mat3=9 < mat4=16
const VARYING_COMPONENTS: Record<string, number> = { float: 1, vec2: 2, vec3: 3, vec4: 4, mat2: 4, mat3: 9, mat4: 16 };
const VEC_VARYING_TYPES = new Set(['vec2', 'vec3', 'vec4']);

/** 抓 `varying <type> <name>;` 声明映射（同名多次声明时后者覆盖）。 */
function extractVaryingDecls(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(VARYING_DECL_RE)) out.set(m[2], m[1]);
  return out;
}

/** name 的每处出现（剔除其声明行后）是否都紧跟 `.`（纯分量/swizzle 访问）。 */
function usesOnlySwizzle(src: string, name: string): boolean {
  const body = src.replace(
    new RegExp(`^[ \\t]*varying[ \\t]+(?:vec[234]|float|mat[234])[ \\t]+${name}[ \\t]*;`, 'gm'),
    '',
  );
  const re = new RegExp(`\\b${name}\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    // 跳过空白后必须是 `.`（`foo(v_TexCoord)`、`texture2D(t, v_TexCoord)` 这类整体用法 ⇒ 放弃）
    if (!/^\s*\./.test(body.slice(m.index + m[0].length))) return false;
  }
  return true;
}

export function reconcileVaryingDeclarations(
  rawVert: string,
  rawFrag: string,
): { vert: string; frag: string; warnings: string[] } {
  const vertDecls = extractVaryingDecls(rawVert);
  const fragDecls = extractVaryingDecls(rawFrag);
  let frag = rawFrag;
  const warnings: string[] = [];
  for (const [name, fragType] of fragDecls) {
    const vertType = vertDecls.get(name);
    if (vertType === undefined || vertType === fragType) continue; // 只处理两侧都声明且类型不同
    const pair = `${name}（vert ${vertType} / frag ${fragType}）`;
    if (!VEC_VARYING_TYPES.has(vertType) || !VEC_VARYING_TYPES.has(fragType)) {
      warnings.push(`varying 声明跨 stage 不匹配（两侧不同族，非 vec 族无法安全提升）：${pair}，已放弃改写`);
      continue;
    }
    if (VARYING_COMPONENTS[fragType] > VARYING_COMPONENTS[vertType]) {
      warnings.push(`varying 声明跨 stage 不匹配（窄侧是 vert）：${pair}；参考实现 lwe ShaderUnit.cpp:379 applyLinkedVaryingCompatibility 处理的是这个方向，需改写顶点侧赋值 ${name} = vec4(expr, 0.0, 1.0)，本库未遇到该形态、尚未实现，已放弃改写`);
      continue;
    }
    if (!usesOnlySwizzle(frag, name)) {
      warnings.push(`varying 声明跨 stage 不匹配（frag 存在整体用法）：${pair}；提升声明会让 ${name} 在 frag 里类型失配，需像 lwe ShaderUnit.cpp:417 applyFragmentTexCoordCompatibility 那样补 .xy，本任务不做，已放弃改写`);
      continue;
    }
    // 语义等价改写：只提升 frag 的声明行（保留缩进），frag 其余文本一字不动
    frag = frag.replace(
      new RegExp(`^([ \\t]*)varying[ \\t]+${fragType}[ \\t]+${name}([ \\t]*);`, 'gm'),
      `$1varying ${vertType} ${name}$2;`,
    );
  }
  return { vert: rawVert, frag, warnings };
}

// GLSL ES 3.00 严格模式修正：int 字面量不能隐式参与浮点运算/赋值/函数重载
// （GLSL1 允许、GLSL3 报 "cannot convert from 'const int' to 'highp float'"、
// "wrong operand types" 或 "no matching overloaded function"）。
// 策略：先把**明确的 int 上下文**（数组下标、for 循环头、int/ivec 声明、位运算）
// 用占位符保护，再把剩余裸 int 字面量统一补 `.0`（浮点/构造/函数参数上下文），
// 最后还原保护段。全库实测覆盖：`v_TexCoord.z = 0;`、`float mask = 1;`、
// `1 - g_Rough`、`smoothstep(..., 1, ...)`、`mix(blurred.a, 1, ...)`、`vec4(1, -1, ...)`。
export function normalizeFloatIntLiterals(src: string): string {
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
  //  - int/ivec 声明与构造：int i = 0; ivec2(1, 2)；**const int x = 3;**
  //    （2026-08-21 修复两处：① `(?:const\s+)?`——原正则漏 const 前缀；
  //    ② 保护**整个声明含右值**——原正则匹配到 `=` 即停，右值 `3;` 的 `3` 在保护段外
  //    被补 .0 → `const int x = 3.0;` GLSL3 报 "cannot convert from 'const float' to
  //    'const highp int'"（godrays_cast 等壁纸实测））
  //  - 比较运算中的整数字面量：mode == 9（ApplyBlending 的 int 比较，
  //    补 .0 后 int==float 报错）；全库无"变量与 int 比较"的 float 场景
  out = out.replace(/^\s*#(?:if|elif|ifdef|ifndef|define).*$/gm, protect);
  out = out.replace(/for\s*\([^)]*\)/g, protect);
  out = out.replace(/\[[^\]]*\]/g, protect);
  out = out.replace(/\b(?:ivec[234])\s*\([^)]*\)/g, protect);
  out = out.replace(/\b(?:const\s+)?int\s+\w+\s*(?:\[[^\]]*\])?\s*=[^;]*;/g, protect);
  out = out.replace(/\b(?:const\s+)?int\s+\w+\s*(?:\[[^\]]*\])?\s*;/g, protect);
  out = out.replace(/(?:==|!=|<=|>=|<|>)\s*-?\d+(?![\w.])/g, protect);
  // 科学计数法整体保护（1e-10 / 1.5e-3：裸 int 正则会把指数部分 '10'/'3' 误补 .0 → 非法 GLSL。
  // 引擎 common.h rgb2hsv 的 `1e-10` 即触发；GLSL 浮点字面量允许 `1.e3`/`.5e3`，
  // 前者被 `\d\.?\d*` 覆盖，后者 `.5e3` 的指数 `3` 前驱为 `e` 本就不会被裸 int 正则命中）
  out = out.replace(/\d\.?\d*[eE][+-]?\d+/g, protect);
  // 剩余裸 int 字面量补 .0（浮点上下文；1.0 之类已有小数点的不会被匹配，
  // 因为数字前不允许 . 或字母、数字后不允许 . 或字母）
  out = out.replace(/(?<![\w.])-?\d+(?![\w.])/g, (m) => `${m}.0`);
  // 还原保护段
  protectedBlocks.forEach((block, i) => {
    out = out.replace(`__WEI_PROTECTED_${i.toString(36)}__`, block);
  });
  return out;
}

// GLSL ES 3.00 严格类型修正（2026-08-21）：int **变量**（const int 常量、int 声明、
// for 循环计数器）参与浮点运算时 GLSL3 报 "wrong operand types"（GLSL1 允许 int 隐式
// 转 float）。文本层无法做完整类型推断，采用保守策略：
//  - 收集 int 变量名（const int / int / uniform int / in|out int / for 头）
//  - 保护明确 int 上下文（int 声明整行、数组下标、for 头、++/--、int()/ivecN()/float() 构造、比较运算）
//  - 剩余使用点包 float(name)（与浮点字面量/变量/vec 混合运算、赋给 float、函数参数）
// 实测覆盖（全库 27 shader）：godrays_cast/shine_cast 的 `const float sampleDrop = sampleCount - 1;`
// （const int 常量赋 float）与 `albedo += sample * (i / sampleDrop);`（循环计数器除以 float）、
// `1.0 / sampleCount`、`vec4 * intVar` 等。
// GLSL ES 3.00 严格类型修正（2026-08-21）：int **变量**（const int 常量、int 声明、
// for 循环计数器）参与浮点运算时 GLSL3 报 "wrong operand types"（GLSL1 允许 int 隐式
// 转 float）。文本层无法做完整类型推断，采用保守策略：
//  - 收集 int 变量名（const int / int / uniform int / in|out int / for 头）
//  - 保护明确 int 上下文（int 声明整行、数组下标、for 头、++/--、int()/float()/ivecN() 构造、比较运算）
//  - 剩余使用点包 float(name)（与浮点字面量/变量/vec 混合运算、赋给 float、函数参数）
// 实测覆盖（全库 27 shader）：godrays_cast/shine_cast 的 `const float sampleDrop = sampleCount - 1;`
// （const int 常量赋 float）与 `albedo += sample * (i / sampleDrop);`（循环计数器除以 float）、
// `1.0 / sampleCount`、`vec4 * intVar` 等。
// 占位符 token 以数字开头（0WEI_INTVAR_...）：变量类正则 [A-Za-z_]\w* 不匹配数字开头，
// 防止比较保护等把已保护的占位符当变量名吞进新保护块（2026-08-21 Simple_Audio_Bars 实测：
// float((a - b) < 0.0) 截断后残留 ) 触发比较保护吞占位符 → 嵌套占位符还原错乱）。
export function floatifyIntVarUses(src: string): string {
  // 变量名收集只看 shader 主体：header 的形参/局部名（mat2 a、float x、const int format…）
  // 不属于 shader 作用域，若混入会让主体里的同名 int 变量被 F7 误判为「类型不一致」而整名跳过。
  const body = protectHeaderRegions(src, () => '');
  const intVars = collectIntVarNames(body);
  // F7（2026-09-21）：同名在别处声明为非 int（最典型：跨互斥 #if/#else 分支的
  // `float bar` / `int bar`）时整名跳过。否则会把另一支写成 `float float(bar) = …`
  // （Simple_Audio_Bars 实测 GLSL 'float' : syntax error）。最保守：该名完全不转换。
  const nonIntDecls = new Set<string>();
  for (const m of body.matchAll(/\b(?:const\s+)?(?:uniform\s+)?(?:in\s+|out\s+)?(?:float|vec[234]|mat[234]|uint|bool|double)\s+(\w+)(?!\s*\()/g)) {
    nonIntDecls.add(m[1]);
  }
  for (const name of [...intVars]) if (nonIntDecls.has(name)) intVars.delete(name);
  if (intVars.size === 0) return src;
  const protectedBlocks: string[] = [];
  const protect = (m: string) => {
    const token = `0WEI_INTVAR_${protectedBlocks.length.toString(36)}__`;
    protectedBlocks.push(m);
    return token;
  };
  const restore = () => {
    // 逆序还原：后建的块可能把先建的 token 吞进自己的块文本（嵌套），顺序还原会让内层
    // token 永远留在文本里（2026-09-21 实测 F6 的 `a = 0;` 被 for 头块吞掉 → 泄漏 token）。
    for (let i = protectedBlocks.length - 1; i >= 0; i--) {
      // 函数式替换避免 block 中 $ 特殊字符；全局替换防同一 token 出现多次残留
      out = out.replace(new RegExp(`0WEI_INTVAR_${i.toString(36)}__`, 'g'), () => protectedBlocks[i]);
    }
  };
  // int/float/ivec 构造保护：从 '(' 扫描配对 ')'（支持嵌套括号，防止 [^)]* 在
  // 内层 ) 截断 → 残留部分被后续比较保护误匹配）。返回替换后的完整字符串。
  const protectConstructs = (text: string): string => {
    const re = /\b(?:int|float|ivec[234])\s*\(/g;
    let out2 = '';
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const open = m.index + m[0].length - 1; // '(' 位置
      let depth = 1;
      let i = open + 1;
      for (; i < text.length && depth > 0; i++) {
        const ch = text[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
      out2 += text.slice(last, m.index) + protect(text.slice(m.index, i));
      last = i;
      re.lastIndex = i; // 跳过已处理段（内部嵌套构造不重复保护）
    }
    return out2 + text.slice(last);
  };
  let out = src;
  // 保护 int 上下文（不包 float）：
  //  - int 声明整行（含右值中的其他 int 变量使用：int x = i * 2 的 i 必须保持 int）
  out = out.replace(/^\s*(?:const\s+)?(?:uniform\s+)?(?:in\s+|out\s+)?int\b[^;]*;/gm, protect);
  //  - 函数参数中的 int 声明：(const int blendMode, ... 的 blendMode 是参数名不是使用点
  //    （2026-08-21 实测：common_blending.h ApplyBlending(const int blendMode, ...) 参数名
  //    被使用点转换 → `const int float(blendMode)` → GLSL3 'float' : syntax error，
  //    影响所有含 common_blending.h 的效果 shader）
  out = out.replace(/(?:\(|,)\s*(?:const\s+)?(?:in\s+|out\s+)?int\s+\w+(?=\s*[,)])/g, protect);
  //  - 数组下标（bufferLeft[a] 的 a 是下标，必须 int）
  out = out.replace(/\[[^\]]*\]/g, protect);
  //  - for 头：用三部分（init; cond; incr）匹配，每部分允许嵌套括号但无分号/花括号
  //    （原 `[^)]*` 在 int(...) 的内层 ) 截断 → 循环变量泄漏到保护段外被误转 float(a)）
  //    ⚠️ 必须在 F6 之前：F6 会把 `for (int i = 0; …)` 的 `i = 0;` 先保护成 token，
  //    头里就少一个 `;` → for 头保护失配（2026-09-21 实测）。
  out = out.replace(/for\s*\([^;{}]*;[^;{}]*;[^;{}]*\)/g, protect);
  //  - F6（2026-09-21）：int 变量的赋值语句整体保护。左值被包成 `float(index) = …` 是
  //    GLSL 'l-value required'；只保护左值还不够 —— `index = abs(float(index))` 仍是
  //    float 赋 int，所以整条赋值语句（到同行分号）保持原样。
  //    `(?!=)` 保证不与 `==`/`!=` 冲突；`>=`/`<=` 因第一个字符不是 `=` 天然不匹配。
  for (const name of intVars) {
    out = out.replace(new RegExp(`\\b${name}\\s*(?:[-+*/%&|^]|<<|>>)?=(?!=)[^\\n;]*;`, 'g'), protect);
  }
  //    兜底：跨行/无分号的赋值目标本身也不能被包成 float(x)
  for (const name of intVars) {
    out = out.replace(new RegExp(`\\b${name}\\s*(?:[-+*/%&|^]|<<|>>)?=(?!=)`, 'g'), protect);
  }
  //  - F6 补充：本地函数 int 形参位置上的实参必须保持 int。audioline 实测
  //    `getMirroredAudioValue(int index, int maxBand)` 的调用点被包成 `float(index1)`
  //    ⇒ GLSL 'no matching overloaded function'（float 实参无法隐式转 int）。
  //    注：正常路径由 protectIntContexts 在补 .0 之前就保护（否则 `index1 - 1` 会先变 `1.0`），
  //    这里保留一份以便直接调用本函数时仍然成立。
  out = protectIntParamArgs(out, collectIntParamPositions(src), protect);
  //  - 自增/自减
  out = out.replace(/(?:\+\+|--)\s*\w+|\w+\s*(?:\+\+|--)/g, protect);
  //  - int/float/ivec 构造（配对括号，float(N) 内已是显式转换，不重复包）
  out = protectConstructs(out);
  //  - 比较运算两侧的 int 变量（x < sampleCount 保持 int 比较）
  //    先整体保护 `LHS op RHS`：单侧规则会把运算符吞进保护段，左操作数随即被包成 float(x)
  //    （生成 `float(format) == FORMAT_RG88`，GLSL3 报 '==' wrong operand types，见 AGENT.md §7.1）。
  out = out.replace(/[A-Za-z_]\w*\s*(?:==|!=|<=|>=|<|>)\s*[A-Za-z_]\w*/g, protect);
  //    单侧兜底：另一侧是字面量/表达式（`x == 0.0`、`== x`）时，仍保护运算符与那一侧。
  out = out.replace(/[A-Za-z_]\w*\s*(?:==|!=|<=|>=|<|>)/g, protect);
  out = out.replace(/(?:==|!=|<=|>=|<|>)\s*[A-Za-z_]\w*/g, protect);
  // header 区段整体保护：见 HEADER_BEGIN 注释（不能在 wrap 之前有别的 protect 把该 token 吞掉，
  // 故放在这里——紧随其后就是 wrap，只有 restore）。
  out = protectHeaderRegions(out, protect);
  // 剩余使用点：float(name)（与浮点字面量/变量/vec 混合运算、赋值、函数参数）
  for (const name of intVars) {
    out = out.replace(new RegExp(`\\b${name}\\b`, 'g'), `float(${name})`);
  }
  // 还原保护段
  restore();
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
export function relaxGlsl3Strictness(src: string): string {
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
      // 拆分：原位置保留 `type name;`（去掉等号前的尾部空格），初始化语句插入 main 第一行后
      lines[i] = l.replace(/\s*=\s*[^;]*;\s*$/, ';');
      moved.push(`\t${m[2]} = ${expr};`);
    }
    if (moved.length) lines.splice(mainIdx + 1, 0, ...moved);
  }
  return lines.join('\n');
}

// F5：我们 header 里定义过的宏名集合（只有这些宏被 shader 重定义时才会触发 GLSL 的
// "macro redefined" ERROR）。放在模块级：header 是常量表，扫一次即可。
const HEADER_MACRO_NAMES: ReadonlySet<string> = (() => {
  const names = new Set<string>();
  for (const header of Object.values(WE_HEADERS)) {
    for (const m of header.matchAll(/^[ \t]*#define[ \t]+([A-Za-z_][A-Za-z0-9_]*)/gm)) names.add(m[1]);
  }
  return names;
})();

// 内置头文本的区段标记（注释形式，即使泄漏进 GLSL 也无副作用）：用于让
// `floatifyIntVarUses` 的 int 变量改写**跳过 header**——header 的宏参数/形参名
// （`#define lerp(a, b, t)`、`mat2 mul(mat2 a, mat2 b)`）会与 shader 里的同名 int 变量
// （shake.vert 的 `for (int a = …)`）相撞，被改写成 `#define lerp(float(a), b, t)` ⇒ 语法错误。
const HEADER_BEGIN = '/*__WE_HEADER_BEGIN__*/';
const HEADER_END = '/*__WE_HEADER_END__*/';

/** 用区段标记包住内置头文本（展开 include / 隐式注入时使用）。 */
export function markHeaderText(text: string): string {
  return `${HEADER_BEGIN}${text}${HEADER_END}`;
}

/** 剥掉区段标记（最终源码不需要它们）。 */
export function stripHeaderMarks(text: string): string {
  return text.split(HEADER_BEGIN).join('').split(HEADER_END).join('');
}

/** 把每个顶层 header 区段（含嵌套，如 common_composite.h 内的 common.h）整体交给 protect。 */
function protectHeaderRegions(text: string, protect: (s: string) => string): string {
  if (!text.includes(HEADER_BEGIN)) return text;
  let out = '';
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith(HEADER_BEGIN, i)) {
      if (depth === 0) { out += text.slice(start, i); start = i; }
      depth++;
      i += HEADER_BEGIN.length;
    } else if (text.startsWith(HEADER_END, i)) {
      depth--;
      if (depth === 0) { out += protect(text.slice(start, i + HEADER_END.length)); start = i + HEADER_END.length; }
      i += HEADER_END.length;
    } else i++;
  }
  return out + text.slice(start);
}

/** 收集 int 变量名（排除 int 函数定义名 `int funcName(`）。 */
function collectIntVarNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(?:const\s+)?(?:uniform\s+)?(?:in\s+|out\s+)?int\s+(\w+)(?!\s*\()/g)) out.add(m[1]);
  return out;
}

/** 本地函数签名里 int 形参的位置（name → 参数下标集合）。 */
function collectIntParamPositions(src: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const m of src.matchAll(/\b(?:void|float|int|uint|bool|vec[234]|mat[234])\s+(\w+)\s*\(([^)]*)\)\s*\{/g)) {
    const pos = new Set<number>();
    m[2].split(',').forEach((p, i) => { if (/\bint\b/.test(p)) pos.add(i); });
    if (pos.size) out.set(m[1], pos);
  }
  return out;
}

/** 保护「int 形参位置」上的实参跨度（调用点不能传 float 实参：GLSL 无 float→int 隐式转换）。 */
function protectIntParamArgs(text: string, signatures: Map<string, Set<number>>, protect: (s: string) => string): string {
  const fnNames = [...signatures.keys()];
  if (!fnNames.length) return text;
  const callRe = new RegExp(`(?<![\\w.])(${fnNames.join('|')})\\s*\\(`, 'g');
  let res = '';
  let last = 0;
  let c: RegExpExecArray | null;
  while ((c = callRe.exec(text))) {
    // 跳过函数定义本身（其前缀是返回类型）
    if (/\b(?:void|float|int|uint|bool|vec[234]|mat[234])\s+$/.test(text.slice(0, c.index))) continue;
    const open = c.index + c[0].length; // '(' 之后
    const args: Array<[number, number]> = [];
    let depth = 1;
    let i = open;
    let argStart = open;
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
      else if (ch === ',' && depth === 1) { args.push([argStart, i]); argStart = i + 1; }
    }
    if (depth !== 0) break; // 括号不配对：保守放弃
    args.push([argStart, i]);
    const positions = signatures.get(c[1]) as Set<number>;
    res += text.slice(last, open);
    let cursor = open;
    for (let k = 0; k < args.length; k++) {
      const [s, e] = args[k];
      if (positions.has(k) && e > s) { res += text.slice(cursor, s) + protect(text.slice(s, e)); cursor = e; }
    }
    res += text.slice(cursor, i);
    last = i;
    callRe.lastIndex = i;
  }
  return res + text.slice(last);
}

// F6（2026-09-21）：int 上下文共享保护层。int 变量的赋值语句（`index = clamp(index, 0, BANDS-1)`）
// 与 int 形参位置上的实参（`getMirroredAudioValue(index1 - 1, …)`）必须在**补 .0 之前**就整体
// 保持原样：否则字面量先被补成 0.0/1.0 → GLSL 报 clamp 无匹配重载 / int-float 混算
// （audioline 实测）。这一层横跨 normalize 与 floatify 两步，最后由调用方还原。
export function protectIntContexts(src: string): { text: string; restore: (s: string) => string } {
  const blocks: string[] = [];
  const protect = (m: string) => {
    const token = `0WEI_INTCTX_${blocks.length.toString(36)}__`;
    blocks.push(m);
    return token;
  };
  const body = protectHeaderRegions(src, () => '');
  let text = src;
  //  - int 变量的赋值语句（同行到分号）：整条是 int 上下文。声明行（前置类型关键字）跳过，
  //    交给各步自己的 int 声明保护处理。
  for (const name of collectIntVarNames(body)) {
    const re = new RegExp(`(?<![\\w.])${name}\\s*(?:[-+*/%&|^]|<<|>>)?=(?!=)[^\\n;]*;`, 'g');
    const spans: Array<[number, number]> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 24), m.index);
      if (/\b(?:const|uniform|in|out|int|uint|float|bool|vec[234]|mat[234])\s+$/.test(before)) continue;
      spans.push([m.index, m.index + m[0].length]);
    }
    for (const [s, e] of spans.reverse()) text = text.slice(0, s) + protect(text.slice(s, e)) + text.slice(e);
  }
  //  - int 形参位置上的实参
  text = protectIntParamArgs(text, collectIntParamPositions(src), protect);
  const restore = (s: string) => {
    let out = s;
    // 逆序还原：后建块可能吞掉先建 token（同 floatifyIntVarUses 的说明）
    for (let i = blocks.length - 1; i >= 0; i--) {
      out = out.replace(new RegExp(`0WEI_INTCTX_${i.toString(36)}__`, 'g'), () => blocks[i]);
    }
    return out;
  };
  return { text, restore };
}

/** GLSL3 严格化三连（normalize 补 .0 → floatify 包 float() → relax 去 const/改保留字）。
 *  F6 的 int 上下文跨度必须横跨 normalize 与 floatify（见 protectIntContexts），
 *  relax 在还原之后跑，保留它对保留字/const 的改写。 */
export function applyGlsl3StrictnessFixes(src: string): string {
  const ctx = protectIntContexts(src);
  let out = normalizeFloatIntLiterals(ctx.text);
  out = floatifyIntVarUses(out);
  out = ctx.restore(out);
  return relaxGlsl3Strictness(out);
}

/** 把 shader 侧对 header 已有宏的 `#define X …` 改写成 `#undef X` + `#define X …`（保留 HLSL 后者胜）。 */
function undefHeaderMacroRedefinitions(src: string): string {
  return src.replace(
    /^([ \t]*)#define[ \t]+([A-Za-z_][A-Za-z0-9_]*)([^\n]*)$/gm,
    (whole, indent: string, name: string, rest: string) =>
      // rest 含行尾 \r，\n 单独插入 ⇒ 不破坏 CRLF 行的宏体
      HEADER_MACRO_NAMES.has(name) ? `${indent}#undef ${name}\n${indent}#define ${name}${rest}` : whole,
  );
}

export function preprocessWeShader(source: string, combos: Record<string, number>): string {
  // F5：shader 侧对「我们 header 已有宏」的 #define 改写成 #undef + #define。
  // 缘由：GLSL 预处理把「同一宏名不同宏体的重定义」当 ERROR（HLSL 只 warning，后者胜），
  // dot_matrix_mobile_fix 的 `#define M_PI 3.14…2795` 因此编译失败。
  // 只改我们 header 里出现过的宏名；#undef 紧贴重定义 ⇒ 展开顺序上仍然后者胜。
  const rewrittenSource = undefHeaderMacroRedefinitions(source);
  // GLSL 先声明后使用：sampler uniform 声明前置。
  // common_blur.h 的 blur13a/blur7a/blur3a 引用 g_Texture0，而 WE shader 源码中
  // sampler 声明在 include 之后 → 若不前置会 "g_Texture0 : undeclared identifier"。
  const samplerDecls: string[] = [];
  const src = rewrittenSource.replace(/^\s*(uniform\s+sampler\w+\s+\w+\s*;.*)$/gm, (m) => {
    samplerDecls.push(m.trim());
    return '';
  });
  let out = src;
  const hadExplicitCommon = out.includes('#include "common.h"');
  // 展开内置头 include（仅处理 WE_HEADERS 已知的头；未知 include 保留原样）。
  // 嵌套头迭代展开至稳定：common_composite.h 内含 #include "common.h"/
  // "common_blending.h"，单趟 Object.entries 循环会残留（composite 键序在
  // common 之后，内层 include 的展开时机已过）——头自带 #ifndef guard 防
  // 重复定义，迭代安全。
  let prev: string;
  do {
    prev = out;
    for (const [name, header] of Object.entries(WE_HEADERS)) {
      out = out.split(`#include "${name}"`).join(markHeaderText(header));
    }
  } while (out !== prev);
  // WE 引擎对所有效果 shader 隐式提供基础函数头（common.h）：
  // 全库实测 114/182 个 shader 无任何 include 却直接调用 mul/texSample2D/frac 等，
  // 故未显式 include common.h 的 shader 前置注入（guard 宏防止与显式 include 重复）
  if (!hadExplicitCommon) {
    out = markHeaderText(WE_HEADERS['common.h']) + '\n' + out;
  }
  out = rewriteAttributes(out);
  // int 变量相关的严格化三连（normalize → floatify → relax）走共享入口：
  // F6 的 int 上下文保护必须横跨 normalize 与 floatify（见 protectIntContexts）。
  out = applyGlsl3StrictnessFixes(out);
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
  const body = stripHeaderMarks(out);
  return prefix.length ? `${prefix.join('\n')}\n${body}` : body;
}
