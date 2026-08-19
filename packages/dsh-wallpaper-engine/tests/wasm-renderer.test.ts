// @vitest-environment jsdom
// Task 8：wasm 渲染器胶水的回退逻辑与 API 调用顺序（jsdom）。
// - 无 WebGPU（navigator.gpu 缺失）→ createWasmSceneRenderer() 返回 null（走现有 JS 渲染回退）
// - loadWasm 注入失败（null / reject）→ render() resolve false（组合层降级到 JS 渲染器）
// - 组合回退链（createFallbackSceneRenderer）：wasm 失败 → JS 渲染器；JS 也失败 → false
//   → controller 走 preview 图回退（spec §7 第 2/3 条）
// - 成功路径：scene.json → 对象遍历（image → model.json → material → .tex；particle）→
//   WeScene.create / load_scene / load_image / add_particle / step / render 按序调用
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createWasmSceneRenderer, createFallbackSceneRenderer } from '../src/client/wasm-renderer.js';

function jsonResp(body: unknown): any {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

// 典型场景：2400×1555 正交视口 + 1 个 image 对象 + 1 个 particle 对象
const SCENE_JSON_TEXT = JSON.stringify({
  camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
  general: { orthogonalprojection: { width: 2400, height: 1555 } },
  objects: [
    { id: 12, name: 'bg', image: 'models/m.json', origin: '100 200 0', scale: '1 1 1', size: '400 300' },
    { id: 18, name: 'rays', particle: 'particles/p.json', origin: '10 20 0', scale: '2 2 1' },
  ],
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    const scene = { load_scene: vi.fn(), load_image: vi.fn(), add_particle: vi.fn(), step: vi.fn(), render: vi.fn() };
    const r = createWasmSceneRenderer({
      loadWasm: async () => ({ default: async () => {}, WeScene: { create: async () => scene } } as any),
    });
    const fg = document.createElement('canvas');
    await expect(r!.render('1', fg)).resolves.toBe(false);
    expect(scene.load_image).not.toHaveBeenCalled();
  });

  it('成功路径：按序调用 WeScene.create / load_scene / load_image / add_particle 并启动帧循环', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const scene = {
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
    await expect(r!.render('1', fg)).resolves.toBe(true);

    // WeScene.create 用场景正交尺寸创建
    expect(mod.WeScene.create).toHaveBeenCalledWith(fg, 2400, 1555);
    // load_scene 收到原始 scene.json 文本
    expect(scene.load_scene).toHaveBeenCalledWith(SCENE_JSON_TEXT);
    // image 对象 → 纹理字节直传 wasm（assetId=对象索引，origin/scale/size 为 Float32Array）
    expect(scene.load_image).toHaveBeenCalledTimes(1);
    const [assetId, tex, origin, scale, size] = scene.load_image.mock.calls[0];
    expect(assetId).toBe(0);
    expect(tex).toBeInstanceOf(Uint8Array);
    expect(Array.from(tex)).toEqual([1, 2, 3, 4]);
    expect(Array.from(origin)).toEqual([100, 200, 0]);
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
});

describe('createFallbackSceneRenderer（组合回退链，spec §7 第 2/3 条）', () => {
  it('wasm 渲染器为 null（无 WebGPU）→ 直接用 JS 渲染器', async () => {
    const js = { render: vi.fn(async () => true) };
    const r = createFallbackSceneRenderer(null, js);
    const fg = document.createElement('canvas');
    await expect(r.render('1', fg)).resolves.toBe(true);
    // wasm null → 组合层直接返回 js 原对象（透传原参数个数）
    expect(js.render).toHaveBeenCalledWith('1', fg);
  });

  it('wasm 加载失败（render 返回 false）→ 降级调用 JS 渲染器', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    // 注入 loadWasm 返回 null 的 wasm renderer：模拟 wasm 加载失败
    const wasm = createWasmSceneRenderer({ loadWasm: async () => null });
    const js = { render: vi.fn(async () => true) };
    const r = createFallbackSceneRenderer(wasm, js);
    const fg = document.createElement('canvas');
    await expect(r.render('1', fg)).resolves.toBe(true);
    expect(js.render).toHaveBeenCalledWith('1', fg, undefined);
  });

  it('wasm 与 JS 渲染器都返回 false → 最终 false（controller 走 preview 图回退）', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const wasm = createWasmSceneRenderer({ loadWasm: async () => null });
    const js = { render: vi.fn(async () => false) };
    const r = createFallbackSceneRenderer(wasm, js);
    const fg = document.createElement('canvas');
    await expect(r.render('1', fg)).resolves.toBe(false);
    expect(js.render).toHaveBeenCalledTimes(1);
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

  it('JS 渲染器 reject → 组合层 reject（controller 已有 catch 兜底走 preview）', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const wasm = createWasmSceneRenderer({ loadWasm: async () => null });
    const js = {
      render: vi.fn(async () => {
        throw new Error('js render fail');
      }),
    };
    const r = createFallbackSceneRenderer(wasm, js);
    const fg = document.createElement('canvas');
    await expect(r.render('1', fg)).rejects.toThrow('js render fail');
  });
});
