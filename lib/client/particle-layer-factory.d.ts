import * as THREE from 'three';
export type ParticleLayer = {
    id: number;
    getter: () => Float32Array;
    frameCount: number;
    geometry: THREE.InstancedBufferGeometry;
    material: THREE.ShaderMaterial;
    mesh: THREE.Mesh;
    positions: THREE.InstancedBufferAttribute;
    sizes: THREE.InstancedBufferAttribute;
    uvs: THREE.InstancedBufferAttribute;
    colors: THREE.InstancedBufferAttribute;
    alphas: THREE.InstancedBufferAttribute;
    rots: THREE.InstancedBufferAttribute;
    velocities: THREE.InstancedBufferAttribute;
    capacity: number;
    loggedFirstFrame: boolean;
    loggedCount: number;
    refract: boolean;
    loggedRefract: boolean;
    parallaxDepth?: [number, number];
    parallaxCenter: [number, number];
    parallaxQuad?: THREE.Object3D;
    parallaxIsolated?: boolean;
    parallaxApplied?: boolean;
    baseWorldOrigin: [number, number, number];
    baseWorldScale: [number, number, number];
    baseWorldAngles: [number, number, number];
};
export interface AddParticleOptions {
    tex?: THREE.Texture;
    frameCount: number;
    frameCols?: number;
    frameRows?: number;
    blend: 'additive' | 'alpha';
    softness?: number;
    objectCenter?: [number, number, number];
    objectScale?: [number, number, number];
    objectAngles?: [number, number, number];
    emitterOrigin?: [number, number, number];
    maxInstances?: number;
    trail?: {
        length: number;
        maxLength: number;
        minLength: number;
    };
    perspective?: {
        fov: number;
        distance: number;
        aspect: number;
    };
    refract?: {
        normalTex: THREE.Texture;
        amount: number;
    };
    objectId?: number;
    renderOrder?: number;
    isolate?: {
        objectId: number;
        rtWidth: number;
        rtHeight: number;
        worldW: number;
        worldH: number;
    };
    parallaxDepth?: [number, number];
}
export interface ParticleLayerHost {
    readonly scene: THREE.Scene;
    readonly sceneWidth: number;
    readonly sceneHeight: number;
    /** 分配下一图层计数器 id（= particleLayers 的键）。 */
    nextLayerId(): number;
    /** 登记图层（player: particleLayers.set(layer.id, layer)）。 */
    addLayer(layer: ParticleLayer): void;
    attachIsolated(objectId: number, kind: 'background' | 'particle' | 'puppet', content: THREE.Object3D, worldW: number, worldH: number, size: {
        width: number;
        height: number;
    }, position: {
        x: number;
        y: number;
        z: number;
    }, quadAngles: [number, number, number], colorBlendMode: number, renderOrder?: number): void;
    isolatedQuad(objectId: number): THREE.Object3D | undefined;
    setDisplayObject(objectId: number, shown: THREE.Object3D): void;
    setObjectToParticle(objectId: number, layer: ParticleLayer): void;
    setRefractLayer(objectId: number, layer: ParticleLayer): void;
    registerFrameConsumer(objectId: number): void;
    layers(): IterableIterator<ParticleLayer>;
}
export declare function addParticle(host: ParticleLayerHost, simVerticesGetter: () => Float32Array, opts: AddParticleOptions): number;
export declare function updateParticles(host: ParticleLayerHost, dt: number): void;
export declare function writeParticleData(layer: ParticleLayer, data: Float32Array, count: number): void;
