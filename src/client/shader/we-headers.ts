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
#define M_PI_HALF 1.57079632679489661923
#define M_PI_2 6.28318530718
#define SQRT_2 1.41421356237309504880
#define SQRT_3 1.73205080756887729352
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

vec2 rotateVec2(vec2 v, float r) {
  vec2 cs = vec2(cos(r), sin(r));
  return vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}

vec2 rotateVec2(vec4 v, float r) { return rotateVec2(v.xy, r); }

// —— WE 引擎通用强转/数学方言（HLSL 转 GLSL 产物，非引擎 common.h 转写，需全局补齐）——
// CAST2/CAST3/CAST4 等是 HLSL (floatN)x 强转的等价物：对**任意**标量/向量 x 均合法
// （vec3(float)=标量广播、vec3(vec2/3)=取分量/透传、vec3(vec4)=取 xyz），故用宏而非函数。
// 真实 WE effects 实测：blendgradient 用 CAST2(0.0)/CAST3(0.0)，waterflow 用 CAST4(vec4)，
// depthparallax 用 CAST3X3(mat4)，model_vertex_v1.h 用 CASTF(uint→float)/CASTU(float→uint)。
#define CAST2(x) vec2(x)
#define CAST3(x) vec3(x)
#define CAST4(x) vec4(x)
#define CASTF(x) float(x)
#define CASTU(x) uint(x)
#define CAST2X2(x) mat2(x)
#define CAST3X3(x) mat3(x)
#define CAST4X4(x) mat4(x)
// WE 的 atan2(y,x) 是 HLSL 风格；GLSL 内建为 atan(y,x)，仅映射名字（fisheye 等效果 shader）。
#define atan2(y, x) atan(y, x)

// —— 以下为引擎真实 common.h 转写（D:\\Steam\\steamapps\\common\\wallpaper_engine\\assets\\shaders\\common.h）——
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(frac(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

vec3 rgb2hsv(vec3 RGB) {
  vec4 P = (RGB.g < RGB.b) ? vec4(RGB.bg, -1.0, 2.0/3.0) : vec4(RGB.gb, 0.0, -1.0/3.0);
  vec4 Q = (RGB.r < P.x) ? vec4(P.xyw, RGB.r) : vec4(RGB.r, P.yzx);
  float C = Q.x - min(Q.w, Q.y);
  float H = abs((Q.w - Q.y) / (6.0 * C + 1e-10) + Q.z);
  vec3 HCV = vec3(H, C, Q.x);
  float S = HCV.y / (HCV.z + 1e-10);
  return vec3(HCV.x, S, HCV.z);
}

float greyscale(vec3 color) {
  return dot(color, vec3(0.11, 0.59, 0.3));
}
// —— 引擎转写结束 ——

// WE 行主序约定：gl_Position = mul(vec4(a_Position,1), g_ModelViewProjectionMatrix)
vec4 mul(vec4 v, mat4 m) { return m * v; }
vec3 mul(vec3 v, mat3 m) { return m * v; }
#endif
`;

// 高斯模糊辅助（common_blur.h）：引擎逐字转写（blur13/blur7/blur3 rgb 版、
// blur13a/blur7a/blur3a alpha 版、blurRotateVec2、blurRadial13a/7a/3a）。
const COMMON_BLUR_H = `
#ifndef WE_COMMON_BLUR_H
#define WE_COMMON_BLUR_H
vec3 blur13(vec2 u, vec2 d)
{
	vec2 o1 = CAST2(1.4091998770852122) * d;
	vec2 o2 = CAST2(3.2979348079914822) * d;
	vec2 o3 = CAST2(5.2062900776825969) * d;
	return texSample2D(g_Texture0, u).rgb * 0.1976406528809576
	+ texSample2D(g_Texture0, u + o1).rgb * 0.2959855056006557
	+ texSample2D(g_Texture0, u - o1).rgb * 0.2959855056006557
	+ texSample2D(g_Texture0, u + o2).rgb * 0.0935333619980593
	+ texSample2D(g_Texture0, u - o2).rgb * 0.0935333619980593
	+ texSample2D(g_Texture0, u + o3).rgb * 0.0116608059608062
	+ texSample2D(g_Texture0, u - o3).rgb * 0.0116608059608062;
}
vec3 blur7(vec2 u, vec2 d)
{
	vec2 o1 = CAST2(2.3515644035337887) * d;
	vec2 o2 = CAST2(0.469433779698372) * d;
	vec2 o3 = CAST2(1.4091998770852121) * d;
	vec2 o4 = CAST2(3) * d;
	return texSample2D(g_Texture0, u + o1).rgb * 0.2028175528299753
	+ texSample2D(g_Texture0, u + o2).rgb * 0.4044856614512112
	+ texSample2D(g_Texture0, u - o3).rgb * 0.3213933537319605
	+ texSample2D(g_Texture0, u - o4).rgb * 0.0713034319868530;
}
vec3 blur3(vec2 u, vec2 d)
{
	return texSample2D(g_Texture0, u + d).rgb * 0.25
	+ texSample2D(g_Texture0, u).rgb * 0.5
	+ texSample2D(g_Texture0, u - d).rgb * 0.25;
}
vec4 blur13a(vec2 u, vec2 d)
{
	vec2 o1 = CAST2(1.4091998770852122) * d;
	vec2 o2 = CAST2(3.2979348079914822) * d;
	vec2 o3 = CAST2(5.2062900776825969) * d;
	return texSample2D(g_Texture0, u) * 0.1976406528809576
	+ texSample2D(g_Texture0, u + o1) * 0.2959855056006557
	+ texSample2D(g_Texture0, u - o1) * 0.2959855056006557
	+ texSample2D(g_Texture0, u + o2) * 0.0935333619980593
	+ texSample2D(g_Texture0, u - o2) * 0.0935333619980593
	+ texSample2D(g_Texture0, u + o3) * 0.0116608059608062
	+ texSample2D(g_Texture0, u - o3) * 0.0116608059608062;
}
vec4 blur7a(vec2 u, vec2 d)
{
	vec2 o1 = CAST2(2.3515644035337887) * d;
	vec2 o2 = CAST2(0.469433779698372) * d;
	vec2 o3 = CAST2(1.4091998770852121) * d;
	vec2 o4 = CAST2(3) * d;
	return texSample2D(g_Texture0, u + o1) * 0.2028175528299753
	+ texSample2D(g_Texture0, u + o2) * 0.4044856614512112
	+ texSample2D(g_Texture0, u - o3) * 0.3213933537319605
	+ texSample2D(g_Texture0, u - o4) * 0.0713034319868530;
}
vec4 blur3a(vec2 u, vec2 d)
{
	return texSample2D(g_Texture0, u + d) * 0.25
	+ texSample2D(g_Texture0, u) * 0.5
	+ texSample2D(g_Texture0, u - d) * 0.25;
}
vec2 blurRotateVec2(vec2 v, float r)
{
	vec2 cs = vec2(cos(r), sin(r));
	return vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x);
}
vec4 blurRadial13a(vec2 u, vec2 center, float amt)
{
	vec2 delta = u - center;
	amt = amt * 0.025;
	float o1 = 1.4091998770852122 * amt;
	float o2 = 3.2979348079914822 * amt;
	float o3 = 5.2062900776825969 * amt;
	vec2 r1 = blurRotateVec2(delta, o1) - delta;
	vec2 r2 = blurRotateVec2(delta, o2) - delta;
	vec2 r3 = blurRotateVec2(delta, o3) - delta;
	return texSample2D(g_Texture0, u) * 0.1976406528809576
	+ texSample2D(g_Texture0, center + r1 + delta) * 0.2959855056006557
	+ texSample2D(g_Texture0, center - r1 + delta) * 0.2959855056006557
	+ texSample2D(g_Texture0, center + r2 + delta) * 0.0935333619980593
	+ texSample2D(g_Texture0, center - r2 + delta) * 0.0935333619980593
	+ texSample2D(g_Texture0, center + r3 + delta) * 0.0116608059608062
	+ texSample2D(g_Texture0, center - r3 + delta) * 0.0116608059608062;
}
vec4 blurRadial7a(vec2 u, vec2 center, float amt)
{
	vec2 delta = u - center;
	amt = amt * 0.025;
	float o1 = 2.3515644035337887 * amt;
	float o2 = 0.469433779698372 * amt;
	float o3 = 1.4091998770852121 * amt;
	float o4 = 3 * amt;
	vec2 r1 = blurRotateVec2(delta, o1) - delta;
	vec2 r2 = blurRotateVec2(delta, o2) - delta;
	vec2 r3 = blurRotateVec2(delta, -o3) - delta;
	vec2 r4 = blurRotateVec2(delta, -o4) - delta;

	return texSample2D(g_Texture0, center + r1 + delta) * 0.2028175528299753
	+ texSample2D(g_Texture0, center + r2 + delta) * 0.4044856614512112
	+ texSample2D(g_Texture0, center + r3 + delta) * 0.3213933537319605
	+ texSample2D(g_Texture0, center + r4 + delta) * 0.0713034319868530;
}
vec4 blurRadial3a(vec2 u, vec2 center, float amt)
{
	vec2 delta = u - center;
	amt = amt * 0.025;
	float o1 = amt;
	vec2 r1 = blurRotateVec2(delta, o1) - delta;

	return texSample2D(g_Texture0, center + delta) * 0.5
	+ texSample2D(g_Texture0, center + r1 + delta) * 0.25
	+ texSample2D(g_Texture0, center - r1 + delta) * 0.25;
}
#endif
`;

// 图像混合（common_blending.h，引擎真实实现逐字转写）：宏驱动 ApplyBlending，
// BLENDMODE 1-32 编译期分支（12=SoftLight、30=Tint、31=线性加 A+B*opacity，default=BlendNormal）。
// BLENDMODE 宏由 scene.json combos 注入，未提供时 #if 裸标识符兜底 #define BLENDMODE 0。
// 返回类型：vec3 —— 全库 5 处调用均赋给 vec3 / .rgb（tint/Simple_Audio_Bars/
// chromatic_aberration/apply/gaussian），WE 引擎语义是仅 rgb 参与混合。
const COMMON_BLENDING_H = `
#ifndef WE_COMMON_BLENDING_H
#define WE_COMMON_BLENDING_H
vec4 Desaturate(vec3 color, float Desaturation)
{
	vec3 grayXfer = vec3(0.3, 0.59, 0.11);
	vec3 gray = CAST3(dot(grayXfer, color));
	return vec4(mix(color, gray, Desaturation), 1.0);
}

vec3 RGBToHSL(vec3 color)
{
#ifdef HDR
	color = saturate(color);
#endif

	vec3 hsl;
	float fmin = min(min(color.r, color.g), color.b);
	float fmax = max(max(color.r, color.g), color.b);
	float delta = fmax - fmin;
	hsl.z = (fmax + fmin) / 2.0;

	if (delta == 0.0)
	{
		hsl.x = 0.0;
		hsl.y = 0.0;
	}
	else
	{
		if (hsl.z < 0.5)
			hsl.y = delta / (fmax + fmin);
		else
			hsl.y = delta / (2.0 - fmax - fmin);
		float deltaR = (((fmax - color.r) / 6.0) + (delta / 2.0)) / delta;
		float deltaG = (((fmax - color.g) / 6.0) + (delta / 2.0)) / delta;
		float deltaB = (((fmax - color.b) / 6.0) + (delta / 2.0)) / delta;
		if (color.r == fmax )
			hsl.x = deltaB - deltaG;
		else if (color.g == fmax)
			hsl.x = (1.0 / 3.0) + deltaR - deltaB;
		else if (color.b == fmax)
			hsl.x = (2.0 / 3.0) + deltaG - deltaR;

		if (hsl.x < 0.0)
			hsl.x += 1.0;
		else if (hsl.x > 1.0)
			hsl.x -= 1.0;
	}

	return hsl;
}

float HueToRGB(float f1, float f2, float hue)
{
	if (hue < 0.0)
		hue += 1.0;
	else if (hue > 1.0)
		hue -= 1.0;
	float res;
	if ((6.0 * hue) < 1.0)
		res = f1 + (f2 - f1) * 6.0 * hue;
	else if ((2.0 * hue) < 1.0)
		res = f2;
	else if ((3.0 * hue) < 2.0)
		res = f1 + (f2 - f1) * ((2.0 / 3.0) - hue) * 6.0;
	else
		res = f1;
	return res;
}

vec3 HSLToRGB(vec3 hsl)
{
	vec3 rgb;
	if (hsl.y == 0.0)
		rgb = CAST3(hsl.z);
	else
	{
		float f2;
		if (hsl.z < 0.5)
			f2 = hsl.z * (1.0 + hsl.y);
		else
			f2 = (hsl.z + hsl.y) - (hsl.y * hsl.z);
		float f1 = 2.0 * hsl.z - f2;
		rgb.r = HueToRGB(f1, f2, hsl.x + (1.0/3.0));
		rgb.g = HueToRGB(f1, f2, hsl.x);
		rgb.b= HueToRGB(f1, f2, hsl.x - (1.0/3.0));
	}
	
	return rgb;
}

vec3 ContrastSaturationBrightness(vec3 color, float brt, float sat, float con)
{
	const float AvgLumR = 0.5;
	const float AvgLumG = 0.5;
	const float AvgLumB = 0.5;
	
	const vec3 LumCoeff = vec3(0.2125, 0.7154, 0.0721);
	
	vec3 AvgLumin = vec3(AvgLumR, AvgLumG, AvgLumB);
	vec3 brtColor = color * brt;
	vec3 intensity = CAST3(dot(brtColor, LumCoeff));
	vec3 satColor = mix(intensity, brtColor, sat);
	vec3 conColor = mix(AvgLumin, satColor, con);
	return conColor;
}

#define BlendLinearDodgef(base, blend) (base + blend)
#define BlendLinearBurnf(base, blend) max(base + blend - 1.0, 0.0)
#define BlendLightenf(base, blend) max(blend, base)
#define BlendDarkenf(base, blend) min(blend, base)
#define BlendLinearLightf(base, blend) (blend < 0.5 ? BlendLinearBurnf(base, (2.0 * blend)) : BlendLinearDodgef(base, (2.0 * (blend - 0.5))))
#define BlendScreenf(base, blend) (1.0 - ((1.0 - base) * (1.0 - blend)))
#define BlendOverlayf(base, blend) (base < 0.5 ? (2.0 * base * blend) : (1.0 - 2.0 * (1.0 - base) * (1.0 - blend)))
#define BlendSoftLightf(base, blend) ((blend < 0.5) ? (2.0 * base * blend + base * base * (1.0 - 2.0 * blend)) : (sqrt(base) * (2.0 * blend - 1.0) + 2.0 * base * (1.0 - blend)))
#define BlendColorDodgef(base, blend) ((blend == 1.0) ? blend : min(base / (1.0 - blend), 1.0))
#define BlendColorBurnf(base, blend) ((blend == 0.0) ? blend : max((1.0 - ((1.0 - base) / blend)), 0.0))
#define BlendVividLightf(base, blend) ((blend < 0.5) ? BlendColorBurnf(base, (2.0 * blend)) : BlendColorDodgef(base, (2.0 * (blend - 0.5))))
#define BlendPinLightf(base, blend) ((blend < 0.5) ? BlendDarkenf(base, (2.0 * blend)) : BlendLightenf(base, (2.0 *(blend - 0.5))))
#define BlendHardMixf(base, blend) ((BlendVividLightf(base, blend) < 0.5) ? 0.0 : 1.0)
#define BlendReflectf(base, blend) ((blend == 1.0) ? blend : min(base * base / (1.0 - blend), 1.0))
#define BlendNormal(base, blend) (blend)
#define BlendLighten BlendLightenf
#define BlendDarken	 BlendDarkenf
#define BlendMultiply(base, blend) (base * blend)
#define BlendAverage(base, blend) ((base + blend) / 2.0)
#define BlendAdd(base, blend) min(base + blend, CAST3(1.0))
#define BlendSubstract(base, blend) max(base + blend - CAST3(1.0), CAST3(0.0))
#define BlendDifference(base, blend) abs(base - blend)
#define BlendNegation(base, blend) (CAST3(1.0) - abs(CAST3(1.0) - base - blend))
#define BlendExclusion(base, blend) (base + blend - 2.0 * base * blend)
#define BlendScreen(base, blend) vec3(BlendScreenf(base.r, blend.r), BlendScreenf(base.g, blend.g), BlendScreenf(base.b, blend.b))
#define BlendOverlay(base, blend) vec3(BlendOverlayf(base.r, blend.r), BlendOverlayf(base.g, blend.g), BlendOverlayf(base.b, blend.b))
#define BlendSoftLight(base, blend) vec3(BlendSoftLightf(base.r, blend.r), BlendSoftLightf(base.g, blend.g), BlendSoftLightf(base.b, blend.b))
#define BlendHardLight(base, blend) BlendOverlay(blend, base)
#define BlendColorDodge(base, blend) vec3(BlendColorDodgef(base.r, blend.r), BlendColorDodgef(base.g, blend.g), BlendColorDodgef(base.b, blend.b))
#define BlendColorBurn(base, blend) vec3(BlendColorBurnf(base.r, blend.r), BlendColorBurnf(base.g, blend.g), BlendColorBurnf(base.b, blend.b))
#define BlendLinearLight(base, blend) vec3(BlendLinearLightf(base.r, blend.r), BlendLinearLightf(base.g, blend.g), BlendLinearLightf(base.b, blend.b))
#define BlendVividLight(base, blend) vec3(BlendVividLightf(base.r, blend.r), BlendVividLightf(base.g, blend.g), BlendVividLightf(base.b, blend.b))
#define BlendPinLight(base, blend) vec3(BlendPinLightf(base.r, blend.r), BlendPinLightf(base.g, blend.g), BlendPinLightf(base.b, blend.b))
#define BlendHardMix(base, blend) vec3(BlendHardMixf(base.r, blend.r), BlendHardMixf(base.g, blend.g), BlendHardMixf(base.b, blend.b))
#define BlendReflect(base, blend) vec3(BlendReflectf(base.r, blend.r), BlendReflectf(base.g, blend.g), BlendReflectf(base.b, blend.b))
#define BlendGlow(base, blend) BlendReflect(blend, base)
#define BlendPhoenix(base, blend) (min(base, blend) - max(base, blend) + CAST3(1.0))
#define BlendOpacity(base, blend, F, O) mix(base, F(base, blend), O)
#define BlendLinearDodge(base, blend) min(base + blend, CAST3(1.0))
#define BlendLinearBurn(base, blend) max(base + blend - CAST3(1.0), CAST3(0.0))
#define BlendTint(base, blend) (CAST3(max(base.x, max(base.y, base.z))) * blend)

vec3 BlendHue(vec3 base, vec3 blend)
{
	vec3 baseHSL = RGBToHSL(base);
	return HSLToRGB(vec3(RGBToHSL(blend).r, baseHSL.g, baseHSL.b));
}

vec3 BlendSaturation(vec3 base, vec3 blend)
{
	vec3 baseHSL = RGBToHSL(base);
	return HSLToRGB(vec3(baseHSL.r, RGBToHSL(blend).g, baseHSL.b));
}

vec3 BlendColor(vec3 base, vec3 blend)
{
	vec3 blendHSL = RGBToHSL(blend);
	return HSLToRGB(vec3(blendHSL.r, blendHSL.g, RGBToHSL(base).b));
}

vec3 BlendLuminosity(vec3 base, vec3 blend)
{
	vec3 baseHSL = RGBToHSL(base);
	return HSLToRGB(vec3(baseHSL.r, baseHSL.g, RGBToHSL(blend).b));
}

vec3 ApplyBlending(const int blendMode, in vec3 A, in vec3 B, in float opacity)
{
#if BLENDMODE == 1
	return mix(A,BlendDarken(A,B),opacity);
#endif
#if BLENDMODE == 2
	return mix(A,BlendMultiply(A,B),opacity);
#endif
#if BLENDMODE == 3
	return mix(A,BlendColorBurn(A,B),opacity);
#endif
#if BLENDMODE == 4
	return mix(A,BlendSubstract(A,B),opacity);
#endif
#if BLENDMODE == 5
	return min(A, B);
#endif
#if BLENDMODE == 6
	return mix(A,BlendLighten(A,B),opacity);
#endif
#if BLENDMODE == 7
	return mix(A,BlendScreen(A,B),opacity);
#endif
#if BLENDMODE == 8
	return mix(A,BlendColorDodge(A,B),opacity);
#endif
#if BLENDMODE == 9
	return mix(A,BlendAdd(A,B),opacity);
#endif
#if BLENDMODE == 10
	return max(A, B);
#endif
#if BLENDMODE == 11
	return mix(A,BlendOverlay(A,B),opacity);
#endif
#if BLENDMODE == 12
	return mix(A,BlendSoftLight(A,B),opacity);
#endif
#if BLENDMODE == 13
	return mix(A,BlendHardLight(A,B),opacity);
#endif
#if BLENDMODE == 14
	return mix(A,BlendVividLight(A,B),opacity);
#endif
#if BLENDMODE == 15
	return mix(A,BlendLinearLight(A,B),opacity);
#endif
#if BLENDMODE == 16
	return mix(A,BlendPinLight(A,B),opacity);
#endif
#if BLENDMODE == 17
	return mix(A,BlendHardMix(A,B),opacity);
#endif
#if BLENDMODE == 18
	return mix(A,BlendDifference(A,B),opacity);
#endif
#if BLENDMODE == 19
	return mix(A,BlendExclusion(A,B),opacity);
#endif
#if BLENDMODE == 20
	return mix(A,BlendSubstract(A,B),opacity);
#endif
#if BLENDMODE == 21
	return mix(A,BlendReflect(A,B),opacity);
#endif
#if BLENDMODE == 22
	return mix(A,BlendGlow(A,B),opacity);
#endif
#if BLENDMODE == 23
	return mix(A,BlendPhoenix(A,B),opacity);
#endif
#if BLENDMODE == 24
	return mix(A,BlendAverage(A,B),opacity);
#endif
#if BLENDMODE == 25
	return mix(A,BlendNegation(A,B),opacity);
#endif
#if BLENDMODE == 26
	return mix(A,BlendHue(A,B),opacity);
#endif
#if BLENDMODE == 27
	return mix(A,BlendSaturation(A,B),opacity);
#endif
#if BLENDMODE == 28
	return mix(A,BlendColor(A,B),opacity);
#endif
#if BLENDMODE == 29
	return mix(A,BlendLuminosity(A,B),opacity);
#endif
#if BLENDMODE == 30
	return mix(A,BlendTint(A,B),opacity);
#endif
#if BLENDMODE == 31
	return A+B*opacity;
#endif
#if BLENDMODE == 32
	return mix(A,A+A*B,opacity);
#endif
	return mix(A,BlendNormal(A,B),opacity);
}
#endif
`;

// 透视辅助（common_perspective.h）：引擎逐字转写（列主序 squareToQuad，含 diffy2/det 分支）。
// 引擎源文件末尾的 #if HLSL inverse(mat3) 原样保留——GLSL3 下 HLSL 未定义为 0，
// 该分支不生效；GLSL ES 3.00 内置 inverse，仍不在此重复定义。
const COMMON_PERSPECTIVE_H = `
#ifndef WE_COMMON_PERSPECTIVE_H
#define WE_COMMON_PERSPECTIVE_H

mat3 squareToQuad(vec2 p0, vec2 p1, vec2 p2, vec2 p3) {
	mat3 m = mat3(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);
	float dx0 = p0.x;
	float dy0 = p0.y;
	float dx1 = p1.x;
	float dy1 = p1.y;
	
	float dx2 = p3.x;
	float dy2 = p3.y;
	float dx3 = p2.x;
	float dy3 = p2.y;
	
	float diffx1 = dx1 - dx3;
	float diffy1 = dy1 - dy3;
	float diffx2 = dx2 - dx3;
	float diffy2 = dy2 - dy3;

	float det = diffx1*diffy2 - diffx2*diffy1;
	float sumx = dx0 - dx1 + dx3 - dx2;
	float sumy = dy0 - dy1 + dy3 - dy2;

	if (det == 0.0 || (sumx == 0.0 && sumy == 0.0)) {
		m[0][0] = dx1 - dx0;
		m[0][1] = dy1 - dy0;
		m[0][2] = 0.0;
		m[1][0] = dx3 - dx1;
		m[1][1] = dy3 - dy1;
		m[1][2] = 0.0;
		m[2][0] = dx0;
		m[2][1] = dy0;
		m[2][2] = 1.0;
		return m;
	} else {
		float ovdet = 1.0 / det;
		float g = (sumx * diffy2 - diffx2 * sumy) * ovdet;
		float h = (diffx1 * sumy - sumx * diffy1) * ovdet;

		m[0][0] = dx1 - dx0 + g * dx1;
		m[0][1] = dy1 - dy0 + g * dy1;
		m[0][2] = g;
		m[1][0] = dx2 - dx0 + h * dx2;
		m[1][1] = dy2 - dy0 + h * dy2;
		m[1][2] = h;
		m[2][0] = dx0;
		m[2][1] = dy0;
		m[2][2] = 1.0;
		return m;
	}
}

#if HLSL
mat3 inverse(mat3 m) {
	float a00 = m[0][0], a01 = m[0][1], a02 = m[0][2];
	float a10 = m[1][0], a11 = m[1][1], a12 = m[1][2];
	float a20 = m[2][0], a21 = m[2][1], a22 = m[2][2];
	float b01 = a22 * a11 - a12 * a21;
	float b11 = -a22 * a10 + a12 * a20;
	float b21 = a21 * a10 - a11 * a20;
	float det = a00 * b01 + a01 * b11 + a02 * b21;
	return mat3(b01, (-a22 * a01 + a02 * a21), (a12 * a01 - a02 * a11),
			  b11, (a22 * a00 - a02 * a20), (-a12 * a00 + a02 * a10),
			  b21, (-a21 * a00 + a01 * a20), (a11 * a00 - a01 * a10)) / det;
}
#endif
#endif
`;

// 合成头（common_composite.h）：ApplyComposite/ApplyCompositeOffset + 3 个 g_Composite* uniform，
// 内部 include common.h / common_blending.h（preprocessWeShader 递归展开）。
// 转写自引擎 D:\\Steam\\steamapps\\common\\wallpaper_engine\\assets\\shaders\\common_composite.h
// （省略引擎源文件中的 4 条英文注释，逻辑逐字一致）
const COMMON_COMPOSITE_H = `
#include "common.h"
#include "common_blending.h"

uniform float g_CompositeAlpha; // {"material":"compositealpha","label":"ui_editor_properties_alpha","default":1,"range":[0.0, 2.0]}
uniform vec2 g_CompositeOffset; // {"material":"compositeoffset","label":"ui_editor_properties_offset","default":"0 0","linked":true,"range":[-10.0, 10.0]}
uniform vec3 g_CompositeColor; // {"material":"compositecolor","label":"ui_editor_properties_color","default":"1 1 1","type":"color"}

vec2 ApplyCompositeOffset(vec2 texCoords, vec2 textureResolution)
{
#if COMPOSITE != 0
	return texCoords + g_CompositeOffset / textureResolution;
#else
	return texCoords;
#endif
}

vec4 ApplyComposite(vec4 original, vec4 effect)
{
#if COMPOSITEMONO == 1
	effect.rgb = CAST3(greyscale(effect.rgb));
#endif

	effect.rgb *= g_CompositeColor;

#if COMPOSITE == 0
	return effect;
#endif

#if COMPOSITE == 1
	effect.rgb = ApplyBlending(BLENDMODE, original.rgb, effect.rgb, effect.a * g_CompositeAlpha);
	effect.a = max(effect.a * saturate(g_CompositeAlpha), original.a);
#endif

#if COMPOSITE == 2
	effect.a *= saturate(g_CompositeAlpha);
	effect = mix(effect, original, original.a);
#endif

#if COMPOSITE == 3
	effect.a *= saturate(g_CompositeAlpha);
	effect.a *= 1.0 - original.a;
#endif

	return effect;
}
`;
const COMMON_FRAGMENT_H = `
#ifndef WE_COMMON_FRAGMENT_H
#define WE_COMMON_FRAGMENT_H

#define FORMAT_RGBA8888 0
#define FORMAT_RGB888 1
#define FORMAT_RGB565 2

#define FORMAT_ETC1_RGB8 3
#define FORMAT_DXT5 4
#define FORMAT_ETC2_RGBA8 5
#define FORMAT_DXT3 6
#define FORMAT_DXT1 7

#define FORMAT_RG88 8
#define FORMAT_R8 9
#define FORMAT_RG1616F 10
#define FORMAT_R16F 11

#define FORMAT_BC7 12

vec3 DecompressNormal(vec4 normal)
{
#if TEX1FORMAT >= FORMAT_ETC1_RGB8 && TEX1FORMAT <= FORMAT_DXT1 || TEX1FORMAT == FORMAT_BC7
	normal.yx = normal.yw * 2.0 - vec2(0.965, 1.0);
#else
#if TEX1FORMAT == FORMAT_RG88
	normal.xy = normal.rg * 2.0 - 1.0;
#else
	normal.xy = normal.wy * 2.0 - 1.0;
#endif
#endif
	normal.z = sqrt(saturate(1.0 - normal.x * normal.x - normal.y * normal.y));
	return normal.xyz;
}

vec4 DecompressNormalWithMask(vec4 normal)
{
#if TEX1FORMAT >= FORMAT_ETC1_RGB8 && TEX1FORMAT <= FORMAT_DXT1 || TEX1FORMAT == FORMAT_BC7
	normal.xw = normal.wx;
	normal.xy = normal.xy * 2.0 - vec2(0.965, 1.0);
#else
#if TEX1FORMAT == FORMAT_RG88
	normal.xy = normal.gr * 2.0 - 1.0;
#else
	normal.xw = normal.wx;
	normal.xy = normal.xy * 2.0 - 1.0;
#endif
#endif
	normal.z = sqrt(saturate(1.0 - normal.x * normal.x - normal.y * normal.y));
	return normal;
}

float ComputeMaterialSpecularPower(const float roughness, const float metallic)
{
	return (1.01 - roughness) * mix(400.0, 250.0, metallic);
}

float ComputeMaterialSpecularStrength(const float roughness, const float metallic)
{
	return (0.5 + metallic * 0.5) * (1.0 - roughness * 0.9);
}

vec3 ComputeLight(const vec3 normal, const vec3 lightDelta, const vec3 color, const float radius)
{
	float lightDistance = length(lightDelta);
	float lightAttn = saturate((radius - lightDistance) / radius);
	return color * (saturate(dot(lightDelta / lightDistance, normal))) * lightAttn * lightAttn;
}

vec3 ComputeLightSpecular(const vec3 normal, const vec3 lightDelta, const vec3 color, const float radius, const vec3 viewDir, const float specularPower, const float specularStrength, const float halfLambert, const float metallicTerm, inout vec3 specularResult)
{
	float lightDistance = length(lightDelta);
	float lightAttn = saturate((radius - lightDistance) / radius);
	vec3 lightDir = lightDelta / lightDistance;
	float specular = max(0.0, dot(normalize(viewDir + lightDir), normal));
	specularResult += pow(specular, specularPower) * specularStrength * lightAttn * color;
	float lightDot = dot(lightDir, normal);
	float halfLambertLight = lightDot * 0.5 + 0.5;
	lightDot = mix(lightDot, halfLambertLight, halfLambert);
	float rim = metallicTerm * 2.0;
	rim = pow((1.0 - saturate(dot(normal, viewDir))) * pow(halfLambertLight, 0.25), 6.0 - rim) * rim;
	return color * (saturate(lightDot) + rim) * lightAttn * lightAttn;
}

float ConvertSampleR8(vec4 _sample)
{
#if HLSL_SM30
		return _sample.a;
#else
		return _sample.r;
#endif
}

vec4 ConvertTexture0Format(vec4 _sample)
{
#if TEX0FORMAT == FORMAT_RG88 || TEX0FORMAT == FORMAT_RG1616F
#if HLSL_SM30
	return _sample.rrra;
#else
	return _sample.rrrg;
#endif
#endif

#if TEX0FORMAT == FORMAT_R8 || TEX0FORMAT == FORMAT_R16F
#if HLSL_SM30
	return vec4(1, 1, 1, _sample.a);
#else
	return vec4(1, 1, 1, _sample.r);
#endif
#endif
	return _sample;
}

vec4 ConvertTextureFormat(const int format, vec4 _sample)
{
	if (format == FORMAT_RG88 || format == FORMAT_RG1616F)
	{
#if HLSL_SM30
		return _sample.rrra;
#else
		return _sample.rrrg;
#endif
	}

	if (format == FORMAT_R8 || format == FORMAT_R16F)
	{
#if HLSL_SM30
		return vec4(1, 1, 1, _sample.a);
#else
		return vec4(1, 1, 1, _sample.r);
#endif
	}
	return _sample;
}
#endif
`;
const COMMON_VERTEX_H = `
#ifndef WE_COMMON_VERTEX_H
#define WE_COMMON_VERTEX_H
mat3 BuildTangentSpace(const vec3 normal, const vec4 signedTangent)
{
	vec3 tangent = signedTangent.xyz;
	vec3 bitangent = cross(normal, tangent) * signedTangent.w;
	return mat3(tangent, bitangent, normal);
}

mat3 BuildTangentSpace(const mat3 modelTransform, const vec3 normal, const vec4 signedTangent)
{
	vec3 tangent = signedTangent.xyz;
	vec3 bitangent = cross(normal, tangent) * signedTangent.w;
	return mat3(mul(tangent, modelTransform),
		mul(bitangent, modelTransform),
		mul(normal, modelTransform));
}

void BuildTangentSpace(const mat3 modelTransform, const vec3 normal, const vec4 signedTangent, out vec3 worldTangent, out vec3 worldBitangent)
{
	vec3 tangent = signedTangent.xyz;
	vec3 bitangent = cross(normal, tangent) * signedTangent.w;
	worldTangent = mul(tangent, modelTransform);
	worldBitangent = mul(bitangent, modelTransform);
}
#endif
`;

export const WE_HEADERS: Record<string, string> = {
  'common.h': COMMON_H,
  'common_blending.h': COMMON_BLENDING_H,
  'common_perspective.h': COMMON_PERSPECTIVE_H,
  'common_blur.h': COMMON_BLUR_H,
  'common_composite.h': COMMON_COMPOSITE_H,
  'common_fragment.h': COMMON_FRAGMENT_H,
  'common_vertex.h': COMMON_VERTEX_H,
};
