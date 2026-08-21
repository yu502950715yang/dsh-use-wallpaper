// tests/effect-runner.test.ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { blendModeToThree } from '../src/client/effect-runner.js';
import { resolveTextureSlotPath, resolveBuiltinTexture } from '../src/client/effect-runner.js';
import {
  resolveInputTexture,
  pickWriteTarget,
  resolveTargetSize,
  resolveTextureResolution,
} from '../src/client/effect-runner.js';

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

// ===== T1.1 输入/输出参数化：update 的 input 可接受任意纹理、setChains 可指定对象 RT 尺寸。
// WebGL 渲染路径无法在 node 跑，抽出以下纯函数（node 可测）断言决策逻辑。=====

describe('resolveInputTexture（输入归一：RT → .texture，Texture 透传）', () => {
  it('WebGLRenderTarget 输入 → 取其 .texture（场景 RT 兼容）', () => {
    const rt = new THREE.WebGLRenderTarget(64, 64);
    expect(resolveInputTexture(rt)).toBe(rt.texture);
    rt.dispose();
  });
  it('Texture 输入 → 原样透传（对象 RT 纹理 / 任意纹理）', () => {
    const tex = new THREE.Texture();
    expect(resolveInputTexture(tex)).toBe(tex);
    tex.dispose();
  });
});

describe('pickWriteTarget（ping-pong 写端选择：上一写端的对端；首 pass → rtA）', () => {
  it('无上一写端（首 pass 读输入纹理，非 runner RT）→ rtA', () => {
    const rtA = new THREE.WebGLRenderTarget(8, 8);
    const rtB = new THREE.WebGLRenderTarget(8, 8);
    expect(pickWriteTarget(null, rtA, rtB)).toBe(rtA);
    rtA.dispose(); rtB.dispose();
  });
  it('上一写端 rtA → rtB', () => {
    const rtA = new THREE.WebGLRenderTarget(8, 8);
    const rtB = new THREE.WebGLRenderTarget(8, 8);
    expect(pickWriteTarget(rtA, rtA, rtB)).toBe(rtB);
    rtA.dispose(); rtB.dispose();
  });
  it('上一写端 rtB → rtA', () => {
    const rtA = new THREE.WebGLRenderTarget(8, 8);
    const rtB = new THREE.WebGLRenderTarget(8, 8);
    expect(pickWriteTarget(rtB, rtA, rtB)).toBe(rtA);
    rtA.dispose(); rtB.dispose();
  });
  it('连续交替 null → rtA → rtB → rtA（与旧实现 read===rtB?rtA:rtB 等价）', () => {
    const rtA = new THREE.WebGLRenderTarget(8, 8);
    const rtB = new THREE.WebGLRenderTarget(8, 8);
    let prev: THREE.WebGLRenderTarget | null = null;
    const seq: THREE.WebGLRenderTarget[] = [];
    for (let i = 0; i < 3; i++) {
      prev = pickWriteTarget(prev, rtA, rtB);
      seq.push(prev);
    }
    expect(seq).toEqual([rtA, rtB, rtA]);
    rtA.dispose(); rtB.dispose();
  });
});

describe('resolveTargetSize（setChains opts 尺寸决策：显式覆盖、缺省保持当前）', () => {
  it('无 opts → 保持当前尺寸（向后兼容，场景级调用）', () => {
    expect(resolveTargetSize({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
  });
  it('仅 width → 覆盖宽度、保持高度', () => {
    expect(resolveTargetSize({ width: 1920, height: 1080 }, { width: 512 })).toEqual({ width: 512, height: 1080 });
  });
  it('仅 height → 覆盖高度、保持宽度', () => {
    expect(resolveTargetSize({ width: 1920, height: 1080 }, { height: 512 })).toEqual({ width: 1920, height: 512 });
  });
  it('width + height → 全部覆盖（对象级 RT 尺寸）', () => {
    expect(resolveTargetSize({ width: 1920, height: 1080 }, { width: 256, height: 128 })).toEqual({ width: 256, height: 128 });
  });
});

describe('resolveTextureResolution（g_TextureNResolution 推导：image 有尺寸用实际，缺失回退默认）', () => {
  it('image 有实际尺寸 → 用实际尺寸（对象纹理 / 槽纹理）', () => {
    const tex = new THREE.Texture();
    tex.image = { width: 320, height: 240 };
    expect(resolveTextureResolution(tex, 1920, 1080)).toEqual({ width: 320, height: 240 });
    tex.dispose();
  });
  it('RT 纹理 → 用其实际 image 尺寸（three 0.170 RT texture 自带 image {width,height,depth}，即对象 RT 分辨率）', () => {
    const rt = new THREE.WebGLRenderTarget(64, 64);
    expect(resolveTextureResolution(rt.texture, 1920, 1080)).toEqual({ width: 64, height: 64 });
    rt.dispose();
  });
  it('image 为 null（普通未解码 Texture）→ 回退默认尺寸', () => {
    const tex = new THREE.Texture(); // image 缺省 null
    expect(resolveTextureResolution(tex, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
    tex.dispose();
  });
  it('null 纹理 → 回退默认尺寸', () => {
    expect(resolveTextureResolution(null, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });
  it('image 尺寸为 0 → 保留 0（?? 语义而非 ||，避免把合法 0 当缺失）', () => {
    const tex = new THREE.Texture();
    tex.image = { width: 0, height: 0 };
    expect(resolveTextureResolution(tex, 1920, 1080)).toEqual({ width: 0, height: 0 });
    tex.dispose();
  });
});
