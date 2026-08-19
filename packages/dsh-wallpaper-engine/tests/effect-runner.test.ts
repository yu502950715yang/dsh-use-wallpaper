// tests/effect-runner.test.ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { blendModeToThree } from '../src/client/effect-runner.js';
import { resolveTextureSlotPath, resolveBuiltinTexture } from '../src/client/effect-runner.js';

describe('blendModeToThree（WE blending → three 混合模式）', () => {
  it('映射 add/multiply/subtract 与默认回退', () => {
    expect(blendModeToThree('add')).toBe(THREE.AdditiveBlending);
    expect(blendModeToThree('multiply')).toBe(THREE.MultiplyBlending);
    expect(blendModeToThree('subtract')).toBe(THREE.SubtractiveBlending);
    expect(blendModeToThree('normal')).toBe(THREE.NormalBlending);
    expect(blendModeToThree('unknown-mode')).toBe(THREE.NormalBlending);
  });
});

describe('resolveTextureSlotPath（纹理槽路径推导）', () => {
  it('无前缀无后缀 → materials/ 前缀 + .tex', () => {
    expect(resolveTextureSlotPath('masks/waterwaves_mask_x')).toBe('materials/masks/waterwaves_mask_x.tex');
    expect(resolveTextureSlotPath('effects/waterripplenormal')).toBe('materials/effects/waterripplenormal.tex');
  });
  it('已完整路径不变', () => {
    expect(resolveTextureSlotPath('materials/masks/x.tex')).toBe('materials/masks/x.tex');
  });
  it('带 materials/ 前缀但无 .tex 后缀 → 仅补后缀（不双重前缀）', () => {
    expect(resolveTextureSlotPath('materials/masks/x')).toBe('materials/masks/x.tex');
    expect(resolveTextureSlotPath('materials/x')).toBe('materials/x.tex');
  });
  it('内置 util 与运行时 _rt_ 原样透传', () => {
    expect(resolveTextureSlotPath('util/white')).toBe('util/white');
    expect(resolveTextureSlotPath('_rt_FullFrameBuffer')).toBe('_rt_FullFrameBuffer');
  });
  it('空路径返回 null', () => {
    expect(resolveTextureSlotPath('')).toBeNull();
    expect(resolveTextureSlotPath(null as unknown as string)).toBeNull();
  });
});

describe('resolveBuiltinTexture（内置/运行时纹理回退）', () => {
  it('util/white → 非 null 纹理', () => {
    const tex = resolveBuiltinTexture('util/white');
    expect(tex).not.toBeNull();
    expect(tex!.image.width).toBe(1);
  });
  it('util/noise 与 util/clouds_256 → 256 噪声纹理', () => {
    for (const p of ['util/noise', 'util/clouds_256']) {
      const tex = resolveBuiltinTexture(p);
      expect(tex).not.toBeNull();
      expect(tex!.image.width).toBe(256);
    }
  });
  it('带 .tex 后缀的内置路径同样识别（util/noise.tex）', () => {
    const tex = resolveBuiltinTexture('util/noise.tex');
    expect(tex).not.toBeNull();
    expect(tex!.image.width).toBe(256);
  });
  it('_rt_* → 白色回退', () => {
    expect(resolveBuiltinTexture('_rt_imageLayerComposite_1_a')).not.toBeNull();
  });
  it('普通路径 → null（交给 fetch）', () => {
    expect(resolveBuiltinTexture('masks/x')).toBeNull();
  });
});
