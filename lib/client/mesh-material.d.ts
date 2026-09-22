import * as THREE from 'three';
export interface MeshMaterialSpec {
    shader: string;
    texturePath: string | null;
    blending: 'additive' | 'normal';
    side: THREE.Side;
    depthTest: boolean;
    depthWrite: boolean;
}
/** 解析材质 json 的 `passes[0]`。空/畸形/无 pass → null（调用方回退白图兜底材质）。 */
export declare function parseMeshMaterial(jsonText: string): MeshMaterialSpec | null;
/** 建 three 材质。spec 为 null（材质缺失/解析失败）→ 白图兜底（不整场失败）。 */
export declare function createMeshMaterial(spec: MeshMaterialSpec | null, texture: THREE.Texture | null): THREE.Material;
