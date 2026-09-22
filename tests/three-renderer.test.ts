// @vitest-environment jsdom
// Task 5：`createThreeSceneRenderer` 生产接线测试。three-renderer 是薄装配层：把 scene.json
// 解析 + 背景纹理（resolveImageTexture）+ 粒子条件（spec/tex/blend）+ wasm CpuParticleSim 工厂
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
  resolveImageTexture: vi.fn(),
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

import * as THREE from 'three';
import { loadSceneToThree } from '../src/client/threejs-player.js';
import { resolveImageTexture, resolveParticleMaterial } from '../src/client/scene-assets.js';
import { loadTexTexture } from '../src/client/tex-loader.js';
import { defaultLoadWasm } from '../src/client/wasm-loader.js';
import { createThreeSceneRenderer, particleBlend, collectObjectEffectChains, collectScriptSources, lastWorldTransformOf } from '../src/client/three-renderer.js';
import { parseSceneJson } from '../src/client/scene-json.js';
import { createGlowStage } from '../src/client/glow-stage.js';
import { setSettingsCtx } from '../src/client/settings.js';
import { ObjectEffectStage } from '../src/client/object-effects.js';
import type { CompiledEffectPass } from '../src/client/shader/effect-chain.js';
import type { ClientSettings } from '../src/client/types.js';

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
});

describe('createThreeSceneRenderer', () => {
  it('render：解析 scene.json → 为 image 对象组装背景纹理、particle 对象组装 spec/tex/blend', async () => {
    resolveImageTexture.mockResolvedValue(fakeTexture() as any);
    // 材质 json 不可得（null）→ 回退材质名启发式：spec 材质名含 "lightshaft" → additive。
    resolveParticleMaterial.mockResolvedValue(null);
    const sim = makeMockSim();
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => sim) } } as any);
    loadSceneToThree.mockReturnValue({
      player: { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn() },
      sims: [sim],
      backgroundIds: [0],
      particleLayers: [{ id: 1, sim }],
    });

    const canvas = document.createElement('canvas');
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    const ok = await r.render('2851992662', canvas, null);

    expect(ok).toBe(true);
    expect(resolveImageTexture).toHaveBeenCalledTimes(1);
    expect(resolveImageTexture.mock.calls[0][0]).toBe('2851992662');
    expect(resolveImageTexture.mock.calls[0][1].id).toBe(13);
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

  it('dispose / 切壁纸时释放本次装配的背景纹理（视频纹理的 <video>/Blob URL 不能被 renderer.dispose 兜住）', async () => {
    // 视频纹理把 `<video>` + Blob URL 挂在纹理的 dispose 事件上，GPU 侧释放不会停解码
    // ⇒ 壁纸切换必须显式 texture.dispose()（见 AGENT.md §5.23）。
    const texA = { dispose: vi.fn() };
    const texB = { dispose: vi.fn() };
    resolveImageTexture.mockResolvedValue(texA as any);
    loadSceneToThree.mockReturnValue({
      player: { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn() },
      sims: [], backgroundIds: [0], particleLayers: [],
    });
    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('2851992662', document.createElement('canvas'), null);
    expect(texA.dispose).not.toHaveBeenCalled(); // 首次装配：纹理仍在使用

    // 切到另一张壁纸（render 先 teardown 上一次）→ 上一次的纹理被释放
    resolveImageTexture.mockResolvedValue(texB as any);
    await r.render('2851992662', document.createElement('canvas'), null);
    expect(texA.dispose).toHaveBeenCalledTimes(1);
    expect(texB.dispose).not.toHaveBeenCalled();

    r.dispose();
    expect(texB.dispose).toHaveBeenCalledTimes(1);
  });

  it('render：混合模式取材质 json 的 passes[0].blending（DK 44 层根因回归）——材质名不带 "additive" 也是 additive', async () => {
    resolveImageTexture.mockResolvedValue(fakeTexture() as any);
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
      player: { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn() },
      sims: [sim],
      backgroundIds: [0],
      particleLayers: [{ id: 1, sim }],
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

  it('render：CpuParticleSim.new 抛错 → 工厂返回空 sim（不整场失败）', async () => {
    resolveParticleMaterial.mockResolvedValue(null);
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => { throw new Error('bad spec'); }) } } as any);
    loadSceneToThree.mockReturnValue({ player: { dispose: vi.fn(), setGlowStage: vi.fn() }, sims: [], backgroundIds: [0], particleLayers: [] });

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
    resolveImageTexture.mockResolvedValue(null);
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => makeMockSim()) } } as any);
    loadSceneToThree.mockReturnValue({ player: { dispose: vi.fn(), setGlowStage: vi.fn() }, sims: [], backgroundIds: [], particleLayers: [] });

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    const ok = await r.render('2851992662', document.createElement('canvas'), null);
    expect(ok).toBe(false);
  });

  it('窗口 resize → player.resize 用新窗口比例重推 cover（监听在 render 后注册、dispose 移除）', async () => {
    resolveImageTexture.mockResolvedValue(fakeTexture() as any);
    resolveParticleMaterial.mockResolvedValue(null);
    // 模拟返回带 resize 的 player（真实 ThreeScenePlayer 的接口）。
    const player = { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn() };
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => makeMockSim()) } } as any);
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [] });

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
    resolveImageTexture.mockResolvedValue(fakeTexture() as any);
    resolveParticleMaterial.mockResolvedValue(null);
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => makeMockSim()) } } as any);
    const player = { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn() };
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [] } as any);
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
          return { player, sims: [], backgroundIds: [0], particleLayers: [] };
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
      player: { dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn() },
      sims: [sim],
      backgroundIds: [],
      particleLayers: [{ id: 0, sim }],
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
  it('按对象收集 effects 并解析为链；无效对象（无 effects / text）被跳过', async () => {
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
    resolveImageTexture.mockResolvedValue(fakeTexture() as never);
    defaultLoadWasm.mockResolvedValue(null); // 无粒子模块（本用例无粒子对象）
    const setObjectEffectStage = vi.fn();
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage,
      setGlowStage: vi.fn(),
      renderer: {},
      // 隔离条目的键 = 对象 id（真实 player 由 attachIsolated(obj.id) 建条目）。
      isolatedObjects: () => [{ id: 13, kind: 'background', rtWidth: 1920, rtHeight: 1080, rtTexture: {} }],
      // 屏幕密度的**唯一来源**是 player 自己（与 applyCover 同一套 state）：这里用哨兵值 0.5
      // 证明 resize 回调是把 player 的值**原样**转给 stage，而不是自己另算一份。
      screenScalePx: vi.fn(() => 0.5),
    };
    loadSceneToThree.mockReturnValue({
      player, sims: [], backgroundIds: [0, 1], particleLayers: [],
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
    // stage 的键 = 对象 id（13），不是图层计数器 id（带效果的对象是第 2 个 image → 旧实现为 1）。
    expect(worldSpy.mock.calls).toEqual([[13, 3840, 2160]]);
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

  // 省电与画质档位（2026-09-21）：状态跨 render 保留；装配即应用；改档位要同步屏幕密度给 stage。
  it('setPaused / setQualityScale：无 player 时记状态、装配即暂停；有 player 时即时下发并同步屏幕密度给 stage', async () => {
    stubSettings({ glowEnabled: false });
    stubAssetFetch(sceneWithEffects({
      id: 13, name: 'bg', image: 'models/a.json',
      origin: '960 540 0', scale: '1 1 1', size: '1920 1080',
      effects: [{ file: 'effects/w/effect.json' }],
    }), FX_FILES);
    resolveImageTexture.mockResolvedValue(fakeTexture() as never);
    defaultLoadWasm.mockResolvedValue(null);
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage: vi.fn(),
      setGlowStage: vi.fn(),
      renderer: {},
      isolatedObjects: () => [{ id: 13, kind: 'background', rtWidth: 1920, rtHeight: 1080, rtTexture: {} }],
      screenScalePx: vi.fn(() => 0.5),
      pause: vi.fn(), resume: vi.fn(), setQualityScale: vi.fn(),
    };
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [] } as never);
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
      setGlowStage: vi.fn(),
      renderer: {},
      isolatedObjects: () => [{ id: 71, kind: 'particle', rtWidth: 400, rtHeight: 400, rtTexture: {} }],
    };
    loadSceneToThree.mockReturnValue({
      player, sims: [sim], backgroundIds: [], particleLayers: [{ id: 0, sim }],
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
    expect(worldSpy.mock.calls).toEqual([[71, 200, 200]]);
    expect(chainsSpy.mock.calls.map((c) => c[0])).toEqual([71]);

    worldSpy.mockRestore();
    chainsSpy.mockRestore();
    r.dispose();
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
  });

  it('无效果对象：不建 stage、不下发 isolate、帧序与今天一致（零回归）', async () => {
    stubAssetFetch(SCENE, {});
    resolveImageTexture.mockResolvedValue(fakeTexture() as never);
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => makeMockSim()) } } as never);
    const setObjectEffectStage = vi.fn();
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage,
      setGlowStage: vi.fn(),
      renderer: {},
      isolatedObjects: () => [],
    };
    loadSceneToThree.mockReturnValue({
      player, sims: [], backgroundIds: [0], particleLayers: [],
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
    resolveImageTexture.mockResolvedValue(fakeTexture() as never);
    defaultLoadWasm.mockResolvedValue(null);
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage: vi.fn(),
      setGlowStage: vi.fn(),
      renderer: {},
      isolatedObjects: () => [{ id: 13, kind: 'background', rtWidth: 1920, rtHeight: 1080, rtTexture: {} }],
    };
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0, 1], particleLayers: [] } as never);
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
    resolveImageTexture.mockResolvedValue(fakeTexture() as never);
    defaultLoadWasm.mockResolvedValue(null);
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage: vi.fn(),
      setGlowStage: vi.fn(),
      renderer: {},
      // P2 起这类对象进入隔离（真实 player 会为 isolate 里每个对象建条目）
      isolatedObjects: () => [{ id: 13, kind: 'background', rtWidth: 3840, rtHeight: 2160, rtTexture: {} }],
    };
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [] } as never);
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

  // Minor 1：挂在 util（`models/util/*` 合成层/全屏层，loadSceneToThree 不渲染）或音频空粒子对象
  // 上的 effects 既不会被隔离也不会被挂链，此前完全静默——诊断上看不出「效果被丢了」。改为按壁纸
  // 汇总一条 warn（每壁纸一条，不按对象刷屏）。
  it('util 对象上的 effects 无法隔离 → 汇总一条「已跳过」告警（不静默丢弃）', async () => {
    stubAssetFetch(sceneWith([
      {
        id: 13, name: 'bg', image: 'models/a.json',
        origin: '960 540 0', scale: '1 1 1', size: '1920 1080',
        effects: [{ file: 'effects/w/effect.json' }],
      },
      {
        id: 37, name: 'composelayer', image: 'models/util/composelayer.json',
        origin: '0 0 0', scale: '1 1 1',
        effects: [{ file: 'effects/w/effect.json' }, { file: 'effects/w/effect.json' }],
      },
    ]), FX_FILES);
    resolveImageTexture.mockResolvedValue(fakeTexture() as never);
    defaultLoadWasm.mockResolvedValue(null);
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage: vi.fn(),
      setGlowStage: vi.fn(),
      renderer: {},
      isolatedObjects: () => [{ id: 13, kind: 'background', rtWidth: 1920, rtHeight: 1080, rtTexture: {} }],
    };
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0, 1], particleLayers: [] } as never);
    const worldSpy = vi.spyOn(ObjectEffectStage.prototype, 'setWorldSize').mockImplementation(() => {});
    const chainsSpy = vi.spyOn(ObjectEffectStage.prototype, 'setObjectChains').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    const ok = await r.render('2132420420', document.createElement('canvas'), null);
    expect(ok).toBe(true);

    // 汇总一条（util 对象上的 2 条效果），而不是每对象/每条链一条。
    const skipped = warn.mock.calls.filter((c) => String(c[0]).includes('未参与渲染'));
    expect(skipped).toHaveLength(1);
    expect(String(skipped[0][0])).toContain('2 条效果');
    // 能隔离的对象照常挂链，不受汇总告警影响。
    expect(chainsSpy.mock.calls.map((c) => c[0])).toEqual([13]);
    expect(loadSceneToThree.mock.calls[0][1].isolate.has(37)).toBe(false);

    worldSpy.mockRestore();
    chainsSpy.mockRestore();
    warn.mockRestore();
    r.dispose();
  });
});

// ── 对侧回归（审查 Important 1）：真实 loadSceneToThree 与 renderer 走同一条链路 ──────────────
// 上面这些用例把整个 `threejs-player.js` mock 掉，于是「renderer 传出的键」与「player 实际建的
// 隔离条目 id」被同一条 mock 一起隔离——两边都写错也全绿。本用例用 `vi.importActual` 跑**真实**的
// loadSceneToThree（注入 mock renderer，写法对齐 tests/threejs-player.test.ts），断言：
//   ① 真实 player 的 `isolatedObjects()` 里存在 `id === 对象 id` 的条目；
//   ② ObjectEffectStage 收到的键就是同一个对象 id，且**找到了**该隔离条目（否则只会打印
//      「尚无隔离条目，效果链未挂载（调用顺序错误）」）。
// 任何一侧改动建层条件/顺序（或键空间再漂移）都会让本用例变红。
describe('对象级效果链接线（真实 loadSceneToThree 对侧校验）', () => {
  // jsdom 无 WebGL：真实 WebGLRenderer 构造即抛错，注入只覆盖 player 用到的接口。
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
    resolveImageTexture.mockResolvedValue(new THREE.DataTexture(new Uint8Array(4), 1, 1) as never);
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
      dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setObjectEffectStage: vi.fn(),
      isolatedObjects: () => [],
    };
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [] } as never);
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

  it('clock 脚本的 text → 下发 textLayers（纹理 + 每帧驱动），初始文本即时钟格式而非占位值', async () => {
    stubAssetFetch(sceneWithText({ text: { value: '12:34', script: CLOCK_SCRIPT } }), {});
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

  it('非 clock 文本 → 有纹理、无驱动（静态文本不动）', async () => {
    stubAssetFetch(sceneWithText({ text: { value: 'HELLO' } }), {});
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
      dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setObjectEffectStage: vi.fn(),
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
    resolveImageTexture.mockResolvedValue(fakeTexture() as never);
    loadSceneToThree.mockReturnValue({ player: scriptPlayer(), sims: [], backgroundIds: [0, 1], particleLayers: [] } as never);

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
    resolveImageTexture.mockResolvedValue(fakeTexture() as never);
    loadSceneToThree.mockReturnValue({ player: scriptPlayer(), sims: [], backgroundIds: [0], particleLayers: [] } as never);

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
    resolveImageTexture.mockResolvedValue(new THREE.DataTexture(new Uint8Array(4), 1, 1) as never);
    loadSceneToThree.mockReturnValue({ player: scriptPlayer(), sims: [], backgroundIds: [0], particleLayers: [] } as never);

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
});
