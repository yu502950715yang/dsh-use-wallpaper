// src/client/shader/we-headers.ts
// WE 内置 GLSL 头文件等价物（全库扫描确认的 7 个 include）。
// 方言事实：texSample2D×89、mul×66、rotateVec2×20、squareToQuad×6、inverse×6、
// texSample2DLod×3、mod2×2、frac/saturate（Simple_Audio_Bars）、M_PI/M_PI_2/DEG2RAD 常量。
// three r170 WebGL2 会自动把 texture2D/texture2DLod 映射为 texture/textureLod，
// 因此这里只补 WE 方言函数与常量，不重写标准采样调用。
// 注意（浏览器集成验证修正）：
//  - GLSL ES 3.00 内置 inverse(mat2/3/4)，此处不得重复定义（会报
//    "cannot be redeclared as function"）；squareToQuad 保留。
//  - GLSL3 无 texture2DLod（three 前缀只映射 texture2DLodEXT），texSample2DLod
//    内部改用 textureLod。
//  - mod2 由 Simple_Audio_Bars 自实现（`float mod2(...)`），common.h 不提供
//    以避免重复定义冲突。
//  - CAST2 是 WE 的标量→vec2 构造（全库 8 处调用：scroll/refract/gaussian 等）。

const COMMON_H = `
#ifndef WE_COMMON_H
#define WE_COMMON_H
#define M_PI 3.14159265358979323846
#define M_PI_2 1.57079632679489661923
#define DEG2RAD 0.01745329251994329576923690768489
#define DEG2PCT 0.0027777777777777777777777777777

float frac(float x) { return fract(x); }
vec2 frac(vec2 x) { return fract(x); }
vec3 frac(vec3 x) { return fract(x); }
vec4 frac(vec4 x) { return fract(x); }

float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec2 saturate(vec2 x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
vec4 saturate(vec4 x) { return clamp(x, 0.0, 1.0); }

vec4 texSample2D(sampler2D t, vec2 uv) { return texture2D(t, uv); }
vec4 texSample2DLod(sampler2D t, vec2 uv, float lod) { return textureLod(t, uv, lod); }

vec2 rotateVec2(vec2 v, float angle) {
  float c = cos(angle), s = sin(angle);
  return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}

// WE 行主序约定：gl_Position = mul(vec4(a_Position,1), g_ModelViewProjectionMatrix)
vec4 mul(vec4 v, mat4 m) { return m * v; }
vec3 mul(vec3 v, mat3 m) { return m * v; }

// 标量 → vec2 构造（WE 方言 CAST2(x) = vec2(x)，scroll/refract/gaussian 等使用）
vec2 CAST2(float x) { return vec2(x); }
// 标量 → vec3/vec4 构造（全库实测 CAST3×32、CAST4×67：clouds/shake/blur 等）
vec3 CAST3(float x) { return vec3(x); }
vec4 CAST4(float x) { return vec4(x); }

// 法线贴图解包（WE 引擎内置，全库仅 refract.frag 调用）：RG 编码法线 → 单位法线
// （[0,1] → [-1,1]，z 由单位长度回推）
vec3 DecompressNormal(vec4 texel) {
  vec3 n = texel.xyz * 2.0 - 1.0;
  n.z = sqrt(max(0.0, 1.0 - dot(n.xy, n.xy)));
  return normalize(n);
}
#endif
`;

// 高斯模糊辅助（common_blur.h）：13/7/3 tap，方向与步长由调用方经 v_TexCoord.zw 传入
const COMMON_BLUR_H = `
#ifndef WE_COMMON_BLUR_H
#define WE_COMMON_BLUR_H
vec4 blur13a(vec2 uv, vec2 dir) {
  vec4 c = texSample2D(g_Texture0, uv) * 0.2270270270;
  c += texSample2D(g_Texture0, uv + dir * 1.3846153846) * 0.3162162162;
  c += texSample2D(g_Texture0, uv - dir * 1.3846153846) * 0.3162162162;
  c += texSample2D(g_Texture0, uv + dir * 3.2307692308) * 0.0702702703;
  c += texSample2D(g_Texture0, uv - dir * 3.2307692308) * 0.0702702703;
  return c;
}
vec4 blur7a(vec2 uv, vec2 dir) {
  vec4 c = texSample2D(g_Texture0, uv) * 0.375;
  c += texSample2D(g_Texture0, uv + dir) * 0.25;
  c += texSample2D(g_Texture0, uv - dir) * 0.25;
  c += texSample2D(g_Texture0, uv + dir * 2.0) * 0.0625;
  c += texSample2D(g_Texture0, uv - dir * 2.0) * 0.0625;
  return c;
}
vec4 blur3a(vec2 uv, vec2 dir) {
  vec4 c = texSample2D(g_Texture0, uv) * 0.5;
  c += texSample2D(g_Texture0, uv + dir) * 0.25;
  c += texSample2D(g_Texture0, uv - dir) * 0.25;
  return c;
}
#endif
`;

// 图像混合（common_blending.h）：ApplyBlending(mode, src, dst, alpha)
// BLENDMODE 取值（全库实测）：0=normal、9=add、12=multiply、30/31 为高级模式
// （浏览器验证期按实际画面补充 30/31 语义；缺省回退 normal）
// 返回类型：vec3 —— 全库 5 处调用均赋给 vec3 / .rgb（tint/Simple_Audio_Bars/
// chromatic_aberration/apply/gaussian），WE 引擎语义是仅 rgb 参与混合。
const COMMON_BLENDING_H = `
#ifndef WE_COMMON_BLENDING_H
#define WE_COMMON_BLENDING_H
vec3 ApplyBlending(int mode, vec3 src, vec3 dst, float alpha) {
  if (mode == 9) return dst + src * alpha;
  if (mode == 12) return dst * mix(vec3(1.0), src, alpha);
  if (mode == 30 || mode == 31) return mix(dst, src, alpha); // 待浏览器验证细化
  return mix(dst, src, alpha); // 0=normal 及未知模式
}
#endif
`;

// 透视辅助（common_perspective.h）：squareToQuad。
// 注意：inverse 不在此定义——GLSL ES 3.00 内置 inverse(mat2/3/4)，重定义会报
// "Name of a built-in function cannot be redeclared as function"（浏览器集成验证实测）。
const COMMON_PERSPECTIVE_H = `
#ifndef WE_COMMON_PERSPECTIVE_H
#define WE_COMMON_PERSPECTIVE_H
mat3 squareToQuad(vec2 p0, vec2 p1, vec2 p2, vec2 p3) {
  vec2 d1 = p1 - p2, d2 = p3 - p2, d3 = p0 - p1 + p2 - p3;
  float a = 0.0, b = 0.0;
  if (d3.x != 0.0 || d3.y != 0.0) {
    float cross = d1.x * d2.y - d1.y * d2.x;
    if (cross != 0.0) {
      a = (d2.x * d3.y - d2.y * d3.x) / cross;
      b = (d1.x * d3.y - d1.y * d3.x) / cross;
    }
  }
  mat3 m = mat3(
    p1.x - p0.x + a * p1.x, p1.y - p0.y + a * p1.y, a,
    p3.x - p0.x + b * p3.x, p3.y - p0.y + b * p3.y, b,
    p0.x, p0.y, 1.0
  );
  return m;
}
#endif
`;

// 占位头（当前全库未观察到独立函数，保留空定义避免 include 失败）
const COMMON_COMPOSITE_H = `#ifndef WE_COMMON_COMPOSITE_H\n#define WE_COMMON_COMPOSITE_H\n#endif\n`;
const COMMON_FRAGMENT_H = `#ifndef WE_COMMON_FRAGMENT_H\n#define WE_COMMON_FRAGMENT_H\n#endif\n`;
const COMMON_VERTEX_H = `#ifndef WE_COMMON_VERTEX_H\n#define WE_COMMON_VERTEX_H\n#endif\n`;

export const WE_HEADERS: Record<string, string> = {
  'common.h': COMMON_H,
  'common_blending.h': COMMON_BLENDING_H,
  'common_perspective.h': COMMON_PERSPECTIVE_H,
  'common_blur.h': COMMON_BLUR_H,
  'common_composite.h': COMMON_COMPOSITE_H,
  'common_fragment.h': COMMON_FRAGMENT_H,
  'common_vertex.h': COMMON_VERTEX_H,
};
