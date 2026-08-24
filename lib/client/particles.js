function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
// 寿命衰减纯函数（便于 node 测试）：alphaAt(initialAlpha, life, maxLife) = initialAlpha * clamp(life/maxLife, 0, 1)
export function alphaAt(initialAlpha, life, maxLife) {
    return initialAlpha * Math.max(0, Math.min(1, life / Math.max(1e-6, maxLife)));
}
export function createParticleSystem(emitter, init, opts) {
    const rand = mulberry32(opts.seed ?? (Math.random() * 0xffffffff) >>> 0);
    const particles = [];
    let accumulator = 0;
    const positions = new Float32Array(opts.maxParticles * 3);
    const colors = new Float32Array(opts.maxParticles * 3);
    const sizes = new Float32Array(opts.maxParticles);
    const alphas = new Float32Array(opts.maxParticles);
    function randIn(min, max) {
        return min + rand() * (max - min);
    }
    function spawn() {
        if (particles.length >= opts.maxParticles)
            return;
        const life = randIn(init.lifetimeMin, init.lifetimeMax);
        const size = randIn(init.sizeMin, init.sizeMax);
        const amn = init.alphaMin ?? 1, amx = init.alphaMax ?? 1;
        const a = randIn(amn, amx); // 单次随机：initialAlpha 与 alpha 同值，避免首帧衰减跳变（Task 0.1 review minor）
        const dist = randIn(emitter.distanceMin, emitter.distanceMax);
        const dir = emitter.directions;
        const dirLen = Math.hypot(dir[0], dir[1], dir[2]) || 1;
        const cm = init.colorMin ?? [255, 255, 255];
        const cx = init.colorMax ?? [255, 255, 255];
        particles.push({
            x: (dir[0] / dirLen) * dist * (rand() * 2 - 1),
            y: (dir[1] / dirLen) * dist * (rand() * 2 - 1),
            z: (dir[2] / dirLen) * dist * (rand() * 2 - 1),
            vx: randIn(init.velocityMin[0], init.velocityMax[0]),
            vy: randIn(init.velocityMin[1], init.velocityMax[1]),
            vz: randIn(init.velocityMin[2], init.velocityMax[2]),
            life, maxLife: life, size,
            r: randIn(cm[0], cx[0]), g: randIn(cm[1], cx[1]), b: randIn(cm[2], cx[2]),
            initialAlpha: a, alpha: a,
        });
    }
    function update(dt) {
        accumulator += dt * emitter.rate;
        while (accumulator >= 1) {
            spawn();
            accumulator -= 1;
        }
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.life -= dt;
            if (p.life <= 0) {
                particles.splice(i, 1);
                continue;
            }
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.z += p.vz * dt;
        }
    }
    function syncBuffers() {
        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            const o = i * 3;
            positions[o] = p.x;
            positions[o + 1] = p.y;
            positions[o + 2] = p.z;
            colors[o] = p.r / 255;
            colors[o + 1] = p.g / 255;
            colors[o + 2] = p.b / 255;
            sizes[i] = p.size;
            alphas[i] = alphaAt(p.initialAlpha, p.life, p.maxLife);
        }
    }
    return {
        count: () => particles.length,
        update,
        positions: () => { syncBuffers(); return positions; },
        colors: () => colors,
        sizes: () => sizes,
        alphas: () => alphas,
    };
}
