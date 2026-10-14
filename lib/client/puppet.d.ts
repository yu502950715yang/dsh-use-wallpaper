import * as THREE from 'three';
import type { MdlAnimation, MdlPuppet } from './mdl-parser.js';
export interface PuppetInstance {
    mesh: THREE.Mesh | THREE.SkinnedMesh;
    bones: THREE.Bone[];
    skeleton: THREE.Skeleton | null;
    animations: MdlAnimation[];
    /** 采样某动画的某一帧（帧号可为小数 = 帧内插值；越界夹到 [0, frameCount-1]）。 */
    applyFrame(anim: MdlAnimation, frame: number): void;
    dispose(): void;
}
export declare function createPuppetMaterial(map: THREE.Texture | null, _colorBlendMode?: number): THREE.MeshBasicMaterial;
export declare function createPuppetMesh(puppet: MdlPuppet, material: THREE.Material): PuppetInstance;
