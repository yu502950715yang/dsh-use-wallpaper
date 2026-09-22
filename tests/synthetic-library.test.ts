// 合成壁纸库的**确定性**回归层（不依赖本机 workshop 素材，CI 上照常跑）。
//
// 与 tests/verify-real-library.test.ts（本机真库、只做结构性断言）分工：
//   本文件负责**精确计数与语义**（效果链分类、combo 派生、sampler mode、RT 图计划、
//   image/particle 链路），这些断言不再随用户本地壁纸库漂移。
import { describe, expect, it } from 'vitest';
import { parsePkg } from '../src/host/pkg-reader.js';
import { parseSceneJson } from '../src/client/scene-json.js';
import { particlesFromSpec, resolveTexPath } from '../src/client/scene-assets.js';
import { parseTex, TEX_FORMAT } from '../src/client/tex-loader.js';
import { resolveEffectChain } from '../src/client/shader/effect-chain.js';
import { isLinearEffectChain } from '../src/client/object-effects.js';
import { buildEffectPlan } from '../src/client/effect-graph.js';
import { buildSyntheticLibrary, type SyntheticWallpaper } from './fixtures/synthetic/build.js';

/** 用**生产** parsePkg 把合成 pkg 解回文件表（顺带验证 makePkg ↔ parsePkg 往返）。 */
function unpack(wp: SyntheticWallpaper): Map<string, Uint8Array> {
  const { entries, dataStart } = parsePkg(new Uint8Array(wp.pkg));
  const map = new Map<string, Uint8Array>();
  for (const e of entries) map.set(e.name, new Uint8Array(wp.pkg.subarray(dataStart + e.offset, dataStart + e.offset + e.size)));
  return map;
}

const lib = buildSyntheticLibrary();
const lin = lib.find((w) => w.id === 'syn-linear')!;
const rt = lib.find((w) => w.id === 'syn-rtgraph')!;

describe('合成 fixture：包读写往返（makePkg ↔ 生产 parsePkg）', () => {
  it('每个 pkg 解出的文件表与声明完全一致', () => {
    for (const wp of lib) {
      const got = unpack(wp);
      expect([...got.keys()].sort()).toEqual([...wp.files.keys()].sort());
      for (const [name, declared] of wp.files) {
        expect(Array.from(got.get(name)!)).toEqual(Array.from(declared));
      }
    }
  });
});

describe('合成 fixture：scene.json 解析与对象归类', () => {
  it('5 个对象的 kind 归类与顺序（image / particle / image / image / util）', () => {
    const desc = parseSceneJson(new TextDecoder().decode(lin.files.get('scene.json')));
    expect(desc.objects.map((o) => o.kind)).toEqual(['image', 'particle', 'image', 'image', 'util']);
    expect(desc.orthogonal).toEqual({ width: 200, height: 200 });
  });
});

describe('合成 fixture：image 链路（model → material → tex）', () => {
  const files = unpack(lin);

  it('resolveTexPath（生产函数）两种布局都正确', () => {
    // 同目录：textures[0] 不含 '/' → 材质同目录同名 .tex
    expect(resolveTexPath('materials/bg.json', 'bg')).toBe('materials/bg.tex');
    // 含 '/'：相对 materials/ 的路径
    expect(resolveTexPath('materials/grain.json', 'sub/grain')).toBe('materials/sub/grain.tex');
  });

  it('两种布局的 .tex 都能被生产 parseTex 解出且尺寸/格式正确', () => {
    for (const [path, w, h] of [['materials/bg.tex', 4, 4], ['materials/sub/grain.tex', 8, 8]] as const) {
      const info = parseTex(files.get(path)!);
      expect(info, path).not.toBeNull();
      expect(info!.format, path).toBe(TEX_FORMAT.RGBA8888);
      expect([info!.width, info!.height], path).toEqual([w, h]);
    }
  });

  it('image 对象的链路可完整走通（model → material → texName → 文件存在）', () => {
    const desc = parseSceneJson(new TextDecoder().decode(files.get('scene.json')));
    for (const obj of desc.objects) {
      if (obj.kind !== 'image') continue;
      const model = JSON.parse(new TextDecoder().decode(files.get(obj.image)!));
      const mat = JSON.parse(new TextDecoder().decode(files.get(model.material)!));
      const texPath = resolveTexPath(model.material, mat.passes[0].textures[0]);
      expect(files.has(texPath), `${obj.name} → ${texPath}`).toBe(true);
      expect(parseTex(files.get(texPath)!)).not.toBeNull();
    }
  });
});

describe('合成 fixture：particle 规格', () => {
  const files = unpack(lin);

  it('emitter 与 initializer（含 rotationrandom）被正确解析', () => {
    const spec = particlesFromSpec(JSON.parse(new TextDecoder().decode(files.get('particles/petals.json')!)));
    expect(spec).not.toBeNull();
    expect(spec!.emitter.rate).toBe(8);
    expect(spec!.emitter.distanceMax).toBe(128);
    expect(spec!.init.lifetimeMin).toBe(1);
    expect(spec!.init.lifetimeMax).toBe(2);
  });
});

describe('合成 fixture：效果链分类（精确计数，替代原真库快照）', () => {
  it('线性库：3 条链（单 pass / 双 pass previous / util 带链）全部判为线性', async () => {
    const files = unpack(lin);
    const desc = parseSceneJson(new TextDecoder().decode(files.get('scene.json')));
    const load = async (n: string) => files.get(n) ?? null;

    const chains: { name: string; passes: Awaited<ReturnType<typeof resolveEffectChain>> }[] = [];
    for (const obj of desc.objects) {
      for (const fx of (obj.effects ?? []) as { file: string }[]) {
        chains.push({ name: obj.name, passes: await resolveEffectChain(fx, load) });
      }
    }

    expect(chains.map((c) => c.name)).toEqual(['grain', 'two', 'compose']);
    for (const c of chains) {
      expect(c.passes, c.name).not.toBeNull();
      expect(isLinearEffectChain(c.passes!), c.name).toBe(true);
    }
    // pass 数：单 pass / 双 pass / util 单 pass
    expect(chains.map((c) => c.passes!.length)).toEqual([1, 2, 1]);
    // blendMode 来自 material json（不是按文件名猜）
    expect(chains[0].passes![0].blendMode).toBe('additive');
    expect(chains[1].passes!.map((p) => p.blendMode)).toEqual(['normal', 'translucent']);
    // 无 sampler 注解 → 不派生 combo
    expect(chains[0].passes![0].combos.MASK).toBeUndefined();
  });

  it('RT 图库：1 条链不被判为线性，且 combo / sampler mode 派生正确', async () => {
    const files = unpack(rt);
    const desc = parseSceneJson(new TextDecoder().decode(files.get('scene.json')));
    const load = async (n: string) => files.get(n) ?? null;
    const fx = (desc.objects[0].effects as { file: string }[])[0];
    const chain = await resolveEffectChain(fx, load);

    expect(chain).not.toBeNull();
    expect(chain!.length).toBe(2);
    expect(isLinearEffectChain(chain!)).toBe(false);

    const p0 = chain![0];
    expect(p0.target).toBe('_rt_HalfBuffer');
    // textures[1] 非 null + 注解 combo:MASK ⇒ MASK 派生为 1（局部作用分支才会启用）
    expect(p0.combos.MASK).toBe(1);
    expect(p0.samplerModes.g_Texture1).toBe('opacitymask');
    expect(p0.textureSlots[1]).toBe('util/noise');
    // fbos 降采样声明随 pass 带出（scale=2 → 半尺寸）
    expect(p0.fboScale).toEqual({ _rt_HalfBuffer: 2 });
    // 第 2 pass 的 bind 指向具名 RT
    expect(chain![1].bind).toEqual([{ name: '_rt_HalfBuffer', index: 0 }]);
  });

  it('RT 图计划：1 张具名 RT（scale=2 → 640×360）、末 pass 写 final、无 droppedChains', async () => {
    const files = unpack(rt);
    const desc = parseSceneJson(new TextDecoder().decode(files.get('scene.json')));
    const load = async (n: string) => files.get(n) ?? null;
    const chain = (await resolveEffectChain((desc.objects[0].effects as { file: string }[])[0], load))!;
    const plan = buildEffectPlan([chain], { baseWidth: 1280, baseHeight: 720 });

    expect(plan.droppedChains).toEqual([]);
    expect(plan.namedTargets).toEqual([{ key: '0:_rt_HalfBuffer', name: '_rt_HalfBuffer', width: 640, height: 360 }]);
    expect(plan.passes.map((p) => p.write.type)).toEqual(['named', 'final']);
    expect(plan.passes[0].bindings).toEqual([]);
    expect(plan.passes[1].bindings).toEqual([{ slot: 0, source: { type: 'named', key: '0:_rt_HalfBuffer' } }]);
  });
});
