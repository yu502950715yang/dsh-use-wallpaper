import * as THREE from 'three';
export interface CompositeQuad {
    /** 把 texture 全屏贴到**当前绑定的** render target（不切 target，不读 canvas 尺寸）。 */
    composite(renderer: THREE.WebGLRenderer, texture: THREE.Texture): void;
    /** 画布缓冲尺寸变化时的钩子（几何是固定 NDC 尺寸，目前只做空实现，保持接口稳定）。 */
    resize(width: number, height: number): void;
    /** 释放自持的几何/材质（纹理所有权在调用方，不在此 dispose）。 */
    dispose(): void;
}
export declare function createCompositeQuad(renderer: THREE.WebGLRenderer): CompositeQuad;
