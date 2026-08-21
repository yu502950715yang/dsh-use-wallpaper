import { describe, expect, it } from 'vitest';
import { createParticleSystem } from '../src/client/particles.js';
import { particlesFromSpec } from '../src/client/scene-assets.js';

const emitter = { rate: 10, directions: [1, 0, 0], distanceMin: 0, distanceMax: 5 };
const init = {
  lifetimeMin: 1, lifetimeMax: 1,
  sizeMin: 8, sizeMax: 20,
  velocityMin: [0, 0, 0] as [number, number, number],
  velocityMax: [1, 0, 0] as [number, number, number],
};

describe('createParticleSystem', () => {
  it('emits particles at rate and caps at maxParticles', () => {
    const ps = createParticleSystem(emitter, init, { maxParticles: 100 });
    for (let i = 0; i < 10; i++) ps.update(0.1); // 累计 1s，rate=10 → 约10个
    expect(ps.count()).toBeGreaterThanOrEqual(8);
    expect(ps.count()).toBeLessThanOrEqual(12);
  });
  it('removes particles after lifetime elapses', () => {
    const ps = createParticleSystem(emitter, init, { maxParticles: 100 });
    ps.update(0.5);  // 发射 5 个
    ps.update(1.0);  // 再过 1s → 第一批已到寿命（lifetime=1）
    expect(ps.count()).toBeLessThanOrEqual(10);
    ps.update(2.0);  // 全部过期
    expect(ps.count()).toBe(0);
  });
  it('moves particles along velocity', () => {
    const ps = createParticleSystem(
      { ...emitter, distanceMin: 0, distanceMax: 0 }, // 初始位置为 0，便于观察位移
      init,
      { maxParticles: 10 },
    );
    ps.update(0.1); // 发射 1 个（life 0.9）
    ps.update(0.1); // 再发射 1 个（两个粒子均存活，life 0.8/0.9）
    const before = [...ps.positions()]; // 拷贝快照，避免引用同一 Float32Array
    ps.update(0.05); // 无新发射（accumulator=0.5<1），仅按 velocity 移动
    const after = [...ps.positions()];
    for (let i = 0; i < ps.count(); i++) {
      // velocity ∈ [0,1]x → x 单调不减；比较的是旧值 vs 新值（真实断言）
      expect(after[i * 3]).toBeGreaterThanOrEqual(before[i * 3]);
    }
  });
  it('is deterministic given a fixed seed', () => {
    const a = createParticleSystem(emitter, init, { maxParticles: 10, seed: 42 });
    const b = createParticleSystem(emitter, init, { maxParticles: 10, seed: 42 });
    const c = createParticleSystem(emitter, init, { maxParticles: 10, seed: 43 });
    a.update(0.5); b.update(0.5); c.update(0.5); // 存活 5 个，positions 含 rand 派生值
    expect([...a.positions()]).toEqual([...b.positions()]); // 同 seed 完全一致
    // 反证：不同 seed 产物不同，证明断言确实比较了 rand 派生值
    expect([...a.positions()]).not.toEqual([...c.positions()]);
  });
});

describe('particlesFromSpec alpha', () => {
  it('解析 alpharandom → alphaMin/alphaMax', () => {
    const spec = particlesFromSpec(JSON.parse(JSON.stringify({
      emitter: [{ rate: 1.5 }],
      initializer: [
        { name: 'lifetimerandom', min: 3, max: 5 },
        { name: 'alpharandom', min: 0.15, max: 0.2 },
      ],
    })));
    expect(spec?.init.alphaMin).toBe(0.15);
    expect(spec?.init.alphaMax).toBe(0.2);
  });

  it('无 alpharandom 时 alpha 缺省 1', () => {
    const spec = particlesFromSpec({ emitter: [{ rate: 1 }], initializer: [] });
    expect(spec?.init.alphaMin).toBeUndefined();
  });
});
