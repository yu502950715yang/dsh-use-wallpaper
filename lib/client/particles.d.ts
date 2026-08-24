export interface ParticleEmitterSpec {
    rate: number;
    directions: [number, number, number];
    distanceMin: number;
    distanceMax: number;
}
export interface ParticleInitializerSpec {
    lifetimeMin: number;
    lifetimeMax: number;
    sizeMin: number;
    sizeMax: number;
    velocityMin: [number, number, number];
    velocityMax: [number, number, number];
    colorMin?: [number, number, number];
    colorMax?: [number, number, number];
    alphaMin?: number;
    alphaMax?: number;
}
export interface ParticleSystemOptions {
    maxParticles: number;
    seed?: number;
}
export declare function alphaAt(initialAlpha: number, life: number, maxLife: number): number;
export declare function createParticleSystem(emitter: ParticleEmitterSpec, init: ParticleInitializerSpec, opts: ParticleSystemOptions): {
    count: () => number;
    update: (dt: number) => void;
    positions: () => Float32Array<ArrayBuffer>;
    colors: () => Float32Array<ArrayBuffer>;
    sizes: () => Float32Array<ArrayBuffer>;
    alphas: () => Float32Array<ArrayBuffer>;
};
