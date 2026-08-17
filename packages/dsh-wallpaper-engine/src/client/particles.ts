export interface ParticleEmitterSpec {
  rate: number;
  directions: [number, number, number];
  distanceMin: number;
  distanceMax: number;
}
export interface ParticleInitializerSpec {
  lifetimeMin: number; lifetimeMax: number;
  sizeMin: number; sizeMax: number;
  velocityMin: [number, number, number];
  velocityMax: [number, number, number];
}
export interface ParticleSystemOptions { maxParticles: number; seed?: number }

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; maxLife: number;
  size: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createParticleSystem(
  emitter: ParticleEmitterSpec,
  init: ParticleInitializerSpec,
  opts: ParticleSystemOptions,
) {
  const rand = mulberry32(opts.seed ?? (Math.random() * 0xffffffff) >>> 0);
  const particles: Particle[] = [];
  let accumulator = 0;
  const positions = new Float32Array(opts.maxParticles * 3);

  function spawn(): void {
    if (particles.length >= opts.maxParticles) return;
    const life = init.lifetimeMin + rand() * (init.lifetimeMax - init.lifetimeMin);
    const size = init.sizeMin + rand() * (init.sizeMax - init.sizeMin);
    const dist = emitter.distanceMin + rand() * (emitter.distanceMax - emitter.distanceMin);
    const dir = emitter.directions;
    const dirLen = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    particles.push({
      x: (dir[0] / dirLen) * dist * (rand() * 2 - 1),
      y: (dir[1] / dirLen) * dist * (rand() * 2 - 1),
      z: (dir[2] / dirLen) * dist * (rand() * 2 - 1),
      vx: init.velocityMin[0] + rand() * (init.velocityMax[0] - init.velocityMin[0]),
      vy: init.velocityMin[1] + rand() * (init.velocityMax[1] - init.velocityMin[1]),
      vz: init.velocityMin[2] + rand() * (init.velocityMax[2] - init.velocityMin[2]),
      life, maxLife: life, size,
    });
  }

  function update(dt: number): void {
    accumulator += dt * emitter.rate;
    while (accumulator >= 1) {
      spawn();
      accumulator -= 1;
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
    }
  }

  function syncPositions(): void {
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
    }
  }

  return {
    count: () => particles.length,
    update,
    positions: () => { syncPositions(); return positions; },
  };
}
