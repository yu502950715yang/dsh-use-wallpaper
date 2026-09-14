// tests/effect-runner.test.ts
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { blendModeToThree } from '../src/client/effect-runner.js';
import { resolveTextureSlotPath, resolveBuiltinTexture } from '../src/client/effect-runner.js';
import {
  resolveInputTexture,
  pickWriteTarget,
  resolveTargetSize,
  resolveTextureResolution,
  fillAudioSpectrumUniform,
  describeEffectPass,
  EffectRunner,
} from '../src/client/effect-runner.js';
import type { CompiledEffectPass } from '../src/client/shader/effect-chain.js';

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

// ===== T3.2 音频频谱注入：频谱字节（0-255）→ uniform 浮点（0-1）的纯逻辑。
// EffectRunner 每帧用该函数把 analyser 的 freqData 写入 g_AudioSpectrum* 数组；
// uniform 长度按 combo RESOLUTION（16/32/64），与 64 bin 频谱的映射规则在此钉死。=====

describe('fillAudioSpectrumUniform（频谱字节 → uniform 浮点：0-255 归一化 0-1，越界补零）', () => {
  it('字节 0-255 → 0-1 浮点（255 → 1，128 → 128/255）', () => {
    const dest = new Array(3).fill(0);
    fillAudioSpectrumUniform(dest, new Uint8Array([0, 128, 255]));
    expect(dest).toEqual([0, 128 / 255, 1]);
  });
  it('uniform 长度大于频谱 bin 数 → 越界补零（无分析器时长度的全零语义延续）', () => {
    const dest = new Array(5).fill(-1);
    fillAudioSpectrumUniform(dest, new Uint8Array([255, 255]));
    expect(dest).toEqual([1, 1, 0, 0, 0]);
  });
  it('uniform 长度小于频谱 bin 数（RESOLUTION < 64）→ 只取前 N 个 bin', () => {
    const dest = new Array(2).fill(0);
    fillAudioSpectrumUniform(dest, new Uint8Array([10, 20, 30, 40]));
    expect(dest).toEqual([10 / 255, 20 / 255]);
  });
});

// ===== F3：编译失败的 pass 必须被缓存（同一 key 第二次不再重建材质 / 不再探针渲染）。
// EffectRunner 在 node 下**可以**实例化：构造器只建 2 张 WebGLRenderTarget（纯 JS），
// 真正碰 WebGL 的只有探针渲染 `renderer.render(...)`。故注入一个最小 mock renderer：
//   - `debug.onShaderError` 在探针渲染时被唤起（模拟 three 的编译失败**只通知、不抛异常**）；
//   - `render` / `setRenderTarget` 记调用次数 —— 编译失败时每个 pass 恰好 1 次探针渲染，
//     缓存生效后第二次 update 应为 0 次。
// 「不再重建材质」用 `THREE.Material.prototype.dispose` 计数作为代理：失败分支必定 dispose
// 刚构造的材质，第二次若不再走构造-失败路径，就不会有第 2 次 dispose。=====

function failingPass(over: Partial<CompiledEffectPass> = {}): CompiledEffectPass {
  return {
    vertSrc: 'void main(){ gl_Position = vec4(position, 1.0); }',
    fragSrc: 'void main(){ gl_FragColor = vec4(1.0); }',
    rawVert: '', rawFrag: 'uniform sampler2D g_Texture0;',
    combos: {}, uniforms: new Map(), textureSlots: [], blendMode: 'normal',
    target: null, bind: [], fboScale: {},
    ...over,
  };
}

/** 最小 mock renderer：探针渲染时触发 onShaderError（= 编译失败），并记录渲染/绑定次数。 */
function createFailRenderer() {
  const fakeGl = { getShaderInfoLog: () => "0:254: '==' wrong operand types" };
  const renderer = {
    debug: { onShaderError: null as null | ((...a: unknown[]) => void) },
    setRenderTarget: vi.fn(),
    render: vi.fn(() => { renderer.debug.onShaderError?.(fakeGl, {}, {}, {}); }),
  };
  return renderer;
}

describe('EffectRunner 编译失败缓存（F3）', () => {
  it('同一 key 第二次 update 不再重建材质 / 不再探针渲染；setChains 后重新尝试', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const disposeSpy = vi.spyOn(THREE.Material.prototype, 'dispose');
    const renderer = createFailRenderer();
    const runner = new EffectRunner(renderer as never, 16, 16);
    const input = new THREE.Texture();
    // textureSlots 留空：本用例不触发纹理槽异步加载（那会走 fetch/tex-loader，与本用例无关）。
    runner.setChains([[failingPass({ target: '_rt_blur' })]], '2911105183', { width: 16, height: 16 });

    await runner.update(0, input);
    // 第一次：1 次探针渲染（失败后 pass 被跳过，不提交任何帧渲染）+ 1 次材质释放。
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    // 告警一次，且文案可辨识（含壁纸 id 与具名 RT / 纹理槽标识），错误详情是字符串
    // （原先 handler 内传对象 → 日志里显示 `Object Object`）。
    const afterFirst = warn.mock.calls.map((c) => c.map((x) => String(x)).join(' ')).join('\n');
    expect(afterFirst).toContain('效果 pass 编译失败，跳过');
    expect(afterFirst).toContain('壁纸 2911105183');
    expect(afterFirst).toContain('_rt_blur');
    expect(afterFirst).toContain('0:254');
    expect(afterFirst).not.toContain('[object Object]');

    await runner.update(1, input);
    await runner.update(2, input);
    // 失败已缓存：后两帧 0 次渲染（不重建材质、不探针渲染），也不再新增告警。
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('效果 pass 编译失败')).length).toBe(1);

    // setChains（换壁纸 / 重挂链）清空失败缓存 → 重新尝试一次（链变了可能就能编译了）。
    runner.setChains([[failingPass({ target: '_rt_blur' })]], '2911105183', { width: 16, height: 16 });
    await runner.update(3, input);
    expect(renderer.render).toHaveBeenCalledTimes(2);

    disposeSpy.mockRestore();
    warn.mockRestore();
    runner.dispose();
  });

  it('describeEffectPass：pass 下标 + 壁纸 id + 具名 RT / 纹理槽 / 混合模式（可辨识，非 `Object Object`）', () => {
    const label = describeEffectPass(
      failingPass({ target: '_rt_a', textureSlots: ['effects/refractnormal'], blendMode: 'add' }),
      '1',
      '2911105183',
    );
    expect(label).toContain('pass 1');
    expect(label).toContain('壁纸 2911105183');
    expect(label).toContain('target=_rt_a');
    expect(label).toContain('effects/refractnormal');
    expect(label).toContain('blend=add');
  });
});
