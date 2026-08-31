import { describe, expect, it } from 'vitest';
import { glslToNagaGlsl, interStageLocationsMatch } from '../../src/client/shader/glsl-to-naga.js';
import type { CompiledEffectPass } from '../../src/client/shader/effect-chain.js';

function makePass(rawVert: string, rawFrag: string, combos: Record<string, number> = {}): CompiledEffectPass {
  return { vertSrc: '', fragSrc: '', rawVert, rawFrag, combos, uniforms: new Map(), textureSlots: [], blendMode: 'normal' };
}

// task-22：godrays/Chisato（2937346640）效果链 pass 存活性。此前 downsample2（vert `#if NOISE==1`
// 的 v_NoiseTexCoord 因 combo 默认只在 frag 声明 → vert 取 NOISE=0 不输出、frag 取 1 声明输入 →
// inter-stage 不匹配）与 cast（仅声明 MVM、gl_Position passthrough，被旧 MVM 正则误判跳过）被跳过
// → 只剩 gaussian → 静态。修复后各 pass 应 inter-stage 匹配、可进入效果链。

const DOWNSAMPLE2_VERT = `
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec4 v_TexCoord;
uniform vec4 g_Texture0Resolution;
uniform vec4 g_Texture1Resolution;
#if NOISE == 1
varying vec4 v_NoiseTexCoord;
#endif
uniform float g_Time;
uniform float g_NoiseSpeed;
uniform float g_NoiseScale;
void main() {
\tgl_Position = vec4(a_Position, 1.0);
\tv_TexCoord = a_TexCoord.xyxy;
#if MASK
\tv_TexCoord.z *= g_Texture1Resolution.z / g_Texture1Resolution.x;
\tv_TexCoord.w *= g_Texture1Resolution.w / g_Texture1Resolution.y;
#endif
\t#ifdef HLSL_SM30
\tvec2 offsets = 0.5 / g_Texture0Resolution.xy;
\tv_TexCoord.xy += offsets;
\t#endif
#if NOISE == 1
\tv_NoiseTexCoord.xy = a_TexCoord + g_Time * g_NoiseSpeed;
\tv_NoiseTexCoord.wz = vec2(a_TexCoord.y, -a_TexCoord.x) * 0.633 + vec2(-g_Time, g_Time) * 0.5 * g_NoiseSpeed;
\tv_NoiseTexCoord *= g_NoiseScale;
#endif
}
`;

const DOWNSAMPLE2_FRAG = `
// [COMBO] {"material":"noise","combo":"NOISE","type":"options","default":1}
varying vec4 v_TexCoord;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform float g_Threshold;
#if NOISE == 1
varying vec4 v_NoiseTexCoord;
uniform sampler2D g_Texture2;
uniform float g_NoiseAmount;
uniform float g_NoiseSmoothness;
#endif
void main() {
#if MASK
\tfloat mask = texSample2D(g_Texture1, v_TexCoord.zw).r;
#else
\tfloat mask = 1.0;
#endif
\tvec4 sample = texSample2D(g_Texture0, v_TexCoord.xy);
#if NOISE
\tfloat noiseSample = texSample2D(g_Texture2, v_NoiseTexCoord.xy).r * texSample2D(g_Texture2, v_NoiseTexCoord.zw).r;
\tnoiseSample = mix(sample.a, sample.a * noiseSample, g_NoiseAmount);
#endif
\tsample.rgb *= sample.a;
\tsample.a = 1.0;
\tgl_FragColor = sample * mask * step(g_Threshold, dot(vec3(0.11, 0.59, 0.3), sample.rgb));
#if NOISE
\tgl_FragColor.a *= smoothstep(0.5 - g_NoiseSmoothness, 0.5 + g_NoiseSmoothness, noiseSample);
#endif
}
`;

const CAST_VERT = `
uniform mat4 g_ModelViewProjectionMatrix;
uniform vec4 g_Texture1Resolution;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
void main() {
\tgl_Position = vec4(a_Position, 1.0);
\tv_TexCoord = a_TexCoord;
}
`;

const CAST_FRAG = `
// [COMBO] {"material":"cast_type","combo":"CASTER","type":"options","default":0,"options":{"Radial":0,"Directional":1}}
// [COMBO] {"material":"quality","combo":"SAMPLES","type":"options","default":0,"options":{"30":0,"50":1}}
#include "common.h"
varying vec2 v_TexCoord;
uniform sampler2D g_Texture0;
uniform float g_Length;
uniform float g_Intensity;
uniform vec3 g_ColorRays;
#if CASTER == 0
uniform vec2 g_Center;
#else
uniform float g_Direction;
#endif
void main() {
\tvec2 texCoords = v_TexCoord;
\tvec4 albedo = CAST4(0.0);
#if CASTER == 0
\tvec2 direction = g_Center - texCoords;
#else
\tvec2 direction = rotateVec2(vec2(0, -0.5), g_Direction - M_PI);
#endif
\tfloat dist = length(direction);
\tdirection /= dist;
\tdist *= g_Length;
\ttexCoords += direction * dist;
#if SAMPLES == 0
\tconst int sampleCount = 30;
\tconst float sampleIntensity = 0.1;
#endif
#if SAMPLES == 1
\tconst int sampleCount = 50;
\tconst float sampleIntensity = 0.1 * (30 / 50.0);
#endif
\tconst float sampleDrop = sampleCount - 1;
\tdirection = direction * dist / sampleDrop;
\tfor (int i = 0; i < sampleCount; ++i) {
\t\tvec4 sample = texSample2D(g_Texture0, texCoords);
\t\ttexCoords -= direction;
\t\talbedo += sample * (i / sampleDrop);
\t}
\talbedo.rgb *= g_ColorRays;
\tgl_FragColor = vec4(g_Intensity * sampleIntensity * albedo.rgb, saturate(g_Intensity * sampleIntensity * albedo.a));
}
`;

const GAUSSIAN_VERT = `
// [COMBO] {"material":"kernel","combo":"KERNEL","type":"options","default":1,"options":{"13x13":0,"7x7":1,"3x3":2}}
uniform vec2 g_Scale;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec4 v_TexCoord;
uniform vec4 g_Texture0Resolution;
void main() {
\tgl_Position = vec4(a_Position, 1.0);
\tv_TexCoord.xy = a_TexCoord;
#if VERTICAL
\tv_TexCoord.z = 0;
\tv_TexCoord.w = g_Scale.y / g_Texture0Resolution.w;
#else
\tv_TexCoord.z = g_Scale.x / g_Texture0Resolution.z;
\tv_TexCoord.w = 0;
#endif
}
`;

const GAUSSIAN_FRAG = `
uniform sampler2D g_Texture0;
#include "common_blur.h"
varying vec4 v_TexCoord;
void main() {
#if KERNEL == 0
\tgl_FragColor = blur13a(v_TexCoord.xy, v_TexCoord.zw);
#endif
#if KERNEL == 1
\tgl_FragColor = blur7a(v_TexCoord.xy, v_TexCoord.zw);
#endif
#if KERNEL == 2
\tgl_FragColor = blur3a(v_TexCoord.xy, v_TexCoord.zw);
#endif
}
`;

const COMBINE_VERT = `
uniform mat4 g_ModelViewProjectionMatrix;
uniform vec4 g_Texture1Resolution;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec4 v_TexCoord;
#if COPYBG
uniform mat4 g_EffectModelViewProjectionMatrix;
varying vec3 v_ScreenCoord;
#endif
#ifdef HLSL_SM30
uniform vec4 g_Texture0Resolution;
#endif
void main() {
\tgl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);
\tv_TexCoord = a_TexCoord.xyxy;
#ifdef HLSL_SM30
\tv_TexCoord.zw += 0.5 / g_Texture0Resolution.xy;
#endif
#if COPYBG
\tv_ScreenCoord = mul(vec4((a_Position), 1.0), g_EffectModelViewProjectionMatrix).xyw;
#if HLSL
\tv_ScreenCoord.y = -v_ScreenCoord.y;
#endif
#endif
}
`;

const COMBINE_FRAG = `
// [COMBO] {"material":"blend_mode","combo":"BLENDMODE","type":"imageblending","default":9}
// [COMBO] {"material":"copy_background","combo":"COPYBG","type":"options"}
#include "common_blending.h"
varying vec4 v_TexCoord;
#if COPYBG
varying vec3 v_ScreenCoord;
uniform sampler2D g_Texture2;
#endif
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
void main() {
\tvec4 rays = texSample2D(g_Texture0, v_TexCoord.zw);
\tvec4 albedo = texSample2D(g_Texture1, v_TexCoord.xy);
#if COPYBG
\tvec2 screenCoord = v_ScreenCoord.xy / v_ScreenCoord.z * vec2(0.5, 0.5) + 0.5;
\tvec4 bg = texSample2D(g_Texture2, screenCoord.xy);
\talbedo.rgb = mix(bg.rgb, albedo.rgb, albedo.a);
#endif
#if BLENDMODE == 0
\talbedo = rays;
#else
\talbedo.rgb = ApplyBlending(BLENDMODE, albedo.rgb, rays.rgb, rays.a);
\talbedo.a = saturate(albedo.a + rays.a);
#endif
\tgl_FragColor = albedo;
}
`;

const WATERWAVES_VERT = `
#include "common.h"
uniform mat4 g_ModelViewProjectionMatrix;
uniform float g_Time;
uniform vec4 g_Texture1Resolution;
uniform float g_Direction;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec4 v_TexCoord;
varying vec2 v_Direction;
void main() {
\tgl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);
\tv_TexCoord.xy = a_TexCoord;
\tv_TexCoord.zw = vec2(v_TexCoord.x * g_Texture1Resolution.z / g_Texture1Resolution.x,
\t\t\t\t\t\tv_TexCoord.y * g_Texture1Resolution.w / g_Texture1Resolution.y);
\tv_Direction = rotateVec2(vec2(0, -1), g_Direction);
}
`;

const WATERWAVES_FRAG = `
varying vec4 v_TexCoord;
varying vec2 v_Direction;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform float g_Time;
uniform float g_Speed;
uniform float g_Scale;
uniform float g_Strength;
uniform float g_Perspective;
void main() {
\tfloat mask = texSample2D(g_Texture1, v_TexCoord.zw).r;
\tvec2 texCoord = v_TexCoord.xy;
\tfloat pos = abs(dot((texCoord - 0.5), v_Direction));
\tfloat distance = g_Time * g_Speed + dot(texCoord, v_Direction) * (g_Scale + g_Perspective * pos);
\tvec2 offset = vec2(v_Direction.y, -v_Direction.x);
\tfloat strength = g_Strength * g_Strength + g_Perspective * pos;
\ttexCoord += sin(distance) * offset * strength * mask;
\tgl_FragColor = texSample2D(g_Texture0, texCoord);
}
`;

describe('godrays pass 存活性（task-22）', () => {
  it('downsample2：vert 的 NOISE 从 frag [COMBO] 默认合并（跨 stage），inter-stage 匹配', () => {
    const pass = makePass(DOWNSAMPLE2_VERT, DOWNSAMPLE2_FRAG, {});
    const desc = glslToNagaGlsl(pass);
    // 修复关键：vert 也得到 #define NOISE 1 → v_NoiseTexCoord 输出与 frag 输入匹配
    expect(desc.vertGlsl).toContain('#define NOISE 1');
    expect(desc.vertGlsl).toMatch(/out\s+vec4\s+v_NoiseTexCoord/);
    expect(interStageLocationsMatch(desc.vertGlsl, desc.fragGlsl)).toBe(true);
  });

  it('cast：declares MVM 但 gl_Position 用 passthrough，inter-stage 匹配（旧 MVM 正则误判已消除）', () => {
    const desc = glslToNagaGlsl(makePass(CAST_VERT, CAST_FRAG, {}));
    expect(interStageLocationsMatch(desc.vertGlsl, desc.fragGlsl)).toBe(true);
    // 不再被“声明 MVM 即跳过”误判：vert 用 passthrough（不乘 MVM），顶点不塌
    expect(desc.vertGlsl).toMatch(/gl_Position\s*=\s*vec4\(a_Position,\s*1\.0\)/);
  });

  it('gaussian（KERNEL 默认 1）：inter-stage 匹配（已生效 pass 不回归）', () => {
    const desc = glslToNagaGlsl(makePass(GAUSSIAN_VERT, GAUSSIAN_FRAG, {}));
    expect(interStageLocationsMatch(desc.vertGlsl, desc.fragGlsl)).toBe(true);
  });

  it('combine：COPYBG/BLENDMODE 默认合并 → inter-stage 匹配（COPYBG 关，无 v_ScreenCoord 不对称）', () => {
    const desc = glslToNagaGlsl(makePass(COMBINE_VERT, COMBINE_FRAG, {}));
    expect(interStageLocationsMatch(desc.vertGlsl, desc.fragGlsl)).toBe(true);
    // BLENDMODE 默认 9（frag [COMBO]）；COPYBG 无默认 → 未定义（=0），#if 分支被裁剪 → v_ScreenCoord 不对称消失
    expect(desc.fragGlsl).toContain('#define BLENDMODE 9');
  });

  it('waterwaves：genuinely 用 MVM（gl_Position=mul(...MVM)），inter-stage 匹配（供 Orange 效果链放行路径）', () => {
    const desc = glslToNagaGlsl(makePass(WATERWAVES_VERT, WATERWAVES_FRAG, {}));
    expect(interStageLocationsMatch(desc.vertGlsl, desc.fragGlsl)).toBe(true);
    // MVM 使用（非仅声明）：去掉声明行后仍出现
    const noDecl = WATERWAVES_VERT.replace(/uniform\s+mat[234]\s+g_ModelViewProjectionMatrix\s*;/g, '');
    expect(/\bg_ModelViewProjectionMatrix\b/.test(noDecl)).toBe(true);
  });
});
