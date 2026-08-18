// tests/effect-runner.test.ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { blendModeToThree } from '../src/client/effect-runner.js';

describe('blendModeToThree（WE blending → three 混合模式）', () => {
  it('映射 add/multiply/subtract 与默认回退', () => {
    expect(blendModeToThree('add')).toBe(THREE.AdditiveBlending);
    expect(blendModeToThree('multiply')).toBe(THREE.MultiplyBlending);
    expect(blendModeToThree('subtract')).toBe(THREE.SubtractiveBlending);
    expect(blendModeToThree('normal')).toBe(THREE.NormalBlending);
    expect(blendModeToThree('unknown-mode')).toBe(THREE.NormalBlending);
  });
});
