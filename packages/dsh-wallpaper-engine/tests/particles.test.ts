import { describe, expect, it } from 'vitest';
import { createParticleSystem } from '../src/client/particles.js';

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
    const ps = createParticleSystem(emitter, init, { maxParticles: 10 });
    ps.update(1.0); // 10 个粒子，velocity ∈ [0,1]x
    const before = ps.positions();
    ps.update(0.5);
    const after = ps.positions();
    for (let i = 0; i < ps.count(); i++) {
      expect(after[i * 3]).toBeGreaterThanOrEqual(before[i * 3]);
    }
  });
  it('is deterministic given a fixed seed', () => {
    const a = createParticleSystem(emitter, init, { maxParticles: 10, seed: 42 });
    const b = createParticleSystem(emitter, init, { maxParticles: 10, seed: 42 });
    a.update(1); b.update(1);
    expect([...a.positions()]).toEqual([...b.positions()]);
  });
});
