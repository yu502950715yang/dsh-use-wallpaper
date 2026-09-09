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
  resolveParticleTexUrl: vi.fn(),
}));

import { loadSceneToThree } from '../src/client/threejs-player.js';
import { resolveImageTexture } from '../src/client/scene-renderer.js';
import { defaultLoadWasm, resolveParticleTexUrl } from '../src/client/wasm-renderer.js';
import { createThreeSceneRenderer } from '../src/client/three-renderer.js';

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
    resolveParticleTexUrl.mockResolvedValue('/wallpapers/static/ptex-foo.tex');
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
    // 粒子条件：spec + tex（经 resolveParticleTexUrl → loadTexTexture）+ blend（material 含 lightshaft → additive）
    expect(resolveParticleTexUrl).toHaveBeenCalledTimes(1);
    expect(resolveParticleTexUrl.mock.calls[0][0]).toBe('2851992662');
    expect(resolveParticleTexUrl.mock.calls[0][1]).toContain('lightshaft');
    expect(loadSceneToThree).toHaveBeenCalledTimes(1);
    const assets = loadSceneToThree.mock.calls[0][1];
    // Task5：viewport 第 4 参 = 窗口/视口尺寸（窗口比例），而非场景尺寸——cover 相机按窗口宽高比
    // 裁剪（背景不变形），对照 wasm 路径用 window.innerWidth/Height 推 cover。
    expect(loadSceneToThree.mock.calls[0][3]).toEqual({ width: 1920, height: 1080 });
    expect(assets.backgroundTextures.get(13)).toEqual({ fake: true });
    expect(assets.particles.get(71).specJson).toContain('lightshaft');
    // material 名含 "lightshaft" → blend = additive
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

  it('render：CpuParticleSim.new 抛错 → 工厂返回空 sim（不整场失败）', async () => {
    resolveParticleTexUrl.mockResolvedValue(null);
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
    resolveParticleTexUrl.mockResolvedValue(null);
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
