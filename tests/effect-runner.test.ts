// tests/effect-runner.test.ts
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { blendModeToThree } from '../src/client/effect-runner.js';
import { resolveTextureSlotPath, resolveBuiltinTexture } from '../src/client/effect-runner.js';
import { builtinTextureUrl, isBuiltinTexturePath, loadEffectTextureSlot } from '../src/client/effect-runner.js';
import {
  resolveInputTexture,
  pickWriteTarget,
  resolveTargetSize,
  resolveTextureResolution,
  fillAudioSpectrumUniform,
  describeEffectPass,
  EffectRunner,
  resolveEmptySlotTexture,
  effectSlotCount,
  resolveSlotFallback,
} from '../src/client/effect-runner.js';
import type { CompiledEffectPass } from '../src/client/shader/effect-chain.js';
import { loadTexTexture } from '../src/client/tex-loader.js';

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
  it('util/noise 与 util/clouds_256 各自 → 256 噪声纹理', () => {
    for (const p of ['util/noise', 'util/clouds_256']) {
      const tex = resolveBuiltinTexture(p);
      expect(tex).not.toBeNull();
      expect(tex!.image.width).toBe(256);
    }
  });
  it('util/noise 与 util/clouds_256 **不是同一张纹理**（WE 里是两张不同纹理，此前共用 key/实例是错的）', () => {
    expect(resolveBuiltinTexture('util/noise')).not.toBe(resolveBuiltinTexture('util/clouds_256'));
  });
  it('同一路径重复查询 → 同一实例（BUILTIN_CACHE 兜底缓存）', () => {
    expect(resolveBuiltinTexture('util/clouds_256')).toBe(resolveBuiltinTexture('util/clouds_256.tex'));
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

// ===== util/* 优先取 WE 真身（2026-09-14 修复 2454403969 的真机扫描线异常）。
// 纯逻辑抽成 `loadEffectTextureSlot(path, id, cache, load, warn)`：加载器可注入 ⇒ node 可测
// （WebGL/网络不参与）。真机路径（真实 fetch + .tex 解码 + 上屏）仍由 e2e 覆盖。=====

describe('builtinTextureUrl / isBuiltinTexturePath（util/* 真身 URL 与引擎侧路径判定）', () => {
  it('util/* → host 既有路由 /wallpapers/particle-texture（name 去掉 .tex 后缀）', () => {
    expect(builtinTextureUrl('util/noise')).toBe('/wallpapers/particle-texture?name=util%2Fnoise');
    expect(builtinTextureUrl('util/clouds_256.tex')).toBe('/wallpapers/particle-texture?name=util%2Fclouds_256');
    expect(builtinTextureUrl('util/white')).toBe('/wallpapers/particle-texture?name=util%2Fwhite');
  });
  it('_rt_* → null（运行时具名 RT，WE 目录内无对应文件，不去打必然 404 的请求）', () => {
    expect(builtinTextureUrl('_rt_FullFrameBuffer')).toBeNull();
  });
  it('普通纹理槽 → null（走壁纸 pkg 内的 scene asset）', () => {
    expect(builtinTextureUrl('masks/waterwaves_mask_x')).toBeNull();
    expect(builtinTextureUrl(null)).toBeNull();
  });
  it('isBuiltinTexturePath：util/* 与 _rt_* 为真，其余为假', () => {
    expect(isBuiltinTexturePath('util/noise')).toBe(true);
    expect(isBuiltinTexturePath('util/noise.tex')).toBe(true);
    expect(isBuiltinTexturePath('_rt_FullFrameBuffer')).toBe(true);
    expect(isBuiltinTexturePath('masks/x')).toBe(false);
    expect(isBuiltinTexturePath('materials/util/noise.tex')).toBe(false);
    expect(isBuiltinTexturePath(null)).toBe(false);
  });
});

describe('loadEffectTextureSlot（① util/* 真身 → ② 程序化回退 → ③ 壁纸 pkg 资源）', () => {
  const realTex = () => new THREE.DataTexture(new Uint8Array([9, 8, 7, 255]), 1, 1, THREE.RGBAFormat);

  it('util/* 真身可达 → 用真身（请求 host 路由、alphaPriority=false），不回退、不告警', async () => {
    const tex = realTex();
    const load = vi.fn(async () => tex);
    const warn = vi.fn();
    const cache = new Map<string, THREE.Texture | null>();
    const got = await loadEffectTextureSlot('util/noise', '2454403969', cache, load, warn);
    expect(got).toBe(tex);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0]).toBe('/wallpapers/particle-texture?name=util%2Fnoise');
    expect(load.mock.calls[0][1]).toEqual({ alphaPriority: false });
    expect(warn).not.toHaveBeenCalled();
    expect(cache.get('2454403969:util/noise')).toBe(tex);
  });

  it('真身不可达 → 回退程序化近似 + 告警一次，且不重复请求（含失败结果进缓存）', async () => {
    const load = vi.fn(async () => null);
    const warn = vi.fn();
    const cache = new Map<string, THREE.Texture | null>();
    const first = await loadEffectTextureSlot('util/noise', '2454403969', cache, load, warn);
    expect(first).toBe(resolveBuiltinTexture('util/noise')); // 回退到程序化噪声（不是 null，不白屏）
    expect(first!.image.width).toBe(256);
    expect(load).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('回退程序化近似');
    expect(String(warn.mock.calls[0][0])).toContain('util/noise');
    // 第二次（模拟下一帧）：命中缓存 ⇒ 不再发请求、不再告警
    const second = await loadEffectTextureSlot('util/noise', '2454403969', cache, load, warn);
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('加载器抛异常 → 按失败处理并回退（异常不抛进帧循环）', async () => {
    const load = vi.fn(async () => { throw new Error('boom'); });
    const warn = vi.fn();
    const cache = new Map<string, THREE.Texture | null>();
    const tex = await loadEffectTextureSlot('util/white', 'x', cache, load, warn);
    expect(tex).toBe(resolveBuiltinTexture('util/white'));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('_rt_* → 不走真身请求（realUrl 为 null）、不发告警，直接白色回退并缓存', async () => {
    const load = vi.fn(async () => realTex());
    const warn = vi.fn();
    const cache = new Map<string, THREE.Texture | null>();
    const tex = await loadEffectTextureSlot('_rt_imageLayerComposite_1_a', 'x', cache, load, warn);
    expect(tex).toBe(resolveBuiltinTexture('_rt_imageLayerComposite_1_a'));
    expect(load).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(cache.has('x:_rt_imageLayerComposite_1_a')).toBe(true);
  });

  it('普通纹理槽 → 走壁纸 pkg 内的 scene asset（materials/ 前缀 + .tex），失败缓存 null 并告警', async () => {
    const load = vi.fn(async () => null);
    const warn = vi.fn();
    const cache = new Map<string, THREE.Texture | null>();
    const tex = await loadEffectTextureSlot('masks/x', 'wp1', cache, load, warn);
    expect(tex).toBeNull();
    expect(load.mock.calls[0][0]).toBe('/wallpapers/scene/wp1/asset?name=' + encodeURIComponent('materials/masks/x.tex'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('纹理槽加载失败');
    // 失败结果也进缓存 ⇒ 第二次不再请求
    await loadEffectTextureSlot('masks/x', 'wp1', cache, load, warn);
    expect(load).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('空路径 → null（不请求）', async () => {
    const load = vi.fn(async () => realTex());
    expect(await loadEffectTextureSlot(null, 'x', new Map(), load, vi.fn())).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});

// ===== 空槽纹理（scene.json 未提供的 sampler 槽按 shader 声明的 mode 兜底）=====
// 依据（2026-09-14 真机反馈 2454403969）：pass 的 textures 数组长度不够时（clouds 只有
// `[null, "util/clouds_256"]`，而 clouds.frag 声明到 g_Texture2），此前该槽**不绑任何东西**，
// three 的兜底是 1×1 全 0；对 flowmask 语义全 0 = `(0-0.498)*2 = -0.996` 的满量程位移。
// mode 标注（effect-chain 的 samplerModes）决定空槽绑什么常量纹理。
// 取值与 WE 素材逐字节对齐：`<WE>/materials/util/black.tex` 首像素 `00 00 00 ff`、
// `util/noflow.tex` 首像素 `7f 7f 00 ff`（127/255 = 0.498，最接近 shake.frag 的零点常量）。
describe('resolveEmptySlotTexture（空槽常量纹理：opacitymask → 黑、flowmask → 中灰）', () => {
  const bytesOf = (tex: THREE.Texture) => Array.from((tex.image as { data: Uint8Array }).data);

  it('opacitymask → 1×1 全 0 黑（R=G=B=0、A=255，与 util/black.tex 一致）', () => {
    const tex = resolveEmptySlotTexture('opacitymask');
    expect(tex).not.toBeNull();
    expect(tex!.image.width).toBe(1);
    expect(tex!.image.height).toBe(1);
    expect(bytesOf(tex!)).toEqual([0, 0, 0, 255]);
  });

  it('flowmask → 1×1 中灰 127/127（与 util/noflow.tex 一致，127/255 = 0.498 = 零位移）', () => {
    const tex = resolveEmptySlotTexture('flowmask');
    expect(bytesOf(tex!)).toEqual([127, 127, 0, 255]);
    // 关键：不能是 128（(128/255-0.498)*2 = +0.0078 的残余位移）也不能是 0（-0.996 满量程）
    expect(bytesOf(tex!)[0]).toBe(127);
  });

  it('同一 mode 重复查询 → 同一实例（模块级缓存，不每次 getMaterial 新建）', () => {
    expect(resolveEmptySlotTexture('opacitymask')).toBe(resolveEmptySlotTexture('opacitymask'));
    expect(resolveEmptySlotTexture('flowmask')).toBe(resolveEmptySlotTexture('flowmask'));
    // 两种 mode 是两个不同实例（黑 ≠ 中灰）
    expect(resolveEmptySlotTexture('opacitymask')).not.toBe(resolveEmptySlotTexture('flowmask'));
  });

  it('无 mode / 未知 mode → null（不改既有行为）', () => {
    expect(resolveEmptySlotTexture(undefined)).toBeNull();
    expect(resolveEmptySlotTexture(null)).toBeNull();
    expect(resolveEmptySlotTexture('')).toBeNull();
    expect(resolveEmptySlotTexture('normal')).toBeNull();
  });
});

describe('effectSlotCount / resolveSlotFallback（槽数补齐与逐槽兜底选择）', () => {
  const pass = (over: Partial<CompiledEffectPass>): CompiledEffectPass => ({
    vertSrc: '', fragSrc: '', rawVert: '', rawFrag: '', combos: {}, uniforms: new Map(),
    textureSlots: [], samplerModes: {}, blendMode: 'normal', target: null, bind: [], fboScale: {},
    ...over,
  });

  it('槽数 = max(textures.length, 声明下标+1)：clouds 数组长 2、声明到 g_Texture2 → 3', () => {
    expect(effectSlotCount(pass({ textureSlots: [null, 'util/clouds_256'], samplerModes: { g_Texture2: 'opacitymask' } }))).toBe(3);
    // 声明比数组短 → 取数组长度（不缩小既有覆盖范围）
    expect(effectSlotCount(pass({ textureSlots: [null, 'a', 'b'], samplerModes: {} }))).toBe(3);
    // 非 g_TextureN 的 sampler 名（如 g_TextureClouds）不参与槽数计算
    expect(effectSlotCount(pass({ textureSlots: [null], samplerModes: { g_Diffuse: 'opacitymask' } }))).toBe(1);
    // 缺字段（早于本字段构造的 pass）→ 退回 textures.length，不抛异常
    const legacy = pass({ textureSlots: [null, 'a'] });
    delete (legacy as Partial<CompiledEffectPass>).samplerModes;
    expect(effectSlotCount(legacy)).toBe(2);
  });

  it('g_Texture0 恒 null（链输入由 update 绑 readTex），与 mode 无关', () => {
    expect(resolveSlotFallback(pass({ textureSlots: [null, null], samplerModes: { g_Texture0: 'opacitymask' } }), 0)).toBeNull();
  });

  it('已提供的槽 → null（真纹理异步加载，预置阶段不占位）', () => {
    expect(resolveSlotFallback(pass({ textureSlots: [null, 'masks/m'] }), 1)).toBeNull();
  });

  it('未提供的槽 → 按 mode 取空槽纹理；无 mode → null', () => {
    const p = pass({ textureSlots: [null, 'x'], samplerModes: { g_Texture2: 'opacitymask', g_Texture3: 'flowmask', g_Texture4: 'unknown' } });
    expect(resolveSlotFallback(p, 2)).toBe(resolveEmptySlotTexture('opacitymask'));
    expect(resolveSlotFallback(p, 3)).toBe(resolveEmptySlotTexture('flowmask'));
    expect(resolveSlotFallback(p, 4)).toBeNull();
    expect(resolveSlotFallback(p, 5)).toBeNull(); // 连声明都没有的槽
  });
});

/** 最小 mock renderer（不触发 onShaderError = 编译成功）：从 render(scene) 里取回材质，
 *  用于断言执行器真正绑到 uniform 上的值（getMaterial 是私有的，材质只能这样观测）。 */
function createBindRenderer() {
  const mats: THREE.ShaderMaterial[] = [];
  const renderer = {
    debug: { onShaderError: null as null | ((...a: unknown[]) => void) },
    setRenderTarget: vi.fn(),
    render: vi.fn((scene: THREE.Scene) => {
      const mesh = scene.children[0] as THREE.Mesh;
      mats.push(mesh.material as THREE.ShaderMaterial);
    }),
  };
  return { renderer, mats };
}

describe('EffectRunner 纹理槽加载器注入（纹理 v 约定由调用方携带）', () => {
  it('构造注入 load → 纹理槽解析走注入加载器（并沿用 alphaPriority:false）', async () => {
    const { renderer } = createBindRenderer();
    const seen: Array<{ url: string; opts?: { alphaPriority?: boolean } }> = [];
    const load = vi.fn(async (url: string, opts?: { alphaPriority?: boolean }) => {
      seen.push({ url, opts });
      return new THREE.Texture();
    });
    // 注入的加载器 = 调用方携带 v 约定的唯一入口（three 主路径注入 rowOrder:'topDown'，
    // 见 object-effects.weVRowOrderLoader）；runner 自身不改纹理语义。
    const runner = new EffectRunner(renderer as never, 16, 16, { load });
    const pass: CompiledEffectPass = {
      vertSrc: 'void main(){ gl_Position = vec4(position, 1.0); }',
      fragSrc: 'uniform sampler2D g_Texture0; void main(){ gl_FragColor = vec4(1.0); }',
      rawVert: '', rawFrag: '', combos: {}, uniforms: new Map(),
      textureSlots: [null, 'masks/x'],
      samplerModes: {},
      blendMode: 'normal', target: null, bind: [], fboScale: {},
    };
    runner.setChains([[pass]], 'wp1', { width: 16, height: 16 });
    await new Promise((r) => setTimeout(r, 0)); // setChains 的预加载是 void 异步
    expect(load).toHaveBeenCalledTimes(1);
    expect(seen[0].url).toContain('materials');
    expect(seen[0].url).toContain('masks');
    expect(seen[0].opts).toMatchObject({ alphaPriority: false });
    runner.dispose();
  });

  it('不注入 load → 缺省沿用 loadTexTexture（既有调用方行为不变）', async () => {
    const { renderer } = createBindRenderer();
    const runner = new EffectRunner(renderer as never, 16, 16);
    // 私有字段只作观测：缺省 loader 必须是模块内 loadTexTexture（同一函数对象）
    expect((runner as unknown as { load: unknown }).load).toBe(loadTexTexture);
    runner.dispose();
  });
});

describe('EffectRunner 空槽绑定（update 真绑到 uniform：空槽常量纹理不被覆盖成 null）', () => {
  it('clouds 型 pass（textures 长 2、声明到 g_Texture2）：g_Texture2 = 空槽黑纹理，g_Texture1 仍无兜底', async () => {
    const { renderer, mats } = createBindRenderer();
    const runner = new EffectRunner(renderer as never, 16, 16);
    // textureSlots[1] 留 null：本用例不触发网络/纹理加载（专测空槽路径）
    const clouds: CompiledEffectPass = {
      vertSrc: 'void main(){ gl_Position = vec4(position, 1.0); }',
      fragSrc: 'uniform sampler2D g_Texture0; void main(){ gl_FragColor = vec4(1.0); }',
      rawVert: '', rawFrag: '', combos: { MASK: 0 }, uniforms: new Map(),
      textureSlots: [null, null],
      samplerModes: { g_Texture2: 'opacitymask' },
      blendMode: 'normal', target: null, bind: [], fboScale: {},
    };
    const input = new THREE.Texture();
    runner.setChains([[clouds]], '2454403969', { width: 16, height: 16 });
    await runner.update(0, input);

    const mat = mats[mats.length - 1]; // 探针渲染与 pass 渲染是同一材质实例
    expect(mat).toBeTruthy();
    // 空槽（textures 数组没给到的 g_Texture2）→ mode 决定的常量纹理，**不是** null
    expect(mat.uniforms['g_Texture2'].value).toBe(resolveEmptySlotTexture('opacitymask'));
    // 维度正确的分辨率 uniform 也建出来了（否则 .z/.x 会 0/0 → NaN UV）
    expect(mat.uniforms['g_Texture2Resolution']).toBeTruthy();
    // 无 mode 的未提供槽维持既有行为（null），不由空槽逻辑接管
    expect(mat.uniforms['g_Texture1'].value).toBeNull();
    // g_Texture0 = 链输入（update 末尾覆写，未被空槽逻辑影响）
    expect(mat.uniforms['g_Texture0'].value).toBe(input);

    // 第二次 update：仍是同一实例（缓存），且没有被 slotTex 的 `?? null` 覆盖回 null
    await runner.update(1, input);
    expect(mats[mats.length - 1].uniforms['g_Texture2'].value).toBe(resolveEmptySlotTexture('opacitymask'));
    runner.dispose();
  });

  it('flowmask 型空槽（shake 的 g_Texture1 未提供）→ 中灰而非 three 的 1×1 全 0', async () => {
    const { renderer, mats } = createBindRenderer();
    const runner = new EffectRunner(renderer as never, 16, 16);
    const shake: CompiledEffectPass = {
      vertSrc: 'void main(){ gl_Position = vec4(position, 1.0); }',
      fragSrc: 'uniform sampler2D g_Texture0; void main(){ gl_FragColor = vec4(1.0); }',
      rawVert: '', rawFrag: '', combos: {}, uniforms: new Map(),
      textureSlots: [null],
      samplerModes: { g_Texture1: 'flowmask' },
      blendMode: 'normal', target: null, bind: [], fboScale: {},
    };
    runner.setChains([[shake]], '3743126786', { width: 16, height: 16 });
    await runner.update(0, new THREE.Texture());
    const mat = mats[mats.length - 1];
    expect(mat.uniforms['g_Texture1'].value).toBe(resolveEmptySlotTexture('flowmask'));
    expect(Array.from((mat.uniforms['g_Texture1'].value as THREE.DataTexture).image.data as Uint8Array))
      .toEqual([127, 127, 0, 255]);
    runner.dispose();
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
    combos: {}, uniforms: new Map(), textureSlots: [], samplerModes: {}, blendMode: 'normal',
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

// 回归（AGENT.md §5.22）：效果 pass 渲染进 ping-pong RT 必须透明清屏（alpha=0），
// 否则效果把 alpha 降下去处会变成不透明黑块贴回主场景。
describe('EffectRunner RT 清屏 alpha（黑块根因回归）', () => {
  function createAlphaRenderer(initialAlpha = 1) {
    let alpha = initialAlpha;
    const at = (t: string) => ({ t, alpha });
    const events: Array<{ t: string; alpha: number }> = [];
    const renderer = {
      debug: { onShaderError: null as null | ((...a: unknown[]) => void) },
      setRenderTarget: vi.fn(),
      render: vi.fn(() => { events.push(at('render')); }),
      getClearAlpha: vi.fn(() => alpha),
      setClearAlpha: vi.fn((v: number) => { alpha = v; }),
      _alpha: () => alpha,
      _events: events,
    };
    return renderer;
  }

  it('pass 渲染时清屏 alpha=0，渲染后恢复原值（1）', async () => {
    const renderer = createAlphaRenderer(1);
    const runner = new EffectRunner(renderer as never, 16, 16);
    const pass = failingPassFree('normal');
    runner.setChains([[pass]], '2911105183', { width: 16, height: 16 });
    await runner.update(0, new THREE.Texture());
    // 第 1 次 render = 1×1 编译探针，第 2 次 = 真正写 ping-pong RT 的 pass 渲染
    expect(renderer._events.length).toBe(2);
    expect(renderer._events.every((e) => e.alpha === 0)).toBe(true);
    expect(renderer._alpha()).toBe(1); // 渲染后已恢复，主场景 → 画布语义不变
    runner.dispose();
  });
});

function failingPassFree(blend: string): CompiledEffectPass {
  return {
    vertSrc: 'void main(){ gl_Position = vec4(position, 1.0); }',
    fragSrc: 'uniform sampler2D g_Texture0; void main(){ gl_FragColor = vec4(1.0); }',
    rawVert: '', rawFrag: '', combos: {}, uniforms: new Map(), textureSlots: [],
    samplerModes: {}, blendMode: blend, target: null, bind: [], fboScale: {},
  };
}

describe('EffectRunner 编译失败缓存（F3）', () => {  it('同一 key 第二次 update 不再重建材质 / 不再探针渲染；setChains 后重新尝试', async () => {
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
