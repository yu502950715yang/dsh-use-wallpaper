// tests/uniform-binder.test.ts
import { describe, expect, it } from 'vitest';
import { resolveUniformBindings, isAudioUniform } from '../src/client/shader/uniform-binder.js';

describe('resolveUniformBindings', () => {
  const anns = [
    { name: 'g_Speed', type: 'float', annotation: { material: 'speed', default: 5 } },
    { name: 'g_Strength', type: 'float', annotation: { material: 'strength' } },
    { name: 'g_Direction', type: 'float', annotation: { default: 0, direction: true } },
    { name: 'g_Color', type: 'vec3', annotation: { material: 'color' } },
    { name: 'g_Unset', type: 'float', annotation: {} },
    { name: 'g_AudioSpectrum16Left', type: 'float[16]', annotation: {} },
  ];
  it('material 映射优先，{user,value} 解包，default 回退，缺失为 0', () => {
    const m = resolveUniformBindings(anns, {
      speed: 2.5,
      strength: { user: 'x', value: 0.75 },
      color: '1.0 0.5 0.0',
    });
    expect(m.get('g_Speed')).toBe(2.5);
    expect(m.get('g_Strength')).toBe(0.75);
    expect(m.get('g_Direction')).toBe(0);
    expect(m.get('g_Color')).toEqual([1.0, 0.5, 0.0]);
    expect(m.get('g_Unset')).toBe(0);
  });
  it('音频频谱 uniform 返回对应长度全零数组', () => {
    const m = resolveUniformBindings(anns, {});
    expect(isAudioUniform('g_AudioSpectrum16Left')).toBe(true);
    expect(isAudioUniform('g_Speed')).toBe(false);
    expect(m.get('g_AudioSpectrum16Left')).toEqual(new Array(16).fill(0));
  });
  it('default 为字符串时也解析为数值', () => {
    const m = resolveUniformBindings(
      [{ name: 'g_Scale', type: 'vec2', annotation: { default: '1 1' } }],
      {},
    );
    expect(m.get('g_Scale')).toEqual([1, 1]);
  });
});
