import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createParticleSystem } from '../src/client/particles.js';
import {
  objectCameraRange, createObjectRenderTarget, resolveTexPath,
  groupEffectsByObject, uvWindow, createCompositeGeometry, PendingChainStore,
} from '../src/client/scene-renderer.js';
import type { SceneObject } from '../src/shared/types.js';

// scene-renderer 的 WebGLRenderer 无法在 node（无 WebGL）环境构造，
// 这里用真实 THREE.BufferGeometry/BufferAttribute 复刻 addParticleSystem 的缓冲接线
// 与帧循环刷新语义，验证「update 后必须再次调用 positions() 同步缓冲」这一关键行为
// （防 Critical 回归：帧循环漏调 positions() 会每帧重传同一份全零数据，粒子静止在原点）。

const emitter = { rate: 10, directions: [1, 0, 0] as [number, number, number], distanceMin: 5, distanceMax: 5 };
const init = {
  lifetimeMin: 5, lifetimeMax: 5,
  sizeMin: 8, sizeMax: 20,
  velocityMin: [0, 0, 0] as [number, number, number],
  velocityMax: [1, 0, 0] as [number, number, number],
};

describe('scene 粒子缓冲刷新（渲染器接线语义）', () => {
  it('BufferAttribute 持有 positions() 返回的同一 live 引用', () => {
    const system = createParticleSystem(emitter, init, { maxParticles: 10, seed: 7 });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(system.positions(), 3));
    // addParticleSystem 时 setAttribute 的就是这个引用；刷新同引用即生效（needsUpdate 后 three 重传）
    expect(geometry.attributes.position.array).toBe(system.positions());
  });
  it('帧循环 update 后必须再次调用 positions()：否则缓冲保持全零，粒子不可见', () => {
    const system = createParticleSystem(emitter, init, { maxParticles: 10, seed: 7 });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(system.positions(), 3));
    geometry.setDrawRange(0, 0);

    system.update(0.1); // 发射 1 个（distance=5 → 初始位置 x 非零）
    // —— 修复前帧循环：只 update + needsUpdate + setDrawRange，不调 positions() ——
    geometry.attributes.position.needsUpdate = true;
    geometry.setDrawRange(0, system.count());
    const stale = Array.from(geometry.attributes.position.array as Float32Array);
    expect(stale.some((v) => v !== 0)).toBe(false); // 缓冲仍是发射前的全零（update 只改内部粒子数组）

    // —— 修复后帧循环：补调 system.positions() 同步同一缓冲 ——
    system.positions();
    const fresh = Array.from(geometry.attributes.position.array as Float32Array);
    expect(fresh.some((v) => v !== 0)).toBe(true); // 粒子位置已写入缓冲
    expect(geometry.attributes.position.array).toBe(system.positions()); // 仍是同一引用

    // 粒子持续移动/新增：再次刷新后缓冲内容变化
    system.update(0.5);
    system.positions();
    const moved = Array.from(geometry.attributes.position.array as Float32Array);
    expect(moved.some((v, i) => v !== fresh[i])).toBe(true);
  });
});

describe('resolveTexPath（材质 → tex 路径推导）', () => {
  it('texName 不含 / 时使用材质同目录（EVA 等常规布局）', () => {
    expect(resolveTexPath('materials/neon-genesis-evangelion-wallpaper-3.json', 'neon-genesis-evangelion-wallpaper-3'))
      .toBe('materials/neon-genesis-evangelion-wallpaper-3.tex');
  });
  it('texName 含 / 时是相对 materials/ 的路径（workshop 子目录纹理，修复丢前缀 bug）', () => {
    expect(resolveTexPath('materials/workshop/2077932499/Rainboww.json', 'workshop/2077932499/Rainboww'))
      .toBe('materials/workshop/2077932499/Rainboww.tex');
  });
});

describe('objectCameraRange（对象局部正交相机范围 = 尺寸×缩放，逐轴钳制 2048）', () => {
  it('常规：范围 = objSize × scale（中心原点，quad 精确填满 RT）', () => {
    expect(objectCameraRange([4, 4], [2.36, 2.36])).toEqual({ w: 9.44, h: 9.44 });
  });
  it('超 2048 上限时逐轴钳制（6144×0.47891≈2942.4 → 2048）', () => {
    // h 方向 3072×0.47891≈1471.2 < 2048 不钳制；用表达式断言避免手算舍入误差
    expect(objectCameraRange([6144, 3072], [0.47891, 0.47891])).toEqual({
      w: 2048,
      h: 3072 * 0.47891,
    });
  });
  it('单轴超限只钳制该轴', () => {
    expect(objectCameraRange([6144, 512], [1, 1])).toEqual({ w: 2048, h: 512 });
  });
  it('零尺寸/零缩放时下限钳制为 1（不产生退化范围）', () => {
    expect(objectCameraRange([0, 0], [0, 0])).toEqual({ w: 1, h: 1 });
  });
});

describe('createObjectRenderTarget（对象级渲染目标）', () => {
  it('按给定尺寸创建 RT', () => {
    const rt = createObjectRenderTarget(512, 256);
    expect(rt.width).toBe(512);
    expect(rt.height).toBe(256);
    rt.dispose();
  });
  it('浮点尺寸取整为整数分辨率（three RT 需要整数像素）', () => {
    const rt = createObjectRenderTarget(9.44, 1471.2);
    expect(rt.width).toBe(9);
    expect(rt.height).toBe(1471);
    rt.dispose();
  });
  it('0/负数尺寸下限钳制为 1（防退化 RT，对齐 EffectRunner.ensureTargets 的输入要求）', () => {
    const rt = createObjectRenderTarget(0, -5);
    expect(rt.width).toBe(1);
    expect(rt.height).toBe(1);
    rt.dispose();
  });
});

describe('groupEffectsByObject（对象级效果链分组：过滤空 effects、保持对象顺序、不展平）', () => {
  const fx = (file: string) => ({ file });
  const image = (id: number, effects?: unknown[]): SceneObject => ({
    kind: 'image', id, name: `obj${id}`, origin: [0, 0, 0], scale: [1, 1, 1],
    image: `models/${id}.json`, ...(effects ? { effects } : {}),
  });
  const particle = (id: number): SceneObject => ({
    kind: 'particle', id, name: `p${id}`, origin: [0, 0, 0], scale: [1, 1, 1],
    particle: `particles/${id}.json`,
  });

  it('2937346640 结构：主图 4 效果、其余对象无效果 → 仅 1 组（效果不展平、组引用原对象）', () => {
    const main = image(1, [
      fx('effects/foliagesway.json'), fx('effects/iris.json'),
      fx('effects/godrays.json'), fx('effects/waterreflection.json'),
    ]);
    const objects = [main, particle(2), image(3)];
    const groups = groupEffectsByObject(objects);
    expect(groups).toHaveLength(1);
    expect(groups[0].obj).toBe(main);
    expect(groups[0].effects).toHaveLength(4);
    expect((groups[0].effects as { file: string }[]).map((e) => e.file)).toEqual([
      'effects/foliagesway.json', 'effects/iris.json', 'effects/godrays.json', 'effects/waterreflection.json',
    ]);
  });
  it('多对象带效果：组按 objects 顺序、effects 数组原样保留（不跨对象展平）', () => {
    const o2 = image(2, [fx('a.json'), fx('b.json')]);
    const o3 = image(3, [fx('c.json')]);
    const o5 = image(5, [fx('d.json'), fx('e.json'), fx('f.json')]);
    const objects = [image(1), o2, o3, particle(4), o5, particle(6)];
    const groups = groupEffectsByObject(objects);
    expect(groups.map((g) => g.obj.id)).toEqual([2, 3, 5]);
    expect(groups.map((g) => g.effects.length)).toEqual([2, 1, 3]);
  });
  it('空数组 / 全无效果对象 → 空分组', () => {
    expect(groupEffectsByObject([])).toEqual([]);
    expect(groupEffectsByObject([image(1), particle(2)])).toEqual([]);
  });
  it('effects 为 undefined（非数组字段）不误判为组', () => {
    expect(groupEffectsByObject([image(1)])).toEqual([]);
  });
});

describe('uvWindow（合成 quad 的 UV 窗口：钳制轴只采样 RT 可见部分）', () => {
  it('未钳制轴（clamped ≥ unclamped）→ 全窗口 [0,1]', () => {
    expect(uvWindow(1471, 1471)).toEqual({ start: 0, end: 1 });
    expect(uvWindow(2048, 2048)).toEqual({ start: 0, end: 1 });
  });
  it('钳制轴：窗口 = ((W-C)/2)/W → 1-((W-C)/2)/W（世界 2942 → RT 2048，x 居中裁剪）', () => {
    const { start, end } = uvWindow(2942, 2048);
    expect(start).toBeCloseTo(447 / 2942, 12);
    expect(end).toBeCloseTo(1 - 447 / 2942, 12);
  });
  it('窗口对称性：start + end = 1（RT 可见窗口恒居中）', () => {
    expect(uvWindow(9.44, 9).start + uvWindow(9.44, 9).end).toBeCloseTo(1, 12);
  });
  it('非正未钳制尺寸 → 全窗口（防除零/负窗口）', () => {
    expect(uvWindow(0, 1)).toEqual({ start: 0, end: 1 });
  });
});

describe('createCompositeGeometry（合成 quad：世界尺寸 = 未钳制 size×scale，UV 映射进可见窗口）', () => {
  it('x 轴钳制（2942×1471 世界 → RT 2048×1471）：quad 世界尺寸未钳制、UV.x 落在窗口内、UV.y 全 [0,1]', () => {
    const geo = createCompositeGeometry(2942, 1471, 2048, 1471);
    // 世界尺寸：position 横跨 ±1471（x）、±735.5（y）= 未钳制 size×scale
    const pos = Array.from(geo.attributes.position.array as Float32Array);
    const xs = pos.filter((_, i) => i % 3 === 0);
    const ys = pos.filter((_, i) => i % 3 === 1);
    expect(Math.min(...xs)).toBe(-1471);
    expect(Math.max(...xs)).toBe(1471);
    expect(Math.min(...ys)).toBe(-735.5);
    expect(Math.max(...ys)).toBe(735.5);
    // UV 窗口：u 只落在 [uvStart, uvEnd]（仅采样 RT 可见段），v 保持全 [0,1]
    // （BufferAttribute 存 Float32Array → 精度 ~7 位，用 6 位小数容差）
    const ux = uvWindow(2942, 2048);
    const uvs = Array.from(geo.attributes.uv.array as Float32Array);
    const us = uvs.filter((_, i) => i % 2 === 0);
    const vs = uvs.filter((_, i) => i % 2 === 1);
    expect(Math.min(...us)).toBeCloseTo(ux.start, 6);
    expect(Math.max(...us)).toBeCloseTo(ux.end, 6);
    expect(Math.min(...vs)).toBe(0);
    expect(Math.max(...vs)).toBe(1);
    geo.dispose();
  });
  it('未钳制（世界 == RT 尺寸）→ UV 全 [0,1]（与无效果对象渲染语义一致）', () => {
    const geo = createCompositeGeometry(1471, 1471, 1471, 1471);
    const uvs = Array.from(geo.attributes.uv.array as Float32Array);
    expect(Math.min(...uvs)).toBe(0);
    expect(Math.max(...uvs)).toBe(1);
    geo.dispose();
  });
});

// I1（Important）竞态修复：renderScene 的链解析 IIFE 与纹理加载循环并发（无顺序屏障），
// 链可能先于 setImageObject 创建条目完成。setObjectEffectChains 对缺失条目必须暂存而非
// 静默丢弃；setImageObject 创建条目后补挂。PendingChainStore 即该决策的纯逻辑实现
// （node 可测：不触碰 renderer/runner，只做「条目存在即应用 / 缺失即暂存」决策）。
describe('PendingChainStore（效果链异步挂载暂存：链先 resolve、条目后创建 → 效果仍挂载）', () => {
  it('链先 resolve、条目后创建：先暂存，条目创建时取回同一链（不丢失）', () => {
    const store = new PendingChainStore<string>();
    const chain = 'chain-A';
    // 链解析完成，但对象条目尚未创建（纹理仍在加载）→ applyIfReady 返回 false（已暂存）
    expect(store.applyIfReady(101, chain, false)).toBe(false);
    // 条目创建完成 → take 取回同一链引用（调用方立即挂到 runner）
    expect(store.take(101)).toBe(chain);
    expect(store.take(101)).toBeUndefined(); // 取走即删，不会重复挂载
  });
  it('条目先创建、链后解析：直接应用，不暂存', () => {
    const store = new PendingChainStore<string>();
    expect(store.applyIfReady(202, 'chain-B', true)).toBe(true);
    expect(store.take(202)).toBeUndefined(); // 无暂存残留
  });
  it('链多次先到：后到的覆盖先到的（最新链生效）', () => {
    const store = new PendingChainStore<string>();
    store.applyIfReady(303, 'stale', false);
    store.applyIfReady(303, 'fresh', false);
    expect(store.take(303)).toBe('fresh');
  });
  it('条目最终未创建（纹理加载失败）：stop 清空暂存，无残留', () => {
    const store = new PendingChainStore<string>();
    store.applyIfReady(404, 'chain', false);
    store.clear();
    expect(store.take(404)).toBeUndefined();
  });
});
