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

// 属性名改写：WE 方言 attribute 名 → three.js 几何体属性名
// （three 的 BufferGeometry 提供 position/uv，ShaderMaterial 按名字绑定；
//  PlaneGeometry(2,2) 的 position 范围 [-1,1] 正好铺满 NDC 全屏 quad）
function rewriteAttributes(src: string): string {
  return src.split('a_Position').join('position').split('a_TexCoord').join('uv');
}

export function preprocessWeShader(source: string, combos: Record<string, number>): string {
  let out = source;
  // 展开内置头 include（仅处理 WE_HEADERS 已知的头；未知 include 保留原样）
  for (const [name, header] of Object.entries(WE_HEADERS)) {
    out = out.split(`#include "${name}"`).join(header);
  }
  out = rewriteAttributes(out);
  // 注入 combo 宏（仅 scene.json 提供的值；未提供的宏在 #if 中自然为 0）
  const defines = Object.entries(combos)
    .map(([k, v]) => `#define ${k} ${v}`)
    .join('\n');
  return defines ? `${defines}\n${out}` : out;
}
