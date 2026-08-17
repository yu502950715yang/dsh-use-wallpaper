import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createParticleSystem } from '../src/client/particles.js';

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
