// @vitest-environment jsdom
// Task 5：`createThreeSceneRenderer` 生产接线测试。three-renderer 是薄装配层：把 scene.json
// 解析 + 背景纹理（resolveImageAssets）+ 粒子条件（spec/tex/blend）+ wasm CpuParticleSim 工厂
// 组装成 `loadSceneToThree` 的 `SceneAssets`。本测试 mock 所有重模块（fetch/wasm/tex-loader/
// 纹理推导），聚焦装配正确性：
//   - render 解析 scene.json 并为每个 image/particle 对象组装 assets；
//   - createParticleSim 工厂调用 wasm `CpuParticleSim.new`（失败 → 空 sim 兜底）；
//   - 零背景 + 零粒子 → render 返回 false（controller 落 preview）；
//   - dispose 释放播放器。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// mock 重模块（three-renderer 的依赖）。type 导入在运行时被擦除，vi.mock 只替换运行时值。
// 只替换 loadSceneToThree，其余导出（如 resolvePixelRatio 的渲染像素比口径）用真实实现——
// mock 自己重写一份公式会与生产漂移，而屏幕密度口径正是本文件多处断言的核心。
vi.mock('../src/client/threejs-player.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/client/threejs-player.js')>()),
  loadSceneToThree: vi.fn(),
}));
vi.mock('../src/client/scene-assets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/client/scene-assets.js')>()),
  resolveImageAssets: vi.fn(),
  resolveParticleMaterial: vi.fn(),
}));
vi.mock('../src/client/tex-loader.js', () => ({
  loadTexTexture: vi.fn(),
}));
vi.mock('../src/client/wasm-loader.js', () => ({
  defaultLoadWasm: vi.fn(),
}));
// 应用级 Glow 的 stage 是 WebGL 资源（RT/材质），单测只关心装配时序 → 整体 mock。
vi.mock('../src/client/glow-stage.js', () => ({
  createGlowStage: vi.fn(() => ({
    apply: vi.fn(), resize: vi.fn(), setOptions: vi.fn(), dispose: vi.fn(),
  })),
}));
// 壁纸 bloom 同理（薄封装 GlowStage）；单独 mock 以便构造「非法视口 ⇒ null」的防御分支。
const bloomMocks = vi.hoisted(() => ({ createBloomStage: vi.fn() }));
vi.mock('../src/client/bloom-stage.js', () => bloomMocks);
// 音频输入（A3）：jsdom 无 Web Audio ⇒ 整体 mock，由各用例决定分析器/播放的返回值。
const audioMocks = vi.hoisted(() => ({
  createAudioAnalyzer: vi.fn(),
  playWallpaperSound: vi.fn(async () => true),
}));
vi.mock('../src/client/audio-input.js', () => audioMocks);

import * as THREE from 'three';
import { loadSceneToThree, ThreeScenePlayer } from '../src/client/threejs-player.js';
import { resolveImageAssets, resolveParticleMaterial } from '../src/client/scene-assets.js';
import { loadTexTexture } from '../src/client/tex-loader.js';
import { defaultLoadWasm } from '../src/client/wasm-loader.js';
import { createThreeSceneRenderer, particleBlend, collectObjectEffectChains, collectScriptSources, lastWorldTransformOf } from '../src/client/three-renderer.js';
import { createRenderHealthStore } from '../src/client/render-health.js';
import type { HealthSnapshot, StorageLike } from '../src/client/render-health.js';
import { parseSceneJson } from '../src/client/scene-json.js';
import { screenScalePx, fitIsolatedBudget, isolatedRtSize, ISOLATED_RT_BUDGET_BYTES, ISOLATED_RT_BYTES_PER_PX } from '../src/client/object-range.js';
import { createGlowStage } from '../src/client/glow-stage.js';
import { setSettingsCtx } from '../src/client/settings.js';
import { SceneScriptHost } from '../src/client/scene-script-host.js';
import { createAudioAnalyzer, playWallpaperSound } from '../src/client/audio-input.js';
import { ObjectEffectStage } from '../src/client/object-effects.js';
import type { CompiledEffectPass } from '../src/client/shader/effect-chain.js';
import type { ClientSettings } from '../src/client/types.js';
import type { PuppetInstance } from '../src/client/puppet.js';

// 精简黑神话 scene.json（与 2851992662 一致的对象结构：1 image + 1 particle）。
const SCENE = JSON.stringify({
  camera: { center: '0.00003 26.39995 0.00000', eye: '0.00003 26.39995 1.00000', up: '0.00000 1.00000 0.00000' },
  general: { clearcolor: '0.7 0.7 0.7', orthogonalprojection: { height: 2160, width: 3840 } },
  objects: [
    {
      id: 13, name: 'bg', image: 'models/a.json',
      origin: '1920.00000 1080.00000 0.00000', scale: '1.00000 1.00000 1.00000',
      size: '3840.00000 2160.00000', alignment: 'center', alpha: 1, brightness: 1,
      color: '1.00000 1.00000 1.00000', visible: true,
    },
    {
      id: 71, name: 'Sakura', particle: 'particles/presets/leaves5.json',
      origin: '2306.34155 419.76611 0.00000', scale: '-2.05166 2.11670 1.00000', visible: true,
    },
  ],
});

// 背景纹理 fake：真实 Texture 一定有 dispose（teardown 会调用它释放本次纹理）。
function fakeTexture() {
  return { fake: true, dispose: vi.fn() };
}

function makeMockSim() {
  return {
    update: vi.fn(),
    vertices: vi.fn(() => new Float32Array(0)),
    frame_count: vi.fn(() => 4),
    set_frame_count: vi.fn(),
    particle_count: vi.fn(() => 0),
  };
}

// 注入插件设置（settings.ts 的模块级 ctx）：describe() 的命名空间值即设置覆盖。
// 不注入（setSettingsCtx(null)）时 readClientSettings 回退 DEFAULTS（glowEnabled=true）。
function stubSettings(patch: Partial<ClientSettings>): void {
  setSettingsCtx({
    remote: {
      settings: {
        describe: async () => ({
          ok: true, value: { namespaces: [{ ns: 'wallpaper-engine', value: patch }] },
        }),
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  bloomMocks.createBloomStage.mockReset();
  setSettingsCtx(null); // 重置设置注入（回退 DEFAULTS）
  // 粒子材质解析缺省：材质 json 不可得（→ 调用方走材质名启发式兜底）——需要材质的用例自行覆盖。
  resolveParticleMaterial.mockResolvedValue(null);
  // scene.json 拉取
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('name=scene.json')) {
      return { ok: true, text: async () => SCENE };
    }
    if (String(url).includes('leaves5.json')) {
      // EVA light rays 材质名（含 "lightshaft" → 混合模式为 additive，对齐 wasm from_material）
      return { ok: true, text: async () => '{"material":"presets/lightshaft"}' };
    }
    return { ok: false, text: async () => '' };
  }));
  // window.innerWidth（jsdom 缺省 1024×768）
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1080 });
  // SceneScript 宿主在 jsdom 里会尝试加载 quickjs.wasm（路径推导失败 → 一条 ENOENT 噪声）。
  // 本文件不测脚本运行时（只有 visible.script 的**收集**交给纯函数 collectScriptSources 覆盖），
  // 故直接让它降级为 null：装配路径不受影响，测试输出保持纯净。
  vi.spyOn(SceneScriptHost, 'create').mockResolvedValue(null as never);
});

describe('createThreeSceneRenderer', () => {
  it('render：解析 scene.json → 为 image 对象组装背景纹理、particle 对象组装 spec/tex/blend', async () => {
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as any, puppetPath: null });
    // 材质 json 不可得（null）→ 回退材质名启发式：spec 材质名含 "lightshaft" → additive。
    resolveParticleMaterial.mockResolvedValue(null);
    const sim = makeMockSim();
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => sim) } } as any);
    loadSceneToThree.mockReturnValue({
      player: { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn() },
      sims: [sim],
      backgroundIds: [0],
      particleLayers: [{ id: 1, sim }], puppetLayers: [],
    });

    const canvas = document.createElement('canvas');
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    const ok = await r.render('2851992662', canvas, null);

    expect(ok).toBe(true);
    expect(resolveImageAssets).toHaveBeenCalledTimes(1);
    expect(resolveImageAssets.mock.calls[0][0]).toBe('2851992662');
    expect(resolveImageAssets.mock.calls[0][1].id).toBe(13);
    // 粒子条件：spec + 材质（resolveParticleMaterial → texUrl + blending）
    expect(resolveParticleMaterial).toHaveBeenCalledTimes(1);
    expect(resolveParticleMaterial.mock.calls[0][0]).toBe('2851992662');
    expect(resolveParticleMaterial.mock.calls[0][1]).toContain('lightshaft');
    expect(loadSceneToThree).toHaveBeenCalledTimes(1);
    const assets = loadSceneToThree.mock.calls[0][1];
    // Task5：viewport 第 4 参 = 窗口/视口尺寸（窗口比例），而非场景尺寸——cover 相机按窗口宽高比
    // 裁剪（背景不变形），对照 wasm 路径用 window.innerWidth/Height 推 cover。
    expect(loadSceneToThree.mock.calls[0][3]).toEqual({ width: 1920, height: 1080 });
    expect(assets.backgroundTextures.get(13)).toEqual({ fake: true, dispose: expect.any(Function) });
    expect(assets.particles.get(71).specJson).toContain('lightshaft');
    // 材质名含 "lightshaft" → blend = additive（材质 json 不可得时的兜底）
    expect(assets.particles.get(71).blend).toBe('additive');
    // createParticleSim 工厂可调用：返回 wasm sim。
    const f = assets.createParticleSim as (j: string, o: [number, number, number], w: number, h: number) => unknown;
    const created = f('{}', [1, 2, 3], 3840, 2160);
    expect(created).toBe(sim);
    // canvas 逻辑尺寸被设为视口
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
    // dispose 释放播放器
    r.dispose();
    expect((loadSceneToThree.mock.results[0].value as any).player.dispose).toHaveBeenCalled();
  });

  // A4：createBloomStage 返回 null（非法视口）时不得静默 —— 保留装配但 warn 一条带壁纸 id。
  it('bloom stage 为 null（非法视口）→ 告警带壁纸 id，装配继续', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bloomMocks.createBloomStage.mockReturnValue(null);
    vi.mocked(resolveImageAssets).mockResolvedValue({ texture: fakeTexture() as any, puppetPath: null, spriteSheet: false });
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setBloomStage: vi.fn(),
      setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
    };
    vi.mocked(loadSceneToThree).mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [] } as never);
    stubAssetFetch(JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 1920, height: 1080 }, bloom: true },
      objects: [{ id: 13, name: 'bg', image: 'models/a.json', origin: '960 540 0', scale: '1 1 1', size: '1920 1080' }],
    }), {});
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2454403969', document.createElement('canvas'))).toBe(true);
    expect(bloomMocks.createBloomStage).toHaveBeenCalledTimes(1);
    expect(player.setBloomStage).toHaveBeenCalledWith(null);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('2454403969') && String(c[0]).includes('bloom'))).toBe(true);
    warn.mockRestore();
    r.dispose?.();
  });

  it('dispose / 切壁纸时释放本次装配的背景纹理（视频纹理的 <video>/Blob URL 不能被 renderer.dispose 兜住）', async () => {
    // 视频纹理把 `<video>` + Blob URL 挂在纹理的 dispose 事件上，GPU 侧释放不会停解码
    // ⇒ 壁纸切换必须显式 texture.dispose()（见 AGENT.md §5.23）。
    const texA = { dispose: vi.fn() };
    const texB = { dispose: vi.fn() };
    resolveImageAssets.mockResolvedValue({ texture: texA as any, puppetPath: null });
    loadSceneToThree.mockReturnValue({
      player: { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn() },
      sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [],
    });
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('2851992662', document.createElement('canvas'), null);
    expect(texA.dispose).not.toHaveBeenCalled(); // 首次装配：纹理仍在使用

    // 切到另一张壁纸（render 先 teardown 上一次）→ 上一次的纹理被释放
    resolveImageAssets.mockResolvedValue({ texture: texB as any, puppetPath: null });
    await r.render('2851992662', document.createElement('canvas'), null);
    expect(texA.dispose).toHaveBeenCalledTimes(1);
    expect(texB.dispose).not.toHaveBeenCalled();

    r.dispose();
    expect(texB.dispose).toHaveBeenCalledTimes(1);
  });

  it('render：混合模式取材质 json 的 passes[0].blending（DK 44 层根因回归）——材质名不带 "additive" 也是 additive', async () => {
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as any, puppetPath: null });
    // DK WOTLK 的真实形态：spec.material 路径名不含 lightshaft/glow/additive，但材质 json 是 additive。
    resolveParticleMaterial.mockResolvedValue({
      texUrl: '/wallpapers/particle-texture?name=particle%2Fchromaticdot',
      blending: 'additive',
    });
    const tex = { fakeTex: true };
    loadTexTexture.mockResolvedValue(tex as any);
    const sim = makeMockSim();
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => sim) } } as any);
    loadSceneToThree.mockReturnValue({
      player: { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn() },
      sims: [sim],
      backgroundIds: [0],
      particleLayers: [{ id: 1, sim }], puppetLayers: [],
    });
    // scene.json 换成 DK 形态的材质路径（路径名里没有 additive 字样）。
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('name=scene.json')) return { ok: true, text: async () => SCENE };
      if (String(url).includes('leaves5.json')) {
        return { ok: true, text: async () => '{"material":"materials/workshop/2111504995/presets/snowperspective.json"}' };
      }
      return { ok: false, text: async () => '' };
    }));

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    const ok = await r.render('2859263090', document.createElement('canvas'), null);
    expect(ok).toBe(true);
    const assets = loadSceneToThree.mock.calls[0][1];
    // 旧实现此处为 'alpha'（按材质名猜）→ 纹理 alpha 全 1 的 addtive 纹理被画成黑方块。
    expect(assets.particles.get(71).blend).toBe('additive');
    // 纹理经 texUrl → loadTexTexture 装配（host 路由 /wallpapers/particle-texture）。
    expect(loadTexTexture).toHaveBeenCalledWith('/wallpapers/particle-texture?name=particle%2Fchromaticdot');
    expect(assets.particles.get(71).tex).toBe(tex);
    r.dispose();
  });

  // 粒子 REFRACT（材质 combo REFRACT=1）：槽 1 的法线/遮罩走**与槽 0 同一条** particle-texture
  // 路由加载后随 `assets.particles[id].refract` 下发（player 据此启用 REFRACT define + 段边界快照）。
  it('render：REFRACT=1 → 槽 1 走同一条路由加载并下发 refract{normalTex, amount}', async () => {
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as any, puppetPath: null });
    resolveParticleMaterial.mockResolvedValue({
      texUrl: '/wallpapers/particle-texture?id=2897292240&name=workshop%2F2446129945%2Fparticle%2Fparticles%20256x1280%20blank',
      blending: 'translucent',
      refract: true,
      normalTexUrl: '/wallpapers/particle-texture?id=2897292240&name=workshop%2F2446129945%2Fparticle%2Fparticles%20256x1280N',
      refractAmount: 0.07,
    });
    const slot0 = { slot: 0 };
    const slot1 = { slot: 1 };
    loadTexTexture.mockImplementation(async (url: string) => (String(url).endsWith('256x1280N') ? slot1 : slot0) as any);
    const sim = makeMockSim();
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => sim) } } as any);
    loadSceneToThree.mockReturnValue({
      player: { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn() },
      sims: [sim], backgroundIds: [0], particleLayers: [{ id: 1, sim }], puppetLayers: [],
    });

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    const ok = await r.render('2897292240', document.createElement('canvas'), null);
    expect(ok).toBe(true);
    const assets = loadSceneToThree.mock.calls[0][1];
    expect(loadTexTexture).toHaveBeenCalledWith('/wallpapers/particle-texture?id=2897292240&name=workshop%2F2446129945%2Fparticle%2Fparticles%20256x1280N');
    expect(assets.particles.get(71).refract).toEqual({ normalTex: slot1, amount: 0.07 });
    r.dispose();
  });

  // 槽 1 缺失/加载失败 ⇒ **不装配该层**（WE NORMALMAP=0 语义：位移恒 0、输出≡背景 ⇒ 无可见贡献）。
  // 绝不回退白方块：这类材质的槽 0 是 RGBA 全 255 占位图，画出来就是白块/白竖条。
  it('render：REFRACT=1 但槽 1 缺失或加载失败 → 不下发该粒子对象（不画白方块）', async () => {
    for (const normalTexUrl of [null, '/wallpapers/particle-texture?id=1&name=missingN'] as const) {
      vi.clearAllMocks();
      resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as any, puppetPath: null });
      resolveParticleMaterial.mockResolvedValue({
        texUrl: '/wallpapers/particle-texture?id=1&name=particle%2Fdot',
        blending: 'translucent', refract: true, normalTexUrl, refractAmount: 0.05,
      });
      loadTexTexture.mockImplementation(async (url: string) => (String(url).includes('missingN') ? null : { slot: 0 }) as any);
      defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => makeMockSim()) } } as any);
      loadSceneToThree.mockReturnValue({
        player: { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn() },
        sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [],
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
      const ok = await r.render('2897292240', document.createElement('canvas'), null);
      const assets = loadSceneToThree.mock.calls[0][1];
      expect(ok).toBe(true);                        // 背景仍在
      expect(assets.particles.size).toBe(0);        // 该层未被装配 ⇒ 不进 scene
      expect(assets.particles.has(71)).toBe(false);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('折射层槽 1'))).toBe(true);
      r.dispose();
      warn.mockRestore();
    }
  });

  it('render：CpuParticleSim.new 抛错 → 工厂返回空 sim（不整场失败）', async () => {
    resolveParticleMaterial.mockResolvedValue(null);
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => { throw new Error('bad spec'); }) } } as any);
    loadSceneToThree.mockReturnValue({ player: { dispose: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn() }, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], });

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    const ok = await r.render('2851992662', document.createElement('canvas'), null);
    expect(ok).toBe(true); // 背景仍在 → true
    const f = loadSceneToThree.mock.calls[0][1].createParticleSim as (j: string, o: [number, number, number], w: number, h: number) => unknown;
    const empty = f('{}', [1, 2, 3], 3840, 2160);
    expect((empty as any).vertices()).toHaveLength(0);
    expect((empty as any).particle_count()).toBe(0);
    r.dispose(); // 清理 window.resize 监听（否则残留监听会在后续测试的 resize 派发时触发）
  });

  it('render：零背景 + 零粒子 → 返回 false（controller 走 preview）', async () => {
    resolveImageAssets.mockResolvedValue({ texture: null, puppetPath: null });
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => makeMockSim()) } } as any);
    loadSceneToThree.mockReturnValue({ player: { dispose: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn() }, sims: [], backgroundIds: [], particleLayers: [], puppetLayers: [], });

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    const ok = await r.render('2851992662', document.createElement('canvas'), null);
    expect(ok).toBe(false);
  });

  it('窗口 resize → player.resize 用新窗口比例重推 cover（监听在 render 后注册、dispose 移除）', async () => {
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as any, puppetPath: null });
    resolveParticleMaterial.mockResolvedValue(null);
    // 模拟返回带 resize 的 player（真实 ThreeScenePlayer 的接口）。
    const player = { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn() };
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => makeMockSim()) } } as any);
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], });

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('2851992662', document.createElement('canvas'), null);
    // render 注册监听后改变窗口尺寸 → 触发 resize → 播放器按新窗口比例重推 cover。
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    window.dispatchEvent(new Event('resize'));
    expect(player.resize).toHaveBeenCalledWith(1600, 900);
    // Glow 的 RT 尺寸只在 player.resize 内部单点同步 ⇒ three-renderer **不**再自己调 stage.resize
    expect(vi.mocked(createGlowStage).mock.results[0].value!.resize).not.toHaveBeenCalled();

    // dispose 移除监听：再次 resize 不再调用 player.resize。
    r.dispose();
    const callsAfterDispose = player.resize.mock.calls.length;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720 });
    window.dispatchEvent(new Event('resize'));
    expect(player.resize.mock.calls.length).toBe(callsAfterDispose);
  });

  // ── 应用级 Glow 的装配（Task 5）：按设置建 stage → 交给 player → teardown 释放 ──────────
  // 成功 render 的公共桩（背景 1 层 + 带 setGlowStage 的 player）。
  function prepareGlowRender() {
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as any, puppetPath: null });
    resolveParticleMaterial.mockResolvedValue(null);
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => makeMockSim()) } } as any);
    const player = { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn() };
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], } as any);
    return player;
  }

  it('glowEnabled=false ⇒ 不创建 Glow stage（零资源），player 收到 null', async () => {
    stubSettings({ glowEnabled: false });
    const player = prepareGlowRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);
    expect(createGlowStage).not.toHaveBeenCalled();
    expect(player.setGlowStage).toHaveBeenCalledWith(null);
    r.dispose();
  });

  it('glowEnabled=true ⇒ 用画布缓冲尺寸 + 设置参数创建 stage 并交给 player', async () => {
    stubSettings({ glowEnabled: true, glowThreshold: 0.8, glowStrength: 2 });
    const player = prepareGlowRender();
    const canvas = document.createElement('canvas');
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2851992662', canvas, null)).toBe(true);

    expect(createGlowStage).toHaveBeenCalledTimes(1);
    // 本场景无 effects（isolate 为空）却仍然建了 Glow ⇒ 钉住「装配必须在 isolate 块之外」。
    expect(loadSceneToThree.mock.calls[0][1].isolate?.size ?? 0).toBe(0);
    const [w, h, opts] = vi.mocked(createGlowStage).mock.calls[0];
    // 尺寸 = 画布**缓冲**尺寸（正数；dpr 由 player.resize 设定，此处只钉口径来源）。
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
    expect(w).toBe(canvas.width);
    expect(h).toBe(canvas.height);
    // 阈值/强度来自插件设置（而非硬编码的 A 档）。
    expect(opts).toEqual({ threshold: 0.8, strength: 2 });
    expect(player.setGlowStage).toHaveBeenCalledWith(vi.mocked(createGlowStage).mock.results[0].value);
    r.dispose();
  });

  it('dispose ⇒ stage 被释放', async () => {
    prepareGlowRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('2851992662', document.createElement('canvas'), null);
    const stage = vi.mocked(createGlowStage).mock.results[0].value!;

    r.dispose();
    expect(stage.dispose).toHaveBeenCalled();
  });

  // Task 3：帧内快照在渲染器级接线——每个 player 都拿到同一个 capture（跨壁纸复用），
  // 且每次装配开始复位 active（否则上一张壁纸的消费者会让新壁纸永久走段渲染）。
  it('帧内快照接线：player.setFrameCapture 收到同一实例；每次 render 前 reset', async () => {
    const player = prepareGlowRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);
    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);
    expect(player.setFrameCapture).toHaveBeenCalledTimes(2);
    const first = player.setFrameCapture.mock.calls[0][0];
    const second = player.setFrameCapture.mock.calls[1][0];
    expect(first).toBeTruthy();
    expect(second).toBe(first); // 同一实例（渲染器级，不随装配重建）
    // active 缺省 false ⇒ 无消费者时 render() 走现状路径（结构性零回归）
    expect(first.active).toBe(false);
    const resetSpy = vi.spyOn(first, 'reset');
    await r.render('2851992662', document.createElement('canvas'), null);
    expect(resetSpy).toHaveBeenCalledTimes(1); // 装配开始即复位
    r.dispose();
  });

  it('dispose ⇒ 帧内快照一并释放（RT/纹理不泄漏）', async () => {
    const player = prepareGlowRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('2851992662', document.createElement('canvas'), null);
    const capture = player.setFrameCapture.mock.calls[0][0] as { dispose: () => void };
    const spy = vi.spyOn(capture, 'dispose');
    r.dispose();
    expect(spy).toHaveBeenCalled();
  });

  // 真 player 才能覆盖「player.dispose 有没有把注入的 capture 释放掉」——桩 player 的 dispose 是空的。
  function playerMockRenderer() {
    return {
      setPixelRatio: vi.fn(), setSize: vi.fn(), setAnimationLoop: vi.fn(), render: vi.fn(),
      setRenderTarget: vi.fn(), clear: vi.fn(), getClearAlpha: vi.fn(() => 1), setClearAlpha: vi.fn(),
      getClearColor: vi.fn((c: THREE.Color) => c), setClearColor: vi.fn(),
      copyFramebufferToTexture: vi.fn(),
      getDrawingBufferSize: vi.fn((v: THREE.Vector2) => v.set(1280, 720)),
      dispose: vi.fn(),
    };
  }

  it('切壁纸（真 player + 同一 renderer）：player.dispose 不释放 capture，第二次装配复用同一实例且仍可用', async () => {
    stubSettings({ glowEnabled: false }); // 本用例只关心 capture 生命周期
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as any, puppetPath: null });
    resolveParticleMaterial.mockResolvedValue(null);
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => makeMockSim()) } } as any);
    const real = new ThreeScenePlayer(document.createElement('canvas'), 1280, 720, playerMockRenderer() as never);
    const firstSetCapture = vi.spyOn(real, 'setFrameCapture');
    // 第二次装配带**同一个 renderer**（复用判据是 renderer 身份，不是 player 身份）。
    const second = { renderer: real.renderer, dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn() };
    loadSceneToThree
      .mockReturnValueOnce({ player: real, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], } as any)
      .mockReturnValueOnce({ player: second, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], } as any);
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);
    const cap = firstSetCapture.mock.calls[0][0]!;
    const disposeSpy = vi.spyOn(cap, 'dispose');
    // 第二次 render = teardown 第一个（真）player + 装配第二个：bug 路径就是这一步把 capture 标成已释放
    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);
    expect(disposeSpy).not.toHaveBeenCalled();
    expect(second.setFrameCapture.mock.calls[0][0]).toBe(cap); // 同一实例（frameCapture ??= 复用）
    expect(cap.active).toBe(false);
    cap.use(); // 已释放的实例在这里会静默无效
    expect(cap.active).toBe(true);
    expect(cap.target).toBeTruthy(); // 已释放的实例在这里会抛错
    r.dispose();                     // 只有创建者释放
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  // 换壁纸 = 换 canvas = 换 renderer（wallpaper-controller 每次 select 都 createElement）：
  // capture 必须换绑，否则 capture() 用旧 renderer 拍旧 canvas 的 framebuffer（快照取错内容）。
  it('换 renderer（换 canvas）⇒ capture 换新实例、旧实例被释放、新实例绑新 renderer', async () => {
    stubSettings({ glowEnabled: false });
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as any, puppetPath: null });
    resolveParticleMaterial.mockResolvedValue(null);
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => makeMockSim()) } } as any);
    const rendererA = playerMockRenderer();
    const rendererB = playerMockRenderer();
    const first = {
      renderer: rendererA, dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
    };
    const second = {
      renderer: rendererB, dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
    };
    loadSceneToThree
      .mockReturnValueOnce({ player: first, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], } as any)
      .mockReturnValueOnce({ player: second, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], } as any);
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);
    const capA = first.setFrameCapture.mock.calls[0][0]!;
    const disposeA = vi.spyOn(capA, 'dispose');

    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);
    const capB = second.setFrameCapture.mock.calls[0][0]!;
    // 注意：不用 `not.toBe` 比对象——vitest 在 !pass 时会深比较其可枚举属性（含会抛错的 target getter）。
    expect(capB === capA).toBe(false);           // 不再复用旧实例
    expect(disposeA).toHaveBeenCalledTimes(1);   // 旧实例随换绑释放（RT/纹理不泄漏）
    // 新实例绑的是新 renderer：惰性建资源读的是它的 drawingBuffer 尺寸，旧 renderer 不再被触碰。
    expect(capB.target).toBeTruthy();
    expect(rendererB.getDrawingBufferSize).toHaveBeenCalled();
    expect(rendererA.getDrawingBufferSize).not.toHaveBeenCalled();
    expect(() => capA.capture()).toThrow();      // 旧实例已 dispose，不得再拍
    r.dispose();
  });

  it('dpr=2 ⇒ Glow 收到**画布缓冲**尺寸 1600×1200，不是 CSS 尺寸 800×600', async () => {
    // 背景（AGENT.md §5.21/§7.12 复发类缺陷）：只断言 `createGlowStage` 的尺寸 == 传入 canvas 的
    // width 是**恒真**的（实现就是读它）⇒ 误传 CSS 尺寸同样通过。本用例固定 dpr=2 并让 mock 复现
    // 真实链路的不变量（loadSceneToThree → player.resize → canvas.width = floor(vw×dpr)），
    // 使「传 CSS 尺寸」的实现必然变红。
    const origDpr = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    try {
      stubSettings({ glowEnabled: true });
      const player = prepareGlowRender();
      const canvas = document.createElement('canvas');
      const stub = player as unknown as { resize: (w: number, h: number) => void };
      stub.resize = (w, h) => { canvas.width = Math.floor(w * 2); canvas.height = Math.floor(h * 2); };
      loadSceneToThree.mockImplementationOnce(
        ((_j: unknown, _a: unknown, _c: unknown, vp: { width: number; height: number }) => {
          stub.resize(vp.width, vp.height);
          return { player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], };
        }) as never,
      );
      const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
      expect(await r.render('2851992662', canvas, null)).toBe(true);
      const [w, h] = vi.mocked(createGlowStage).mock.calls[0];
      expect([w, h]).toEqual([1600, 1200]);
      r.dispose();
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: origDpr, configurable: true });
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1080 });
    }
  });

  // ── 运行期即时改 Glow（2026-09-21）：面板改阈值/强度/开关后**立刻**生效，不必重选壁纸 ────────
  // 通道：settings-section → setWallpaperRuntimeHandler → index.ts applyRuntimeSettings →
  //       sceneRenderer.setGlow(patch) → 已装配的 GlowStage.setOptions（只改两个 uniform，不重建 RT）。
  it('setGlow({threshold,strength}) ⇒ 就地对已装配 stage setOptions（不重建、不重复交给 player）', async () => {
    const player = prepareGlowRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('2851992662', document.createElement('canvas'), null); // 缺省设置 glowEnabled=true
    const stage = vi.mocked(createGlowStage).mock.results[0].value!;

    r.setGlow?.({ threshold: 0.4, strength: 3 });
    expect(stage.setOptions).toHaveBeenCalledWith({ threshold: 0.4, strength: 3 });
    expect(createGlowStage).toHaveBeenCalledTimes(1); // 没重建 stage
    expect(player.setGlowStage).toHaveBeenCalledTimes(1); // 只在装配时交过一次
    r.dispose();
  });

  it('setGlow({enabled:false}) ⇒ 立即释放 stage 并把 player 的 stage 置空（零 RT 残留）', async () => {
    const player = prepareGlowRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('2851992662', document.createElement('canvas'), null);
    const stage = vi.mocked(createGlowStage).mock.results[0].value!;

    r.setGlow?.({ enabled: false });
    expect(stage.dispose).toHaveBeenCalledTimes(1);
    expect(player.setGlowStage).toHaveBeenLastCalledWith(null);
    expect(createGlowStage).toHaveBeenCalledTimes(1);
    r.dispose(); // 已关闭 ⇒ 不得二次 dispose
    expect(stage.dispose).toHaveBeenCalledTimes(1);
  });

  it('setGlow({enabled:true})（原本关闭）⇒ 用当前画布尺寸 + 持久参数新建 stage 交给 player', async () => {
    stubSettings({ glowEnabled: false });
    const player = prepareGlowRender();
    const canvas = document.createElement('canvas');
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('2851992662', canvas, null);
    expect(createGlowStage).not.toHaveBeenCalled();

    r.setGlow?.({ enabled: true });
    expect(createGlowStage).toHaveBeenCalledTimes(1);
    const [w, h, opts] = vi.mocked(createGlowStage).mock.calls[0];
    expect([w, h]).toEqual([canvas.width, canvas.height]);
    expect(opts).toEqual({ threshold: 0.65, strength: 0.35 }); // 关闭期间的值取持久设置（此处为 DEFAULTS）
    expect(player.setGlowStage).toHaveBeenLastCalledWith(vi.mocked(createGlowStage).mock.results[0].value);
    r.dispose();
  });

  it('setGlow 在首次装配前下发 ⇒ 状态跨 render 保留，且优先于持久设置', async () => {
    stubSettings({ glowEnabled: true, glowThreshold: 0.9, glowStrength: 3 });
    prepareGlowRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    r.setGlow?.({ threshold: 0.3, strength: 2 }); // 尚无 player：只记状态
    expect(createGlowStage).not.toHaveBeenCalled();

    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);
    expect(vi.mocked(createGlowStage).mock.calls[0][2]).toEqual({ threshold: 0.3, strength: 2 });
    r.dispose();
  });

  it('setGlow({enabled:false}) 在装配前下发 ⇒ 即便设置为开启也不建 stage（运行期开关优先）', async () => {
    stubSettings({ glowEnabled: true });
    prepareGlowRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    r.setGlow?.({ enabled: false });
    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);
    expect(createGlowStage).not.toHaveBeenCalled();
    r.dispose();
  });
});

// 对象级 `instanceoverride` 的接线：scene.json 的 particle 对象带 instanceoverride →
// `assets.particles[id].overrideJson`（原始 JSON 文本）→ `createParticleSim` 第 5 参 →
// wasm `CpuParticleSim.new`（Rust 侧按官方 OverrideSpawnProgram 语义应用）。
// 回归背景（GTR 3743126786）：烟柱 `{alpha: 0.03, size: 2.09}` 此前完全没被消费，
// 粒子按材质 alpha（实测均值 0.797）渲染成贯穿全屏的竖直白烟串。
describe('createThreeSceneRenderer instanceoverride 接线', () => {
  const GTR_SCENE = JSON.stringify({
    camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
    general: { orthogonalprojection: { height: 4147, width: 7430 } },
    objects: [
      {
        id: 22, name: 'Струя дыма', particle: 'particles/presets/smoke2.json',
        origin: '5101.16553 1089.44336 0.00000', scale: '2.89780 2.89780 2.89780',
        instanceoverride: { alpha: 0.029999999, id: 23, size: 2.0899999 },
      },
      {
        id: 67, name: 'Падающая звезда', particle: 'particles/presets/shootingstar.json',
        origin: '1107.52405 3202.11768 0.00000', scale: '2.71680 2.71680 2.71680',
      },
    ],
  });

  function stubGtrFetch() {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('name=scene.json')) return { ok: true, text: async () => GTR_SCENE };
      if (String(url).includes('smoke2.json')) return { ok: true, text: async () => '{"material":"materials/presets/smoke2.json"}' };
      if (String(url).includes('shootingstar.json')) return { ok: true, text: async () => '{"material":"materials/presets/shootingstar.json"}' };
      return { ok: false, text: async () => '' };
    }));
  }

  it('带 instanceoverride 的粒子对象 → overrideJson 组装进 assets 并透传给工厂', async () => {
    stubGtrFetch();
    const sim = makeMockSim();
    const cpNew = vi.fn(() => sim);
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: cpNew } } as any);
    loadSceneToThree.mockReturnValue({
      player: { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn() },
      sims: [sim],
      backgroundIds: [],
      particleLayers: [{ id: 0, sim }], puppetLayers: [],
    });

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    const ok = await r.render('3743126786', document.createElement('canvas'), null);
    expect(ok).toBe(true);

    const assets = loadSceneToThree.mock.calls[0][1];
    const smoke = assets.particles.get(22);
    expect(JSON.parse(smoke.overrideJson)).toEqual({ alpha: 0.029999999, id: 23, size: 2.0899999 });
    // 无 instanceoverride 的对象 → undefined（由 loadSceneToThree 归一成空串传下去）
    expect(assets.particles.get(67).overrideJson).toBeUndefined();

    // 工厂把 overrideJson 原样作为第 5 参交给 wasm。
    const f = assets.createParticleSim as any;
    expect(f('{}', [1, 2, 3], 7430, 4147, smoke.overrideJson)).toBe(sim);
    expect(cpNew).toHaveBeenCalledWith('{}', expect.anything(), 7430, 4147, expect.stringContaining('"alpha"'));
    r.dispose();
  });
});

// 混合模式推导（纯函数）：WE 材质的**权威来源是材质 json 的 `passes[0].blending` 字段值**，
// 不是 spec.material 的路径名。DK WOTLK 44 层的材质路径名里一个 "additive" 字样都没有，
// 旧实现按名猜 → 全判 NormalBlending → alpha 恒 1 的 additive 纹理被画成硬边黑方块。
describe('particleBlend（材质 json blending → 粒子混合模式）', () => {
  it('材质 json 的 blending 优先：additive/add → additive；translucent/alpha/normal → alpha', () => {
    // 路径名完全不带辉光字样，仍按材质 json 判为 additive（DK 雪片/火把的形态）。
    const dkSpec = '{"material":"materials/workshop/2111504995/presets/snowperspective.json"}';
    expect(particleBlend('additive', dkSpec)).toBe('additive');
    expect(particleBlend('add', dkSpec)).toBe('additive');
    expect(particleBlend('ADDITIVE', dkSpec)).toBe('additive');
    expect(particleBlend(' translucent ', dkSpec)).toBe('alpha');
    expect(particleBlend('alpha', dkSpec)).toBe('alpha');
    expect(particleBlend('normal', dkSpec)).toBe('alpha');
    // 黑神话 leaves5：材质 json = translucent（与路径名启发式结论一致，无回归）。
    expect(particleBlend('translucent', '{"material":"materials/presets/leaves5.json"}')).toBe('alpha');
  });

  it('材质 json 不可得（null/空串）→ 回退材质名启发式（对齐 wasm BlendMode::from_material）', () => {
    expect(particleBlend(null, '{"material":"materials/presets/lightshaft.json"}')).toBe('additive');
    expect(particleBlend(undefined, '{"material":"presets/glow_1"}')).toBe('additive');
    expect(particleBlend('', '{"material":"materials/presets/torch.json"}')).toBe('alpha');
    expect(particleBlend(null, 'not json')).toBe('alpha');
    expect(particleBlend(null, '{}')).toBe('alpha');
  });
});

// ===== Task 5：对象级效果链的解析与本路径接线 =====
// 本文件不 mock effect-runner：用例要么不建 runner（挂载方法替换成 spy），要么走真实
// ObjectEffectStage（用例内的链不带纹理槽，不触碰 WebGL）。

// 造一个最小 CompiledEffectPass（只填本任务关心的字段，其余为占位值）。
function fxPass(over: Partial<CompiledEffectPass> = {}): CompiledEffectPass {
  return {
    vertSrc: '', fragSrc: '', rawVert: '', rawFrag: '',
    combos: {}, uniforms: new Map(), textureSlots: [], blendMode: 'normal',
    target: null, bind: [], fboScale: {},
    ...over,
  };
}

// 效果链解析段要用的最小资源集：effect.json → material json → shader 源。
const FX_FILES: Record<string, string> = {
  'effects/w/effect.json': JSON.stringify({ passes: [{ material: 'materials/effects/w.json' }] }),
  'materials/effects/w.json': JSON.stringify({ passes: [{ shader: 'effects/w', blending: 'normal' }] }),
  'shaders/effects/w.vert': 'void main(){ gl_Position = vec4(position, 1.0); }',
  'shaders/effects/w.frag': 'void main(){ gl_FragColor = texture2D(g_Texture0, uv); }',
};

// 具名 RT 图链（pass 写出具名 RT）：与真实库里的 blur / blurprecise / bloom 同形，
// 供「这类对象照常隔离（P2 起可执行）」的用例使用。
const FX_FILES_RT_GRAPH: Record<string, string> = {
  ...FX_FILES,
  'effects/rtg/effect.json': JSON.stringify({
    passes: [{ material: 'materials/effects/w.json', target: '_rt_blur' }],
  }),
};

// Task 5：`textures[j] = "_rt_FullFrameBuffer"`（2597392171 obj#50 godrays_combine 的形态）。
const FX_FILES_FRAME_RT: Record<string, string> = {
  ...FX_FILES,
  'effects/frame/effect.json': JSON.stringify({ passes: [{ material: 'materials/effects/w.json' }] }),
};

// fetch 桩：scene.json + 资源名 → 文本。资源同时提供 arrayBuffer 形态（与 three-renderer 的
// loadFile 实现一致：`new Uint8Array(await r.arrayBuffer())`）。
function stubAssetFetch(scene: string, files: Record<string, string>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const name = new URL(String(url), 'http://localhost').searchParams.get('name') ?? '';
    if (name === 'scene.json') return { ok: true, text: async () => scene };
    const body = files[name];
    if (body === undefined) return { ok: false, text: async () => '' };
    const bytes = new TextEncoder().encode(body);
    return { ok: true, text: async () => body, arrayBuffer: async () => bytes.buffer };
  }));
}

describe('collectObjectEffectChains（effects 解析与分类）', () => {
  it('按对象收集 effects 并解析为链；无 effects 对象被跳过', async () => {
    const desc = {
      camera: { center: [0, 0, 0], eye: [0, 0, 0], up: [0, 1, 0] },
      orthogonal: { width: 100, height: 100 },
      objects: [
        { kind: 'image', id: 1, name: 'a', origin: [0, 0, 0], scale: [1, 1, 1], image: 'x', effects: [{ file: 'effects/w/effect.json' }] },
        { kind: 'image', id: 2, name: 'b', origin: [0, 0, 0], scale: [1, 1, 1], image: 'y' },
      ],
    } as never;
    const files = new Map<string, Uint8Array>();
    files.set('effects/w/effect.json', new TextEncoder().encode(JSON.stringify({
      passes: [{ material: 'materials/effects/w.json' }],
    })));
    files.set('materials/effects/w.json', new TextEncoder().encode(JSON.stringify({
      passes: [{ shader: 'effects/w', blending: 'normal' }],
    })));
    files.set('shaders/effects/w.vert', new TextEncoder().encode('void main(){ gl_Position = vec4(position, 1.0); }'));
    files.set('shaders/effects/w.frag', new TextEncoder().encode('void main(){ gl_FragColor = texture2D(g_Texture0, uv); }'));
    const out = await collectObjectEffectChains(desc, async (n) => files.get(n) ?? null);
    expect(out.size).toBe(1);
    expect(out.get(1)![0].length).toBe(1);
    expect(out.has(2)).toBe(false);
  });

  it('解析失败的链被过滤并 warn（该对象回退无效果显示，不整场失败）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const desc = {
      camera: { center: [0, 0, 0], eye: [0, 0, 0], up: [0, 1, 0] },
      orthogonal: { width: 100, height: 100 },
      objects: [
        { kind: 'image', id: 5, name: 'a', origin: [0, 0, 0], scale: [1, 1, 1], image: 'x', effects: [{ file: 'effects/missing/effect.json' }] },
      ],
    } as never;
    const out = await collectObjectEffectChains(desc, async () => null);
    expect(out.size).toBe(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('效果链解析失败'))).toBe(true);
    warn.mockRestore();
  });

  // 过滤发生在**解析之前**：不可见 effect 连 effect.json 都不去读（本用例刻意不提供 material/shader，
  // 若过滤失效就会走解析并打「效果链解析失败」）。
  it('effect 级 visible:false 的 effect 不进链表（lwe CImage 语义），且不在解析阶段告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const desc = {
      camera: { center: [0, 0, 0], eye: [0, 0, 0], up: [0, 1, 0] },
      orthogonal: { width: 100, height: 100 },
      objects: [
        { kind: 'image', id: 7, name: 'a', origin: [0, 0, 0], scale: [1, 1, 1], image: 'x',
          effects: [{ file: 'effects/w/effect.json', visible: false }] },
      ],
    } as never;
    const files = new Map<string, Uint8Array>();
    files.set('effects/w/effect.json', new TextEncoder().encode(JSON.stringify({ passes: [{ material: 'materials/effects/w.json' }] })));
    const out = await collectObjectEffectChains(desc, async (n) => files.get(n) ?? null);
    expect(out.size).toBe(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('效果链解析失败'))).toBe(false);
    warn.mockRestore();
  });
});

// 修正 D：`onViewportResize` 旧实现以 `if (!entry.runner) continue;` 开头，「尚无 runner 的隔离对象」
// 不随视口重设 RT（视口放大偏糊、缩小超额占显存）。Task 6 起具名 RT 图链照常建 runner，
// 「无 runner」这一态改由「只 setWorldSize、链尚未挂载」构造。
describe('ObjectEffectStage.onViewportResize（无 runner 的隔离对象也要重设 RT）', () => {
  it('只 setWorldSize、链尚未挂载（无 runner）→ 按新预算重设 RT，但不回退输出', () => {
    const view = { id: 1, rtWidth: 100, rtHeight: 50, rtTexture: new THREE.Texture() };
    const resized: Array<{ id: number; w: number; h: number }> = [];
    const outputs: Array<{ id: number; tex: THREE.Texture }> = [];
    const host = {
      renderer: {} as never,
      isolatedObjects: () => [view],
      setObjectOutput: (id: number, tex: THREE.Texture) => { outputs.push({ id, tex }); },
      resizeObjectRT: (id: number, w: number, h: number) => {
        resized.push({ id, w, h });
        // 与真实 player 一致：resizeObjectRT 会回写 rtWidth/rtHeight（threejs-player.ts:570-571）
        view.rtWidth = w;
        view.rtHeight = h;
      },
    };
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', screenScale: 1,
    });
    // 契约顺序：只 setWorldSize（世界尺寸唯一来源），链尚未挂载 ⇒ 有隔离条目与世界尺寸、没有 runner。
    stage.setWorldSize(1, 50, 25);
    // 世界 50×25 @密度 0.4 → 屏占位 20×10
    stage.onViewportResize(0.4);
    expect(resized).toEqual([{ id: 1, w: 20, h: 10 }]);
    // 没有 runner 就没有「重挂链后 quad 采样已 dispose 纹理」的问题 → 不得动输出。
    expect(outputs).toEqual([]);
    stage.dispose();
  });

  // Task 6 起具名 RT 图链照常建 runner（不再整条跳过）⇒ 有 runner 的对象同样随视口重设 RT。
  it('具名 RT 图链的隔离对象有 runner → resize 同样重设 RT 并回退对象 RT 原图', () => {
    const view = { id: 1, rtWidth: 100, rtHeight: 50, rtTexture: new THREE.Texture() };
    const resized: Array<{ id: number; w: number; h: number }> = [];
    const outputs: Array<{ id: number; tex: THREE.Texture }> = [];
    const host = {
      renderer: {} as never,
      isolatedObjects: () => [view],
      setObjectOutput: (id: number, tex: THREE.Texture) => { outputs.push({ id, tex }); },
      resizeObjectRT: (id: number, w: number, h: number) => {
        resized.push({ id, w, h });
        view.rtWidth = w;
        view.rtHeight = h;
      },
    };
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', screenScale: 1,
    });
    stage.setWorldSize(1, 50, 25);
    stage.setObjectChains(1, [[fxPass({ target: '_rt_a' })]]);
    expect(stage.debugRunners().has(1)).toBe(true);
    stage.onViewportResize(0.4);
    expect(resized).toEqual([{ id: 1, w: 20, h: 10 }]);
    expect(outputs).toHaveLength(1); // 重挂后回退对象 RT 原图
    stage.dispose();
  });
});

// 接线：效果链解析 → isolate 尺寸 → ObjectEffectStage 装配。核心断言是**键空间统一**：
//   - `isolate` 以 scene.json 的**对象 id** 为键；
//   - player 的隔离条目 id（`isolatedObjects()[].id`）**也是对象 id**（attachIsolated 用 obj.id 建条目）；
//   - stage 的键（setWorldSize / setObjectChains）同样是对象 id。
// 三者同键空间：既不需要「对象 id → 图层计数器 id」的翻译层（那层复制了 loadSceneToThree 的建层
// 条件与顺序，对侧一改测试全绿而效果链静默全失效），也不会在「同壁纸 image + particle 同时隔离」
// 时撞键（背景层/粒子层两个计数器各自从 0 起，旧实现会互相覆盖）。
describe('对象级效果链接线（isolate 尺寸 + ObjectEffectStage 装配）', () => {
  function sceneWith(objects: Array<Record<string, unknown>>): string {
    return JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { height: 1080, width: 1920 } },
      objects,
    });
  }
  function sceneWithEffects(obj: Record<string, unknown>): string {
    return sceneWith([obj]);
  }

  it('image 对象：isolate 按对象 id 下发（五字段），效果链按同一个对象 id 挂载', async () => {
    // 两个 image 对象、带效果的是**第二个**：对象 id = 13（图层 id 会是 1）。
    // 断言键就是 13（既不是图层 id 0/1）才能真正钉住「对象 id 是唯一键空间」。
    stubAssetFetch(sceneWith([
      {
        id: 60, name: 'back', image: 'models/b.json',
        origin: '0 0 0', scale: '1 1 1', size: '1920 1080',
      },
      {
        id: 13, name: 'bg', image: 'models/a.json',
        origin: '960 540 0', scale: '1 1 1', size: '3840 2160',
        effects: [{ file: 'effects/w/effect.json' }],
      },
    ]), FX_FILES);
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null });
    defaultLoadWasm.mockResolvedValue(null); // 无粒子模块（本用例无粒子对象）
    const setObjectEffectStage = vi.fn();
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage,
      setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
      renderer: {},
      // 隔离条目的键 = 对象 id（真实 player 由 attachIsolated(obj.id) 建条目）。
      isolatedObjects: () => [{ id: 13, kind: 'background', rtWidth: 1920, rtHeight: 1080, rtTexture: {} }],
      // 屏幕密度的**唯一来源**是 player 自己（与 applyCover 同一套 state）：这里用哨兵值 0.5
      // 证明 resize 回调是把 player 的值**原样**转给 stage，而不是自己另算一份。
      screenScalePx: vi.fn(() => 0.5),
    };
    loadSceneToThree.mockReturnValue({
      player, sims: [], backgroundIds: [0, 1], particleLayers: [], puppetLayers: [],
    } as never);
    const worldSpy = vi.spyOn(ObjectEffectStage.prototype, 'setWorldSize').mockImplementation(() => {});
    const chainsSpy = vi.spyOn(ObjectEffectStage.prototype, 'setObjectChains').mockImplementation(() => {});

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    const ok = await r.render('2851992662', document.createElement('canvas'), null);
    expect(ok).toBe(true);

    // isolate 以对象 id（13）为键；五字段：objectId 同键，RT 像素 = 世界尺寸 × **屏幕密度**
    // （= 对象在画布缓冲上的占位像素），世界尺寸保持未收口的 |size × scale|。
    // 本用例场景 1920×1080、视口 1920×1080、dpr=1 ⇒ cover 铺满、密度 = 1 ⇒ RT = 世界 3840×2160
    // （旧口径「收口到视口 × dpr」会给 1920×1080 ⇒ 合成那一步 0.5× 重采样 ⇒ 整层发糊）。
    // 无效果对象不在表内。
    const assets = loadSceneToThree.mock.calls[0][1];
    expect(assets.isolate.get(13)).toEqual({
      objectId: 13, rtWidth: 3840, rtHeight: 2160, worldW: 3840, worldH: 2160,
    });
    expect(assets.isolate.has(60)).toBe(false);
    // stage 的键 = 对象 id（13），不是图层计数器 id（带效果的对象是第 2 个 image → 旧实现为 1）；
    // 第 4 参 = 源纹理像素（本用例 fakeTexture 无 image ⇒ 源未知 ⇒ null）；第 5 参 = 进 resize 期预算（image）。
    expect(worldSpy.mock.calls).toEqual([[13, 3840, 2160, null, true]]);
    expect(chainsSpy.mock.calls.map((c) => c[0])).toEqual([13]);
    expect(chainsSpy.mock.calls[0][1]).toHaveLength(1);
    // 装配完成才注入 player（stage 非 null），供帧序调用 bindOutputs/advance。
    expect(setObjectEffectStage).toHaveBeenCalledTimes(1);
    expect(setObjectEffectStage.mock.calls[0][0]).toBeInstanceOf(ObjectEffectStage);

    // 窗口 resize → 播放器重推 cover + 编排器按 player 的**新屏幕密度**重设对象 RT。
    const viewportSpy = vi.spyOn(ObjectEffectStage.prototype, 'onViewportResize').mockImplementation(() => {});
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    window.dispatchEvent(new Event('resize'));
    expect(viewportSpy.mock.calls).toEqual([[0.5]]); // = player.screenScalePx()（哨兵值，原样转发）
    expect(player.resize).toHaveBeenCalledWith(1600, 900);

    worldSpy.mockRestore();
    chainsSpy.mockRestore();
    viewportSpy.mockRestore();
    // teardown（切壁纸/dispose）必须释放编排器：runner 持有对象 RT/材质，且要在 player.dispose
    // （释放 renderer/隔离 RT）之前释放。
    const disposeSpy = vi.spyOn(ObjectEffectStage.prototype, 'dispose').mockImplementation(() => {});
    r.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    disposeSpy.mockRestore();
  });

  // v0.8.2 F2：util 层（models/util/*）与 image 同构进 isolate 表；世界尺寸按 utilWorldSize：
  // project/fullscreen = 正交场景尺寸，compose/solid = size × |scale|。RT = 屏占位（不参与预算）。
  it('util 对象带 effects → 进 isolate 表（与 image 同构），world 用 utilWorldSize', async () => {
    stubAssetFetch(sceneWith([
      {
        id: 58, name: 'Full Composition Layer', image: 'models/util/projectlayer.json',
        origin: '960 540 0', scale: '1 1 1', size: '1920 1080', alpha: 1, color: '1 1 1',
        effects: [{ file: 'effects/w/effect.json' }],
      },
      {
        id: 37, name: 'Compose', image: 'models/util/composelayer.json',
        origin: '200 200 0', scale: '1 1 1', size: '400 850',
        effects: [{ file: 'effects/w/effect.json' }],
      },
      {
        id: 327, name: 'Spectrum', image: 'models/util/solidlayer.json',
        origin: '0 0 0', scale: '0.87 -0.98 0.1', size: '1000 1000',
        alpha: 0, color: '0.79 0.79 0.79',
        effects: [{ file: 'effects/w/effect.json' }],
      },
    ]), FX_FILES);
    vi.mocked(defaultLoadWasm).mockResolvedValue(null);
    const registerFrameConsumer = vi.fn();
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage: vi.fn(),
      setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
      registerFrameConsumer,
      renderer: {},
      isolatedObjects: () => [
        { id: 58, kind: 'background', rtWidth: 1920, rtHeight: 1080, rtTexture: {} },
        { id: 37, kind: 'background', rtWidth: 400, rtHeight: 850, rtTexture: {} },
        { id: 327, kind: 'background', rtWidth: 870, rtHeight: 980, rtTexture: {} },
      ],
    };
    vi.mocked(loadSceneToThree).mockReturnValue({
      player, sims: [], backgroundIds: [0, 1, 2], particleLayers: [], puppetLayers: [],
    } as never);
    const worldSpy = vi.spyOn(ObjectEffectStage.prototype, 'setWorldSize').mockImplementation(() => {});
    const chainsSpy = vi.spyOn(ObjectEffectStage.prototype, 'setObjectChains').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2911105183', document.createElement('canvas'))).toBe(true);

    const assets = vi.mocked(loadSceneToThree).mock.calls[0][1];
    // 场景/视口均 1920×1080、dpr=1 ⇒ 密度 1：RT = 世界尺寸。
    expect(assets.isolate!.get(58)).toEqual({
      objectId: 58, rtWidth: 1920, rtHeight: 1080, worldW: 1920, worldH: 1080,
    });
    expect(assets.isolate!.get(37)).toEqual({
      objectId: 37, rtWidth: 400, rtHeight: 850, worldW: 400, worldH: 850,
    });
    expect(assets.isolate!.get(327)).toEqual({
      objectId: 327, rtWidth: 870, rtHeight: 980, worldW: 870, worldH: 980,
    });
    // 链按对象 id 挂载（顺序 = objects 顺序），源尺寸显式 null（util 无 pkg 源纹理）；
    // 第 5 参 = false（util 不进 resize 期预算）。
    expect(worldSpy.mock.calls).toEqual([
      [58, 1920, 1080, null, false],
      [37, 400, 850, null, false],
      [327, 870, 980, null, false],
    ]);
    expect(chainsSpy.mock.calls.map((c) => c[0])).toEqual([58, 37, 327]);
    // util 层不再算「挂在未参与渲染的对象类型上」。
    expect(warn.mock.calls.some((c) => String(c[0]).includes('未参与渲染'))).toBe(false);
    // T3：passthrough util（58/37）登记为帧消费者（内容输入 = 整帧快照）；solid（327）不登记。
    expect(registerFrameConsumer.mock.calls.map((c) => c[0])).toEqual([58, 37]);

    worldSpy.mockRestore();
    chainsSpy.mockRestore();
    warn.mockRestore();
    r.dispose?.();
  });

  // v0.8.2 Fix round 1（Minor 10）：util 准入只有「非静态隐藏 + 有非空效果链」——隐藏层不得被隔离
  // 画回来；无链层保持 v0.8.1 的不渲染（零回归）。
  it('util 准入：静态隐藏 / 无 effects 不进 isolate，只有带链的层进', async () => {
    stubAssetFetch(sceneWith([
      { id: 54, name: 'fullscreen', image: 'models/util/fullscreenlayer.json', effects: [{ file: 'effects/w/effect.json' }] },
      {
        id: 60, name: 'hidden', image: 'models/util/composelayer.json', size: '400 850',
        visible: false, effects: [{ file: 'effects/w/effect.json' }],
      },
      { id: 61, name: 'no-effects', image: 'models/util/solidlayer.json', size: '1000 1000', scale: '0.87 -0.98 1' },
    ]), FX_FILES);
    vi.mocked(defaultLoadWasm).mockResolvedValue(null);
    const registerFrameConsumer = vi.fn();
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage: vi.fn(),
      setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
      registerFrameConsumer,
      renderer: {}, isolatedObjects: () => [],
    };
    vi.mocked(loadSceneToThree).mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [] } as never);
    const worldSpy = vi.spyOn(ObjectEffectStage.prototype, 'setWorldSize').mockImplementation(() => {});
    const chainsSpy = vi.spyOn(ObjectEffectStage.prototype, 'setObjectChains').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2851992662', document.createElement('canvas'))).toBe(true);

    const assets = vi.mocked(loadSceneToThree).mock.calls[0][1];
    expect([...assets.isolate!.keys()]).toEqual([54]);
    expect(worldSpy.mock.calls.map((c) => c[0])).toEqual([54]);
    expect(chainsSpy.mock.calls.map((c) => c[0])).toEqual([54]);
    expect(registerFrameConsumer.mock.calls.map((c) => c[0])).toEqual([54]); // fullscreen = 内容输入消费者
    expect(warn.mock.calls.some((c) => String(c[0]).includes('未参与渲染'))).toBe(false);

    worldSpy.mockRestore();
    chainsSpy.mockRestore();
    warn.mockRestore();
    r.dispose?.();
  });

  // v0.8.2 Fix round 1（Minor 10）：util 世界尺寸取**父链折叠后的世界 scale**（3789452668 #327：
  // 父 80 的 scale 1.14488/1.13179 × 局部 0.87345/0.97913 ⇒ ≈1000×1108，不是局部 873×979）。
  it('parent util 世界尺寸取世界 scale（3789452668 #327 形态）', async () => {
    stubAssetFetch(sceneWith([
      {
        id: 80, name: 'parent', image: 'models/p.json',
        origin: '1927.49512 1142.68176 0', scale: '1.14488 1.13179 0.95818', size: '386 221',
      },
      {
        id: 327, name: '音频线', image: 'models/util/solidlayer_depthtest.json', parent: 80,
        origin: '4.3728 -180.26727 0', scale: '0.87345 -0.97913 0.10436', size: '1000 1000',
        alpha: 0, color: '0.79 0.79 0.79', effects: [{ file: 'effects/w/effect.json' }],
      },
    ]), FX_FILES);
    vi.mocked(resolveImageAssets).mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null, spriteSheet: false });
    vi.mocked(defaultLoadWasm).mockResolvedValue(null);
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage: vi.fn(),
      setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
      renderer: {}, isolatedObjects: () => [],
    };
    vi.mocked(loadSceneToThree).mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [] } as never);
    const worldSpy = vi.spyOn(ObjectEffectStage.prototype, 'setWorldSize').mockImplementation(() => {});
    const chainsSpy = vi.spyOn(ObjectEffectStage.prototype, 'setObjectChains').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2851992662', document.createElement('canvas'))).toBe(true);

    const iso = (vi.mocked(loadSceneToThree).mock.calls[0][1] as {
      isolate: Map<number, { rtWidth: number; rtHeight: number; worldW: number; worldH: number }>;
    }).isolate.get(327)!;
    // 世界 scale = 局部 0.87345/-0.97913 × 父 1.14488/1.13179 ⇒ ≈1.0/1.108 ⇒ world ≈1000×1108。
    const worldW = 1000 * 0.87345 * 1.14488;
    const worldH = 1000 * 0.97913 * 1.13179;
    expect(iso.worldW).toBeCloseTo(worldW, 6);
    expect(iso.worldH).toBeCloseTo(worldH, 6);
    // 密度 1 ⇒ RT = 屏占位 ≈ world：不是局部 873×979（父链未折叠时会是那个值）。
    expect([iso.rtWidth, iso.rtHeight]).toEqual([1000, 1108]);

    worldSpy.mockRestore();
    chainsSpy.mockRestore();
    warn.mockRestore();
    r.dispose?.();
  });

  // 省电与画质档位（2026-09-21）：状态跨 render 保留；装配即应用；改档位要同步屏幕密度给 stage。
  it('setPaused / setQualityScale：无 player 时记状态、装配即暂停；有 player 时即时下发并同步屏幕密度给 stage', async () => {
    stubSettings({ glowEnabled: false });
    stubAssetFetch(sceneWithEffects({
      id: 13, name: 'bg', image: 'models/a.json',
      origin: '960 540 0', scale: '1 1 1', size: '1920 1080',
      effects: [{ file: 'effects/w/effect.json' }],
    }), FX_FILES);
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null });
    defaultLoadWasm.mockResolvedValue(null);
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage: vi.fn(),
      setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
      renderer: {},
      isolatedObjects: () => [{ id: 13, kind: 'background', rtWidth: 1920, rtHeight: 1080, rtTexture: {} }],
      screenScalePx: vi.fn(() => 0.5),
      pause: vi.fn(), resume: vi.fn(), setQualityScale: vi.fn(),
    };
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], } as never);
    const worldSpy = vi.spyOn(ObjectEffectStage.prototype, 'setWorldSize').mockImplementation(() => {});
    const chainsSpy = vi.spyOn(ObjectEffectStage.prototype, 'setObjectChains').mockImplementation(() => {});
    const viewportSpy = vi.spyOn(ObjectEffectStage.prototype, 'onViewportResize').mockImplementation(() => {});

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    r.setPaused?.(true); // 尚无 player：只记状态
    expect(player.pause).not.toHaveBeenCalled();
    await r.render('2851992662', document.createElement('canvas'), null);
    expect(player.pause).toHaveBeenCalledTimes(1); // 装配即暂停（如切到后台时换壁纸）

    r.setPaused?.(false);
    expect(player.resume).toHaveBeenCalledTimes(1);
    r.setQualityScale?.(0.5);
    expect(player.setQualityScale).toHaveBeenCalledWith(0.5);
    // 对象 RT 的尺寸基准 = 屏幕密度，必须与 player 同源（哨兵值原样转发，不在这里另算）
    expect(viewportSpy).toHaveBeenLastCalledWith(0.5);

    worldSpy.mockRestore(); chainsSpy.mockRestore(); viewportSpy.mockRestore();
    r.dispose();
  });

  it('particle 对象：RT 像素 = 屏占位（世界 × 屏幕密度）、世界尺寸不随 dpr；链同样按对象 id 挂载', async () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    stubAssetFetch(sceneWithEffects({
      id: 71, name: 'Sakura', particle: 'particles/presets/leaves5.json',
      origin: '2306 419 0', scale: '2 2 1',
      effects: [{ file: 'effects/w/effect.json' }],
    }), {
      ...FX_FILES,
      'particles/presets/leaves5.json': '{"material":"materials/presets/leaves5.json","distanceMax":100}',
    });
    resolveParticleMaterial.mockResolvedValue(null);
    const sim = makeMockSim();
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => sim) } } as never);
    const setObjectEffectStage = vi.fn();
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage,
      setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
      renderer: {},
      isolatedObjects: () => [{ id: 71, kind: 'particle', rtWidth: 400, rtHeight: 400, rtTexture: {} }],
    };
    loadSceneToThree.mockReturnValue({
      player, sims: [sim], backgroundIds: [], particleLayers: [{ id: 0, sim }], puppetLayers: [],
    } as never);
    const worldSpy = vi.spyOn(ObjectEffectStage.prototype, 'setWorldSize').mockImplementation(() => {});
    const chainsSpy = vi.spyOn(ObjectEffectStage.prototype, 'setObjectChains').mockImplementation(() => {});

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    const ok = await r.render('2851992662', document.createElement('canvas'), null);
    expect(ok).toBe(true);

    // distanceMax 100 × scale 2 → 世界 200×200；dpr=2 且 cover 铺满（场景 = 视口）⇒ 屏幕密度 2
    // → RT 像素 = 屏占位 400×400（未触 4096 上限）。
    const assets = loadSceneToThree.mock.calls[0][1];
    expect(assets.isolate.get(71)).toEqual({
      objectId: 71, rtWidth: 400, rtHeight: 400, worldW: 200, worldH: 200,
    });
    // 键 = 对象 id 71：粒子图层 id 也是 0（与背景层计数器独立、各自从 0 起），旧实现下
    // 「同壁纸 image + particle 都隔离」会与背景条目的 0 撞键、互相覆盖。
    // 粒子不在 isolateItems 内 ⇒ 源尺寸未知 ⇒ 第 4 参是显式 null（统一下发形状，不靠缺省参数）。
    // 第 5 参 = false：粒子不进 resize 期预算（挂载期预算集合只有 image）。
    expect(worldSpy.mock.calls).toEqual([[71, 200, 200, null, false]]);
    expect(chainsSpy.mock.calls.map((c) => c[0])).toEqual([71]);

    worldSpy.mockRestore();
    chainsSpy.mockRestore();
    r.dispose();
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
  });

  it('无效果对象：不建 stage、不下发 isolate、帧序与今天一致（零回归）', async () => {
    stubAssetFetch(SCENE, {});
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null });
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => makeMockSim()) } } as never);
    const setObjectEffectStage = vi.fn();
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage,
      setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
      renderer: {},
      isolatedObjects: () => [],
    };
    loadSceneToThree.mockReturnValue({
      player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [],
    } as never);

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    const ok = await r.render('2851992662', document.createElement('canvas'), null);
    expect(ok).toBe(true);
    const assets = loadSceneToThree.mock.calls[0][1];
    // 无效果对象 → 没有任何隔离请求（isolate 缺省或空 Map，两条路径对 player 等价）。
    expect(assets.isolate?.size ?? 0).toBe(0);
    expect(setObjectEffectStage).not.toHaveBeenCalled();
    r.dispose();
  });

  // 2026-09-14（云不滚动修复）：colorBlendMode ∈ {6,7,31} 的对象**照常进隔离路径**。
  // 旧守卫的来由：这类模式的混合语义是「读当前帧缓冲、按自己的 alpha 与之混合」，内容材质把结果
  // alpha 钉成「背景的 alpha」（blendSrcAlpha=Zero / blendDstAlpha=One）；对象级 RT 里没有「背景」、
  // 清屏 alpha=0 ⇒ RT alpha 恒 0 ⇒ 合成 quad 的片元被乘成 0，对象整体不可见 —— 当年的取舍是
  // 「保可见、牺牲效果」（GTR 3743126786 的云因此不滚动）。
  // 现在混合语义整体搬到**合成 quad**（内容材质在隔离路径不套 cb，只把自己的颜色/alpha 写进 RT），
  // 于是对象可见 **且** 效果生效，守卫已整体删除（回归：GTR 的 Clouds Back obj 246 云滚动）。
  it('colorBlendMode=7 的对象照常进隔离路径（效果生效且对象可见），普通对象同样隔离', async () => {
    stubAssetFetch(sceneWith([
      {
        id: 13, name: 'bg', image: 'models/a.json',
        origin: '960 540 0', scale: '1 1 1', size: '1920 1080',
        effects: [{ file: 'effects/w/effect.json' }],
      },
      {
        id: 246, name: 'Clouds Back', image: 'models/clouds.json',
        origin: '960 540 0', scale: '1 1 1', size: '1920 1080', colorBlendMode: 7,
        effects: [{ file: 'effects/w/effect.json' }],
      },
    ]), FX_FILES);
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null });
    defaultLoadWasm.mockResolvedValue(null);
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage: vi.fn(),
      setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
      renderer: {},
      isolatedObjects: () => [{ id: 13, kind: 'background', rtWidth: 1920, rtHeight: 1080, rtTexture: {} }],
    };
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0, 1], particleLayers: [], puppetLayers: [], } as never);
    const worldSpy = vi.spyOn(ObjectEffectStage.prototype, 'setWorldSize').mockImplementation(() => {});
    const chainsSpy = vi.spyOn(ObjectEffectStage.prototype, 'setObjectChains').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    const ok = await r.render('3743126786', document.createElement('canvas'), null);
    expect(ok).toBe(true);

    const assets = loadSceneToThree.mock.calls[0][1];
    // 两个对象都隔离、都挂链（顺序 = scene.json objects 顺序）。
    expect(assets.isolate.has(246)).toBe(true);
    expect(assets.isolate.get(13)).toBeTruthy();
    expect(worldSpy.mock.calls.map((c) => c[0])).toEqual([13, 246]);
    expect(chainsSpy.mock.calls.map((c) => c[0])).toEqual([13, 246]);
    // 旧的「colorBlendMode 与对象级 RT alpha 语义冲突」告警整体消失（守卫已删）。
    expect(warn.mock.calls.some((c) => String(c[0]).includes('colorBlendMode='))).toBe(false);
    // 也不计入「挂在未参与渲染的对象类型上」的汇总告警。
    expect(warn.mock.calls.some((c) => String(c[0]).includes('未参与渲染'))).toBe(false);

    worldSpy.mockRestore();
    chainsSpy.mockRestore();
    warn.mockRestore();
    r.dispose();
  });

  // P2：具名 RT 图链**已可执行**（Task 6 起 setObjectChains 一视同仁建 runner/计划），
  // 准入回到「有链即隔离」——rtGraphOnly 优化与「不再隔离」告警整体删除。
  it('链全为具名 RT 图链的对象**照常**隔离（P2 起可执行，不再有 rtGraphOnly 优化）', async () => {
    stubAssetFetch(sceneWith([
      {
        id: 13, name: 'rtgraph', image: 'models/a.json',
        origin: '960 540 0', scale: '1 1 1', size: '3840 2160',
        effects: [{ file: 'effects/rtg/effect.json' }],
      },
    ]), FX_FILES_RT_GRAPH);
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null });
    defaultLoadWasm.mockResolvedValue(null);
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage: vi.fn(),
      setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
      renderer: {},
      // P2 起这类对象进入隔离（真实 player 会为 isolate 里每个对象建条目）
      isolatedObjects: () => [{ id: 13, kind: 'background', rtWidth: 3840, rtHeight: 2160, rtTexture: {} }],
    };
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], } as never);
    const worldSpy = vi.spyOn(ObjectEffectStage.prototype, 'setWorldSize').mockImplementation(() => {});
    const chainsSpy = vi.spyOn(ObjectEffectStage.prototype, 'setObjectChains').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2132420420', document.createElement('canvas'), null)).toBe(true);
    const assets = loadSceneToThree.mock.calls[0][1];
    expect(assets.isolate.has(13)).toBe(true);                    // ← 反转点（原为 false）
    expect(worldSpy.mock.calls.map((c) => c[0])).toEqual([13]);
    expect(chainsSpy.mock.calls.map((c) => c[0])).toEqual([13]);
    // 不再有「效果需要具名 RT（P2 未实现）」告警
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('效果需要具名 RT'))).toHaveLength(0);
    worldSpy.mockRestore();
    chainsSpy.mockRestore();
    warn.mockRestore();
    r.dispose();
  });

  // 最终审查 C2（按 R6 降级）：效果链的 `_rt_FullFrameBuffer` 消费者**本轮不启用**。装配路径仍
  // 照常注入 capture、照常挂链（能力保留在执行器与纯函数里），但**不得**登记段边界消费者：
  // 不登记 ⇒ frameCapture 不 active ⇒ 段渲染不开启 ⇒ 2597392171 的链行为 = 改动前（该槽留空 +
  // 每槽去重告警）。登记行为与判定口径的单测：tests/object-effects.test.ts。
  it('链引用 _rt_FullFrameBuffer：门控关闭 ⇒ 不登记段边界消费者（capture 仍照常注入）', async () => {
    stubAssetFetch(sceneWith([
      {
        id: 13, name: 'godrays', image: 'models/a.json',
        origin: '960 540 0', scale: '1 1 1', size: '3840 2160',
        effects: [{
          file: 'effects/frame/effect.json',
          passes: [{ textures: [null, '_rt_FullFrameBuffer'] }],
        }],
      },
      {
        id: 60, name: 'plain', image: 'models/b.json',
        origin: '0 0 0', scale: '1 1 1', size: '1920 1080',
        effects: [{ file: 'effects/w/effect.json' }],
      },
    ]), FX_FILES_FRAME_RT);
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null });
    defaultLoadWasm.mockResolvedValue(null);
    const registerFrameConsumer = vi.fn();
    const setFrameCapture = vi.fn();
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage: vi.fn(),
      setGlowStage: vi.fn(), setFrameCapture, registerFrameConsumer,
      setParallax: vi.fn(), setParallaxPointer: vi.fn(),
      renderer: {},
      isolatedObjects: () => [
        { id: 13, kind: 'background', rtWidth: 3840, rtHeight: 2160, rtTexture: {} },
        { id: 60, kind: 'background', rtWidth: 1920, rtHeight: 1080, rtTexture: {} },
      ],
    };
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0, 1], particleLayers: [], puppetLayers: [], } as never);
    // 不替换 setObjectChains：本用例要走**真实**挂载路径（判定就发生在它内部）。
    vi.spyOn(ObjectEffectStage.prototype, 'setWorldSize').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2597392171', document.createElement('canvas'), null)).toBe(true);
    // capture 接线不变（无消费者时 active=false ⇒ 帧序与改动前一致），但两个对象都**不**登记。
    expect(setFrameCapture).toHaveBeenCalledTimes(1);
    expect(registerFrameConsumer).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('尚无隔离条目'))).toHaveLength(0);
    warn.mockRestore();
    r.dispose();
  });

  // v0.8.2 F2 起 util 层走隔离渲染（不再计入本告警）；仍「未参与渲染」的是缺 spec/资源的粒子对象
  // 与音频空对象。这类对象上的 effects 既不会被隔离也不会被挂链，此前完全静默——按壁纸汇总一条
  // warn（每壁纸一条，不按对象刷屏）。
  it('缺粒子资源的对象上的 effects 无法隔离 → 汇总一条「已跳过」告警（不静默丢弃）', async () => {
    stubAssetFetch(sceneWith([
      {
        id: 13, name: 'bg', image: 'models/a.json',
        origin: '960 540 0', scale: '1 1 1', size: '1920 1080',
        effects: [{ file: 'effects/w/effect.json' }],
      },
      {
        id: 71, name: 'missing-particle', particle: 'particles/missing.json',
        origin: '0 0 0', scale: '1 1 1',
        effects: [{ file: 'effects/w/effect.json' }, { file: 'effects/w/effect.json' }],
      },
    ]), FX_FILES);
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null });
    defaultLoadWasm.mockResolvedValue(null);
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage: vi.fn(),
      setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
      renderer: {},
      isolatedObjects: () => [{ id: 13, kind: 'background', rtWidth: 1920, rtHeight: 1080, rtTexture: {} }],
    };
    vi.mocked(loadSceneToThree).mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], } as never);
    const worldSpy = vi.spyOn(ObjectEffectStage.prototype, 'setWorldSize').mockImplementation(() => {});
    const chainsSpy = vi.spyOn(ObjectEffectStage.prototype, 'setObjectChains').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    const ok = await r.render('2132420420', document.createElement('canvas'), null);
    expect(ok).toBe(true);

    // 汇总一条（缺粒子资源的对象上的 2 条效果），而不是每对象/每条链一条。
    const skipped = warn.mock.calls.filter((c) => String(c[0]).includes('未参与渲染'));
    expect(skipped).toHaveLength(1);
    expect(String(skipped[0][0])).toContain('2 条效果');
    // 能隔离的对象照常挂链，不受汇总告警影响。
    expect(chainsSpy.mock.calls.map((c) => c[0])).toEqual([13]);
    expect(vi.mocked(loadSceneToThree).mock.calls[0][1].isolate!.has(71)).toBe(false);

    worldSpy.mockRestore();
    chainsSpy.mockRestore();
    warn.mockRestore();
    r.dispose();
  });

  // v0.8.2 T3：util 层内容输入 = 整帧快照 ⇒ 每个 **passthrough** util 层（project/fullscreen/
  // compose）都登记为帧消费者（段边界才有快照可写成内容）；solid 保留纯色内容、不登记。
  // `_rt_FullFrameBuffer` 槽门控只对「util + 链显式引用」开放：对象链（image）保持关闭。
  it('util 内容输入：passthrough util 登记帧消费者；solid 与对象链不登记，槽门控只放行 util', async () => {
    const framePass = { passes: [{ textures: [null, '_rt_FullFrameBuffer'] }] };
    stubAssetFetch(sceneWith([
      {
        id: 13, name: 'image-godrays', image: 'models/a.json',
        origin: '960 540 0', scale: '1 1 1', size: '1920 1080',
        effects: [{ file: 'effects/frame/effect.json', ...framePass }],
      },
      {
        id: 58, name: 'project', image: 'models/util/projectlayer.json',
        origin: '960 540 0', scale: '1 1 1', size: '1920 1080',
        effects: [{ file: 'effects/frame/effect.json', ...framePass }],
      },
      {
        id: 37, name: 'compose', image: 'models/util/composelayer.json',
        origin: '200 200 0', scale: '1 1 1', size: '400 850',
        effects: [{ file: 'effects/w/effect.json' }], // 不引用全局快照槽（真实 util 链读 previous）
      },
      {
        id: 327, name: 'solid', image: 'models/util/solidlayer.json',
        origin: '0 0 0', scale: '0.87 -0.98 0.1', size: '1000 1000',
        alpha: 0, color: '0.79 0.79 0.79',
        effects: [{ file: 'effects/frame/effect.json', ...framePass }],
      },
    ]), FX_FILES_FRAME_RT);
    vi.mocked(resolveImageAssets).mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null, spriteSheet: false });
    vi.mocked(defaultLoadWasm).mockResolvedValue(null);
    const registerFrameConsumer = vi.fn();
    const setFrameCapture = vi.fn();
    const setObjectEffectStage = vi.fn();
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage,
      setGlowStage: vi.fn(), setFrameCapture, registerFrameConsumer,
      currentFrameSnapshot: () => null,
      setParallax: vi.fn(), setParallaxPointer: vi.fn(),
      renderer: {},
      isolatedObjects: () => [
        { id: 13, kind: 'background', rtWidth: 1920, rtHeight: 1080, rtTexture: {} },
        { id: 58, kind: 'background', rtWidth: 1920, rtHeight: 1080, rtTexture: {} },
        { id: 37, kind: 'background', rtWidth: 400, rtHeight: 850, rtTexture: {} },
        { id: 327, kind: 'background', rtWidth: 870, rtHeight: 980, rtTexture: {} },
      ],
    };
    vi.mocked(loadSceneToThree).mockReturnValue({ player, sims: [], backgroundIds: [0, 1, 2, 3], particleLayers: [], puppetLayers: [], } as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2911105183', document.createElement('canvas'))).toBe(true);

    // 只有 passthrough util（58 project / 37 compose）登记；solid 327 与 image 13 不登记。
    expect(registerFrameConsumer.mock.calls.map((c) => c[0])).toEqual([58, 37]);
    // capture 必须先注入、再登记消费者（否则 checkFrameConsumers 命不中 → 不 active）。
    expect(setFrameCapture.mock.invocationCallOrder[0])
      .toBeLessThan(registerFrameConsumer.mock.invocationCallOrder[0]);
    // 槽门控：util 58 的链显式引用 → 绑定；37 未引用 → 不绑定；solid/image 一律不绑定。
    const stage = setObjectEffectStage.mock.calls[0][0] as ObjectEffectStage;
    expect(stage.frameSnapshotBound(58)).toBe(true);
    expect(stage.frameSnapshotBound(37)).toBe(false);
    expect(stage.frameSnapshotBound(327)).toBe(false);
    expect(stage.frameSnapshotBound(13)).toBe(false);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('尚无隔离条目'))).toHaveLength(0);

    warn.mockRestore();
    r.dispose?.();
  });

  // 与 threejs-player 的「resize / setFrameCapture 清空 lastFrameSnapshot」配套：player 侧清空后，
  // 渲染器每帧同步给 stage 的必须是 null（不是上一帧旧纹理），否则门控放行的链会采到已 dispose 的纹理。
  it('每帧快照槽同步：player 快照为 null 时 stage 收到 null（不保留旧纹理）', async () => {
    stubAssetFetch(sceneWith([
      {
        id: 13, name: 'bg', image: 'models/a.json',
        origin: '960 540 0', scale: '1 1 1', size: '1920 1080',
        effects: [{ file: 'effects/w/effect.json' }],
      },
    ]), FX_FILES);
    vi.mocked(resolveImageAssets).mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null, spriteSheet: false });
    vi.mocked(defaultLoadWasm).mockResolvedValue(null);
    const setObjectEffectStage = vi.fn();
    const snap = fakeTexture() as unknown as THREE.Texture;
    const currentFrameSnapshot = vi.fn<() => THREE.Texture | null>(() => snap);
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage,
      setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
      currentFrameSnapshot,
      renderer: {},
      isolatedObjects: () => [{ id: 13, kind: 'background', rtWidth: 1920, rtHeight: 1080, rtTexture: {} }],
    };
    vi.mocked(loadSceneToThree).mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], } as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2911105183', document.createElement('canvas'))).toBe(true);
    const stage = setObjectEffectStage.mock.calls[0][0] as ObjectEffectStage;
    const sync = vi.spyOn(stage, 'setFrameSnapshot');
    const onFrame = vi.mocked(loadSceneToThree).mock.calls[0][1].onFrame as (dt: number) => void;

    onFrame(0.016);
    expect(sync).toHaveBeenLastCalledWith(snap);
    // 模拟 player.resize()/setFrameCapture() 已清空 lastFrameSnapshot。
    currentFrameSnapshot.mockReturnValue(null);
    onFrame(0.016);
    expect(sync).toHaveBeenLastCalledWith(null);
    expect(currentFrameSnapshot).toHaveBeenCalled();

    sync.mockRestore();
    warn.mockRestore();
    r.dispose?.();
  });

  // T5：effect 级 visible 的 {user} 在装配前被 resolveSceneUserBindings 换成静态 bool，
  // 用户值 false ⇒ 整条链跳过（不隔离、不建 stage）；用户值 true ⇒ 同一 fixture 照常挂载。
  it('effect 级 visible 的 {user}：用户 false → 链跳过，true → 照常挂载', async () => {
    stubAssetFetch(sceneWith([{
      id: 13, name: 'bg', image: 'models/a.json',
      origin: '960 540 0', scale: '1 1 1', size: '1920 1080',
      effects: [{ file: 'effects/w/effect.json', visible: { user: 'depthparallax', value: true } }],
    }]), FX_FILES);
    vi.mocked(resolveImageAssets).mockResolvedValue({
      texture: fakeTexture() as never, puppetPath: null, spriteSheet: false,
    });
    vi.mocked(defaultLoadWasm).mockResolvedValue(null); // 本用例无粒子
    const setObjectEffectStage = vi.fn();
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage,
      setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
      renderer: {},
      isolatedObjects: () => [{ id: 13, kind: 'background', rtWidth: 1920, rtHeight: 1080, rtTexture: {} }],
    };
    vi.mocked(loadSceneToThree).mockReturnValue({
      player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [],
    } as never);
    const worldSpy = vi.spyOn(ObjectEffectStage.prototype, 'setWorldSize').mockImplementation(() => {});
    const chainsSpy = vi.spyOn(ObjectEffectStage.prototype, 'setObjectChains').mockImplementation(() => {});

    // 用户值 false：resolve 后 effect.visible=false ⇒ effectChains 为空 ⇒ 无隔离、无 stage。
    localStorage.setItem('we:userprop:fx-effect-visible:depthparallax', 'false');
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('fx-effect-visible', document.createElement('canvas'))).toBe(true);
    const hidden = vi.mocked(loadSceneToThree).mock.calls[0]![1] as {
      backgroundTextures: Map<number, unknown>; isolate?: Map<number, unknown>;
    };
    expect(hidden.backgroundTextures.has(13)).toBe(true); // 对象本身照常装配（只关 effect）
    expect(hidden.isolate?.has(13) ?? false).toBe(false);
    expect(setObjectEffectStage).not.toHaveBeenCalled();

    // 对照：key 缺失回退作者 value=true，同一 fixture 的链能挂上（排除 fixture 产不出链）。
    localStorage.removeItem('we:userprop:fx-effect-visible:depthparallax');
    expect(await r.render('fx-effect-visible', document.createElement('canvas'))).toBe(true);
    const shown = vi.mocked(loadSceneToThree).mock.calls[1]![1] as { isolate?: Map<number, unknown> };
    expect(shown.isolate?.has(13)).toBe(true);
    expect(setObjectEffectStage).toHaveBeenCalledTimes(1);
    expect(chainsSpy.mock.calls.map((c) => c[0])).toEqual([13]);
    expect(chainsSpy.mock.calls[0]![1]).toHaveLength(1);

    worldSpy.mockRestore();
    chainsSpy.mockRestore();
    r.dispose?.();
  });
});

// Task 5：挂载期隔离对象 RT 的新口径 —— min(源纹理长边, 4096) 等比收口、只升不降（下限仍是屏占位），
// 并按显存预算等比收窄升级幅度。R13：默认 384 MB 只装得下 1 个 4096 收口对象，故钉「长边 = 4096」的用例只放 1 个。
describe('对象级效果链：隔离 RT 尺寸按源纹理收口 4096', () => {
  let origDpr: number;
  beforeEach(() => {
    origDpr = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
  });
  afterEach(() => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: origDpr });
    vi.restoreAllMocks();
  });

  // 场景 5000×2400 铺进 1920×1080 视口、dpr=1 ⇒ 屏幕密度 0.45 ⇒ 5000×2400 对象的屏占位
  // 只有 2250×1080（= 旧口径的 RT）。
  const ORTHO = { width: 5000, height: 2400 };
  const SRC = { width: 5000, height: 2400 };
  const OCC_LONG = 2250;

  function bgObject(id: number): Record<string, unknown> {
    return {
      id, name: `bg-${id}`, image: `models/${id}.json`,
      origin: '2500 1200 0', scale: '1 1 1', size: '5000 2400',
      effects: [{ file: 'effects/w/effect.json' }],
    };
  }
  function stubAsset(objects: Array<Record<string, unknown>>): void {
    stubAssetFetch(JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: ORTHO },
      objects,
    }), FX_FILES);
    defaultLoadWasm.mockResolvedValue(null); // 本场景无粒子
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(), setObjectEffectStage: vi.fn(),
      registerFrameConsumer: vi.fn(),
      renderer: {}, isolatedObjects: () => [],
    };
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], } as never);
    // 链的 WebGL 部分（runner/材质）在 jsdom 里不可用：挂链打桩，只断言 isolate 表的尺寸。
    vi.spyOn(ObjectEffectStage.prototype, 'setWorldSize').mockImplementation(() => {});
    vi.spyOn(ObjectEffectStage.prototype, 'setObjectChains').mockImplementation(() => {});
  }
  function isolateOf(): Map<number, { rtWidth: number; rtHeight: number; worldW: number; worldH: number }> {
    return (loadSceneToThree.mock.calls[0][1] as {
      isolate: Map<number, { rtWidth: number; rtHeight: number; worldW: number; worldH: number }>;
    }).isolate;
  }

  it('有源纹理的隔离对象：RT = 源纹理等比收口 4096（长边恰为上限，旧口径是 2250）', async () => {
    stubAsset([bgObject(13)]); // R13(a)：只放 1 个隔离对象，预算充裕 ⇒ 长边必须恰为 4096
    resolveImageAssets.mockResolvedValue({ texture: { image: { ...SRC }, dispose: vi.fn() } as never, puppetPath: null });

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);

    const iso = isolateOf().get(13)!;
    expect(Math.max(iso.rtWidth, iso.rtHeight)).toBe(4096);
    // 等比收口（非逐轴截断）：短边 = 4096 × 2400/5000 = 1966，而不是被钳成 4096。
    expect(iso.rtWidth).toBe(4096);
    expect(iso.rtHeight).toBe(1966);
    // 世界尺寸（合成 quad 的基准）仍是未钳制的 |size × 世界 scale|。
    expect(iso.worldW).toBe(5000);
    expect(iso.worldH).toBe(2400);
    r.dispose();
  });

  it('无源尺寸（纹理未就绪）的隔离对象：回退屏占位 —— 只升不降', async () => {
    stubAsset([bgObject(246)]);
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null }); // 无 image ⇒ source = null

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);

    const density = screenScalePx(ORTHO.width, ORTHO.height, 1920, 1080, 1);
    const iso = isolateOf().get(246)!;
    expect(iso.rtWidth).toBe(Math.round(ORTHO.width * density));
    expect(iso.rtHeight).toBe(Math.round(ORTHO.height * density));
    r.dispose();
  });

  it('对象缺 size ⇒ 世界尺寸走纹理像素兜底（不得改用逐轴钳 4096 的相机范围）', async () => {
    // scene.json 的 image 对象没有 size 字段时（size2 → undefined），世界尺寸退到纹理 image 像素，
    // 源纹理像素则走同一条 sourcePixelsFromTexture ⇒ 两者必须同时是 8192×4096。
    stubAsset([{
      id: 13, name: 'bg-nosize', image: 'models/13.json', origin: '0 0 0', scale: '1 1 1',
      effects: [{ file: 'effects/w/effect.json' }],
    }]);
    resolveImageAssets.mockResolvedValue({ texture: { image: { width: 8192, height: 4096 }, dispose: vi.fn() } as never, puppetPath: null });

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);

    // 世界尺寸（合成 quad 的基准）= 纹理像素 × scale，未逐轴钳 4096；第 5 参 = true（image 进预算）。
    expect(vi.mocked(ObjectEffectStage.prototype.setWorldSize).mock.calls)
      .toEqual([[13, 8192, 4096, { width: 8192, height: 4096 }, true]]);
    // RT = 源纹理等比收口 4096（源长边 8192 > cap；屏占位仅 3686×1843 = 8192×4096 × 密度 0.45）：
    // 4096 × 4096/8192 = 2048。5000 是场景宽，不是屏占位长边。
    const iso = isolateOf().get(13)!;
    expect([iso.rtWidth, iso.rtHeight]).toEqual([4096, 2048]);
    expect(iso).toMatchObject({ worldW: 8192, worldH: 4096 });
    r.dispose();
  });

  it('调用点统一下发第 4 参：源尺寸已知传 SourcePixels、未知传 null（不是 undefined）', async () => {
    stubAsset([bgObject(13), bgObject(246)]);
    // 13 有源纹理、246 纹理未就绪（无 image ⇒ source = null）：一次渲染钉住两种下发形状。
    resolveImageAssets.mockImplementation(async (_id, o) => ({
      texture: (o.id === 13 ? { image: { ...SRC }, dispose: vi.fn() } : fakeTexture()) as never,
      puppetPath: null,
    }));

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);

    // 第 4 参 = 与挂载期尺寸计算同一份源纹理像素；源未知时是显式 null（缺参 = 3 参形状会让本断言变红）。
    expect(vi.mocked(ObjectEffectStage.prototype.setWorldSize).mock.calls)
      .toEqual([[13, 5000, 2400, { width: 5000, height: 2400 }, true], [246, 5000, 2400, null, true]]);
    r.dispose();
  });

  it('两个 4096 收口对象超预算 → 等比收窄升级幅度，且不低于屏占位', async () => {
    stubAsset([bgObject(13), bgObject(246)]);
    resolveImageAssets.mockResolvedValue({ texture: { image: { ...SRC }, dispose: vi.fn() } as never, puppetPath: null });

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);

    const a = isolateOf().get(13)!;
    const b = isolateOf().get(246)!;
    // 预算护栏生效：两对象合计不超 384 MB（未接线时各自 4096×1966 ⇒ 合计 ≈ 451 MB）。
    expect((a.rtWidth * a.rtHeight + b.rtWidth * b.rtHeight) * ISOLATED_RT_BYTES_PER_PX)
      .toBeLessThanOrEqual(ISOLATED_RT_BUDGET_BYTES);
    // 只升不降：收窄的是升级幅度，下限仍是屏占位 2250×1080。
    expect(Math.max(a.rtWidth, a.rtHeight)).toBeGreaterThan(OCC_LONG);
    expect(a.rtWidth).toBe(b.rtWidth); // 同一 budgetScale + 同尺寸对象 ⇒ 同一 RT
    r.dispose();
  });

  // spec §2.2：util 层不参与 fitIsolatedBudget（不跟 image 抢预算）；RT 恒为屏占位。
  it('util 层不进隔离预算：image 的 4096 收口只按 image 集合受预算约束', async () => {
    stubAsset([
      bgObject(13), bgObject(246),
      {
        id: 58, name: 'projectlayer', image: 'models/util/projectlayer.json',
        origin: '0 0 0', scale: '1 1 1', size: '5000 2400',
        effects: [{ file: 'effects/w/effect.json' }],
      },
    ]);
    vi.mocked(resolveImageAssets).mockResolvedValue({ texture: { image: { ...SRC }, dispose: vi.fn() } as never, puppetPath: null, spriteSheet: false });

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2911105183', document.createElement('canvas'))).toBe(true);

    const density = screenScalePx(ORTHO.width, ORTHO.height, 1920, 1080, 1);
    // 期望值按「只有 image 参与预算」的纯函数口径算；util 若被误计入，budgetScale 会更小 ⇒ 这里变红。
    const budget = fitIsolatedBudget([
      { worldW: SRC.width, worldH: SRC.height, source: SRC },
      { worldW: SRC.width, worldH: SRC.height, source: SRC },
    ], density);
    const expected = isolatedRtSize(SRC.width, SRC.height, density, SRC, { budgetScale: budget });
    const img = isolateOf().get(13)!;
    expect([img.rtWidth, img.rtHeight]).toEqual([expected.width, expected.height]);
    // util RT = 屏占位（世界 = 正交场景尺寸 5000×2400）。
    const util = isolateOf().get(58)!;
    expect(util).toEqual({
      objectId: 58,
      rtWidth: Math.round(5000 * density), rtHeight: Math.round(2400 * density),
      worldW: 5000, worldH: 2400,
    });
    r.dispose?.();
  });
});

// 真实 loadSceneToThree 用例（本文件多处）共用的 mock renderer：jsdom 无 WebGL ⇒ 真实 WebGLRenderer
// 构造即抛错，故只覆盖 player 用到的接口。
function createPlayerMockRenderer() {
  return {
    setSize: vi.fn(),
    setPixelRatio: vi.fn(),
    render: vi.fn(),
    setRenderTarget: vi.fn(),
    dispose: vi.fn(),
    setAnimationLoop: vi.fn(),
  };
}

// ── 对侧回归（审查 Important 1）：真实 loadSceneToThree 与 renderer 走同一条链路 ──────────────
// 上面这些用例把整个 `threejs-player.js` mock 掉，于是「renderer 传出的键」与「player 实际建的
// 隔离条目 id」被同一条 mock 一起隔离——两边都写错也全绿。本用例用 `vi.importActual` 跑**真实**的
// loadSceneToThree（注入 mock renderer，写法对齐 tests/threejs-player.test.ts），断言：
//   ① 真实 player 的 `isolatedObjects()` 里存在 `id === 对象 id` 的条目；
//   ② ObjectEffectStage 收到的键就是同一个对象 id，且**找到了**该隔离条目（否则只会打印
//      「尚无隔离条目，效果链未挂载（调用顺序错误）」）。
// 任何一侧改动建层条件/顺序（或键空间再漂移）都会让本用例变红。
describe('对象级效果链接线（真实 loadSceneToThree 对侧校验）', () => {
  it('真实 player 的隔离条目 id === 对象 id，stage 收到的键同为该对象 id', async () => {
    const OBJ_ID = 13;
    stubAssetFetch(JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { height: 1080, width: 1920 } },
      objects: [{
        id: OBJ_ID, name: 'bg', image: 'models/a.json',
        origin: '960 540 0', scale: '1 1 1', size: '1920 1080',
        effects: [{ file: 'effects/w/effect.json' }],
      }],
    }), FX_FILES);
    resolveImageAssets.mockResolvedValue({ texture: new THREE.DataTexture(new Uint8Array(4), 1, 1) as never, puppetPath: null });
    defaultLoadWasm.mockResolvedValue(null);
    // 真实 loadSceneToThree（旁路本文件顶部的 mock），注入 mock renderer。
    const actual = await vi.importActual<typeof import('../src/client/threejs-player.js')>(
      '../src/client/threejs-player.js',
    );
    loadSceneToThree.mockImplementation(
      (sceneJson: string, assets: unknown, canvas: HTMLCanvasElement, viewport: unknown) =>
        actual.loadSceneToThree(
          sceneJson,
          { ...(assets as object), renderer: createPlayerMockRenderer() } as never,
          canvas,
          viewport as never,
        ),
    );
    // mount 会构造 EffectRunner（需要 WebGL）：本用例只校验**键空间对齐**，把 mount 打桩。
    // setObjectChains 保留真实实现——它正是「拿键去 isolatedObjects() 里找隔离条目」的那一环。
    const mountSpy = vi.spyOn(
      ObjectEffectStage.prototype as unknown as { mount: (...args: unknown[]) => void },
      'mount',
    ).mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    const ok = await r.render('2851992662', document.createElement('canvas'), null);
    expect(ok).toBe(true);

    // ① 真实 player：隔离条目的键 = scene.json 的对象 id（旧实现此处是图层计数器 id 0）。
    const player = loadSceneToThree.mock.results[0].value.player as { isolatedObjects: () => Array<{ id: number }> };
    expect(player.isolatedObjects().map((o) => o.id)).toEqual([OBJ_ID]);
    // ② stage：键 = 同一个对象 id，且**找到了**隔离条目（mount 只在 find 成功后才会被调用）。
    expect(mountSpy).toHaveBeenCalledTimes(1);
    expect(mountSpy.mock.calls[0][0]).toBe(OBJ_ID);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('调用顺序错误'))).toBe(false);

    mountSpy.mockRestore();
    warn.mockRestore();
    r.dispose();
  });

  // renderOrder 唯一化：真实装配循环把 objects 数组下标透传给 addBackground/addParticle
  // （WE 绘制序 = m_objectsByRenderOrder，lwe CScene.cpp:94-101/262-295）。
  it('真实 loadSceneToThree：按 objects 下标把唯一 renderOrder 透传给 addBackground/addParticle', async () => {
    const actual = await vi.importActual<typeof import('../src/client/threejs-player.js')>(
      '../src/client/threejs-player.js',
    );
    const bgSpy = vi.spyOn(actual.ThreeScenePlayer.prototype, 'addBackground');
    const partSpy = vi.spyOn(actual.ThreeScenePlayer.prototype, 'addParticle');
    try {
      // 下标 0 image、1 particle、2 image（第 3 个对象用来确认下标不重复）
      const scene = JSON.stringify({
        general: { orthogonalprojection: { height: 1080, width: 1920 } },
        objects: [
          { id: 13, image: 'models/a.json', origin: '960 540 0', scale: '1 1 1', size: '1920 1080' },
          { id: 22, particle: 'particles/p.json', origin: '100 100 0', scale: '1 1 1' },
          { id: 30, image: 'models/b.json', origin: '100 100 0', scale: '1 1 1', size: '100 100' },
        ],
      });
      const tex = () => new THREE.DataTexture(new Uint8Array(4), 2, 2);
      const assets = {
        renderer: createPlayerMockRenderer(),
        backgroundTextures: new Map([[13, tex()], [30, tex()]]),
        particles: new Map([[22, { specJson: '{}', blend: 'alpha' as const }]]),
        createParticleSim: vi.fn(() => makeMockSim()),
      };
      const result = actual.loadSceneToThree(
        scene,
        assets as never,
        document.createElement('canvas'),
      );
      // 透传给 player 的就是下标（addBackground 的第 1 参 / addParticle 的第 2 参）
      expect(bgSpy.mock.calls.map((c) => c[0].renderOrder)).toEqual([0, 2]);
      expect(partSpy.mock.calls.map((c) => c[1].renderOrder)).toEqual([1]);
      // 玩家侧真正的绘制序：唯一且与下标一致
      expect(result.player.scene.children.map((c) => (c as THREE.Mesh).renderOrder)).toEqual([0, 1, 2]);
    } finally {
      bgSpy.mockRestore();
      partSpy.mockRestore();
    }
  });
});

// text 对象（2026-09-21）：主路径渲染 text（时钟每帧走字）；**只对 text** 应用 visible 过滤——
// 不接会叠出本应隐藏的时钟（2911105183 的 3 个 Clock 里有 2 个默认隐藏）。
describe('three-renderer text 对象', () => {
  const sceneWithText = (textObj: Record<string, unknown>) => JSON.stringify({
    camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
    general: { orthogonalprojection: { width: 1920, height: 1080 } },
    objects: [{
      id: 5, name: 'Clock', origin: '960 540 0', scale: '1 1 1', size: '400 100', ...textObj,
    }],
  });
  const CLOCK_SCRIPT = "var d = new Date(); var m = ['Jan.','Feb.']; var h = d.getHours(); var mi = d.getMinutes();";
  // 记录型 2D 上下文：度量按「等宽 0.5em、字体 bounding box 1em（ascent 0.8em / descent 0.2em）」模拟。
  let ctx2d: {
    font: string; fillStyle: string; textAlign: string; textBaseline: string;
    fillText: ReturnType<typeof vi.fn>; measureText: ReturnType<typeof vi.fn>;
  };

  function stubTextRender() {
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(), setObjectEffectStage: vi.fn(),
      isolatedObjects: () => [],
    };
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], } as never);
    return player;
  }

  beforeEach(() => {
    ctx2d = {
      font: '', fillStyle: '', textAlign: '', textBaseline: '', fillText: vi.fn(),
      measureText: vi.fn((s: string) => {
        const px = parseFloat(ctx2d.font) || 10;
        return {
          width: String(s).length * px * 0.5,
          fontBoundingBoxAscent: px * 0.8,
          fontBoundingBoxDescent: px * 0.2,
        };
      }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx2d as unknown as CanvasRenderingContext2D);
    stubSettings({ glowEnabled: false });
    defaultLoadWasm.mockResolvedValue(null);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('clock 脚本的 text → 下发 textLayers（纹理 + 每帧驱动），初始文本即时钟格式而非占位值', async () => {    stubAssetFetch(sceneWithText({ text: { value: '12:34', script: CLOCK_SCRIPT } }), {});
    stubTextRender();
    // 注入「运行时不可用」：单测不加载 quickjs wasm，clock 兜底路径才是本用例的断言对象。
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm, getTextScriptRuntime: async () => null });
    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);

    const assets = loadSceneToThree.mock.calls[0][1] as { textLayers: Map<number, {
      texture: unknown;
      driver?: { update(now: Date): boolean; layout: { width: number; height: number; textWidth: number; textHeight: number } };
      size?: [number, number];
    }> };
    const layer = assets.textLayers.get(5)!;
    expect(layer.texture).toBeTruthy();
    expect(typeof layer.driver?.update).toBe('function');
    // 驱动携带最近一次实测布局：帧循环按它 resize quad；必须与装配期画布尺寸同源
    expect(layer.driver?.layout.width).toBe(layer.size![0]);
    expect(layer.driver?.layout.height).toBe(layer.size![1]);
    expect(String(ctx2d.fillText.mock.calls[0][0])).toMatch(/\d{2}:\d{2}/);
    r.dispose();
  });

  // v0.8.1 F3：text 带 effects 时按对象 id 进 isolate 表；世界尺寸 = 实测布局 × |scale|，
  // RT 用屏占位口径（不是 scene.json 的 size）。
  it('带 effects 的 text → isolate 按对象 id 下发，世界尺寸取实测布局 × scale', async () => {
    stubAssetFetch(sceneWithText({
      scale: '2 2 1',
      effects: [{ file: 'effects/w/effect.json' }],
      text: { value: '12:34' },
    }), FX_FILES);
    stubTextRender();
    // mock player 没有隔离条目：接住真 stage 的挂链，避免它报「调用顺序错误」告警。
    const chainsSpy = vi.spyOn(ObjectEffectStage.prototype, 'setObjectChains').mockImplementation(() => {});
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    // bg 参数 render 内未使用，省略即可（不再为 null 补类型断言）。
    expect(await r.render('2851992662', document.createElement('canvas'))).toBe(true);

    const assets = vi.mocked(loadSceneToThree).mock.calls[0][1] as {
      textLayers: Map<number, { size?: [number, number] }>;
      isolate: Map<number, unknown>;
    };
    const layer = assets.textLayers.get(5)!;
    // 实测布局 = 5 字符 × 48px×0.5 = 120 宽、字高 ceil(48) = 49；scale 2 → 世界 240×98。
    expect(layer.size).toEqual([120, 49]);
    expect(assets.isolate.get(5)).toEqual({
      objectId: 5, rtWidth: 240, rtHeight: 98, worldW: 240, worldH: 98,
    });
    // 链按对象 id 5（不是图层计数器 id）挂载，且链非空。
    expect(chainsSpy.mock.calls.map((c) => c[0])).toEqual([5]);
    expect(chainsSpy.mock.calls[0][1]).toHaveLength(1);
    chainsSpy.mockRestore();
    r.dispose!();
  });

  // 回归（v0.8.1 热修）：text 隔离 RT 的源分辨率下限 = 布局 canvas 像素。只按屏占位会把小字号
  // 文本降到几十像素再跑效果链（blur 半径相对笔画过强 → Spider Man 日期/时钟糊成一片）。
  it('text 隔离 RT 以布局像素为源分辨率下限（小视口下不按屏占位降采样）', async () => {
    stubAssetFetch(sceneWithText({
      scale: '1 1 1',
      effects: [{ file: 'effects/w/effect.json' }],
      text: { value: '12:34' },
    }), FX_FILES);
    stubTextRender();
    const chainsSpy = vi.spyOn(ObjectEffectStage.prototype, 'setObjectChains').mockImplementation(() => {});
    // 正交 1920×1080 + 视口 480×270 ⇒ 屏幕密度 0.25；世界 120×49 的屏占位仅 30×12。
    const oldW = window.innerWidth;
    const oldH = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 480 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 270 });
    try {
      const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
      expect(await r.render('2851992662', document.createElement('canvas'))).toBe(true);
      const assets = vi.mocked(loadSceneToThree).mock.calls[0][1] as {
        isolate: Map<number, unknown>;
      };
      // 布局 canvas 120×49 长边 120 > 屏占位长边 30 ⇒ RT 升到 120×49（与布局 1:1，不糊）。
      expect(assets.isolate.get(5)).toEqual({
        objectId: 5, rtWidth: 120, rtHeight: 49, worldW: 120, worldH: 49,
      });
      chainsSpy.mockRestore();
      r.dispose!();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: oldW });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: oldH });
    }
  });

  it('visible=false 的 text 被过滤（不下发）——否则会画出本应隐藏的时钟', async () => {
    stubAssetFetch(sceneWithText({ visible: false, text: { value: '12:34', script: CLOCK_SCRIPT } }), {});
    stubTextRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('2851992662', document.createElement('canvas'), null);

    const assets = loadSceneToThree.mock.calls[0][1] as { textLayers: Map<number, unknown> };
    expect(assets.textLayers.size).toBe(0);
    expect(ctx2d.fillText).not.toHaveBeenCalled();
    r.dispose();
  });

  it('visible 用户绑定 → 按 localStorage 用户属性决定（键缺失回退绑定默认值）', async () => {
    stubAssetFetch(sceneWithText({ visible: { user: 'clock', value: false }, text: { value: '12:34' } }), {});
    stubTextRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });

    await r.render('2851992662', document.createElement('canvas'), null);
    expect((loadSceneToThree.mock.calls[0][1] as { textLayers: Map<number, unknown> }).textLayers.size).toBe(0);

    localStorage.setItem('we:userprop:clock', 'true');
    await r.render('2851992662', document.createElement('canvas'), null);
    expect((loadSceneToThree.mock.calls[1][1] as { textLayers: Map<number, unknown> }).textLayers.size).toBe(1);

    localStorage.clear();
    r.dispose();
  });

  // Task 3 修复：装配期 effective 可见性（对象形态 condition + 父链继承）必须随 SceneAssets 下发，
  // 否则 player 会拿空 userProps 二次重判，覆盖掉 condition/父链结果。
  it('对象形态 condition + 父链 → effectiveVisible 下发，textLayers/纹理按同一份结果过滤', async () => {
    stubAssetFetch(JSON.stringify({
      general: { orthogonalprojection: { width: 1920, height: 1080 } },
      objects: [
        { id: 192, origin: '960 540 0', scale: '1 1 1', size: '400 100', text: { value: 'A' },
          visible: { user: { name: 'clock', condition: '1' }, value: true } },
        { id: 199, parent: 192, image: 'models/a.json', origin: '960 540 0', scale: '1 1 1', size: '100 100' },
        { id: 227, origin: '960 540 0', scale: '1 1 1', size: '400 100', text: { value: 'B' },
          visible: { user: { name: 'clock', condition: '2' }, value: false } },
        { id: 234, parent: 227, image: 'models/b.json', origin: '960 540 0', scale: '1 1 1', size: '100 100' },
      ],
    }), {});
    stubTextRender();
    vi.mocked(resolveImageAssets).mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null, spriteSheet: false });
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });

    localStorage.setItem('we:userprop:clock', '"2"');
    await r.render('3812518176', document.createElement('canvas'), undefined);
    let assets = vi.mocked(loadSceneToThree).mock.calls[0][1] as {
      effectiveVisible?: Map<number, boolean>;
      textLayers: Map<number, unknown>;
      backgroundTextures: Map<number, unknown>;
    };
    // 227 的 condition 命中（作者 value:false 不影响）；192 分支及其子 199 沿父链隐藏。
    expect(assets.effectiveVisible?.get(192)).toBe(false);
    expect(assets.effectiveVisible?.get(199)).toBe(false);
    expect(assets.effectiveVisible?.get(227)).toBe(true);
    expect(assets.effectiveVisible?.get(234)).toBe(true);
    expect([...assets.textLayers.keys()]).toEqual([227]);
    expect([...assets.backgroundTextures.keys()]).toEqual([234]);

    localStorage.setItem('we:userprop:clock', '"1"');
    await r.render('3812518176', document.createElement('canvas'), undefined);
    assets = vi.mocked(loadSceneToThree).mock.calls[1][1] as typeof assets;
    expect([...assets.textLayers.keys()]).toEqual([192]);
    expect([...assets.backgroundTextures.keys()]).toEqual([199]);

    localStorage.clear();
    r.dispose?.();
  });

  // 字体加载（2026-10-10）：`systemfont_<family>` 是 WE 的**宿主系统字体别名**，永远不会在 pkg /
  // 引擎 assets 目录里，且必须按 basename 判 —— scene.json 里存在 `fonts/systemfont_arial` 这种
  // 带目录前缀的写法（OWE SceneTextObjectParser.cpp:290-292 同判据）。此前它被当成字体文件路径 ⇒
  // 加载失败 ⇒ 落 sans-serif（正确结果是 Arial）。
  // 真身字体路径（`fonts/X.ttf`）走另一条分支：有 FontFace 时请求 + 注册家族名，无 FontFace
  // （jsdom/node）时静默返回 undefined、由调用方回退 —— 本用例只钉住「两条分支的选择」，
  // 不假设运行环境有没有 FontFace。
  it('字体：systemfont_*（含 fonts/ 前缀）解析为系统家族且不请求网络；真身字体路径不误判', async () => {
    const fontUrls = () => (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('name=font'));

    // ① 带目录前缀的系统字体别名：解析出的 CSS 家族应是 Arial，且**不**把它当字体文件去请求
    stubAssetFetch(sceneWithText({ font: 'fonts/systemfont_arial', text: { value: 'HELLO' } }), {});
    stubTextRender();
    const r1 = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r1.render('2851992662', document.createElement('canvas'), null);
    expect(fontUrls()).toEqual([]);
    expect(ctx2d.font).toContain('Arial');

    // ② 真身字体名（`fonts/X.ttf`）绝不能被解析成系统家族（它是文件路径）
    stubAssetFetch(sceneWithText({ font: 'fonts/CursedTimerUlil-Aznm.ttf', text: { value: 'HELLO' } }), {});
    const r2 = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r2.render('2851992662', document.createElement('canvas'), null);
    expect(ctx2d.font).toBe('48px sans-serif'); // 无 FontFace 环境的回退口径

    r1.dispose();
    r2.dispose();
  });

  it('非 clock 文本 → 有纹理、无驱动（静态文本不动）', async () => {    stubAssetFetch(sceneWithText({ text: { value: 'HELLO' } }), {});
    stubTextRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('2851992662', document.createElement('canvas'), null);

    const assets = loadSceneToThree.mock.calls[0][1] as { textLayers: Map<number, { driver?: unknown }> };
    expect(assets.textLayers.get(5)!.driver).toBeUndefined();
    // 无 pointsize/padding/alignment → WE 默认 pointsize 12（48px）、画布 = 实测文本（120×48）、
    // 缺省 halign=center → 行起点 = 画布中心 60，基线 = ascent 0.8em。
    expect(ctx2d.fillText).toHaveBeenCalledWith('HELLO', 60, 0.8 * 48);
    r.dispose();
  });

  // SceneTextObjectParser 第 434-481 行：图层尺寸 = measureText 实测文本 + 2×padding（不是
  // scene.json 的 size），文本按 horizontalalign/verticalalign 定锚点（origin 是锚点）。
  it('pointsize/padding/horizontalalign/verticalalign → 画布尺寸与锚点偏移下发', async () => {
    stubAssetFetch(sceneWithText({
      text: 'const', pointsize: '32', padding: '32', scale: '0.05 0.05 0.05',
      horizontalalign: 'left', verticalalign: 'bottom', size: '365 156',
    }), {});
    stubTextRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('2851992662', document.createElement('canvas'), null);

    const assets = loadSceneToThree.mock.calls[0][1] as {
      textLayers: Map<number, { size?: [number, number]; anchorOffset?: [number, number] }>;
    };
    const layer = assets.textLayers.get(5)!;
    // 128px 字体下 'const' 宽 = 5 × 0.5em × 128 = 320；高 = 128 → 画布 = 320+64 × 128+64
    expect(layer.size).toEqual([384, 192]);
    // left/bottom：中心 = origin + (textWidth/2, textHeight/2) × scale（不含 padding）
    expect(layer.anchorOffset).toEqual([(320 / 2) * 0.05, (128 / 2) * 0.05]);
    expect(ctx2d.fillText).toHaveBeenCalledWith('const', 32, 32 + 0.8 * 128);
    r.dispose();
  });

  // 2026-09-21 用户实测反馈：CodeTime（2980088441）把作者的占位值画到屏幕上（"12"/hour:minute:…/
  // "Year"），整张壁纸只剩脏字。脚本不可用（bind 失败 / 运行时拿不到）时 text.value 不代表真实
  // 内容，宁可不画。
  it('带脚本但非 clock 且脚本 bind 失败 → 跳过，不显示作者占位值', async () => {
    stubAssetFetch(sceneWithText({
      text: {
        value: '"12"',
        script: "export function update(value) { let clock = new Date(); value.x = clock.getFullYear(); return value; }",
      },
    }), {});
    stubTextRender();
    const r = createThreeSceneRenderer({
      loadWasm: defaultLoadWasm,
      getTextScriptRuntime: async () => ({ bind: () => null, dispose: vi.fn() }),
    });
    await r.render('2851992662', document.createElement('canvas'), null);

    const assets = loadSceneToThree.mock.calls[0][1] as { textLayers: Map<number, unknown> };
    expect(assets.textLayers.size).toBe(0);
    expect(ctx2d.fillText).not.toHaveBeenCalled();
    r.dispose();
  });

  // Task 4：三个优先序 + 泄漏口径（spec §3.2/§3.3）。
  it('脚本 bind 成功 → 脚本驱动优先（clock 形态也走脚本），初始文本来自脚本首帧', async () => {
    const update = vi.fn(() => 'SCRIPTED');
    const bind = vi.fn(() => ({ update, dispose: vi.fn() }));
    stubAssetFetch(sceneWithText({ text: { value: '12:34', script: CLOCK_SCRIPT } }), {});
    stubTextRender();
    const r = createThreeSceneRenderer({
      loadWasm: defaultLoadWasm,
      getTextScriptRuntime: async () => ({ bind, dispose: vi.fn() }),
    });
    await r.render('2851992662', document.createElement('canvas'), null);

    const assets = loadSceneToThree.mock.calls[0][1] as {
      textLayers: Map<number, { texture: unknown; driver?: { update(now: Date): boolean } }>;
    };
    expect(bind).toHaveBeenCalledTimes(1);
    expect(ctx2d.fillText.mock.calls[0][0]).toBe('SCRIPTED'); // 初始文本来自脚本，不是 clock 格式
    expect(assets.textLayers.get(5)!.driver).toBeTruthy();
    r.dispose();
  });

  it('脚本 bind 失败 + 识别为 clock → 回退既有 clock 驱动', async () => {
    stubAssetFetch(sceneWithText({ text: { value: '12:34', script: CLOCK_SCRIPT } }), {});
    stubTextRender();
    const r = createThreeSceneRenderer({
      loadWasm: defaultLoadWasm,
      getTextScriptRuntime: async () => ({ bind: () => null, dispose: vi.fn() }),
    });
    await r.render('2851992662', document.createElement('canvas'), null);

    // clock 分支产出的是时钟格式（HH:MM + 日期），不是 text.value 占位串
    expect(String(ctx2d.fillText.mock.calls[0][0])).toMatch(/\d{2}:\d{2}/);
    const assets = loadSceneToThree.mock.calls[0][1] as { textLayers: Map<number, { driver?: unknown }> };
    expect(assets.textLayers.get(5)!.driver).toBeTruthy();
    r.dispose();
  });

  it('没有 text 脚本的壁纸 → 不实例化脚本运行时（不付 wasm 成本）', async () => {
    stubAssetFetch(sceneWithText({ text: { value: 'HELLO' } }), {});
    stubTextRender();
    const getRuntime = vi.fn(async () => null);
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm, getTextScriptRuntime: getRuntime });
    await r.render('2851992662', document.createElement('canvas'), null);

    expect(getRuntime).not.toHaveBeenCalled();
    r.dispose();
  });

  it('dispose 释放脚本绑定（切壁纸不留 handle）', async () => {
    const disposeBinding = vi.fn();
    stubAssetFetch(sceneWithText({ text: { value: '12:34', script: CLOCK_SCRIPT } }), {});
    stubTextRender();
    const r = createThreeSceneRenderer({
      loadWasm: defaultLoadWasm,
      getTextScriptRuntime: async () => ({ bind: () => ({ update: () => 'x', dispose: disposeBinding }), dispose: vi.fn() }),
    });
    await r.render('2851992662', document.createElement('canvas'), null);
    r.dispose();

    expect(disposeBinding).toHaveBeenCalledTimes(1);
  });
});

// 场景树层级（parent）：组装前先把对象变换折叠成**世界值**再下发。
// 计划里用的 `scriptPlayer()` helper 本轮不在作用域（该 text describe 用的是局部
// `stubTextRender()`），按本文件既有风格补一个等价 helper。
describe('three-renderer 场景树层级（parent → 世界变换）', () => {
  function scriptPlayer() {
    return {
      dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(), setObjectEffectStage: vi.fn(),
      isolatedObjects: () => [],
    };
  }

  it('parent 层级：组装折叠出世界变换（3798688689 的 solidlayer 世界宽 = 2560）', async () => {
    const scene = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 2560, height: 1440 } },
      objects: [
        { id: 1, name: 'root', origin: '1280 720 0', scale: '1.64103 1.64103 1' },
        { id: 1003, parent: 1, name: 'matte', origin: '0 0 0', scale: '1 1 1' },
        { id: 10030, parent: 1003, name: 'solid', image: 'models/layers/l_10030.json', size: '100 100', scale: '15.6 9.6 1' },
      ],
    });
    stubAssetFetch(scene, {});
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null });
    loadSceneToThree.mockReturnValue({ player: scriptPlayer(), sims: [], backgroundIds: [0, 1], particleLayers: [], puppetLayers: [], } as never);

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm, getTextScriptRuntime: async () => null });
    await r.render('3798688689', document.createElement('canvas'), null);

    const t = lastWorldTransformOf(10030)!;
    expect(t.scale[0]).toBeCloseTo(25.6001, 3);        // 1.64103 × 15.6
    expect(t.origin[0]).toBeCloseTo(1280, 3);
    expect(100 * t.scale[0]).toBeCloseTo(2560, 0);     // 世界宽 = 场景宽
    // 链上每个节点都要有世界值
    expect(lastWorldTransformOf(1)!.scale).toEqual([1.64103, 1.64103, 1]);
    expect(lastWorldTransformOf(1003)!.origin).toEqual([1280, 720, 0]);
    // 世界变换表随 assets 一起下发给真实装配路径（loadSceneToThree）
    const assets = loadSceneToThree.mock.calls[0][1] as {
      worldTransforms?: Map<number, { origin: [number, number, number]; scale: [number, number, number] }>;
    };
    expect(assets.worldTransforms!.get(10030)!.scale[0]).toBeCloseTo(25.6001, 3);
    r.dispose();
  });

  it('无 parent 的对象：接线后世界值逐字段等于局部值（零回归）', async () => {
    const scene = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 1920, height: 1080 } },
      objects: [{ id: 9, name: 'flat', image: 'models/layers/l_9.json', origin: '100 200 0', scale: '2 3 1', size: '10 10' }],
    });
    stubAssetFetch(scene, {});
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null });
    loadSceneToThree.mockReturnValue({ player: scriptPlayer(), sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], } as never);

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm, getTextScriptRuntime: async () => null });
    await r.render('3743126786', document.createElement('canvas'), null);
    expect(lastWorldTransformOf(9)).toEqual({ origin: [100, 200, 0], scale: [2, 3, 1], angles: [0, 0, 0] });
    const assets = loadSceneToThree.mock.calls[0][1] as {
      worldTransforms?: Map<number, { origin: [number, number, number] }>;
    };
    expect(assets.worldTransforms!.get(9)!.origin).toEqual([100, 200, 0]);
    r.dispose();
  });

  it('隔离对象的世界尺寸随父链 scale（RT 尺寸基准 = 世界尺寸 × 屏幕密度）', async () => {
    const OBJ_ID = 10030;
    const scene = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 2560, height: 1440 } },
      objects: [
        { id: 1, name: 'root', origin: '1280 720 0', scale: '1.64103 1.64103 1' },
        { id: 1003, parent: 1, name: 'matte', origin: '0 0 0', scale: '1 1 1' },
        {
          id: OBJ_ID, parent: 1003, name: 'solid', image: 'models/layers/l_10030.json',
          size: '100 100', scale: '15.6 9.6 1', effects: [{ file: 'effects/w/effect.json' }],
        },
      ],
    });
    stubAssetFetch(scene, FX_FILES);
    resolveImageAssets.mockResolvedValue({ texture: new THREE.DataTexture(new Uint8Array(4), 1, 1) as never, puppetPath: null });
    loadSceneToThree.mockReturnValue({ player: scriptPlayer(), sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], } as never);

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm, getTextScriptRuntime: async () => null });
    await r.render('3798688689', document.createElement('canvas'), null);

    const assets = loadSceneToThree.mock.calls[0][1] as {
      isolate?: Map<number, { worldW: number; worldH: number }>;
    };
    // 世界尺寸 = |size × 世界 scale| = 100 × 25.6001 ≈ 2560（场景宽），不再是局部 scale 的 100×15.6
    expect(assets.isolate!.get(OBJ_ID)!.worldW).toBeCloseTo(2560.01, 1);
    expect(assets.isolate!.get(OBJ_ID)!.worldH).toBeCloseTo(1575.39, 1);
    r.dispose();
  });
});

// SceneScript 运行时（2026-09-22）：脚本收集必须按 objects 顺序、且**不遗漏**「无媒体字段」的
// 纯控制器对象 —— 3798688689 的 3 个总控（92000/93000/94000）正是这一类，漏掉它们画面就不动。
describe('collectScriptSources', () => {
  it('按 objects 顺序收集 util / image / 兜底分支的脚本', () => {
    const desc = parseSceneJson(JSON.stringify({
      general: { orthogonalprojection: { width: 100, height: 100 } },
      objects: [
        { id: 92000, name: '粒子控制器', visible: { script: 'export function update(){}', value: true } },
        { id: 94001, name: '切换按钮', image: 'models/util/solidlayer.json', visible: { script: 'export function cursorClick(){}', value: true } },
        { id: 221582, name: '字标', image: 'models/layers/l_1.json', visible: { script: 'export function update(){}', value: true } },
        { id: 5, name: '无脚本', image: 'models/layers/l_2.json' },
        { id: 6, name: '布尔 visible', image: 'models/layers/l_3.json', visible: false },
      ],
    }));
    expect(collectScriptSources(desc).map((s) => s.objectId)).toEqual([92000, 94001, 221582]);
  });

  it('空描述返回空数组；空串脚本跳过', () => {
    const desc = parseSceneJson(JSON.stringify({ objects: [{ id: 1, visible: { script: '', value: true } }] }));
    expect(collectScriptSources(desc)).toEqual([]);
  });

  it('text 对象的 text.script 不被收集（归既有 text-script.ts 运行时）', () => {
    const desc = parseSceneJson(JSON.stringify({
      objects: [{
        id: 701, name: 'Time2',
        text: { value: 'Time', script: "export var scriptProperties = createScriptProperties();\nexport function update(v){return v;}" },
        visible: { user: 'time', value: true },
      }],
    }));
    expect(collectScriptSources(desc)).toEqual([]);
  });

  // 对象级脚本入口（2026-10-20）：3765967112 的 angles.script 是唯一脚本来源（无 visible.script）。
  it('转换字段的 objectScript 被收集（含 scriptProperties）；visible.script 优先', () => {
    const desc = parseSceneJson(JSON.stringify({
      objects: [
        {
          id: 123, name: 'Day/Night', image: 'models/x.json',
          angles: {
            script: 'export function init(){ thisLayer.getTextureAnimation().pause(); }',
            scriptproperties: { dayStart: 0, nightStart: 12 },
            value: '0 0 0',
          },
        },
        {
          id: 5, name: 'both', image: 'models/y.json',
          visible: { script: 'export function update(){return true;}', value: true },
          angles: { script: 'export function init(){}', value: '0 0 0' },
        },
      ],
    }));
    const srcs = collectScriptSources(desc);
    expect(srcs.map((s) => s.objectId)).toEqual([123, 5]);
    expect(srcs[0]!.source).toContain('getTextureAnimation');
    expect(srcs[0]!.scriptProperties).toEqual({ dayStart: 0, nightStart: 12 });
    expect(srcs[0]!.property).toBe('angles'); // 属性脚本：update(value) 收/回 Vec3
    expect(srcs[1]!.source).toContain('return true');
    expect(srcs[1]!.scriptProperties).toBeUndefined();
    expect(srcs[1]!.property).toBeUndefined(); // visible.script 不带属性（布尔语义）
  });
});

// image / particle 的 visible 过滤（2026-09-25）：此前**只对 text** 应用，全库实测 134 个
// 隐藏的 image/particle 里 125 个是布尔 false（3798688689 一张就 121 个）⇒ 会画出本应隐藏的图层。
// 裁定：**布尔 / 用户属性**绑定在装载期静态过滤；**script 绑定一律保留** —— 其可见性是
// visible.script 的运行期通道（applyLayerState），装载期剔掉会让脚本永远无法打开它。
describe('three-renderer image/particle 的 visible 过滤', () => {
  const sceneWith = (objects: Record<string, unknown>[]) => JSON.stringify({
    camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
    general: { orthogonalprojection: { width: 1920, height: 1080 } },
    objects,
  });
  const IMG = (id: number, name: string, visible: unknown) => ({
    id, name, image: `models/${name}.json`, origin: '960 540 0', scale: '1 1 1', size: '400 400', visible,
  });
  const PART = (id: number, visible: unknown) => ({
    id, name: `p${id}`, particle: 'particles/p.json', origin: '960 540 0', scale: '1 1 1', visible,
  });
  const PARTICLE_SPEC = JSON.stringify({ emitter: [], maxcount: 8 });

  function stubRender() {
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(), setObjectEffectStage: vi.fn(),
      isolatedObjects: () => [],
    };
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], } as never);
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as any, puppetPath: null });
    const sim = makeMockSim();
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => sim) } } as any);
    return player;
  }

  it('布尔 false 的 image/particle 不下发（不解析纹理）；true 照常下发', async () => {
    stubAssetFetch(sceneWith([
      IMG(13, 'a', true), IMG(14, 'b', false),
      PART(71, true), PART(72, false),
    ]), { 'particles/p.json': PARTICLE_SPEC });
    stubRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('3798688689', document.createElement('canvas'), null);

    const assets = loadSceneToThree.mock.calls[0][1];
    expect(assets.backgroundTextures.has(13)).toBe(true);
    expect(assets.backgroundTextures.has(14)).toBe(false);
    expect(assets.particles.has(71)).toBe(true);
    expect(assets.particles.has(72)).toBe(false);
    // 隐藏对象连纹理都不该解析（少了这一步会白拉一次 .tex + 上传 GPU）
    expect(resolveImageAssets).toHaveBeenCalledTimes(1);
    expect(resolveImageAssets.mock.calls[0][1].id).toBe(13);
    r.dispose();
  });

  it('script 绑定的 image 即使 value=false 仍下发（可见性归 visible.script 运行期通道）', async () => {
    // 与布尔 false 混排：证明过滤「按绑定形态分流」，而不是把 value=false 一律剔掉。
    stubAssetFetch(sceneWith([
      IMG(14, 'b', false),
      IMG(15, 'c', { script: 'export function update(v){ return v; }', value: false }),
    ]), {});
    stubRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('3798688689', document.createElement('canvas'), null);

    const assets = loadSceneToThree.mock.calls[0][1];
    expect(assets.backgroundTextures.has(14)).toBe(false);
    expect(assets.backgroundTextures.has(15)).toBe(true);
    r.dispose();
  });

  it('user 绑定的 image 按用户属性决定（键缺失回退 value；用户开启后下发）', async () => {
    stubAssetFetch(sceneWith([IMG(16, 'd', { user: 'layer', value: false })]), {});
    stubRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('3798688689', document.createElement('canvas'), null);
    expect((loadSceneToThree.mock.calls[0][1] as { backgroundTextures: Map<number, unknown> }).backgroundTextures.has(16)).toBe(false);

    localStorage.setItem('we:userprop:layer', 'true');
    await r.render('3798688689', document.createElement('canvas'), null);
    expect((loadSceneToThree.mock.calls[1][1] as { backgroundTextures: Map<number, unknown> }).backgroundTextures.has(16)).toBe(true);

    localStorage.clear();
    r.dispose();
  });

  it('被静态隐藏的对象不进 isolate 表（不建隔离条目），可见对象照旧隔离', async () => {
    const withFx = (id: number, name: string, visible: unknown) => ({
      ...IMG(id, name, visible), effects: [{ file: 'effects/w/effect.json' }],
    });
    stubAssetFetch(sceneWith([withFx(13, 'a', true), withFx(14, 'b', false)]), FX_FILES);
    stubRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('3798688689', document.createElement('canvas'), null);

    const assets = loadSceneToThree.mock.calls[0][1] as { isolate?: Map<number, unknown> };
    expect(assets.isolate?.has(13)).toBe(true);
    // 隐藏对象若仍隔离，player 会给它建隔离条目 + 合成 quad ⇒ 本应隐藏的层又画回来
    expect(assets.isolate?.has(14) ?? false).toBe(false);
    r.dispose();
  });

  it('被静态隐藏的对象的 effects 不解析（省掉一次 effect.json 请求）', async () => {
    stubAssetFetch(sceneWith([
      { ...IMG(13, 'a', true), effects: [{ file: 'effects/w/effect.json' }] },
      { ...IMG(14, 'b', false), effects: [{ file: 'effects/hidden/effect.json' }] },
    ]), {
      ...FX_FILES,
      'effects/hidden/effect.json': JSON.stringify({ passes: [{ material: 'materials/effects/w.json' }] }),
    });
    stubRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('3798688689', document.createElement('canvas'), null);

    const urls = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls
      .map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('effects%2Fw%2Feffect.json'))).toBe(true);
    expect(urls.some((u) => u.includes('effects%2Fhidden'))).toBe(false);
    r.dispose();
  });
});

// 音频链路（A3，2026-09-25）：壁纸 sound 对象 → playWallpaperSound（出声）+ 每帧频谱 →
// EffectRunner（`Simple_Audio_Bars` / `audioline` 等随频谱动）。装配期创建分析器，帧内 update()；
// 开关（soundEnabled）关掉时**不创建 AudioContext**，切壁纸时 close 释放。
describe('three-renderer 音频链路', () => {
  const sceneWithSound = (objects: Record<string, unknown>[]) => JSON.stringify({
    camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
    general: { orthogonalprojection: { width: 1920, height: 1080 } },
    objects: [
      { id: 13, name: 'bg', image: 'models/a.json', origin: '960 540 0', scale: '1 1 1', size: '1920 1080', visible: true },
      { id: 35, name: 'audio', sound: ['sounds/a.flac'] },
      { id: 36, name: 'audio2', sound: ['sounds/b.ogg'] },
      ...objects,
    ],
  });

  function fakeAnalyzer() {
    return {
      context: { close: vi.fn(async () => {}), state: 'running', resume: vi.fn(async () => {}) },
      analyser: { connect: vi.fn() },
      freqData: new Uint8Array(64),
      update: vi.fn(),
    };
  }

  function stubPlayer() {
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(), setObjectEffectStage: vi.fn(),
      isolatedObjects: () => [],
    };
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], } as never);
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as any, puppetPath: null });
    return player;
  }

  beforeEach(() => {
    audioMocks.createAudioAnalyzer.mockReset();
    audioMocks.playWallpaperSound.mockReset();
    audioMocks.playWallpaperSound.mockResolvedValue(true);
  });

  it('装配期：desc.sounds → 逐个 playWallpaperSound（走 scene asset 路由，接同一分析器）', async () => {
    const fake = fakeAnalyzer();
    audioMocks.createAudioAnalyzer.mockReturnValue(fake);
    stubAssetFetch(sceneWithSound([]), {});
    stubPlayer();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('3798688689', document.createElement('canvas'), null);

    expect(createAudioAnalyzer).toHaveBeenCalledTimes(1);
    expect(playWallpaperSound).toHaveBeenCalledTimes(2);
    const urls = playWallpaperSound.mock.calls.map((c) => decodeURIComponent(String(c[0])));
    expect(urls[0]).toContain('/wallpapers/scene/3798688689/asset?name=sounds/a.flac');
    expect(urls[1]).toContain('/wallpapers/scene/3798688689/asset?name=sounds/b.ogg');
    expect(playWallpaperSound.mock.calls[0][1]).toBe(fake);
    r.dispose();
  });

  // A3 [Important]：SceneSoundObject 三态映射——loop 取 files[0] 循环；random / single 随机选一首，
  // 但 single 不循环。断言第 3 参 {volume, loop} 与选曲 URL（random/single 用固定随机数）。
  it('playbackmode 三态：loop 首曲循环、random 随机循环、single 随机一首不循环', async () => {
    const fake = fakeAnalyzer();
    audioMocks.createAudioAnalyzer.mockReturnValue(fake);
    stubAssetFetch(JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 1920, height: 1080 } },
      objects: [
        { id: 41, name: 'loop', sound: ['sounds/l1.flac', 'sounds/l2.flac'], playbackmode: 'loop', volume: 0.5 },
        { id: 42, name: 'random', sound: ['sounds/r1.flac', 'sounds/r2.flac'], playbackmode: 'random' },
        { id: 43, name: 'single', sound: ['sounds/s1.flac', 'sounds/s2.flac'], playbackmode: 'single', volume: 0.25 },
      ],
    }), {});
    stubPlayer();
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.75); // 0.75×2 → 第 2 首
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('3798688689', document.createElement('canvas'));
    rand.mockRestore();

    expect(playWallpaperSound).toHaveBeenCalledTimes(3);
    const got = vi.mocked(playWallpaperSound).mock.calls.map((c) => ({
      url: decodeURIComponent(String(c[0])),
      opts: c[2] as { volume: number; loop: boolean },
    }));
    expect(got[0].url).toContain('sounds/l1.flac'); // loop：永远首曲
    expect(got[0].opts).toEqual({ volume: 0.5, loop: true });
    expect(got[1].url).toContain('sounds/r2.flac'); // random：随机一首
    expect(got[1].opts).toEqual({ volume: 1, loop: true });
    expect(got[2].url).toContain('sounds/s2.flac'); // single：随机一首
    expect(got[2].opts).toEqual({ volume: 0.25, loop: false });
    r.dispose?.();
  });

  it('soundEnabled=false → 不创建分析器、不播放（零 AudioContext 开销）', async () => {
    stubSettings({ glowEnabled: false, soundEnabled: false });
    audioMocks.createAudioAnalyzer.mockReturnValue(fakeAnalyzer());
    stubAssetFetch(sceneWithSound([]), {});
    stubPlayer();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('3798688689', document.createElement('canvas'), null);

    expect(createAudioAnalyzer).not.toHaveBeenCalled();
    expect(playWallpaperSound).not.toHaveBeenCalled();
    r.dispose();
  });

  it('无 sound 的壁纸 → 不创建分析器（不白开 AudioContext）', async () => {
    audioMocks.createAudioAnalyzer.mockReturnValue(fakeAnalyzer());
    stubAssetFetch(JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 1920, height: 1080 } },
      objects: [{ id: 13, name: 'bg', image: 'models/a.json', origin: '960 540 0', scale: '1 1 1', size: '1920 1080' }],
    }), {});
    stubPlayer();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('3743126786', document.createElement('canvas'), null);

    expect(createAudioAnalyzer).not.toHaveBeenCalled();
    r.dispose();
  });

  it('切壁纸（teardown）→ close 释放 AudioContext，不泄漏', async () => {
    const fake = fakeAnalyzer();
    audioMocks.createAudioAnalyzer.mockReturnValue(fake);
    stubAssetFetch(sceneWithSound([]), {});
    stubPlayer();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('3798688689', document.createElement('canvas'), null);
    expect(fake.context.close).not.toHaveBeenCalled();

    await r.render('3798688689', document.createElement('canvas'), null); // 第二次 render 先 teardown 上一次
    expect(fake.context.close).toHaveBeenCalledTimes(1);
    r.dispose();
  });

  it('帧内：onFrame 刷新频谱（analyzer.update()）', async () => {
    const fake = fakeAnalyzer();
    audioMocks.createAudioAnalyzer.mockReturnValue(fake);
    stubAssetFetch(sceneWithSound([]), {});
    stubPlayer();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('3798688689', document.createElement('canvas'), null);

    const onFrame = (loadSceneToThree.mock.calls[0][1] as { onFrame?: (dt: number) => void }).onFrame;
    expect(typeof onFrame).toBe('function');
    onFrame!(0.016);
    expect(fake.update).toHaveBeenCalledTimes(1);
    r.dispose();
  });

  it('运行期开关：关 → 停声并释放 AudioContext；再开 → 重新创建并播放', async () => {
    const fake1 = fakeAnalyzer();
    audioMocks.createAudioAnalyzer.mockReturnValue(fake1);
    stubAssetFetch(sceneWithSound([]), {});
    stubPlayer();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('3798688689', document.createElement('canvas'), null);
    expect(fake1.context.close).not.toHaveBeenCalled();

    r.setSoundEnabled?.(false);
    expect(fake1.context.close).toHaveBeenCalledTimes(1);
    expect(audioMocks.playWallpaperSound).toHaveBeenCalledTimes(2); // 关闭不额外播放

    const fake2 = fakeAnalyzer();
    audioMocks.createAudioAnalyzer.mockReturnValue(fake2);
    r.setSoundEnabled?.(true);
    expect(createAudioAnalyzer).toHaveBeenCalledTimes(2);
    expect(audioMocks.playWallpaperSound).toHaveBeenCalledTimes(4); // 两条 sound 重新播放
    r.dispose();
  });
});

// WebGL 上下文丢失（显存耗尽/驱动重置）回退（Task 8，护栏项）：隔离对象 RT 变大后显存压力上升，
// 而现状下 context lost 就是**一块空白背景**（比「糊」严重得多）⇒ 渲染器必须停播并回调一次，
// 由控制器换成该壁纸的 preview。三点契约：preventDefault、只触发一次、teardown 移除监听。
describe('createThreeSceneRenderer webglcontextlost 回退 preview 接线', () => {
  const LOST_SCENE = JSON.stringify({
    camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
    general: { orthogonalprojection: { height: 1080, width: 1920 } },
    objects: [{
      id: 13, name: 'bg', image: 'models/a.json',
      origin: '960 540 0', scale: '1 1 1', size: '1920 1080',
    }],
  });

  // 造一张会丢上下文的画布：dispose 原实现没动过 → 监听必然残留，故必须在该处显式移除。
  function lostCanvas(): { canvas: HTMLCanvasElement; tex: { dispose: ReturnType<typeof vi.fn> } } {
    const tex = { dispose: vi.fn() };
    resolveImageAssets.mockResolvedValue({ texture: tex as never, puppetPath: null });
    resolveParticleMaterial.mockResolvedValue(null);
    defaultLoadWasm.mockResolvedValue(null);
    stubAssetFetch(LOST_SCENE, {});
    loadSceneToThree.mockReturnValue({
      player: { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn() },
      sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [],
    } as never);
    return { canvas: document.createElement('canvas'), tex };
  }

  it('webglcontextlost ⇒ preventDefault + 回调一次（带壁纸 id），再派发不重复触发', async () => {
    const { canvas, tex } = lostCanvas();
    const seen: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    r.setOnContextLost?.((id) => seen.push(id));
    await r.render('1922570576', canvas, null);

    const evt = new Event('webglcontextlost', { cancelable: true });
    canvas.dispatchEvent(evt);
    // 不 preventDefault，浏览器就不会保留上下文状态、也不会给 restore 机会。
    expect(evt.defaultPrevented).toBe(true);
    expect(seen).toEqual(['1922570576']);
    // 停掉当前播放器 + 释放本次装配资源（复用既有 teardown），并留一条可辨识告警。
    expect((loadSceneToThree.mock.results.at(-1)!.value as any).player.dispose).toHaveBeenCalled();
    expect(tex.dispose).toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('1922570576'))).toBe(true);

    // 一次性语义：同一 canvas（真实浏览器同一丢失事件可能被重复派发）不得二次回退。
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(seen).toEqual(['1922570576']);
    warn.mockRestore();
    r.dispose();
  });

  it('未注册回调 / 传入 null ⇒ 上下文丢失仍安全（preventDefault + 停播，不抛）', async () => {
    const { canvas } = lostCanvas();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    r.setOnContextLost?.(null);
    await r.render('1922570576', canvas, null);

    const evt = new Event('webglcontextlost', { cancelable: true });
    expect(() => canvas.dispatchEvent(evt)).not.toThrow();
    expect(evt.defaultPrevented).toBe(true);
    warn.mockRestore();
    r.dispose();
  });

  it('dispose 移除监听 ⇒ 之后的上下文丢失不再回调（不跨壁纸残留）', async () => {
    const { canvas } = lostCanvas();
    const seen: string[] = [];
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    r.setOnContextLost?.((id) => seen.push(id));
    await r.render('1922570576', canvas, null);

    r.dispose();
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(seen).toEqual([]);
  });

  it('切壁纸（render 先 teardown）⇒ 旧 canvas 的监听被移除，新 canvas 的丢失只回调一次', async () => {
    const seen: string[] = [];
    // 回退路径自身也打一条 warn（壁纸 id）：spy 收口，保持测试输出干净（只断言路径归属）。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    r.setOnContextLost?.((id) => seen.push(id));
    const first = lostCanvas();
    await r.render('1922570576', first.canvas, null);
    const second = lostCanvas();
    await r.render('2851992662', second.canvas, null);

    // 旧 canvas 的丢失事件不属于当前壁纸：其监听已随 teardown 移除，不得触发回退。
    first.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(seen).toEqual([]);
    second.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(seen).toEqual(['2851992662']);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('2851992662'))).toBe(true);
    warn.mockRestore();
    r.dispose();
  });

  it('render 进行中丢失上下文 ⇒ 本次装配作废（返回 false、不安装 player、只回调一次）', async () => {
    const { canvas } = lostCanvas();
    // 把「贴图解析」这个 await 卡住：先发起 render，再派发丢失事件，最后放行 —— 复现
    // 「丢失发生在 render 的 await 期间，而那次 render 恢复后仍装好 player 并返回 true」。
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let entered!: () => void;
    const atAwait = new Promise<void>((res) => { entered = res; });
    resolveImageAssets.mockImplementation(async () => {
      entered();
      await gate;
      return { texture: fakeTexture() as never, puppetPath: null };
    });
    const seen: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    r.setOnContextLost?.((id) => seen.push(id));

    const pending = r.render('1922570576', canvas, null);
    await atAwait; // 此刻 render 挂在 await 上（仅剩放行 gate 才会继续），监听已就位
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(seen).toEqual(['1922570576']);
    release();

    // 仍在飞的那次 render 必须作废：返回 true 会让控制器把 preview 换回一块失效 canvas。
    await expect(pending).resolves.toBe(false);
    // 没有安装 player：loadSceneToThree 是唯一的装配入口（不会留下僵尸帧循环/GL 资源）。
    expect(loadSceneToThree).not.toHaveBeenCalled();
    expect(seen).toEqual(['1922570576']); // 作废收尾不得二次回调
    warn.mockRestore();
    r.dispose();
  });

  // R27 的另一半：上面的用例只覆盖「丢失作废在飞的 render」，本用例覆盖「再 render 一次能重新装配」。
  // 若入口不复位 contextLost（或 teardown 留成 true），作废一次后本实例只会静默返回 false（最坏回归）。
  it('上下文丢失作废后，再 render() 一次仍能成功装配（contextLost 复位为 false）', async () => {
    const first = lostCanvas(); // 本用例自带 resolveImageAssets 实现，不依赖上一个用例的 gate
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let entered!: () => void;
    const atAwait = new Promise<void>((res) => { entered = res; });
    resolveImageAssets.mockImplementationOnce(async () => {
      entered();
      await gate;
      return { texture: fakeTexture() as never, puppetPath: null };
    });
    const seen: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    r.setOnContextLost?.((id) => seen.push(id));

    const pending = r.render('1922570576', first.canvas, null);
    await atAwait;
    first.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    release();
    await expect(pending).resolves.toBe(false); // 第 1 次：作废
    expect(seen).toEqual(['1922570576']);

    // 第 2 次（同一个 renderer 实例、新的 canvas）：必须能重新装配并启动播放器。
    const second = lostCanvas();
    const before = loadSceneToThree.mock.calls.length;
    await expect(r.render('2851992662', second.canvas, null)).resolves.toBe(true);
    expect(loadSceneToThree.mock.calls.length).toBe(before + 1);
    // 复位是**性质**而非一次性侥幸：新 canvas 的丢失监听同样就位、带的是新壁纸 id。
    second.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(seen).toEqual(['1922570576', '2851992662']);
    warn.mockRestore();
    r.dispose();
  });

  it('本次装配无壁纸 id ⇒ 丢失只留「无 id」告警并早退（不回调、不回退 preview）', async () => {
    const { canvas } = lostCanvas();
    const seen: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    r.setOnContextLost?.((id) => seen.push(id));

    // 监听在 render 的同步段注册（首个 await 之前）⇒ 空 id 也照样挂上，同步派发即可命中。
    const pending = r.render('', canvas, null);
    const evt = new Event('webglcontextlost', { cancelable: true });
    canvas.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    // 无 id 不得完全静默：必须是「无 id」专属那条，而不是「已回退 preview（壁纸 …）」。
    expect(warn.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('[wallpaper-engine]')))
      .toEqual(['[wallpaper-engine] WebGL 上下文丢失，但无本次装配的壁纸 id，已停播（不回退 preview）']);
    expect(seen).toEqual([]); // 没有 id 就没得回退 ⇒ 回调不得被调用
    expect(loadSceneToThree).not.toHaveBeenCalled();
    await expect(pending).resolves.toBe(false); // 丢失仍作废本次装配
    warn.mockRestore();
    r.dispose();
  });
});

// Task 2：render 的每个出口对**当前壁纸 id** 打一条结构化原因（硬失败落盘/软失败仅会话），
// 并把装配耗时与首帧耗时写进同一份快照。断言看的是 store 快照（真实行为），不是「某方法被调用」。
describe('scene 渲染看护：失败分类与打点', () => {
  const SCENE_ONE_IMAGE = JSON.stringify({
    general: { orthogonalprojection: { width: 1920, height: 1080 } },
    objects: [{ id: 1, name: 'bg', image: 'models/bg.json', origin: '960.00000 540.00000 0.00000', size: '1920.00000 1080.00000' }],
  });

  // 成功出口的 player 替身：setFrameCapture/setGlowStage/setParallax 缺一个就会落进 catch 被记成 exception。
  function okPlayer() {
    return {
      player: { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn() },
      sims: [], backgroundIds: [1], particleLayers: [], puppetLayers: [],
    };
  }

  it('scene.json 404 → 硬失败 scene-json', async () => {
    const store = createRenderHealthStore({ storage: null });
    const r = createThreeSceneRenderer({ healthStore: store });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })));
    const fg = document.createElement('canvas');
    expect(await r.render('wid-404', fg)).toBe(false);
    expect(store.snapshot('wid-404').failure?.kind).toBe('scene-json');
    expect(store.snapshot('wid-404').failure?.hard).toBe(true);
  });

  it('scene.json fetch 抛错 → 软失败 load-error（不落盘、可自动重试）', async () => {
    const store = createRenderHealthStore({ storage: null, softCooldownMs: 0 });
    const r = createThreeSceneRenderer({ healthStore: store });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const fg = document.createElement('canvas');
    expect(await r.render('wid-net', fg)).toBe(false);
    const snap = store.snapshot('wid-net');
    expect(snap.failure?.kind).toBe('load-error');
    expect(snap.failure?.hard).toBe(false);
    expect(store.shouldAutoRetry('wid-net')).toBe(true);
  });

  it('装配成功 → 记 ok 与装配耗时，并在首帧回调处补 firstFrameMs', async () => {
    const store = createRenderHealthStore({ storage: null });
    let onFrame: ((dt: number) => void) | null = null;
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null });
    defaultLoadWasm.mockResolvedValue(null);
    loadSceneToThree.mockImplementation((_json: unknown, assets: { onFrame?: (dt: number) => void }) => {
      onFrame = assets.onFrame ?? null; // 宿主注入的每帧钩子：首帧计时挂在这里
      return okPlayer();
    });
    const r = createThreeSceneRenderer({ healthStore: store });
    const published: HealthSnapshot[] = [];
    r.setOnHealth?.((s) => { published.push(s); });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => SCENE_ONE_IMAGE })));
    expect(await r.render('wid-ok', document.createElement('canvas'))).toBe(true);
    const before = store.snapshot('wid-ok').timing;
    expect(before?.assembleMs).toBeGreaterThanOrEqual(0);
    expect(before?.firstFrameMs).toBe(-1); // 首帧还没发生
    onFrame?.(0.016);
    expect(store.snapshot('wid-ok').timing?.firstFrameMs).toBeGreaterThanOrEqual(0);
    expect(published).toHaveLength(2); // 成功出口一次 + 首帧一次
    onFrame?.(0.016);
    expect(published).toHaveLength(2); // 第二帧不再打点（首帧计时是「第一次出帧」）
    r.dispose();
  });

  it('首帧明显晚于装配 ⇒ assembleMs 不被首帧时刻抬高（首帧回填只补 firstFrameMs）', async () => {
    const store = createRenderHealthStore({ storage: null });
    let onFrame: ((dt: number) => void) | null = null;
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null });
    defaultLoadWasm.mockResolvedValue(null);
    loadSceneToThree.mockImplementation((_json: unknown, assets: { onFrame?: (dt: number) => void }) => {
      onFrame = assets.onFrame ?? null;
      return okPlayer();
    });
    const r = createThreeSceneRenderer({ healthStore: store });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => SCENE_ONE_IMAGE })));
    expect(await r.render('wid-late', document.createElement('canvas'))).toBe(true);
    const assembled = store.snapshot('wid-late').timing?.assembleMs;
    expect(assembled).toBeGreaterThanOrEqual(0);

    await new Promise((res) => setTimeout(res, 25)); // 首帧确实晚于装配
    onFrame?.(0.016);
    const after = store.snapshot('wid-late').timing;
    expect(after?.firstFrameMs).toBeGreaterThan((assembled ?? 0) + 20); // 首帧耗时刻意远晚于装配
    // 回归点：旧实现把 firstFrameAt 当装配耗时写回（这里会写成 ≳25 的值），夸大装配
    expect(after?.assembleMs).toBe(assembled);
    r.dispose();
  });

  it('零可见对象 → 硬失败 no-visible-objects，且不得同时记成功（判定在 succeed 之前）', async () => {
    const store = createRenderHealthStore({ storage: null });
    resolveImageAssets.mockResolvedValue({ texture: null, puppetPath: null });
    defaultLoadWasm.mockResolvedValue(null);
    stubAssetFetch(SCENE_ONE_IMAGE, {});
    loadSceneToThree.mockReturnValue({ ...okPlayer(), backgroundIds: [], particleLayers: [], puppetLayers: [], } as never);
    const r = createThreeSceneRenderer({ healthStore: store });
    expect(await r.render('wid-empty', document.createElement('canvas'))).toBe(false);
    const snap = store.snapshot('wid-empty');
    expect(snap.failure?.kind).toBe('no-visible-objects');
    expect(snap.failure?.hard).toBe(true);
    expect(snap.timing).toBeNull(); // 空场景打到成功出口就会留下装配耗时 ⇒ 顺序回归在这里现形
    r.dispose();
  });

  it('装配成功、帧循环已跑起来后丢上下文 → 硬失败 context-lost（事件路径，唯一记录点）', async () => {
    const store = createRenderHealthStore({ storage: null });
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null });
    defaultLoadWasm.mockResolvedValue(null);
    stubAssetFetch(SCENE_ONE_IMAGE, {});
    loadSceneToThree.mockReturnValue(okPlayer() as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = createThreeSceneRenderer({ healthStore: store });
    const seen: HealthSnapshot[] = [];
    r.setOnHealth?.((s) => seen.push(s));
    const canvas = document.createElement('canvas');
    expect(await r.render('wid-live', canvas)).toBe(true);
    expect(store.snapshot('wid-live').failure).toBeNull(); // 装配成功这一刻还没有失败

    // 生产上最常见的一条：装配完成后浏览器回收 / GPU 复位 ⇒ 不经过任何 abortIfContextLost 检查点。
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    const snap = store.snapshot('wid-live');
    expect(snap.failure?.kind).toBe('context-lost');
    expect(snap.failure?.hard).toBe(true);
    expect(seen).toHaveLength(2); // 成功出口一次 + 丢失一次
    // 记录点唯一：同一次丢失不得被记两遍（once + teardown 移除监听）。
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(seen).toHaveLength(2);
    warn.mockRestore();
    r.dispose();
  });

  it('render 进行中丢上下文 → 硬失败 context-lost（8 个作废检查点只记一次）', async () => {
    const store = createRenderHealthStore({ storage: null });
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let entered!: () => void;
    const atAwait = new Promise<void>((res) => { entered = res; });
    resolveImageAssets.mockImplementation(async () => {
      entered();
      await gate;
      return { texture: fakeTexture() as never, puppetPath: null };
    });
    defaultLoadWasm.mockResolvedValue(null);
    stubAssetFetch(SCENE_ONE_IMAGE, {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = createThreeSceneRenderer({ healthStore: store });
    const seen: HealthSnapshot[] = [];
    r.setOnHealth?.((s) => seen.push(s));

    const canvas = document.createElement('canvas');
    const pending = r.render('wid-lost', canvas, null);
    await atAwait; // render 挂在贴图解析上，丢失监听已就位
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    release();
    await expect(pending).resolves.toBe(false);
    expect(seen).toHaveLength(1);
    expect(store.snapshot('wid-lost').failure?.kind).toBe('context-lost');
    expect(store.snapshot('wid-lost').failure?.hard).toBe(true);
    warn.mockRestore();
    r.dispose();
  });

  it('装配抛异常 → 硬失败 exception（detail 保留原始 message）', async () => {
    const store = createRenderHealthStore({ storage: null });
    resolveImageAssets.mockRejectedValue(new Error('纹理爆炸'));
    defaultLoadWasm.mockResolvedValue(null);
    stubAssetFetch(SCENE_ONE_IMAGE, {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = createThreeSceneRenderer({ healthStore: store });
    expect(await r.render('wid-throw', document.createElement('canvas'))).toBe(false);
    const snap = store.snapshot('wid-throw');
    expect(snap.failure?.kind).toBe('exception');
    expect(snap.failure?.hard).toBe(true);
    expect(snap.failure?.detail).toBe('纹理爆炸');
    warn.mockRestore();
    r.dispose();
  });

  it('getLastHealth / setOnHealth：读当前壁纸快照、订阅可撤销、订阅者异常不影响渲染', async () => {
    const store = createRenderHealthStore({ storage: null });
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null });
    defaultLoadWasm.mockResolvedValue(null);
    loadSceneToThree.mockReturnValue(okPlayer() as never);
    const r = createThreeSceneRenderer({ healthStore: store });
    expect(r.getLastHealth?.()).toBeNull(); // 还没渲染过 ⇒ 无可归属的状态

    const seen: HealthSnapshot[] = [];
    r.setOnHealth?.((s) => { seen.push(s); });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => SCENE_ONE_IMAGE })));
    await r.render('wid-ok', document.createElement('canvas'));
    expect(r.getLastHealth?.()?.wallpaperId).toBe('wid-ok');
    expect(r.getLastHealth?.()?.ok).toBe(true);
    expect(seen).toHaveLength(1); // 成功出口打点一次

    // 撤销订阅后不再收到打点（面板关闭/卸载时用得上）。
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })));
    r.setOnHealth?.(null);
    await r.render('wid-404', document.createElement('canvas'));
    expect(seen).toHaveLength(1);
    expect(r.getLastHealth?.()?.failure?.kind).toBe('scene-json');

    // 订阅者抛错不得掀翻渲染（订阅方是 UI 代码）；且**首次**异常必须留一条告警，否则 UI bug 彻底隐形。
    const subWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    r.setOnHealth?.(() => { throw new Error('subscriber boom'); });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => SCENE_ONE_IMAGE })));
    await expect(r.render('wid-ok2', document.createElement('canvas'))).resolves.toBe(true);
    await expect(r.render('wid-ok3', document.createElement('canvas'))).resolves.toBe(true);
    expect(subWarn.mock.calls.filter((c) => String(c[0]).includes('订阅者'))).toHaveLength(1); // 只告警一次
    subWarn.mockRestore();
    r.dispose();
  });

  // 归属回归：controller 允许 select 重叠（wallpaper-controller 的 generation 竞态 + 两次 await render），
  // 故「上一次 render 的结论」绝不能落到当前壁纸键上。
  it('A 的 render 未决期间 B 开始 render：A 的失败必须落在 A 的键上，B 的快照不受影响', async () => {
    const store = createRenderHealthStore({ storage: null });
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null });
    defaultLoadWasm.mockResolvedValue(null);
    loadSceneToThree.mockReturnValue(okPlayer() as never);
    // A 的 scene.json 响应悬挂（慢盘/慢网），B 走正常路径 ⇒ 两次 render 重叠。
    let releaseA!: () => void;
    const gateA = new Promise<void>((res) => { releaseA = res; });
    let aAtFetch!: () => void;
    const aFetching = new Promise<void>((res) => { aAtFetch = res; });
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url).includes('/scene/A/')) {
        aAtFetch();
        await gateA;
        return { ok: false, status: 404, text: async () => '' }; // A 最终硬失败
      }
      return { ok: true, status: 200, text: async () => SCENE_ONE_IMAGE };
    }));
    const r = createThreeSceneRenderer({ healthStore: store });

    const pendingA = r.render('A', document.createElement('canvas'), null);
    await aFetching; // A 已挂在 fetch 上（await 未决），此时 B 的 render 顶上
    expect(await r.render('B', document.createElement('canvas'), null)).toBe(true);
    expect(store.snapshot('B').ok).toBe(true); // B 走成功出口，快照已是「好」
    releaseA();
    await expect(pendingA).resolves.toBe(false);

    // 关键：A 的结论只能写在 A 上。写错键 ⇒ B 被记忆成「拿不到 scene.json」且不再自动重试。
    expect(store.snapshot('A').failure?.kind).toBe('scene-json');
    expect(store.snapshot('A').failure?.hard).toBe(true);
    const snapB = store.snapshot('B');
    expect(snapB.failure).toBeNull();
    expect(snapB.ok).toBe(true);
    r.dispose();
  });

  it('A 的 render 未决期间 B 以硬失败告终：A 随后装配成功仍须记在 A 上', async () => {
    const store = createRenderHealthStore({ storage: null });
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null });
    defaultLoadWasm.mockResolvedValue(null);
    loadSceneToThree.mockReturnValue(okPlayer() as never);
    let releaseA!: () => void;
    const gateA = new Promise<void>((res) => { releaseA = res; });
    let aAtFetch!: () => void;
    const aFetching = new Promise<void>((res) => { aAtFetch = res; });
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url).includes('/scene/A/')) {
        aAtFetch();
        await gateA;
        return { ok: true, status: 200, text: async () => SCENE_ONE_IMAGE }; // A 最终装配成功
      }
      return { ok: false, status: 404, text: async () => '' }; // B 硬失败
    }));
    const r = createThreeSceneRenderer({ healthStore: store });

    const pendingA = r.render('A', document.createElement('canvas'), null);
    await aFetching;
    expect(await r.render('B', document.createElement('canvas'), null)).toBe(false);
    expect(store.snapshot('B').failure?.kind).toBe('scene-json');
    releaseA();
    await expect(pendingA).resolves.toBe(true);

    // 成功同样按本次 render 的 id 记：A 的装配耗时不得写进 B（B 的硬失败结论也不得被抹掉）。
    expect(store.snapshot('A').ok).toBe(true);
    expect(store.snapshot('A').timing?.assembleMs).toBeGreaterThanOrEqual(0);
    expect(store.snapshot('B').failure?.kind).toBe('scene-json');
    r.dispose();
  });

  // Minor 3：计时必须是**本次 render 的局部状态** —— 重叠 render 下（controller 允许 select 竞态）
  // 共享的 renderStartedAt/firstFrameAt 会把被取代那次的起点算进本次装配/首帧耗时。
  it('重叠 render：A 的装配/首帧耗时取自 A 自己的起点，不串到 B 的起点上', async () => {
    const store = createRenderHealthStore({ storage: null });
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null });
    defaultLoadWasm.mockResolvedValue(null);
    const frames = new Map<HTMLCanvasElement, (dt: number) => void>();
    loadSceneToThree.mockImplementation((
      _json: unknown, assets: { onFrame?: (dt: number) => void }, fg: HTMLCanvasElement,
    ) => {
      if (assets.onFrame) frames.set(fg, assets.onFrame);
      return okPlayer();
    });
    // A 的 scene.json 响应悬挂 ⇒ B 先装配完成，A 随后完成（两次 render 重叠）。
    let releaseA!: () => void;
    const gateA = new Promise<void>((res) => { releaseA = res; });
    let aAtFetch!: () => void;
    const aFetching = new Promise<void>((res) => { aAtFetch = res; });
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url).includes('/scene/A/')) { aAtFetch(); await gateA; }
      return { ok: true, status: 200, text: async () => SCENE_ONE_IMAGE };
    }));
    // 受控单调时钟：把 performance.now 钉到测试自己推进的计数器上，耗时才可精确断言。
    const hadOwnNow = Object.prototype.hasOwnProperty.call(performance, 'now');
    const origNow = performance.now;
    let clock = 0;
    Object.defineProperty(performance, 'now', { configurable: true, writable: true, value: () => clock });
    try {
      const r = createThreeSceneRenderer({ healthStore: store });
      const canvasA = document.createElement('canvas');
      const pendingA = r.render('A', canvasA, null); // A 的起点 = 0
      await aFetching;
      clock = 100;
      expect(await r.render('B', document.createElement('canvas'), null)).toBe(true); // B 的起点 = 100
      clock = 200;
      releaseA();
      await expect(pendingA).resolves.toBe(true); // A 在 200 时刻装配完成
      clock = 300;
      frames.get(canvasA)?.(0.016); // A 的首帧在 300 时刻到来
      expect(store.snapshot('A').timing).toEqual({ assembleMs: 200, firstFrameMs: 300 });
      r.dispose();
    } finally {
      if (hadOwnNow) Object.defineProperty(performance, 'now', { configurable: true, writable: true, value: origNow });
      else delete (performance as unknown as { now?: () => number }).now;
    }
  });

  // Minor 4：no-visible-objects 出口的 teardown 抛错不得被外层 catch 改写成 exception（同一份快照被覆盖）。
  it('零可见对象出口的 teardown 抛错 ⇒ 失败原因仍是 no-visible-objects（不被改写成 exception）', async () => {
    const store = createRenderHealthStore({ storage: null });
    resolveImageAssets.mockResolvedValue({ texture: null, puppetPath: null });
    defaultLoadWasm.mockResolvedValue(null);
    stubAssetFetch(SCENE_ONE_IMAGE, {});
    loadSceneToThree.mockReturnValue({
      player: {
        dispose: () => { throw new Error('dispose boom'); },
        resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
      },
      sims: [], backgroundIds: [], particleLayers: [], puppetLayers: [],
    } as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = createThreeSceneRenderer({ healthStore: store });
    expect(await r.render('wid-empty-boom', document.createElement('canvas'))).toBe(false);
    warn.mockRestore();
    const snap = store.snapshot('wid-empty-boom');
    expect(snap.failure?.kind).toBe('no-visible-objects');
    expect(snap.failure?.detail).toBe('background=0 particleLayers=0 puppetLayers=0');
    // 不再 r.dispose()：stub 的 player.dispose 恒抛，本用例要的正是这个（收尾自身失败不得掩盖原因）。
  });

  // 追加 nit（2026-10-14）：abortIfContextLost 的收尾若抛错，曾一路冒到 render 外层 catch，把 onContextLost
  // 已记下的 context-lost 改写成 exception（同一份快照被覆盖）⇒ 装配中止但结论必须是 context-lost。
  it('装配进行中丢上下文 + 收尾抛错 ⇒ render 返回 false，失败仍是 context-lost（不被改写成 exception）', async () => {
    const store = createRenderHealthStore({ storage: null });
    const scene = JSON.stringify({
      general: { orthogonalprojection: { width: 1920, height: 1080 } },
      objects: [
        { id: 1, name: 'bg', image: 'models/bg.json', origin: '960.00000 540.00000 0.00000', size: '1920.00000 1080.00000' },
        // 纯控制器对象：只为让装配在 player 装好**之后**还有一处 await（脚本宿主）可挂起。
        { id: 2, name: 'ctl', visible: { script: 'export function update(){}', value: true } },
      ],
    });
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null });
    defaultLoadWasm.mockResolvedValue(null);
    stubAssetFetch(scene, {});
    // 收尾抛错：player.dispose 恒抛 —— onContextLost 那次被它自己的 try 吞掉，abortIfContextLost 那一次
    // （旧实现走裸 teardown）会冒到外层 catch 并改写失败原因。
    loadSceneToThree.mockReturnValue({
      player: {
        dispose: () => { throw new Error('dispose boom'); },
        resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
      },
      sims: [], backgroundIds: [1], particleLayers: [], puppetLayers: [],
    } as never);
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let entered!: () => void;
    const atAwait = new Promise<void>((res) => { entered = res; });
    vi.spyOn(SceneScriptHost, 'create').mockImplementation(async () => { entered(); await gate; return null as never; });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = createThreeSceneRenderer({ healthStore: store });
    const canvas = document.createElement('canvas');
    const pending = r.render('wid-lost-boom', canvas, null);
    await atAwait; // player 已装好、装配挂在脚本宿主上 ⇒ 丢失事件此刻到达
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    release();
    await expect(pending).resolves.toBe(false);                                  // ① 中止装配 = false，不抛出/reject
    expect(store.snapshot('wid-lost-boom').failure?.kind).toBe('context-lost');  // ② 收尾失败不得改写结论
    warn.mockRestore();
    // 不再 r.dispose()：stub 的 player.dispose 恒抛，本用例要的正是这个（收尾自身失败不得掩盖原因）。
  });

  // Minor 5（失败出口一律收尾）：早退出口也要 teardown —— 否则本次 canvas 的 webglcontextlost
  // 监听留在实例上，迟到的丢失事件会把刚记下的失败结论改写掉。
  it('scene-json 硬失败出口已收尾：本次 canvas 的上下文丢失监听被移除，失败结论不被迟到事件改写', async () => {
    const store = createRenderHealthStore({ storage: null });
    const r = createThreeSceneRenderer({ healthStore: store });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })));
    const fg = document.createElement('canvas');
    expect(await r.render('wid-404-tail', fg)).toBe(false);
    expect(store.snapshot('wid-404-tail').failure?.kind).toBe('scene-json');
    const evt = new Event('webglcontextlost', { cancelable: true });
    fg.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false); // 监听已随收尾移除
    expect(store.snapshot('wid-404-tail').failure?.kind).toBe('scene-json');
    r.dispose();
  });

  it('load-error 软失败出口已收尾：监听被移除，软失败仍可自动重试', async () => {
    const store = createRenderHealthStore({ storage: null, softCooldownMs: 0 });
    const r = createThreeSceneRenderer({ healthStore: store });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const fg = document.createElement('canvas');
    expect(await r.render('wid-net-tail', fg)).toBe(false);
    const evt = new Event('webglcontextlost', { cancelable: true });
    fg.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(store.snapshot('wid-net-tail').failure?.kind).toBe('load-error'); // 未被改写成 context-lost
    expect(store.shouldAutoRetry('wid-net-tail')).toBe(true);
    r.dispose();
  });
});

// Task 5：视差接线（scene.json 的 general.cameraparallax* → player.setParallax；指针逐帧下发 + 随实例收尾）。
// 断言的都是「player 收到了什么值 / window 上的监听是否随实例装卸」，不是「函数被调用过」。
describe('createThreeSceneRenderer 视差接线', () => {
  // 本文件缺省的 fetch 桩只回同一份 SCENE；需要变场景的用例用这个重新 stub（只改 general 字段）。
  function stubSceneWithGeneral(general: Record<string, unknown>): void {
    const scene = JSON.parse(SCENE) as { general: Record<string, unknown> };
    Object.assign(scene.general, general);
    const fixed = JSON.stringify(scene);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('name=scene.json')) return { ok: true, text: async () => fixed };
      if (String(url).includes('leaves5.json')) return { ok: true, text: async () => '{"material":"presets/lightshaft"}' };
      return { ok: false, text: async () => '' };
    }));
  }

  // 成功装配的 player 替身：接口新增方法缺一个就会落进 catch 被记成 exception（false），不再是真装配。
  function parallaxPlayer() {
    return {
      dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
    };
  }

  function prepareParallaxRender() {
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture() as any, puppetPath: null });
    resolveParticleMaterial.mockResolvedValue(null);
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => makeMockSim()) } } as any);
    const player = parallaxPlayer();
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [], } as any);
    return player;
  }

  function movePointer(x: number, y: number): void {
    const ev = new Event('pointermove') as any;
    ev.clientX = x; ev.clientY = y;
    window.dispatchEvent(ev);
  }

  // 关闭态必须是**具体配置**（enabled:false）而不是 null：player 只在 cfg.enabled=false 时把对象写回
  // 一次基准位，cfg=null 会让 tickParallax 整体早退 ⇒ 上一张壁纸留下的位移不复位。
  it('关视差（cameraparallax 缺省）⇒ player 收到 enabled:false 的配置（不是 null）', async () => {
    const player = prepareParallaxRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);
    expect(player.setParallax).toHaveBeenCalledTimes(1);
    expect(player.setParallax).toHaveBeenCalledWith({ enabled: false, amount: 0, delay: 0, mouseInfluence: 0 });
    r.dispose();
  });

  it('开视差 ⇒ 四个字段原样透传给 player.setParallax', async () => {
    stubSceneWithGeneral({
      cameraparallax: true, cameraparallaxamount: 0.5, cameraparallaxdelay: 0.1, cameraparallaxmouseinfluence: 1,
    });
    const player = prepareParallaxRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);
    expect(player.setParallax).toHaveBeenCalledWith({ enabled: true, amount: 0.5, delay: 0.1, mouseInfluence: 1 });
    r.dispose();
  });

  it('指针逐帧下发：onFrame 把归一化指针交给 player（未移动 = 居中；window 的 pointermove 能改到它）', async () => {
    const player = prepareParallaxRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);
    const onFrame = loadSceneToThree.mock.calls[0][1].onFrame as (dt: number) => void;
    onFrame(0.016);
    expect(player.setParallaxPointer).toHaveBeenLastCalledWith({ x: 0.5, y: 0.5 });
    // jsdom 视口 1920×1080（beforeEach）⇒ (480,270) 归一化为 (0.25,0.25)
    movePointer(480, 270);
    onFrame(0.016);
    expect(player.setParallaxPointer).toHaveBeenLastCalledWith({ x: 0.25, y: 0.25 });
    expect(player.setParallaxPointer).toHaveBeenCalledTimes(2);
    r.dispose();
  });

  // v0.8.2 F18：每帧把「原始指针」与「视差跟随指针」折算成效果 shader 的全局 uniform 下发。
  // 场景带一个隔离对象（有 effects）才会装配 ObjectEffectStage —— 全局 uniform 的落点是 stage。
  it('每帧下发全局 uniform：pointerPosition=原始指针、parallaxPosition=视差跟随值（y 翻转）', async () => {
    stubAssetFetch(JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: {
        orthogonalprojection: { width: 1920, height: 1080 },
        cameraparallax: true, cameraparallaxamount: 0.5, cameraparallaxdelay: 0.1, cameraparallaxmouseinfluence: 1,
      },
      objects: [{
        id: 13, name: 'bg', image: 'models/a.json', origin: '960 540 0', scale: '1 1 1', size: '1920 1080',
        effects: [{ file: 'effects/w/effect.json' }],
      }],
    }), FX_FILES);
    vi.mocked(resolveImageAssets).mockResolvedValue({ texture: fakeTexture() as any, puppetPath: null, spriteSheet: false });
    vi.mocked(defaultLoadWasm).mockResolvedValue(null);
    const follow: { x: number; y: number } = { x: 0.5, y: 0.5 };
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage: vi.fn(),
      setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
      parallaxPointer: vi.fn(() => follow),
      renderer: {},
      isolatedObjects: () => [{ id: 13, kind: 'background', rtWidth: 1920, rtHeight: 1080, rtTexture: {} }],
    };
    vi.mocked(loadSceneToThree).mockReturnValue({
      player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [],
    } as never);
    const globalSpy = vi.spyOn(ObjectEffectStage.prototype, 'setGlobalUniforms');

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('3780477933', document.createElement('canvas'))).toBe(true);
    const onFrame = vi.mocked(loadSceneToThree).mock.calls[0][1].onFrame as (dt: number) => void;

    onFrame(0.016);
    expect(globalSpy).toHaveBeenLastCalledWith({ pointerPosition: [0.5, 0.5], parallaxPosition: [0.5, 0.5] });

    // 视差跟随值滞后于原始指针：parallaxPosition 用它（x 中心化、y 翻到向上）。
    follow.x = 0.2; follow.y = 0.2;
    movePointer(480, 270); // 原始指针 (0.25,0.25)
    onFrame(0.016);
    expect(globalSpy).toHaveBeenLastCalledWith({
      pointerPosition: [0.25, 0.25],
      parallaxPosition: [0.2, 0.8],
    });
    expect(globalSpy).toHaveBeenCalledTimes(2);

    globalSpy.mockRestore();
    r.dispose?.();
  });

  // 关视差时 parallaxPosition 保持中性 0.5（无偏移）；player 未实现 parallaxPointer（旧/替身）也不得抛。
  it('关视差 → parallaxPosition 中性；player 无 parallaxPointer 时回退原始指针', async () => {
    stubAssetFetch(JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 1920, height: 1080 } },
      objects: [{
        id: 13, name: 'bg', image: 'models/a.json', origin: '960 540 0', scale: '1 1 1', size: '1920 1080',
        effects: [{ file: 'effects/w/effect.json' }],
      }],
    }), FX_FILES);
    vi.mocked(resolveImageAssets).mockResolvedValue({ texture: fakeTexture() as any, puppetPath: null, spriteSheet: false });
    vi.mocked(defaultLoadWasm).mockResolvedValue(null);
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage: vi.fn(),
      setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn(),
      renderer: {},
      isolatedObjects: () => [{ id: 13, kind: 'background', rtWidth: 1920, rtHeight: 1080, rtTexture: {} }],
    };
    vi.mocked(loadSceneToThree).mockReturnValue({
      player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [],
    } as never);
    const globalSpy = vi.spyOn(ObjectEffectStage.prototype, 'setGlobalUniforms');

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('3780477933', document.createElement('canvas'))).toBe(true);
    const onFrame = vi.mocked(loadSceneToThree).mock.calls[0][1].onFrame as (dt: number) => void;
    movePointer(480, 270);
    onFrame(0.016);
    expect(globalSpy).toHaveBeenLastCalledWith({ pointerPosition: [0.25, 0.25], parallaxPosition: [0.5, 0.5] });

    globalSpy.mockRestore();
    r.dispose?.();
  });

  it('监听随实例收尾：切壁纸先卸后装、不叠加；卸载复位居中（切回后仍生效）', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const player = prepareParallaxRender();
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);
    const handler = addSpy.mock.calls.find((c) => c[0] === 'pointermove')?.[1];
    expect(typeof handler).toBe('function');
    const onFrameA = loadSceneToThree.mock.calls[0][1].onFrame as (dt: number) => void;
    movePointer(480, 270);
    onFrameA(0.016);
    expect(player.setParallaxPointer).toHaveBeenLastCalledWith({ x: 0.25, y: 0.25 });

    // 第二次 render = 先 teardown（卸监听 + 复位居中）再装：同一 handler 重新挂上，不叠加。
    expect(await r.render('2851992662', document.createElement('canvas'), null)).toBe(true);
    const pointerAdds = addSpy.mock.calls.filter((c) => c[0] === 'pointermove');
    expect(pointerAdds.map((c) => c[1])).toEqual([handler, handler]);
    expect(removeSpy.mock.calls.filter((c) => c[0] === 'pointermove')).toEqual([['pointermove', handler]]);
    const onFrameB = loadSceneToThree.mock.calls[1][1].onFrame as (dt: number) => void;
    onFrameB(0.016);
    expect(player.setParallaxPointer).toHaveBeenLastCalledWith({ x: 0.5, y: 0.5 }); // 卸载时复位居中
    movePointer(960, 810);
    onFrameB(0.016);
    expect(player.setParallaxPointer).toHaveBeenLastCalledWith({ x: 0.5, y: 0.75 }); // 重挂后仍生效

    r.dispose();
    expect(removeSpy.mock.calls.filter((c) => c[0] === 'pointermove')).toHaveLength(2);
  });
});

// Task 7：`.mdl` puppet 的装配接线。本机唯一 .mdl 样本是**静态族**（无 MDLS/MDLA），故夹具也用静态族
//（stride 48 / 3 顶点 / 无段标记），断言真实几何与真实材质，而不是「函数被调用过」。
describe('createThreeSceneRenderer · puppet 接线', () => {
  const PUPPET_SCENE = JSON.stringify({
    camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
    general: { orthogonalprojection: { width: 1920, height: 1080 } },
    objects: [{
      id: 16, name: 'puppet', image: 'models/p.json',
      origin: '1000.00000 600.00000 0.00000', scale: '2.00000 2.00000 1.00000',
      size: '100.00000 100.00000', visible: true,
    }],
  });
  const MDL_URL = '/wallpapers/asset?name=models%2Fp_puppet.mdl';

  /** 最小静态族 .mdl：MDLV0021 + 材质串@21 + 7×u32 零 + u32 15 + u32 vertexBytes + stride 48 顶点 + 索引。 */
  function staticMdlBytes(): Uint8Array {
    const material = 'materials/p.json';
    const verticesOffset = 21 + material.length + 1 + 7 * 4 + 4 + 4;
    const vertexBytes = 48 * 3;
    const buf = new Uint8Array(verticesOffset + vertexBytes + 4 + 6);
    const dv = new DataView(buf.buffer);
    for (let i = 0; i < 'MDLV0021'.length; i++) buf[i] = 'MDLV0021'.charCodeAt(i);
    dv.setUint16(9, 9, true);
    dv.setUint32(11, 1, true);
    dv.setUint32(15, 1, true);
    for (let i = 0; i < material.length; i++) buf[21 + i] = material.charCodeAt(i);
    dv.setUint32(verticesOffset - 8, 15, true);
    dv.setUint32(verticesOffset - 4, vertexBytes, true);
    for (let i = 0; i < 3; i++) {
      const o = verticesOffset + i * 48;
      dv.setFloat32(o, i, true);
      dv.setFloat32(o + 4, i * 2, true);
      dv.setFloat32(o + 40, i / 2, true);
      dv.setFloat32(o + 44, 0.25, true);
    }
    dv.setUint32(verticesOffset + vertexBytes, 6, true);
    for (let i = 0; i < 3; i++) dv.setUint16(verticesOffset + vertexBytes + 4 + i * 2, i, true);
    return buf;
  }

  /** 装配场景 json 与 `.mdl` 字节（其余 URL 一律 404）。path 为 null = 不提供 .mdl 响应。 */
  function stubPuppetFetch(mdl: Uint8Array | null): ReturnType<typeof vi.fn> {
    const mock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('name=scene.json')) return { ok: true, text: async () => PUPPET_SCENE };
      if (mdl && u.includes('_puppet.mdl')) {
        return { ok: true, arrayBuffer: async () => mdl.buffer.slice(0) };
      }
      return { ok: false, text: async () => '' };
    });
    vi.stubGlobal('fetch', mock);
    return mock;
  }

  function assetsOfLastLoad(): {
    puppetMeshes: Map<number, PuppetInstance>;
    backgroundTextures: Map<number, unknown>;
    isolate: Map<number, { rtWidth: number; rtHeight: number; worldW: number; worldH: number }>;
  } {
    return loadSceneToThree.mock.calls.at(-1)![1] as never;
  }

  it('model json 有 puppet ⇒ 拉 .mdl 建网格并交进 SceneAssets.puppetMeshes（静态族 → 非蒙皮）', async () => {
    const tex = fakeTexture();
    resolveImageAssets.mockResolvedValue({ texture: tex, puppetPath: 'models/p_puppet.mdl' } as never);
    defaultLoadWasm.mockResolvedValue(null);
    const fetchMock = stubPuppetFetch(staticMdlBytes());
    loadSceneToThree.mockReturnValue({
      player: { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn() },
      sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [0],
    } as never);

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('wid-puppet', document.createElement('canvas'), null)).toBe(true);

    // .mdl 走 scene asset 路由（pkg 内条目），路径 encode
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u === '/wallpapers/scene/wid-puppet/asset?name=models%2Fp_puppet.mdl')).toBe(true);

    const { puppetMeshes } = assetsOfLastLoad();
    expect([...puppetMeshes.keys()]).toEqual([16]);
    const inst = puppetMeshes.get(16)!;
    expect(inst.mesh).toBeInstanceOf(THREE.Mesh);
    expect(inst.mesh.isSkinnedMesh ?? false).toBe(false);       // 静态族：无可蒙皮数据 ⇒ 普通网格
    expect(inst.mesh.geometry.getAttribute('position').count).toBe(3);
    expect([...(inst.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).array]).toEqual([0, 0, 0, 1, 2, 0, 2, 4, 0]);
    expect(inst.bones).toEqual([]);
    expect(inst.animations).toEqual([]);
    // 材质：three 内建材质 + 解析出的贴图（puppet 靠它出画面）
    expect(inst.mesh.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect((inst.mesh.material as THREE.MeshBasicMaterial).map).toBe(tex);
    expect((inst.mesh.material as THREE.MeshBasicMaterial).transparent).toBe(true);
    r.dispose();
  });

  it('无 puppet 字段（普通 image 对象）⇒ 不拉 .mdl、puppetMeshes 为空（零回归）', async () => {
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture(), puppetPath: null } as never);
    defaultLoadWasm.mockResolvedValue(null);
    const fetchMock = stubPuppetFetch(staticMdlBytes());
    loadSceneToThree.mockReturnValue({
      player: { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn() },
      sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [],
    } as never);

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('wid-plain', document.createElement('canvas'), null)).toBe(true);
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes('.mdl'))).toBe(false);
    expect(assetsOfLastLoad().puppetMeshes!.size).toBe(0);
    r.dispose();
  });

  it('.mdl 取不到 / 解析失败 ⇒ 退化成普通背景贴图 + 一条可排查告警（不拖成硬失败）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [label, mdl] of [['取不到', null], ['太短', new Uint8Array(16)]] as const) {
      vi.clearAllMocks();
      const tex = fakeTexture();
      resolveImageAssets.mockResolvedValue({ texture: tex, puppetPath: 'models/p_puppet.mdl' } as never);
      defaultLoadWasm.mockResolvedValue(null);
      stubPuppetFetch(mdl);
      loadSceneToThree.mockReturnValue({
        player: { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn() },
        sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [],
      } as never);

      const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
      expect(await r.render(`wid-degrade-${label}`, document.createElement('canvas'), null), label).toBe(true);
      const assets = assetsOfLastLoad();
      expect(assets.puppetMeshes!.size, label).toBe(0);
      // 该对象仍按普通 image 渲染（贴图链不受 puppet 失败影响）
      expect(assets.backgroundTextures!.get(16), label).toBe(tex);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('puppet 解析失败')), label).toBe(true);
      r.dispose();
    }
    warn.mockRestore();
  });

  // Critical（fix round 1）：puppet 对象**不**建隔离条目 —— 幽灵条目会挤占其它对象的 RT 预算，并让
  // ObjectEffectStage 对不存在的视图报「调用顺序错误」。改为 fail-loud 一条专属告警。
  /** fetch：scene.json + 效果链资源（FX_FILES）+ `.mdl` 字节。 */
  function stubPuppetFxFetch(scene: string, mdl: Uint8Array | null): void {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      const name = new URL(u, 'http://localhost').searchParams.get('name') ?? '';
      if (name === 'scene.json') return { ok: true, text: async () => scene };
      if (mdl && u.includes('_puppet.mdl')) return { ok: true, arrayBuffer: async () => mdl.buffer.slice(0) };
      const body = FX_FILES[name];
      if (body === undefined) return { ok: false, text: async () => '' };
      const bytes = new TextEncoder().encode(body);
      return { ok: true, text: async () => body, arrayBuffer: async () => bytes.buffer };
    }));
  }

  const FX_SCENE_ORTHO = { width: 5000, height: 2400 };
  function fxImageObject(id: number): Record<string, unknown> {
    return {
      id, name: `fx-${id}`, image: `models/${id}.json`,
      origin: '2500 1200 0', scale: '1 1 1', size: '5000 2400',
      effects: [{ file: 'effects/w/effect.json' }],
    };
  }
  function fxScene(objects: Array<Record<string, unknown>>): string {
    return JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: FX_SCENE_ORTHO },
      objects,
    });
  }
  function stubFxPlayer(): { setObjectEffectStage: ReturnType<typeof vi.fn> } {
    const setObjectEffectStage = vi.fn();
    loadSceneToThree.mockReturnValue({
      player: {
        dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(),
        setParallax: vi.fn(), setParallaxPointer: vi.fn(), setObjectEffectStage,
        renderer: {}, isolatedObjects: () => [],
      },
      sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [0],
    } as never);
    return { setObjectEffectStage };
  }

  it('带效果链的 puppet 对象：不进 isolate 表、不挂链、不建 stage，并 fail-loud 一条专属告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveImageAssets.mockResolvedValue({ texture: fakeTexture(), puppetPath: 'models/p_puppet.mdl' } as never);
    defaultLoadWasm.mockResolvedValue(null);
    stubPuppetFxFetch(fxScene([fxImageObject(16)]), staticMdlBytes());
    const { setObjectEffectStage } = stubFxPlayer();
    const worldSpy = vi.spyOn(ObjectEffectStage.prototype, 'setWorldSize').mockImplementation(() => {});
    const chainsSpy = vi.spyOn(ObjectEffectStage.prototype, 'setObjectChains').mockImplementation(() => {});

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('wid-puppet-fx', document.createElement('canvas'), null)).toBe(true);

    expect(assetsOfLastLoad().isolate.has(16)).toBe(false);
    expect(worldSpy).not.toHaveBeenCalled();
    expect(chainsSpy).not.toHaveBeenCalled();
    expect(setObjectEffectStage).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('puppet 对象不支持对象级效果链，已按直渲处理（id=16）'))).toBe(true);
    // 不得再并入「效果挂在未参与渲染的对象类型上」那条汇总告警（puppet 是**参与渲染**的）。
    expect(warn.mock.calls.some((c) => String(c[0]).includes('效果挂在未参与渲染的对象类型上'))).toBe(false);
    r.dispose();
    warn.mockRestore();
  });

  it('puppet 对象不占 isolate 预算：另一隔离对象仍拿到完整的 4096 收口', async () => {
    resolveImageAssets.mockImplementation(async (_id, o) => ({
      texture: { image: { ...FX_SCENE_ORTHO }, dispose: vi.fn() } as never,
      puppetPath: o.id === 16 ? 'models/p_puppet.mdl' : null,
    }));
    defaultLoadWasm.mockResolvedValue(null);
    stubPuppetFxFetch(fxScene([fxImageObject(16), fxImageObject(17)]), staticMdlBytes());
    stubFxPlayer();

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    expect(await r.render('wid-puppet-budget', document.createElement('canvas'), null)).toBe(true);

    const isolate = assetsOfLastLoad().isolate;
    expect(isolate.has(16)).toBe(false);
    // 预算只剩 17 一个对象（225 MB ≤ 384 MB）⇒ 长边恰为 4096；两者都进预算时会被等比收窄。
    expect(isolate.get(17)!.rtWidth).toBe(4096);
    expect(isolate.get(17)!.rtHeight).toBe(1966);
    r.dispose();
  });
});

// Task 7 护栏（接收方补）：puppet 只走**真实** loadSceneToThree 链路才验得到的两条口径 ——
//   ① puppet 图层必须计入「零可见对象」判定（否则 puppet-only 场景被误判成空场景 → 硬失败 no-visible-objects）；
//   ② puppet 失败只是退化，**不得**升级成渲染失败（不写 `we:renderfail:` 记忆）。
describe('createThreeSceneRenderer · puppet 真实链路护栏', () => {
  const GUARD_SCENE = (objects: unknown[]): string => JSON.stringify({
    camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
    general: { orthogonalprojection: { width: 1920, height: 1080 } },
    objects,
  });
  const PUPPET_ONLY = GUARD_SCENE([{
    id: 16, name: 'puppet', image: 'models/p.json',
    origin: '1000.00000 600.00000 0.00000', scale: '2.00000 2.00000 1.00000',
    size: '100.00000 100.00000', visible: true,
  }]);
  // 两个 image 对象：16 是 puppet（其 .mdl 解析会失败）、17 是普通贴图对象 ⇒ 本张壁纸**仍有可见内容**。
  const PUPPET_AND_BG = GUARD_SCENE([
    {
      id: 16, name: 'puppet', image: 'models/p.json',
      origin: '1000.00000 600.00000 0.00000', scale: '1.00000 1.00000 1.00000', size: '100.00000 100.00000',
    },
    {
      id: 17, name: 'bg', image: 'models/bg.json',
      origin: '960.00000 540.00000 0.00000', scale: '1.00000 1.00000 1.00000', size: '1920.00000 1080.00000',
    },
  ]);

  /** 真实 loadSceneToThree（旁路本文件顶部的 mock）：jsdom 无 WebGL ⇒ 注入 mock renderer。 */
  async function withRealLoader(): Promise<void> {
    const actual = await vi.importActual<typeof import('../src/client/threejs-player.js')>(
      '../src/client/threejs-player.js',
    );
    loadSceneToThree.mockImplementation(
      (sceneJson: string, assets: unknown, canvas: HTMLCanvasElement, viewport: unknown) =>
        actual.loadSceneToThree(
          sceneJson,
          { ...(assets as object), renderer: createPlayerMockRenderer() } as never,
          canvas,
          viewport as never,
        ),
    );
  }

  /** 静态族 .mdl（MDLV0021 / stride 48 / 无 MDLS+MDLA，同本机唯一真样本的族）。 */
  function staticMdlBytes(): Uint8Array {
    const material = 'materials/p.json';
    const verticesOffset = 21 + material.length + 1 + 7 * 4 + 4 + 4;
    const buf = new Uint8Array(verticesOffset + 48 * 3 + 4 + 6);
    const dv = new DataView(buf.buffer);
    for (let i = 0; i < 'MDLV0021'.length; i++) buf[i] = 'MDLV0021'.charCodeAt(i);
    dv.setUint16(9, 9, true);
    dv.setUint32(11, 1, true);
    dv.setUint32(15, 1, true);
    for (let i = 0; i < material.length; i++) buf[21 + i] = material.charCodeAt(i);
    dv.setUint32(verticesOffset - 8, 15, true);
    dv.setUint32(verticesOffset - 4, 48 * 3, true);
    for (let i = 0; i < 3; i++) {
      const o = verticesOffset + i * 48;
      dv.setFloat32(o, i, true); dv.setFloat32(o + 4, i * 2, true);
      dv.setFloat32(o + 40, i / 2, true); dv.setFloat32(o + 44, 0.25, true);
    }
    dv.setUint32(verticesOffset + 48 * 3, 6, true);
    for (let i = 0; i < 3; i++) dv.setUint16(verticesOffset + 48 * 3 + 4 + i * 2, i, true);
    return buf;
  }

  /** fetch：scene.json + `.mdl`（mdlBytes=null ⇒ 该路径 404）。其余 URL 一律 404。 */
  function stubGuardFetch(scene: string, mdlBytes: Uint8Array | null): void {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('name=scene.json')) return { ok: true, text: async () => scene };
      if (mdlBytes && u.includes('_puppet.mdl')) return { ok: true, arrayBuffer: async () => mdlBytes.buffer.slice(0) };
      return { ok: false, text: async () => '' };
    }));
  }

  /** 打点用的 localStorage 替身（只看写盘：puppet 退化不得留下 `we:renderfail:`）。 */
  function fakeStorage(): StorageLike & { written: string[] } {
    const map = new Map<string, string>();
    const written: string[] = [];
    return {
      written,
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => { written.push(k); map.set(k, v); },
      removeItem: (k) => { map.delete(k); },
      key: (i) => [...map.keys()][i] ?? null,
      get length() { return map.size; },
    };
  }

  it('puppet 图层**独占**可见内容（background=0 particle=0 puppet=1）⇒ 不算空场景，render 仍 true', async () => {
    // 桩掉 loadSceneToThree 精确控制三项计数（真链路用例里 addBackground 的兜底会掩盖条件）。
    // 日志行 `background=0 particleLayers=0 puppetLayers=1` 是这条口径的可观测证据。
    const store = createRenderHealthStore({ storage: null });
    resolveImageAssets.mockResolvedValue({ texture: null, puppetPath: null } as never);
    defaultLoadWasm.mockResolvedValue(null);
    stubAssetFetch(PUPPET_ONLY, {});
    loadSceneToThree.mockReturnValue({
      player: { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(), setParallax: vi.fn(), setParallaxPointer: vi.fn() },
      sims: [], backgroundIds: [], particleLayers: [], puppetLayers: [7],
    } as never);
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm, healthStore: store });
    expect(await r.render('wid-puppet-only-stub', document.createElement('canvas'), null)).toBe(true);
    expect(store.snapshot('wid-puppet-only-stub').failure).toBeNull();
    r.dispose();
  });

  it('puppet-only 场景：puppet 图层计入可见对象 ⇒ 不落 no-visible-objects（真 Grid 挂进场景）', async () => {
    await withRealLoader();
    const store = createRenderHealthStore({ storage: null });
    resolveImageAssets.mockResolvedValue({ texture: null, puppetPath: 'models/p_puppet.mdl' } as never);
    defaultLoadWasm.mockResolvedValue(null);
    stubGuardFetch(PUPPET_ONLY, staticMdlBytes());
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm, healthStore: store });
    expect(await r.render('wid-puppet-only', document.createElement('canvas'), null)).toBe(true);

    const loaded = loadSceneToThree.mock.results.at(-1)!.value as {
      player: { scene: THREE.Scene; displayObject(id: number): unknown };
      backgroundIds: number[]; puppetLayers: number[];
    };
    expect(loaded.puppetLayers).toHaveLength(1);          // 唯一可见对象是 puppet
    expect(loaded.puppetLayers).toEqual(loaded.backgroundIds);
    const mesh = loaded.player.displayObject(16) as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(loaded.player.scene.children).toContain(mesh);
    expect(mesh.position.x).toBeCloseTo(40, 6);           // we_to_three = origin − viewport/2
    expect(store.snapshot('wid-puppet-only').failure).toBeNull();
    r.dispose();
  });

  it('.mdl 取不到 ⇒ 退化成普通贴图：render 仍 true、不写 we:renderfail:、不留硬失败', async () => {
    await withRealLoader();
    const storage = fakeStorage();
    const store = createRenderHealthStore({ storage });
    const tex = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    resolveImageAssets.mockResolvedValue({ texture: tex, puppetPath: 'models/p_puppet.mdl' } as never);
    defaultLoadWasm.mockResolvedValue(null);
    stubGuardFetch(PUPPET_AND_BG, null);                  // 该对象仍是可见内容（背景贴图）⇒ 不落 no-visible-objects
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm, healthStore: store });

    expect(await r.render('wid-md-degrade', document.createElement('canvas'), null)).toBe(true);
    const loaded = loadSceneToThree.mock.results.at(-1)!.value as {
      player: { scene: THREE.Scene; displayObject(id: number): unknown };
      backgroundIds: number[]; puppetLayers: number[];
    };
    expect(loaded.puppetLayers).toEqual([]);              // 退化路径：没有 puppet 图层
    expect(loaded.backgroundIds).toHaveLength(2);         // 两个 image 对象都按普通贴图出图
    const bg = loaded.player.displayObject(17) as THREE.Mesh;
    expect((bg.material as THREE.MeshBasicMaterial).map).toBe(tex);
    // 硬失败记忆是「整张壁纸渲染失败」的通道：puppet 解析失败不得借用它
    expect(store.snapshot('wid-md-degrade').failure).toBeNull();
    expect(storage.written).toEqual([]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('puppet 解析失败'))).toBe(true);
    warn.mockRestore();
    r.dispose();
  });

  it('.mdl 能取到但解析失败（畸形字节）⇒ 仅告警 + 退化成普通贴图，不落任何失败记忆', async () => {
    await withRealLoader();
    const storage = fakeStorage();
    const store = createRenderHealthStore({ storage });
    const tex = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    resolveImageAssets.mockResolvedValue({ texture: tex, puppetPath: 'models/p_puppet.mdl' } as never);
    defaultLoadWasm.mockResolvedValue(null);
    stubGuardFetch(PUPPET_AND_BG, new Uint8Array(16));    // 16B 过短：解析必失败（真机上的损坏 pkg 形态）

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm, healthStore: store });
    expect(await r.render('wid-md-corrupt', document.createElement('canvas'), null)).toBe(true);
    const loaded = loadSceneToThree.mock.results.at(-1)!.value as {
      player: { displayObject(id: number): unknown };
      backgroundIds: number[]; puppetLayers: number[];
    };
    expect(loaded.puppetLayers).toEqual([]);              // 解析失败 ⇒ 没有 puppet 图层
    expect(loaded.backgroundIds).toHaveLength(2);         // 该对象退化成普通贴图层
    const degraded = loaded.player.displayObject(16) as THREE.Mesh;
    expect((degraded.material as THREE.MeshBasicMaterial).map).toBe(tex);
    // 关键：失败归因不是整场渲染失败（既不是 exception 也不是 no-visible-objects），也没有写盘
    expect(store.snapshot('wid-md-corrupt').failure).toBeNull();
    expect(storage.written).toEqual([]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('puppet 解析失败'))).toBe(true);
    warn.mockRestore();
    r.dispose();
  });
});
// 对象级脚本接线（2026-10-20）：3765967112 的 angles.script 被 render 收集，纹理动画回调
// 落到本次装配的 player（pause/play/setFrame/getFrame）。执行本身的覆盖在 scene-script-host.test.ts。
describe('对象级脚本 → player 纹理动画接线', () => {
  it('render 把 angles.script 交给 SceneScriptHost，并把纹理动画回调接到 player', async () => {
    const scene = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 3840, height: 2160 } },
      objects: [{
        id: 123, name: 'Day/Night (Click)', image: 'models/workshop/x/dayNightToggleSprite.json',
        origin: '1882.8114 1551.4239 0', scale: '0.2 0.2 0.2', size: '256 256',
        angles: {
          script: 'export function init(){ thisLayer.getTextureAnimation().pause(); }',
          scriptproperties: { dayStart: 0, nightStart: 12 },
          value: '0 0 0',
        },
      }],
    });
    stubAssetFetch(scene, {});
    vi.mocked(resolveImageAssets).mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null } as never);
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(),
      setParallax: vi.fn(), setParallaxPointer: vi.fn(), setObjectEffectStage: vi.fn(),
      isolatedObjects: () => [], scene: new THREE.Scene(), renderer: {},
      pauseSpriteSheet: vi.fn(), playSpriteSheet: vi.fn(), stopSpriteSheet: vi.fn(),
      isSpriteSheetPlaying: vi.fn(() => false), setSpriteSheetFrame: vi.fn(), getSpriteSheetFrame: vi.fn(() => 2),
    };
    vi.mocked(loadSceneToThree).mockReturnValue({
      player, sims: [], backgroundIds: [0], particleLayers: [], puppetLayers: [],
    } as never);

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('3765967112', document.createElement('canvas'));

    const opts = vi.mocked(SceneScriptHost.create).mock.calls[0]![0];
    expect(opts.scripts.map((s) => s.objectId)).toEqual([123]);
    expect(opts.scripts[0]!.source).toContain('getTextureAnimation');
    expect(opts.scripts[0]!.scriptProperties).toEqual({ dayStart: 0, nightStart: 12 });
    expect(opts.scripts[0]!.property).toBe('angles'); // 属性脚本契约（update 收/回 Vec3）
    expect(opts.wallpaperId).toBe('3765967112');       // localStorage 按壁纸隔离
    const tex = opts.textureAnimation!;
    tex.pause(123);
    tex.play(123);
    tex.stop(123);
    tex.setFrame(123, 2);
    expect(player.pauseSpriteSheet).toHaveBeenCalledWith(123);
    expect(player.playSpriteSheet).toHaveBeenCalledWith(123);
    expect(player.stopSpriteSheet).toHaveBeenCalledWith(123);
    expect(player.setSpriteSheetFrame).toHaveBeenCalledWith(123, 2);
    expect(tex.isPlaying(123)).toBe(false);
    expect(tex.getFrame(123)).toBe(2);
    r.dispose?.();
  });
});

// T4.4：assembled userProps = localStorage override ?? host 默认值；属性级 condition 不满足时
// 该属性视为不可用（回退作者 value，spec §4.1）。
describe('用户属性默认值与属性级 condition 接线', () => {
  it('未覆盖时用 project 默认值；condition 不满足 ⇒ 回退作者值', async () => {
    const scene = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 1920, height: 1080 } },
      objects: [
        {
          id: 1, name: 'bg', image: 'models/a.json', origin: '960 540 0', scale: '1 1 1',
          color: { user: 'color1', value: '1 1 1' },
        },
        // flag 必须被 scene 引用（host 只返回被引用属性）——作为 condition 的依赖键。
        { id: 2, name: 'ctl', image: 'models/b.json', origin: '0 0 0', scale: '1 1 1', visible: { user: 'flag', value: true } },
      ],
    });
    const properties = {
      properties: [
        {
          key: 'color1', label: 'C', order: 1, usedBy: ['objects[].color'],
          type: 'color', value: '0 1 0', condition: 'flag.value==true',
        },
        { key: 'flag', label: 'F', order: 2, usedBy: ['objects[].visible'], type: 'bool', value: true },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('name=scene.json')) return { ok: true, text: async () => scene };
      if (u.includes('/wallpapers/properties')) return { ok: true, json: async () => properties };
      return { ok: false, text: async () => '' };
    }));
    vi.mocked(resolveImageAssets).mockResolvedValue({ texture: fakeTexture() as never, puppetPath: null, spriteSheet: false });
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setFrameCapture: vi.fn(),
      setParallax: vi.fn(), setParallaxPointer: vi.fn(), setObjectEffectStage: vi.fn(),
      isolatedObjects: () => [],
    };
    vi.mocked(loadSceneToThree).mockReturnValue({
      player, sims: [], backgroundIds: [0, 1], particleLayers: [], puppetLayers: [],
    } as never);

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm, getTextScriptRuntime: async () => null });
    expect(await r.render('wid-cond', document.createElement('canvas'), undefined)).toBe(true);
    // 默认值生效：color 用户值 "0 1 0" → 0-255 三元组。
    expect((vi.mocked(resolveImageAssets).mock.calls[0]![1] as any).color).toEqual([0, 255, 0]);

    // localStorage 覆盖 flag=false ⇒ condition 不满足 ⇒ color1 视为不可用 → 作者值。
    localStorage.setItem('we:userprop:wid-cond:flag', 'false');
    expect(await r.render('wid-cond', document.createElement('canvas'), undefined)).toBe(true);
    const after = vi.mocked(resolveImageAssets).mock.calls.slice(2).find((c) => (c[1] as any).id === 1)!;
    expect((after[1] as any).color).toEqual([255, 255, 255]);

    localStorage.removeItem('we:userprop:wid-cond:flag');
    r.dispose?.();
  });
});
