import { describe, expect, it, vi } from 'vitest';
import { fetchMdlBytes, particlesFromSpec, resolveImageAssets, resolveParticleMaterial } from '../src/client/scene-assets.js';
import type { SceneImageObject } from '../src/shared/types.js';
import { readFileSync } from 'node:fs';

describe('particlesFromSpec (v1 subset)', () => {
  it('maps Wallpaper Engine particle json to emitter/init spec', () => {
    const raw = JSON.stringify({
      emitter: [{ name: 'sphererandom', rate: 0.3, directions: '1 0.03 0', distancemin: 10, distancemax: 320 }],
      initializer: [
        { name: 'lifetimerandom', min: 8, max: 20 },
        { name: 'sizerandom', min: 350, max: 750 },
        { name: 'velocityrandom', min: '-20 0 0', max: '-5 10 0' },
      ],
    });
    const spec = particlesFromSpec(JSON.parse(raw))!;
    expect(spec.emitter.rate).toBe(0.3);
    expect(spec.init.lifetimeMin).toBe(8);
    expect(spec.init.lifetimeMax).toBe(20);
    expect(spec.init.sizeMin).toBe(350);
    expect(spec.init.velocityMin).toEqual([-20, 0, 0]);
  });
  it('returns null when emitter or initializers missing', () => {
    expect(particlesFromSpec({})).toBeNull();
    expect(particlesFromSpec({ emitter: [] })).toBeNull();
  });
});

describe('resolveParticleMaterial', () => {
  // 回归（2026-09-29）：纹理 URL 必须带壁纸 id —— 否则 host 只在 WE 引擎目录找纹理，
  // 打包在壁纸 scene.pkg 里的粒子纹理（3793620838 的两只鸟）取不到 → 渲染成圆点。
  it('texUrl 携带壁纸 id，供 host 先在 scene.pkg 内查纹理', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        passes: [{ blending: 'translucent', textures: ['particle/BIRD TEST 3 FILTER'] }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const r = await resolveParticleMaterial(
        '3793620838',
        JSON.stringify({ material: 'materials/particle/BIRD TEST 3 FILTER.json' }),
      );
      expect(r).toEqual({
        texUrl: '/wallpapers/particle-texture?id=3793620838&name=particle%2FBIRD%20TEST%203%20FILTER',
        blending: 'translucent',
        refract: false,
        normalTexUrl: null,
        refractAmount: 0.05,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('材质不可得 → texUrl null（调用方走白图兜底）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    try {
      expect(await resolveParticleMaterial('1', JSON.stringify({ material: 'materials/x.json' }))).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // 折射层（WE combo REFRACT=1）：槽 1 是法线/遮罩纹理，必须走**与槽 0 完全相同**的
  // particle-texture 路由（pkg 优先、空格与子目录原样保留），不得加 `materials/` 前缀。
  it('REFRACT=1 + 槽1 ⇒ refract=true 且槽1 走同一条 particle-texture 路由', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        passes: [{
          blending: 'translucent',
          combos: { REFRACT: 1 },
          textures: [
            'workshop/2446129945/particle/particles 256x1280 blank',
            'workshop/2446129945/particle/particles 256x1280N',
          ],
        }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const r = await resolveParticleMaterial(
        '2897292240',
        JSON.stringify({ material: 'materials/workshop/2446129945/particle/halo_50_1.json' }),
      );
      expect(r).toEqual({
        texUrl: '/wallpapers/particle-texture?id=2897292240&name=workshop%2F2446129945%2Fparticle%2Fparticles%20256x1280%20blank',
        blending: 'translucent',
        refract: true,
        normalTexUrl: '/wallpapers/particle-texture?id=2897292240&name=workshop%2F2446129945%2Fparticle%2Fparticles%20256x1280N',
        refractAmount: 0.05,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('槽1 的 `particle/` 前缀与别名路由与槽 0 同源（含空格）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        passes: [{ combos: { REFRACT: 1 }, textures: ['particle/dot 1', 'particle/normal 2'] }],
      }),
    })));
    try {
      const r = await resolveParticleMaterial('7', JSON.stringify({ material: 'materials/x.json' }));
      expect(r!.texUrl).toBe('/wallpapers/particle-texture?id=7&name=particle%2Fdot%201');
      expect(r!.normalTexUrl).toBe('/wallpapers/particle-texture?id=7&name=particle%2Fnormal%202');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // 失败开放：判据只认 combo === 1，不做素材启发式（白图槽 0 的 additive 材质绝不能进 REFRACT）。
  it('REFRACT=0 / 无 combos ⇒ refract=false（失败开放，不影响 blending 判定）', async () => {
    for (const passes of [
      [{ blending: 'additive', combos: { REFRACT: 0 }, textures: ['particle/snow'] }],
      [{ blending: 'additive', textures: ['particle/snow'] }],
      [{ blending: 'additive', combos: { REFRACT: '1' }, textures: ['particle/snow'] }],
      [{ blending: 'additive', combos: {}, textures: ['particle/snow'] }],
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ passes }) })));
      try {
        const r = await resolveParticleMaterial('1', JSON.stringify({ material: 'materials/x.json' }));
        expect(r!.refract).toBe(false);
        expect(r!.blending).toBe('additive');
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it('槽1 缺失 ⇒ refract=true 但 normalTexUrl=null（调用方不装配该层）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        passes: [{ combos: { REFRACT: 1 }, textures: ['workshop/2446129945/particle/rain'] }],
      }),
    })));
    try {
      const r = await resolveParticleMaterial('2897292240', JSON.stringify({ material: 'materials/x.json' }));
      expect(r!.refract).toBe(true);
      expect(r!.normalTexUrl).toBeNull();
      expect(r!.texUrl).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('护栏：chromaticdot + additive + 无 combos ⇒ 不进 REFRACT 路径（白图槽 0 不得被判为折射）', async () => {
    // 基线实地形态：1429403119 的 snowflat 材质 = additive + particle/chromaticdot（RGBA 全 255）。
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ passes: [{ blending: 'additive', textures: ['particle/chromaticdot'] }] }),
    })));
    try {
      const r = await resolveParticleMaterial('1429403119', JSON.stringify({ material: 'materials/presets/snowflat.json' }));
      expect(r!.refract).toBe(false);
      expect(r!.normalTexUrl).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refractAmount：缺省 0.05；显式值覆盖（非有限值回落缺省）', async () => {
    for (const [cs, expected] of [
      [undefined, 0.05],
      [{}, 0.05],
      [{ ui_editor_properties_refract_amount: 0.12 }, 0.12],
      [{ ui_editor_properties_refract_amount: 0 }, 0],
      [{ ui_editor_properties_refract_amount: '0.2' }, 0.05],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ passes: [{ combos: { REFRACT: 1 }, textures: ['a'], constantshadervalues: cs }] }),
      })));
      try {
        const r = await resolveParticleMaterial('1', JSON.stringify({ material: 'materials/x.json' }));
        expect(r!.refractAmount).toBe(expected);
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });
});

describe('particlesFromSpec on real EVA fixtures', () => {
  it('parses lightshafts preset json', () => {
    const raw = readFileSync(new URL('./fixtures/eva/particles_presets_lightshafts.json', import.meta.url), 'utf8');
    const spec = particlesFromSpec(JSON.parse(raw))!;
    expect(spec.emitter.rate).toBeCloseTo(0.3, 5);
    expect(spec.emitter.directions).toEqual([1, 0.03, 0]);
    expect(spec.emitter.distanceMin).toBe(10);
    expect(spec.emitter.distanceMax).toBe(320);
    expect(spec.init.lifetimeMin).toBe(8);
    expect(spec.init.lifetimeMax).toBe(20);
    expect(spec.init.sizeMin).toBe(350);
    expect(spec.init.sizeMax).toBe(750);
    expect(spec.init.velocityMin).toEqual([-20, 0, 0]);
    expect(spec.init.velocityMax).toEqual([-5, 10, 0]);
  });
  it('parses Ashes particle json (boxrandom without rate/distance fields → WE defaults)', () => {
    const raw = readFileSync(new URL('./fixtures/eva/particles_Ashes.json', import.meta.url), 'utf8');
    const spec = particlesFromSpec(JSON.parse(raw))!;
    // emitter 无 rate/distancemax 字段 → 采用真实 WE 缺省（rate=10、distancemax=256）
    expect(spec.emitter.rate).toBe(10);
    expect(spec.emitter.directions).toEqual([1, 1, 1]);
    expect(spec.emitter.distanceMin).toBe(0);
    expect(spec.emitter.distanceMax).toBe(256);
    expect(spec.init.lifetimeMin).toBe(3);
    expect(spec.init.lifetimeMax).toBe(5);
    expect(spec.init.sizeMin).toBe(20);
    expect(spec.init.sizeMax).toBe(50);
    expect(spec.init.velocityMin).toEqual([-50, -50, 0]);
    expect(spec.init.velocityMax).toEqual([50, 0, 0]);
  });
});

// Task 7：image 对象的**一次** model json 拉取同时给出纹理与 puppet 路径；`.mdl` 字节单独按需拉。
describe('resolveImageAssets / fetchMdlBytes', () => {
  const obj = { image: 'models/20240220213723_1_puppet.json' } as SceneImageObject;
  const MODEL_URL = '/wallpapers/scene/3303428996/asset?name=models%2F20240220213723_1_puppet.json';

  it('model json 只拉一次：puppet 字段原样带出（material 缺失 ⇒ texture null，但 puppetPath 仍有效）', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ puppet: 'models/20240220213723_1_puppet.mdl' }) };
    }));
    try {
      expect(await resolveImageAssets('3303428996', obj)).toEqual({
        texture: null,
        puppetPath: 'models/20240220213723_1_puppet.mdl',
      });
      expect(calls).toEqual([MODEL_URL]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('无 puppet 字段（普通 image 对象）⇒ puppetPath null，纹理链行为与改动前一致', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ material: 'materials/m.json' }) })));
    try {
      // 材质拉取同 URL 的 mock 会拿到 {material} ⇒ 无 passes[0].textures[0] ⇒ texture null
      expect(await resolveImageAssets('1', obj)).toEqual({ texture: null, puppetPath: null });
    } finally { vi.unstubAllGlobals(); }
  });

  it('model json 拿不到 / 网络异常 ⇒ 两条链都 null（调用方走白图兜底，不阻断）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    try {
      expect(await resolveImageAssets('1', obj)).toEqual({ texture: null, puppetPath: null });
    } finally { vi.unstubAllGlobals(); }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net'); }));
    try {
      expect(await resolveImageAssets('1', obj)).toEqual({ texture: null, puppetPath: null });
    } finally { vi.unstubAllGlobals(); }
  });

  it('puppet 字段非字符串 / 空串 ⇒ 一律当没有（不当路径拼 URL）', async () => {
    for (const puppet of [42, '', null, { path: 'x.mdl' }]) {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ puppet }) })));
      try {
        expect((await resolveImageAssets('1', obj)).puppetPath).toBeNull();
      } finally { vi.unstubAllGlobals(); }
    }
  });

  it('fetchMdlBytes：走 scene asset 路由（路径 encode）→ Uint8Array；非 ok / 异常 → null', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    }));
    try {
      const bytes = await fetchMdlBytes('3303428996', 'models/a_puppet.mdl');
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect([...bytes!]).toEqual([1, 2, 3]);
      expect(calls).toEqual(['/wallpapers/scene/3303428996/asset?name=models%2Fa_puppet.mdl']);
    } finally { vi.unstubAllGlobals(); }

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })));
    try {
      expect(await fetchMdlBytes('1', 'models/a.mdl')).toBeNull();
    } finally { vi.unstubAllGlobals(); }

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net'); }));
    try {
      expect(await fetchMdlBytes('1', 'models/a.mdl')).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });
});