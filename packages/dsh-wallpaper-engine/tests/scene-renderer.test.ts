import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createParticleSystem } from '../src/client/particles.js';
import {
  objectCameraRange, createObjectRenderTarget, resolveTexPath,
  groupEffectsByObject, uvWindow, createCompositeGeometry, PendingChainStore,
  particleObjectRange, particleWorldSize, shouldUseObjectPath,
  barAnchorOffsetY, updateVisualizerBars, materialModulation,
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
  it('T4.4 负 scale.y（镜像）：相机范围取幅值 |size×scale|（镜像在 quad 几何/RT 内容，不在相机）', () => {
    // 2460786246 Lightning cloud 语义 scale.y=-0.18：RT 分辨率必须按幅值 300×0.18=54，
    // 而非负值被下限钳成 1px（RT 退化 → 镜像内容不可见）
    expect(objectCameraRange([400, 300], [1, -0.18])).toEqual({ w: 400, h: 54 });
    // 负 scale 的钳制同样按幅值比较上限（-10000×1 → |−10000| > 2048 → 钳 2048）
    expect(objectCameraRange([10000, 512], [1, 1])).toEqual({ w: 2048, h: 512 });
    expect(objectCameraRange([6144, 3072], [-0.47891, -0.47891])).toEqual({
      w: 2048,
      h: 3072 * 0.47891,
    });
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
  const text = (id: number, effects?: unknown[]): SceneObject => ({
    kind: 'text', id, name: `t${id}`, origin: [0, 0, 0], scale: [1, 1, 1],
    text: '12:00',
    ...(effects ? { effects } : {}),
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
  it('text 对象不参与分组（T3.1：text 始终走共享场景路径，其 effects 超出本期范围）', () => {
    // 带效果的 text 对象也不进组（不触发对象 RT/效果链执行）；image 带效果照常成组
    const t = text(10, [fx('a.json')]);
    const img = image(11, [fx('b.json')]);
    const groups = groupEffectsByObject([t, img, text(12)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].obj.id).toBe(11);
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

describe('createCompositeGeometry（合成 quad：世界尺寸 = 未钳制 size×scale，UV 展开映射进可见窗口外侧）', () => {
  it('x 轴钳制（2942×1471 世界 → RT 2048×1471）：quad 世界尺寸未钳制、UV.x 展开映射、UV.y 全 [0,1]', () => {
    const geo = createCompositeGeometry(2942, 1471, 2048, 1471);
    // 世界尺寸：position 横跨 ±1471（x）、±735.5（y）= 未钳制 size×scale
    const pos = Array.from(geo.attributes.position.array as Float32Array);
    const xs = pos.filter((_, i) => i % 3 === 0);
    const ys = pos.filter((_, i) => i % 3 === 1);
    expect(Math.min(...xs)).toBe(-1471);
    expect(Math.max(...xs)).toBe(1471);
    expect(Math.min(...ys)).toBe(-735.5);
    expect(Math.max(...ys)).toBe(735.5);
    // UV 展开映射（I2 修复）：start/end 是世界空间占比（窗口 = 可见段占比），quad UV
    // 须展开为 u' = (u - start) / (end - start)——中间 [start, end] 世界区间与 RT
    // [0,1] 一一对应（RT 像素与场景像素 1:1），窗口外侧由采样器 CLAMP 到 0/1。
    // 对 W=2942,C=2048：窗口 [0.15194, 0.84806] → quad 左缘 u' = (0-start)/宽 ≈
    // -0.21826（CLAMP 后 0，即 RT 左缘 = 世界局部 -1024）、右缘 u' ≈ 1.21826（CLAMP 1）；
    // 世界中心 u=0.5 是不动点（1:1）；v 轴未钳制（1471 == RT）保持全 [0,1]。
    // （BufferAttribute 存 Float32Array → 精度 ~7 位，用 6 位小数容差）
    const ux = uvWindow(2942, 2048);
    const expand = (u: number) => (u - ux.start) / (ux.end - ux.start);
    expect(expand(0)).toBeCloseTo((2048 - 2942) / (2 * 2048), 6); // 纹理窗口左缘 (C-W)/2C
    expect(expand(1)).toBeCloseTo((2942 + 2048) / (2 * 2048), 6); // 纹理窗口右缘 (W+C)/2C
    expect(expand(ux.start)).toBeCloseTo(0, 6);  // 世界可见段起点采样 RT 左缘（1:1）
    expect(expand(ux.end)).toBeCloseTo(1, 6);    // 世界可见段终点采样 RT 右缘（1:1）
    expect(expand(0.5)).toBeCloseTo(0.5, 6);     // 世界中心 1:1 不动点
    const uvs = Array.from(geo.attributes.uv.array as Float32Array);
    const us = uvs.filter((_, i) => i % 2 === 0);
    const vs = uvs.filter((_, i) => i % 2 === 1);
    expect(Math.min(...us)).toBeCloseTo(expand(0), 6);
    expect(Math.max(...us)).toBeCloseTo(expand(1), 6);
    expect(Math.min(...vs)).toBe(0);
    expect(Math.max(...vs)).toBe(1);
    geo.dispose();
  });
  it('未钳制（世界 == RT 尺寸）→ UV 全 [0,1]（1:1 回归保护：窗口 [0,1] 两式等价不受影响）', () => {
    const geo = createCompositeGeometry(1471, 1471, 1471, 1471);
    const uvs = Array.from(geo.attributes.uv.array as Float32Array);
    expect(Math.min(...uvs)).toBe(0);
    expect(Math.max(...uvs)).toBe(1);
    geo.dispose();
  });
  it('T4.4 负 worldH（scale.y<0 镜像）：quad 帧尺寸取幅值、帧几何不翻转（镜像由 RT 内容承载）', () => {
    // 对象 RT 路径：局部 mesh 负 scale 已把镜像渲染进 RT，合成 quad 只是显示帧——
    // 帧几何若用负 worldH（PlaneGeometry 翻转顶点）会把镜像二次翻转回正（镜像抵消）。
    // 断言：帧高度 = 幅值 50（±25），且 v=1（RT 顶部）顶点在 +y（帧未翻转）。
    const geo = createCompositeGeometry(100, -50, 100, 50);
    const pos = Array.from(geo.attributes.position.array as Float32Array);
    const ys = pos.filter((_, i) => i % 3 === 1);
    expect(Math.min(...ys)).toBe(-25);
    expect(Math.max(...ys)).toBe(25);
    const uvs = Array.from(geo.attributes.uv.array as Float32Array);
    const maxYIdx = ys.indexOf(Math.max(...ys)); // v=1 顶点应位于 +y（顶部）
    expect(uvs[maxYIdx * 2 + 1]).toBe(1);
    const minYIdx = ys.indexOf(Math.min(...ys));
    expect(uvs[minYIdx * 2 + 1]).toBe(0);
    geo.dispose();
  });
});

describe('particleObjectRange（粒子对象局部相机范围 = 发射距离×缩放，逐轴钳制 2048、下限 1）', () => {
  it('常规：范围 = distanceMax × scale（用发射距离估计粒子世界包围盒）', () => {
    expect(particleObjectRange({ distanceMax: 320 }, [1, 1])).toEqual({ w: 320, h: 320 });
    expect(particleObjectRange({ distanceMax: 100 }, [2, 3])).toEqual({ w: 200, h: 300 });
  });
  it('超 2048 上限逐轴钳制（单轴超限只钳制该轴）', () => {
    expect(particleObjectRange({ distanceMax: 4096 }, [1, 1])).toEqual({ w: 2048, h: 2048 });
    expect(particleObjectRange({ distanceMax: 320 }, [10, 1])).toEqual({ w: 2048, h: 320 });
  });
  it('缺/零 distanceMax（粒子对象无发射器字段）→ 默认 64 基准再 ×scale 并钳制', () => {
    expect(particleObjectRange({}, [1, 1])).toEqual({ w: 64, h: 64 });
    expect(particleObjectRange({ distanceMax: 0 }, [1, 1])).toEqual({ w: 64, h: 64 });
    expect(particleObjectRange({}, [100, 1])).toEqual({ w: 2048, h: 64 });
  });
  it('零缩放 → 下限钳制为 1（不产生退化范围）', () => {
    expect(particleObjectRange({ distanceMax: 320 }, [0, 0])).toEqual({ w: 1, h: 1 });
  });
  it('T4.4 负 scale.y（镜像）：相机范围取幅值 |distanceMax×scale|（粒子布局绕 origin 镜像，RT 分辨率按幅值）', () => {
    expect(particleObjectRange({ distanceMax: 320 }, [1, -0.5])).toEqual({ w: 320, h: 160 });
    expect(particleObjectRange({ distanceMax: 4096 }, [-1, -1])).toEqual({ w: 2048, h: 2048 });
    expect(particleObjectRange({}, [-1, 1])).toEqual({ w: 64, h: 64 });
  });
});

describe('particleWorldSize（粒子对象合成 quad 世界尺寸 = 未钳制发射距离×缩放）', () => {
  it('世界尺寸 = distanceMax × scale（未钳制，供合成 quad 与 RT 可见窗口匹配）', () => {
    expect(particleWorldSize({ distanceMax: 320 }, [10, 1])).toEqual({ w: 3200, h: 320 });
  });
  it('缺/零 distanceMax → 默认 64 基准', () => {
    expect(particleWorldSize({}, [1, 1])).toEqual({ w: 64, h: 64 });
    expect(particleWorldSize({ distanceMax: 0 }, [1, 1])).toEqual({ w: 64, h: 64 });
  });
});

describe('shouldUseObjectPath（对象带效果 → 对象 RT 路径；image/particle 共用调度谓词）', () => {
  it('effects 非空数组 → true', () => {
    expect(shouldUseObjectPath({ effects: [{ file: 'a.json' }] })).toBe(true);
    expect(shouldUseObjectPath({ effects: [{}] })).toBe(true);
  });
  it('无 effects / 空数组 / 非数组字段 → false（无效果对象保持共享场景路径）', () => {
    expect(shouldUseObjectPath({})).toBe(false);
    expect(shouldUseObjectPath({ effects: [] })).toBe(false);
    expect(shouldUseObjectPath({ effects: 'x' as unknown })).toBe(false);
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

// T4.3 材质调制纯函数：WE 对象 color/alpha/brightness → three 材质输入
// （color 0-255 → /255，×brightness 后 clamp 0-1；opacity = alpha）。MeshBasicMaterial
// 无 brightness 通道 → 乘入 color（color 缺省按白色处理）。全缺省 → {1,1,1,1} 无调制。
describe('materialModulation（T4.3 对象 color/alpha/brightness → 材质系数）', () => {
  it('全缺省 → {1,1,1,1}（无调制，不改变材质默认值）', () => {
    expect(materialModulation()).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });
  it('color 0-255 → /255 归一化（optColor 输出量级）', () => {
    expect(materialModulation([255, 0, 0])).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(materialModulation([128, 64, 32])).toEqual({ r: 128 / 255, g: 64 / 255, b: 32 / 255, a: 1 });
  });
  it('alpha → a（material.opacity 输入，0-1 直接透传）', () => {
    expect(materialModulation(undefined, 0.5)).toEqual({ r: 1, g: 1, b: 1, a: 0.5 });
    expect(materialModulation(undefined, 0)).toEqual({ r: 1, g: 1, b: 1, a: 0 });
  });
  it('brightness 乘入 color：×0.5 减半', () => {
    expect(materialModulation([255, 255, 255], undefined, 0.5)).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
  });
  it('brightness 超 1 → color×brightness clamp 0-1（200/255×2>1 → 1）', () => {
    expect(materialModulation([200, 200, 200], undefined, 2)).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });
  it('brightness 单独作用（无 color）→ 白色 × brightness', () => {
    expect(materialModulation(undefined, undefined, 0.5)).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
  });
  it('三者组合：color×brightness + alpha 同时生效', () => {
    const m = materialModulation([255, 128, 0], 0.25, 0.5);
    expect(m.r).toBe(0.5);
    expect(m.g).toBeCloseTo((128 / 255) * 0.5, 12);
    expect(m.b).toBe(0);
    expect(m.a).toBe(0.25);
  });
});
// T3.3 visualizer 驱动：barAnchorOffsetY（alignment 锚点 → 中心锚定 quad 的 y 偏移）与
// updateVisualizerBars（每帧按频谱刷新条高与锚定偏移）为纯函数（只操作 THREE.Mesh 变换，
// node 可测，不触碰 WebGLRenderer）。语义对齐 Simple Visualizer 脚本：
//   scale.y = amt * scriptProperties.scaleY；origin.y += 0（锚点 y 恒定）；
//   origin.x += originX 在循环内累积（创建期已按 i+1 累加进 position.x，本函数不动 x）。
describe('barAnchorOffsetY（alignment → 中心锚定 y 偏移）', () => {
  it('centre / 缺省 → 0（中心即锚点）', () => {
    expect(barAnchorOffsetY('centre', 20)).toBe(0);
    expect(barAnchorOffsetY(undefined, 20)).toBe(0);
  });
  it('bottom → +h/2（锚点=底边，quad 中心上移半高，条向上生长）', () => {
    expect(barAnchorOffsetY('bottom', 20)).toBe(10);
  });
  it('top → -h/2（锚点=顶边，quad 中心下移半高，条向下生长）', () => {
    expect(barAnchorOffsetY('top', 20)).toBe(-10);
  });
});

describe('updateVisualizerBars（每帧频谱驱动条高与锚定偏移）', () => {
  const makeBars = (count: number) => {
    const bars: THREE.Mesh[] = [];
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
      mesh.position.set(10 + i * 5, 0, 0); // 创建期已按脚本累积 origin.x
      bars.push(mesh);
    }
    return bars;
  };
  const props = { barWidth: 1, scaleY: 20, originX: 5, barAlignmentdir: 'bottom' };

  it('scale.y = freqData[i]/255 × scaleY；bottom 锚定 y = anchorY + h/2', () => {
    const bars = makeBars(2);
    updateVisualizerBars(bars, 10, props, new Uint8Array([255, 128]));
    expect(bars[0].scale.y).toBe(20);                    // 255/255×20
    expect(bars[0].position.y).toBe(10 + 10);            // anchorY + 20/2
    expect(bars[1].scale.y).toBeCloseTo(128 / 255 * 20, 6);
    expect(bars[1].position.y).toBeCloseTo(10 + (128 / 255 * 20) / 2, 6);
  });
  it('centre 锚定：y = anchorY（偏移 0）', () => {
    const bars = makeBars(1);
    updateVisualizerBars(bars, 5, { ...props, barAlignmentdir: 'centre' }, new Uint8Array([255]));
    expect(bars[0].position.y).toBe(5);
    expect(bars[0].scale.y).toBe(20);
  });
  it('top 锚定：y = anchorY - h/2', () => {
    const bars = makeBars(1);
    updateVisualizerBars(bars, 5, { ...props, barAlignmentdir: 'top' }, new Uint8Array([255]));
    expect(bars[0].position.y).toBe(5 - 10);
  });
  it('缺 barAlignmentdir → 按 bottom 处理（视觉系默认自基线向上生长）', () => {
    const bars = makeBars(1);
    updateVisualizerBars(bars, 5, { barWidth: 1, scaleY: 20, originX: 5 }, new Uint8Array([255]));
    expect(bars[0].position.y).toBe(5 + 10);
  });
  it('position.x 由创建期累积（i+1）×originX，本函数不改动 x', () => {
    const bars = makeBars(3);
    updateVisualizerBars(bars, 0, props, new Uint8Array([255, 128, 64]));
    expect(bars.map((b) => b.position.x)).toEqual([10, 15, 20]);
  });
  it('freqData 为 null（无音频分析器）→ 全零高度（条不可见但存在，不崩）', () => {
    const bars = makeBars(2);
    updateVisualizerBars(bars, 0, props, null);
    expect(bars[0].scale.y).toBe(0);
    expect(bars[1].scale.y).toBe(0);
  });
  it('freqData 比条数短（防御）→ 按 i % len 循环取 bin', () => {
    const bars = makeBars(4);
    updateVisualizerBars(bars, 0, props, new Uint8Array([255, 0]));
    expect(bars[0].scale.y).toBe(20);
    expect(bars[1].scale.y).toBe(0);
    expect(bars[2].scale.y).toBe(20);
    expect(bars[3].scale.y).toBe(0);
  });
  it('scriptProperties 缺字段 → 兜底默认值（scaleY=10、originX=10），不崩', () => {
    const bars = makeBars(1);
    updateVisualizerBars(bars, 0, {}, new Uint8Array([255]));
    expect(bars[0].scale.y).toBe(10);
  });
});
