import * as THREE from 'three';
import type { UtilMaterialSpec } from './util-material.js';
export declare function createWhiteTexture(): THREE.DataTexture;
/** WE `colorBlendMode` → three `CustomBlending` 设置；未实现的模式返回 null。 */
export declare function colorBlendModeToThree(mode: number): {
    blendEquation: THREE.BlendingEquation;
    blendSrc: THREE.BlendingSrcFactor | THREE.BlendingDstFactor;
    blendDst: THREE.BlendingDstFactor;
} | null;
export declare function createLayerMaterial(texture: THREE.Texture | null, colorBlendMode: number, mod: {
    r: number;
    g: number;
    b: number;
    a: number;
}, forIsolation?: boolean): THREE.Material;
export declare function createUtilLayerMaterial(spec: UtilMaterialSpec, forIsolation: boolean, brightness?: number): THREE.Material;
export declare function createCompositeQuadMaterial(texture: THREE.Texture, colorBlendMode: number, opacity?: number): THREE.Material;
export declare function applyCompositeSampling(rt: THREE.WebGLRenderTarget, worldW: number, worldH: number, screenScale: number): void;
