import { describe, expect, it, vi } from 'vitest';
import { particlesFromSpec } from '../src/client/scene-assets.js';
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
