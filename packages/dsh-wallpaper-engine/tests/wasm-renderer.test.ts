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
    const scene = { load_scene: vi.fn(), load_image: vi.fn(), add_particle: vi.fn(), step: vi.fn(), render: vi.fn() };
    const r = createWasmSceneRenderer({
      loadWasm: async () => ({ default: async () => {}, WeScene: { create: async () => scene } } as any),
    });
    const fg = document.createElement('canvas');
    await expect(r!.render('1', fg)).resolves.toBe(false);
    expect(scene.load_image).not.toHaveBeenCalled();
  });

  it('场景含效果链 → render() 在 WeScene.create 之前返回 false（canvas 未绑定 WebGPU，可回退 JS）', async () => {
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
    const mod = { default: vi.fn(async () => undefined), WeScene: { create: vi.fn(async () => ({})) } };
    const r = createWasmSceneRenderer({ loadWasm: async () => mod as any });
    const fg = document.createElement('canvas');
    const bg = document.createElement('canvas');
    const fgW = fg.width, fgH = fg.height, bgW = bg.width, bgH = bg.height;
    await expect(r!.render('1', fg, bg)).resolves.toBe(false);
    // 效果链检测在 WeScene.create 之前：fg/bg 均未绑定 WebGPU → 组合层/controller 可重建 canvas 走 JS
    expect(mod.WeScene.create).not.toHaveBeenCalled();
    expect(fg.width).toBe(fgW); // canvas 未被视口尺寸赋值（未进入绑定流程）
    expect(fg.height).toBe(fgH);
    expect(bg.width).toBe(bgW);
    expect(bg.height).toBe(bgH);
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

    // WeScene.create 用视口尺寸创建（Task 9 修复：surface 与 canvas 属性尺寸 = 视口，
    // 对齐 scene-renderer.setScene 的 vw/vh；jsdom 默认 window.innerWidth=1024/innerHeight=768）
    expect(mod.WeScene.create).toHaveBeenCalledWith(fg, 1024, 768);
    expect(fg.width).toBe(1024);
    expect(fg.height).toBe(768);
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

  it('image 对象无 size 字段 + alignment → origin 不偏移（纹理尺寸在 origin 计算时未知，跳过 alignment）', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const sceneJson = JSON.stringify({
      camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
      general: { orthogonalprojection: { width: 2400, height: 1555 } },
      objects: [
        { id: 12, name: 'bg', image: 'models/m.json', origin: '100 200 0', scale: '1 1 1', alignment: 'bottomright' },
      ],
    });
    const scene = { load_scene: vi.fn(), load_image: vi.fn(), add_particle: vi.fn(), step: vi.fn(), render: vi.fn() };
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

  it('wasm 加载失败（render 返回 false）→ 组合层返回 false，由 controller 重建 canvas 重试（防 WebGPU 污染）', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    // 注入 loadWasm 返回 null 的 wasm renderer：模拟 wasm 加载失败
    const wasm = createWasmSceneRenderer({ loadWasm: async () => null });
    const js = { render: vi.fn(async () => true) };
    const r = createFallbackSceneRenderer(wasm, js);
    const fg = document.createElement('canvas');
    // Task 9 修复：wasm 失败后 fg 已被 WebGPU 占用 → 组合层不自行换 canvas（避免与
    // controller 展示引用不一致），返回 false 让 controller 重建 canvas 再调 render
    await expect(r.render('1', fg)).resolves.toBe(false);
    expect(js.render).not.toHaveBeenCalled();
    // controller 重试（wasmFailed 已记录）→ 直接用新 canvas 走 JS
    const fg2 = document.createElement('canvas');
    const bg2 = document.createElement('canvas');
    await expect(r.render('1', fg2, bg2)).resolves.toBe(true);
    // createWasmSceneRenderer 的 render 为闭包（非 spy），以 js.render 调用次数验证回退
    expect(js.render).toHaveBeenCalledTimes(1);
    expect(js.render).toHaveBeenCalledWith('1', fg2, bg2);
  });

  it('wasm 与 JS 渲染器都返回 false → 最终 false（controller 走 preview 图回退）', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const wasm = createWasmSceneRenderer({ loadWasm: async () => null });
    const js = { render: vi.fn(async () => false) };
    const r = createFallbackSceneRenderer(wasm, js);
    const fg = document.createElement('canvas');
    // 第一次 wasm 失败 → false；重试（wasmFailed）→ JS false → false
    await expect(r.render('1', fg)).resolves.toBe(false);
    await expect(r.render('1', fg)).resolves.toBe(false);
    expect(js.render).toHaveBeenCalledTimes(1);
  });

  it('wasm 失败后同壁纸再次渲染跳过 wasm 直接走 JS', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const wasm = { render: vi.fn(async () => false) };
    const js = { render: vi.fn(async () => true) };
    const r = createFallbackSceneRenderer(wasm, js);
    const fg = document.createElement('canvas');
    // 第一次 wasm 失败 → false（controller 将重建 canvas 重试）
    await expect(r.render('1', fg)).resolves.toBe(false);
    // controller 重试（wasmFailed 已记录）→ 直接走 JS
    const fg2 = document.createElement('canvas');
    const bg2 = document.createElement('canvas');
    await expect(r.render('1', fg2, bg2)).resolves.toBe(true);
    // wasm 只尝试一次；第二次渲染直接走 JS
    expect(wasm.render).toHaveBeenCalledTimes(1);
    expect(js.render).toHaveBeenCalledTimes(1);
    expect(js.render).toHaveBeenCalledWith('1', fg2, bg2);
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

  it('wasm 失败后 JS 渲染器 reject → 组合层 reject（controller 已有 catch 兜底走 preview）', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const wasm = createWasmSceneRenderer({ loadWasm: async () => null });
    const js = {
      render: vi.fn(async () => {
        throw new Error('js render fail');
      }),
    };
    const r = createFallbackSceneRenderer(wasm, js);
    const fg = document.createElement('canvas');
    // 第一次：wasm 失败 → false（不触发 JS）
    await expect(r.render('1', fg)).resolves.toBe(false);
    // 重试（wasmFailed）→ JS reject → 组合层 reject
    const fg2 = document.createElement('canvas');
    const bg2 = document.createElement('canvas');
    await expect(r.render('1', fg2, bg2)).rejects.toThrow('js render fail');
  });
});
