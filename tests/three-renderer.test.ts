// @vitest-environment jsdom
// Task 5：`createThreeSceneRenderer` 生产接线测试。three-renderer 是薄装配层：把 scene.json
// 解析 + 背景纹理（resolveImageTexture）+ 粒子条件（spec/tex/blend）+ wasm CpuParticleSim 工厂
// 组装成 `loadSceneToThree` 的 `SceneAssets`。本测试 mock 所有重模块（fetch/wasm/tex-loader/
// 纹理推导），聚焦装配正确性：
//   - render 解析 scene.json 并为每个 image/particle 对象组装 assets；
//   - createParticleSim 工厂调用 wasm `CpuParticleSim.new`（失败 → 空 sim 兜底）；
//   - 零背景 + 零粒子 → render 返回 false（controller 落 preview）；
//   - dispose 释放播放器。
import { describe, expect, it, vi, beforeEach } from 'vitest';

// mock 重模块（three-renderer 的依赖）。type 导入在运行时被擦除，vi.mock 只替换运行时值。
vi.mock('../src/client/threejs-player.js', () => ({
  loadSceneToThree: vi.fn(),
}));
vi.mock('../src/client/scene-renderer.js', () => ({
  resolveImageTexture: vi.fn(),
}));
vi.mock('../src/client/tex-loader.js', () => ({
  loadTexTexture: vi.fn(),
}));
vi.mock('../src/client/wasm-renderer.js', () => ({
  defaultLoadWasm: vi.fn(),
  resolveParticleMaterial: vi.fn(),
}));

import { loadSceneToThree } from '../src/client/threejs-player.js';
import { resolveImageTexture } from '../src/client/scene-renderer.js';
import { loadTexTexture } from '../src/client/tex-loader.js';
import { defaultLoadWasm, resolveParticleMaterial } from '../src/client/wasm-renderer.js';
import { createThreeSceneRenderer, particleBlend } from '../src/client/three-renderer.js';

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

function makeMockSim() {
  return {
    update: vi.fn(),
    vertices: vi.fn(() => new Float32Array(0)),
    frame_count: vi.fn(() => 4),
    set_frame_count: vi.fn(),
    particle_count: vi.fn(() => 0),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
    resolveImageTexture.mockResolvedValue({ fake: true } as any);
    // 材质 json 不可得（null）→ 回退材质名启发式：spec 材质名含 "lightshaft" → additive。
    resolveParticleMaterial.mockResolvedValue(null);
    const sim = makeMockSim();
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => sim) } } as any);
    loadSceneToThree.mockReturnValue({
      player: { dispose: vi.fn(), resize: vi.fn() },
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
    expect(assets.backgroundTextures.get(13)).toEqual({ fake: true });
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

  it('render：混合模式取材质 json 的 passes[0].blending（DK 44 层根因回归）——材质名不带 "additive" 也是 additive', async () => {
    resolveImageTexture.mockResolvedValue({ fake: true } as any);
    // DK WOTLK 的真实形态：spec.material 路径名不含 lightshaft/glow/additive，但材质 json 是 additive。
    resolveParticleMaterial.mockResolvedValue({
      texUrl: '/wallpapers/static/ptex-chromaticdot.tex',
      blending: 'additive',
    });
    const tex = { fakeTex: true };
    loadTexTexture.mockResolvedValue(tex as any);
    const sim = makeMockSim();
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => sim) } } as any);
    loadSceneToThree.mockReturnValue({
      player: { dispose: vi.fn(), resize: vi.fn() },
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
    // 纹理经 texUrl → loadTexTexture 装配。
    expect(loadTexTexture).toHaveBeenCalledWith('/wallpapers/static/ptex-chromaticdot.tex');
    expect(assets.particles.get(71).tex).toBe(tex);
    r.dispose();
  });

  it('render：CpuParticleSim.new 抛错 → 工厂返回空 sim（不整场失败）', async () => {
    resolveParticleMaterial.mockResolvedValue(null);
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => { throw new Error('bad spec'); }) } } as any);
    loadSceneToThree.mockReturnValue({ player: { dispose: vi.fn() }, sims: [], backgroundIds: [0], particleLayers: [] });

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
    loadSceneToThree.mockReturnValue({ player: { dispose: vi.fn() }, sims: [], backgroundIds: [], particleLayers: [] });

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    const ok = await r.render('2851992662', document.createElement('canvas'), null);
    expect(ok).toBe(false);
  });

  it('窗口 resize → player.resize 用新窗口比例重推 cover（监听在 render 后注册、dispose 移除）', async () => {
    resolveImageTexture.mockResolvedValue({ fake: true } as any);
    resolveParticleMaterial.mockResolvedValue(null);
    // 模拟返回带 resize 的 player（真实 ThreeScenePlayer 的接口）。
    const player = { dispose: vi.fn(), resize: vi.fn() };
    defaultLoadWasm.mockResolvedValue({ CpuParticleSim: { new: vi.fn(() => makeMockSim()) } } as any);
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0], particleLayers: [] });

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    await r.render('2851992662', document.createElement('canvas'), null);
    // render 注册监听后改变窗口尺寸 → 触发 resize → 播放器按新窗口比例重推 cover。
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    window.dispatchEvent(new Event('resize'));
    expect(player.resize).toHaveBeenCalledWith(1600, 900);

    // dispose 移除监听：再次 resize 不再调用 player.resize。
    r.dispose();
    const callsAfterDispose = player.resize.mock.calls.length;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720 });
    window.dispatchEvent(new Event('resize'));
    expect(player.resize.mock.calls.length).toBe(callsAfterDispose);
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
      player: { dispose: vi.fn(), resize: vi.fn() },
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
