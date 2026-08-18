// src/client/shader/uniform-binder.ts
// uniform 静态值绑定：material 参数映射 → constantshadervalues；default 回退；音频数组置零。
import type { UniformAnnotation } from './shader-preprocessor.js';

export type UniformValue = number | number[];

export function isAudioUniform(name: string): boolean {
  return name.startsWith('g_AudioSpectrum');
}

function parseValue(raw: unknown): number | number[] | null {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (typeof raw === 'string') {
    const parts = raw.trim().split(/\s+/).map(Number);
    if (parts.some((n) => !isFinite(n))) return null;
    return parts.length === 1 ? parts[0] : parts;
  }
  if (Array.isArray(raw)) {
    const nums = raw.map(Number);
    if (nums.some((n) => !isFinite(n))) return null;
    return nums.length === 1 ? nums[0] : nums;
  }
  return null;
}

export function resolveUniformBindings(
  annotations: UniformAnnotation[],
  constants: Record<string, unknown>,
): Map<string, UniformValue> {
  const out = new Map<string, UniformValue>();
  for (const u of annotations) {
    // 纹理 uniform（sampler*）由执行器按纹理槽运行时绑定，这里跳过
    if (u.type.startsWith('sampler')) continue;
    // 音频频谱数组 → 全零（静音；spec §4.3）
    const arrMatch = u.type.match(/^float\[(\d+)\]$/);
    if (isAudioUniform(u.name) && arrMatch) {
      out.set(u.name, new Array(Number(arrMatch[1])).fill(0));
      continue;
    }
    let raw: unknown;
    const mat = u.annotation?.material;
    if (typeof mat === 'string') {
      const v = constants[mat];
      // WE 参数可能带 {user, value} 包装（值在 value 字段）
      raw = v && typeof v === 'object' && !Array.isArray(v) && 'value' in (v as object)
        ? (v as { value: unknown }).value
        : v;
    }
    if (raw === undefined && u.annotation?.default !== undefined) raw = u.annotation.default;
    const parsed = parseValue(raw);
    // 无值回退：按 GLSL 类型给维度正确的默认（vec2/vec3/vec4 → 全零数组；
    // float/int → 0）。three 上传 vecN 需要数组/Vector，number 0 会转换失败。
    const dim = u.type === 'vec2' ? 2 : u.type === 'vec3' ? 3 : u.type === 'vec4' ? 4 : 0;
    if (parsed === null || parsed === 0) {
      out.set(u.name, dim ? new Array(dim).fill(0) : (parsed ?? 0));
    } else {
      out.set(u.name, parsed);
    }
  }
  return out;
}
