import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createParticleSystem } from '../src/client/particles.js';
import { objectCameraRange, createObjectRenderTarget, resolveTexPath } from '../src/client/scene-renderer.js';

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
