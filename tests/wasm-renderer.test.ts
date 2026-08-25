// @vitest-environment jsdom
// Task 8：wasm 渲染器胶水的回退逻辑与 API 调用顺序（jsdom）。
// - 无 WebGPU（navigator.gpu 缺失）→ createWasmSceneRenderer() 返回 null（走现有 JS 渲染回退）
// - loadWasm 注入失败（null / reject）→ render() resolve false（组合层降级到 JS 渲染器）
// - 组合回退链（createFallbackSceneRenderer）：wasm 失败 → JS 渲染器；JS 也失败 → false
//   → controller 走 preview 图回退（spec §7 第 2/3 条）
// - 成功路径：scene.json → 对象遍历（image → model.json → material → .tex；particle）→
//   WeScene.create / load_scene / load_image / add_particle / step / render 按序调用
// - Task 2.1：hasEffectChains 效果链检测（任一对象 effects?.length > 0 → true）；
//   wasm 渲染器无效果链执行器，检测到效果链 → render() 在 WeScene.create（绑定 GPU）
//   之前返回 false，走 controller 的 canvas 重建 → JS 渲染器回退链
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseSceneJson } from '../src/client/scene-json.js';
import { createWasmSceneRenderer, createFallbackSceneRenderer, hasEffectChains } from '../src/client/wasm-renderer.js';

function jsonResp(body: unknown): any {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

// 典型场景：2400×1555 正交视口 + 1 个 image 对象 + 1 个 particle 对象
// （T4.1：image 对象 alignment='bottomright'、size 400×300、scale 1 → 传给 wasm 的
// origin 须预偏移为锚点对应中心 [-100, 50, 0]；Rust 保持「origin=中心」约定不改）
const SCENE_JSON_TEXT = JSON.stringify({
  camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
  general: { orthogonalprojection: { width: 2400, height: 1555 } },
  objects: [
    { id: 12, name: 'bg', image: 'models/m.json', origin: '100 200 0', scale: '1 1 1', size: '400 300', alignment: 'bottomright' },
    { id: 18, name: 'rays', particle: 'particles/p.json', origin: '10 20 0', scale: '2 2 1' },
  ],
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Task 2.1：效果链检测（纯函数）。scene.json 经 parseSceneJson 解析后 effects 保留在对象上
// （Array.isArray ? effects : undefined），检测只需判断任一对象 effects?.length > 0。
function descWithObjects(objects: unknown[]): any {
  return parseSceneJson(JSON.stringify({ general: { orthogonalprojection: { width: 100, height: 100 } }, objects }));
}

describe('hasEffectChains', () => {
  it('任一对象含非空 effects → true', () => {
    const desc = descWithObjects([{ id: 1, name: 'a', image: 'models/a.json', effects: [{ id: 1 }] }]);
    expect(hasEffectChains(desc)).toBe(true);
  });

  it('effects 挂在非首对象（particle 对象）上也返回 true', () => {
    const desc = descWithObjects([
      { id: 1, name: 'a', image: 'models/a.json' },
      { id: 2, name: 'b', particle: 'particles/p.json', effects: [{ id: 7, type: 'godrays' }] },
    ]);
    expect(hasEffectChains(desc)).toBe(true);
  });

  it('无 effects 字段 → false', () => {
    const desc = descWithObjects([{ id: 1, name: 'a', image: 'models/a.json' }]);
    expect(hasEffectChains(desc)).toBe(false);
  });

  it('effects 为空数组 → false', () => {
    const desc = descWithObjects([{ id: 1, name: 'a', image: 'models/a.json', effects: [] }]);
    expect(hasEffectChains(desc)).toBe(false);
  });

  it('effects 非数组（null）→ false（parseSceneJson 归并为 undefined）', () => {
    const desc = descWithObjects([{ id: 1, name: 'a', image: 'models/a.json', effects: null }]);
    expect(hasEffectChains(desc)).toBe(false);
  });

  it('无对象 → false', () => {
    expect(hasEffectChains(descWithObjects([]))).toBe(false);
  });
});

describe('createWasmSceneRenderer', () => {
  it('无 WebGPU（navigator.gpu 缺失）时返回 null，走现有 JS 渲染回退', () => {
    vi.stubGlobal('navigator', { gpu: undefined });
    expect(createWasmSceneRenderer()).toBeNull();
  });

  it('navigator 缺失（SSR/极端环境）时返回 null', () => {
    const saved = (globalThis as any).navigator;
    Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
    try {
      expect(createWasmSceneRenderer()).toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'navigator', { value: saved, configurable: true });
    }
  });

  it('wasm 模块加载返回 null 时 render() resolve false', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const r = createWasmSceneRenderer({ loadWasm: async () => null });
    expect(r).not.toBeNull();
    const fg = document.createElement('canvas');
    await expect(r!.render('1', fg)).resolves.toBe(false);
  });

  it('wasm 模块加载 reject 时 render() resolve false', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const r = createWasmSceneRenderer({
      loadWasm: async () => {
        throw new Error('load fail');
      },
    });
    const fg = document.createElement('canvas');
    await expect(r!.render('1', fg)).resolves.toBe(false);
  });

  it('scene.json 拉取失败时 render() resolve false', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 } as any)));
    const r = createWasmSceneRenderer({
      loadWasm: async () => ({ default: async () => {}, WeScene: { create: async () => ({}) } } as any),
    });
    const fg = document.createElement('canvas');
    await expect(r!.render('1', fg)).resolves.toBe(false);
  });

  it('对象全部加载失败时 render() resolve false（不启动帧循环）', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const sceneJson = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 2400, height: 1555 } },
      objects: [{ id: 1, name: 'a', image: 'models/missing.json', origin: '0 0 0', scale: '1 1 1' }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('scene.json')) return jsonResp(sceneJson);
        return { ok: false, status: 404, json: async () => ({}) } as any;
      }),
    );
    const scene = { set_cover: vi.fn(), load_scene: vi.fn(), load_image: vi.fn(), add_particle: vi.fn(), step: vi.fn(), render: vi.fn() };
    const r = createWasmSceneRenderer({
      loadWasm: async () => ({ default: async () => {}, WeScene: { create: async () => scene } } as any),
    });
    const fg = document.createElement('canvas');
    await expect(r!.render('1', fg)).resolves.toBe(false);
    expect(scene.load_image).not.toHaveBeenCalled();
  });

  it('场景含效果链 → 不再拦截（2026-08-21 决策：强制 wasm，禁用 JS 回退）→ 继续 wasm 渲染流程', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const sceneJson = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 2400, height: 1555 } },
      objects: [
        { id: 12, name: 'bg', image: 'models/m.json', effects: [{ id: 1, type: 'godrays' }] },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('scene.json')) return jsonResp(sceneJson);
        return { ok: false, status: 404, json: async () => ({}) } as any;
      }),
    );
    const mod = { default: vi.fn(async () => undefined), WeScene: { create: vi.fn(async () => ({ set_cover: vi.fn(), load_scene: vi.fn() })) } };
    const r = createWasmSceneRenderer({ loadWasm: async () => mod as any });
    const fg = document.createElement('canvas');
    const bg = document.createElement('canvas');
    // 效果链不再拦截：WeScene.create 被调用（进入 wasm 绑定流程）；纹理 404 → rendered=0 → false（preview）
    await expect(r!.render('1', fg, bg)).resolves.toBe(false);
    expect(mod.WeScene.create).toHaveBeenCalled(); // 不再在 create 前拦截返回
  });

  it('成功路径：按序调用 WeScene.create / load_scene / load_image / add_particle 并启动帧循环', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const scene = {
      set_cover: vi.fn(),
      load_scene: vi.fn(),
      load_image: vi.fn(),
      add_particle: vi.fn(),
      step: vi.fn(),
      render: vi.fn(),
      resize: vi.fn(),
      scene_width: () => 2400,
      scene_height: () => 1555,
    };
    const mod = {
      default: vi.fn(async () => undefined),
      WeScene: { create: vi.fn(async () => scene) },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        // asset name 经 encodeURIComponent 编码，'/' → %2F，故用文件名片段匹配
        if (url.includes('name=scene.json')) return jsonResp(SCENE_JSON_TEXT);
        if (url.includes('m.json')) return jsonResp({ material: 'materials/mat.json' });
        if (url.includes('mat.json')) return jsonResp({ passes: [{ textures: ['tex'] }] });
        if (url.includes('tex.tex')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
        if (url.includes('p.json')) return jsonResp({ emitter: [{ rate: 5 }], initializer: [] });
        return { ok: false, status: 404, json: async () => ({}) } as any;
      }),
    );
    const r = createWasmSceneRenderer({ loadWasm: async () => mod });
    const fg = document.createElement('canvas');
    const bg = document.createElement('canvas');
    // 2026-08-21 铺满全屏改造：传 bg 参数验证背景层已移除——renderer 忽略 bg（单层渲染）
    await expect(r!.render('1', fg, bg)).resolves.toBe(true);

    // WeScene.create 用视口尺寸创建（Task 9 修复：surface 与 canvas 属性尺寸 = 视口，
    // 对齐 scene-renderer.setScene 的 vw/vh；jsdom 默认 window.innerWidth=1024/innerHeight=768）
    expect(mod.WeScene.create).toHaveBeenCalledTimes(1); // 仅前景一次，bg 被忽略
    expect(mod.WeScene.create).toHaveBeenCalledWith(fg, 1024, 768);
    expect(fg.width).toBe(1024);
    expect(fg.height).toBe(768);
    // 2026-08-21 铺满全屏改造：前景创建后调用 set_cover（cover 相机 + 场景色清屏，
    // 对齐桌面版默认 FillMode::ASPECTCROP；背景模糊层已移除，无 bgScene 创建）
    expect(scene.set_cover).toHaveBeenCalledTimes(1);
    // load_scene 收到原始 scene.json 文本
    expect(scene.load_scene).toHaveBeenCalledWith(SCENE_JSON_TEXT);
    // image 对象 → 纹理字节直传 wasm（assetId=对象索引，origin/scale/size 为 Float32Array）
    expect(scene.load_image).toHaveBeenCalledTimes(1);
    const [assetId, tex, origin, scale, size] = scene.load_image.mock.calls[0];
    expect(assetId).toBe(0);
    expect(tex).toBeInstanceOf(Uint8Array);
    expect(Array.from(tex)).toEqual([1, 2, 3, 4]);
    // T4.1：alignment='bottomright'、worldSize=[400,300] → origin 预偏移为锚点中心
    // （100 - 400/2, 200 - 300/2, 0）= [-100, 50, 0]；Rust 保持「origin=中心」约定
    expect(Array.from(origin)).toEqual([-100, 50, 0]);
    expect(Array.from(scale)).toEqual([1, 1, 1]);
    expect(Array.from(size)).toEqual([400, 300]);
    // particle 对象 → 规格 json 直传
    expect(scene.add_particle).toHaveBeenCalledTimes(1);
    expect(scene.add_particle.mock.calls[0][0]).toContain('"rate"');
    expect(Array.from(scene.add_particle.mock.calls[0][1])).toEqual([10, 20, 0]);
    expect(Array.from(scene.add_particle.mock.calls[0][2])).toEqual([2, 2, 1]);
    // 帧循环启动：step + render 至少执行一帧
    await vi.waitFor(() => {
      expect(scene.step).toHaveBeenCalled();
      expect(scene.render).toHaveBeenCalled();
    });
  });

  it('粒子对象带材质纹理 → add_particle 收到 TEXV0005 字节（方案 A 粒子纹理，2026-08-21）', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const scene = { set_cover: vi.fn(), load_scene: vi.fn(), load_image: vi.fn(), add_particle: vi.fn(), step: vi.fn(), render: vi.fn() };
    const sceneJson = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 2400, height: 1555 } },
      objects: [{ id: 18, name: 'fog', particle: 'particles/p.json', origin: '10 20 0', scale: '2 2 1' }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('name=scene.json')) return jsonResp(sceneJson);
        if (url.includes('p.json')) return jsonResp({ emitter: [{ rate: 1.5 }], initializer: [], material: 'materials/presets/fog1.json' });
        if (url.includes('fog1.json')) return jsonResp({ passes: [{ textures: ['particle/fog/fog1'] }] });
        if (url.includes('ptex-fog-fog1')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([9, 8, 7, 6]).buffer };
        return { ok: false, status: 404, json: async () => ({}) } as any;
      }),
    );
    const mod = { default: vi.fn(async () => undefined), WeScene: { create: vi.fn(async () => scene) } };
    const r = createWasmSceneRenderer({ loadWasm: async () => mod });
    const fg = document.createElement('canvas');
    await expect(r!.render('1', fg)).resolves.toBe(true);
    expect(scene.add_particle).toHaveBeenCalledTimes(1);
    const texBytes = scene.add_particle.mock.calls[0][3];
    expect(Array.from(texBytes)).toEqual([9, 8, 7, 6]);
  });

  it('粒子材质纹理坏引用（presets/lightshaft）→ 别名映射到真实纹理 ptex-light-light_shafts-0.tex（2026-08-22）', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const scene = { set_cover: vi.fn(), load_scene: vi.fn(), load_image: vi.fn(), add_particle: vi.fn(), step: vi.fn(), render: vi.fn() };
    const sceneJson = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 2400, height: 1555 } },
      objects: [{ id: 18, name: 'light rays', particle: 'particles/p.json', origin: '1551 772 0', scale: '2.2 2.2 1' }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('name=scene.json')) return jsonResp(sceneJson);
        if (url.includes('p.json')) return jsonResp({ emitter: [{ rate: 0.3 }], initializer: [], material: 'materials/presets/lightshaft.json' });
        if (url.includes('lightshaft.json')) return jsonResp({ passes: [{ textures: ['presets/lightshaft'] }] });
        // 别名映射：坏引用 "presets/lightshaft" → 真实纹理 "particle/light/light_shafts_0"
        if (url.includes('ptex-light-light_shafts_0')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
        return { ok: false, status: 404, json: async () => ({}) } as any;
      }),
    );
    const mod = { default: vi.fn(async () => undefined), WeScene: { create: vi.fn(async () => scene) } };
    const r = createWasmSceneRenderer({ loadWasm: async () => mod });
    const fg = document.createElement('canvas');
    await expect(r!.render('1', fg)).resolves.toBe(true);
    expect(scene.add_particle).toHaveBeenCalledTimes(1);
    const texBytes = scene.add_particle.mock.calls[0][3];
    expect(Array.from(texBytes)).toEqual([1, 2, 3, 4]);
  });

  it('粒子材质纹理缺失（静态 ptex 资源 404）→ add_particle 收到空 Uint8Array（纯色兜底）', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const scene = { set_cover: vi.fn(), load_scene: vi.fn(), load_image: vi.fn(), add_particle: vi.fn(), step: vi.fn(), render: vi.fn() };
    const sceneJson = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 2400, height: 1555 } },
      objects: [{ id: 18, name: 'fog', particle: 'particles/p.json', origin: '10 20 0', scale: '2 2 1' }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('name=scene.json')) return jsonResp(sceneJson);
        if (url.includes('p.json')) return jsonResp({ emitter: [{ rate: 1.5 }], initializer: [], material: 'materials/presets/fog1.json' });
        if (url.includes('fog1.json')) return jsonResp({ passes: [{ textures: ['particle/fog/fog1'] }] });
        return { ok: false, status: 404, json: async () => ({}) } as any;
      }),
    );
    const mod = { default: vi.fn(async () => undefined), WeScene: { create: vi.fn(async () => scene) } };
    const r = createWasmSceneRenderer({ loadWasm: async () => mod });
    const fg = document.createElement('canvas');
    await expect(r!.render('1', fg)).resolves.toBe(true);
    const texBytes = scene.add_particle.mock.calls[0][3];
    expect(texBytes).toBeInstanceOf(Uint8Array);
    expect(texBytes.length).toBe(0);
  });

  // T4.2 可见性过滤（wasm 路径补齐）：JS 路径（renderScene）已用 resolveVisibility 过滤
  // visibleObjects；wasm 路径此前遍历 desc.objects 不过滤 → 不可见对象仍渲染（行为不一致）。
  // 修复：render() 对象循环内用 resolveVisibility(obj, {}) 跳过不可见对象——wasm 无用户
  // 属性注入（settings 查询仅 JS 路径有），传 {} 时 user 绑定回退绑定 value（= 无用户属性
  // 存储的缺省语义，与 JS 路径 getUserProperty 恒 undefined 一致）。
  it('T4.2 可见性过滤：visible:false 的 image 对象跳过（load_image 不调用，assetId 保持原索引）', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const sceneJson = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 2400, height: 1555 } },
      objects: [
        { id: 12, name: 'bg', image: 'models/m.json', origin: '100 200 0', scale: '1 1 1', size: '400 300' },
        { id: 13, name: 'hidden', image: 'models/m.json', origin: '0 0 0', scale: '1 1 1', size: '100 100', visible: false },
        { id: 18, name: 'rays', particle: 'particles/p.json', origin: '10 20 0', scale: '2 2 1' },
      ],
    });
    const scene = { set_cover: vi.fn(), load_scene: vi.fn(), load_image: vi.fn(), add_particle: vi.fn(), step: vi.fn(), render: vi.fn() };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('name=scene.json')) return jsonResp(sceneJson);
        if (url.includes('m.json')) return jsonResp({ material: 'materials/mat.json' });
        if (url.includes('mat.json')) return jsonResp({ passes: [{ textures: ['tex'] }] });
        if (url.includes('tex.tex')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
        if (url.includes('p.json')) return jsonResp({ emitter: [{ rate: 5 }], initializer: [] });
        return { ok: false, status: 404, json: async () => ({}) } as any;
      }),
    );
    const r = createWasmSceneRenderer({ loadWasm: async () => ({ default: vi.fn(), WeScene: { create: async () => scene } } as any) });
    const fg = document.createElement('canvas');
    await expect(r!.render('1', fg)).resolves.toBe(true);
    // 仅可见 image 对象加载（assetId = 原索引 0）；隐藏对象（索引 1）未触发 load_image
    expect(scene.load_image).toHaveBeenCalledTimes(1);
    expect(scene.load_image.mock.calls[0][0]).toBe(0);
    // particle 可见 → 照常 add_particle
    expect(scene.add_particle).toHaveBeenCalledTimes(1);
    expect(Array.from(scene.add_particle.mock.calls[0][1])).toEqual([10, 20, 0]);
    await vi.waitFor(() => {
      expect(scene.step).toHaveBeenCalled();
    });
  });

  it('T4.2 可见性过滤：visible:false 的 particle 对象跳过（add_particle 不调用）', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const sceneJson = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 2400, height: 1555 } },
      objects: [
        { id: 12, name: 'bg', image: 'models/m.json', origin: '100 200 0', scale: '1 1 1', size: '400 300' },
        { id: 18, name: 'hidden-rays', particle: 'particles/p.json', origin: '10 20 0', scale: '2 2 1', visible: false },
      ],
    });
    const scene = { set_cover: vi.fn(), load_scene: vi.fn(), load_image: vi.fn(), add_particle: vi.fn(), step: vi.fn(), render: vi.fn() };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('name=scene.json')) return jsonResp(sceneJson);
        if (url.includes('m.json')) return jsonResp({ material: 'materials/mat.json' });
        if (url.includes('mat.json')) return jsonResp({ passes: [{ textures: ['tex'] }] });
        if (url.includes('tex.tex')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
        if (url.includes('p.json')) return jsonResp({ emitter: [{ rate: 5 }], initializer: [] });
        return { ok: false, status: 404, json: async () => ({}) } as any;
      }),
    );
    const r = createWasmSceneRenderer({ loadWasm: async () => ({ default: vi.fn(), WeScene: { create: async () => scene } } as any) });
    const fg = document.createElement('canvas');
    await expect(r!.render('1', fg)).resolves.toBe(true);
    expect(scene.load_image).toHaveBeenCalledTimes(1);      // 可见 image 照常
    expect(scene.add_particle).not.toHaveBeenCalled();      // 隐藏粒子未加载
    await vi.waitFor(() => {
      expect(scene.step).toHaveBeenCalled();
    });
  });

  it('image 对象无 size 字段 + alignment → origin 不偏移（纹理尺寸在 origin 计算时未知，跳过 alignment）', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const sceneJson = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 2400, height: 1555 } },
      objects: [
        { id: 12, name: 'bg', image: 'models/m.json', origin: '100 200 0', scale: '1 1 1', alignment: 'bottomright' },
      ],
    });
    const scene = { set_cover: vi.fn(), load_scene: vi.fn(), load_image: vi.fn(), add_particle: vi.fn(), step: vi.fn(), render: vi.fn() };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('name=scene.json')) return jsonResp(sceneJson);
        if (url.includes('m.json')) return jsonResp({ material: 'materials/mat.json' });
        if (url.includes('mat.json')) return jsonResp({ passes: [{ textures: ['tex'] }] });
        if (url.includes('tex.tex')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
        return { ok: false, status: 404, json: async () => ({}) } as any;
      }),
    );
    const r = createWasmSceneRenderer({ loadWasm: async () => ({ default: vi.fn(), WeScene: { create: async () => scene } } as any) });
    const fg = document.createElement('canvas');
    await expect(r!.render('1', fg)).resolves.toBe(true);
    expect(scene.load_image).toHaveBeenCalledTimes(1);
    const origin = scene.load_image.mock.calls[0][2];
    expect(Array.from(origin)).toEqual([100, 200, 0]); // 无 size → 原样直传（不偏移）
    await vi.waitFor(() => {
      expect(scene.step).toHaveBeenCalled();
    });
  });

  // T5：脚本动画接入（SceneScriptRuntime，Task 4）。带可见性脚本（visible.script，T4.2
  // 归一化后挂到 image 对象的 script 字段）的 image 对象 → 懒初始化 SceneScriptRuntime 并
  // bind；帧循环每帧 update(1/60)，读回 origin 变化灌回 scene.update_image（assetId=原索引）。
  it('带脚本 image 对象：绑定脚本并每帧调用 update_image（读回 origin 变化）', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const scene = {
      set_cover: vi.fn(), load_scene: vi.fn(), load_image: vi.fn(), add_particle: vi.fn(),
      step: vi.fn(), render: vi.fn(), update_image: vi.fn(),
    };
    const sceneJson = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 2400, height: 1555 } },
      objects: [
        {
          id: 12, name: 'anim', image: 'models/m.json', origin: '100 200 0', scale: '1 1 1', size: '400 300',
          visible: { script: `export class A extends IThisPropertyObject { update(dt) { this.origin.x += 5; } }`, value: true },
        },
      ],
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('name=scene.json')) return jsonResp(sceneJson);
      if (url.includes('m.json')) return jsonResp({ material: 'materials/mat.json' });
      if (url.includes('mat.json')) return jsonResp({ passes: [{ textures: ['tex'] }] });
      if (url.includes('tex.tex')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }));
    const r = createWasmSceneRenderer({ loadWasm: async () => ({ default: vi.fn(), WeScene: { create: async () => scene } } as any) });
    const fg = document.createElement('canvas');
    await expect(r!.render('1', fg)).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(scene.update_image).toHaveBeenCalled();
    });
    const [assetId] = scene.update_image.mock.calls[0];
    expect(assetId).toBe(0); // 原索引
  });
});

describe('createFallbackSceneRenderer（2026-08-21 决策：强制 wasm，禁用 JS 回退）', () => {
  it('wasm 渲染器为 null（无 WebGPU）→ 恒 false（controller 走 preview，不再用 JS 兜底）', async () => {
    const js = { render: vi.fn(async () => true) };
    const r = createFallbackSceneRenderer(null, js);
    const fg = document.createElement('canvas');
    await expect(r.render('1', fg)).resolves.toBe(false);
    expect(js.render).not.toHaveBeenCalled();
  });

  it('wasm 加载失败（render 返回 false）→ 组合层返回 false，重试（wasmFailed）仍 false（不再走 JS）', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    // 注入 loadWasm 返回 null 的 wasm renderer：模拟 wasm 加载失败
    const wasm = createWasmSceneRenderer({ loadWasm: async () => null });
    const js = { render: vi.fn(async () => true) };
    const r = createFallbackSceneRenderer(wasm, js);
    const fg = document.createElement('canvas');
    // Task 9 语义保留：wasm 失败后 fg 已被 WebGPU 占用 → 组合层不自行换 canvas，返回 false 让 controller 重建
    await expect(r.render('1', fg)).resolves.toBe(false);
    expect(js.render).not.toHaveBeenCalled();
    // controller 重试（wasmFailed 已记录）→ 直接 false（preview 兜底），不再走 JS
    const fg2 = document.createElement('canvas');
    const bg2 = document.createElement('canvas');
    await expect(r.render('1', fg2, bg2)).resolves.toBe(false);
    expect(js.render).not.toHaveBeenCalled();
  });

  it('wasm 与 JS 都失败 → 最终 false（JS 不再参与，wasm 失败即 preview）', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const wasm = createWasmSceneRenderer({ loadWasm: async () => null });
    const js = { render: vi.fn(async () => false) };
    const r = createFallbackSceneRenderer(wasm, js);
    const fg = document.createElement('canvas');
    await expect(r.render('1', fg)).resolves.toBe(false);
    await expect(r.render('1', fg)).resolves.toBe(false);
    expect(js.render).not.toHaveBeenCalled();
  });

  it('wasm 失败后同壁纸再次渲染跳过 wasm 直接返回 false（不再走 JS）', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const wasm = { render: vi.fn(async () => false) };
    const js = { render: vi.fn(async () => true) };
    const r = createFallbackSceneRenderer(wasm, js);
    const fg = document.createElement('canvas');
    // 第一次 wasm 失败 → false（controller 将重建 canvas 重试）
    await expect(r.render('1', fg)).resolves.toBe(false);
    // controller 重试（wasmFailed 已记录）→ 直接 false，不再走 JS
    const fg2 = document.createElement('canvas');
    await expect(r.render('1', fg2)).resolves.toBe(false);
    expect(wasm.render).toHaveBeenCalledTimes(1); // wasm 只尝试一次
    expect(js.render).not.toHaveBeenCalled();
  });

  it('wasm 渲染成功 → 不调用 JS 渲染器', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const wasm = { render: vi.fn(async () => true) };
    const js = { render: vi.fn(async () => true) };
    const r = createFallbackSceneRenderer(wasm, js);
    const fg = document.createElement('canvas');
    await expect(r.render('1', fg)).resolves.toBe(true);
    expect(js.render).not.toHaveBeenCalled();
  });
});
