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
import * as glslangNS from '@webgpu/glslang';
const glslangInit = glslangNS.default;
let glslangPromise = null;
function loadGlslang() {
    // Task 9（浏览器 bundle）：web-devel 工厂的 locateFile() 经 build-client.mjs 的
    // glslang-web-patch 插件改为读 globalThis.__DSH_GLSLANG_BASE__（DSH 插件静态路由前缀），
    // 以 fetch /wallpapers/static/glslang.wasm。Node 测试（node-devel）用 fs 读 wasm，不受影响。
    if (typeof globalThis !== 'undefined') {
        globalThis.__DSH_GLSLANG_BASE__ = '/wallpapers/static/';
    }
    glslangPromise ??= glslangInit();
    return glslangPromise;
}
// SPIR-V 是 little-endian 32-bit word 流；@webgpu/glslang 返回 Uint32Array → 转 Uint8Array bytes
//（wasm 侧 spirv-webgpu-transform::u8_slice_to_u32_vec 按 LE 读回 word）。
function u32ToBytes(u32) {
    const out = new Uint8Array(u32.length * 4);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < u32.length; i++)
        dv.setUint32(i * 4, u32[i], true);
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
function assignInterfaceLocations(src, stage) {
    const out = [];
    let fragInLoc = 0;
    let vertInLoc = 0;
    let vertOutLoc = 0;
    for (const line of src.split('\n')) {
        const hasLayout = /layout\s*\(\s*location\s*=/.test(line);
        const m = DECL_IO_RE.exec(line);
        if (m && !hasLayout) {
            const [, indent, io, type, name, arr, rest] = m;
            // 数组 varying/attribute 占 location 连续多槽（vec2 v_TexCoord[4] 占 location 0..3），
            // 后续接口须在上一个数组占用的槽之后，否则 location 重叠 → glslang 报错（Reviewer Minor #2）。
            const arrN = arr ? Number(arr.match(/\d+/)?.[0] ?? 1) : 1;
            const decl = `${indent}layout(location=`;
            if (stage === 'frag') {
                // fragment 的 in = varying；out 只有 o_Color（已带 layout，不重排）。
                if (io === 'in') {
                    out.push(`${decl}${fragInLoc}) in ${type} ${name}${arr ?? ''};${rest}`);
                    fragInLoc += arrN;
                }
                else
                    out.push(line);
            }
            else {
                if (io === 'in') {
                    out.push(`${decl}${vertInLoc}) in ${type} ${name}${arr ?? ''};${rest}`);
                    vertInLoc += arrN;
                }
                else {
                    out.push(`${decl}${vertOutLoc}) out ${type} ${name}${arr ?? ''};${rest}`);
                    vertOutLoc += arrN;
                }
            }
        }
        else {
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
function broadcastScalarOperand(src) {
    const swizzleDim = (expr) => {
        const m = expr.match(/\.(rgba|xyzw|rgb|xyz|rg|xy)$/);
        if (!m)
            return null;
        return m[1].length === 4 ? 4 : m[1].length === 3 ? 3 : 2;
    };
    const vecOf = (dim) => `vec${dim}`;
    return src
        // max|min|clamp( <数字> , <ident.swizzle> )：把数字广播成向量
        .replace(/\b(max|min|clamp)\(\s*(-?\d+(?:\.\d+)?)\s*,\s*([A-Za-z_]\w*\s*\.\s*(?:rgba|xyzw|rgb|xyz|rg|xy))\s*\)/g, (m, fn, num, exp) => {
        const dim = swizzleDim(exp);
        return dim ? `${fn}(${vecOf(dim)}(${num}), ${exp})` : m;
    })
        // max|min|clamp( <ident.swizzle> , <数字> )
        .replace(/\b(max|min|clamp)\(\s*([A-Za-z_]\w*\s*\.\s*(?:rgba|xyzw|rgb|xyz|rg|xy))\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g, (m, fn, exp, num) => {
        const dim = swizzleDim(exp);
        return dim ? `${fn}(${exp}, ${vecOf(dim)}(${num}))` : m;
    });
}
// GLSL 不允许 vec4→vec3/vec2 隐式降维，但 WE 效果 shader 沿用 HLSL 习惯直接
// `vec3 c = texSample2D(...)`（隐式丢 alpha）。转换后成为 `vec3 c = texture(...)`，glslang
// 报 "cannot convert from vec4 to vec3"。仅当 RHS 为**单个完整纯 texture()/textureLod() 调用**
// 时补 swizzle（vec3→.rgb、vec2→.xy）；RHS 若是复合表达式（`texture(...) + X` / `.xyz * 2 - 1`
// / 以括号结尾的 `texture(...) + (a + 0.5)`）则**不动**，避免把 .rgb 误接到子表达式的括号/数字上
// （Reviewer Important #1）。
// 用配对括号解析：`texture(...)` 的闭合 `)` 必须是 RHS 的**最后一个字符**（无尾随运算/swizzle），
// 且允许实参内嵌套括号（如 `texture(g, frac(shimmerCoord))`）。
function isSingleTextureCall(call) {
    const open = call.indexOf('(');
    if (open < 0)
        return false;
    let depth = 0;
    for (let i = open; i < call.length; i++) {
        if (call[i] === '(')
            depth++;
        else if (call[i] === ')') {
            depth--;
            if (depth === 0)
                return i === call.length - 1; // 闭合括号即末尾 → 纯单调用
        }
    }
    return false;
}
function fixVectorAssignFromTexture(src) {
    return src.replace(/\b(vec3|vec2)\s+(\w+)\s*=\s*((?:texture|textureLod)\([^;]*)\s*;/g, (m, type, name, call) => {
        // RHS 必须以 texture/textureLod 调用开头（`texA + ...` 之类不以 texture 开头，不命中）。
        if (!/^(?:texture|textureLod)\(/.test(call))
            return m;
        if (!isSingleTextureCall(call))
            return m;
        const swizzle = type === 'vec3' ? 'rgb' : 'xy';
        return `${type} ${name} = ${call}.${swizzle};`;
    });
}
// WE 方言：标量字面量后跟 .rgb/.rgba/.rg 表示广播成向量（如 `1.0.rgb` = vec3(1.0)，
// 常见于 `* 2.0 - 1.0.rgb` 之类）。GLSL 对 float 值 .rgb 报 "vector swizzle out of range"。
// 用 lookbehind 排除变量名（x.rgb 是合法 swizzle），仅对纯数字字面量展开为 vecN(标量)。
function broadcastFloatSwizzle(src) {
    return src.replace(/(?<![A-Za-z0-9_])(-?\d+(?:\.\d+)?)\s*\.\s*(rgba|rgb|rg)\b/g, (m, num, sw) => `vec${sw.length}(${num})`);
}
// 迭代展开 WE 内置头 include（头自带 #ifndef guard，迭代安全）。
function expandIncludes(src) {
    let out = src;
    let prev;
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
function defaultValueForType(type) {
    const vec = type.match(/^vec([234])$/);
    if (vec)
        return new Array(Number(vec[1])).fill(0);
    const mat = type.match(/^mat([234])$/);
    if (mat) {
        const n = Number(mat[1]);
        return new Array(n * n).fill(0);
    }
    const arr = type.match(/^[A-Za-z_][A-Za-z0-9_]*\[(\d+)\]$/);
    if (arr)
        return new Array(Number(arr[1])).fill(0);
    if (type.startsWith('sampler'))
        return null;
    return 0;
}
export function std140TypeInfo(typeStr) {
    // 数组：查 `[` 前缀再递归（覆盖 float/int/uint/bool/vec/mat 的 `[N]`）。元素 stride =
    // roundup(elem_size,16) = max(elem_size,16)——必须用 elem_size 而非 elem_align（矩阵元素
    // size>16，mat4[2] 应为 2*64=128B 而非 2*16=32B，reviewer Important #1）。
    const arrBase = typeStr.indexOf('[');
    if (arrBase >= 0) {
        const elem = std140TypeInfo(typeStr.slice(0, arrBase));
        if (!elem)
            return null;
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
// 返回 Map 形态（供 buildDefines 产出 `#define` 行，也供 expandIfBranches 按同一宏值求值 #if）。
function buildDefinesMap(source, combos) {
    const defines = new Map();
    for (const [k, v] of Object.entries(combos))
        defines.set(k, String(v));
    for (const [k, v] of extractComboDefaults(source)) {
        if (!defines.has(k))
            defines.set(k, String(v));
    }
    const alreadyDefined = new Set();
    for (const m of source.matchAll(/^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)/gm))
        alreadyDefined.add(m[1]);
    for (const id of extractIfIdentifiers(source)) {
        if (/^\d/.test(id))
            continue;
        if (alreadyDefined.has(id))
            continue;
        if (defines.has(id))
            continue;
        defines.set(id, '0');
    }
    return defines;
}
function buildDefines(source, combos) {
    return [...buildDefinesMap(source, combos).entries()].map(([k, v]) => `#define ${k} ${v}`);
}
// 计算一个 `#if` 条件表达式的布尔值（用已注入的宏值；未定义标识符按 C 预处理语义当 0）。
// 支持 WE 效果 shader 常见表达式：标识符真值、`IDENT == N`/`!=`/`<`/`<=`/`>`/`>=`、
// `!expr`、`(expr)`、`&&`/`||`、`defined(X)`。递归下降解析，返回 1/0（不处理位运算，
// 全库 WE 效果 shader 的 #if 未用到）。`isDefined(X)` 由调用方传入（用于 `#if defined(X)`，
// 反映预处理过程中 `#define` 的累积状态，而非静态注入宏集）。
function evalIfExpr(rawExpr, defines, isDefined) {
    let e = rawExpr.replace(/\/\/.*$/, '').trim();
    if (e === '')
        return 0;
    e = e.replace(/defined\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, (_m, id) => (isDefined(id) ? '1' : '0'));
    // token 化：数字(-?[\d.]+)、标识符、多字符运算符、单字符运算符、括号
    const toks = [];
    const re = /-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|==|!=|<=|>=|&&|\|\||[!<>()]/g;
    let m;
    while ((m = re.exec(e)))
        toks.push(m[0]);
    if (toks.length === 0)
        return 0;
    let pos = 0;
    const peek = () => toks[pos];
    const next = () => toks[pos++];
    const valOf = (t) => {
        if (/^-?\d+(?:\.\d+)?$/.test(t))
            return Number(t);
        return defines.has(t) ? Number(defines.get(t)) : 0;
    };
    // 文法：or := and ('||' and)* ; and := unary ('&&' unary)* ; unary := '!' unary | cmp
    //       cmp := primary (cmpop primary)? ; primary := '(' or ')' | number | ident
    function primary() {
        const t = next();
        if (t === '(') {
            const v = or();
            if (peek() === ')')
                next();
            return v;
        }
        return valOf(t);
    }
    function cmp() {
        const a = primary();
        const op = peek();
        if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
            next();
            const b = primary();
            switch (op) {
                case '==': return Number(a === b);
                case '!=': return Number(a !== b);
                case '<': return Number(a < b);
                case '<=': return Number(a <= b);
                case '>': return Number(a > b);
                case '>=': return Number(a >= b);
            }
        }
        return a;
    }
    function unary() {
        if (peek() === '!') {
            next();
            return Number(unary() === 0);
        }
        return cmp();
    }
    function and() {
        let v = unary();
        while (peek() === '&&') {
            next();
            const r = unary();
            v = Number(v !== 0 && r !== 0);
        }
        return v;
    }
    function or() {
        let v = and();
        while (peek() === '||') {
            next();
            const r = and();
            v = Number(v !== 0 || r !== 0);
        }
        return v;
    }
    return or();
}
// 按宏值展开互斥 `#if/#elif/#else/#endif`（及 `#ifdef/#ifndef`），只保留选中的分支。
// glslang 的 C 预处理器在编译时也会裁剪；但 JS 侧 `assignInterfaceLocations` 需要在**裁剪后**的
// 文本上给 varying 编号（否则互斥多分支里每个分支的声明都被编号，把选中分支的 location 推到
// 超过 WebGPU `maxInterStageShaderVariables`(=16)，如 blur_gaussian 的 `#if KERNEL==0/1/2`）。
// 必须先于 varying 改写 / location 编号执行。保持嵌套，未激活块内的**非预处理行**剔除。
// 关键：必须**模拟预处理宏状态**（而非只用初始注入宏集）——header guard（如 `#ifndef WE_COMMON_H`
// + `#define WE_COMMON_H`）防重复 include；若 `#define` 不累积进 `isDefined`，第二次 `#ifndef
// WE_COMMON_H` 会误判为真，把 common.h 内容重复内联（如 `frac(...)` 函数重定义，glslang 报
// "function already has a body"）。故遍历时 `#define` 加入已定义集、`#undef` 移除。
// `valueDefines`（combos 值）供 `#if IDENT == N` 求值；`initDefined` 为一开始就视为已定义的宏
// （combos 名 + [COMBO] 默认宏），与"仅出现在 #if 表达式里被兜底成 0 的标识符"区分——后者是
// 未定义的（C 语义当 0），`#ifdef` 应判 false。
function expandIfBranches(src, valueDefines, initDefined) {
    const lines = src.split('\n');
    const out = [];
    const definedSet = new Set(initDefined);
    const isDefined = (id) => definedSet.has(id);
    // 栈元素：{ parentActive, active, anyTaken }——active 为本分支在当前父级下是否输出。
    const stack = [];
    for (const line of lines) {
        const t = line.trim();
        const isIf = /^#if\s+/.test(t);
        const isIfdef = /^#ifdef\s+/.test(t);
        const isIfndef = /^#ifndef\s+/.test(t);
        const isElif = /^#elif\s+/.test(t);
        const isElse = /^#else\s*$/.test(t);
        const isEndif = /^#endif\s*$/.test(t);
        const isDefine = /^#define\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(t);
        const isUndef = /^#undef\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(t);
        if (isIf || isIfdef || isIfndef) {
            const parent = stack.length ? stack[stack.length - 1].active : true;
            let cond;
            if (isIf)
                cond = evalIfExpr(t.slice(3), valueDefines, isDefined);
            else if (isIfdef)
                cond = Number(isDefined(t.slice(7).trim()));
            else
                cond = Number(!isDefined(t.slice(8).trim()));
            const active = parent && cond !== 0;
            stack.push({ parentActive: parent, active, anyTaken: cond !== 0 });
            continue; // 预处理行不输出
        }
        if (isElif) {
            const top = stack[stack.length - 1];
            if (!top)
                continue;
            // 前面分支已取 → 本分支不激活；否则若父级激活且条件真 → 本分支激活。
            let cond = evalIfExpr(t.slice(5), valueDefines, isDefined);
            if (top.anyTaken)
                cond = 0;
            top.active = top.parentActive && cond !== 0;
            top.anyTaken = top.anyTaken || cond !== 0;
            continue;
        }
        if (isElse) {
            const top = stack[stack.length - 1];
            if (!top)
                continue;
            top.active = top.parentActive && !top.anyTaken;
            top.anyTaken = true;
            continue;
        }
        if (isEndif) {
            stack.pop();
            continue;
        }
        const active = stack.length ? stack[stack.length - 1].active : true;
        if (isDefine) {
            if (active) {
                definedSet.add(isDefine[1]);
                out.push(line);
            } // 未激活分支的 #define 不累积（C 语义跳过整块）
            continue;
        }
        if (isUndef) {
            if (active) {
                definedSet.delete(isUndef[1]);
                out.push(line);
            }
            continue;
        }
        // 普通行：仅当当前所有层都激活（最内层 active 为真）才输出。
        if (active)
            out.push(line);
    }
    return out.join('\n');
}
// 把数组 IO（`varying/attribute/in/out <type> <name>[N];`）展开为 N 个**同名后缀**的单独声明，
// 并把该数组的**常量下标**引用（`<name>[K]`）改写为 `<name>_<K>`。vertex 输出数组语义等价于
// N 个连续 location 的单独输出；fragment 输入同理——naga spv-in 对顶层层级 IO 数组不设
// `TypeFlags::IO_SHAREABLE`（task-18 根因，见 effect.rs spv_to_wgsl 报 `NotIOShareableType`）。
//
// **左值写保底（task-18 fix）**：展开的前提是能改写所有下标引用。变量下标 `name[idx]` 作为**右值读**
// 可改写为三元选择链（`(idx==0?name_0:...)` 合法右值）；但作为**赋值左值**（`name[idx] = x`、
// `name[idx] += x`、`name[idx]++`）三元链是**非左值**，glslang 拒绝。因此若某数组存在**任意一处
// 变量下标左值写**，则**整个数组保留原样**（声明与所有下标引用都不展开/改写），交给调用方
// per-pass 容错兜底（该 pass 跳过，不崩不白屏）。常量下标写（blur/gaussian 的 v_TexCoord[0]=...）
// 与变量下标右值读仍可正常展开。
function expandArrayIO(src, stage) {
    const varyingKw = stage === 'vert' ? 'out' : 'in';
    // ① 收集数组 IO 声明（仅匹配独立声明行）；组：1=缩进，2=关键字，3=类型，4=名字，5=数组长度，6=行尾。
    const ioRe = /^(\s*)\b(varying|attribute|in|out)\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\w+)\s*\[\s*(\d+)\s*\]\s*;(.*)$/gm;
    const decls = new Map();
    for (const m of src.matchAll(ioRe)) {
        decls.set(m[4], { type: m[3], n: Number(m[5]), indent: m[1], rest: m[6] });
    }
    if (decls.size === 0)
        return src;
    // ② 判定哪些数组含「变量下标左值写」→ 整个数组保留原样（交给 per-pass 容错，而非改写为非左值三元）。
    const keep = new Set();
    for (const name of decls.keys()) {
        const refRe = new RegExp(`\\b${name}\\s*\\[\\s*([A-Za-z_][A-Za-z0-9_]*|\\d+)\\s*\\]`, 'g');
        let m;
        while ((m = refRe.exec(src))) {
            if (/^\d+$/.test(m[1]))
                continue; // 常量下标：可展开（含常量写）
            if (isLValueWrite(src, m.index + m[0].length)) {
                keep.add(name);
                break;
            }
        }
    }
    // ③ 展开声明：keep 的数组保留原行；否则展开为 N 个同名后缀单变量（location 连续）。
    let out = src.replace(ioRe, (m, indent, kw, type, name, count, rest) => {
        if (keep.has(name))
            return m; // 保留原数组声明（其下标引用也全部保留，见 ④）
        const n = Number(count);
        const finalKw = kw === 'attribute' ? 'in' : kw === 'varying' ? varyingKw : kw;
        let decl = '';
        for (let i = 0; i < n; i++)
            decl += `${indent}${finalKw} ${type} ${name}_${i};${rest}\n`;
        return decl;
    });
    // ④ 改写下标引用：keep 的数组一律不改写（保留数组引用）；否则常量→name_K、变量（读）→三元链。
    for (const name of decls.keys()) {
        if (keep.has(name))
            continue;
        const re = new RegExp(`\\b${name}\\s*\\[\\s*([A-Za-z_][A-Za-z0-9_]*|\\d+)\\s*\\]`, 'g');
        out = out.replace(re, (m, idx) => {
            if (/^\d+$/.test(idx))
                return `${name}_${Number(idx)}`;
            const n = decls.get(name).n;
            let sel = '';
            for (let i = 0; i < n; i++)
                sel += `${i === 0 ? '' : ':'}${idx}==${i}?${name}_${i}`;
            sel += `:${name}_${n - 1}`;
            return `(${sel})`;
        });
    }
    return out;
}
// 判断 `whole[pos..]` 是否为数组下标引用的**赋值左值上下文**（`=`/复合赋值/后缀自增自减），
// 从而不能改写为非左值三元链。排除 `==`/`!=`/`<=`/`>=`/`&&`/`||` 等读取比较。
function isLValueWrite(whole, pos) {
    const after = whole.slice(pos);
    return /^\s*(?:=(?!=)|\+=|-=|\*=|\/=|<<=|>>=|&=|\|=|\^=|%=|(?:\+\+|--))/.test(after);
}
// 单 stage 转换：对 rawVert 用 vertex 语义、对 rawFrag 用 fragment 语义。
// bindingOffset：本 stage 的第一个 layout(binding=N) 编号。跨 stage（vert+frag）由
// glslToNagaPass 传续，保证合并 uniforms 后的 binding 全局唯一（wasm 侧据此布置单一 bind group）。
function convertStage(src, stage, combos, uniforms, bindingOffset) {
    // ① 展开 WE 内置头 include；未显式 include common.h 则隐式前置（WE 引擎对效果 shader 隐式提供）。
    // 先统一行尾（WE 安装目录 shader 为 CRLF，`\r` 会让 `(.*)$`/`$` 类正则锚点失配——JS `.` 不匹配 `\r`）。
    const hadExplicitCommon = src.includes('#include "common.h"');
    let s = expandIncludes(src.replace(/\r\n?/g, '\n'));
    if (!hadExplicitCommon)
        s = WE_HEADERS['common.h'] + '\n' + s;
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
    // ④''' 按组合宏裁剪互斥 `#if/#elif/#else/#endif` 分支（task-18 根因之二）：glslang 的 C 预处理器
    //   在编译时裁剪，但 JS 侧 `assignInterfaceLocations` 需在**裁剪后**文本上编号 varying（否则互斥
    //   多分支里每个分支的声明都被编号，把选中分支的 location 推到超过 WebGPU
    //   `maxInterStageShaderVariables`(=16)，如 blur/localcontrast_gaussian 的 `#if KERNEL==0/1/2`
    //   ——保留分支的数组 varying 展开后被推到 location 20+，wgpu 校验拒绝）。必须先行裁剪。
    //   求值用与 `buildDefines` 同一宏集（combos 优先 → [COMBO] 默认 → 未定义兜底 0），与 glslang
    //   语义一致；`#ifdef`/`#ifndef` 按"是否定义"处理（初始已定义集 = combos 名 + [COMBO] 默认宏，
    //   不含被兜底成 0 的 #if 标识符——后者是未定义，`#ifdef` 应判 false）。
    s = expandIfBranches(s, buildDefinesMap(s, combos), new Set([...Object.keys(combos), ...extractComboDefaults(s).keys()]));
    // ⑤ 插值/属性改写：fragment 的 varying→in，vertex 的 varying→out；attribute→in。
    // 支持数组 varying/attribute（`varying vec2 v_TexCoord[4];`，blur/downsample 效果用）。
    // ⑤'' 数组 IO 展开（task-18 根因）：naga 24 的 Validator 校验 `NotIOShareableType`——
    //   `TypeFlags::IO_SHAREABLE` 对数组顶层 IO 不成立，由 naga spv-in 产生的数组 varying/attribute
    //   （如 blur/localcontrast 的 `varying vec2 v_TexCoord[4]` 采样偏移数组）spv-in 后过校验必失败，
    //   导致效果链 pass 编译失败、整链回退。WE 效果 shader 的数组下标恒为常量（0..N-1），
    //   故展开为 N 个**同名后缀**的单独声明（语义等价位点连续 location），并把常量下标引用改写为
    //   对应后缀名，使 glslang 产出的 SPIR-V 无数组 IO、naga spv-in 正常通过。
    s = expandArrayIO(s, stage);
    const varyingKw = stage === 'vert' ? 'out' : 'in';
    s = s.replace(/\bvarying\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\w+)(\s*\[\s*\d+\s*\])?\s*;/g, (m, type, name, arr) => `${varyingKw} ${type} ${name}${arr ?? ''};`);
    s = s.replace(/\battribute\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\w+)(\s*\[\s*\d+\s*\])?\s*;/g, (m, type, name, arr) => `in ${type} ${name}${arr ?? ''};`);
    // ⑤' 用户可变接口 location（glslang Vulkan 硬性要求，见 assignInterfaceLocations 注释）。
    s = assignInterfaceLocations(s, stage);
    // ⑥ gl_FragColor（仅 fragment）→ o_Color，引用替换。
    if (stage === 'frag')
        s = s.replace(/gl_FragColor/g, 'o_Color');
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
    const binds = [];
    let bind = bindingOffset;
    // samplerCount：本 stage 的 sampler（组合采样器）个数。spirv-webgpu-transform 拆组合采样器时
    // 每个 sampler2D 合法消费 **2 个** binding 槽（1 texture + 1 sampler），而非本函数编号用的 1 个。
    // 故 `nextBinding = bind + samplerCount`（= offset + 2*#sampler + #block）才是该 stage 拆分后的
    // 实际 binding 上限——下游 stage（vert 从 frag.nextBinding 继续）以此错开，避免跨 stage 因
    // transform 扩展而 binding 碰撞（task-16 根因）。
    let samplerCount = 0;
    const decls = [];
    s = s.replace(UNIFORM_LINE_RE, (m, indent, type, name, arrSize) => {
        decls.push({ type, name, arrSize });
        return '\n';
    });
    if (decls.length) {
        const opaqueLines = [];
        const nonOpaque = [];
        let blockBinding = null;
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
            }
            else {
                // 非不透明 → std140 block 成员（无实例名，成员全局可见）。按声明顺序排布，offset 增量计算
                // （与 glslang std140 一致，见 std140TypeInfo）；block 首个成员分配 block binding（全体共用）。
                if (blockBinding === null)
                    blockBinding = bind++;
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
        if (opaqueLines.length)
            s = `${opaqueLines.join('\n')}\n${s}`;
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
// WE 语义：combo 宏是**整 pass 共用**（vert+frag 读同一宏值）。但 `// [COMBO] {...}` 的 default
// 注释通常只出现在某个 stage（多为 frag）的源码里。若 vertex 用 `#if <COMBO> == N` 判定是否输出
// 某 varying（如 godrays downsample2 的 `v_NoiseTexCoord`，`#if NOISE == 1`），而该 combo 的
// 默认只在 frag 的 [COMBO] 注释中声明 → 下述 `convertStage` 对 vert 只按 vert 源码建宏（找不到
// 默认 → `extractIfIdentifiers` 兜底设 `#define NOISE 0`），导致 **vert 不输出该 varying、frag 却
// 声明对应输入** → `interStageLocationsMatch` 判定不匹配 → 该 pass 被跳过（godrays 静态根因）。
// 故先把**两个 stage** 的 [COMBO] 默认合并进 pass.combos，再传给两个 stage 的转换。
function passCombos(pass) {
    const merged = { ...pass.combos };
    for (const src of [pass.rawVert, pass.rawFrag]) {
        for (const [k, v] of extractComboDefaults(src)) {
            if (!(k in merged))
                merged[k] = v;
        }
    }
    return merged;
}
// WE 方言 → desktop GLSL pass 描述（同步；仅做规则①-⑨ 翻译，不编译 SPIR-V）。
// 供单测断言规则 / 调试；生产 wasm 路径用 glslToNagaPass（含 glslang SPIR-V 编译）。
// 规则①-⑨ 对 rawVert/rawFrag 各自执行；layout(binding=N) 编号跨 stage 全局唯一
// （frag 先编号 [0..n)，vert 从 frag.nextBinding（下一个空闲 binding）继续，合并 uniforms 无重复 binding）。
export function glslToNagaGlsl(pass) {
    const combos = passCombos(pass);
    const frag = convertStage(pass.rawFrag, 'frag', combos, pass.uniforms, 0);
    const vert = convertStage(pass.rawVert, 'vert', combos, pass.uniforms, frag.nextBinding);
    return {
        vertGlsl: vert.glsl,
        fragGlsl: frag.glsl,
        uniforms: [...frag.binds, ...vert.binds],
        textureSlots: pass.textureSlots,
        blendMode: pass.blendMode,
    };
}
// WE 方言 → SPIR-V bytes pass 描述（异步；@webgpu/glslang 一次初始化，compileGLSL 随后同步）。
// glslang 产 SPIR-V 的 entry_point 恒为 `main`（wasm 侧 spv_to_wgsl/naga spv-in 亦解析为 `main`）。
// 编译失败抛错 → 调用方捕获并回退（绝不白屏）。
export async function glslToNagaPass(pass) {
    const combos = passCombos(pass);
    const frag = convertStage(pass.rawFrag, 'frag', combos, pass.uniforms, 0);
    const vert = convertStage(pass.rawVert, 'vert', combos, pass.uniforms, frag.nextBinding);
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
// WebGPU inter-stage 匹配校验（task-18）：fragment 的每个 `layout(location=N)` 输入，必须存在
// 相同 location 且相同类型的 vertex 输出。GL 对"未连接的 varying"提供默认值，WebGPU 严格校验
// （"component count ... is different" / 缺 location 则 CreateRenderPipeline 失败）。WE 效果 shader
// 偶有 fragment 输入无对应 vertex 输出（如 waterripple.frag 的 `varying vec2 v_Scroll;`，而其
// waterripple.vert 未输出 v_Scroll）——此类 pass 在 WebGPU 下无法建管线，由调用方**跳过该 pass**
// （效果链级容错，而非整链回退）。返回 true = 匹配。
export function interStageLocationsMatch(vertGlsl, fragGlsl) {
    const ioOf = (glsl, io) => {
        const m = new Map();
        for (const mm of glsl.matchAll(new RegExp(`layout\\s*\\(\\s*location\\s*=\\s*(\\d+)\\s*\\)\\s*${io}\\s+([A-Za-z0-9_]+)\\s+\\w+`, 'g'))) {
            m.set(Number(mm[1]), mm[2]);
        }
        return m;
    };
    const vout = ioOf(vertGlsl, 'out');
    const fin = ioOf(fragGlsl, 'in');
    for (const [loc, type] of fin) {
        if (vout.get(loc) !== type)
            return false;
    }
    return true;
}
