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

import * as THREE from 'three';
import { loadSceneToThree } from '../src/client/threejs-player.js';
import { resolveImageTexture } from '../src/client/scene-renderer.js';
import { loadTexTexture } from '../src/client/tex-loader.js';
import { defaultLoadWasm, resolveParticleMaterial } from '../src/client/wasm-renderer.js';
import { createThreeSceneRenderer, particleBlend, collectObjectEffectChains } from '../src/client/three-renderer.js';
import { ObjectEffectStage } from '../src/client/object-effects.js';
import type { CompiledEffectPass } from '../src/client/shader/effect-chain.js';

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
    resolveImageTexture.mockResolvedValue(fakeTexture() as any);
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
      player: { dispose: vi.fn(), resize: vi.fn() },
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
    // 纹理经 texUrl → loadTexTexture 装配（host 路由 /wallpapers/particle-texture）。
    expect(loadTexTexture).toHaveBeenCalledWith('/wallpapers/particle-texture?name=particle%2Fchromaticdot');
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
    resolveImageTexture.mockResolvedValue(fakeTexture() as any);
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

// ===== Task 5：对象级效果链的解析与本路径接线 =====
// 本文件不 mock effect-runner：新增用例要么不建 runner（具名 RT 图链整条跳过），要么把
// ObjectEffectStage 的挂载方法替换成 spy（不触碰 WebGL）。

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

// 具名 RT 图链（pass 写出具名 RT → `isLinearEffectChain` 判为 false，执行器整条跳过）：
// 与真实库里的 blur / blurprecise / bloom 同形，供「这类对象不值得隔离」的用例（F2）使用。
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
});

// 修正 D：`onViewportResize` 旧实现以 `if (!entry.runner) continue;` 开头，「链全被跳过、
// 因而没有 runner 的隔离对象」不再随视口重设 RT（视口放大偏糊、缩小超额占显存）。
describe('ObjectEffectStage.onViewportResize（无 runner 的隔离对象也要重设 RT）', () => {
  it('链全被跳过（无 runner）→ 按新预算重设 RT，但不回退输出', () => {
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', screenScale: 1,
    });
    // 契约顺序：先 setWorldSize（世界尺寸唯一来源），再 setObjectChains 传**具名 RT 图链**
    // （整条跳过 → 该对象有隔离条目与世界尺寸，但没有 runner）。
    stage.setWorldSize(1, 50, 25);
    stage.setObjectChains(1, [[fxPass({ target: '_rt_a' })]]);
    expect(stage.debugRunners().has(1)).toBe(false);
    // 世界 50×25 @密度 0.4 → 屏占位 20×10
    stage.onViewportResize(0.4);
    expect(resized).toEqual([{ id: 1, w: 20, h: 10 }]);
    // 没有 runner 就没有「重挂链后 quad 采样已 dispose 纹理」的问题 → 不得动输出。
    expect(outputs).toEqual([]);
    warn.mockRestore();
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

  // F2（终审 I2）：isolate 准入从「有链」收紧为「至少有一条线性链」。链**全为具名 RT 图链**时
  // `setObjectChains` 整条跳过（不建 runner），对象 RT 的显存与每帧一次额外渲染 + 一次 RT 切换
  // 完全没有收益，而 quad 永远采样 RT 原图 ⇒ 隔离没有额外视觉收益（纯浪费）。
  it('链全为具名 RT 图链的对象不进 isolate；线性对象（含 colorBlendMode=7）照常隔离', async () => {
    stubAssetFetch(sceneWith([
      {
        id: 13, name: 'rtgraph', image: 'models/a.json',
        origin: '960 540 0', scale: '1 1 1', size: '3840 2160',
        effects: [{ file: 'effects/rtg/effect.json' }],
      },
      {
        id: 60, name: 'linear', image: 'models/b.json',
        origin: '960 540 0', scale: '1 1 1', size: '1920 1080',
        effects: [{ file: 'effects/w/effect.json' }],
      },
      {
        id: 246, name: 'Clouds Back', image: 'models/clouds.json',
        origin: '960 540 0', scale: '1 1 1', size: '1920 1080', colorBlendMode: 7,
        effects: [{ file: 'effects/w/effect.json' }],
      },
    ]), FX_FILES_RT_GRAPH);
    resolveImageTexture.mockResolvedValue(fakeTexture() as never);
    defaultLoadWasm.mockResolvedValue(null);
    const player = {
      dispose: vi.fn(), resize: vi.fn(), setObjectEffectStage: vi.fn(),
      renderer: {},
      // 真实 player 只会为 isolate 里的对象建隔离条目 → 这里也只有线性链的 60。
      isolatedObjects: () => [{ id: 60, kind: 'background', rtWidth: 1920, rtHeight: 1080, rtTexture: {} }],
    };
    loadSceneToThree.mockReturnValue({ player, sims: [], backgroundIds: [0, 1, 2], particleLayers: [] } as never);
    const worldSpy = vi.spyOn(ObjectEffectStage.prototype, 'setWorldSize').mockImplementation(() => {});
    const chainsSpy = vi.spyOn(ObjectEffectStage.prototype, 'setObjectChains').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = createThreeSceneRenderer({ loadWasm: defaultLoadWasm });
    const ok = await r.render('2132420420', document.createElement('canvas'), null);
    expect(ok).toBe(true);

    const assets = loadSceneToThree.mock.calls[0][1];
    // ① 具名 RT 图链对象不隔离（不再为注定被跳过的链白付一张 3840×2160 对象 RT + 每帧额外渲染）；
    // ② 线性链对象照常隔离挂链（收紧准入不得误伤正常对象）；
    // ③ colorBlendMode ∈ {6,7,31} 的对象同样隔离（旧守卫已删，混合语义搬到合成 quad）。
    expect(assets.isolate.has(13)).toBe(false);
    expect(assets.isolate.has(60)).toBe(true);
    expect(assets.isolate.has(246)).toBe(true);
    expect(worldSpy.mock.calls.map((c) => c[0])).toEqual([60, 246]);
    expect(chainsSpy.mock.calls.map((c) => c[0])).toEqual([60, 246]);
    // 降级告警仍在（收紧准入不等于让「效果被跳过」在诊断上消失），且带上具名 RT 标识；
    // 也不并入「挂在未参与渲染的对象类型上」的汇总告警——该对象照常渲染，原因不同。
    const rtGraph = warn.mock.calls.filter((c) => String(c[0]).includes('效果需要具名 RT'));
    expect(rtGraph).toHaveLength(1);
    expect(String(rtGraph[0][0])).toContain('_rt_blur');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('未参与渲染'))).toBe(false);

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
